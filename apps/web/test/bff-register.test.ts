import { describe, expect, it } from 'vitest';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/server/bff/internal-credential';
import {
  handleRegister,
  handleRegisterResend,
  handleRegisterVerify,
} from '../src/server/bff/register';
import {
  REGISTER_CHALLENGE_COOKIE,
  clearedRegisterChallengeCookie,
  readRegisterChallengeCookie,
  registerChallengeCookie,
} from '../src/server/bff/register-challenge-cookie';

/**
 * The BFF half of registration and contact verification (Phase 7-A).
 *
 * What matters at this boundary:
 *
 *   * **the browser is told nothing that varies with whether the address was taken** — the success body is
 *     a literal with one field, and the challenge cookie is set on both paths, so the next page cannot look
 *     or behave differently for the two cases;
 *   * **the challenge travels in its own `HttpOnly` cookie**, separate from the contact change's, so the
 *     browser never learns which challenge it is answering and cannot choose one;
 *   * **no session cookie is ever set, cleared or refreshed**, because nothing in registration signs
 *     anyone in;
 *   * **the resend carries no destination**, so there is nothing in it to aim.
 */

const ENV = Object.freeze({
  API_BASE_URL: 'https://api.internal.test',
  PUBLIC_WEB_ORIGIN: 'https://web.test',
  INTERNAL_BFF_CREDENTIAL: 'test-current-credential-value-not-a-real-se',
});

const CHALLENGE = '22222222-2222-4222-8222-222222222222';
const FRESH_CHALLENGE = '33333333-3333-4333-8333-333333333333';
const EMAIL = 'new.person@example.test';
const PHONE = '+201555000222';
const PASSWORD = 'a-sufficiently-long-password';

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

function request(path: string, body: unknown, cookie?: string): Request {
  return new Request(`https://web.test/api/auth/${path}`, {
    method: 'POST',
    headers: {
      origin: 'https://web.test',
      'content-type': 'application/json',
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify(body),
  });
}

/** A request carrying the challenge cookie the registration step would have set. */
function withChallenge(path: string, body: unknown, value = CHALLENGE): Request {
  return request(path, body, `${REGISTER_CHALLENGE_COOKIE.name}=${value}`);
}

const REGISTRATION = { email: EMAIL, phone: PHONE, password: PASSWORD, displayName: 'Nadia' };

function setCookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

const PROBLEM = { type: 'about:blank', title: 'Unauthorized', status: 401, code: 'AUTHENTICATION_FAILED' };

describe('the registration challenge cookie', () => {
  it('is its own `__Host-` cookie, and not the contact change’s', () => {
    expect(REGISTER_CHALLENGE_COOKIE.name).toBe('__Host-mp_register_challenge');
    expect(REGISTER_CHALLENGE_COOKIE.name).not.toBe('__Host-mp_contact_phone_challenge');
    const serialized = registerChallengeCookie(CHALLENGE);
    expect(serialized).toContain('HttpOnly');
    expect(serialized).toContain('Secure');
    expect(serialized).toContain('SameSite=Strict');
    expect(serialized).toContain('Path=/');
    expect(serialized).not.toContain('Domain');
  });

  it('clears with the same attributes and an empty value', () => {
    const cleared = clearedRegisterChallengeCookie();
    expect(cleared).toContain(`${REGISTER_CHALLENGE_COOKIE.name}=;`);
    expect(cleared).toContain('Max-Age=0');
    expect(cleared).toContain('HttpOnly');
    expect(cleared).toContain('Secure');
  });

  it('reads only a challenge identifier, so nothing a browser invents reaches the API', () => {
    expect(readRegisterChallengeCookie(`${REGISTER_CHALLENGE_COOKIE.name}=${CHALLENGE}`)).toBe(CHALLENGE);
    for (const value of ['', 'not-a-uuid', '../../etc', `${CHALLENGE} or 1=1`]) {
      expect(readRegisterChallengeCookie(`${REGISTER_CHALLENGE_COOKIE.name}=${value}`), value).toBeNull();
    }
    expect(readRegisterChallengeCookie(null)).toBeNull();
    // Another flow's cookie is not this one.
    expect(readRegisterChallengeCookie(`__Host-mp_contact_phone_challenge=${CHALLENGE}`)).toBeNull();
  });
});

describe('POST /api/auth/register', () => {
  it('forwards the four approved fields with the internal credential', async () => {
    const seen: Seen[] = [];
    await handleRegister(request('register', REGISTRATION), {
      env: ENV,
      fetch: api(200, { status: 'ok', challengeId: CHALLENGE }, seen),
    });

    expect(seen[0]!.url).toBe('https://api.internal.test/v1/auth/register');
    expect(JSON.parse(seen[0]!.body)).toEqual(REGISTRATION);
    expect(seen[0]!.headers.get(INTERNAL_CREDENTIAL_HEADER)).toBe(ENV.INTERNAL_BFF_CREDENTIAL);
  });

  it('drops anything the page added beyond those fields', async () => {
    const seen: Seen[] = [];
    await handleRegister(
      request('register', { ...REGISTRATION, userId: 'x', emailConfirm: true, challengeId: CHALLENGE }),
      { env: ENV, fetch: api(200, { status: 'ok', challengeId: CHALLENGE }, seen) },
    );

    expect(Object.keys(JSON.parse(seen[0]!.body)).sort()).toEqual([
      'displayName',
      'email',
      'password',
      'phone',
    ]);
  });

  it('omits the optional name rather than forwarding an empty one', async () => {
    const seen: Seen[] = [];
    const { displayName: _unused, ...withoutName } = REGISTRATION;
    await handleRegister(request('register', withoutName), {
      env: ENV,
      fetch: api(200, { status: 'ok', challengeId: CHALLENGE }, seen),
    });

    expect('displayName' in JSON.parse(seen[0]!.body)).toBe(false);
  });

  it('answers the browser with a status and nothing else, and puts the challenge in the cookie', async () => {
    const response = await handleRegister(request('register', REGISTRATION), {
      env: ENV,
      fetch: api(200, { status: 'ok', challengeId: CHALLENGE }),
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    // Not even the identifier: there is nothing in this body a page could compare between two addresses.
    expect(body).toEqual({ status: 'ok' });
    expect(setCookies(response)).toHaveLength(1);
    expect(setCookies(response)[0]).toContain(`${REGISTER_CHALLENGE_COOKIE.name}=${CHALLENGE}`);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('sets the cookie for a synthetic challenge too, so the next page cannot tell the difference', async () => {
    // The API answers a taken address with a challenge identifier that belongs to nothing. Were the cookie
    // withheld here, the verification page would render its "start again" state for a taken address and its
    // form for a free one — an account-existence oracle in a page render.
    const free = await handleRegister(request('register', REGISTRATION), {
      env: ENV,
      fetch: api(200, { status: 'ok', challengeId: CHALLENGE }),
    });
    const taken = await handleRegister(request('register', REGISTRATION), {
      env: ENV,
      fetch: api(200, { status: 'ok', challengeId: FRESH_CHALLENGE }),
    });

    expect(taken.status).toBe(free.status);
    expect(await taken.clone().json()).toEqual(await free.clone().json());
    expect(setCookies(taken)).toHaveLength(setCookies(free).length);
    expect(readRegisterChallengeCookie(setCookies(taken)[0]!.split(';')[0]!)).toBe(FRESH_CHALLENGE);
  });

  it('never touches a session cookie', async () => {
    const response = await handleRegister(request('register', REGISTRATION), {
      env: ENV,
      fetch: api(200, { status: 'ok', challengeId: CHALLENGE }),
    });

    for (const cookie of setCookies(response)) {
      expect(cookie).not.toContain('__Host-mp_access');
      expect(cookie).not.toContain('__Host-mp_refresh');
    }
  });

  it('never lets the password or the address back out to the browser', async () => {
    const response = await handleRegister(request('register', REGISTRATION), {
      env: ENV,
      // Even if the API said too much, this layer rebuilds the body from what it knows.
      fetch: api(200, { status: 'ok', challengeId: CHALLENGE, email: EMAIL, exists: true }),
    });
    const raw = await response.text();

    expect(raw).not.toContain(PASSWORD);
    expect(raw).not.toContain(EMAIL);
    expect(raw).not.toContain('exists');
    expect(raw).not.toContain(CHALLENGE);
  });

  it('refuses a cross-origin post before calling the API', async () => {
    const seen: Seen[] = [];
    const response = await handleRegister(
      new Request('https://web.test/api/auth/register', {
        method: 'POST',
        headers: { origin: 'https://evil.test', 'content-type': 'application/json' },
        body: JSON.stringify(REGISTRATION),
      }),
      { env: ENV, fetch: api(200, { status: 'ok', challengeId: CHALLENGE }, seen) },
    );

    expect(response.status).toBe(403);
    expect(seen).toHaveLength(0);
    expect(setCookies(response)).toHaveLength(0);
  });

  it('is a 400 for a body that is not JSON, and a 503 when the API cannot be reached', async () => {
    const malformed = await handleRegister(
      new Request('https://web.test/api/auth/register', {
        method: 'POST',
        headers: { origin: 'https://web.test', 'content-type': 'application/json' },
        body: 'not json',
      }),
      { env: ENV, fetch: api(200, { status: 'ok', challengeId: CHALLENGE }) },
    );
    expect(malformed.status).toBe(400);

    const unreachable = await handleRegister(request('register', REGISTRATION), {
      env: ENV,
      fetch: (() => Promise.reject(new Error('down'))) as unknown as typeof fetch,
    });
    expect(unreachable.status).toBe(503);
    expect(setCookies(unreachable)).toHaveLength(0);
  });

  it('forwards an API problem unchanged and sets no cookie', async () => {
    const response = await handleRegister(request('register', REGISTRATION), {
      env: ENV,
      fetch: api(429, { ...PROBLEM, status: 429, code: 'TOO_MANY_REQUESTS' }),
    });

    expect(response.status).toBe(429);
    expect((await response.json())['code']).toBe('TOO_MANY_REQUESTS');
    expect(setCookies(response)).toHaveLength(0);
  });

  it('is a 503 when the API answered 200 without a usable challenge', async () => {
    const response = await handleRegister(request('register', REGISTRATION), {
      env: ENV,
      fetch: api(200, { status: 'ok' }),
    });

    expect(response.status).toBe(503);
    expect(setCookies(response)).toHaveLength(0);
  });
});

describe('POST /api/auth/register/resend', () => {
  it('sends the challenge from the cookie and nothing the browser could aim', async () => {
    const seen: Seen[] = [];
    await handleRegisterResend(withChallenge('register/resend', { phone: '+201000000000' }), {
      env: ENV,
      fetch: api(200, { status: 'ok', challengeId: FRESH_CHALLENGE }, seen),
    });

    expect(seen[0]!.url).toBe('https://api.internal.test/v1/auth/register/resend');
    // The phone the page tried to add is not forwarded. The destination is decided in the database.
    expect(JSON.parse(seen[0]!.body)).toEqual({ challengeId: CHALLENGE });
  });

  it('replaces the cookie with the fresh challenge and tells the browser only the status', async () => {
    const response = await handleRegisterResend(withChallenge('register/resend', {}), {
      env: ENV,
      fetch: api(200, { status: 'ok', challengeId: FRESH_CHALLENGE }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    expect(readRegisterChallengeCookie(setCookies(response)[0]!.split(';')[0]!)).toBe(FRESH_CHALLENGE);
  });

  it('refuses without the cookie, and does not call the API', async () => {
    const seen: Seen[] = [];
    const response = await handleRegisterResend(request('register/resend', {}), {
      env: ENV,
      fetch: api(200, { status: 'ok', challengeId: FRESH_CHALLENGE }, seen),
    });

    expect(response.status).toBe(401);
    expect((await response.json())['code']).toBe('AUTHENTICATION_FAILED');
    expect(seen).toHaveLength(0);
    expect(setCookies(response)[0]).toContain('Max-Age=0');
  });

  it('ignores a challenge the page put in the body', async () => {
    const seen: Seen[] = [];
    const response = await handleRegisterResend(
      request('register/resend', { challengeId: FRESH_CHALLENGE }),
      { env: ENV, fetch: api(200, { status: 'ok', challengeId: FRESH_CHALLENGE }, seen) },
    );

    // No cookie, so no resend — whatever the body said.
    expect(response.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('clears the cookie on a 401, and keeps it on a throttle worth retrying', async () => {
    const refused = await handleRegisterResend(withChallenge('register/resend', {}), {
      env: ENV,
      fetch: api(401, PROBLEM),
    });
    expect(refused.status).toBe(401);
    expect(setCookies(refused)[0]).toContain('Max-Age=0');

    const throttled = await handleRegisterResend(withChallenge('register/resend', {}), {
      env: ENV,
      fetch: api(429, { ...PROBLEM, status: 429, code: 'TOO_MANY_REQUESTS' }),
    });
    expect(throttled.status).toBe(429);
    expect(setCookies(throttled)).toHaveLength(0);
  });

  it('never returns a session or a destination', async () => {
    const response = await handleRegisterResend(withChallenge('register/resend', {}), {
      env: ENV,
      fetch: api(200, { status: 'ok', challengeId: FRESH_CHALLENGE, toPhoneE164: PHONE }),
    });
    const raw = await response.text();

    expect(raw).not.toContain(PHONE);
    expect(raw).not.toContain(FRESH_CHALLENGE);
    for (const cookie of setCookies(response)) {
      expect(cookie).not.toContain('__Host-mp_access');
      expect(cookie).not.toContain('__Host-mp_refresh');
    }
  });

  it('refuses a cross-origin post', async () => {
    const seen: Seen[] = [];
    const response = await handleRegisterResend(
      new Request('https://web.test/api/auth/register/resend', {
        method: 'POST',
        headers: {
          origin: 'https://evil.test',
          'content-type': 'application/json',
          cookie: `${REGISTER_CHALLENGE_COOKIE.name}=${CHALLENGE}`,
        },
        body: JSON.stringify({}),
      }),
      { env: ENV, fetch: api(200, { status: 'ok', challengeId: FRESH_CHALLENGE }, seen) },
    );

    expect(response.status).toBe(403);
    expect(seen).toHaveLength(0);
  });
});

describe('POST /api/auth/register/verify', () => {
  it('forwards the challenge from the cookie and the code from the body', async () => {
    const seen: Seen[] = [];
    await handleRegisterVerify(withChallenge('register/verify', { otp: '123456' }), {
      env: ENV,
      fetch: api(200, { status: 'verified' }, seen),
    });

    expect(seen[0]!.url).toBe('https://api.internal.test/v1/auth/register/verify');
    expect(JSON.parse(seen[0]!.body)).toEqual({ challengeId: CHALLENGE, otp: '123456' });
  });

  it('never lets a page choose the challenge it answers', async () => {
    const seen: Seen[] = [];
    await handleRegisterVerify(
      withChallenge('register/verify', { otp: '123456', challengeId: FRESH_CHALLENGE }),
      { env: ENV, fetch: api(200, { status: 'verified' }, seen) },
    );

    expect(JSON.parse(seen[0]!.body)['challengeId']).toBe(CHALLENGE);
  });

  it('answers with a literal, clears the challenge and creates no session', async () => {
    const response = await handleRegisterVerify(withChallenge('register/verify', { otp: '123456' }), {
      env: ENV,
      fetch: api(200, { status: 'verified', accessToken: 'leaked', userId: 'leaked' }),
    });
    const raw = await response.clone().text();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'verified' });
    expect(raw).not.toContain('leaked');
    expect(setCookies(response)[0]).toContain('Max-Age=0');
    for (const cookie of setCookies(response)) {
      expect(cookie).not.toContain('__Host-mp_access');
      expect(cookie).not.toContain('__Host-mp_refresh');
    }
  });

  it('refuses without the cookie and does not call the API', async () => {
    const seen: Seen[] = [];
    const response = await handleRegisterVerify(request('register/verify', { otp: '123456' }), {
      env: ENV,
      fetch: api(200, { status: 'verified' }, seen),
    });

    expect(response.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('treats a cookie that is not a challenge identifier as no cookie at all', async () => {
    const seen: Seen[] = [];
    const response = await handleRegisterVerify(
      withChallenge('register/verify', { otp: '123456' }, 'not-a-uuid'),
      { env: ENV, fetch: api(200, { status: 'verified' }, seen) },
    );

    expect(response.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('clears the challenge on a refused code and keeps it on an outage', async () => {
    const refused = await handleRegisterVerify(withChallenge('register/verify', { otp: '000000' }), {
      env: ENV,
      fetch: api(401, PROBLEM),
    });
    expect(refused.status).toBe(401);
    expect(setCookies(refused)[0]).toContain('Max-Age=0');

    const unavailable = await handleRegisterVerify(withChallenge('register/verify', { otp: '123456' }), {
      env: ENV,
      fetch: api(503, { ...PROBLEM, status: 503, code: 'SERVICE_UNAVAILABLE' }),
    });
    expect(unavailable.status).toBe(503);
    expect(setCookies(unavailable)).toHaveLength(0);
  });
});
