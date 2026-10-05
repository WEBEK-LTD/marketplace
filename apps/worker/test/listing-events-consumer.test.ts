import { Writable } from 'node:stream';
import { Redis } from 'ioredis';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LISTING_EVENT_DRAIN_BATCH,
  LISTING_EVENT_DRAIN_INTERVAL_MS,
  LISTING_EVENT_GROUP,
  LISTING_EVENT_JOB,
  LISTING_EVENT_PAYLOAD,
  LISTING_EVENT_QUEUE,
  LISTING_EVENT_SCHEDULER_ID,
  LISTING_EVENT_STREAM,
  ListingEventConsumerQueue,
} from '../src/analytics/listing-events.consumer.js';
import { createLogger, type WorkerLogger } from '../src/logging/logger.js';
import { assertIdPayload } from '../src/queue/payload.js';
import { assertQueueName } from '../src/queue/policy.js';
import type { QueueJob } from '../src/queue/definitions.js';
import { startRedis, type RedisInstance } from './support/redis-server.js';

/**
 * The listing event stream consumer (0101, O-21's approved path).
 *
 * Run against a **real Redis stream and a real consumer group**, because the properties that matter are
 * Redis's own semantics rather than anything this class computes: an entry stays pending until it is
 * acknowledged, a restart re-reads what it never acknowledged, and a group that already exists answers
 * `BUSYGROUP` rather than failing a start.
 *
 * The three properties under test, in order of what would be lost without them:
 *
 *   * **written before acknowledged.** A crash between the two re-delivers the entry, and 0013's writer
 *     de-duplicates on the event id, so the repeat inserts nothing. Acknowledging first would be
 *     at-most-once and would lose events on exactly the failure this ordering exists for.
 *   * **nothing is interpreted.** The API resolved the account and hashed the session; these rows are moved
 *     byte for byte, so there is no field here that could decide whose event it is.
 *   * **a poison entry is dropped, not retried for ever.** An unparseable payload can never succeed, and
 *     leaving it pending would hold the whole backlog behind one bad string.
 *
 * No database is involved: the writer is a double, which is also how a failing insert is exercised.
 */

const ROWS: readonly Record<string, unknown>[] = [
  {
    event_id: '11111111-1111-4111-8111-111111111111',
    listing_id: '22222222-2222-4222-8222-222222222222',
    event_type: 'click',
    occurred_at: '2026-10-03T12:00:00.000Z',
    user_id: null,
    session_hash: 'ab'.repeat(32),
    source: 'search',
    referrer_host: null,
    promotion_id: null,
  },
];

interface Recorded {
  readonly batches: Array<readonly Record<string, unknown>[]>;
}

/** A writer double. `failUntil` makes the first N inserts throw, as a brief outage would. */
function writer(recorded: Recorded, failUntil = 0): { recordListingEvents(rows: readonly Record<string, unknown>[]): Promise<number> } {
  let attempts = 0;
  return {
    recordListingEvents: async (rows) => {
      attempts += 1;
      if (attempts <= failUntil) throw new Error('the database is unavailable');
      recorded.batches.push(rows);
      return rows.length;
    },
  };
}

function silent(): { logger: WorkerLogger; lines: Array<Record<string, unknown>> } {
  const lines: Array<Record<string, unknown>> = [];
  const logger = createLogger(
    'debug',
    new Writable({
      write: (chunk, _encoding, callback) => {
        lines.push(JSON.parse(String(chunk)) as Record<string, unknown>);
        callback();
      },
    }),
  );
  return { logger, lines };
}

let server: RedisInstance;
let redis: Redis;

beforeEach(async () => {
  server = await startRedis();
  redis = new Redis(server.url, { maxRetriesPerRequest: 1 });
});

afterEach(async () => {
  await redis.quit().catch(() => undefined);
  await server.stop();
});

function consumer(
  recorded: Recorded,
  options: { readonly failUntil?: number; readonly batchSize?: number } = {},
): { queue: ListingEventConsumerQueue; lines: Array<Record<string, unknown>> } {
  const { logger, lines } = silent();
  return {
    queue: new ListingEventConsumerQueue(
      redis,
      writer(recorded, options.failUntil ?? 0),
      logger,
      LISTING_EVENT_DRAIN_INTERVAL_MS,
      options.batchSize ?? LISTING_EVENT_DRAIN_BATCH,
    ),
    lines,
  };
}

/** One entry on the stream, in the shape the API's `XADD` writes. */
async function publish(rows: unknown): Promise<string> {
  const id = await redis.xadd(LISTING_EVENT_STREAM, '*', 'events', JSON.stringify(rows));
  if (id === null) throw new Error('the stream accepted nothing');
  return id;
}

/** How many entries this group has delivered and not had acknowledged. */
async function pending(): Promise<number> {
  const summary = (await redis.xpending(LISTING_EVENT_STREAM, LISTING_EVENT_GROUP)) as [number, ...unknown[]] | null;
  return summary === null ? 0 : Number(summary[0]);
}

/* ------------------------------------------------------------------------------------------------ */

describe('the consumer group', () => {
  /** `MKSTREAM`, so the worker can be running before the API has ever ingested anything. */
  it('is created before the stream exists, and reads nothing', async () => {
    const recorded: Recorded = { batches: [] };
    expect(await redis.exists(LISTING_EVENT_STREAM)).toBe(0);

    expect(await consumer(recorded).queue.drain()).toBe(0);

    expect(await redis.exists(LISTING_EVENT_STREAM)).toBe(1);
    const groups = (await redis.xinfo('GROUPS', LISTING_EVENT_STREAM)) as unknown[][];
    expect(groups.map((group) => group[1])).toContain(LISTING_EVENT_GROUP);
    expect(recorded.batches).toEqual([]);
  });

  /** The expected answer on every start after the first; a second process must not fail on it. */
  it('tolerates a group that already exists', async () => {
    const recorded: Recorded = { batches: [] };
    await consumer(recorded).queue.drain();
    await expect(consumer(recorded).queue.drain()).resolves.toBe(0);

    await publish(ROWS);
    expect(await consumer(recorded).queue.drain()).toBe(1);
  });

  it('reads from the beginning, so an entry written before the first drain is not skipped', async () => {
    const recorded: Recorded = { batches: [] };
    await publish(ROWS);
    expect(await consumer(recorded).queue.drain()).toBe(1);
    expect(recorded.batches).toHaveLength(1);
  });
});

describe('a drain', () => {
  it('writes the rows and acknowledges the entry', async () => {
    const recorded: Recorded = { batches: [] };
    await publish(ROWS);

    expect(await consumer(recorded).queue.drain()).toBe(1);
    expect(recorded.batches).toEqual([ROWS]);
    expect(await pending()).toBe(0);
  });

  /** It moves bytes. Nothing is derived, renamed or defaulted on the way through. */
  it('passes the rows through byte for byte, keys and all', async () => {
    const recorded: Recorded = { batches: [] };
    await publish(ROWS);
    await consumer(recorded).queue.drain();

    expect(recorded.batches[0]).toEqual(ROWS);
    expect(Object.keys(recorded.batches[0]![0]!)).toEqual(Object.keys(ROWS[0]!));
    expect(recorded.batches[0]![0]!['session_hash']).toBe('ab'.repeat(32));
    expect(recorded.batches[0]![0]!['user_id']).toBeNull();
  });

  it('takes several entries in one pass, each as its own batch', async () => {
    const recorded: Recorded = { batches: [] };
    await publish(ROWS);
    await publish([{ ...ROWS[0]!, event_id: '33333333-3333-4333-8333-333333333333' }]);
    await publish([{ ...ROWS[0]!, event_id: '44444444-4444-4444-8444-444444444444' }]);

    expect(await consumer(recorded).queue.drain()).toBe(3);
    expect(recorded.batches).toHaveLength(3);
    expect(await pending()).toBe(0);
  });

  it('claims no more than its batch size in one pass', async () => {
    const recorded: Recorded = { batches: [] };
    for (let index = 0; index < 5; index += 1) await publish(ROWS);

    const { queue } = consumer(recorded, { batchSize: 2 });
    expect(await queue.drain()).toBe(2);
    expect(await queue.drain()).toBe(2);
    expect(await queue.drain()).toBe(1);
    expect(await queue.drain()).toBe(0);
  });

  it('answers zero and writes nothing when the stream is empty', async () => {
    const recorded: Recorded = { batches: [] };
    const { queue } = consumer(recorded);
    expect(await queue.drain()).toBe(0);
    expect(await queue.drain()).toBe(0);
    expect(recorded.batches).toEqual([]);
  });

  it('is what processing a scheduled job does', async () => {
    const recorded: Recorded = { batches: [] };
    await publish(ROWS);
    const job: QueueJob = {
      id: '1',
      name: LISTING_EVENT_JOB,
      data: LISTING_EVENT_PAYLOAD,
      scheduledFor: new Date('2026-10-03T12:00:00.000Z'),
    };

    await consumer(recorded).queue.process(job);
    expect(recorded.batches).toEqual([ROWS]);
  });
});

describe('at-least-once delivery', () => {
  /**
   * The ordering that makes the whole path safe. The insert failed, so nothing is acknowledged and the
   * entry is still the group's to deliver.
   */
  it('leaves an entry pending when the insert fails', async () => {
    const recorded: Recorded = { batches: [] };
    await publish(ROWS);

    const { queue } = consumer(recorded, { failUntil: 1 });
    await expect(queue.drain()).rejects.toThrow();

    expect(recorded.batches).toEqual([]);
    expect(await pending()).toBe(1);
  });

  /** And the next tick re-reads it. The repeat is safe because 0013's writer de-duplicates. */
  it('re-delivers the pending entry on the next drain, rather than skipping it', async () => {
    const recorded: Recorded = { batches: [] };
    await publish(ROWS);

    const { queue } = consumer(recorded, { failUntil: 1 });
    await expect(queue.drain()).rejects.toThrow();

    // The same consumer, now that the database is back: the entry it never acknowledged comes round again.
    expect(await queue.drain()).toBe(1);
    expect(recorded.batches).toEqual([ROWS]);
    expect(await pending()).toBe(0);
  });

  /** A restart is the same case: the pending list belongs to the consumer name, not to the process. */
  it('resumes a pending entry in a fresh consumer after a restart', async () => {
    const first: Recorded = { batches: [] };
    await publish(ROWS);
    await expect(consumer(first, { failUntil: 1 }).queue.drain()).rejects.toThrow();
    expect(await pending()).toBe(1);

    const second: Recorded = { batches: [] };
    expect(await consumer(second).queue.drain()).toBe(1);
    expect(second.batches).toEqual([ROWS]);
    expect(await pending()).toBe(0);
  });

  /** Pending first, so a backlog is not overtaken by new traffic and left behind for ever. */
  it('takes the pending entry before anything newer', async () => {
    const recorded: Recorded = { batches: [] };
    const older = [{ ...ROWS[0]!, event_id: '55555555-5555-4555-8555-555555555555' }];
    await publish(older);

    const { queue } = consumer(recorded, { failUntil: 1, batchSize: 1 });
    await expect(queue.drain()).rejects.toThrow();

    await publish([{ ...ROWS[0]!, event_id: '66666666-6666-4666-8666-666666666666' }]);
    expect(await queue.drain()).toBe(1);
    expect(recorded.batches[0]).toEqual(older);
  });
});

describe('a poison entry', () => {
  /** It can never succeed, so it is acknowledged and logged rather than holding up the backlog. */
  it('is acknowledged and logged when its payload is not JSON', async () => {
    const recorded: Recorded = { batches: [] };
    await redis.xadd(LISTING_EVENT_STREAM, '*', 'events', '{not json');

    const { queue, lines } = consumer(recorded);
    expect(await queue.drain()).toBe(1);

    expect(recorded.batches).toEqual([]);
    expect(await pending()).toBe(0);
    expect(lines.some((line) => String(line['msg']).includes('could not be read'))).toBe(true);
  });

  it('is acknowledged when its payload is JSON of the wrong shape', async () => {
    const recorded: Recorded = { batches: [] };
    for (const payload of [{ events: 1 }, 'click', 42, null, [1, 2], [null], [['a']]]) {
      await publish(payload);
    }

    expect(await consumer(recorded).queue.drain()).toBe(7);
    expect(recorded.batches).toEqual([]);
    expect(await pending()).toBe(0);
  });

  it('is acknowledged when the entry has no events field at all', async () => {
    const recorded: Recorded = { batches: [] };
    await redis.xadd(LISTING_EVENT_STREAM, '*', 'rows', JSON.stringify(ROWS));

    const { queue, lines } = consumer(recorded);
    expect(await queue.drain()).toBe(1);
    expect(recorded.batches).toEqual([]);
    expect(lines.some((line) => String(line['msg']).includes('could not be read'))).toBe(true);
  });

  it('never holds up the entries behind it', async () => {
    const recorded: Recorded = { batches: [] };
    await redis.xadd(LISTING_EVENT_STREAM, '*', 'events', 'not json at all');
    await publish(ROWS);

    expect(await consumer(recorded).queue.drain()).toBe(2);
    expect(recorded.batches).toEqual([ROWS]);
    expect(await pending()).toBe(0);
  });

  /** An empty batch is not poison — it is nothing to write — so it is acknowledged without a warning. */
  it('is not what an empty batch is: that is acknowledged quietly', async () => {
    const recorded: Recorded = { batches: [] };
    await publish([]);

    const { queue, lines } = consumer(recorded);
    expect(await queue.drain()).toBe(1);
    expect(recorded.batches).toEqual([]);
    expect(await pending()).toBe(0);
    expect(lines.some((line) => String(line['msg']).includes('could not be read'))).toBe(false);
  });

  it('is logged without its payload, so a malformed entry cannot write itself into the log', async () => {
    const recorded: Recorded = { batches: [] };
    await redis.xadd(LISTING_EVENT_STREAM, '*', 'events', 'secret-looking-payload-abcdef');

    const { queue, lines } = consumer(recorded);
    await queue.drain();
    expect(JSON.stringify(lines)).not.toContain('secret-looking-payload');
  });
});

describe('the registration', () => {
  it('uses a queue name the worker policy accepts', () => {
    expect(() => assertQueueName(LISTING_EVENT_QUEUE)).not.toThrow();
  });

  it('declares a repeatable schedule with a stable scheduler id', () => {
    const recorded: Recorded = { batches: [] };
    const { queue } = consumer(recorded);
    expect(queue.name).toBe(LISTING_EVENT_QUEUE);
    expect(queue.schedule).toEqual({
      jobName: LISTING_EVENT_JOB,
      schedulerId: LISTING_EVENT_SCHEDULER_ID,
      everyMs: LISTING_EVENT_DRAIN_INTERVAL_MS,
      data: LISTING_EVENT_PAYLOAD,
    });
  });

  /** The worker's IDs-only rule: a job payload carries identifiers and never event content. */
  it('carries an identifiers-only payload', () => {
    expect(() => assertIdPayload(LISTING_EVENT_PAYLOAD)).not.toThrow();
    expect(Object.keys(LISTING_EVENT_PAYLOAD)).toEqual(['consumerId']);
  });

  it('drains every second, the same order as the loss window O-21 already accepts', () => {
    expect(LISTING_EVENT_DRAIN_INTERVAL_MS).toBe(1_000);
    expect(LISTING_EVENT_DRAIN_BATCH).toBe(50);
  });
});
