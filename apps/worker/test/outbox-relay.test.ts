import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/logging/logger.js';
import { OutboxEventQueue, outboxErrorType, UNCLASSIFIED_ERROR_TYPE } from '../src/outbox/outbox-event.queue.js';
import {
  InvalidOutboxHandlerError,
  OutboxHandlerRegistry,
  type OutboxEventView,
} from '../src/outbox/outbox-handler.registry.js';
import {
  OUTBOX_CLAIM_BATCH_SIZE,
  OUTBOX_RELAY_JOB_NAME,
  OUTBOX_RELAY_PAYLOAD,
  OUTBOX_RELAY_QUEUE,
  OutboxRelayQueue,
} from '../src/outbox/outbox-relay.queue.js';
import {
  OUTBOX_SWEEP_BATCH_SIZE,
  OUTBOX_SWEEP_STALE_AFTER,
  OUTBOX_SWEEPER_JOB_NAME,
  OUTBOX_SWEEPER_QUEUE,
  OutboxSweeperQueue,
} from '../src/outbox/outbox-sweeper.queue.js';
import type { JobRunStatus, OutboxStore } from '../src/outbox/outbox.store.js';
import { assertQueueName } from '../src/queue/policy.js';
import { assertIdPayload } from '../src/queue/payload.js';
import { scheduledOccurrence } from '../src/queue/scheduling.js';
import { buildQueueDefinitions } from '../src/queue/registry.js';
import type { QueueJob, QueuePublisher } from '../src/queue/definitions.js';
import { loadEnv } from '../src/config/env.js';

/**
 * Phase 8-A — the transactional outbox relay, sweeper and dead-letter path, exercised in process.
 *
 * No provider is contacted and no financial table is named anywhere in this file. The store is a
 * double, but a faithful one: it reproduces exactly what 0007 and 0083 enforce — that a claim takes only
 * pending, undead-lettered, available rows **of the named event types** and increments `attempts`; that
 * completing twice is a no-op; that the sweeper only sees rows with `published_at` set; and that
 * `start_job_run` returns null for an occurrence already recorded.
 */

interface FakeEvent {
  id: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: unknown;
  occurredAt: Date;
  availableAt: number;
  attempts: number;
  publishedAt: number | null;
  completedAt: number | null;
  deadLetteredAt: number | null;
  lastErrorType: string | null;
}

function event(id: string, eventType: string, overrides: Partial<FakeEvent> = {}): FakeEvent {
  return {
    id,
    aggregateType: eventType.split('.')[0] ?? 'thing',
    aggregateId: 'batch',
    eventType,
    payload: { some_id: id },
    occurredAt: new Date(1_000_000),
    availableAt: 0,
    attempts: 0,
    publishedAt: null,
    completedAt: null,
    deadLetteredAt: null,
    lastErrorType: null,
    ...overrides,
  };
}

interface JobRunRow {
  id: string;
  jobName: string;
  scheduledFor: number | null;
  status: 'running' | JobRunStatus;
  processedCount: number | null;
  errorType: string | null;
}

/** A faithful stand-in for 0007's and 0083's outbox and job-run functions. */
class FakeStore implements OutboxStore {
  readonly runs: JobRunRow[] = [];
  now = 2_000_000;
  claims: Array<{ eventTypes: readonly string[]; limit: number }> = [];
  sweeps: Array<{ staleAfter: string; limit: number }> = [];
  failClaim = false;
  private nextRunId = 1;

  constructor(readonly events: FakeEvent[]) {}

  private toView(row: FakeEvent): OutboxEventView {
    return {
      id: row.id,
      aggregateType: row.aggregateType,
      aggregateId: row.aggregateId,
      eventType: row.eventType,
      payload: row.payload,
      occurredAt: row.occurredAt,
      attempts: row.attempts,
      publishedAt: row.publishedAt === null ? null : new Date(row.publishedAt),
      completedAt: row.completedAt === null ? null : new Date(row.completedAt),
      deadLetteredAt: row.deadLetteredAt === null ? null : new Date(row.deadLetteredAt),
    };
  }

  async claimForEventTypes(eventTypes: readonly string[], limit: number): Promise<readonly OutboxEventView[]> {
    this.claims.push({ eventTypes, limit });
    if (this.failClaim) throw new Error('claim unavailable');
    // 0083 refuses an empty list rather than claiming everything.
    if (eventTypes.length === 0) throw new Error('p_event_types must name at least one registered event type');
    if (limit < 1 || limit > 1000) throw new Error('p_limit must be between 1 and 1000');
    const claimed = this.events
      .filter(
        (row) =>
          row.publishedAt === null &&
          row.deadLetteredAt === null &&
          row.availableAt <= this.now &&
          eventTypes.includes(row.eventType),
      )
      .slice(0, limit);
    for (const row of claimed) {
      row.publishedAt = this.now;
      row.attempts += 1;
    }
    return claimed.map((row) => this.toView(row));
  }

  async read(id: string): Promise<OutboxEventView | null> {
    const row = this.events.find((e) => e.id === id);
    return row === undefined ? null : this.toView(row);
  }

  async complete(id: string): Promise<boolean> {
    const row = this.events.find((e) => e.id === id);
    if (row === undefined || row.completedAt !== null || row.deadLetteredAt !== null) return false;
    row.completedAt = this.now;
    return true;
  }

  async deadLetter(id: string, errorType: string): Promise<boolean> {
    const row = this.events.find((e) => e.id === id);
    if (row === undefined || row.completedAt !== null || row.deadLetteredAt !== null) return false;
    row.deadLetteredAt = this.now;
    row.lastErrorType = errorType;
    return true;
  }

  async sweep(staleAfter: string, limit: number): Promise<number> {
    this.sweeps.push({ staleAfter, limit });
    const minutes = Number(/^(\d+) minutes$/.exec(staleAfter)?.[1] ?? '5');
    const cutoff = this.now - minutes * 60_000;
    const stale = this.events
      .filter((row) => row.publishedAt !== null && row.publishedAt < cutoff && row.completedAt === null && row.deadLetteredAt === null)
      .slice(0, limit);
    for (const row of stale) {
      row.publishedAt = null;
      row.availableAt = this.now;
    }
    return stale.length;
  }

  async startJobRun(jobName: string, scheduledFor: Date | null): Promise<string | null> {
    const occurrence = scheduledFor === null ? null : scheduledFor.getTime();
    // 0007's partial unique index: `(job_name, scheduled_for) where scheduled_for is not null`.
    if (occurrence !== null && this.runs.some((r) => r.jobName === jobName && r.scheduledFor === occurrence)) {
      return null;
    }
    const id = `run-${this.nextRunId++}`;
    this.runs.push({ id, jobName, scheduledFor: occurrence, status: 'running', processedCount: null, errorType: null });
    return id;
  }

  async finishJobRun(id: string, status: JobRunStatus, processedCount: number | null, errorType: string | null): Promise<boolean> {
    const run = this.runs.find((r) => r.id === id);
    if (run === undefined || run.status !== 'running') return false;
    run.status = status;
    run.processedCount = processedCount;
    run.errorType = errorType;
    return true;
  }
}

class RecordingPublisher implements QueuePublisher {
  readonly published: Array<{ queue: string; jobName: string; data: Record<string, string> }> = [];
  fail = false;

  async publish(queue: string, jobName: string, data: Record<string, string>): Promise<string> {
    if (this.fail) throw new Error('redis unavailable');
    assertQueueName(queue);
    assertIdPayload(data);
    this.published.push({ queue, jobName, data });
    return `job-${this.published.length}`;
  }
}

function silentLogger() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(...chunk.toString().split('\n').filter((line) => line.length > 0));
      callback();
    },
  });
  return { logger: createLogger('debug', stream), logs: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>) };
}

const HANDLED = 'listing.published';
const UNHANDLED = 'payment.succeeded';
const TEST_QUEUE = 'test-handler';

function registry(handle: (e: OutboxEventView) => Promise<void> = async () => undefined) {
  return new OutboxHandlerRegistry([{ eventType: HANDLED, queue: TEST_QUEUE, jobName: 'handle', handle }]);
}

function tick(scheduledFor: Date | null): QueueJob {
  return { id: 'job-1', name: 'relay', data: OUTBOX_RELAY_PAYLOAD, scheduledFor };
}

describe('the handler-registration contract', () => {
  it('refuses a registration the database could not hold', () => {
    expect(() => new OutboxHandlerRegistry([{ eventType: 'NotAnEventType', queue: TEST_QUEUE, jobName: 'h', handle: async () => undefined }])).toThrow(InvalidOutboxHandlerError);
    expect(() => new OutboxHandlerRegistry([{ eventType: 'nodot', queue: TEST_QUEUE, jobName: 'h', handle: async () => undefined }])).toThrow(InvalidOutboxHandlerError);
    expect(() => new OutboxHandlerRegistry([{ eventType: HANDLED, queue: 'Bad Queue', jobName: 'h', handle: async () => undefined }])).toThrow(TypeError);
    expect(() => new OutboxHandlerRegistry([{ eventType: HANDLED, queue: TEST_QUEUE, jobName: 'Handle', handle: async () => undefined }])).toThrow(InvalidOutboxHandlerError);
  });

  it('allows at most one handler per event type', () => {
    const one = { eventType: HANDLED, queue: TEST_QUEUE, jobName: 'h', handle: async () => undefined };
    expect(() => new OutboxHandlerRegistry([one, { ...one, jobName: 'other' }])).toThrow(InvalidOutboxHandlerError);
  });

  it('is empty in 8-A, and an empty registry exposes no event type and no queue', () => {
    expect(OutboxHandlerRegistry.EMPTY.isEmpty).toBe(true);
    expect(OutboxHandlerRegistry.EMPTY.eventTypes).toEqual([]);
    expect(OutboxHandlerRegistry.EMPTY.queues).toEqual([]);
    expect(OutboxHandlerRegistry.EMPTY.find(HANDLED)).toBeUndefined();
  });

  it('reports its event types sorted, so every claim sends the same argument', () => {
    const many = new OutboxHandlerRegistry([
      { eventType: 'z.thing', queue: TEST_QUEUE, jobName: 'z', handle: async () => undefined },
      { eventType: 'a.thing', queue: TEST_QUEUE, jobName: 'a', handle: async () => undefined },
    ]);
    expect(many.eventTypes).toEqual(['a.thing', 'z.thing']);
    expect(many.queues).toEqual([TEST_QUEUE]);
    expect([...many.handlersFor(TEST_QUEUE).keys()].sort()).toEqual(['a', 'z']);
  });
});

describe('the worker registers nothing while the registry is empty', () => {
  const base = {
    NODE_ENV: 'test',
    PSEUDONYMOUS_USER_ID_KEY: 'test-pseudonymous-user-id-key-not-a-real-secret',
    APP_WORKER_DATABASE_URL: 'postgres://app_worker@127.0.0.1:5432/marketplace_test',
    REDIS_URL: 'redis://127.0.0.1:6379',
    WORKER_HEALTH_HOST: '127.0.0.1',
    WORKER_HEALTH_PORT: '9099',
    LOG_LEVEL: 'debug',
  };

  it('builds no queue at all and says so, exactly as 7-D does for email', () => {
    const { logger, logs } = silentLogger();
    const definitions = buildQueueDefinitions(loadEnv(base), logger);
    expect(definitions).toEqual([]);
    const events = logs().map((line) => line.event);
    expect(events).toContain('email_relay_not_registered');
    expect(events).toContain('outbox_relay_not_registered');
  });

  it('builds the relay, the sweeper and one queue per handler destination once a handler exists', () => {
    const { logger } = silentLogger();
    const store = new FakeStore([]);
    const definitions = buildQueueDefinitions(loadEnv(base), logger, null, registry(), store);
    expect(definitions.map((d) => d.name)).toEqual([OUTBOX_RELAY_QUEUE, OUTBOX_SWEEPER_QUEUE, TEST_QUEUE]);
  });

  it('carries the settled values without restating them anywhere else', () => {
    expect(OUTBOX_CLAIM_BATCH_SIZE).toBe(100);
    expect(OUTBOX_SWEEP_BATCH_SIZE).toBe(100);
    expect(OUTBOX_SWEEP_STALE_AFTER).toBe('5 minutes');
    const env = loadEnv(base);
    expect(env.outboxRelayIntervalMs).toBe(15_000);
    expect(env.outboxSweeperIntervalMs).toBe(300_000);
  });
});

describe('an event with no registered handler', () => {
  it('is never claimed: the claim carries only the registered types', async () => {
    const { logger } = silentLogger();
    const store = new FakeStore([event('11111111-1111-4111-8111-111111111111', UNHANDLED)]);
    const relay = new OutboxRelayQueue(store, registry(), logger, 15_000);
    relay.attach(new RecordingPublisher());

    const result = await relay.drain();

    expect(result).toEqual({ claimed: 0, published: 0, failed: 0 });
    expect(store.claims).toEqual([{ eventTypes: [HANDLED], limit: OUTBOX_CLAIM_BATCH_SIZE }]);
    const row = store.events[0];
    expect(row?.publishedAt).toBeNull();
    expect(row?.completedAt).toBeNull();
    expect(row?.deadLetteredAt).toBeNull();
    expect(row?.attempts).toBe(0);
  });

  it('is left untouched even when a handled event sits beside it', async () => {
    const { logger } = silentLogger();
    const handled = event('11111111-1111-4111-8111-111111111111', HANDLED);
    const unhandled = event('22222222-2222-4222-8222-222222222222', UNHANDLED);
    const store = new FakeStore([handled, unhandled]);
    const relay = new OutboxRelayQueue(store, registry(), logger, 15_000);
    const publisher = new RecordingPublisher();
    relay.attach(publisher);

    await relay.drain();

    expect(publisher.published).toEqual([{ queue: TEST_QUEUE, jobName: 'handle', data: { eventId: handled.id } }]);
    expect(unhandled.attempts).toBe(0);
    expect(unhandled.publishedAt).toBeNull();
  });

  it('cannot enter a sweep cycle, because the sweeper only sees published events', async () => {
    const { logger } = silentLogger();
    const unhandled = event('22222222-2222-4222-8222-222222222222', UNHANDLED);
    const store = new FakeStore([unhandled]);
    const relay = new OutboxRelayQueue(store, registry(), logger, 15_000);
    relay.attach(new RecordingPublisher());
    const sweeper = new OutboxSweeperQueue(store, logger, 300_000);

    for (let i = 0; i < 10; i += 1) {
      await relay.drain();
      store.now += 10 * 60_000;
      expect(await sweeper.sweep()).toBe(0);
    }

    expect(unhandled.attempts).toBe(0);
    expect(unhandled.publishedAt).toBeNull();
    expect(unhandled.deadLetteredAt).toBeNull();
    expect(unhandled.completedAt).toBeNull();
  });

  it('is never claimed by an empty registry, which the database itself refuses', async () => {
    const { logger } = silentLogger();
    const store = new FakeStore([event('11111111-1111-4111-8111-111111111111', HANDLED)]);
    const relay = new OutboxRelayQueue(store, OutboxHandlerRegistry.EMPTY, logger, 15_000);
    relay.attach(new RecordingPublisher());

    expect(await relay.drain()).toEqual({ claimed: 0, published: 0, failed: 0 });
    expect(store.claims).toEqual([]);
    await expect(store.claimForEventTypes([], 100)).rejects.toThrow(/at least one registered event type/);
  });
});

describe('a registered handler', () => {
  it('claims, dispatches and completes exactly once', async () => {
    const { logger } = silentLogger();
    const row = event('11111111-1111-4111-8111-111111111111', HANDLED);
    const store = new FakeStore([row]);
    const seen: OutboxEventView[] = [];
    const handlers = registry(async (e) => {
      seen.push(e);
    });
    const relay = new OutboxRelayQueue(store, handlers, logger, 15_000);
    const publisher = new RecordingPublisher();
    relay.attach(publisher);

    await relay.drain();
    expect(row.attempts).toBe(1);
    expect(row.publishedAt).not.toBeNull();
    expect(row.completedAt).toBeNull();

    const queue = new OutboxEventQueue(TEST_QUEUE, handlers.handlersFor(TEST_QUEUE), store, logger);
    const outcome = await queue.handle({ id: 'j1', name: 'handle', data: { eventId: row.id }, scheduledFor: null });

    expect(outcome).toEqual({ handled: true, completed: true });
    expect(seen.map((e) => [e.id, e.eventType, e.aggregateId])).toEqual([[row.id, HANDLED, 'batch']]);
    expect(row.completedAt).not.toBeNull();
  });

  it('never completes an event it could not read', async () => {
    const { logger } = silentLogger();
    const store = new FakeStore([]);
    let ran = false;
    const handlers = registry(async () => {
      ran = true;
    });
    const queue = new OutboxEventQueue(TEST_QUEUE, handlers.handlersFor(TEST_QUEUE), store, logger);

    const outcome = await queue.handle({
      id: 'j1',
      name: 'handle',
      data: { eventId: '33333333-3333-4333-8333-333333333333' },
      scheduledFor: null,
    });

    expect(outcome).toEqual({ handled: false, completed: false, reason: 'missing' });
    expect(ran).toBe(false);
  });

  it('skips an event another worker already settled, and does not run the effect twice', async () => {
    const { logger } = silentLogger();
    const row = event('11111111-1111-4111-8111-111111111111', HANDLED, { publishedAt: 1, completedAt: 2 });
    const store = new FakeStore([row]);
    let runs = 0;
    const handlers = registry(async () => {
      runs += 1;
    });
    const queue = new OutboxEventQueue(TEST_QUEUE, handlers.handlersFor(TEST_QUEUE), store, logger);

    const outcome = await queue.handle({ id: 'j1', name: 'handle', data: { eventId: row.id }, scheduledFor: null });

    expect(outcome).toEqual({ handled: false, completed: false, reason: 'already_settled' });
    expect(runs).toBe(0);
  });

  it('completes idempotently: the second completion changes nothing', async () => {
    const store = new FakeStore([event('11111111-1111-4111-8111-111111111111', HANDLED, { publishedAt: 1 })]);
    expect(await store.complete('11111111-1111-4111-8111-111111111111')).toBe(true);
    expect(await store.complete('11111111-1111-4111-8111-111111111111')).toBe(false);
    expect(store.events[0]?.completedAt).toBe(2_000_000);
  });

  it('completes nothing when the handler throws', async () => {
    const { logger } = silentLogger();
    const row = event('11111111-1111-4111-8111-111111111111', HANDLED, { publishedAt: 1 });
    const store = new FakeStore([row]);
    const handlers = registry(async () => {
      throw new RangeError('handler failed');
    });
    const queue = new OutboxEventQueue(TEST_QUEUE, handlers.handlersFor(TEST_QUEUE), store, logger);

    await expect(queue.handle({ id: 'j1', name: 'handle', data: { eventId: row.id }, scheduledFor: null })).rejects.toThrow(RangeError);
    expect(row.completedAt).toBeNull();
  });

  it('refuses a job name no handler owns rather than guessing', async () => {
    const { logger } = silentLogger();
    const store = new FakeStore([event('11111111-1111-4111-8111-111111111111', HANDLED)]);
    const queue = new OutboxEventQueue(TEST_QUEUE, registry().handlersFor(TEST_QUEUE), store, logger);
    await expect(queue.handle({ id: 'j1', name: 'other', data: { eventId: 'x' }, scheduledFor: null })).rejects.toThrow(/No outbox handler is registered/);
  });
});

describe('dead-letter handling', () => {
  it('stops re-publication through 0007s writer, storing only an error class', async () => {
    const { logger, logs } = silentLogger();
    const row = event('11111111-1111-4111-8111-111111111111', HANDLED, { publishedAt: 1 });
    const store = new FakeStore([row]);
    const queue = new OutboxEventQueue(TEST_QUEUE, registry().handlersFor(TEST_QUEUE), store, logger);

    await queue.onFinalFailure({ id: 'j1', name: 'handle', data: { eventId: row.id }, scheduledFor: null }, 'RangeError');

    expect(row.deadLetteredAt).not.toBeNull();
    expect(row.lastErrorType).toBe('RangeError');
    const line = logs().find((l) => l.event === 'outbox_event_dead_lettered');
    expect(line).toMatchObject({ level: 50, queue: TEST_QUEUE, errorType: 'RangeError', stopped: true });
    // No message, no stack, no payload on the line.
    expect(JSON.stringify(line)).not.toContain('handler failed');
  });

  it('never writes an error type the column would refuse', () => {
    expect(outboxErrorType('RangeError')).toBe('RangeError');
    expect(outboxErrorType('some.dotted.thing')).toBe(UNCLASSIFIED_ERROR_TYPE);
    expect(outboxErrorType('has space')).toBe(UNCLASSIFIED_ERROR_TYPE);
    expect(outboxErrorType('')).toBe(UNCLASSIFIED_ERROR_TYPE);
    expect(outboxErrorType('9Leading')).toBe(UNCLASSIFIED_ERROR_TYPE);
    for (const value of ['RangeError', UNCLASSIFIED_ERROR_TYPE]) {
      expect(value).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
    }
  });

  it('leaves a completed event alone', async () => {
    const { logger } = silentLogger();
    const row = event('11111111-1111-4111-8111-111111111111', HANDLED, { publishedAt: 1, completedAt: 2 });
    const store = new FakeStore([row]);
    const queue = new OutboxEventQueue(TEST_QUEUE, registry().handlersFor(TEST_QUEUE), store, logger);
    await queue.onFinalFailure({ id: 'j1', name: 'handle', data: { eventId: row.id }, scheduledFor: null }, 'RangeError');
    expect(row.deadLetteredAt).toBeNull();
  });
});

describe('the sweeper', () => {
  it('returns a stale claimed event to pending on the existing five-minute contract', async () => {
    const { logger } = silentLogger();
    const row = event('11111111-1111-4111-8111-111111111111', HANDLED);
    const store = new FakeStore([row]);
    const relay = new OutboxRelayQueue(store, registry(), logger, 15_000);
    const publisher = new RecordingPublisher();
    relay.attach(publisher);
    const sweeper = new OutboxSweeperQueue(store, logger, 300_000);

    await relay.drain();
    expect(row.publishedAt).not.toBeNull();

    // Four minutes later nothing is stale yet.
    store.now += 4 * 60_000;
    expect(await sweeper.sweep()).toBe(0);
    expect(row.publishedAt).not.toBeNull();

    // Six minutes after the claim it is.
    store.now += 2 * 60_000;
    expect(await sweeper.sweep()).toBe(1);
    expect(row.publishedAt).toBeNull();
    expect(store.sweeps.at(-1)).toEqual({ staleAfter: '5 minutes', limit: OUTBOX_SWEEP_BATCH_SIZE });

    // And the relay picks it up again, which is the whole point.
    await relay.drain();
    expect(publisher.published).toHaveLength(2);
    expect(row.attempts).toBe(2);
  });

  it('never returns a completed or dead-lettered event', async () => {
    const { logger } = silentLogger();
    const completed = event('11111111-1111-4111-8111-111111111111', HANDLED, { publishedAt: 1, completedAt: 2 });
    const dead = event('22222222-2222-4222-8222-222222222222', HANDLED, { publishedAt: 1, deadLetteredAt: 2 });
    const store = new FakeStore([completed, dead]);
    const sweeper = new OutboxSweeperQueue(store, logger, 300_000);
    expect(await sweeper.sweep()).toBe(0);
  });
});

describe('Redis failure', () => {
  it('loses no outbox row: the event stays in flight and the sweeper returns it', async () => {
    const { logger } = silentLogger();
    const row = event('11111111-1111-4111-8111-111111111111', HANDLED);
    const store = new FakeStore([row]);
    const relay = new OutboxRelayQueue(store, registry(), logger, 15_000);
    const publisher = new RecordingPublisher();
    publisher.fail = true;
    relay.attach(publisher);
    const sweeper = new OutboxSweeperQueue(store, logger, 300_000);

    const result = await relay.drain();

    expect(result).toEqual({ claimed: 1, published: 0, failed: 1 });
    expect(publisher.published).toEqual([]);
    expect(store.events).toHaveLength(1);
    expect(row.completedAt).toBeNull();
    expect(row.deadLetteredAt).toBeNull();

    publisher.fail = false;
    store.now += 6 * 60_000;
    expect(await sweeper.sweep()).toBe(1);
    await relay.drain();
    expect(publisher.published).toHaveLength(1);
  });

  it('propagates a database failure so BullMQ retries the tick', async () => {
    const { logger } = silentLogger();
    const store = new FakeStore([event('11111111-1111-4111-8111-111111111111', HANDLED)]);
    store.failClaim = true;
    const relay = new OutboxRelayQueue(store, registry(), logger, 15_000);
    relay.attach(new RecordingPublisher());
    await expect(relay.drain()).rejects.toThrow('claim unavailable');
  });
});

describe('job run recording', () => {
  it('writes exactly one row per scheduled occurrence, for the relay and for the sweeper', async () => {
    const { logger } = silentLogger();
    const store = new FakeStore([event('11111111-1111-4111-8111-111111111111', HANDLED)]);
    const relay = new OutboxRelayQueue(store, registry(), logger, 15_000);
    relay.attach(new RecordingPublisher());
    const sweeper = new OutboxSweeperQueue(store, logger, 300_000);

    const first = new Date(1_700_000_000_000);
    const second = new Date(1_700_000_015_000);
    await relay.process(tick(first));
    await relay.process(tick(second));
    await sweeper.process({ id: 's1', name: 'sweep', data: { sweeperId: '8a000000-0000-4000-8000-000000000002' }, scheduledFor: first });

    expect(store.runs.map((r) => [r.jobName, r.scheduledFor, r.status, r.processedCount])).toEqual([
      [OUTBOX_RELAY_JOB_NAME, first.getTime(), 'succeeded', 1],
      [OUTBOX_RELAY_JOB_NAME, second.getTime(), 'succeeded', 0],
      [OUTBOX_SWEEPER_JOB_NAME, first.getTime(), 'succeeded', 0],
    ]);
  });

  it('does not duplicate a row when the same occurrence is delivered again', async () => {
    const { logger } = silentLogger();
    const store = new FakeStore([]);
    const relay = new OutboxRelayQueue(store, registry(), logger, 15_000);
    relay.attach(new RecordingPublisher());
    const occurrence = new Date(1_700_000_000_000);

    await relay.process(tick(occurrence));
    await relay.process(tick(occurrence));
    await relay.process(tick(occurrence));

    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]?.status).toBe('succeeded');
  });

  it('records a failed run and still lets the job fail', async () => {
    const { logger } = silentLogger();
    const store = new FakeStore([]);
    store.failClaim = true;
    const relay = new OutboxRelayQueue(store, registry(), logger, 15_000);
    relay.attach(new RecordingPublisher());

    await expect(relay.process(tick(new Date(1_700_000_000_000)))).rejects.toThrow('claim unavailable');
    expect(store.runs.map((r) => [r.status, r.errorType])).toEqual([['failed', 'Error']]);
  });

  it('runs the work even when the occurrence is unknown, recording an unscheduled row', async () => {
    const { logger } = silentLogger();
    const row = event('11111111-1111-4111-8111-111111111111', HANDLED);
    const store = new FakeStore([row]);
    const relay = new OutboxRelayQueue(store, registry(), logger, 15_000);
    relay.attach(new RecordingPublisher());

    await relay.process(tick(null));

    expect(store.runs.map((r) => r.scheduledFor)).toEqual([null]);
    expect(row.publishedAt).not.toBeNull();
  });
});

describe('the scheduler occurrence', () => {
  it('prefers prevMillis and falls back to the scheduler job id', () => {
    expect(scheduledOccurrence({ id: 'repeat:outbox-relay:1700000000000', opts: { prevMillis: 1_700_000_015_000 } })).toEqual(new Date(1_700_000_015_000));
    expect(scheduledOccurrence({ id: 'repeat:outbox-relay:1700000000000' })).toEqual(new Date(1_700_000_000_000));
    expect(scheduledOccurrence({ id: 'repeat:outbox-relay:1700000000000', opts: {} })).toEqual(new Date(1_700_000_000_000));
  });

  it('is null for a job no schedule produced, rather than an invented timestamp', () => {
    expect(scheduledOccurrence({ id: '42' })).toBeNull();
    expect(scheduledOccurrence({})).toBeNull();
    expect(scheduledOccurrence({ id: null })).toBeNull();
    expect(scheduledOccurrence({ id: 'repeat:x:0' })).toBeNull();
  });
});

describe('the financial boundary', () => {
  it('names no financial table, provider, adapter or webhook anywhere in 8-A worker code', async () => {
    const { readFile, readdir } = await import('node:fs/promises');
    const dir = new URL('../src/outbox/', import.meta.url);
    const names = (await readdir(dir)).filter((name) => name.endsWith('.ts')).sort();
    expect(names.length).toBeGreaterThanOrEqual(5);
    const forbidden = [
      'refunds', 'refund_items', 'payments', 'payment_attempts', 'payment_disputes', 'payment_events',
      'ledger_entries', 'ledger_journals', 'seller_balances', 'withdrawals', 'payouts', 'payout_items',
      'provider_settlements', 'PaymentProvider', 'PayoutProvider', 'webhook',
    ];
    for (const name of names) {
      const text = await readFile(new URL(name, dir), 'utf8');
      for (const word of forbidden) {
        expect(text.includes(word), `${name} mentions ${word}`).toBe(false);
      }
    }
  });
});
