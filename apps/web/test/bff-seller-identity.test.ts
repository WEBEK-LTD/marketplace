import { describe, expect, it } from 'vitest';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/server/bff/internal-credential';
import { handleSeller, handleSellerIdentity } from '../src/server/bff/sellers';
import { SESSION_COOKIES } from '../src/server/bff/session-cookies';

/**
 * The BFF half of the authenticated seller identity (Phase 6-A).
 *
 * What matters at this boundary:
 *
 *   * the session comes from the `__Host-mp_access` cookie and nowhere else, and it leaves as one header
 *     on one internal hop — the browser's `Cookie` header is never forwarded;
 *   * no token, credential or upstream address reaches a browser-visible body, and nothing is cached;
 *   * the API's own problem body is passed through with its own status and code, so "you have no
 *     storefront" is written once;
 *   * a drifted or unexpected upstream answer becomes a clean 503 rather than a half-built identity;
 *   * the upstream address is this module's, not something a request can choose;
 *   * `/api/sellers/[slug]` is untouched and still needs no session.
 */

const ENV = Object.freeze({
  API_BASE_URL: 'https://api.internal.test',
  PUBLIC_WEB_ORIGIN: 'https://web.test',
  INTERNAL_BFF_CREDENTIAL: 'test-current-credential-value-not-a-real-se',
});

const ACCESS_TOKEN = 'browser-access-token-value-not-a-real-token';
const REFRESH_TOKEN = 'browser-refresh-token-value-not-a-real-toke';
const COOKIE = `${SESSION_COOKIES.access.name}=${ACCESS_TOKEN}; ${SESSION_COOKIES.refresh.name}=${REFRESH_TOKEN}`;

const SELLER = {
  slug: 'good-shop',
  displayName: 'Good Shop',
  status: 'active',
  verificationStatus: 'verified',
  city: 'Cairo',
  countryCode: 'EG',
};

interface Seen {
  readonly url: string;
  readonly method: string | undefined;
  readonly headers: Headers;
}

function upstream(
  status: number,
  body: unknown,
  seen: Seen[],
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    seen.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers as HeadersInit),
    });
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(text, {
      status,
      headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
    });
  };
}

function request(url = 'https://web.test/api/sellers/me', cookie: string | null = COOKIE): Request {
  return new Request(url, { headers: cookie === null ? {} : { cookie } });
}

const problem = (status: number, code: string) => ({
  type: 'about:blank',
  title: status === 404 ? 'Not Found' : 'Refused',
  status,
  detail: 'A sentence the API owns.',
  instance: '/v1/sellers/me',
  code,
});

describe('the session', () => {
  it('refuses with 401 when there is no access cookie, without calling the API', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerIdentity(request('https://web.test/api/sellers/me', null), {
      env: ENV,
      fetch: upstream(200, { seller: SELLER }, seen),
    });

    expect(response.status).toBe(401);
    expect(((await response.json()) as { code: string }).code).toBe('AUTHENTICATION_REQUIRED');
    expect(seen).toHaveLength(0);
  });

  it('refuses when only a refresh cookie is present: this route reads the access cookie', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerIdentity(
      request('https://web.test/api/sellers/me', `${SESSION_COOKIES.refresh.name}=${REFRESH_TOKEN}`),
      { env: ENV, fetch: upstream(200, { seller: SELLER }, seen) },
    );

    expect(response.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('sends the token as one header and never forwards the browser’s cookie', async () => {
    const seen: Seen[] = [];
    await handleSellerIdentity(request(), { env: ENV, fetch: upstream(200, { seller: SELLER }, seen) });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers.get('x-session-token')).toBe(ACCESS_TOKEN);
    expect(seen[0]?.headers.get('cookie')).toBeNull();
  });

  it('sends the internal credential', async () => {
    const seen: Seen[] = [];
    await handleSellerIdentity(request(), { env: ENV, fetch: upstream(200, { seller: SELLER }, seen) });

    expect(seen[0]?.headers.get(INTERNAL_CREDENTIAL_HEADER)).toBe(ENV.INTERNAL_BFF_CREDENTIAL);
  });

  it('prefers an explicit cookie header when the caller supplies one', async () => {
    const seen: Seen[] = [];
    await handleSellerIdentity(request('https://web.test/api/sellers/me', null), {
      env: ENV,
      fetch: upstream(200, { seller: SELLER }, seen),
      cookieHeader: COOKIE,
    });

    expect(seen[0]?.headers.get('x-session-token')).toBe(ACCESS_TOKEN);
  });
});

describe('the answer', () => {
  it('rebuilds the six approved fields and nothing else', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerIdentity(request(), {
      env: ENV,
      fetch: upstream(200, { seller: SELLER }, seen),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ seller: SELLER });
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('addresses the API and nothing a request could choose', async () => {
    const seen: Seen[] = [];
    await handleSellerIdentity(
      request('https://web.test/api/sellers/me?upstream=https://evil.test&slug=other-shop'),
      { env: ENV, fetch: upstream(200, { seller: SELLER }, seen) },
    );

    expect(seen[0]?.url).toBe('https://api.internal.test/v1/sellers/me');
    expect(seen[0]?.method).toBe('GET');
    expect(seen[0]?.url).not.toContain('evil.test');
    expect(seen[0]?.url).not.toContain('other-shop');
  });

  it('leaks no token, credential or upstream address', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerIdentity(request(), {
      env: ENV,
      fetch: upstream(200, { seller: SELLER }, seen),
    });
    const text = await response.text();

    for (const secret of [ACCESS_TOKEN, REFRESH_TOKEN, ENV.INTERNAL_BFF_CREDENTIAL, ENV.API_BASE_URL]) {
      expect(text, secret).not.toContain(secret);
    }
  });

  it('carries no identifier: the browser never receives the seller’s own uuid', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerIdentity(request(), {
      env: ENV,
      fetch: upstream(
        200,
        { seller: { ...SELLER, userId: '11111111-1111-4111-8111-111111111111' } },
        seen,
      ),
    });

    // A seventh field means the contract refused the body, so nothing half-built reaches the browser.
    expect(response.status).toBe(503);
  });

  it('passes every status through, because the owner may see their own account state', async () => {
    const seen: Seen[] = [];
    for (const [status, verificationStatus] of [
      ['pending', 'unverified'],
      ['active', 'verified'],
      ['suspended', 'verified'],
      ['closed', 'verified'],
    ] as const) {
      const response = await handleSellerIdentity(request(), {
        env: ENV,
        fetch: upstream(200, { seller: { ...SELLER, status, verificationStatus } }, seen),
      });
      expect(response.status, status).toBe(200);
      expect((await response.json()) as unknown).toEqual({
        seller: { ...SELLER, status, verificationStatus },
      });
    }
  });
});

describe('refusals and drift', () => {
  it('passes the API’s own problem body through with its status and code', async () => {
    const seen: Seen[] = [];
    for (const [status, code] of [
      [401, 'AUTHENTICATION_REQUIRED'],
      [403, 'BAD_REQUEST'],
      [404, 'NOT_FOUND'],
    ] as const) {
      const response = await handleSellerIdentity(request(), {
        env: ENV,
        fetch: upstream(status, problem(status, code), seen),
      });

      expect(response.status, code).toBe(status);
      expect(response.headers.get('content-type')).toBe('application/problem+json');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(((await response.json()) as { code: string }).code).toBe(code);
    }
  });

  it('turns an account that is not a seller into the API’s 404, not an empty seller', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerIdentity(request(), {
      env: ENV,
      fetch: upstream(404, problem(404, 'NOT_FOUND'), seen),
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(404);
    expect(body['seller']).toBeUndefined();
  });

  it('turns an unexpected upstream status into 503', async () => {
    const seen: Seen[] = [];
    for (const status of [201, 204, 301, 418, 429, 500, 503]) {
      const response = await handleSellerIdentity(request(), {
        env: ENV,
        fetch: upstream(status, { seller: SELLER }, seen),
      });
      expect(response.status, String(status)).toBe(503);
    }
  });

  it('turns a drifted success body into 503', async () => {
    const seen: Seen[] = [];
    for (const body of [
      'not json',
      {},
      { seller: {} },
      { seller: { ...SELLER, status: 'banned' } },
      { seller: { ...SELLER, verificationStatus: 'in_review' } },
      { seller: { ...SELLER, countryCode: 'EGY' } },
      { seller: { ...SELLER, slug: '' } },
      { seller: { ...SELLER, legalName: 'Good Shop Trading LLC' } },
      { seller: SELLER, extra: true },
    ]) {
      const response = await handleSellerIdentity(request(), {
        env: ENV,
        fetch: upstream(200, body, seen),
      });
      expect(response.status, JSON.stringify(body).slice(0, 60)).toBe(503);
    }
  });

  it('turns an unreachable API into 503', async () => {
    const response = await handleSellerIdentity(request(), {
      env: ENV,
      fetch: async () => {
        throw new Error('connection refused');
      },
    });

    expect(response.status).toBe(503);
    expect(((await response.json()) as { code: string }).code).toBe('SERVICE_UNAVAILABLE');
  });
});

describe('the public seller route is untouched', () => {
  it('still reads a seller by slug with no session at all', async () => {
    const seen: Seen[] = [];
    const response = await handleSeller(
      new Request('https://web.test/api/sellers/good-shop'),
      'good-shop',
      {
        env: ENV,
        fetch: upstream(200, { seller: { slug: 'good-shop', displayName: 'Good Shop', bio: null, contentLanguage: null, city: 'Cairo' }, availability: 'available' }, seen),
      },
    );

    expect(response.status).toBe(200);
    expect(seen[0]?.url).toBe('https://api.internal.test/v1/sellers/good-shop');
    // No session travels on the public read: 4-E's hop is unchanged.
    expect(seen[0]?.headers.get('x-session-token')).toBeNull();
  });

  it('and the two readers address two different upstream paths', async () => {
    const seen: Seen[] = [];
    await handleSellerIdentity(request(), { env: ENV, fetch: upstream(200, { seller: SELLER }, seen) });
    await handleSeller(new Request('https://web.test/api/sellers/me-shop'), 'me-shop', {
      env: ENV,
      fetch: upstream(404, problem(404, 'NOT_FOUND'), seen),
    });

    expect(seen.map((call) => call.url)).toEqual([
      'https://api.internal.test/v1/sellers/me',
      'https://api.internal.test/v1/sellers/me-shop',
    ]);
  });
});
