import { describe, expect, it } from 'vitest';
import { readCategoryFeed } from '../src/server/bff/categories';
import { handleSearch } from '../src/server/bff/search';

/**
 * The category feed BFF, and the filters search now shares with it (Phase 8-D).
 *
 * What matters at this boundary:
 *
 *   * the filters are forwarded as the **validated document rebuilt**, never as whatever arrived, so a
 *     parameter this contract does not define cannot cross this origin;
 *   * a repeated dimension survives the round trip as the repeated parameter it is;
 *   * responses are validated against the contract, so a drifted body is a clean failure rather than a
 *     half-rendered panel — and a field the contract does not name causes a refusal rather than a strip;
 *   * an absence, a malformed request and an outage are three different answers, because the page says
 *     something different about each;
 *   * nothing is cached, and no cookie is ever forwarded: this surface is the same for everybody.
 *
 * Everything is stubbed at the `fetch` boundary: no API, no database, no network.
 */

const ENV = {
  API_BASE_URL: 'https://api.internal.test',
  INTERNAL_BFF_CREDENTIAL: 'test-web-feed-bff-canary-not-real-abcdefghi',
} as const;

const LISTING = {
  type: 'listing',
  id: '44444444-4444-4444-8444-444444444444',
  slug: 'oak-table',
  title: 'Oak dining table',
  city: 'Cairo',
  priceMinor: '250000',
  currencyCode: 'EGP',
  currencyMinorUnit: 2,
  isNegotiable: false,
  listingTypeCode: 'product',
} as const;

const FACET = {
  kind: 'tag',
  key: null,
  label: null,
  dataType: null,
  unit: null,
  values: [{ value: 'handmade', label: 'Handmade', matchCount: 2 }],
  rangeMin: null,
  rangeMax: null,
  minorUnit: null,
} as const;

const PAGE = { items: [LISTING], nextCursor: null, facets: [FACET] };

interface Seen {
  url: string;
  method: string;
  cookie: string | null;
  credential: string | null;
}

function apiReturns(status: number, body: unknown, seen: { value?: Seen } = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const sent = new Headers(init?.headers);
    seen.value = {
      url: String(input),
      method: init?.method ?? 'GET',
      cookie: sent.get('cookie'),
      credential: sent.get('x-internal-bff-credential'),
    };
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': status < 400 ? 'application/json' : 'application/problem+json' },
    });
  }) as unknown as typeof fetch;
}

function apiUnreachable(): typeof fetch {
  return (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
}

describe('reading one category’s feed', () => {
  it('asks for the category’s own listings, in the locale it was given', async () => {
    const seen: { value?: Seen } = {};
    await readCategoryFeed(
      'furniture',
      { locale: 'ar', filters: {} },
      { env: ENV, fetch: apiReturns(200, PAGE, seen) },
    );
    expect(seen.value?.url).toContain('https://api.internal.test/v1/categories/furniture/listings?');
    expect(seen.value?.url).toContain('locale=ar');
    expect(seen.value?.method).toBe('GET');
    expect(seen.value?.cookie).toBeNull();
  });

  it('returns the page and the panel', async () => {
    const result = await readCategoryFeed(
      'furniture',
      { locale: 'en', filters: {} },
      { env: ENV, fetch: apiReturns(200, PAGE) },
    );
    expect(result.kind).toBe('found');
    if (result.kind === 'found') {
      expect(result.items[0]?.slug).toBe('oak-table');
      expect(result.facets[0]?.values[0]?.value).toBe('handmade');
      expect(result.nextCursor).toBeNull();
    }
  });

  it('percent-encodes a slug rather than pasting it into a URL', async () => {
    const seen: { value?: Seen } = {};
    await readCategoryFeed(
      'a slug/with things',
      { locale: 'en', filters: {} },
      { env: ENV, fetch: apiReturns(200, PAGE, seen) },
    );
    expect(seen.value?.url).toContain('a%20slug%2Fwith%20things');
  });

  it('forwards every filter as the repeated parameter it is', async () => {
    const seen: { value?: Seen } = {};
    await readCategoryFeed(
      'furniture',
      {
        locale: 'en',
        filters: {
          listingType: 'product',
          tags: ['handmade', 'vintage'],
          attributes: [
            { key: 'material', options: ['oak', 'pine'] },
            { key: 'boxed', boolean: true },
            { key: 'width', min: 120, max: 200 },
          ],
          price: { currency: 'EGP', min: '1000', max: '500000' },
        },
      },
      { env: ENV, fetch: apiReturns(200, PAGE, seen) },
    );
    const url = seen.value?.url ?? '';
    expect(url).toContain('type=product');
    expect(url).toContain('tag=handmade');
    expect(url).toContain('tag=vintage');
    expect(url).toContain('attr.material=oak');
    expect(url).toContain('attr.material=pine');
    expect(url).toContain('attr.boxed=true');
    expect(url).toContain('attr.width.min=120');
    expect(url).toContain('attr.width.max=200');
    expect(url).toContain('price.currency=EGP');
    expect(url).toContain('price.min=1000');
    expect(url).toContain('price.max=500000');
  });

  it('forwards the cursor and the page size when it has them, and nothing when it does not', async () => {
    const withBoth: { value?: Seen } = {};
    await readCategoryFeed(
      'furniture',
      { locale: 'en', filters: {}, cursor: 'CURSOR', limit: 10 },
      { env: ENV, fetch: apiReturns(200, PAGE, withBoth) },
    );
    expect(withBoth.value?.url).toContain('cursor=CURSOR');
    expect(withBoth.value?.url).toContain('limit=10');

    const without: { value?: Seen } = {};
    await readCategoryFeed(
      'furniture',
      { locale: 'en', filters: {}, cursor: null },
      { env: ENV, fetch: apiReturns(200, PAGE, without) },
    );
    expect(without.value?.url).not.toContain('cursor=');
    expect(without.value?.url).not.toContain('limit=');
  });

  it('reports an absence, a malformed request and an outage as three different answers', async () => {
    const cases = [
      { status: 404, kind: 'not_found' },
      { status: 400, kind: 'invalid' },
      { status: 503, kind: 'unavailable' },
      { status: 500, kind: 'unavailable' },
    ] as const;
    for (const scenario of cases) {
      const result = await readCategoryFeed(
        'furniture',
        { locale: 'en', filters: {} },
        { env: ENV, fetch: apiReturns(scenario.status, { status: scenario.status, code: 'X' }) },
      );
      expect(result.kind, String(scenario.status)).toBe(scenario.kind);
    }
  });

  it('is an outage when the API cannot be reached', async () => {
    const result = await readCategoryFeed(
      'furniture',
      { locale: 'en', filters: {} },
      { env: ENV, fetch: apiUnreachable() },
    );
    expect(result.kind).toBe('unavailable');
  });

  it('refuses a body the contract does not recognise rather than rendering part of it', async () => {
    const drifted = [
      { items: [{ ...LISTING, type: 'vehicle' }], nextCursor: null, facets: [] },
      { items: [LISTING], nextCursor: null, facets: [{ ...FACET, kind: 'distance' }] },
      // A field the contract does not name: refused whole, never stripped and forwarded.
      { items: [LISTING], nextCursor: null, facets: [{ ...FACET, definitionId: 'leaked' }] },
      { items: [LISTING], facets: [] },
    ];
    for (const body of drifted) {
      const result = await readCategoryFeed(
        'furniture',
        { locale: 'en', filters: {} },
        { env: ENV, fetch: apiReturns(200, body) },
      );
      expect(result.kind, JSON.stringify(body).slice(0, 60)).toBe('unavailable');
    }
  });

  it('treats an empty page as a state rather than a failure', async () => {
    const result = await readCategoryFeed(
      'furniture',
      { locale: 'en', filters: {} },
      { env: ENV, fetch: apiReturns(200, { items: [], nextCursor: null, facets: [] }) },
    );
    expect(result.kind).toBe('found');
    if (result.kind === 'found') {
      expect(result.items).toEqual([]);
      expect(result.facets).toEqual([]);
    }
  });
});

describe('the search route handler takes the same filters', () => {
  const searchRequest = (query: string): Request => new Request(`https://web.test/api/search?${query}`);

  it('forwards the validated filters upstream', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleSearch(searchRequest('q=table&tag=handmade&attr.material=oak'), {
      env: ENV,
      fetch: apiReturns(200, { items: [LISTING], nextCursor: null }, seen),
    });
    expect(response.status).toBe(200);
    expect(seen.value?.url).toContain('tag=handmade');
    expect(seen.value?.url).toContain('attr.material=oak');
  });

  it('refuses a malformed filter without an upstream hop', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleSearch(searchRequest('q=table&type=vehicle'), {
      env: ENV,
      fetch: apiReturns(200, { items: [], nextCursor: null }, seen),
    });
    expect(response.status).toBe(400);
    expect(seen.value).toBeUndefined();
  });

  it('never forwards a parameter this contract does not define', async () => {
    const seen: { value?: Seen } = {};
    await handleSearch(searchRequest('q=table&sort=price&utm_source=newsletter'), {
      env: ENV,
      fetch: apiReturns(200, { items: [], nextCursor: null }, seen),
    });
    expect(seen.value?.url).not.toContain('sort=');
    expect(seen.value?.url).not.toContain('utm_source');
  });

  it('caches nothing, because a filtered page is as fresh as an unfiltered one', async () => {
    const response = await handleSearch(searchRequest('q=table&tag=handmade'), {
      env: ENV,
      fetch: apiReturns(200, { items: [LISTING], nextCursor: null }),
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
