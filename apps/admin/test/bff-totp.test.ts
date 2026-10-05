import { describe, expect, it } from 'vitest';
import { SESSION_COOKIES } from '../src/server/bff/session-cookies';
import {
  handleTotpChallenge,
  handleTotpEnrol,
  handleTotpStatus,
  handleTotpVerify,
} from '../src/server/bff/totp';
import {
  TOTP_CHALLENGE_COOKIE,
  readTotpChallengeCookie,
  totpChallengeCookie,
} from '../src/server/bff/totp-challenge-cookie';

/**
 * The BFF half of TOTP enrolment and the AAL2 challenge, on the admin origin (Phase 7-B).
 *
 * What matters at this boundary:
 *
 *   * the caller's token comes from the `__Host-mp_admin_access` cookie and never from a request body;
 *   * the factor, the challenge **and the operation a code will authorise** travel in an `HttpOnly`
 *     cookie, so a page can choose none of them — the last is the one that would matter most;
 *   * the provider's `aal2` session stops here and becomes the admin cookies, exactly as the sign-in
 *     envelope does; no token reaches the browser;
 *   * the shared secret crosses once, in the enrolment response, and is never put in a cookie.
 */

const ENV = Object.freeze({
  API_BASE_URL: 'https://api.internal.test',
  INTERNAL_BFF_CREDENTIAL: 'test-current-credential-value-not-a-real-se',
});

const SESSION_TOKEN = 'admin-access-token-value-not-a-real-token';
const FACTOR = '33333333-3333-4333-8333-333333333333';
const CHALLENGE = '22222222-2222-4222-8222-222222222222';
const SECRET = 'JBSWY3DPEHPK3PXP';
const OTPAUTH = `otpauth://totp/Marketplace?secret=${SECRET}&issuer=Marketplace&algorithm=SHA1&digits=6&period=30`;
const NEW_ACCESS = 'aal2-access-token-value-not-a-real-token';
const NEW_REFRESH = 'aal2-refresh-token-value-not-a-real-token';

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
      headers: { 'content-type': status === 200 ? 'application/json' : 'application/problem+json' },
    });
  }) as unknown as typeof fetch;
}

const SESSION_COOKIE = `${SESSION_COOKIES.access.name}=${SESSION_TOKEN}`;

function request(path: string, body: unknown, cookie: string = SESSION_COOKIE, method = 'POST'): Request {
  return new Request(`https://admin.test/api/auth/totp${path}`, {
    method,
    headers: {
      origin: 'https://admin.test',
      'content-type': 'application/json',
      cookie,
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
  });
}

/** A request carrying the challenge cookie the challenge step would have written. */
function withChallenge(path: string, body: unknown, operation: string | null = null): Request {
  return request(path, body, `${SESSION_COOKIE}; ${TOTP_CHALLENGE_COOKIE.name}=${FACTOR}:${CHALLENGE}:${operation ?? ''}`);
}

function setCookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

const PROBLEM = { type: 'about:blank', title: 'Unauthorized', status: 401, code: 'AUTHENTICATION_FAILED' };
const SESSION_ENVELOPE = {
  status: 'verified',
  session: { accessToken: NEW_ACCESS, refreshToken: NEW_REFRESH, expiresIn: 3600 },
};

describe('the challenge cookie', () => {
  it('is its own `__Host-` cookie with the approved attributes', () => {
    expect(TOTP_CHALLENGE_COOKIE.name).toBe('__Host-mp_admin_totp_challenge');
    const serialized = totpChallengeCookie({ factorId: FACTOR, challengeId: CHALLENGE, operation: null })!;
    expect(serialized).toContain('HttpOnly');
    expect(serialized).toContain('Secure');
    expect(serialized).toContain('SameSite=Strict');
    expect(serialized).toContain('Path=/');
    expect(serialized).not.toContain('Domain');
  });

  it('round-trips the factor, the challenge and the operation', () => {
    const state = { factorId: FACTOR, challengeId: CHALLENGE, operation: 'payout.details.change' };
    const value = totpChallengeCookie(state)!.split(';')[0]!;
    expect(readTotpChallengeCookie(value)).toEqual(state);

    const withoutOperation = { factorId: FACTOR, challengeId: CHALLENGE, operation: null };
    const bare = totpChallengeCookie(withoutOperation)!.split(';')[0]!;
    expect(readTotpChallengeCookie(bare)).toEqual(withoutOperation);
  });

  it('refuses to write a state it could not read back', () => {
    expect(totpChallengeCookie({ factorId: 'a:b', challengeId: CHALLENGE, operation: null })).toBeNull();
    expect(totpChallengeCookie({ factorId: FACTOR, challengeId: '../x', operation: null })).toBeNull();
    expect(totpChallengeCookie({ factorId: FACTOR, challengeId: CHALLENGE, operation: 'Not Valid' })).toBeNull();
    expect(totpChallengeCookie({ factorId: '', challengeId: CHALLENGE, operation: null })).toBeNull();
  });

  it('treats anything malformed as no cookie at all', () => {
    for (const value of [
      '',
      FACTOR,
      `${FACTOR}:${CHALLENGE}`,
      `${FACTOR}:${CHALLENGE}:bad operation`,
      `${FACTOR}:${CHALLENGE}:Upper.Case`,
      `../..:${CHALLENGE}:`,
      `${FACTOR}:${CHALLENGE}::extra`,
    ]) {
      expect(
        readTotpChallengeCookie(`${TOTP_CHALLENGE_COOKIE.name}=${value}`),
        value,
      ).toBeNull();
    }
    expect(readTotpChallengeCookie(null)).toBeNull();
  });
});

describe('GET /api/auth/totp', () => {
  it('asks the API with the caller’s own token and rebuilds the answer', async () => {
    const seen: Seen[] = [];
    const response = await handleTotpStatus(request('', undefined, SESSION_COOKIE, 'GET'), {
      env: ENV,
      fetch: api(200, { status: 'enrolled' }, seen),
    });

    expect(seen[0]!.url).toBe('https://api.internal.test/v1/auth/totp');
    expect(seen[0]!.headers.get('x-session-token')).toBe(SESSION_TOKEN);
    expect(await response.json()).toEqual({ status: 'enrolled' });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('refuses without a session and does not call the API', async () => {
    const seen: Seen[] = [];
    const response = await handleTotpStatus(request('', undefined, '', 'GET'), {
      env: ENV,
      fetch: api(200, { status: 'enrolled' }, seen),
    });

    expect(response.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('is a 503 when the API answers something else', async () => {
    const response = await handleTotpStatus(request('', undefined, SESSION_COOKIE, 'GET'), {
      env: ENV,
      fetch: api(200, { status: 'maybe' }),
    });
    expect(response.status).toBe(503);
  });
});

describe('POST /api/auth/totp/enrol', () => {
  it('passes the enrolment material through under no-store, and sets no cookie', async () => {
    const response = await handleTotpEnrol(request('/enrol', {}), {
      env: ENV,
      fetch: api(200, { status: 'ok', secret: SECRET, otpauthUri: OTPAUTH, qrSvg: '<svg/>' }),
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['otpauthUri', 'qrSvg', 'secret', 'status']);
    expect(body['secret']).toBe(SECRET);
    expect(response.headers.get('cache-control')).toBe('no-store');
    // The secret is never written to a cookie: nothing about it survives the response.
    expect(setCookies(response)).toHaveLength(0);
  });

  it('drops anything the API said beyond the three fields the screen uses', async () => {
    const response = await handleTotpEnrol(request('/enrol', {}), {
      env: ENV,
      fetch: api(200, {
        status: 'ok',
        secret: SECRET,
        otpauthUri: OTPAUTH,
        qrSvg: null,
        factorId: FACTOR,
        userId: 'leaked',
      }),
    });
    const raw = await response.text();

    expect(raw).not.toContain(FACTOR);
    expect(raw).not.toContain('leaked');
  });

  it('is a 503 when the API answered 200 without a usable secret', async () => {
    const response = await handleTotpEnrol(request('/enrol', {}), {
      env: ENV,
      fetch: api(200, { status: 'ok', otpauthUri: OTPAUTH, qrSvg: null }),
    });
    expect(response.status).toBe(503);
  });

  it('forwards a refusal unchanged, secret or no secret', async () => {
    const response = await handleTotpEnrol(request('/enrol', {}), {
      env: ENV,
      fetch: api(409, { ...PROBLEM, status: 409, code: 'TOTP_ALREADY_ENROLLED' }),
    });
    const raw = await response.text();

    expect(response.status).toBe(409);
    expect(raw).toContain('TOTP_ALREADY_ENROLLED');
    expect(raw).not.toContain(SECRET);
    expect(setCookies(response)).toHaveLength(0);
  });

  it('refuses a cross-origin post before calling the API', async () => {
    const seen: Seen[] = [];
    const response = await handleTotpEnrol(
      new Request('https://admin.test/api/auth/totp/enrol', {
        method: 'POST',
        headers: { origin: 'https://evil.test', 'content-type': 'application/json', cookie: SESSION_COOKIE },
        body: '{}',
      }),
      { env: ENV, fetch: api(200, { status: 'ok', secret: SECRET, otpauthUri: OTPAUTH, qrSvg: null }, seen) },
    );

    expect(response.status).toBe(403);
    expect(seen).toHaveLength(0);
  });
});

describe('POST /api/auth/totp/challenge', () => {
  const ENVELOPE = { status: 'ok', challenge: { factorId: FACTOR, challengeId: CHALLENGE } };

  it('forwards only the operation and keeps the identifiers in its own cookie', async () => {
    const seen: Seen[] = [];
    const response = await handleTotpChallenge(
      request('/challenge', { operation: 'payout.details.change', factorId: 'chosen-by-the-page' }),
      { env: ENV, fetch: api(200, ENVELOPE, seen) },
    );

    expect(JSON.parse(seen[0]!.body)).toEqual({ operation: 'payout.details.change' });
    expect(await response.json()).toEqual({ status: 'ok' });
    expect(readTotpChallengeCookie(setCookies(response)[0]!.split(';')[0]!)).toEqual({
      factorId: FACTOR,
      challengeId: CHALLENGE,
      operation: 'payout.details.change',
    });
  });

  it('tells the browser nothing about the factor or the challenge', async () => {
    const response = await handleTotpChallenge(request('/challenge', {}), {
      env: ENV,
      fetch: api(200, ENVELOPE),
    });
    const raw = await response.text();

    expect(raw).not.toContain(FACTOR);
    expect(raw).not.toContain(CHALLENGE);
    expect(raw).toBe(JSON.stringify({ status: 'ok' }));
  });

  it('records no operation when none was asked for', async () => {
    const response = await handleTotpChallenge(request('/challenge', {}), {
      env: ENV,
      fetch: api(200, ENVELOPE),
    });

    expect(readTotpChallengeCookie(setCookies(response)[0]!.split(';')[0]!)?.operation).toBeNull();
  });

  it('is a 503 rather than a challenge nobody could answer', async () => {
    const response = await handleTotpChallenge(request('/challenge', {}), {
      env: ENV,
      fetch: api(200, { status: 'ok', challenge: { factorId: 'has:colon', challengeId: CHALLENGE } }),
    });

    expect(response.status).toBe(503);
    expect(setCookies(response)).toHaveLength(0);
  });

  it('refuses without a session, and forwards the API’s own refusals', async () => {
    const seen: Seen[] = [];
    const noSession = await handleTotpChallenge(request('/challenge', {}, ''), {
      env: ENV,
      fetch: api(200, ENVELOPE, seen),
    });
    expect(noSession.status).toBe(401);
    expect(seen).toHaveLength(0);

    const notEnrolled = await handleTotpChallenge(request('/challenge', {}), {
      env: ENV,
      fetch: api(409, { ...PROBLEM, status: 409, code: 'TOTP_NOT_ENROLLED' }),
    });
    expect(notEnrolled.status).toBe(409);
    expect(setCookies(notEnrolled)).toHaveLength(0);
  });
});

describe('POST /api/auth/totp/verify', () => {
  it('sends the cookie’s identifiers and the page’s code', async () => {
    const seen: Seen[] = [];
    await handleTotpVerify(withChallenge('/verify', { code: '123456' }), {
      env: ENV,
      fetch: api(200, SESSION_ENVELOPE, seen),
    });

    expect(JSON.parse(seen[0]!.body)).toEqual({
      factorId: FACTOR,
      challengeId: CHALLENGE,
      code: '123456',
    });
  });

  it('takes the operation from the cookie, never from the request', async () => {
    const seen: Seen[] = [];
    await handleTotpVerify(
      // The cookie says one operation; the page asks for another. The cookie wins, because it was sealed
      // when the challenge was raised — before this code existed.
      withChallenge('/verify', { code: '123456', operation: 'account.delete' }, 'payout.details.change'),
      { env: ENV, fetch: api(200, SESSION_ENVELOPE, seen) },
    );

    expect(JSON.parse(seen[0]!.body)['operation']).toBe('payout.details.change');
  });

  it('never lets a page choose the factor or the challenge', async () => {
    const seen: Seen[] = [];
    await handleTotpVerify(
      withChallenge('/verify', { code: '123456', factorId: 'somebody-else', challengeId: 'replayed' }),
      { env: ENV, fetch: api(200, SESSION_ENVELOPE, seen) },
    );

    const sent = JSON.parse(seen[0]!.body) as Record<string, unknown>;
    expect(sent['factorId']).toBe(FACTOR);
    expect(sent['challengeId']).toBe(CHALLENGE);
  });

  it('turns the aal2 session into the admin cookies and tells the browser nothing', async () => {
    const response = await handleTotpVerify(withChallenge('/verify', { code: '123456' }), {
      env: ENV,
      fetch: api(200, SESSION_ENVELOPE),
    });
    const raw = await response.clone().text();
    const cookies = setCookies(response);

    expect(await response.json()).toEqual({ status: 'verified' });
    expect(raw).not.toContain(NEW_ACCESS);
    expect(raw).not.toContain(NEW_REFRESH);
    // The same two `__Host-mp_admin_*` cookies the sign-in writes, replaced with the aal2 pair.
    expect(cookies.some((cookie) => cookie.startsWith(`${SESSION_COOKIES.access.name}=${NEW_ACCESS}`))).toBe(
      true,
    );
    expect(cookies.some((cookie) => cookie.startsWith(`${SESSION_COOKIES.refresh.name}=${NEW_REFRESH}`))).toBe(
      true,
    );
    for (const cookie of cookies) {
      if (cookie.startsWith(TOTP_CHALLENGE_COOKIE.name)) continue;
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('Secure');
      expect(cookie).toContain('SameSite=Strict');
    }
    // Spent: the challenge has nothing left to authorise.
    expect(cookies.some((cookie) => cookie.startsWith(`${TOTP_CHALLENGE_COOKIE.name}=;`))).toBe(true);
  });

  it('refuses without the challenge cookie and does not call the API', async () => {
    const seen: Seen[] = [];
    const response = await handleTotpVerify(request('/verify', { code: '123456' }), {
      env: ENV,
      fetch: api(200, SESSION_ENVELOPE, seen),
    });

    expect(response.status).toBe(401);
    expect(seen).toHaveLength(0);
    expect(setCookies(response)[0]).toContain('Max-Age=0');
  });

  it('treats a tampered challenge cookie as none at all', async () => {
    const seen: Seen[] = [];
    const response = await handleTotpVerify(
      request('/verify', { code: '123456' }, `${SESSION_COOKIE}; ${TOTP_CHALLENGE_COOKIE.name}=nonsense`),
      { env: ENV, fetch: api(200, SESSION_ENVELOPE, seen) },
    );

    expect(response.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('clears the challenge on a refused code and keeps the session cookies alone', async () => {
    const response = await handleTotpVerify(withChallenge('/verify', { code: '000000' }), {
      env: ENV,
      fetch: api(401, PROBLEM),
    });
    const cookies = setCookies(response);

    expect(response.status).toBe(401);
    expect(cookies.some((cookie) => cookie.startsWith(`${TOTP_CHALLENGE_COOKIE.name}=;`))).toBe(true);
    // A refused code is not a sign-out: the aal1 session the person already had is untouched.
    expect(cookies.some((cookie) => cookie.startsWith(SESSION_COOKIES.access.name))).toBe(false);
    expect(cookies.some((cookie) => cookie.startsWith(SESSION_COOKIES.refresh.name))).toBe(false);
  });

  it('keeps the challenge on an outage, which is worth retrying', async () => {
    const response = await handleTotpVerify(withChallenge('/verify', { code: '123456' }), {
      env: ENV,
      fetch: api(503, { ...PROBLEM, status: 503, code: 'SERVICE_UNAVAILABLE' }),
    });

    expect(response.status).toBe(503);
    expect(setCookies(response)).toHaveLength(0);
  });

  it('is a 503 when the API answered 200 without a usable session', async () => {
    const response = await handleTotpVerify(withChallenge('/verify', { code: '123456' }), {
      env: ENV,
      fetch: api(200, { status: 'verified' }),
    });

    expect(response.status).toBe(503);
    expect(setCookies(response)).toHaveLength(0);
  });

  it('refuses a cross-origin post', async () => {
    const seen: Seen[] = [];
    const response = await handleTotpVerify(
      new Request('https://admin.test/api/auth/totp/verify', {
        method: 'POST',
        headers: {
          origin: 'https://evil.test',
          'content-type': 'application/json',
          cookie: `${SESSION_COOKIE}; ${TOTP_CHALLENGE_COOKIE.name}=${FACTOR}:${CHALLENGE}:`,
        },
        body: JSON.stringify({ code: '123456' }),
      }),
      { env: ENV, fetch: api(200, SESSION_ENVELOPE, seen) },
    );

    expect(response.status).toBe(403);
    expect(seen).toHaveLength(0);
  });
});
