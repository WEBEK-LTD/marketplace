import { afterEach, describe, expect, it } from 'vitest';
import { createProducer } from '../src/queue/producer.js';
import { startRedis, freePort, type RedisInstance } from './support/redis-server.js';
import { createTestRuntime, ID_A, inspector, waitUntil, type TestRuntime } from './support/runtime.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function readyStatus(t: TestRuntime): Promise<number> {
  return (await fetch(`${t.healthUrl}/ready`)).status;
}

describe('Redis unavailable at start-up', () => {
  it('keeps retrying, stays not ready, then starts consuming when Redis appears', async () => {
    const port = await freePort();
    const processed: string[] = [];
    const t = await createTestRuntime(`redis://127.0.0.1:${port}`, [
      { name: 'resilience-start', process: async (job) => void processed.push(job.id) },
    ]);
    cleanup.push(() => t.runtime.stop().then(() => undefined));
    const starting = t.runtime.start();
    await waitUntil(async () => (await fetch(`${t.healthUrl}/health`).then((r) => r.status).catch(() => 0)) === 200);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(await readyStatus(t)).toBe(503);

    const server: RedisInstance = await startRedis({ port });
    cleanup.push(() => server.stop());
    await starting;
    await waitUntil(async () => (await readyStatus(t)) === 200, 15_000);

    const producer = createProducer('resilience-start', inspector(server.url));
    const jobId = await producer.enqueue('probe', { orderId: ID_A });
    await waitUntil(() => processed.includes(jobId));
    await producer.close();
    expect(t.logs().some((line) => line.event === 'redis_error')).toBe(true);
  });
});

describe('Redis outage while running', () => {
  it('reports not ready during the outage and resumes processing after recovery', async () => {
    const server = await startRedis();
    cleanup.push(() => server.stop());
    const processed: string[] = [];
    const t = await createTestRuntime(server.url, [
      { name: 'resilience-outage', process: async (job) => void processed.push(job.id) },
    ]);
    cleanup.push(() => t.runtime.stop().then(() => undefined));
    await t.runtime.start();
    expect(await readyStatus(t)).toBe(200);

    await server.stop();
    await waitUntil(async () => (await readyStatus(t)) === 503, 10_000);
    expect(await fetch(`${t.healthUrl}/health`).then((r) => r.status)).toBe(200);

    await server.start();
    await waitUntil(async () => (await readyStatus(t)) === 200, 20_000, 200);
    expect(t.logs().filter((line) => line.event === 'redis_ready').length).toBeGreaterThanOrEqual(2);

    const producer = createProducer('resilience-outage', inspector(server.url));
    const jobId = await producer.enqueue('probe', { orderId: ID_A });
    await waitUntil(() => processed.includes(jobId), 20_000);
    await producer.close();
  });

  it('shuts down with an error if Redis comes back without noeviction', async () => {
    const server = await startRedis();
    cleanup.push(() => server.stop());
    const t = await createTestRuntime(server.url, [{ name: 'resilience-policy', process: async () => undefined }]);
    await t.runtime.start();
    const received: string[] = [];
    t.runtime.onFatal((error) => void received.push(error.name));
    cleanup.push(() => t.runtime.stop().then(() => undefined));
    await server.stop();
    const lru = await startRedis({ port: server.port, policy: 'allkeys-lru' });
    cleanup.push(() => lru.stop());
    await waitUntil(() => t.runtime.fatal !== undefined, 20_000, 200);
    expect(received).toEqual(['EvictionPolicyError']);
    expect(t.logs().some((line) => line.event === 'eviction_policy_failed')).toBe(true);
  });
});

describe('Redis authentication', () => {
  it('connects with the password from REDIS_URL and never logs it', async () => {
    const server = await startRedis({ password: 'pw-must-not-appear-in-logs' });
    cleanup.push(() => server.stop());
    const t = await createTestRuntime(server.url, [{ name: 'auth-ok', process: async () => undefined }]);
    cleanup.push(() => t.runtime.stop().then(() => undefined));
    await t.runtime.start();
    expect(await readyStatus(t)).toBe(200);
    expect(t.lines.join('\n')).not.toContain('pw-must-not-appear-in-logs');
  });

  it('stays not ready with a wrong password and never logs either password', async () => {
    const server = await startRedis({ password: 'the-real-password' });
    cleanup.push(() => server.stop());
    const wrongUrl = `redis://:the-wrong-password@127.0.0.1:${server.port}`;
    const t = await createTestRuntime(wrongUrl, [{ name: 'auth-bad', process: async () => undefined }]);
    cleanup.push(() => t.runtime.stop().then(() => undefined));
    void t.runtime.start().catch(() => undefined);
    await waitUntil(() => t.logs().some((line) => line.event === 'redis_error'), 10_000);
    expect(await readyStatus(t)).toBe(503);
    const all = t.lines.join('\n');
    expect(all).not.toContain('the-real-password');
    expect(all).not.toContain('the-wrong-password');
  });
});
