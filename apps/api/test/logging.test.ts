import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './support/app.js';

const SECRETS = {
  authorization: 'Bearer secret-token-abc123',
  cookie: 'session=secret-cookie-def456',
  proxy: 'Basic secret-proxy-ghi789',
  query: 'secret-query-jkl012',
};

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
  await request(t.app.getHttpServer())
    .post(`/probe/log-headers?token=${SECRETS.query}`)
    .set('Authorization', SECRETS.authorization)
    .set('Cookie', SECRETS.cookie)
    .set('Proxy-Authorization', SECRETS.proxy)
    .send({});
});
afterAll(async () => {
  await t.app.close();
});

describe('structured logging', () => {
  it('writes every line as JSON with level, time and message', () => {
    expect(t.lines.length).toBeGreaterThan(0);
    for (const line of t.logs()) {
      expect(typeof line.level).toBe('number');
      expect(typeof line.time).toBe('number');
      expect(typeof line.msg).toBe('string');
    }
  });

  it('routes NestJS framework logs through the JSON logger', () => {
    expect(t.logs().some((line) => line.context === 'RouterExplorer')).toBe(true);
  });

  it('logs requests with method and path only (no query string, no headers)', () => {
    const incoming = t.logs().find((line) => line.msg === 'incoming request' && JSON.stringify(line).includes('log-headers'));
    expect(incoming?.req).toEqual({ method: 'POST', path: '/probe/log-headers' });
  });

  it('redacts authorization, cookie and proxy credentials even when headers are logged explicitly', () => {
    const probe = t.logs().find((line) => line.msg === 'probe headers') as { headers: Record<string, string> } | undefined;
    expect(probe?.headers.authorization).toBe('[REDACTED]');
    expect(probe?.headers.cookie).toBe('[REDACTED]');
    expect(probe?.headers['proxy-authorization']).toBe('[REDACTED]');
  });

  it('never writes any of the secret values', () => {
    const all = t.lines.join('\n');
    for (const secret of Object.values(SECRETS)) {
      expect(all).not.toContain(secret);
    }
  });
});
