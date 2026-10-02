import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { APP_DIR, startBuiltApp, type RunningApp } from './support/next-server.js';
import { problem, startStubApi, type StubApi } from './support/stub-api.js';

/**
 * The web BFF login route, exercised over real HTTP against the built app.
 *
 * `handleLogin` already has unit tests; what this file proves is the wiring: that the route exists at
 * the path the browser posts to, that the proxy lets it through without locale rewriting, that the
 * Origin check and the internal credential are really in force on the wire, and — the assertion the
 * whole C-8 design exists for — that the tokens the API returns leave this server only as `__Host-`
 * cookies and never in a body, a page or a bundle.
 */

/** Obviously fake. Distinct strings so a hit anywhere names exactly what leaked. */
const CANARY_CREDENTIAL = 'test-web-route-canary-credential-not-realxx';
const ACCESS_TOKEN = 'test-web-access-token-canary-not-a-real-token';
const REFRESH_TOKEN = 'test-web-refresh-token-canary-not-a-real-token';

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
    response.end(JSON.stringify({ status: 'ok', session: { accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN, expiresIn: 900 } }));
  });
});

const CREDENTIALS = { identifier: 'person@example.test', password: 'correct horse battery staple' };

function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${app.baseUrl}/api/auth/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: app.baseUrl, 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function cookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

describe('POST /api/auth/login (web BFF route)', () => {
  it('turns the API session into the two approved cookies and a body with no token in it', async () => {
    const response = await post(CREDENTIALS);

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ status: 'ok' });
    expect(body).not.toContain(ACCESS_TOKEN);
    expect(body).not.toContain(REFRESH_TOKEN);
    expect(response.headers.get('cache-control')).toBe('no-store');

    const set = cookies(response);
    // Three: the two C-8 session cookies and the C-15 device cookie, which this browser arrives without.
    expect(set).toHaveLength(3);
    const access = set.find((cookie) => cookie.startsWith('__Host-mp_access='));
    const refresh = set.find((cookie) => cookie.startsWith('__Host-mp_refresh='));
    const device = set.find((cookie) => cookie.startsWith('__Host-mp_device_id='));
    expect(device).toBeDefined();
    expect(device).toContain('HttpOnly');
    expect(device).toContain('Max-Age=31536000');
    expect(access).toBeDefined();
    expect(refresh).toBeDefined();
    expect(access).toContain(`__Host-mp_access=${ACCESS_TOKEN};`);
    expect(refresh).toContain(`__Host-mp_refresh=${REFRESH_TOKEN};`);
    for (const cookie of [access ?? '', refresh ?? '']) {
      expect(cookie).toContain('Path=/');
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('Secure');
      expect(cookie).toContain('SameSite=Strict');
      expect(cookie).not.toContain('Domain');
    }
    expect(access).toContain('Max-Age=900');
    expect(refresh).toContain('Max-Age=2592000');
  });

  it('reaches the API at /v1/auth/login with the internal credential and the posted body', async () => {
    await post(CREDENTIALS);

    expect(api.seen).toHaveLength(1);
    const seen = api.seen[0];
    expect(seen?.method).toBe('POST');
    expect(seen?.url).toBe('/v1/auth/login');
    expect(seen?.credential).toBe(CANARY_CREDENTIAL);
    expect(JSON.parse(seen?.body ?? '{}')).toEqual(CREDENTIALS);
  });

  it('passes a 401 through unchanged, clears the session and stays generic', async () => {
    api.reply((_request, response) => problem(response, 401, 'AUTHENTICATION_FAILED'));
    const response = await post(CREDENTIALS);

    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['code']).toBe('AUTHENTICATION_FAILED');
    expect(body['detail']).toBe('Authentication failed.');
    // Nothing that could name the account, the lockout or the reason.
    expect(JSON.stringify(body)).not.toContain('lock');
    expect(response.headers.get('www-authenticate')).toBeNull();

    const set = cookies(response);
    expect(set).toHaveLength(2);
    for (const cookie of set) {
      expect(cookie).toContain('Max-Age=0');
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('Secure');
      expect(cookie).toContain('SameSite=Strict');
    }
  });

  it('passes a 429 through with the throttle problem and no session', async () => {
    api.reply((_request, response) => problem(response, 429, 'TOO_MANY_REQUESTS'));
    const response = await post(CREDENTIALS);

    expect(response.status).toBe(429);
    expect(((await response.json()) as Record<string, unknown>)['code']).toBe('TOO_MANY_REQUESTS');
    expect(cookies(response).every((cookie) => cookie.includes('Max-Age=0'))).toBe(true);
  });

  it('passes a 503 through with no session', async () => {
    api.reply((_request, response) => problem(response, 503, 'SERVICE_UNAVAILABLE'));
    const response = await post(CREDENTIALS);

    expect(response.status).toBe(503);
    expect(cookies(response).every((cookie) => cookie.includes('Max-Age=0'))).toBe(true);
  });

  it('answers 503 when the API cannot be reached at all, and never invents a session', async () => {
    api.reply((_request, response) => response.destroy());
    const response = await post(CREDENTIALS);

    expect(response.status).toBe(503);
    expect(((await response.json()) as Record<string, unknown>)['code']).toBe('SERVICE_UNAVAILABLE');
    expect(cookies(response)).toHaveLength(0);
  });

  it('answers 503 rather than a session when the API returns a body it does not recognise', async () => {
    api.reply((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok' }));
    });
    const response = await post(CREDENTIALS);

    expect(response.status).toBe(503);
    expect(cookies(response)).toHaveLength(0);
  });

  it('refuses a cross-site post before it reaches the API', async () => {
    const response = await post(CREDENTIALS, { origin: 'https://evil.test' });

    expect(response.status).toBe(403);
    expect(cookies(response)).toHaveLength(0);
    expect(api.seen).toHaveLength(0);
  });

  it('refuses a post with no Origin unless the browser says it is same-origin', async () => {
    const withoutOrigin = await fetch(`${app.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(CREDENTIALS),
    });
    expect(withoutOrigin.status).toBe(403);
    expect(api.seen).toHaveLength(0);

    const sameSite = await fetch(`${app.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify(CREDENTIALS),
    });
    expect(sameSite.status).toBe(200);
  });

  it('rejects a body that is not JSON without spending a throttle slot', async () => {
    const response = await post('not json at all');

    expect(response.status).toBe(400);
    expect(((await response.json()) as Record<string, unknown>)['code']).toBe('VALIDATION_FAILED');
    expect(api.seen).toHaveLength(0);
  });

  it('serves no other method on the route', async () => {
    const response = await fetch(`${app.baseUrl}/api/auth/login`, { redirect: 'manual' });
    expect(response.status).toBe(405);
    expect(api.seen).toHaveLength(0);
  });

  it('is reachable without a locale prefix and is not rewritten by locale routing', async () => {
    // A locale-rewritten path would be a 404 here; the 200 above is the proof it is not rewritten.
    const prefixed = await fetch(`${app.baseUrl}/en/api/auth/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { origin: app.baseUrl, 'content-type': 'application/json' },
      body: JSON.stringify(CREDENTIALS),
    });
    expect(prefixed.status).not.toBe(200);
    expect(cookies(prefixed)).toHaveLength(0);
  });

  it('still serves the localized 404 for other /api paths', async () => {
    const response = await fetch(`${app.baseUrl}/api/anything`, { redirect: 'manual' });
    expect(response.status).toBe(404);
    expect(await response.text()).toContain('>Page not found</h1>');
  });
});

describe('the login screen', () => {
  it('renders the form in both languages and sets no cookie', async () => {
    const english = await fetch(`${app.baseUrl}/login`, { redirect: 'manual' });
    expect(english.status).toBe(200);
    expect(english.headers.getSetCookie()).toHaveLength(0);
    const html = await english.text();
    expect(html).toContain('<html lang="en" dir="ltr">');
    expect(html).toContain('>Sign in</h1>');
    expect(html).toContain('id="login-identifier"');
    expect(html).toContain('type="password"');
    expect(html).toContain('autoComplete="current-password"');

    const arabic = await (await fetch(`${app.baseUrl}/ar/login`, { redirect: 'manual' })).text();
    expect(arabic).toContain('<html lang="ar" dir="rtl">');
    expect(arabic).toContain('>تسجيل الدخول</h1>');
  });

  it('shows no account-existence, lockout or reason-code wording anywhere on the page', async () => {
    const html = await (await fetch(`${app.baseUrl}/login`)).text();
    for (const forbidden of ['locked', 'lockout', 'no such account', 'unknown user', 'invalid_credentials', 'account_locked', 'throttle_rejected']) {
      expect(html.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('never exposes the credential, the API URL or a token in the page or the client bundle', async () => {
    const html = await (await fetch(`${app.baseUrl}/login`)).text();
    for (const forbidden of [CANARY_CREDENTIAL, ACCESS_TOKEN, REFRESH_TOKEN, 'x-internal-credential', api.baseUrl]) {
      expect(html).not.toContain(forbidden);
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
    for (const forbidden of [CANARY_CREDENTIAL, ACCESS_TOKEN, REFRESH_TOKEN, 'x-internal-credential', 'API_BASE_URL', 'sessionCookies', 'handleLogin']) {
      expect(js).not.toContain(forbidden);
    }
    // The browser code must not touch storage or Supabase directly.
    for (const forbidden of ['localStorage', 'sessionStorage', 'supabase', '/auth/v1/token']) {
      expect(js.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});
