import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { QueueDefinition } from '../src/queue/definitions.js';
import { createProducer } from '../src/queue/producer.js';
import { EvictionPolicyError } from '../src/redis/eviction-policy.js';
import { startRedis, type RedisInstance } from './support/redis-server.js';
import { createTestRuntime, ID_A, ID_B, inspectQueue, inspector, waitUntil, type TestRuntime } from './support/runtime.js';

// TOOL-5: BullMQ enqueue, retry and dead-letter against local Redis with noeviction.
let server: RedisInstance;
const runtimes: TestRuntime[] = [];

beforeAll(async () => {
  server = await startRedis({ policy: 'noeviction' });
});
afterAll(async () => {
  await server.stop();
});
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((t) => t.runtime.stop()));
});

async function run(definitions: QueueDefinition[], random: () => number = () => 0) {
  const t = await createTestRuntime(server.url, definitions, { random });
  runtimes.push(t);
  await t.runtime.start();
  return t;
}

describe('TOOL-5: enqueue and process', () => {
  it('processes an IDs-only job under the queue prefix', async () => {
    const seen: Array<{ id: string; name: string; data: unknown }> = [];
    await run([{ name: 'tool5-basic', process: async (job) => void seen.push(job) }]);
    const producer = createProducer('tool5-basic', inspector(server.url));
    const jobId = await producer.enqueue('probe', { orderId: ID_A });
    await waitUntil(() => seen.length === 1);
    expect(seen[0]).toEqual({ id: jobId, name: 'probe', data: { orderId: ID_A } });

    const redis = inspector(server.url);
    const keys = await redis.keys('*');
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((key) => key.startsWith('queue:'))).toBe(true);
    const job = await producer.queue.getJob(jobId);
    expect(job?.opts).toMatchObject({ attempts: 5, removeOnComplete: { age: 86_400, count: 1_000 }, removeOnFail: false });
    redis.disconnect();
    await producer.close();
  });

  it('refuses payloads that are not IDs only', async () => {
    const producer = createProducer('tool5-basic', inspector(server.url));
    await expect(producer.enqueue('probe', { email: 'a@b.c' } as never)).rejects.toThrow(/Job data must contain only/);
    await producer.close();
  });
});

describe('TOOL-5: controlled retry', () => {
  it('retries with 1 s then 2 s backoff and then succeeds', async () => {
    const attempts: number[] = [];
    await run([
      {
        name: 'tool5-retry',
        process: async () => {
          attempts.push(Date.now());
          if (attempts.length < 3) throw new Error('temporary failure');
        },
      },
    ]);
    const producer = createProducer('tool5-retry', inspector(server.url));
    const jobId = await producer.enqueue('probe', { orderId: ID_A });
    await waitUntil(async () => (await producer.queue.getJobState(jobId)) === 'completed', 20_000);
    expect(attempts).toHaveLength(3);
    const [a1 = 0, a2 = 0, a3 = 0] = attempts;
    expect(a2 - a1).toBeGreaterThanOrEqual(1_000);
    expect(a2 - a1).toBeLessThan(2_500);
    expect(a3 - a2).toBeGreaterThanOrEqual(2_000);
    expect(a3 - a2).toBeLessThan(3_500);
    await producer.close();
  });
});

describe('TOOL-5: dead-letter', () => {
  it('moves a job to <queue>-dead-letter after 5 attempts with IDs and error type only', async () => {
    const attempts: number[] = [];
    const t = await run(
      [
        {
          name: 'tool5-poison',
          process: async () => {
            attempts.push(Date.now());
            throw new TypeError('secret-internal-message-do-not-store');
          },
        },
      ],
      () => 1,
    );
    const producer = createProducer('tool5-poison', inspector(server.url));
    const jobId = await producer.enqueue('probe', { orderId: ID_A, sellerId: ID_B });
    const deadLetter = inspectQueue('tool5-poison-dead-letter', server.url);
    await waitUntil(async () => (await deadLetter.getJob(`dead-letter-${jobId}`)) !== undefined, 30_000, 200);

    expect(attempts).toHaveLength(5);
    const gaps = attempts.slice(1).map((time, i) => time - (attempts[i] ?? 0));
    [800, 1_600, 3_200, 6_400].forEach((min, i) => expect(gaps[i]).toBeGreaterThanOrEqual(min));

    const entry = await deadLetter.getJob(`dead-letter-${jobId}`);
    expect(entry?.data).toEqual({
      sourceQueue: 'tool5-poison',
      jobId,
      jobName: 'probe',
      attempts: 5,
      data: { orderId: ID_A, sellerId: ID_B },
      errorType: 'TypeError',
    });
    const raw = JSON.stringify(entry?.toJSON());
    expect(raw).not.toContain('secret-internal-message');
    expect(entry?.stacktrace).toEqual([]);
    expect(entry?.failedReason).toBeUndefined();
    expect(raw).not.toMatch(/at \S+ \(|\.ts:\d+/);

    await waitUntil(async () => (await producer.queue.getJob(jobId)) === undefined);
    expect(await producer.queue.getFailedCount()).toBe(0);

    const alert = t.logs().find((line) => line.event === 'dead_letter');
    expect(alert).toMatchObject({ level: 50, sourceQueue: 'tool5-poison', jobId, attempts: 5, errorType: 'TypeError' });
    expect(t.lines.join('\n')).not.toContain('secret-internal-message');
    await producer.close();
    await deadLetter.close();
  });

  it('dead-letters malformed payloads immediately without retrying', async () => {
    let calls = 0;
    await run([{ name: 'tool5-malformed', process: async () => void (calls += 1) }]);
    const raw = createProducer('tool5-malformed', inspector(server.url));
    const job = await raw.queue.add('probe', { note: 'free text is not allowed' });
    const deadLetter = inspectQueue('tool5-malformed-dead-letter', server.url);
    await waitUntil(async () => (await deadLetter.getJob(`dead-letter-${String(job.id)}`)) !== undefined);
    const entry = await deadLetter.getJob(`dead-letter-${String(job.id)}`);
    expect(entry?.data).toMatchObject({ attempts: 1, data: {}, errorType: 'UnrecoverableError' });
    expect(JSON.stringify(entry?.data)).not.toContain('free text');
    expect(calls).toBe(0);
    await raw.close();
    await deadLetter.close();
  });

  it('purges dead-letter entries older than the retention period', async () => {
    const t = await createTestRuntime(server.url, [{ name: 'tool5-purge', process: async () => undefined }], {
      deadLetterRetentionMs: 500,
      purgeIntervalMs: 250,
    });
    runtimes.push(t);
    const deadLetter = inspectQueue('tool5-purge-dead-letter', server.url);
    await deadLetter.add('dead-letter', { sourceQueue: 'tool5-purge' }, { jobId: 'dead-letter-old' });
    await t.runtime.start();
    await waitUntil(async () => (await deadLetter.getJob('dead-letter-old')) === undefined, 10_000);
    expect(t.logs().some((line) => line.event === 'dead_letter_purged')).toBe(true);
    await deadLetter.close();
  });
});

describe('TOOL-5: noeviction is required', () => {
  it('refuses to start against Redis with another eviction policy', async () => {
    const lru = await startRedis({ policy: 'allkeys-lru' });
    const t = await createTestRuntime(lru.url, [{ name: 'tool5-lru', process: async () => undefined }]);
    try {
      await expect(t.runtime.start()).rejects.toBeInstanceOf(EvictionPolicyError);
      const ready = await fetch(`${t.healthUrl}/ready`);
      expect(ready.status).toBe(503);
    } finally {
      await t.runtime.stop();
      await lru.stop();
    }
  });
});
