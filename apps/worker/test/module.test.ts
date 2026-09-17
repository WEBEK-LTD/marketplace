import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NestFactory } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import { createLogger } from '../src/logging/logger.js';
import { WorkerRuntime } from '../src/runtime/worker-runtime.js';
import { REDIS_CONNECTION, WorkerModule } from '../src/worker.module.js';
import { freePort, startRedis } from './support/redis-server.js';
import { Writable } from 'node:stream';

describe('NestJS standalone module', () => {
  it('wires the runtime and Redis connection and registers no business queues', async () => {
    const server = await startRedis();
    const env = loadEnv({
      NODE_ENV: 'test',
      REDIS_URL: server.url,
      WORKER_HEALTH_HOST: '127.0.0.1',
      WORKER_HEALTH_PORT: String(await freePort()),
    });
    const logger = createLogger('info', new Writable({ write: (_c, _e, cb) => cb() }));
    const app = await NestFactory.createApplicationContext(WorkerModule.forRoot(env, logger), { logger: false });
    try {
      const runtime = app.get(WorkerRuntime);
      expect(runtime).toBeInstanceOf(WorkerRuntime);
      await runtime.start();
      expect((await runtime.readiness()).status).toBe('ready');
      expect(app.get(REDIS_CONNECTION).status).toBe('ready');
      await runtime.stop();
    } finally {
      await app.close();
      await server.stop();
    }
  });
});

describe('msgpackr pure-JavaScript mode', () => {
  it('is disabled for native acceleration when the worker entry order is used', () => {
    const script = `
      await import(${JSON.stringify(fileURLToPath(new URL('../dist/runtime/pure-js-msgpack.js', import.meta.url)))});
      const { createRequire } = await import('node:module');
      const bullmqEntry = import.meta.resolve('bullmq');
      const req = createRequire(bullmqEntry);
      const esm = await import(req.resolve('msgpackr').replace(/dist\\/node\\.cjs$/, 'node-index.js'));
      const bullmq = await import('bullmq');
      console.log(JSON.stringify({ native: esm.isNativeAccelerationEnabled, bullmq: typeof bullmq.Queue }));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
    });
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout.trim())).toEqual({ native: false, bullmq: 'function' });
  });
});
