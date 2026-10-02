import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { APP_DIR, startBuiltApp, type RunningApp } from './support/next-server.js';
import { problem, startStubApi, type StubApi } from './support/stub-api.js';

/**
 * The F4 routes and the security page, over real HTTP against the built app.
 *
 * `bff-contact-change.test.ts` proves the handler contract; this file proves the wiring: the two routes
 * exist where the browser posts, locale routing leaves them alone, the session cookie is the only way to
 * authenticate, and nothing about the session or the session token reaches a page or a bundle.
 */

const CANARY_CREDENTIAL = 'test-contact-canary-credential-not-realxxxx';
const SESSION_TOKEN = 'contact-session-token-canary-not-a-real-token';
const CHALLENGE = '22222222-2222-4222-8222-222222222222';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const PHONE = '+201555000111';

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
  api.reply((request, response) => {
    // Phase 5-A put `/dashboard/*` behind a session, so the page now asks the API who the caller is
    // before it renders. The contact-change answers are unchanged.
    if (request.url.startsWith('/v1/users/me?') || request.url === '/v1/users/me') {
      response.writeHead(200, { 'content-type': 'application/json' });
      return void response.end(JSON.stringify({ user: { id: USER_ID, displayName: 'Nadia' } }));
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', challenge: { id: CHALLENGE } }));
  });
});

/** The session the security page needs to render at all, now that it is a protected surface. */
const SESSION_COOKIES = `__Host-mp_access=${SESSION_TOKEN}; __Host-mp_refresh=contact-refresh-token-canary-not-a-real-token`;

const CHALLENGE_COOKIE = '__Host-mp_contact_phone_challenge';

function post(step: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${app.baseUrl}/api/auth/contact/phone/${step}`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      origin: app.baseUrl,
      'content-type': 'application/json',
      cookie: `__Host-mp_access=${SESSION_TOKEN}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

/** A verify request carrying both the session and the challenge cookie the start step sets. */
function postVerify(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return post('verify', body, { cookie: `__Host-mp_access=${SESSION_TOKEN}; ${CHALLENGE_COOKIE}=${CHALLENGE}`, ...headers });
}

describe('the contact-change routes', () => {
  it('start answers exactly {status:ok} and puts the challenge in the approved cookie', async () => {
    const response = await post('start', { phone: PHONE });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ status: 'ok' });
    // The identifier is nowhere in the browser's body.
    expect(body).not.toContain(CHALLENGE);
    expect(body).not.toContain('challengeId');

    const set = response.headers.getSetCookie();
    expect(set).toHaveLength(1);
    const cookie = set[0] ?? '';
    expect(cookie.startsWith(`${CHALLENGE_COOKIE}=${CHALLENGE};`)).toBe(true);
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Max-Age=900');
    expect(cookie).not.toContain('Domain');

    expect(api.seen[0]?.url).toBe('/v1/users/me/contact/phone/start');
    expect(api.seen[0]?.credential).toBe(CANARY_CREDENTIAL);
  });

  it('verify sends only the code, and the API gets the challenge from the cookie boundary', async () => {
    const response = await postVerify({ otp: '123456' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    expect(api.seen[0]?.url).toBe('/v1/users/me/contact/phone/verify');
    expect(JSON.parse(api.seen[0]?.body ?? '{}')).toEqual({ challengeId: CHALLENGE, otp: '123456' });
    // Spent: the challenge cookie is cleared, and the session cookies are untouched.
    const set = response.headers.getSetCookie();
    expect(set).toHaveLength(1);
    expect(set[0]).toContain(`${CHALLENGE_COOKIE}=`);
    expect(set[0]).toContain('Max-Age=0');
  });

  it('refuses a verify with no challenge cookie, and never reaches the API', async () => {
    const response = await post('verify', { otp: '123456' });

    expect(response.status).toBe(401);
    expect(api.seen).toHaveLength(0);
  });

  it('ignores a challenge the browser puts in its body', async () => {
    await postVerify({ otp: '123456', challengeId: '99999999-9999-4999-8999-999999999999' });

    expect(JSON.parse(api.seen[0]?.body ?? '{}')).toEqual({ challengeId: CHALLENGE, otp: '123456' });
  });

  it('refuses both steps without the session cookie, before the API is reached', async () => {
    for (const step of ['start', 'verify']) {
      api.seen.length = 0;
      const response = await fetch(`${app.baseUrl}/api/auth/contact/phone/${step}`, {
        method: 'POST',
        redirect: 'manual',
        headers: { origin: app.baseUrl, 'content-type': 'application/json' },
        body: JSON.stringify({ phone: PHONE }),
      });
      expect(response.status).toBe(401);
      expect(api.seen).toHaveLength(0);
    }
  });

  it('refuses both steps cross-site, before the API is reached', async () => {
    for (const step of ['start', 'verify']) {
      api.seen.length = 0;
      const response = await post(step, { phone: PHONE }, { origin: 'https://evil.test' });
      expect(response.status).toBe(403);
      expect(api.seen).toHaveLength(0);
    }
  });

  it('passes a throttle and an authentication problem through unchanged', async () => {
    api.reply((_request, response) => problem(response, 429, 'THROTTLED'));
    const throttled = await post('start', { phone: PHONE });
    expect(throttled.status).toBe(429);
    expect(((await throttled.json()) as Record<string, unknown>)['code']).toBe('THROTTLED');

    api.reply((_request, response) => problem(response, 401, 'AUTHENTICATION_FAILED'));
    const refused = await postVerify({ otp: '000000' });
    expect(refused.status).toBe(401);
    // A refused challenge is terminal here, so its cookie is cleared.
    expect(refused.headers.getSetCookie().every((cookie) => cookie.includes('Max-Age=0'))).toBe(true);
  });

  it('is reachable unprefixed, is not locale-rewritten, and serves no other method', async () => {
    const prefixed = await fetch(`${app.baseUrl}/en/api/auth/contact/phone/start`, {
      method: 'POST',
      redirect: 'manual',
      headers: { origin: app.baseUrl, 'content-type': 'application/json', cookie: `__Host-mp_access=${SESSION_TOKEN}` },
      body: JSON.stringify({ phone: PHONE }),
    });
    expect(prefixed.status).not.toBe(200);

    for (const step of ['start', 'verify']) {
      const get = await fetch(`${app.baseUrl}/api/auth/contact/phone/${step}`, { redirect: 'manual' });
      expect(get.status).toBe(405);
    }
  });
});

describe('the security page', () => {
  it('renders the phone section in both languages and sets no cookie', async () => {
    const english = await fetch(`${app.baseUrl}/dashboard/security`, {
      redirect: 'manual',
      headers: { cookie: SESSION_COOKIES },
    });
    expect(english.status).toBe(200);
    expect(english.headers.getSetCookie()).toHaveLength(0);
    const html = await english.text();
    expect(html).toContain('>Security</h1>');
    expect(html).toContain('>Phone number</h2>');
    expect(html).toContain('id="contact-phone"');
    expect(html).toContain('autoComplete="tel"');

    const arabic = await (
      await fetch(`${app.baseUrl}/ar/dashboard/security`, {
        redirect: 'manual',
        headers: { cookie: SESSION_COOKIES },
      })
    ).text();
    expect(arabic).toContain('<html lang="ar" dir="rtl">');
    expect(arabic).toContain('>الأمان</h1>');
  });

  it('shows no account data, no session token and no internal detail', async () => {
    const html = await (
      await fetch(`${app.baseUrl}/dashboard/security`, { headers: { cookie: SESSION_COOKIES } })
    ).text();
    for (const forbidden of [SESSION_TOKEN, CANARY_CREDENTIAL, 'x-internal-credential', 'x-session-token', api.baseUrl, CHALLENGE_COOKIE]) {
      expect(html).not.toContain(forbidden);
    }
    // The page holds no account state: the only number on it is the example in the field hint, the
    // input is empty, and no account identifier appears anywhere.
    const numbers = html.match(/\+\d{7,}/g) ?? [];
    expect(new Set(numbers)).toEqual(new Set(['+201234567890']));
    // The identity the page now reads is an id and a name; neither is rendered as account data.
    expect(html).not.toContain(USER_ID);
    expect(html).toContain('id="contact-phone"');
    expect(html).toMatch(/id="contact-phone"[^>]*value=""/);
    expect(html).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });

  it('never puts a token, a credential or a storage call in the client bundle', () => {
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
    for (const forbidden of [
      SESSION_TOKEN,
      CANARY_CREDENTIAL,
      'x-internal-credential',
      'x-session-token',
      '__Host-mp_access',
      '__Host-mp_contact_phone_challenge',
      'API_BASE_URL',
    ]) {
      expect(js).not.toContain(forbidden);
    }
    for (const forbidden of ['localStorage', 'sessionStorage', 'indexedDB', 'supabase', '/auth/v1/']) {
      expect(js.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('ships a phone-change component that knows nothing about a challenge', () => {
    // Scoped to the chunks that actually contain this component: `challengeId` legitimately exists in
    // the F3 recovery bundle, where the approved contract does hand it to the browser.
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        return statSync(full).isDirectory() ? files(full) : [full];
      });
    const chunks = files(join(APP_DIR, '.next/static'))
      .filter((file) => file.endsWith('.js'))
      .map((file) => readFileSync(file, 'utf8'))
      .filter((text) => text.includes('PhoneChangeForm'));

    expect(chunks).toHaveLength(1);
    for (const chunk of chunks) {
      // The component holds no challenge at all: no identifier, no cookie name, no storage.
      expect(chunk).not.toContain('challengeId');
      expect(chunk).not.toContain('__Host-mp_contact_phone_challenge');
      expect(chunk.toLowerCase()).not.toContain('localstorage');
      expect(chunk.toLowerCase()).not.toContain('sessionstorage');
      // What it does send is the code, under the approved field name.
      expect(chunk).toContain('otp');
    }
  });
});
