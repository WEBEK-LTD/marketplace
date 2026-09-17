import { HealthResponseSchema, ProblemDetailsSchema, ReadinessResponseSchema } from '@repo/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startRedis, type RedisInstance } from './support/redis-server.js';
import { createTestRuntime, type TestRuntime } from './support/runtime.js';

let server: RedisInstance;
let t: TestRuntime;
beforeAll(async () => {
  server = await startRedis();
  t = await createTestRuntime(server.url, [{ name: 'health-probe', process: async () => undefined }]);
  await t.runtime.start();
});
afterAll(async () => {
  await t.runtime.stop();
  await server.stop();
});

describe('internal health server', () => {
  it('GET /health reports process health', async () => {
    const res = await fetch(`${t.healthUrl}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(HealthResponseSchema.parse(await res.json())).toEqual({ status: 'ok' });
  });

  it('GET /ready reports Redis and worker readiness', async () => {
    const res = await fetch(`${t.healthUrl}/ready`);
    expect(res.status).toBe(200);
    expect(ReadinessResponseSchema.parse(await res.json())).toEqual({
      status: 'ready',
      checks: [
        { name: 'redis', status: 'ok' },
        { name: 'workers', status: 'ok' },
      ],
    });
  });

  it.each([
    ['GET', '/metrics'],
    ['POST', '/health'],
    ['DELETE', '/ready'],
    ['GET', '/ready/extra'],
    ['GET', '/healthz'],
  ])('%s %s returns a 404 problem', async (method, path) => {
    const res = await fetch(`${t.healthUrl}${path}`, { method });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/problem+json; charset=utf-8');
    expect(ProblemDetailsSchema.parse(await res.json()).code).toBe('NOT_FOUND');
  });

  it('never exposes the Redis URL', async () => {
    const bodies = await Promise.all(['/health', '/ready', '/x'].map(async (path) => (await fetch(`${t.healthUrl}${path}`)).text()));
    for (const body of bodies) expect(body).not.toContain(String(server.port));
  });
});
