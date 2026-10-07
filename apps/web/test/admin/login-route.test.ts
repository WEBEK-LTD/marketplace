import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { APP_DIR, startBuiltApp, type RunningApp } from '../support/next-server.js';
import { problem, startStubApi, type StubApi } from '../support/stub-api.js';

/**
 * Where the console is mounted (0108). Every address in this file is console-relative, exactly as it was while the
 * console was an application of its own; this is the one place that turns it into the address the server answers.
 */
const CONSOLE = '/admin';

/**
 * The admin BFF login route, exercised over real HTTP against the built admin app.
 *
 * The admin origin is a separate application with a separate session, so this file proves the same
 * wiring as the web one **and** the thing that keeps the two apart: the cookies it issues are the
 * `__Host-mp_admin_*` pair and nothing else. A web cookie name appearing here would mean the two
 * sessions could stand in for one another.
 */

/** Obviously fake. Distinct strings so a hit anywhere names exactly what leaked. */
const CANARY_CREDENTIAL = 'test-admin-route-canary-credential-not-real';
const ACCESS_TOKEN = 'test-admin-access-token-canary-not-a-real-token';
const REFRESH_TOKEN = 'test-admin-refresh-token-canary-not-a-real-token';

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

const CREDENTIALS = { identifier: 'admin@example.test', password: 'correct horse battery staple' };

function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${app.baseUrl}${CONSOLE}/api/auth/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: app.baseUrl, 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function cookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

describe('POST /api/auth/login (admin BFF route)', () => {
  it('issues the admin cookies only, with the approved attributes and no token in the body', async () => {
    const response = await post(CREDENTIALS);

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ status: 'ok' });
    expect(body).not.toContain(ACCESS_TOKEN);
    expect(body).not.toContain(REFRESH_TOKEN);

    const set = cookies(response);
    expect(set).toHaveLength(2);
    const names = set.map((cookie) => cookie.slice(0, cookie.indexOf('=')));
    expect(names.sort()).toEqual(['__Host-mp_admin_access', '__Host-mp_admin_refresh']);
    // The public web session must not exist on this origin under any circumstances.
    expect(set.join('\n')).not.toContain('__Host-mp_access=');
    expect(set.join('\n')).not.toContain('__Host-mp_refresh=');

    for (const cookie of set) {
      expect(cookie).toContain('Path=/');
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('Secure');
      expect(cookie).toContain('SameSite=Strict');
      expect(cookie).not.toContain('Domain');
    }
    expect(set.find((cookie) => cookie.startsWith('__Host-mp_admin_access='))).toContain('Max-Age=900');
    expect(set.find((cookie) => cookie.startsWith('__Host-mp_admin_refresh='))).toContain('Max-Age=2592000');
  });

  it('reaches the API at /v1/auth/login with the internal credential', async () => {
    await post(CREDENTIALS);

    expect(api.seen).toHaveLength(1);
    expect(api.seen[0]?.url).toBe('/v1/auth/login');
    expect(api.seen[0]?.credential).toBe(CANARY_CREDENTIAL);
    expect(JSON.parse(api.seen[0]?.body ?? '{}')).toEqual(CREDENTIALS);
  });

  it('passes a 401 through unchanged and clears the admin session', async () => {
    api.reply((_request, response) => problem(response, 401, 'AUTHENTICATION_FAILED'));
    const response = await post(CREDENTIALS);

    expect(response.status).toBe(401);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['code']).toBe('AUTHENTICATION_FAILED');
    expect(body['detail']).toBe('Authentication failed.');
    expect(response.headers.get('www-authenticate')).toBeNull();
    const set = cookies(response);
    expect(set).toHaveLength(2);
    expect(set.every((cookie) => cookie.includes('Max-Age=0') && cookie.startsWith('__Host-mp_admin_'))).toBe(true);
  });

  it('passes 429 and 503 through with no session', async () => {
    api.reply((_request, response) => problem(response, 429, 'TOO_MANY_REQUESTS'));
    const throttled = await post(CREDENTIALS);
    expect(throttled.status).toBe(429);
    expect(cookies(throttled).every((cookie) => cookie.includes('Max-Age=0'))).toBe(true);

    api.reply((_request, response) => problem(response, 503, 'SERVICE_UNAVAILABLE'));
    const unavailable = await post(CREDENTIALS);
    expect(unavailable.status).toBe(503);
    expect(cookies(unavailable).every((cookie) => cookie.includes('Max-Age=0'))).toBe(true);
  });

  it('answers 503 when the API cannot be reached, and never invents a session', async () => {
    api.reply((_request, response) => response.destroy());
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

  it('rejects a body that is not JSON, and serves no other method', async () => {
    const malformed = await post('not json at all');
    expect(malformed.status).toBe(400);
    expect(api.seen).toHaveLength(0);

    const get = await fetch(`${app.baseUrl}${CONSOLE}/api/auth/login`, { redirect: 'manual' });
    expect(get.status).toBe(405);
    expect(api.seen).toHaveLength(0);
  });
});

describe('the admin login screen', () => {
  it('renders the form, sets no cookie and stays noindex', async () => {
    const response = await fetch(`${app.baseUrl}${CONSOLE}/login`, { redirect: 'manual' });
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toHaveLength(0);
    expect(response.headers.get('x-robots-tag')).toBe('noindex');

    const html = await response.text();
    expect(html).toContain('>Sign in</h1>');
    expect(html).toContain('id="login-identifier"');
    expect(html).toContain('type="password"');
    for (const forbidden of ['locked', 'lockout', 'invalid_credentials', 'account_locked']) {
      expect(html.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('never exposes the credential, the API URL or a token in the page or the client bundle', async () => {
    const html = await (await fetch(`${app.baseUrl}${CONSOLE}/login`)).text();
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
    for (const forbidden of ['localStorage', 'sessionStorage', 'supabase', '/auth/v1/token']) {
      expect(js.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});
