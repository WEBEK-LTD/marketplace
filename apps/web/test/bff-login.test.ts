import { describe, expect, it } from 'vitest';
import { handleLogin } from '../src/server/bff/login';
import { addressedOrigin } from '../src/server/bff/origin';
import { DEVICE_COOKIE } from '../src/server/bff/device-cookie';
import { SESSION_COOKIES, clearedSessionCookies, sessionCookies } from '../src/server/bff/session-cookies';

/**
 * The BFF half of F2, where the browser's session is actually made.
 *
 * The assertions that matter are about what the *browser* receives: two `__Host-` cookies with the
 * approved attributes, and a body that contains no token anywhere. The tokens exist in the API's
 * server-to-server response and must die in this handler.
 */

const ENV = Object.freeze({
  API_BASE_URL: 'https://api.internal.test',
  PUBLIC_WEB_ORIGIN: 'https://web.test',
  INTERNAL_BFF_CREDENTIAL: 'test-current-credential-value-not-a-real-se',
});

const ACCESS = 'access-token-value';
const REFRESH = 'refresh-token-value';

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://web.test/auth/login', {
    method: 'POST',
    headers: { origin: 'https://web.test', 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function apiReturns(status: number, payload: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

/** All `Set-Cookie` values, whichever way the runtime exposes them. */
function setCookies(response: Response): string[] {
  const getter = (response.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getter === 'function') return getter.call(response.headers);
  const single = response.headers.get('set-cookie');
  return single === null ? [] : single.split(/,\s*(?=__Host-)/);
}

describe('the BFF login handler', () => {
  it('issues both approved cookies and no token in the body', async () => {
    const response = await handleLogin(post({ identifier: 'a@b.test', password: 'correct horse battery' }), {
      env: ENV,
      fetch: apiReturns(200, { status: 'ok', session: { accessToken: ACCESS, refreshToken: REFRESH, expiresIn: 3600 } }),
    });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ status: 'ok' });
    // The one assertion this whole design exists for.
    expect(body).not.toContain(ACCESS);
    expect(body).not.toContain(REFRESH);

    const cookies = setCookies(response);
    // Three now, not two: C-15 adds the device cookie for a browser that arrived without one. The two
    // session cookies are unchanged, and nothing else is set.
    expect(cookies).toHaveLength(3);
    expect(cookies.some((cookie) => cookie.startsWith(`${SESSION_COOKIES.access.name}=${ACCESS};`))).toBe(true);
    expect(cookies.some((cookie) => cookie.startsWith(`${SESSION_COOKIES.refresh.name}=${REFRESH};`))).toBe(true);
    expect(cookies.filter((cookie) => cookie.startsWith(`${DEVICE_COOKIE.name}=`))).toHaveLength(1);
  });

  it('sets every approved cookie attribute, on both cookies', async () => {
    for (const cookie of sessionCookies({ accessToken: ACCESS, refreshToken: REFRESH })) {
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('Secure');
      expect(cookie).toContain('SameSite=Strict');
      expect(cookie).toContain('Path=/');
      // Host-only: a Domain attribute would both widen the cookie and make the browser reject the
      // `__Host-` prefix outright.
      expect(cookie).not.toContain('Domain');
      expect(cookie.startsWith('__Host-')).toBe(true);
    }
  });

  it('uses the approved names and lifetimes for the public web origin', () => {
    expect(SESSION_COOKIES.access.name).toBe('__Host-mp_access');
    expect(SESSION_COOKIES.refresh.name).toBe('__Host-mp_refresh');
    expect(SESSION_COOKIES.access.maxAgeSeconds).toBe(900);
    expect(SESSION_COOKIES.refresh.maxAgeSeconds).toBe(2_592_000);

    const [access, refresh] = sessionCookies({ accessToken: ACCESS, refreshToken: REFRESH });
    expect(access).toContain('Max-Age=900');
    expect(refresh).toContain('Max-Age=2592000');
  });

  it('clears the session with the same attributes, so the browser actually replaces the cookies', () => {
    for (const cookie of clearedSessionCookies()) {
      expect(cookie).toContain('Max-Age=0');
      expect(cookie).toContain('Path=/');
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('Secure');
      expect(cookie).toContain('SameSite=Strict');
    }
  });

  it('refuses a cross-site post with the existing Origin check and issues nothing', async () => {
    const response = await handleLogin(
      post({ identifier: 'a@b.test', password: 'correct horse battery' }, { origin: 'https://evil.test' }),
      { env: ENV, fetch: apiReturns(200, { status: 'ok', session: { accessToken: ACCESS, refreshToken: REFRESH, expiresIn: 1 } }) },
    );

    expect(response.status).toBe(403);
    expect(setCookies(response)).toHaveLength(0);
  });

  it('passes the API problem through unchanged and clears any session', async () => {
    const problem = {
      type: 'about:blank',
      title: 'Unauthorized',
      status: 401,
      detail: 'Authentication failed.',
      instance: '/v1/auth/login',
      code: 'AUTHENTICATION_FAILED',
    };
    const response = await handleLogin(post({ identifier: 'a@b.test', password: 'correct horse battery' }), {
      env: ENV,
      fetch: apiReturns(401, problem),
    });

    expect(response.status).toBe(401);
    expect(JSON.parse(await response.text())).toEqual(problem);
    expect(setCookies(response).every((cookie) => cookie.includes('Max-Age=0'))).toBe(true);
  });

  it('answers 503 when the API cannot be reached, and never invents a session', async () => {
    const response = await handleLogin(post({ identifier: 'a@b.test', password: 'correct horse battery' }), {
      env: ENV,
      fetch: (() => Promise.reject(new Error('connect ECONNREFUSED'))) as unknown as typeof fetch,
    });

    expect(response.status).toBe(503);
    expect(setCookies(response)).toHaveLength(0);
  });

  it('answers 503 rather than a session when the API returns a body it does not recognise', async () => {
    const response = await handleLogin(post({ identifier: 'a@b.test', password: 'correct horse battery' }), {
      env: ENV,
      fetch: apiReturns(200, { status: 'ok' }),
    });

    expect(response.status).toBe(503);
    expect(setCookies(response)).toHaveLength(0);
  });

  it('sends the internal credential upstream and never lets the browser see it', async () => {
    let seen: Headers | undefined;
    const response = await handleLogin(post({ identifier: 'a@b.test', password: 'correct horse battery' }), {
      env: ENV,
      fetch: (async (_input: unknown, init: RequestInit) => {
        seen = new Headers(init.headers);
        return new Response(
          JSON.stringify({ status: 'ok', session: { accessToken: ACCESS, refreshToken: REFRESH, expiresIn: 1 } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as unknown as typeof fetch,
    });

    expect(seen?.get('x-internal-credential')).toBe(ENV.INTERNAL_BFF_CREDENTIAL);
    expect(await response.text()).not.toContain(ENV.INTERNAL_BFF_CREDENTIAL);
  });
});

describe('the origin a request was addressed to', () => {
  const at = (url: string, headers: Record<string, string>) => addressedOrigin({ url, headers: new Headers(headers) });

  it('uses the Host header, because the server\u2019s own URL is not what the browser addressed', () => {
    // `next start` reports its listening origin here, whatever the request said.
    expect(at('http://localhost:3000/api/auth/login', { host: '127.0.0.1:45327' })).toBe('http://127.0.0.1:45327');
  });

  it('prefers the forwarded host and scheme a proxy set', () => {
    expect(
      at('http://localhost:3000/api/auth/login', {
        host: 'internal.local:3000',
        'x-forwarded-host': 'shop.example.test',
        'x-forwarded-proto': 'https',
      }),
    ).toBe('https://shop.example.test');
  });

  it('takes only the first entry of a forwarded chain and ignores an unknown scheme', () => {
    expect(at('http://localhost:3000/x', { 'x-forwarded-host': 'a.test, b.test', 'x-forwarded-proto': 'https, http' })).toBe('https://a.test');
    expect(at('http://localhost:3000/x', { host: 'a.test', 'x-forwarded-proto': 'gopher' })).toBe('http://a.test');
  });

  it('falls back to the request URL when no host header exists at all', () => {
    expect(at('https://shop.example.test/api/auth/login', {})).toBe('https://shop.example.test');
    expect(at('https://shop.example.test/api/auth/login', { host: '   ' })).toBe('https://shop.example.test');
  });

  it('still refuses a cross-site post when the browser addressed this host', async () => {
    const response = await handleLogin(
      new Request('http://localhost:3000/api/auth/login', {
        method: 'POST',
        headers: { host: 'shop.example.test', origin: 'https://evil.test', 'content-type': 'application/json' },
        body: JSON.stringify({ identifier: 'a@b.test', password: 'correct horse battery' }),
      }),
      { env: ENV, fetch: apiReturns(200, { status: 'ok', session: { accessToken: ACCESS, refreshToken: REFRESH, expiresIn: 1 } }) },
    );

    expect(response.status).toBe(403);
    expect(setCookies(response)).toHaveLength(0);
  });
});
