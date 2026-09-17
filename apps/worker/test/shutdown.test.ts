import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProducer } from '../src/queue/producer.js';
import { freePort, startRedis, type RedisInstance } from './support/redis-server.js';
import { createTestRuntime, ID_A, inspector, waitUntil } from './support/runtime.js';

const MAIN = fileURLToPath(new URL('../dist/main.js', import.meta.url));
let server: RedisInstance;
beforeAll(async () => {
  server = await startRedis();
});
afterAll(async () => {
  await server.stop();
});

describe('graceful shutdown', () => {
  it('lets an active job finish before closing', async () => {
    let finished = false;
    const t = await createTestRuntime(server.url, [
      {
        name: 'shutdown-drain',
        process: async () => {
          await new Promise((resolve) => setTimeout(resolve, 1_500));
          finished = true;
        },
      },
    ]);
    await t.runtime.start();
    const producer = createProducer('shutdown-drain', inspector(server.url));
    const jobId = await producer.enqueue('probe', { orderId: ID_A });
    await waitUntil(async () => (await producer.queue.getJobState(jobId)) === 'active');
    const started = Date.now();
    const result = await t.runtime.stop('SIGTERM');
    expect(result.timedOut).toBe(false);
    expect(finished).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
    expect(await producer.queue.getJobState(jobId)).toBe('completed');
    expect(t.redis.status).toBe('end');
    expect(await fetch(`${t.healthUrl}/health`).then(() => 'open', () => 'closed')).toBe('closed');
    expect(t.logs().map((line) => line.event)).toEqual(expect.arrayContaining(['shutdown_started', 'shutdown_complete']));
    await producer.close();
  });

  it('force-closes after the timeout and the unfinished job is retried later', async () => {
    const processedBy: string[] = [];
    const slow = {
      name: 'shutdown-timeout',
      process: async () => {
        processedBy.push('first');
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        processedBy.push('first-finished-after-forced-close');
      },
    };
    const first = await createTestRuntime(server.url, [slow], {
      envOverrides: { WORKER_SHUTDOWN_TIMEOUT_MS: '500' },
      lockDurationMs: 1_000,
      stalledIntervalMs: 500,
    });
    await first.runtime.start();
    const producer = createProducer('shutdown-timeout', inspector(server.url));
    const jobId = await producer.enqueue('probe', { orderId: ID_A });
    await waitUntil(() => processedBy.length === 1);
    const started = Date.now();
    const result = await first.runtime.stop('SIGTERM');
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(first.logs().some((line) => line.event === 'shutdown_timeout')).toBe(true);
    expect(await producer.queue.getJobState(jobId)).toBe('active');

    const second = await createTestRuntime(
      server.url,
      [{ name: 'shutdown-timeout', process: async () => void processedBy.push('second') }],
      { lockDurationMs: 1_000, stalledIntervalMs: 500 },
    );
    await second.runtime.start();
    await waitUntil(() => processedBy.includes('second'), 20_000, 100);
    await waitUntil(async () => (await producer.queue.getJobState(jobId)) === 'completed', 10_000);
    await second.runtime.stop();
    await producer.close();

    // The force-closed job keeps running in this process and finishes later; the event loop
    // must stay responsive when it does (no busy retry loop against a closed connection).
    const ticks: number[] = [];
    const ticker = setInterval(() => ticks.push(Date.now()), 50);
    try {
      await waitUntil(() => processedBy.includes('first-finished-after-forced-close'), 10_000);
      const before = ticks.length;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(ticks.length - before).toBeGreaterThanOrEqual(15);
    } finally {
      clearInterval(ticker);
    }
  });
});

describe('shutdown while Redis is unavailable', () => {
  function trackProcessErrors() {
    const errors: string[] = [];
    const onError = (error: unknown) => void errors.push(String(error));
    process.on('uncaughtException', onError);
    process.on('unhandledRejection', onError);
    return {
      errors,
      dispose: () => {
        process.off('uncaughtException', onError);
        process.off('unhandledRejection', onError);
      },
    };
  }

  it('force-closes immediately when Redis is already down', async () => {
    const own = await startRedis();
    const t = await createTestRuntime(own.url, [{ name: 'shutdown-down', process: async () => undefined }]);
    await t.runtime.start();
    await own.stop();
    await waitUntil(() => t.redis.status !== 'ready');
    const tracker = trackProcessErrors();
    try {
      const started = Date.now();
      const result = await t.runtime.stop('SIGTERM');
      expect(result.timedOut).toBe(false);
      expect(Date.now() - started).toBeLessThan(1_500);
      expect(t.logs().some((line) => line.event === 'shutdown_redis_unavailable')).toBe(true);
      expect(t.logs().some((line) => line.event === 'shutdown_complete')).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(tracker.errors).toEqual([]);
    } finally {
      tracker.dispose();
    }
  });

  it('completes within the timeout when Redis dies during draining', async () => {
    const own = await startRedis();
    let started = false;
    const t = await createTestRuntime(
      own.url,
      [
        {
          name: 'shutdown-middrain',
          process: async () => {
            started = true;
            await new Promise((resolve) => setTimeout(resolve, 1_000));
          },
        },
      ],
      { envOverrides: { WORKER_SHUTDOWN_TIMEOUT_MS: '2000' } },
    );
    await t.runtime.start();
    const producer = createProducer('shutdown-middrain', inspector(own.url));
    await producer.enqueue('probe', { orderId: ID_A });
    await waitUntil(() => started);
    const tracker = trackProcessErrors();
    try {
      const began = Date.now();
      const stopping = t.runtime.stop('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 200));
      await own.stop();
      const result = await stopping;
      // The job's own work finished (1 s); recording its completion is impossible while Redis is
      // down, so it stays in Redis and is retried later. Shutdown still completes in bounded time.
      expect(result.timedOut).toBe(false);
      expect(Date.now() - began).toBeLessThan(4_000);
      expect(t.logs().some((line) => line.event === 'shutdown_complete')).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(tracker.errors).toEqual([]);
    } finally {
      tracker.dispose();
      await producer.close().catch(() => undefined);
    }
  });
});

function runMain(env: Record<string, string>, onReady?: (child: ReturnType<typeof spawn>) => void) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [MAIN], { env: { PATH: process.env.PATH ?? '', ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (onReady !== undefined && stdout.includes('"event":"worker_started"')) {
        const ready = onReady;
        onReady = undefined;
        ready(child);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('built worker process', () => {
  it('exists (run the build first)', () => {
    expect(existsSync(MAIN)).toBe(true);
  });

  it('exits with code 0 after SIGTERM and logs only JSON', async () => {
    const result = await runMain(
      { NODE_ENV: 'test', REDIS_URL: server.url, WORKER_HEALTH_HOST: '127.0.0.1', WORKER_HEALTH_PORT: String(await freePort()) },
      (child) => child.kill('SIGTERM'),
    );
    expect(result.code).toBe(0);
    const configLine = result.stdout.split('\n').find((line) => line.includes('"config_loaded"')) ?? '';
    expect(JSON.parse(configLine)).toMatchObject({ event: 'config_loaded', component: 'worker', variablesValidated: 7 });
    for (const forbidden of ['redis://', String(server.port), '127.0.0.1', 'REDIS_URL', 'NODE_ENV', '"test"']) {
      expect(configLine).not.toContain(forbidden);
    }
    const events = result.stdout.trim().split('\n').map((line) => (JSON.parse(line) as { event?: string }).event);
    expect(events.indexOf('shutdown_started')).toBeLessThan(events.indexOf('shutdown_complete'));
    expect(result.stdout).not.toContain(server.url);
  });

  it('exits with code 1 when Redis does not use noeviction, without logging the URL', async () => {
    const lru = await startRedis({ policy: 'allkeys-lru', password: 'lru-secret-password' });
    try {
      const result = await runMain({
        NODE_ENV: 'test',
        REDIS_URL: lru.url,
        WORKER_HEALTH_HOST: '127.0.0.1',
        WORKER_HEALTH_PORT: String(await freePort()),
      });
      expect(result.code).toBe(1);
      expect(result.stdout).toContain('"event":"worker_start_failed"');
      expect(result.stdout).toContain('"errorType":"EvictionPolicyError"');
      expect(result.stdout + result.stderr).not.toContain('lru-secret-password');
    } finally {
      await lru.stop();
    }
  });

  it('exits with code 1 on invalid environment without printing values', async () => {
    const result = await runMain({
      NODE_ENV: 'production',
      REDIS_URL: 'redis://:prod-password-not-printed@redis:6379',
      WORKER_HEALTH_HOST: '127.0.0.1',
      WORKER_HEALTH_PORT: '8081',
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Invalid or missing environment variables: REDIS_URL');
    expect(result.stdout + result.stderr).not.toContain('prod-password-not-printed');
  });
});
