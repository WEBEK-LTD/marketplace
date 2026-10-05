import { describe, expect, it } from 'vitest';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/server/bff/internal-credential';
import { handleSearch, readSearch } from '../src/server/bff/search';

/**
 * The BFF half of public search (Phase 4-F, V1).
 *
 * A mixed union is the shape most likely to fail quietly, so the refusal tests carry the weight here: a
 * result whose `type` does not match its fields must become a clean failure rather than a half-drawn card.
 */

const ENV = {
  API_BASE_URL: 'https://api.test',
  PUBLIC_WEB_ORIGIN: 'https://web.test',
  INTERNAL_BFF_CREDENTIAL: 'test-current-credential-value-not-a-real-se',
} as const;

const LISTING = {
  type: 'listing',
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'walnut-table',
  title: 'Walnut dining table',
  city: 'Cairo',
  priceMinor: '250000',
  currencyCode: 'EGP',
  currencyMinorUnit: 2,
  isNegotiable: false,
  listingTypeCode: 'product',
};

const SERVICE = {
  type: 'service',
  id: '22222222-2222-4222-8222-222222222222',
  slug: 'walnut-restoration',
  title: 'Walnut furniture restoration',
  city: 'Cairo',
  priceMinor: '150000',
  currencyCode: 'EGP',
  currencyMinorUnit: 2,
  pricingModel: 'fixed',
  deliveryDays: 14,
  revisionsIncluded: 1,
};

const PAGE = { items: [LISTING, SERVICE], nextCursor: 'Y3Vyc29y' };

interface Seen {
  url: string;
  credential: string | null;
  method: string;
}

function apiReturns(status: number, body: unknown, seen: { value?: Seen } = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const sent = new Headers(init?.headers);
    seen.value = {
      url: String(input),
      credential: sent.get(INTERNAL_CREDENTIAL_HEADER),
      method: init?.method ?? 'GET',
    };
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': status === 200 ? 'application/json' : 'application/problem+json' },
    });
  }) as unknown as typeof fetch;
}

function apiUnreachable(): typeof fetch {
  return (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
}

describe('running a search', () => {
  it('makes exactly one credentialled GET, with the query and locale encoded', async () => {
    const seen: { value?: Seen } = {};
    await readSearch({ q: 'walnut table', locale: 'ar' }, { env: ENV, fetch: apiReturns(200, PAGE, seen) });
    expect(seen.value?.method).toBe('GET');
    expect(seen.value?.url).toBe('https://api.test/v1/search?q=walnut+table&locale=ar');
    expect(seen.value?.credential).toBe(ENV.INTERNAL_BFF_CREDENTIAL);
  });

  it('normalises a locale it does not serve', async () => {
    const seen: { value?: Seen } = {};
    await readSearch({ q: 'walnut', locale: 'de' }, { env: ENV, fetch: apiReturns(200, PAGE, seen) });
    expect(seen.value?.url).toBe('https://api.test/v1/search?q=walnut&locale=en');
  });

  it('passes a cursor and a limit through, and omits them when absent', async () => {
    const seen: { value?: Seen } = {};
    await readSearch(
      { q: 'walnut', locale: 'en', cursor: 'abc', limit: '10' },
      { env: ENV, fetch: apiReturns(200, PAGE, seen) },
    );
    expect(seen.value?.url).toBe('https://api.test/v1/search?q=walnut&locale=en&cursor=abc&limit=10');

    await readSearch({ q: 'walnut', cursor: null, limit: '' }, { env: ENV, fetch: apiReturns(200, PAGE, seen) });
    expect(seen.value?.url).toBe('https://api.test/v1/search?q=walnut&locale=en');
  });

  it('reports the three outcomes a page has to render', async () => {
    const ok = await readSearch({ q: 'walnut' }, { env: ENV, fetch: apiReturns(200, PAGE) });
    expect(ok).toMatchObject({ kind: 'ok' });

    expect((await readSearch({ q: 'a' }, { env: ENV, fetch: apiReturns(400, {}) })).kind).toBe('invalid');
    expect((await readSearch({ q: 'walnut' }, { env: ENV, fetch: apiReturns(503, {}) })).kind).toBe('unavailable');
    expect((await readSearch({ q: 'walnut' }, { env: ENV, fetch: apiUnreachable() })).kind).toBe('unavailable');
  });

  it('refuses a result whose type does not match its fields', async () => {
    for (const bad of [
      { items: [{ ...LISTING, pricingModel: 'fixed' }], nextCursor: null },
      { items: [{ ...SERVICE, isNegotiable: false }], nextCursor: null },
      { items: [{ ...LISTING, type: 'seller' }], nextCursor: null },
      { items: [{ ...LISTING, rank: 0.4 }], nextCursor: null },
      { items: [{ ...LISTING, description: 'A table.' }], nextCursor: null },
      { items: {}, nextCursor: null },
      'not json at all',
    ]) {
      const result = await readSearch({ q: 'walnut' }, { env: ENV, fetch: apiReturns(200, bad) });
      expect(result.kind, JSON.stringify(bad).slice(0, 44)).toBe('unavailable');
    }
  });

  it('refuses a page where only one result is malformed', async () => {
    const mixed = { items: [LISTING, { ...SERVICE, type: 'category' }], nextCursor: null };
    expect((await readSearch({ q: 'walnut' }, { env: ENV, fetch: apiReturns(200, mixed) })).kind).toBe('unavailable');
  });
});

describe('GET /api/search', () => {
  it('answers 200 with the page and never caches it', async () => {
    const response = await handleSearch(new Request('https://web.test/api/search?q=walnut'), {
      env: ENV,
      fetch: apiReturns(200, PAGE),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(PAGE);
  });

  it('forwards the browser query to the API', async () => {
    const seen: { value?: Seen } = {};
    await handleSearch(new Request('https://web.test/api/search?q=walnut&limit=50&cursor=xyz&locale=ar'), {
      env: ENV,
      fetch: apiReturns(200, PAGE, seen),
    });
    expect(seen.value?.url).toBe('https://api.test/v1/search?q=walnut&locale=ar&cursor=xyz&limit=50');
  });

  it('answers 400 when the API refuses the query', async () => {
    const response = await handleSearch(new Request('https://web.test/api/search?q=a'), {
      env: ENV,
      fetch: apiReturns(400, {}),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
  });

  it('answers 503 rather than passing an upstream failure through', async () => {
    const response = await handleSearch(new Request('https://web.test/api/search?q=walnut'), {
      env: ENV,
      fetch: apiReturns(500, { detail: 'relation "listings" does not exist' }),
    });
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ status: 503, code: 'SERVICE_UNAVAILABLE' });
    expect(body).not.toContain('relation');
  });

  it('never lets a private field reach the browser', async () => {
    const leaky = {
      items: [{ ...LISTING, sellerUserId: '33333333-3333-4333-8333-333333333333' }],
      nextCursor: null,
    };
    const response = await handleSearch(new Request('https://web.test/api/search?q=walnut'), {
      env: ENV,
      fetch: apiReturns(200, leaky),
    });
    const body = await response.text();
    expect(response.status).toBe(503);
    expect(body).not.toContain('33333333-3333-4333-8333-333333333333');
  });
});
