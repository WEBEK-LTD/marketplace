import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BODY_LIMIT_BYTES } from '../src/app.factory.js';
import { createTestApp, type TestApp } from './support/app.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.app.close();
});

function bodyOfSize(bytes: number): string {
  const prefix = '{"name":"a","payload":"';
  const suffix = '"}';
  return `${prefix}${'x'.repeat(bytes - prefix.length - suffix.length)}${suffix}`;
}

describe('request body limit', () => {
  it('is exactly 1 MiB', () => {
    expect(BODY_LIMIT_BYTES).toBe(1024 * 1024);
  });

  it('accepts a body of exactly 1 MiB', async () => {
    const body = bodyOfSize(BODY_LIMIT_BYTES);
    expect(Buffer.byteLength(body)).toBe(BODY_LIMIT_BYTES);
    const res = await request(t.app.getHttpServer()).post('/probe/echo').set('content-type', 'application/json').send(body);
    expect(res.status).toBe(201);
  });

  it('rejects one byte more with PAYLOAD_TOO_LARGE', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/probe/echo')
      .set('content-type', 'application/json')
      .send(bodyOfSize(BODY_LIMIT_BYTES + 1));
    expect(res.status).toBe(413);
    expect(res.headers['content-type']).toBe('application/problem+json; charset=utf-8');
    expect(JSON.parse(res.text)).toMatchObject({ code: 'PAYLOAD_TOO_LARGE', status: 413 });
  });
});
