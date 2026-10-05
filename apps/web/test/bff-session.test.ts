import { describe, expect, it } from 'vitest';
import { handleLogout, handleSessionRefresh } from '../src/server/bff/session';
import { readCurrentUser } from '../src/server/bff/current-user';
import { SESSION_COOKIES } from '../src/server/bff/session-cookies';

/**
 * The BFF half of session continuity (Phase 5-A).
 *
 * The assertions that carry weight at this boundary:
 *
 *   * **no token reaches the browser** — not in a body, not in a header, only in `Set-Cookie`;
 *   * the cookies that come back are byte-for-byte the C-8 cookies, `__Host-` prefix and all;
 *   * **both** cookies rotate, so the browser stops presenting the refresh token that was just spent;
 *   * a refusal ends the session and clears the cookies; an **outage does not**, because a failing API
 *     says nothing about whether somebody is signed in;
 *   * logout always clears, always answers 200, and never calls upstream when there is nothing to end.
 */

const ENV = Object.freeze({
  API_BASE_URL: 'https://api.internal.test',
  PUBLIC_WEB_ORIGIN: 'https://web.test',
  INTERNAL_BFF_CREDENTIAL: 'test-current-credential-value-not-a-real-se',
});

const REFRESH_TOKEN = 'browser-refresh-token-value-not-a-real-token';
const ACCESS_TOKEN = 'browser-access-token-value-not-a-real-token';
const NEW_ACCESS = 'renewed-access-token-value-not-a-real-token';
const NEW_REFRESH = 'renewed-refresh-token-value-not-a-real-toke';

interface Seen {
  readonly url: string;
  readonly headers: Headers;
  readonly method: string;
}

function api(status: number, payload: unknown, seen: Seen[] = []): typeof fetch {
  return (async (input: unknown, init: RequestInit) => {
    seen.push({
      url: String(input),
      headers: new Headers(init.headers),
      method: String(init.method ?? 'GET'),
    });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': status === 200 ? 'application/json' : 'application/problem+json' },
    });
  }) as unknown as typeof fetch;
}

function unreachable(seen: Seen[] = []): typeof fetch {
  return (async (input: unknown, init: RequestInit) => {
    seen.push({
      url: String(input),
      headers: new Headers(init.headers),
      method: String(init.method ?? 'GET'),
    });
    throw new TypeError('network');
  }) as unknown as typeof fetch;
}

function post(path: string, cookie: string | null): Request {
  return new Request(`https://web.test${path}`, {
    method: 'POST',
    headers: {
      origin: 'https://web.test',
      ...(cookie === null ? {} : { cookie }),
    },
  });
}

const ENVELOPE = {
  status: 'ok',
  session: { accessToken: NEW_ACCESS, refreshToken: NEW_REFRESH, expiresIn: 900 },
};

const REFUSAL = {
  type: 'about:blank',
  title: 'Unauthorized',
  status: 401,
  detail: 'Authentication failed.',
  instance: '/v1/auth/refresh',
  code: 'AUTHENTICATION_FAILED',
};

function cookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

function cookieNamed(response: Response, name: string): string | undefined {
  return cookies(response).find((value) => value.startsWith(`${name}=`));
}

describe('POST /api/auth/refresh', () => {
  it('renews the session and answers with no token at all', async () => {
    const seen: Seen[] = [];
    const response = await handleSessionRefresh(
      post('/api/auth/refresh', `${SESSION_COOKIES.refresh.name}=${REFRESH_TOKEN}`),
      { env: ENV, fetch: api(200, ENVELOPE, seen) },
    );

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ status: 'ok' });
    expect(text).not.toContain(NEW_ACCESS);
    expect(text).not.toContain(NEW_REFRESH);
    expect(text).not.toContain(REFRESH_TOKEN);
  });

  it('presents the refresh token upstream in its own header, with the internal credential', async () => {
    const seen: Seen[] = [];
    await handleSessionRefresh(
      post('/api/auth/refresh', `${SESSION_COOKIES.refresh.name}=${REFRESH_TOKEN}`),
      { env: ENV, fetch: api(200, ENVELOPE, seen) },
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('https://api.internal.test/v1/auth/refresh');
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.headers.get('x-refresh-token')).toBe(REFRESH_TOKEN);
    expect(seen[0]?.headers.get('x-internal-credential')).toBe(ENV.INTERNAL_BFF_CREDENTIAL);
    // The browser's own cookie header is never forwarded: the BFF reads it and presents one value.
    expect(seen[0]?.headers.get('cookie')).toBeNull();
  });

  it('rotates both cookies with the approved C-8 attributes', async () => {
    const response = await handleSessionRefresh(
      post('/api/auth/refresh', `${SESSION_COOKIES.refresh.name}=${REFRESH_TOKEN}`),
      { env: ENV, fetch: api(200, ENVELOPE) },
    );

    const access = cookieNamed(response, SESSION_COOKIES.access.name);
    const refresh = cookieNamed(response, SESSION_COOKIES.refresh.name);

    expect(access).toBe(
      `__Host-mp_access=${NEW_ACCESS}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=900`,
    );
    expect(refresh).toBe(
      `__Host-mp_refresh=${NEW_REFRESH}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`,
    );
  });

  it('replaces the refresh token that was spent', async () => {
    const response = await handleSessionRefresh(
      post('/api/auth/refresh', `${SESSION_COOKIES.refresh.name}=${REFRESH_TOKEN}`),
      { env: ENV, fetch: api(200, ENVELOPE) },
    );
    expect(cookieNamed(response, SESSION_COOKIES.refresh.name)).not.toContain(REFRESH_TOKEN);
  });

  it('refuses without a refresh cookie and asks the API nothing', async () => {
    const seen: Seen[] = [];
    const response = await handleSessionRefresh(post('/api/auth/refresh', null), {
      env: ENV,
      fetch: api(200, ENVELOPE, seen),
    });

    expect(response.status).toBe(401);
    expect(seen).toHaveLength(0);
    expect(cookies(response)).toHaveLength(2);
  });

  it('treats an emptied refresh cookie as no session', async () => {
    const seen: Seen[] = [];
    const response = await handleSessionRefresh(
      post('/api/auth/refresh', `${SESSION_COOKIES.refresh.name}=`),
      { env: ENV, fetch: api(200, ENVELOPE, seen) },
    );

    expect(response.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('clears both cookies when the API refuses the token', async () => {
    const response = await handleSessionRefresh(
      post('/api/auth/refresh', `${SESSION_COOKIES.refresh.name}=${REFRESH_TOKEN}`),
      { env: ENV, fetch: api(401, REFUSAL) },
    );

    expect(response.status).toBe(401);
    expect(cookieNamed(response, SESSION_COOKIES.access.name)).toContain('Max-Age=0');
    expect(cookieNamed(response, SESSION_COOKIES.refresh.name)).toContain('Max-Age=0');
  });

  it('leaves the cookies alone when the API cannot be reached', async () => {
    const response = await handleSessionRefresh(
      post('/api/auth/refresh', `${SESSION_COOKIES.refresh.name}=${REFRESH_TOKEN}`),
      { env: ENV, fetch: unreachable() },
    );

    expect(response.status).toBe(503);
    expect(cookies(response)).toHaveLength(0);
  });

  it('treats a failing API the same way: 503, session untouched', async () => {
    const response = await handleSessionRefresh(
      post('/api/auth/refresh', `${SESSION_COOKIES.refresh.name}=${REFRESH_TOKEN}`),
      { env: ENV, fetch: api(500, { code: 'HTTP_ERROR' }) },
    );

    expect(response.status).toBe(503);
    expect(cookies(response)).toHaveLength(0);
  });

  it('refuses a cross-site request before reading any cookie', async () => {
    const seen: Seen[] = [];
    const request = new Request('https://web.test/api/auth/refresh', {
      method: 'POST',
      headers: {
        origin: 'https://evil.test',
        cookie: `${SESSION_COOKIES.refresh.name}=${REFRESH_TOKEN}`,
      },
    });
    const response = await handleSessionRefresh(request, { env: ENV, fetch: api(200, ENVELOPE, seen) });

    expect(response.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it('never leaves a body that could be mistaken for a session', async () => {
    const response = await handleSessionRefresh(
      post('/api/auth/refresh', `${SESSION_COOKIES.refresh.name}=${REFRESH_TOKEN}`),
      { env: ENV, fetch: api(200, ENVELOPE) },
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('POST /api/auth/logout', () => {
  it('ends the session and clears both cookies', async () => {
    const seen: Seen[] = [];
    const response = await handleLogout(
      post('/api/auth/logout', `${SESSION_COOKIES.access.name}=${ACCESS_TOKEN}`),
      { env: ENV, fetch: api(200, { status: 'ok' }, seen) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    expect(cookieNamed(response, SESSION_COOKIES.access.name)).toContain('Max-Age=0');
    expect(cookieNamed(response, SESSION_COOKIES.refresh.name)).toContain('Max-Age=0');
    expect(seen[0]?.url).toBe('https://api.internal.test/v1/auth/logout');
    expect(seen[0]?.headers.get('x-session-token')).toBe(ACCESS_TOKEN);
  });

  it('is idempotent with no session: nothing upstream, still cleared, still 200', async () => {
    const seen: Seen[] = [];
    const response = await handleLogout(post('/api/auth/logout', null), {
      env: ENV,
      fetch: api(200, { status: 'ok' }, seen),
    });

    expect(response.status).toBe(200);
    expect(seen).toHaveLength(0);
    expect(cookies(response)).toHaveLength(2);
  });

  it('clears the cookies even when the API cannot be reached', async () => {
    const response = await handleLogout(
      post('/api/auth/logout', `${SESSION_COOKIES.access.name}=${ACCESS_TOKEN}`),
      { env: ENV, fetch: unreachable() },
    );

    expect(response.status).toBe(200);
    expect(cookieNamed(response, SESSION_COOKIES.access.name)).toContain('Max-Age=0');
    expect(cookieNamed(response, SESSION_COOKIES.refresh.name)).toContain('Max-Age=0');
  });

  it('clears the cookies even when the API refuses the token', async () => {
    const response = await handleLogout(
      post('/api/auth/logout', `${SESSION_COOKIES.access.name}=${ACCESS_TOKEN}`),
      { env: ENV, fetch: api(401, REFUSAL) },
    );

    expect(response.status).toBe(200);
    expect(cookies(response).every((cookie) => cookie.includes('Max-Age=0'))).toBe(true);
  });

  it('answers the same both times it is called', async () => {
    const first = await handleLogout(
      post('/api/auth/logout', `${SESSION_COOKIES.access.name}=${ACCESS_TOKEN}`),
      { env: ENV, fetch: api(200, { status: 'ok' }) },
    );
    const second = await handleLogout(post('/api/auth/logout', null), {
      env: ENV,
      fetch: api(200, { status: 'ok' }),
    });

    expect(first.status).toBe(second.status);
    expect(await first.json()).toEqual(await second.json());
    expect(cookies(first)).toEqual(cookies(second));
  });

  it('refuses a cross-site request', async () => {
    const seen: Seen[] = [];
    const request = new Request('https://web.test/api/auth/logout', {
      method: 'POST',
      headers: {
        origin: 'https://evil.test',
        cookie: `${SESSION_COOKIES.access.name}=${ACCESS_TOKEN}`,
      },
    });
    const response = await handleLogout(request, { env: ENV, fetch: api(200, { status: 'ok' }, seen) });

    expect(response.status).toBe(403);
    expect(seen).toHaveLength(0);
    expect(cookies(response)).toHaveLength(0);
  });
});

describe('reading the caller’s identity', () => {
  const IDENTITY = { user: { id: '11111111-1111-4111-8111-111111111111', displayName: 'Nadia' } };

  it('presents the access cookie and returns the identity', async () => {
    const seen: Seen[] = [];
    const lookup = await readCurrentUser({
      env: ENV,
      fetch: api(200, IDENTITY, seen),
      cookieHeader: `${SESSION_COOKIES.access.name}=${ACCESS_TOKEN}`,
    });

    expect(lookup).toEqual({ kind: 'authenticated', user: IDENTITY.user });
    expect(seen[0]?.url).toBe('https://api.internal.test/v1/users/me');
    expect(seen[0]?.headers.get('x-session-token')).toBe(ACCESS_TOKEN);
    expect(seen[0]?.headers.get('x-internal-credential')).toBe(ENV.INTERNAL_BFF_CREDENTIAL);
  });

  it('asks nothing when there is no access cookie', async () => {
    const seen: Seen[] = [];
    const lookup = await readCurrentUser({ env: ENV, fetch: api(200, IDENTITY, seen), cookieHeader: null });

    expect(lookup).toEqual({ kind: 'unauthenticated' });
    expect(seen).toHaveLength(0);
  });

  it('reports a refused token as unauthenticated', async () => {
    const lookup = await readCurrentUser({
      env: ENV,
      fetch: api(401, REFUSAL),
      cookieHeader: `${SESSION_COOKIES.access.name}=${ACCESS_TOKEN}`,
    });
    expect(lookup).toEqual({ kind: 'unauthenticated' });
  });

  it('reports an outage as unavailable, never as a sign-out', async () => {
    for (const fetcher of [unreachable(), api(503, { code: 'SERVICE_UNAVAILABLE' })]) {
      const lookup = await readCurrentUser({
        env: ENV,
        fetch: fetcher,
        cookieHeader: `${SESSION_COOKIES.access.name}=${ACCESS_TOKEN}`,
      });
      expect(lookup).toEqual({ kind: 'unavailable' });
    }
  });

  it('refuses a body that has drifted from the contract rather than rendering it', async () => {
    const drifted = { user: { id: '11111111-1111-4111-8111-111111111111', displayName: 'Nadia', email: 'x@test.invalid' } };
    const lookup = await readCurrentUser({
      env: ENV,
      fetch: api(200, drifted),
      cookieHeader: `${SESSION_COOKIES.access.name}=${ACCESS_TOKEN}`,
    });
    expect(lookup).toEqual({ kind: 'unavailable' });
  });
});
