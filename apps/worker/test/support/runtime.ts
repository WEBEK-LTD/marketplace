import { Writable } from 'node:stream';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { loadEnv, type WorkerEnv } from '../../src/config/env.js';
import { createLogger } from '../../src/logging/logger.js';
import type { QueueDefinition } from '../../src/queue/definitions.js';
import { createRedisConnection } from '../../src/redis/connection.js';
import { WorkerRuntime, type RuntimeOptions } from '../../src/runtime/worker-runtime.js';
import { freePort } from './redis-server.js';

export interface TestRuntime {
  readonly runtime: WorkerRuntime;
  readonly logger: ReturnType<typeof createLogger>;
  readonly redis: Redis;
  readonly env: WorkerEnv;
  readonly lines: string[];
  readonly healthUrl: string;
  logs(): Array<Record<string, unknown>>;
}

export async function createTestRuntime(
  redisUrl: string,
  definitions: readonly QueueDefinition[],
  options: RuntimeOptions & { readonly envOverrides?: Record<string, string> } = {},
): Promise<TestRuntime> {
  const port = await freePort();
  const env = loadEnv({
    NODE_ENV: 'test',
    REDIS_URL: redisUrl,
    WORKER_HEALTH_HOST: '127.0.0.1',
    WORKER_HEALTH_PORT: String(port),
    LOG_LEVEL: 'debug',
    ...options.envOverrides,
  });
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(...chunk.toString().split('\n').filter((line) => line.length > 0));
      callback();
    },
  });
  const logger = createLogger(env.logLevel, stream);
  const redis = createRedisConnection(env.redisUrl, logger);
  const runtime = new WorkerRuntime(env, redis, definitions, logger, options);
  return {
    runtime,
    logger,
    redis,
    env,
    lines,
    healthUrl: `http://127.0.0.1:${port}`,
    logs: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

/** A separate client for inspecting Redis in tests. */
export function inspector(url: string): Redis {
  const client = new Redis(url, { maxRetriesPerRequest: 1, lazyConnect: false });
  client.on('error', () => undefined);
  return client;
}

/** Read-only access to a queue (including dead-letter queues) for assertions. */
export function inspectQueue(name: string, url: string): Queue {
  const queue = new Queue(name, { connection: inspector(url), prefix: 'queue' });
  queue.on('error', () => undefined);
  return queue;
}

export async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 20_000, stepMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error('condition not met in time');
}

export const ID_A = '11111111-1111-4111-8111-111111111111';
export const ID_B = '22222222-2222-4222-8222-222222222222';
