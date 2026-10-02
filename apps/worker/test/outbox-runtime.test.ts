import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '../src/logging/logger.js';
import { OutboxEventQueue } from '../src/outbox/outbox-event.queue.js';
import { OutboxHandlerRegistry, type OutboxEventView } from '../src/outbox/outbox-handler.registry.js';
import { OUTBOX_RELAY_QUEUE, OutboxRelayQueue } from '../src/outbox/outbox-relay.queue.js';
import { OUTBOX_SWEEPER_QUEUE } from '../src/outbox/outbox-sweeper.queue.js';
import type { JobRunStatus, OutboxStore } from '../src/outbox/outbox.store.js';
import type { QueueDefinition, QueueJob } from '../src/queue/definitions.js';
import { createProducer } from '../src/queue/producer.js';
import { deadLetterQueueName, MAX_ATTEMPTS } from '../src/queue/policy.js';
import { startRedis } from './support/redis-server.js';
import { createTestRuntime, inspector, inspectQueue, waitUntil } from './support/runtime.js';

/**
 * Phase 8-A through the real runtime and a real Redis.
 *
 * The in-process suite proves the relay's decisions; this one proves the wiring around them — that the
 * runtime hands a publishing definition its port, that a job produced by a real job scheduler carries
 * the occurrence timestamp `job_runs` needs, and that a handler which keeps failing ends in both the
 * existing dead-letter queue and `dead_letter_outbox_event`.
 *
 * No database is contacted: the store is the double. No provider, financial table or webhook appears.
 */

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const HANDLED = 'listing.published';
const TEST_QUEUE = 'outbox-test-handler';
const EVENT_ID = '11111111-1111-4111-8111-111111111111';

interface Settled {
  completed: string[];
  deadLettered: Array<{ id: string; errorType: string }>;
  runs: Array<{ jobName: string; scheduledFor: number | null }>;
}

function store(settled: Settled, eventTypes: readonly string[]): OutboxStore {
  let claimed = false;
  const view: OutboxEventView = {
    id: EVENT_ID,
    aggregateType: 'listing',
    aggregateId: EVENT_ID,
    eventType: HANDLED,
    payload: {},
    occurredAt: new Date(1_000_000),
    attempts: 1,
    publishedAt: null,
    completedAt: null,
    deadLetteredAt: null,
  };
  return {
    async claimForEventTypes(types) {
      expect([...types]).toEqual([...eventTypes]);
      if (claimed) return [];
      claimed = true;
      return [view];
    },
    async read() {
      return view;
    },
    async complete(id) {
      settled.completed.push(id);
      return true;
    },
    async deadLetter(id, errorType) {
      settled.deadLettered.push({ id, errorType });
      return true;
    },
    async sweep() {
      return 0;
    },
    async startJobRun(jobName, scheduledFor) {
      const occurrence = scheduledFor === null ? null : scheduledFor.getTime();
      if (settled.runs.some((r) => r.jobName === jobName && r.scheduledFor === occurrence && occurrence !== null)) {
        return null;
      }
      settled.runs.push({ jobName, scheduledFor: occurrence });
      return `run-${settled.runs.length}`;
    },
    async finishJobRun(_id: string, _status: JobRunStatus) {
      return true;
    },
  };
}

function logger() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(...chunk.toString().split('\n').filter((line) => line.length > 0));
      callback();
    },
  });
  return { logger: createLogger('debug', stream), logs: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>) };
}

describe('the relay through the real runtime', () => {
  it('receives a publish port, relays a claimed event and the handler completes it', async () => {
    const redis = await startRedis();
    cleanup.push(() => redis.stop());
    const settled: Settled = { completed: [], deadLettered: [], runs: [] };
    const seen: OutboxEventView[] = [];
    const registry = new OutboxHandlerRegistry([
      {
        eventType: HANDLED,
        queue: TEST_QUEUE,
        jobName: 'handle',
        handle: async (e) => {
          seen.push(e);
        },
      },
    ]);
    const { logger: log } = logger();
    const fake = store(settled, registry.eventTypes);
    const relay = new OutboxRelayQueue(fake, registry, log, 1_000);
    const handler = new OutboxEventQueue(TEST_QUEUE, registry.handlersFor(TEST_QUEUE), fake, log);

    const t = await createTestRuntime(redis.url, [relay, handler]);
    cleanup.push(() => t.runtime.stop().then(() => undefined));
    await t.runtime.start();

    await waitUntil(() => settled.completed.length === 1, 20_000);
    expect(seen.map((e) => e.eventType)).toEqual([HANDLED]);
    expect(settled.completed).toEqual([EVENT_ID]);

    // The relay's own scheduled occurrence reached job_runs, and it is a real timestamp.
    await waitUntil(() => settled.runs.length >= 1);
    const run = settled.runs[0];
    expect(run?.jobName).toBe('outbox.relay');
    expect(typeof run?.scheduledFor).toBe('number');
    expect(run?.scheduledFor).toBeGreaterThan(1_600_000_000_000);
  }, 60_000);

  it('dead-letters the outbox event when a handler exhausts its attempts, using the existing alert', async () => {
    const redis = await startRedis();
    cleanup.push(() => redis.stop());
    const settled: Settled = { completed: [], deadLettered: [], runs: [] };
    const registry = new OutboxHandlerRegistry([
      {
        eventType: HANDLED,
        queue: TEST_QUEUE,
        jobName: 'handle',
        handle: async () => {
          throw new RangeError('never succeeds');
        },
      },
    ]);
    // The wrapper writes its own line through its own logger; the runtime writes the dead-letter alert
    // through the runtime's. Both are asserted below, each on the stream that actually carries it.
    const { logger: log, logs: handlerLogs } = logger();
    const fake = store(settled, registry.eventTypes);
    const handler = new OutboxEventQueue(TEST_QUEUE, registry.handlersFor(TEST_QUEUE), fake, log);

    const t = await createTestRuntime(redis.url, [handler], { random: () => 1 });
    cleanup.push(() => t.runtime.stop().then(() => undefined));
    await t.runtime.start();

    const producer = createProducer(TEST_QUEUE, inspector(redis.url));
    cleanup.push(() => producer.close());
    await producer.enqueue('handle', { eventId: EVENT_ID });

    await waitUntil(() => settled.deadLettered.length === 1, 40_000, 100);
    expect(settled.deadLettered).toEqual([{ id: EVENT_ID, errorType: 'RangeError' }]);
    expect(settled.completed).toEqual([]);

    // The existing dead-letter queue holds the entry, and the existing alert line was raised.
    const dlq = inspectQueue(deadLetterQueueName(TEST_QUEUE), redis.url);
    cleanup.push(() => dlq.close());
    await waitUntil(async () => (await dlq.getWaiting()).length === 1, 20_000);
    const [entry] = await dlq.getWaiting();
    expect(entry?.data).toMatchObject({ sourceQueue: TEST_QUEUE, jobName: 'handle', errorType: 'RangeError', attempts: MAX_ATTEMPTS });
    expect(t.logs().some((line) => line.event === 'dead_letter')).toBe(true);
    const settledLine = handlerLogs().find((line) => line.event === 'outbox_event_dead_lettered');
    expect(settledLine).toMatchObject({ level: 50, queue: TEST_QUEUE, errorType: 'RangeError', stopped: true });
    expect(JSON.stringify(settledLine)).not.toContain('never succeeds');
  }, 90_000);

  it('never attaches a publisher to a definition that does not ask for one', async () => {
    const redis = await startRedis();
    cleanup.push(() => redis.stop());
    const processed: string[] = [];
    const plain: QueueDefinition = {
      name: 'outbox-plain',
      process: async (job: QueueJob) => void processed.push(job.id),
    };
    const t = await createTestRuntime(redis.url, [plain]);
    cleanup.push(() => t.runtime.stop().then(() => undefined));
    await t.runtime.start();

    const producer = createProducer('outbox-plain', inspector(redis.url));
    cleanup.push(() => producer.close());
    const jobId = await producer.enqueue('probe', { eventId: EVENT_ID });
    await waitUntil(() => processed.includes(jobId), 20_000);
    expect(t.logs().some((line) => line.event === 'worker_started' && Array.isArray(line.queues) && (line.queues as string[]).includes('outbox-plain'))).toBe(true);
  }, 60_000);
});

describe('queue names', () => {
  it('are infrastructure names and map no event type to any business queue', () => {
    expect(OUTBOX_RELAY_QUEUE).toBe('outbox-relay');
    expect(OUTBOX_SWEEPER_QUEUE).toBe('outbox-sweeper');
    // 8-A ships an empty registry, so it names no destination queue at all.
    expect(OutboxHandlerRegistry.EMPTY.queues).toEqual([]);
  });
});
