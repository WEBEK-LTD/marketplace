import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { APP_DIR, startBuiltApp, type RunningApp } from './support/next-server.js';
import { problem, startStubApi, type StubApi } from './support/stub-api.js';

/**
 * The F3 recovery routes and pages, over real HTTP against the built app.
 *
 * `bff-recovery.test.ts` proves the handler contract; this file proves the wiring: that the three routes
 * exist at the paths the browser posts to, that locale routing leaves them alone, and that the reset
 * token the API issues leaves this server only as a `Set-Cookie` — never in a body, a page, a redirect
 * location or a client bundle.
 */

const CANARY_CREDENTIAL = 'test-recovery-canary-credential-not-realxxx';
const RESET_TOKEN = 'recovery-reset-token-canary-not-a-real-token';
const CHALLENGE = '22222222-2222-4222-8222-222222222222';

let api: StubApi;
let app: RunningApp;

beforeAll(async () => {
  api = await startStubApi();
  app = await startBuiltApp({ API_BASE_URL: api.baseUrl, INTERNAL_BFF_CREDENTIAL: CANARY_CREDENTIAL });
}, 120_000);

afterAll(async () => {
  await app.stop();
  await api.stop();
});

beforeEach(() => {
  api.seen.length = 0;
  api.reply((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        status: 'ok',
        challengeId: CHALLENGE,
        reset: {
          token: RESET_TOKEN,
          link: `https://web.invalid/auth/recovery?token=${RESET_TOKEN}`,
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        },
      }),
    );
  });
});

function post(step: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${app.baseUrl}/api/auth/recovery/${step}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: app.baseUrl, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function cookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

describe('the recovery routes', () => {
  it('start reaches the API with the internal credential and answers neutrally', async () => {
    const response = await post('start', { identifier: 'person@example.test' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', challengeId: CHALLENGE });
    expect(api.seen[0]?.url).toBe('/v1/auth/recovery/start');
    expect(api.seen[0]?.credential).toBe(CANARY_CREDENTIAL);
    expect(cookies(response)).toHaveLength(0);
  });

  it('verify sets exactly the approved reset cookie and returns no token', async () => {
    const response = await post('verify', { challengeId: CHALLENGE, otp: '123456' });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ status: 'ok', next: '/reset-password' });
    expect(body).not.toContain(RESET_TOKEN);

    const set = cookies(response);
    expect(set).toHaveLength(1);
    const cookie = set[0] ?? '';
    expect(cookie.startsWith(`__Host-mp_reset=${RESET_TOKEN};`)).toBe(true);
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Max-Age=900');
    expect(cookie).not.toContain('Domain');
  });

  it('the location the browser is sent to afterwards carries no token', async () => {
    const response = await post('verify', { challengeId: CHALLENGE, otp: '123456' });
    const next = ((await response.json()) as { next: string }).next;

    expect(next).toBe('/reset-password');
    expect(next).not.toContain(RESET_TOKEN);
    expect(next).not.toContain('token');
  });

  it('a refused code clears the cookie and passes the generic problem through', async () => {
    api.reply((_request, response) => problem(response, 401, 'AUTHENTICATION_FAILED'));
    const response = await post('verify', { challengeId: CHALLENGE, otp: '000000' });

    expect(response.status).toBe(401);
    expect(((await response.json()) as Record<string, unknown>)['code']).toBe('AUTHENTICATION_FAILED');
    expect(cookies(response).every((cookie) => cookie.includes('Max-Age=0'))).toBe(true);
  });

  it('reset presents the cookie token as a header and clears the cookie afterwards', async () => {
    const response = await post(
      'reset',
      { newPassword: 'correct horse battery staple' },
      { cookie: `__Host-mp_reset=${RESET_TOKEN}` },
    );

    expect(response.status).toBe(200);
    expect(api.seen[0]?.url).toBe('/v1/auth/recovery/reset');
    expect(JSON.parse(api.seen[0]?.body ?? '{}')).toEqual({ newPassword: 'correct horse battery staple' });
    expect(cookies(response).every((cookie) => cookie.includes('Max-Age=0'))).toBe(true);
    expect(await response.text()).not.toContain(RESET_TOKEN);
  });

  it('refuses every step cross-site, before the API is reached', async () => {
    for (const step of ['start', 'verify', 'reset']) {
      api.seen.length = 0;
      const response = await post(step, { identifier: 'a@b.test' }, { origin: 'https://evil.test' });
      expect(response.status).toBe(403);
      expect(api.seen).toHaveLength(0);
      expect(cookies(response)).toHaveLength(0);
    }
  });

  it('is reachable unprefixed and never locale-rewritten, while other /api paths still 404', async () => {
    const prefixed = await fetch(`${app.baseUrl}/en/api/auth/recovery/start`, {
      method: 'POST',
      redirect: 'manual',
      headers: { origin: app.baseUrl, 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: 'person@example.test' }),
    });
    expect(prefixed.status).not.toBe(200);

    const unknown = await fetch(`${app.baseUrl}/api/auth/recovery/nope`, { redirect: 'manual' });
    expect(unknown.status).toBe(404);
  });

  it('serves no other method on the three routes', async () => {
    for (const step of ['start', 'verify', 'reset']) {
      const response = await fetch(`${app.baseUrl}/api/auth/recovery/${step}`, { redirect: 'manual' });
      expect(response.status).toBe(405);
    }
  });
});

describe('the recovery pages', () => {
  it('render in both languages and set no cookie', async () => {
    for (const [path, heading] of [
      ['/forgot-password', 'Reset your password'],
      ['/forgot-password/verify', 'Enter your code'],
      ['/reset-password', 'Choose a new password'],
    ] as const) {
      const response = await fetch(`${app.baseUrl}${path}`, { redirect: 'manual' });
      expect(response.status).toBe(200);
      expect(response.headers.getSetCookie()).toHaveLength(0);
      const html = await response.text();
      expect(html).toContain(`>${heading}</h1>`);
      expect(html).toContain('<html lang="en" dir="ltr">');
    }

    const arabic = await (await fetch(`${app.baseUrl}/ar/forgot-password`, { redirect: 'manual' })).text();
    expect(arabic).toContain('<html lang="ar" dir="rtl">');
    expect(arabic).toContain('>إعادة تعيين كلمة المرور</h1>');
  });

  it('say the same neutral thing to everyone and disclose no account state', async () => {
    const html = await (await fetch(`${app.baseUrl}/forgot-password`)).text();
    expect(html).toContain('the contact you verified');
    for (const forbidden of ['no account', 'unknown account', 'account is locked', 'not registered', 'no such account']) {
      expect(html.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('never put a token, a credential or a storage call in a page or a bundle', async () => {
    for (const path of ['/forgot-password', '/forgot-password/verify', '/reset-password']) {
      const html = await (await fetch(`${app.baseUrl}${path}`)).text();
      for (const forbidden of [RESET_TOKEN, CANARY_CREDENTIAL, 'x-internal-credential', 'x-reset-token', api.baseUrl]) {
        expect(html).not.toContain(forbidden);
      }
    }

    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        return statSync(full).isDirectory() ? files(full) : [full];
      });
    const js = files(join(APP_DIR, '.next/static'))
      .filter((file) => file.endsWith('.js'))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    expect(js.length).toBeGreaterThan(0);
    for (const forbidden of [RESET_TOKEN, CANARY_CREDENTIAL, 'x-internal-credential', 'x-reset-token', '__Host-mp_reset', 'API_BASE_URL']) {
      expect(js).not.toContain(forbidden);
    }
    for (const forbidden of ['localStorage', 'sessionStorage', 'indexedDB', 'supabase']) {
      expect(js.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});
