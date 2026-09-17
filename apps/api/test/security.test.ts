import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './support/app.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.app.close();
});

const noCorsHeaders = (headers: Record<string, unknown>) =>
  Object.keys(headers).filter((name) => name.toLowerCase().startsWith('access-control-'));

describe('security headers (helmet)', () => {
  it('sets the helmet baseline and hides the server technology', async () => {
    const res = await request(t.app.getHttpServer()).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['strict-transport-security']).toContain('max-age=');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('also sets them on error responses', async () => {
    const res = await request(t.app.getHttpServer()).get('/missing');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('strict CORS', () => {
  it('sends no CORS headers for cross-origin requests', async () => {
    const res = await request(t.app.getHttpServer()).get('/health').set('Origin', 'https://evil.example');
    expect(res.status).toBe(200);
    expect(noCorsHeaders(res.headers)).toEqual([]);
  });

  it('does not answer CORS preflight requests', async () => {
    const res = await request(t.app.getHttpServer())
      .options('/health')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'GET');
    expect(res.status).toBe(404);
    expect(noCorsHeaders(res.headers)).toEqual([]);
  });
});
