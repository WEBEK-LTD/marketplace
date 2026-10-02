import { describe, expect, it } from 'vitest';
import {
  handleRecoveryReset,
  handleRecoveryStart,
  handleRecoveryVerify,
} from '../src/server/bff/recovery';
import { RESET_COOKIE, clearedResetCookie, readResetCookie, resetCookie } from '../src/server/bff/reset-cookie';

/**
 * The BFF half of the F3 recovery flow.
 *
 * The assertions that matter are about what crosses the boundary in each direction: the reset token must
 * arrive from the API and leave only as a `Set-Cookie`, never as a body, a URL or a log line; and a
 * token presented by a browser must never be forwarded to the API.
 */

const ENV = Object.freeze({
  API_BASE_URL: 'https://api.internal.test',
  PUBLIC_WEB_ORIGIN: 'https://web.test',
  INTERNAL_BFF_CREDENTIAL: 'test-current-credential-value-not-a-real-se',
});

const TOKEN = 'reset-token-canary-value-not-a-real-token-x';
const CHALLENGE = '22222222-2222-4222-8222-222222222222';

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://web.test/api/auth/recovery/${path}`, {
    method: 'POST',
    headers: { origin: 'https://web.test', 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

interface Seen {
  readonly url: string;
  readonly headers: Headers;
  readonly body: string;
}

function api(status: number, payload: unknown, seen: Seen[] = []): typeof fetch {
  return (async (input: unknown, init: RequestInit) => {
    seen.push({ url: String(input), headers: new Headers(init.headers), body: String(init.body ?? '') });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': status === 200 ? 'application/json' : 'application/problem+json' },
    });
  }) as unknown as typeof fetch;
}

function cookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

const GENERIC_401 = {
  type: 'about:blank',
  title: 'Unauthorized',
  status: 401,
  detail: 'Authentication failed.',
  instance: '/v1/auth/recovery/verify',
  code: 'AUTHENTICATION_FAILED',
};

describe('the reset cookie', () => {
  it('uses the approved name, lifetime and attributes, and is not a session cookie', () => {
    expect(RESET_COOKIE.name).toBe('__Host-mp_reset');
    expect(RESET_COOKIE.maxAgeSeconds).toBe(900);

    const cookie = resetCookie(TOKEN);
    expect(cookie.startsWith(`__Host-mp_reset=${TOKEN};`)).toBe(true);
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Max-Age=900');
    expect(cookie).not.toContain('Domain');
    // None of the four C-8 session cookie names may be reused for a reset.
    for (const session of ['__Host-mp_access', '__Host-mp_refresh', '__Host-mp_admin_access', '__Host-mp_admin_refresh']) {
      expect(cookie).not.toContain(session);
    }
  });

  it('clears with the same attributes so the browser really replaces it', () => {
    const cleared = clearedResetCookie();
    expect(cleared).toContain('Max-Age=0');
    expect(cleared).toContain('HttpOnly');
    expect(cleared).toContain('Secure');
    expect(cleared).toContain('SameSite=Strict');
    expect(cleared).toContain('Path=/');
  });

  it('reads its own value out of a cookie header and ignores everything else', () => {
    expect(readResetCookie(`other=1; __Host-mp_reset=${TOKEN}; another=2`)).toBe(TOKEN);
    expect(readResetCookie('__Host-mp_access=session-token')).toBeNull();
    expect(readResetCookie('__Host-mp_reset=')).toBeNull();
    expect(readResetCookie(null)).toBeNull();
  });
});

describe('POST /api/auth/recovery/start', () => {
  it('forwards the request with the internal credential and passes the neutral answer through', async () => {
    const seen: Seen[] = [];
    const response = await handleRecoveryStart(post('start', { identifier: 'person@example.test' }), {
      env: ENV,
      fetch: api(200, { status: 'ok', challengeId: CHALLENGE }, seen),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', challengeId: CHALLENGE });
    expect(seen[0]?.url).toBe('https://api.internal.test/v1/auth/recovery/start');
    expect(seen[0]?.headers.get('x-internal-credential')).toBe(ENV.INTERNAL_BFF_CREDENTIAL);
    // Nothing is set on the browser at this step: there is no token yet.
    expect(cookies(response)).toHaveLength(0);
  });

  it('gives a known and an unknown identifier byte-identical treatment', async () => {
    const known = await handleRecoveryStart(post('start', { identifier: 'person@example.test' }), {
      env: ENV,
      fetch: api(200, { status: 'ok', challengeId: CHALLENGE }),
    });
    const unknown = await handleRecoveryStart(post('start', { identifier: 'nobody@example.test' }), {
      env: ENV,
      fetch: api(200, { status: 'ok', challengeId: '33333333-3333-4333-8333-333333333333' }),
    });

    expect(unknown.status).toBe(known.status);
    expect(unknown.headers.get('content-type')).toBe(known.headers.get('content-type'));
    expect(Object.keys(await unknown.json()).sort()).toEqual(Object.keys(await known.json()).sort());
    expect(cookies(unknown)).toEqual(cookies(known));
  });

  it('refuses a cross-site post before the API is called', async () => {
    const seen: Seen[] = [];
    const response = await handleRecoveryStart(
      post('start', { identifier: 'person@example.test' }, { origin: 'https://evil.test' }),
      { env: ENV, fetch: api(200, { status: 'ok', challengeId: CHALLENGE }, seen) },
    );

    expect(response.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it('answers 503 when the API cannot be reached', async () => {
    const response = await handleRecoveryStart(post('start', { identifier: 'person@example.test' }), {
      env: ENV,
      fetch: (() => Promise.reject(new Error('connect ECONNREFUSED'))) as unknown as typeof fetch,
    });
    expect(response.status).toBe(503);
  });
});

describe('POST /api/auth/recovery/verify', () => {
  const envelope = {
    status: 'ok',
    reset: { token: TOKEN, link: `https://web.test/auth/recovery?token=${TOKEN}`, expiresAt: new Date().toISOString() },
  };

  it('turns the API token into the reset cookie and returns a body with no token in it', async () => {
    const response = await handleRecoveryVerify(post('verify', { challengeId: CHALLENGE, otp: '123456' }), {
      env: ENV,
      fetch: api(200, envelope),
    });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ status: 'ok', next: '/reset-password' });
    // The assertion this whole design exists for.
    expect(body).not.toContain(TOKEN);
    // And the next location the browser is given carries no token either.
    expect(JSON.parse(body).next).not.toContain('token');

    const set = cookies(response);
    expect(set).toHaveLength(1);
    expect(set[0]).toBe(resetCookie(TOKEN));
  });

  it('never returns the recovery link, so the token cannot end up in a browser URL', async () => {
    const response = await handleRecoveryVerify(post('verify', { challengeId: CHALLENGE, otp: '123456' }), {
      env: ENV,
      fetch: api(200, envelope),
    });
    const body = await response.text();
    expect(body).not.toContain('https://web.test/auth/recovery');
    expect(body).not.toContain('link');
  });

  it('passes a refused code through as the generic problem and clears any reset cookie', async () => {
    const response = await handleRecoveryVerify(post('verify', { challengeId: CHALLENGE, otp: '000000' }), {
      env: ENV,
      fetch: api(401, GENERIC_401),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(GENERIC_401);
    expect(cookies(response)).toEqual([clearedResetCookie()]);
  });

  it('answers 503 rather than a cookie when the envelope is not the expected shape', async () => {
    const response = await handleRecoveryVerify(post('verify', { challengeId: CHALLENGE, otp: '123456' }), {
      env: ENV,
      fetch: api(200, { status: 'ok' }),
    });

    expect(response.status).toBe(503);
    expect(cookies(response)).toHaveLength(0);
  });

  it('refuses a cross-site post and sets nothing', async () => {
    const response = await handleRecoveryVerify(
      post('verify', { challengeId: CHALLENGE, otp: '123456' }, { origin: 'https://evil.test' }),
      { env: ENV, fetch: api(200, envelope) },
    );

    expect(response.status).toBe(403);
    expect(cookies(response)).toHaveLength(0);
  });
});

describe('POST /api/auth/recovery/reset', () => {
  it('sends the cookie token in the approved header and only the password in the body', async () => {
    const seen: Seen[] = [];
    const response = await handleRecoveryReset(
      post('reset', { newPassword: 'correct horse battery staple' }, { cookie: `__Host-mp_reset=${TOKEN}` }),
      { env: ENV, fetch: api(200, { status: 'ok' }, seen) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    expect(seen[0]?.headers.get('x-reset-token')).toBe(TOKEN);
    expect(seen[0]?.headers.get('x-internal-credential')).toBe(ENV.INTERNAL_BFF_CREDENTIAL);
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({ newPassword: 'correct horse battery staple' });
    // Spent: the cookie is cleared on the way out.
    expect(cookies(response)).toEqual([clearedResetCookie()]);
  });

  it('never forwards a token the browser put in its own body', async () => {
    const seen: Seen[] = [];
    await handleRecoveryReset(
      post(
        'reset',
        { newPassword: 'correct horse battery staple', resetToken: 'browser-supplied-token' },
        { cookie: `__Host-mp_reset=${TOKEN}` },
      ),
      { env: ENV, fetch: api(200, { status: 'ok' }, seen) },
    );

    expect(seen[0]?.body).not.toContain('browser-supplied-token');
    expect(seen[0]?.headers.get('x-reset-token')).toBe(TOKEN);
  });

  it('refuses with the generic 401 when no reset cookie is present, without calling the API', async () => {
    const seen: Seen[] = [];
    const response = await handleRecoveryReset(post('reset', { newPassword: 'correct horse battery staple' }), {
      env: ENV,
      fetch: api(200, { status: 'ok' }, seen),
    });

    expect(response.status).toBe(401);
    expect(((await response.json()) as Record<string, unknown>)['code']).toBe('AUTHENTICATION_FAILED');
    expect(seen).toHaveLength(0);
    expect(cookies(response)).toEqual([clearedResetCookie()]);
  });

  it('clears the cookie when the API refuses the token, and passes the problem through', async () => {
    const response = await handleRecoveryReset(
      post('reset', { newPassword: 'correct horse battery staple' }, { cookie: `__Host-mp_reset=${TOKEN}` }),
      { env: ENV, fetch: api(401, { ...GENERIC_401, instance: '/v1/auth/recovery/reset' }) },
    );

    expect(response.status).toBe(401);
    expect(cookies(response)).toEqual([clearedResetCookie()]);
  });

  it('refuses a cross-site post and never reads the cookie', async () => {
    const seen: Seen[] = [];
    const response = await handleRecoveryReset(
      post(
        'reset',
        { newPassword: 'correct horse battery staple' },
        { origin: 'https://evil.test', cookie: `__Host-mp_reset=${TOKEN}` },
      ),
      { env: ENV, fetch: api(200, { status: 'ok' }, seen) },
    );

    expect(response.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it('answers 503 when the API cannot be reached', async () => {
    const response = await handleRecoveryReset(
      post('reset', { newPassword: 'correct horse battery staple' }, { cookie: `__Host-mp_reset=${TOKEN}` }),
      { env: ENV, fetch: (() => Promise.reject(new Error('down'))) as unknown as typeof fetch },
    );
    expect(response.status).toBe(503);
  });

  it('never echoes the token or the credential back to the browser', async () => {
    const response = await handleRecoveryReset(
      post('reset', { newPassword: 'correct horse battery staple' }, { cookie: `__Host-mp_reset=${TOKEN}` }),
      { env: ENV, fetch: api(200, { status: 'ok', echo: TOKEN }) },
    );

    const body = await response.text();
    expect(body).not.toContain(TOKEN);
    expect(body).not.toContain(ENV.INTERNAL_BFF_CREDENTIAL);
  });
});
