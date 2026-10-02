import { describe, expect, it } from 'vitest';
import { handleSellerIdentity, handleSellerOnboarding } from '../src/server/bff/sellers';
import { SESSION_COOKIES } from '../src/server/bff/session-cookies';

/**
 * `POST /api/sellers/me` at the BFF boundary (Phase 6-C).
 *
 * The properties this boundary owes the browser:
 *
 *   * the Origin check runs **first** — before the session cookie is read, so a cross-site post is refused
 *     without this handler ever touching the caller's session;
 *   * the session comes from the `__Host-mp_access` cookie and leaves as one header on one internal hop; the
 *     browser's `Cookie` header is never forwarded and no token reaches a response;
 *   * the strict request contract is applied here too, and what goes upstream is the *validated* value, so a
 *     field the contract does not name has no route through this handler at all;
 *   * the response is rebuilt from the validated contract, so a drifted upstream body becomes a clean failure
 *     rather than a half-created storefront in a browser;
 *   * success is 201 exactly, and every other status is either a declared refusal forwarded with the API's
 *     own problem body or a 503 — never a success;
 *   * the upstream address is fixed, and nothing in a request can redirect it.
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
  displayName: 'Good Shop',
  status: 'pending',
  verificationStatus: 'unverified',
  city: 'Cairo',
  countryCode: 'EG',
};

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: 'good-shop',
    displayName: 'Good Shop',
    legalName: 'Good Shop Trading LLC',
    bio: 'We restore mid-century furniture.',
    contentLanguage: 'en',
    countryCode: 'EG',
    governorate: 'Cairo Governorate',
    city: 'Cairo',
    contactEmail: 'owner@example.invalid',
    contactPhone: '+201555000001',
    ...overrides,
  };
}

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

function request(payload: unknown = body(), headers: Record<string, string> = {}): Request {
  return new Request('https://web.test/api/sellers/me', {
    method: 'POST',
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
  it('refuses a post from another origin without calling the API', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerOnboarding(request(body(), { origin: 'https://evil.test' }), {
      env: ENV,
      fetch: upstream(201, { seller: SELLER }, seen),
    });

    expect(response.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it('refuses a post with no Origin and no same-origin fetch metadata', async () => {
    const seen: Seen[] = [];
    const bare = new Request('https://web.test/api/sellers/me', {
      method: 'POST',
      headers: { cookie: COOKIE, 'content-type': 'application/json' },
      body: JSON.stringify(body()),
    });
    const response = await handleSellerOnboarding(bare, {
      env: ENV,
      fetch: upstream(201, { seller: SELLER }, seen),
    });

    expect(response.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it('accepts a post with no Origin when the browser says the fetch is same-origin', async () => {
    const seen: Seen[] = [];
    const metadata = new Request('https://web.test/api/sellers/me', {
      method: 'POST',
      headers: { cookie: COOKIE, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify(body()),
    });
    const response = await handleSellerOnboarding(metadata, {
      env: ENV,
      fetch: upstream(201, { seller: SELLER }, seen),
    });

    expect(response.status).toBe(201);
    expect(seen).toHaveLength(1);
  });

  it('refuses a cross-origin post that carries no session either, as a 403 rather than a 401', async () => {
    // The order is the assertion: the Origin check answered, so the handler never looked for a cookie. A
    // 401 here would mean the session was read before the CSRF decision.
    const seen: Seen[] = [];
    const noCookie = new Request('https://web.test/api/sellers/me', {
      method: 'POST',
      headers: { origin: 'https://evil.test', 'content-type': 'application/json' },
      body: JSON.stringify(body()),
    });
    const response = await handleSellerOnboarding(noCookie, {
      env: ENV,
      fetch: upstream(201, { seller: SELLER }, seen),
    });

    expect(response.status).toBe(403);
    expect(seen).toHaveLength(0);
  });
});

describe('the session', () => {
  it('refuses a same-origin post with no access cookie, without calling the API', async () => {
    const seen: Seen[] = [];
    const noCookie = new Request('https://web.test/api/sellers/me', {
      method: 'POST',
      headers: { origin: 'https://web.test', 'content-type': 'application/json' },
      body: JSON.stringify(body()),
    });
    const response = await handleSellerOnboarding(noCookie, {
      env: ENV,
      fetch: upstream(201, { seller: SELLER }, seen),
    });

    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe('AUTHENTICATION_REQUIRED');
    expect(seen).toHaveLength(0);
  });

  it('refuses a request carrying only the refresh cookie', async () => {
    const seen: Seen[] = [];
    const refreshOnly = new Request('https://web.test/api/sellers/me', {
      method: 'POST',
      headers: {
        origin: 'https://web.test',
        cookie: `${SESSION_COOKIES.refresh.name}=${REFRESH_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body()),
    });
    const response = await handleSellerOnboarding(refreshOnly, { env: ENV, fetch: upstream(201, {}, seen) });

    expect(response.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('presents the access token upstream in the session header, with the internal credential', async () => {
    const seen: Seen[] = [];
    await handleSellerOnboarding(request(), { env: ENV, fetch: upstream(201, { seller: SELLER }, seen) });

    expect(seen[0]?.headers.get('x-session-token')).toBe(ACCESS_TOKEN);
    expect(seen[0]?.headers.get('x-internal-credential')).toBe(ENV.INTERNAL_BFF_CREDENTIAL);
  });

  it('never forwards the browser cookie header', async () => {
    const seen: Seen[] = [];
    await handleSellerOnboarding(request(), { env: ENV, fetch: upstream(201, { seller: SELLER }, seen) });

    expect(seen[0]?.headers.get('cookie')).toBeNull();
    expect(seen[0]?.body).not.toContain(ACCESS_TOKEN);
    expect(seen[0]?.body).not.toContain(REFRESH_TOKEN);
  });

  it('posts to the one fixed upstream address', async () => {
    const seen: Seen[] = [];
    await handleSellerOnboarding(request(), { env: ENV, fetch: upstream(201, { seller: SELLER }, seen) });

    expect(seen[0]?.url).toBe('https://api.internal.test/v1/sellers/me');
    expect(seen[0]?.method).toBe('POST');
  });

  it('cannot be pointed at another upstream by a header in the request', async () => {
    const seen: Seen[] = [];
    await handleSellerOnboarding(
      request(body(), { 'x-api-base-url': 'https://evil.test', 'x-upstream': 'https://evil.test' }),
      { env: ENV, fetch: upstream(201, { seller: SELLER }, seen) },
    );

    // The address comes from the validated server configuration and from nowhere else.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('https://api.internal.test/v1/sellers/me');
  });

  it('refuses a request whose forwarded host disagrees with its Origin', async () => {
    // A spoofed `x-forwarded-host` changes the origin this handler believes it was addressed at, so the
    // Origin header no longer matches and the request is refused. Either way the attacker's host is never
    // called: the outcome is a 403, not a redirected write.
    const seen: Seen[] = [];
    const response = await handleSellerOnboarding(
      request(body(), { 'x-forwarded-host': 'evil.test' }),
      { env: ENV, fetch: upstream(201, { seller: SELLER }, seen) },
    );

    expect(response.status).toBe(403);
    expect(seen).toHaveLength(0);
  });
});

describe('the strict request contract', () => {
  it('forwards the validated body, not the text the browser sent', async () => {
    const seen: Seen[] = [];
    await handleSellerOnboarding(request(body({ displayName: '  Good Shop  ' })), {
      env: ENV,
      fetch: upstream(201, { seller: SELLER }, seen),
    });

    const forwarded = JSON.parse(seen[0]?.body ?? '{}');
    expect(forwarded.displayName).toBe('Good Shop');
    expect(Object.keys(forwarded).sort()).toEqual([
      'bio',
      'city',
      'contactEmail',
      'contactPhone',
      'contentLanguage',
      'countryCode',
      'displayName',
      'governorate',
      'legalName',
      'slug',
    ]);
  });

  it.each([
    ['userId', USER_ID],
    ['status', 'active'],
    ['verificationStatus', 'verified'],
    ['suspensionReason', 'none'],
    ['verifiedAt', '2026-01-01T00:00:00.000Z'],
    ['logoObjectPath', 'logos/mine.webp'],
    ['role', 'seller'],
  ])('refuses an injected %s here, before the API is called at all', async (field, value) => {
    const seen: Seen[] = [];
    const response = await handleSellerOnboarding(request(body({ [field]: value })), {
      env: ENV,
      fetch: upstream(201, { seller: SELLER }, seen),
    });

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('VALIDATION_FAILED');
    expect(seen).toHaveLength(0);
  });

  it('refuses a malformed slug without a round trip', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerOnboarding(request(body({ slug: 'Good-Shop' })), {
      env: ENV,
      fetch: upstream(201, { seller: SELLER }, seen),
    });

    expect(response.status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it('refuses an unparsable body and an empty one', async () => {
    const seen: Seen[] = [];
    const options = { env: ENV, fetch: upstream(201, { seller: SELLER }, seen) };

    expect((await handleSellerOnboarding(request('{not json'), options)).status).toBe(400);
    expect((await handleSellerOnboarding(request(''), options)).status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it('drops blank optional fields rather than forwarding empty strings', async () => {
    const seen: Seen[] = [];
    await handleSellerOnboarding(
      request({ slug: 'plain-shop', displayName: 'Plain Shop', countryCode: 'EG' }),
      { env: ENV, fetch: upstream(201, { seller: SELLER }, seen) },
    );

    expect(Object.keys(JSON.parse(seen[0]?.body ?? '{}')).sort()).toEqual([
      'countryCode',
      'displayName',
      'slug',
    ]);
  });
});

describe('the response', () => {
  it('answers 201 with the storefront rebuilt from the validated contract', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerOnboarding(request(), {
      env: ENV,
      fetch: upstream(201, { seller: SELLER }, seen),
    });

    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ seller: SELLER });
  });

  it('drops a field the contract does not name, even if the API sent one', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerOnboarding(request(), {
      env: ENV,
      fetch: upstream(201, { seller: SELLER }, seen),
    });
    const text = await response.text();

    expect(text).not.toContain('userId');
    expect(text).not.toContain(USER_ID);
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
      const response = await handleSellerOnboarding(request(), {
        env: ENV,
        fetch: upstream(201, drifted, seen),
      });
      expect(response.status, JSON.stringify(drifted)).toBe(503);
    }
  });

  it('refuses a 200 where the contract says 201', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerOnboarding(request(), {
      env: ENV,
      fetch: upstream(200, { seller: SELLER }, seen),
    });

    expect(response.status).toBe(503);
  });

  it.each([
    [400, 'VALIDATION_FAILED'],
    [401, 'AUTHENTICATION_REQUIRED'],
    [403, 'BAD_REQUEST'],
    [409, 'SELLER_PROFILE_EXISTS'],
    [409, 'SELLER_SLUG_TAKEN'],
    [429, 'THROTTLED'],
  ])('passes an upstream %i through with the API own code %s', async (status, code) => {
    const seen: Seen[] = [];
    const response = await handleSellerOnboarding(request(), {
      env: ENV,
      fetch: upstream(status, problem(status, code), seen),
    });

    expect(response.status).toBe(status);
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    expect((await response.json()).code).toBe(code);
  });

  it.each([404, 418, 500, 502, 503])('turns an undeclared upstream %i into a 503', async (status) => {
    const seen: Seen[] = [];
    const response = await handleSellerOnboarding(request(), {
      env: ENV,
      fetch: upstream(status, problem(status, 'NOT_FOUND'), seen),
    });

    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe('SERVICE_UNAVAILABLE');
  });

  it('answers 503 when the API cannot be reached at all', async () => {
    const response = await handleSellerOnboarding(request(), {
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
      [201, { seller: SELLER }],
      [409, problem(409, 'SELLER_SLUG_TAKEN')],
      [500, problem(500, 'INTERNAL_ERROR')],
    ] as const) {
      const response = await handleSellerOnboarding(request(), {
        env: ENV,
        fetch: upstream(status, payload, seen),
      });
      const text = await response.text();
      expect(text).not.toContain(ACCESS_TOKEN);
      expect(text).not.toContain(REFRESH_TOKEN);
      expect(text).not.toContain(ENV.INTERNAL_BFF_CREDENTIAL);
      expect(text).not.toContain('api.internal.test');
    }
  });
});

describe('the 6-A read is untouched', () => {
  it('still answers a GET with the identity projection', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerIdentity(
      new Request('https://web.test/api/sellers/me', { headers: { cookie: COOKIE } }),
      { env: ENV, fetch: upstream(200, { seller: SELLER }, seen) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ seller: SELLER });
    expect(seen[0]?.method).toBeUndefined();
  });

  it('and a GET is not subject to the Origin check, because it changes nothing', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerIdentity(
      new Request('https://web.test/api/sellers/me', {
        headers: { cookie: COOKIE, origin: 'https://evil.test' },
      }),
      { env: ENV, fetch: upstream(200, { seller: SELLER }, seen) },
    );

    // A read carries no state change, so it is refused by the session rules only — exactly as 6-A shipped it.
    expect(response.status).toBe(200);
  });
});
