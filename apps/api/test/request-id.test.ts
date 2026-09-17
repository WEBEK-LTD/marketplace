import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './support/app.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.app.close();
});

describe('request IDs', () => {
  it('generates a UUID when none is supplied and logs it', async () => {
    const res = await request(t.app.getHttpServer()).get('/health');
    const id = res.headers['x-request-id'] as string;
    expect(id).toMatch(UUID);
    expect(t.logs().some((line) => line.requestId === id)).toBe(true);
  });

  it('generates a different ID for every request', async () => {
    const a = await request(t.app.getHttpServer()).get('/health');
    const b = await request(t.app.getHttpServer()).get('/health');
    expect(a.headers['x-request-id']).not.toBe(b.headers['x-request-id']);
  });

  it('accepts a valid UUID from x-request-id', async () => {
    const supplied = '3F2504E0-4F89-11D3-9A0C-0305E82C3301';
    const res = await request(t.app.getHttpServer()).get('/health').set('x-request-id', supplied);
    expect(res.headers['x-request-id']).toBe(supplied.toLowerCase());
  });

  it.each(['abc', '3f2504e0-4f89-11d3-9a0c-0305e82c330', 'x\nfake-log-line', `${'a'.repeat(200)}`])(
    'replaces an invalid x-request-id (%j)',
    async (supplied) => {
      const res = await request(t.app.getHttpServer()).get('/health').set('x-request-id', supplied.replace('\n', ''));
      expect(res.headers['x-request-id']).toMatch(UUID);
      expect(res.headers['x-request-id']).not.toBe(supplied);
    },
  );

  it('includes the request ID on problem responses', async () => {
    const res = await request(t.app.getHttpServer()).get('/missing');
    expect(res.headers['x-request-id']).toMatch(UUID);
  });
});
