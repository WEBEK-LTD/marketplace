import { HealthResponseSchema, ReadinessResponseSchema } from '@repo/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReadinessService, type ReadinessCheck } from '../src/health/readiness.js';
import { createTestApp, type TestApp } from './support/app.js';

describe('health endpoints', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('GET /health returns the liveness contract', async () => {
    const res = await request(t.app.getHttpServer()).get('/health');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(HealthResponseSchema.parse(res.body)).toEqual({ status: 'ok' });
  });

  it('GET /ready is ready with an empty check list in Step 3', async () => {
    const res = await request(t.app.getHttpServer()).get('/ready');
    expect(res.status).toBe(200);
    expect(ReadinessResponseSchema.parse(res.body)).toEqual({ status: 'ready', checks: [] });
  });

  it('health checks are outside /v1', async () => {
    expect((await request(t.app.getHttpServer()).get('/v1/health')).status).toBe(404);
  });
});

describe('readiness with failing checks', () => {
  const checks: ReadinessCheck[] = [
    { name: 'passing', check: async () => true },
    { name: 'failing', check: async () => false },
    {
      name: 'throwing',
      check: async () => {
        throw new Error('connection refused');
      },
    },
  ];

  it('the service reports each check and never throws', async () => {
    await expect(new ReadinessService(checks).evaluate()).resolves.toEqual({
      status: 'not_ready',
      checks: [
        { name: 'passing', status: 'ok' },
        { name: 'failing', status: 'failed' },
        { name: 'throwing', status: 'failed' },
      ],
    });
    await expect(new ReadinessService([checks[0] as ReadinessCheck]).evaluate()).resolves.toMatchObject({ status: 'ready' });
  });

  it('GET /ready returns 503 with the contract body', async () => {
    const t = await createTestApp({ readinessChecks: checks });
    try {
      const res = await request(t.app.getHttpServer()).get('/ready');
      expect(res.status).toBe(503);
      expect(ReadinessResponseSchema.parse(res.body).status).toBe('not_ready');
      expect(res.text).not.toContain('connection refused');
    } finally {
      await t.app.close();
    }
  });
});
