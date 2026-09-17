import { ProblemDetailsSchema } from '@repo/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INTERNAL_DETAIL_MARKER } from './support/probe.module.js';
import { createTestApp, type TestApp } from './support/app.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.app.close();
});

function expectProblem(res: request.Response, status: number, code: string): void {
  expect(res.status).toBe(status);
  expect(res.headers['content-type']).toBe('application/problem+json; charset=utf-8');
  const body = JSON.parse(res.text) as unknown;
  expect(ProblemDetailsSchema.parse(body)).toMatchObject({ type: 'about:blank', status, code });
  expect(res.text).not.toMatch(/stack|at \w+ \(|node_modules/);
  expect(res.text).not.toContain(INTERNAL_DETAIL_MARKER);
}

describe('problem details', () => {
  it('returns NOT_FOUND for unknown routes with the path (without query) as instance', async () => {
    const res = await request(t.app.getHttpServer()).get('/missing?token=abc');
    expectProblem(res, 404, 'NOT_FOUND');
    expect(JSON.parse(res.text)).toMatchObject({ title: 'Not Found', instance: '/missing' });
  });

  it('returns VALIDATION_FAILED with field errors for an invalid body', async () => {
    const res = await request(t.app.getHttpServer()).post('/probe/echo').send({ name: '', extra: true });
    expectProblem(res, 400, 'VALIDATION_FAILED');
    const body = JSON.parse(res.text) as { errors: Array<{ path: string; message: string }>; detail: string };
    expect(body.detail).toBe('The request is invalid.');
    expect(body.errors.map((e) => e.path).sort()).toEqual(['', 'name']);
    for (const issue of body.errors) expect(issue.message.length).toBeGreaterThan(0);
  });

  it('validates query parameters with Zod as well', async () => {
    expectProblem(await request(t.app.getHttpServer()).get('/probe/query?page=0'), 400, 'VALIDATION_FAILED');
    const ok = await request(t.app.getHttpServer()).get('/probe/query?page=2');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ page: 2 });
  });

  it('accepts a valid body', async () => {
    const res = await request(t.app.getHttpServer()).post('/probe/echo').send({ name: 'a', payload: 'xyz' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ name: 'a', size: 3 });
  });

  it('returns BAD_REQUEST for malformed JSON', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/probe/echo')
      .set('content-type', 'application/json')
      .send('{"name":');
    expectProblem(res, 400, 'BAD_REQUEST');
  });

  it('returns UNSUPPORTED_MEDIA_TYPE for non-JSON bodies', async () => {
    const res = await request(t.app.getHttpServer()).post('/probe/echo').set('content-type', 'application/xml').send('<a/>');
    expectProblem(res, 415, 'UNSUPPORTED_MEDIA_TYPE');
  });

  it('hides unexpected errors behind INTERNAL_ERROR but logs them server-side', async () => {
    const res = await request(t.app.getHttpServer()).get('/probe/boom');
    expectProblem(res, 500, 'INTERNAL_ERROR');
    expect(JSON.parse(res.text)).toMatchObject({ title: 'Internal Server Error', detail: 'An unexpected error occurred.' });
    expect(t.lines.some((line) => line.includes(INTERNAL_DETAIL_MARKER) && line.includes('"level":50'))).toBe(true);
  });

  it('uses generic text for other HTTP errors, never the exception message', async () => {
    const res = await request(t.app.getHttpServer()).get('/probe/conflict');
    expectProblem(res, 409, 'HTTP_ERROR');
    expect(JSON.parse(res.text)).toMatchObject({ title: 'Conflict', detail: 'The request could not be completed.' });
  });

  it('returns NOT_FOUND for a wrong method on an existing path', async () => {
    expectProblem(await request(t.app.getHttpServer()).post('/health').send({}), 404, 'NOT_FOUND');
  });
});
