import { describe, expect, it } from 'vitest';
import {
  handleLocaleChange,
  readAdminAccessToken,
  readStaffSession,
} from '../src/server/bff/staff-session';
import { SESSION_COOKIES } from '../src/server/bff/session-cookies';

/**
 * The BFF half of the staff console session (Phase 7-F).
 *
 * What matters at this boundary:
 *
 *   * the caller's token comes from `__Host-mp_admin_access` and never from a body, and the browser's
 *     own `Cookie` header is never forwarded upstream;
 *   * **the answer is validated against the contract rather than forwarded**, which matters more here
 *     than on any list: these are the fields every authorization decision in the shell is made from, so
 *     a drifted body becomes a clean failure instead of a console with the wrong idea of who somebody
 *     is;
 *   * a session that ended and a service that could not answer stay distinct, because an outage must
 *     never be rendered as a demotion;
 *   * the language write sends exactly one field, refuses a cross-site request, and refuses a language
 *     the console cannot render without a round trip.
 */

const ENV = Object.freeze({
  API_BASE_URL: 'https://api.internal.test',
  INTERNAL_BFF_CREDENTIAL: 'test-current-credential-value-not-a-real-se',
});

const SESSION_TOKEN = 'admin-session-token-canary-not-a-real-token';
const COOKIE = `${SESSION_COOKIES.access.name}=${SESSION_TOKEN}`;

const SESSION = {
  id: '11111111-1111-4111-8111-111111111111',
  displayName: 'Nadia',
  localeCode: 'en',
  isStaff: true,
  requiresStepUp: false,
  roles: ['moderator'],
  permissions: ['moderation.report.read', 'reviews.review.read'],
};

interface Seen {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string;
}

function api(status: number, payload: unknown, seen: Seen[] = []): typeof fetch {
  return (async (input: unknown, init: RequestInit) => {
    seen.push({
      url: String(input),
      method: String(init.method ?? 'GET'),
      headers: new Headers(init.headers),
      body: String(init.body ?? ''),
    });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': status < 400 ? 'application/json' : 'application/problem+json' },
    });
  }) as unknown as typeof fetch;
}

function localeRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://admin.test/api/account/locale', {
    method: 'POST',
    headers: { origin: 'https://admin.test', 'content-type': 'application/json', cookie: COOKIE, ...headers },
    body: JSON.stringify(body),
  });
}

/* ------------------------------------------------------------------------------------------------ */

describe('reading the console session', () => {
  it('presents the caller’s token and the internal credential, and never the browser cookie', async () => {
    const seen: Seen[] = [];
    await readStaffSession({ env: ENV, cookieHeader: COOKIE, fetch: api(200, { session: SESSION }, seen) });

    expect(seen[0]!.url).toBe('https://api.internal.test/v1/admin/session');
    expect(seen[0]!.method).toBe('GET');
    expect(seen[0]!.headers.get('x-session-token')).toBe(SESSION_TOKEN);
    expect(seen[0]!.headers.get('x-internal-credential')).toBe(ENV.INTERNAL_BFF_CREDENTIAL);
    expect(seen[0]!.headers.get('cookie')).toBeNull();
    expect(seen[0]!.body).toBe('');
  });

  it('never reaches the API without a session cookie', async () => {
    const seen: Seen[] = [];
    const result = await readStaffSession({ env: ENV, cookieHeader: null, fetch: api(200, {}, seen) });
    expect(result.kind).toBe('unauthenticated');
    expect(seen).toEqual([]);
  });

  it('reads only the admin cookie, not the public one', () => {
    expect(readAdminAccessToken(COOKIE)).toBe(SESSION_TOKEN);
    expect(readAdminAccessToken('__Host-mp_access=public-token')).toBeNull();
    expect(readAdminAccessToken(`${SESSION_COOKIES.access.name}=`)).toBeNull();
    expect(readAdminAccessToken(null)).toBeNull();
    expect(readAdminAccessToken('nonsense')).toBeNull();
  });

  it('returns the validated session', async () => {
    const result = await readStaffSession({
      env: ENV,
      cookieHeader: COOKIE,
      fetch: api(200, { session: SESSION }),
    });
    expect(result.kind).toBe('ok');
    expect(result.kind === 'ok' && result.session.permissions).toEqual(SESSION.permissions);
  });

  it.each([
    ['a field the contract does not name', { session: { ...SESSION, isSuperUser: true } }],
    ['permissions that are not permission keys', { session: { ...SESSION, permissions: ['DROP TABLE'] } }],
    ['a role the contract does not name', { session: { ...SESSION, roles: ['root'] } }],
    ['permissions that are not an array', { session: { ...SESSION, permissions: 'all' } }],
    ['no session at all', {}],
    ['a session that is not an object', { session: 'admin' }],
  ])('refuses an answer carrying %s', async (_name, payload) => {
    const result = await readStaffSession({ env: ENV, cookieHeader: COOKIE, fetch: api(200, payload) });
    // A drifted body is an outage, never a permission set.
    expect(result.kind).toBe('unavailable');
  });

  it('keeps a session that ended and a service that could not answer apart', async () => {
    const ended = await readStaffSession({ env: ENV, cookieHeader: COOKIE, fetch: api(401, {}) });
    expect(ended.kind).toBe('unauthenticated');

    for (const status of [403, 404, 500, 503]) {
      const down = await readStaffSession({ env: ENV, cookieHeader: COOKIE, fetch: api(status, {}) });
      expect(down.kind, String(status)).toBe('unavailable');
    }
  });

  it('treats an unreachable API as unavailable rather than as a refusal', async () => {
    const failing = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;
    const result = await readStaffSession({ env: ENV, cookieHeader: COOKIE, fetch: failing });
    expect(result.kind).toBe('unavailable');
  });

  it('accepts no permission, role or assurance level from anywhere', async () => {
    // The function's only input is the cookie header; there is no parameter for anything else.
    expect(readStaffSession.length).toBeLessThanOrEqual(1);
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../src/server/bff/staff-session.ts', import.meta.url), 'utf8'),
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const field of ['isStaff', 'requiresStepUp', 'permissions', 'roles', 'aal']) {
      // None of them is ever read from a request in this module.
      expect(code, field).not.toContain(`body.${field}`);
      expect(code, field).not.toContain(`searchParams.get('${field}')`);
    }
  });
});

describe('the language switch', () => {
  it('sends exactly one field to the profile operation the API already has', async () => {
    const seen: Seen[] = [];
    const response = await handleLocaleChange(localeRequest({ localeCode: 'ar' }), {
      env: ENV,
      fetch: api(200, { changed: true }, seen),
    });

    expect(response.status).toBe(200);
    expect(seen[0]!.url).toBe('https://api.internal.test/v1/users/me/profile');
    expect(seen[0]!.method).toBe('PATCH');
    expect(JSON.parse(seen[0]!.body)).toEqual({ localeCode: 'ar' });
    expect(seen[0]!.headers.get('cookie')).toBeNull();
  });

  it('drops everything else a page tried to send', async () => {
    const seen: Seen[] = [];
    await handleLocaleChange(
      localeRequest({ localeCode: 'en', displayName: 'Someone', userId: 'x', roles: ['admin'] }),
      { env: ENV, fetch: api(200, { changed: true }, seen) },
    );
    expect(JSON.parse(seen[0]!.body)).toEqual({ localeCode: 'en' });
  });

  it('refuses a cross-site request before anything else', async () => {
    const seen: Seen[] = [];
    const response = await handleLocaleChange(
      localeRequest({ localeCode: 'ar' }, { origin: 'https://evil.test' }),
      { env: ENV, fetch: api(200, {}, seen) },
    );
    expect(response.status).toBe(403);
    expect(seen).toEqual([]);
  });

  it('refuses a request with no session, before reaching the API', async () => {
    const seen: Seen[] = [];
    const request = new Request('https://admin.test/api/account/locale', {
      method: 'POST',
      headers: { origin: 'https://admin.test', 'content-type': 'application/json' },
      body: JSON.stringify({ localeCode: 'ar' }),
    });
    const response = await handleLocaleChange(request, { env: ENV, fetch: api(200, {}, seen) });
    expect(response.status).toBe(401);
    expect(seen).toEqual([]);
  });

  it.each([
    ['a language the console cannot render', { localeCode: 'fr' }],
    ['a language that is not a string', { localeCode: 2 }],
    ['no language at all', {}],
    ['a body that is not an object', 'ar'],
  ])('refuses %s without a round trip', async (_name, body) => {
    const seen: Seen[] = [];
    const response = await handleLocaleChange(localeRequest(body), { env: ENV, fetch: api(200, {}, seen) });
    expect(response.status).toBe(400);
    expect(seen).toEqual([]);
  });

  it('never forwards the API’s body to the browser', async () => {
    const response = await handleLocaleChange(localeRequest({ localeCode: 'ar' }), {
      env: ENV,
      fetch: api(200, { changed: true, secret: 'leaked', token: SESSION_TOKEN }),
    });
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ changed: true });
    expect(text).not.toContain('leaked');
    expect(text).not.toContain(SESSION_TOKEN);
  });

  it('turns an upstream refusal into the right answer, and never a success', async () => {
    const ended = await handleLocaleChange(localeRequest({ localeCode: 'ar' }), {
      env: ENV,
      fetch: api(401, { code: 'AUTHENTICATION_REQUIRED' }),
    });
    expect(ended.status).toBe(401);

    for (const status of [400, 404, 409, 500, 503]) {
      const other = await handleLocaleChange(localeRequest({ localeCode: 'ar' }), {
        env: ENV,
        fetch: api(status, { code: 'HTTP_ERROR' }),
      });
      expect(other.status, String(status)).toBe(503);
    }
  });

  it('never returns a cacheable answer', async () => {
    const response = await handleLocaleChange(localeRequest({ localeCode: 'ar' }), {
      env: ENV,
      fetch: api(200, { changed: true }),
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
