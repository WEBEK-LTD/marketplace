import { describe, expect, it } from 'vitest';
import {
  handleContactPhoneStart,
  handleContactPhoneVerify,
} from '../src/server/bff/contact-change';
import {
  CONTACT_CHALLENGE_COOKIE,
  clearedContactChallengeCookie,
  contactChallengeCookie,
  readContactChallengeCookie,
} from '../src/server/bff/contact-challenge-cookie';

/**
 * The BFF half of the F4 phone contact change.
 *
 * What matters at this boundary: the session token comes from the `__Host-mp_access` cookie and never
 * from the browser's body; the challenge identifier travels the same way, in its own `HttpOnly` cookie,
 * so the browser is never told which challenge it is answering and cannot choose one; the responses are
 * rebuilt rather than forwarded; and the session cookies themselves are never touched, because a contact
 * change is not a session event.
 */

const ENV = Object.freeze({
  API_BASE_URL: 'https://api.internal.test',
  PUBLIC_WEB_ORIGIN: 'https://web.test',
  INTERNAL_BFF_CREDENTIAL: 'test-current-credential-value-not-a-real-se',
});

const SESSION_TOKEN = 'session-token-canary-value-not-a-real-token';
const CHALLENGE = '22222222-2222-4222-8222-222222222222';
const PHONE = '+201555000111';

interface Seen {
  readonly url: string;
  readonly headers: Headers;
  readonly body: string;
}

function post(step: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://web.test/api/auth/contact/phone/${step}`, {
    method: 'POST',
    headers: {
      origin: 'https://web.test',
      'content-type': 'application/json',
      cookie: `__Host-mp_access=${SESSION_TOKEN}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
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

const START_ENVELOPE = { status: 'ok', challenge: { id: CHALLENGE } };

function setCookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

/** A verify request that carries the challenge cookie the start step would have set. */
function verifyRequest(body: unknown, extraCookies = ''): Request {
  return new Request('https://web.test/api/auth/contact/phone/verify', {
    method: 'POST',
    headers: {
      origin: 'https://web.test',
      'content-type': 'application/json',
      cookie: `__Host-mp_access=${SESSION_TOKEN}; ${CONTACT_CHALLENGE_COOKIE.name}=${CHALLENGE}${extraCookies}`,
    },
    body: JSON.stringify(body),
  });
}

describe('the challenge cookie', () => {
  it('uses the approved name and attributes, and carries only an identifier', () => {
    expect(CONTACT_CHALLENGE_COOKIE.name).toBe('__Host-mp_contact_phone_challenge');
    expect(CONTACT_CHALLENGE_COOKIE.maxAgeSeconds).toBe(900);

    const cookie = contactChallengeCookie(CHALLENGE);
    expect(cookie.startsWith(`__Host-mp_contact_phone_challenge=${CHALLENGE};`)).toBe(true);
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Max-Age=900');
    expect(cookie).not.toContain('Domain');
    // An identifier, never a code or a number.
    expect(cookie).not.toMatch(/\+\d|[^0-9a-f-]{0}\b\d{6}\b/);
  });

  it('clears with the same attributes', () => {
    const cleared = clearedContactChallengeCookie();
    expect(cleared).toContain('Max-Age=0');
    expect(cleared).toContain('HttpOnly');
    expect(cleared).toContain('Secure');
    expect(cleared).toContain('SameSite=Strict');
    expect(cleared).toContain('Path=/');
  });

  it('reads back only a value shaped like a challenge identifier', () => {
    expect(readContactChallengeCookie(`other=1; ${CONTACT_CHALLENGE_COOKIE.name}=${CHALLENGE}`)).toBe(CHALLENGE);
    expect(readContactChallengeCookie(`${CONTACT_CHALLENGE_COOKIE.name}=not-a-uuid`)).toBeNull();
    expect(readContactChallengeCookie('__Host-mp_access=session-token')).toBeNull();
    expect(readContactChallengeCookie(null)).toBeNull();
  });
});

describe('POST /api/auth/contact/phone/start', () => {
  it('sends the session from the cookie and the credential, and returns only the challenge id', async () => {
    const seen: Seen[] = [];
    const response = await handleContactPhoneStart(post('start', { phone: PHONE }), {
      env: ENV,
      fetch: api(200, START_ENVELOPE, seen),
    });

    expect(response.status).toBe(200);
    const body = await response.text();
    // The approved browser body, exactly.
    expect(JSON.parse(body)).toEqual({ status: 'ok' });
    expect(body).not.toContain(CHALLENGE);
    // The identifier leaves only as the approved cookie.
    expect(setCookies(response)).toEqual([contactChallengeCookie(CHALLENGE)]);
    expect(seen[0]?.url).toBe('https://api.internal.test/v1/users/me/contact/phone/start');
    expect(seen[0]?.headers.get('x-session-token')).toBe(SESSION_TOKEN);
    expect(seen[0]?.headers.get('x-internal-credential')).toBe(ENV.INTERNAL_BFF_CREDENTIAL);
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({ phone: PHONE });
    // The session cookies themselves are untouched: only the challenge cookie is set.
    expect(setCookies(response).every((cookie) => cookie.startsWith(CONTACT_CHALLENGE_COOKIE.name))).toBe(true);
  });

  it('forwards only the phone, never a field the browser added', async () => {
    const seen: Seen[] = [];
    await handleContactPhoneStart(
      post('start', { phone: PHONE, userId: '99999999-9999-4999-8999-999999999999', sessionToken: 'forged' }),
      { env: ENV, fetch: api(200, START_ENVELOPE, seen) },
    );

    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({ phone: PHONE });
    expect(seen[0]?.body).not.toContain('99999999');
    expect(seen[0]?.body).not.toContain('forged');
    expect(seen[0]?.headers.get('x-session-token')).toBe(SESSION_TOKEN);
  });

  it('refuses with 401 when there is no session cookie, without calling the API', async () => {
    const seen: Seen[] = [];
    const request = new Request('https://web.test/api/auth/contact/phone/start', {
      method: 'POST',
      headers: { origin: 'https://web.test', 'content-type': 'application/json' },
      body: JSON.stringify({ phone: PHONE }),
    });
    const response = await handleContactPhoneStart(request, { env: ENV, fetch: api(200, START_ENVELOPE, seen) });

    expect(response.status).toBe(401);
    expect(((await response.json()) as Record<string, unknown>)['code']).toBe('AUTHENTICATION_REQUIRED');
    expect(seen).toHaveLength(0);
  });

  it('ignores a reset cookie and any other cookie that is not the session', async () => {
    const seen: Seen[] = [];
    const request = new Request('https://web.test/api/auth/contact/phone/start', {
      method: 'POST',
      headers: {
        origin: 'https://web.test',
        'content-type': 'application/json',
        cookie: '__Host-mp_reset=a-reset-token; other=1',
      },
      body: JSON.stringify({ phone: PHONE }),
    });
    const response = await handleContactPhoneStart(request, { env: ENV, fetch: api(200, START_ENVELOPE, seen) });

    expect(response.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('refuses a cross-site post before the API is called', async () => {
    const seen: Seen[] = [];
    const response = await handleContactPhoneStart(post('start', { phone: PHONE }, { origin: 'https://evil.test' }), {
      env: ENV,
      fetch: api(200, START_ENVELOPE, seen),
    });

    expect(response.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it('passes an API problem through and answers 503 when the API cannot be reached', async () => {
    const problem = {
      type: 'about:blank',
      title: 'Too Many Requests',
      status: 429,
      detail: 'Too many requests.',
      instance: '/v1/users/me/contact/phone/start',
      code: 'THROTTLED',
    };
    const throttled = await handleContactPhoneStart(post('start', { phone: PHONE }), {
      env: ENV,
      fetch: api(429, problem),
    });
    expect(throttled.status).toBe(429);
    expect(await throttled.json()).toEqual(problem);

    const down = await handleContactPhoneStart(post('start', { phone: PHONE }), {
      env: ENV,
      fetch: (() => Promise.reject(new Error('connect ECONNREFUSED'))) as unknown as typeof fetch,
    });
    expect(down.status).toBe(503);
  });

  it('answers 503 rather than a challenge when the envelope is not the expected shape', async () => {
    const response = await handleContactPhoneStart(post('start', { phone: PHONE }), {
      env: ENV,
      fetch: api(200, { status: 'ok' }),
    });

    expect(response.status).toBe(503);
  });

  it('never echoes the session token, the credential or the challenge to the browser', async () => {
    const response = await handleContactPhoneStart(post('start', { phone: PHONE }), {
      env: ENV,
      fetch: api(200, { ...START_ENVELOPE, echo: SESSION_TOKEN }),
    });

    const body = await response.text();
    expect(body).not.toContain(SESSION_TOKEN);
    expect(body).not.toContain(ENV.INTERNAL_BFF_CREDENTIAL);
    expect(body).not.toContain(CHALLENGE);
  });
});

describe('POST /api/auth/contact/phone/verify', () => {
  it('takes the challenge from the cookie, sends it with the code, and clears the cookie on success', async () => {
    const seen: Seen[] = [];
    const response = await handleContactPhoneVerify(verifyRequest({ otp: '123456' }), {
      env: ENV,
      fetch: api(200, { status: 'ok', anything: 'else' }, seen),
    });

    expect(response.status).toBe(200);
    // Rebuilt, not forwarded: the extra field the API sent does not reach the browser.
    expect(await response.json()).toEqual({ status: 'ok' });
    expect(seen[0]?.url).toBe('https://api.internal.test/v1/users/me/contact/phone/verify');
    // The API receives the challenge from this boundary alone.
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({ challengeId: CHALLENGE, otp: '123456' });
    expect(seen[0]?.headers.get('x-session-token')).toBe(SESSION_TOKEN);
    // Spent: the challenge cookie is cleared, and no session cookie is touched.
    expect(setCookies(response)).toEqual([clearedContactChallengeCookie()]);
  });

  it('ignores a challenge the browser tried to choose', async () => {
    const seen: Seen[] = [];
    await handleContactPhoneVerify(
      verifyRequest({ otp: '123456', challengeId: '99999999-9999-4999-8999-999999999999' }),
      { env: ENV, fetch: api(200, { status: 'ok' }, seen) },
    );

    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({ challengeId: CHALLENGE, otp: '123456' });
    expect(seen[0]?.body).not.toContain('99999999');
  });

  it('refuses with the generic 401 when there is no challenge cookie, without calling the API', async () => {
    const seen: Seen[] = [];
    const response = await handleContactPhoneVerify(post('verify', { otp: '123456' }), {
      env: ENV,
      fetch: api(200, { status: 'ok' }, seen),
    });

    expect(response.status).toBe(401);
    expect(((await response.json()) as Record<string, unknown>)['code']).toBe('AUTHENTICATION_FAILED');
    expect(seen).toHaveLength(0);
    expect(setCookies(response)).toEqual([clearedContactChallengeCookie()]);
  });

  it('ignores a challenge cookie that is not a challenge identifier', async () => {
    const seen: Seen[] = [];
    const request = new Request('https://web.test/api/auth/contact/phone/verify', {
      method: 'POST',
      headers: {
        origin: 'https://web.test',
        'content-type': 'application/json',
        cookie: `__Host-mp_access=${SESSION_TOKEN}; ${CONTACT_CHALLENGE_COOKIE.name}=not-a-challenge`,
      },
      body: JSON.stringify({ otp: '123456' }),
    });
    const response = await handleContactPhoneVerify(request, { env: ENV, fetch: api(200, { status: 'ok' }, seen) });

    expect(response.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('passes a refused code through as the generic problem, and clears the challenge cookie', async () => {
    const problem = {
      type: 'about:blank',
      title: 'Unauthorized',
      status: 401,
      detail: 'Authentication failed.',
      instance: '/v1/users/me/contact/phone/verify',
      code: 'AUTHENTICATION_FAILED',
    };
    const response = await handleContactPhoneVerify(verifyRequest({ otp: '000000' }), {
      env: ENV,
      fetch: api(401, problem),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(problem);
    // Invalid, expired, spent or exhausted — the API answers all of them the same way, so the challenge
    // ends here and the cookie goes with it.
    expect(setCookies(response)).toEqual([clearedContactChallengeCookie()]);
  });

  it('keeps the challenge cookie when the failure is worth retrying', async () => {
    const throttled = await handleContactPhoneVerify(verifyRequest({ otp: '123456' }), {
      env: ENV,
      fetch: api(429, { type: 'about:blank', title: 'Too Many Requests', status: 429, detail: 'Too many requests.', instance: '/x', code: 'THROTTLED' }),
    });
    expect(throttled.status).toBe(429);
    expect(setCookies(throttled)).toHaveLength(0);

    const down = await handleContactPhoneVerify(verifyRequest({ otp: '123456' }), {
      env: ENV,
      fetch: (() => Promise.reject(new Error('down'))) as unknown as typeof fetch,
    });
    expect(down.status).toBe(503);
    expect(setCookies(down)).toHaveLength(0);
  });

  it('refuses without a session and refuses cross-site, in both cases before the API', async () => {
    const seen: Seen[] = [];
    const noSession = new Request('https://web.test/api/auth/contact/phone/verify', {
      method: 'POST',
      headers: {
        origin: 'https://web.test',
        'content-type': 'application/json',
        cookie: `${CONTACT_CHALLENGE_COOKIE.name}=${CHALLENGE}`,
      },
      body: JSON.stringify({ otp: '123456' }),
    });
    expect((await handleContactPhoneVerify(noSession, { env: ENV, fetch: api(200, { status: 'ok' }, seen) })).status).toBe(401);

    const crossSite = new Request('https://web.test/api/auth/contact/phone/verify', {
      method: 'POST',
      headers: {
        origin: 'https://evil.test',
        'content-type': 'application/json',
        cookie: `__Host-mp_access=${SESSION_TOKEN}; ${CONTACT_CHALLENGE_COOKIE.name}=${CHALLENGE}`,
      },
      body: JSON.stringify({ otp: '123456' }),
    });
    expect((await handleContactPhoneVerify(crossSite, { env: ENV, fetch: api(200, { status: 'ok' }, seen) })).status).toBe(403);
    expect(seen).toHaveLength(0);
  });
});
