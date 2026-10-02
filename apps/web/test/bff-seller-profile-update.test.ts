import { describe, expect, it } from 'vitest';
import {
  handleSellerIdentity,
  handleSellerOnboarding,
  handleSellerProfileUpdate,
} from '../src/server/bff/sellers';
import { SESSION_COOKIES } from '../src/server/bff/session-cookies';

/**
 * `PATCH /api/sellers/me` at the BFF boundary (Phase 6-D).
 *
 * The properties this boundary owes the browser, and the two that are specific to an edit:
 *
 *   * the Origin check runs **first**, before the session cookie is read, so a cross-site edit is refused
 *     without this handler touching the caller's session;
 *   * the session leaves as one header on one internal hop and the browser's `Cookie` is never forwarded;
 *   * the strict update contract is applied here too, and the **validated** value is forwarded, so a `slug`,
 *     `userId` or `status` a client invented has no route through this handler at all;
 *   * **absent and null survive the round trip**: a key the schema left out is not forwarded, and a key
 *     whose value is `null` is — which is the whole of the partial-update contract, and the thing a
 *     re-serialisation is most likely to break;
 *   * success is **200 exactly** — an edit creates nothing, so a 201 from upstream is drift, not success;
 *   * 404 is a declared refusal rather than a service failure, because a caller with no storefront is not an
 *     outage.
 *
 * No browser, no live API, no provider: the upstream is a function.
 */

const ENV = Object.freeze({
  API_BASE_URL: 'https://api.internal.test',
  PUBLIC_WEB_ORIGIN: 'https://web.test',
  INTERNAL_BFF_CREDENTIAL: 'test-current-credential-value-not-a-real-se',
});

const ACCESS_TOKEN = 'browser-access-token-value-not-a-real-token';
const REFRESH_TOKEN = 'browser-refresh-token-value-not-a-real-toke';
const COOKIE = `${SESSION_COOKIES.access.name}=${ACCESS_TOKEN}; ${SESSION_COOKIES.refresh.name}=${REFRESH_TOKEN}`;
const USER_ID = '11111111-1111-4111-8111-111111111111';

const SELLER = {
  slug: 'good-shop',
  displayName: 'Renamed Shop',
  status: 'active',
  verificationStatus: 'verified',
  city: 'Cairo',
  countryCode: 'EG',
};

interface Seen {
  readonly url: string;
  readonly method: string | undefined;
  readonly headers: Headers;
  readonly body: string | undefined;
}

function upstream(
  status: number,
  payload: unknown,
  seen: Seen[],
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    seen.push({
      url: String(input),
      method: init?.method,
      headers: new Headers(init?.headers as HeadersInit),
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return new Response(text, {
      status,
      headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
    });
  };
}

function request(payload: unknown = { displayName: 'Renamed Shop' }, headers: Record<string, string> = {}): Request {
  return new Request('https://web.test/api/sellers/me', {
    method: 'PATCH',
    headers: {
      origin: 'https://web.test',
      cookie: COOKIE,
      'content-type': 'application/json',
      ...headers,
    },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}

const problem = (status: number, code: string) => ({
  type: 'about:blank',
  title: 'Refused',
  status,
  detail: 'A sentence the API owns.',
  instance: '/v1/sellers/me',
  code,
});

describe('the Origin check, and its order', () => {
  it('refuses an edit from another origin without calling the API', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerProfileUpdate(
      request({ displayName: 'Renamed Shop' }, { origin: 'https://evil.test' }),
      { env: ENV, fetch: upstream(200, { seller: SELLER }, seen) },
    );

    expect(response.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it('refuses an edit with no Origin and no same-origin fetch metadata', async () => {
    const seen: Seen[] = [];
    const bare = new Request('https://web.test/api/sellers/me', {
      method: 'PATCH',
      headers: { cookie: COOKIE, 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Renamed Shop' }),
    });
    const response = await handleSellerProfileUpdate(bare, {
      env: ENV,
      fetch: upstream(200, { seller: SELLER }, seen),
    });

    expect(response.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it('accepts one with no Origin when the browser says the fetch is same-origin', async () => {
    const seen: Seen[] = [];
    const metadata = new Request('https://web.test/api/sellers/me', {
      method: 'PATCH',
      headers: { cookie: COOKIE, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ displayName: 'Renamed Shop' }),
    });
    const response = await handleSellerProfileUpdate(metadata, {
      env: ENV,
      fetch: upstream(200, { seller: SELLER }, seen),
    });

    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
  });

  it('refuses a cross-origin edit that carries no session either, as a 403 rather than a 401', async () => {
    // The order is the assertion: the Origin check answered, so no cookie was ever read.
    const seen: Seen[] = [];
    const noCookie = new Request('https://web.test/api/sellers/me', {
      method: 'PATCH',
      headers: { origin: 'https://evil.test', 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Renamed Shop' }),
    });
    const response = await handleSellerProfileUpdate(noCookie, {
      env: ENV,
      fetch: upstream(200, { seller: SELLER }, seen),
    });

    expect(response.status).toBe(403);
    expect(seen).toHaveLength(0);
  });
});

describe('the session', () => {
  it('refuses a same-origin edit with no access cookie, without calling the API', async () => {
    const seen: Seen[] = [];
    const noCookie = new Request('https://web.test/api/sellers/me', {
      method: 'PATCH',
      headers: { origin: 'https://web.test', 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Renamed Shop' }),
    });
    const response = await handleSellerProfileUpdate(noCookie, {
      env: ENV,
      fetch: upstream(200, { seller: SELLER }, seen),
    });

    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe('AUTHENTICATION_REQUIRED');
    expect(seen).toHaveLength(0);
  });

  it('refuses a request carrying only the refresh cookie', async () => {
    const seen: Seen[] = [];
    const refreshOnly = new Request('https://web.test/api/sellers/me', {
      method: 'PATCH',
      headers: {
        origin: 'https://web.test',
        cookie: `${SESSION_COOKIES.refresh.name}=${REFRESH_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ displayName: 'Renamed Shop' }),
    });
    const response = await handleSellerProfileUpdate(refreshOnly, { env: ENV, fetch: upstream(200, {}, seen) });

    expect(response.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('presents the access token upstream with the internal credential, and forwards no cookie', async () => {
    const seen: Seen[] = [];
    await handleSellerProfileUpdate(request(), { env: ENV, fetch: upstream(200, { seller: SELLER }, seen) });

    expect(seen[0]?.headers.get('x-session-token')).toBe(ACCESS_TOKEN);
    expect(seen[0]?.headers.get('x-internal-credential')).toBe(ENV.INTERNAL_BFF_CREDENTIAL);
    expect(seen[0]?.headers.get('cookie')).toBeNull();
    expect(seen[0]?.body).not.toContain(ACCESS_TOKEN);
    expect(seen[0]?.body).not.toContain(REFRESH_TOKEN);
  });

  it('patches the one fixed upstream address', async () => {
    const seen: Seen[] = [];
    await handleSellerProfileUpdate(request(), { env: ENV, fetch: upstream(200, { seller: SELLER }, seen) });

    expect(seen[0]?.url).toBe('https://api.internal.test/v1/sellers/me');
    expect(seen[0]?.method).toBe('PATCH');
  });

  it('cannot be pointed at another upstream by a header in the request', async () => {
    const seen: Seen[] = [];
    await handleSellerProfileUpdate(
      request({ displayName: 'Renamed Shop' }, { 'x-api-base-url': 'https://evil.test' }),
      { env: ENV, fetch: upstream(200, { seller: SELLER }, seen) },
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('https://api.internal.test/v1/sellers/me');
  });

  it('refuses a request whose forwarded host disagrees with its Origin', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerProfileUpdate(
      request({ displayName: 'Renamed Shop' }, { 'x-forwarded-host': 'evil.test' }),
      { env: ENV, fetch: upstream(200, { seller: SELLER }, seen) },
    );

    expect(response.status).toBe(403);
    expect(seen).toHaveLength(0);
  });
});

describe('the strict request contract', () => {
  it.each([
    ['userId', USER_ID],
    ['slug', 'a-different-address'],
    ['status', 'active'],
    ['verificationStatus', 'verified'],
    ['suspensionReason', 'none'],
    ['verifiedAt', '2026-01-01T00:00:00.000Z'],
    ['updatedAt', '2026-01-01T00:00:00.000Z'],
    ['logoObjectPath', 'logos/mine.webp'],
    ['role', 'seller'],
  ])('refuses an injected %s here, before the API is called at all', async (field, value) => {
    const seen: Seen[] = [];
    const response = await handleSellerProfileUpdate(request({ displayName: 'Renamed Shop', [field]: value }), {
      env: ENV,
      fetch: upstream(200, { seller: SELLER }, seen),
    });

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('VALIDATION_FAILED');
    expect(seen).toHaveLength(0);
  });

  it('forwards the validated body, not the text the browser sent', async () => {
    const seen: Seen[] = [];
    await handleSellerProfileUpdate(request({ displayName: '  Renamed Shop  ' }), {
      env: ENV,
      fetch: upstream(200, { seller: SELLER }, seen),
    });

    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({ displayName: 'Renamed Shop' });
  });

  it('keeps an explicit null and drops an absent key, which is the partial-update contract', async () => {
    const seen: Seen[] = [];
    await handleSellerProfileUpdate(request({ legalName: null, city: 'Alexandria' }), {
      env: ENV,
      fetch: upstream(200, { seller: SELLER }, seen),
    });

    const forwarded = JSON.parse(seen[0]?.body ?? '{}');
    expect(Object.hasOwn(forwarded, 'legalName')).toBe(true);
    expect(forwarded.legalName).toBeNull();
    expect(forwarded.city).toBe('Alexandria');
    // Everything the browser did not mention is absent upstream too, not sent as null.
    for (const absent of ['displayName', 'bio', 'contentLanguage', 'countryCode', 'governorate', 'contactEmail', 'contactPhone']) {
      expect(Object.hasOwn(forwarded, absent), absent).toBe(false);
    }
  });

  it('forwards an empty edit as an empty body', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerProfileUpdate(request({}), {
      env: ENV,
      fetch: upstream(200, { seller: SELLER }, seen),
    });

    expect(response.status).toBe(200);
    expect(seen[0]?.body).toBe('{}');
  });

  it('refuses an unparsable body and an empty one', async () => {
    const seen: Seen[] = [];
    const options = { env: ENV, fetch: upstream(200, { seller: SELLER }, seen) };

    expect((await handleSellerProfileUpdate(request('{not json'), options)).status).toBe(400);
    expect((await handleSellerProfileUpdate(request(''), options)).status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it('refuses a value the shared limits reject without a round trip', async () => {
    const seen: Seen[] = [];
    const options = { env: ENV, fetch: upstream(200, { seller: SELLER }, seen) };

    expect((await handleSellerProfileUpdate(request({ displayName: 'A' }), options)).status).toBe(400);
    expect((await handleSellerProfileUpdate(request({ contactPhone: '0201' }), options)).status).toBe(400);
    expect((await handleSellerProfileUpdate(request({ displayName: null }), options)).status).toBe(400);
    expect(seen).toHaveLength(0);
  });
});

describe('the response', () => {
  it('answers 200 with the storefront rebuilt from the validated contract', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerProfileUpdate(request(), {
      env: ENV,
      fetch: upstream(200, { seller: SELLER }, seen),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ seller: SELLER });
  });

  it('turns a drifted success body into a clean failure rather than rendering it', async () => {
    const seen: Seen[] = [];
    for (const drifted of [
      { seller: { ...SELLER, userId: USER_ID } },
      { seller: { ...SELLER, status: 'brand-new' } },
      { seller: { slug: 'good-shop' } },
      { sellers: [SELLER] },
      'not json at all',
    ]) {
      const response = await handleSellerProfileUpdate(request(), {
        env: ENV,
        fetch: upstream(200, drifted, seen),
      });
      expect(response.status, JSON.stringify(drifted)).toBe(503);
    }
  });

  it('refuses a 201 where the contract says 200: an edit creates nothing', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerProfileUpdate(request(), {
      env: ENV,
      fetch: upstream(201, { seller: SELLER }, seen),
    });

    expect(response.status).toBe(503);
  });

  it.each([
    [400, 'VALIDATION_FAILED'],
    [401, 'AUTHENTICATION_REQUIRED'],
    [403, 'BAD_REQUEST'],
    [404, 'NOT_FOUND'],
    [409, 'SELLER_PROFILE_NOT_EDITABLE'],
    [429, 'THROTTLED'],
  ])('passes an upstream %i through with the API own code %s', async (status, code) => {
    const seen: Seen[] = [];
    const response = await handleSellerProfileUpdate(request(), {
      env: ENV,
      fetch: upstream(status, problem(status, code), seen),
    });

    expect(response.status).toBe(status);
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    expect((await response.json()).code).toBe(code);
  });

  it.each([418, 500, 502, 503])('turns an undeclared upstream %i into a 503', async (status) => {
    const seen: Seen[] = [];
    const response = await handleSellerProfileUpdate(request(), {
      env: ENV,
      fetch: upstream(status, problem(status, 'INTERNAL_ERROR'), seen),
    });

    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe('SERVICE_UNAVAILABLE');
  });

  it('answers 503 when the API cannot be reached at all', async () => {
    const response = await handleSellerProfileUpdate(request(), {
      env: ENV,
      fetch: async () => {
        throw new Error('connection refused');
      },
    });

    expect(response.status).toBe(503);
  });

  it('never puts a token, a credential or the upstream address in a response', async () => {
    const seen: Seen[] = [];
    for (const [status, payload] of [
      [200, { seller: SELLER }],
      [409, problem(409, 'SELLER_PROFILE_NOT_EDITABLE')],
      [500, problem(500, 'INTERNAL_ERROR')],
    ] as const) {
      const response = await handleSellerProfileUpdate(request(), {
        env: ENV,
        fetch: upstream(status, payload, seen),
      });
      const text = await response.text();
      expect(text).not.toContain(ACCESS_TOKEN);
      expect(text).not.toContain(REFRESH_TOKEN);
      expect(text).not.toContain(ENV.INTERNAL_BFF_CREDENTIAL);
      expect(text).not.toContain('api.internal.test');
      expect(text).not.toContain(USER_ID);
    }
  });
});

describe('the 6-A read and the 6-C creation are untouched', () => {
  it('a GET still answers with the identity projection and is not subject to the Origin check', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerIdentity(
      new Request('https://web.test/api/sellers/me', {
        headers: { cookie: COOKIE, origin: 'https://evil.test' },
      }),
      { env: ENV, fetch: upstream(200, { seller: SELLER }, seen) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ seller: SELLER });
  });

  it('a POST still creates, answering 201', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerOnboarding(
      new Request('https://web.test/api/sellers/me', {
        method: 'POST',
        headers: { origin: 'https://web.test', cookie: COOKIE, 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'good-shop', displayName: 'Good Shop', countryCode: 'EG' }),
      }),
      { env: ENV, fetch: upstream(201, { seller: SELLER }, seen) },
    );

    expect(response.status).toBe(201);
    expect(seen[0]?.method).toBe('POST');
  });
});
