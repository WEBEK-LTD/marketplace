import { describe, expect, it } from 'vitest';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/server/bff/internal-credential';
import { handleListing, handleListings, readListing, readListings } from '../src/server/bff/listings';

/**
 * The BFF half of the public listings (Phase 4-B).
 *
 * The browser's request must leave this origin as exactly one credentialled internal call, and whatever
 * comes back must be checked against the shared contract before a page is allowed to render it. A body
 * that has drifted becomes a clean 503 here rather than a half-drawn listing in someone's browser.
 *
 * The three outcomes of a slug lookup — the listing, a redirect to its current slug, and nothing the
 * public may see — are the other half of the work: each has to reach the browser as its own status, and
 * the 404 has to look the same whatever the private reason behind it was.
 */

const ENV = {
  API_BASE_URL: 'https://api.test',
  PUBLIC_WEB_ORIGIN: 'https://web.test',
  INTERNAL_BFF_CREDENTIAL: 'test-current-credential-value-not-a-real-se',
} as const;

const SUMMARY = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'a-listing',
  title: 'A listing title',
  city: 'Cairo',
  priceMinor: '250000',
  currencyCode: 'EGP',
  currencyMinorUnit: 2,
  isNegotiable: false,
  listingTypeCode: 'product',
} as const;

const PAGE = { items: [SUMMARY], nextCursor: 'Y3Vyc29y' };

const DETAIL = {
  listing: {
    ...SUMMARY,
    description: 'A description long enough to be real.',
    contentLanguage: 'en',
    createdAt: '2026-01-01T12:00:00.000Z',
    availability: 'available',
    category: { slug: 'furniture', name: 'Furniture' },
    seller: { slug: 'good-shop', displayName: 'Good Shop' },
    attributes: [
      { key: 'width', label: 'Width', unit: 'cm', kind: 'number', text: '180', boolean: null, options: [] },
    ],
    tags: [{ slug: 'handmade', name: 'Handmade' }],
  },
};

interface Seen {
  url: string;
  credential: string | null;
  method: string;
  redirect: RequestRedirect | undefined;
}

function apiReturns(
  status: number,
  body: unknown,
  seen: { value?: Seen } = {},
  headers: Record<string, string> = {},
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const sent = new Headers(init?.headers);
    seen.value = {
      url: String(input),
      credential: sent.get(INTERNAL_CREDENTIAL_HEADER),
      method: init?.method ?? 'GET',
      redirect: init?.redirect,
    };
    return new Response(body === null ? null : typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: {
        'content-type': status === 200 ? 'application/json' : 'application/problem+json',
        ...headers,
      },
    });
  }) as unknown as typeof fetch;
}

function apiUnreachable(): typeof fetch {
  return (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
}

describe('reading a page of listings', () => {
  it('makes exactly one credentialled GET to the API', async () => {
    const seen: { value?: Seen } = {};
    await readListings({}, { env: ENV, fetch: apiReturns(200, PAGE, seen) });
    expect(seen.value?.method).toBe('GET');
    expect(seen.value?.url).toBe('https://api.test/v1/listings');
    expect(seen.value?.credential).toBe(ENV.INTERNAL_BFF_CREDENTIAL);
  });

  it('passes a limit and a cursor through, and omits them when absent', async () => {
    const seen: { value?: Seen } = {};
    await readListings({ limit: '10', cursor: 'abc' }, { env: ENV, fetch: apiReturns(200, PAGE, seen) });
    expect(seen.value?.url).toBe('https://api.test/v1/listings?limit=10&cursor=abc');

    await readListings({ limit: '', cursor: null }, { env: ENV, fetch: apiReturns(200, PAGE, seen) });
    expect(seen.value?.url).toBe('https://api.test/v1/listings');
  });

  it('refuses a body that does not match the contract', async () => {
    for (const bad of [
      { items: [{ ...SUMMARY, sellerUserId: '11111111-1111-4111-8111-111111111111' }], nextCursor: null },
      { items: [{ ...SUMMARY, priceMinor: 2500 }], nextCursor: null },
      { items: [{ ...SUMMARY, viewCount: 9 }], nextCursor: null },
      { items: {}, nextCursor: null },
      'not json at all',
    ]) {
      expect(await readListings({}, { env: ENV, fetch: apiReturns(200, bad) })).toBeNull();
    }
  });

  it('returns nothing when the API refuses or cannot be reached', async () => {
    expect(await readListings({}, { env: ENV, fetch: apiReturns(503, {}) })).toBeNull();
    expect(await readListings({}, { env: ENV, fetch: apiUnreachable() })).toBeNull();
  });
});

describe('GET /api/listings', () => {
  it('answers 200 with the page and never caches it', async () => {
    const response = await handleListings(new Request('https://web.test/api/listings'), {
      env: ENV,
      fetch: apiReturns(200, PAGE),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(PAGE);
  });

  it('forwards the browser query to the API', async () => {
    const seen: { value?: Seen } = {};
    await handleListings(new Request('https://web.test/api/listings?limit=50&cursor=xyz'), {
      env: ENV,
      fetch: apiReturns(200, PAGE, seen),
    });
    expect(seen.value?.url).toBe('https://api.test/v1/listings?limit=50&cursor=xyz');
  });

  it('answers 503 rather than passing an upstream failure through', async () => {
    const response = await handleListings(new Request('https://web.test/api/listings'), {
      env: ENV,
      fetch: apiReturns(500, { detail: 'relation "listings" does not exist' }),
    });
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ status: 503, code: 'SERVICE_UNAVAILABLE' });
    expect(body).not.toContain('relation');
  });
});

describe('reading one listing', () => {
  it('asks for the slug and the locale, and does not follow the redirect itself', async () => {
    const seen: { value?: Seen } = {};
    await readListing('a-listing', 'ar', { env: ENV, fetch: apiReturns(200, DETAIL, seen) });
    expect(seen.value?.url).toBe('https://api.test/v1/listings/a-listing?locale=ar');
    expect(seen.value?.redirect).toBe('manual');
  });

  it('normalises a locale it does not serve', async () => {
    const seen: { value?: Seen } = {};
    await readListing('a-listing', 'de', { env: ENV, fetch: apiReturns(200, DETAIL, seen) });
    expect(seen.value?.url).toBe('https://api.test/v1/listings/a-listing?locale=en');
    await readListing('a-listing', undefined, { env: ENV, fetch: apiReturns(200, DETAIL, seen) });
    expect(seen.value?.url).toBe('https://api.test/v1/listings/a-listing?locale=en');
  });

  it('encodes a slug rather than pasting it into the path', async () => {
    const seen: { value?: Seen } = {};
    await readListing('a listing/../../admin', 'en', { env: ENV, fetch: apiReturns(404, {}, seen) });
    expect(seen.value?.url).toBe(
      'https://api.test/v1/listings/a%20listing%2F..%2F..%2Fadmin?locale=en',
    );
  });

  it('reports the four outcomes a page has to render', async () => {
    const found = await readListing('a-listing', 'en', { env: ENV, fetch: apiReturns(200, DETAIL) });
    expect(found.kind).toBe('found');

    const moved = await readListing('old-slug', 'en', {
      env: ENV,
      fetch: apiReturns(301, null, {}, { 'x-canonical-slug': 'a-listing', 'x-canonical-type': 'product' }),
    });
    expect(moved).toEqual({ kind: 'moved', canonicalSlug: 'a-listing', canonicalType: 'product' });

    const missing = await readListing('nothing', 'en', { env: ENV, fetch: apiReturns(404, {}) });
    expect(missing.kind).toBe('not_found');

    const down = await readListing('a-listing', 'en', { env: ENV, fetch: apiUnreachable() });
    expect(down.kind).toBe('unavailable');
  });

  it('treats a redirect with no canonical slug or an unknown surface as a failure, not a move', async () => {
    // Since Phase 4-C a redirect also has to say which surface owns the slug, because it may point off
    // this one. A redirect that does not say is not guessed at: the target would be a guess too.
    expect((await readListing('old-slug', 'en', { env: ENV, fetch: apiReturns(301, null) })).kind).toBe('unavailable');
    expect(
      (
        await readListing('old-slug', 'en', {
          env: ENV,
          fetch: apiReturns(301, null, {}, { 'x-canonical-slug': 'a-listing' }),
        })
      ).kind,
    ).toBe('unavailable');
    expect(
      (
        await readListing('old-slug', 'en', {
          env: ENV,
          fetch: apiReturns(301, null, {}, { 'x-canonical-slug': 'a-listing', 'x-canonical-type': 'nonsense' }),
        })
      ).kind,
    ).toBe('unavailable');
  });

  it('carries a redirect that points off the listing surface', async () => {
    const moved = await readListing('logo-design', 'en', {
      env: ENV,
      fetch: apiReturns(301, null, {}, { 'x-canonical-slug': 'logo-design', 'x-canonical-type': 'service' }),
    });
    expect(moved).toEqual({ kind: 'moved', canonicalSlug: 'logo-design', canonicalType: 'service' });
  });

  it('refuses a listing body that does not match the contract', async () => {
    for (const bad of [
      { listing: { ...DETAIL.listing, contactPhoneE164: '+201000000000' } },
      { listing: { ...DETAIL.listing, sellerUserId: '11111111-1111-4111-8111-111111111111' } },
      { listing: { ...DETAIL.listing, seller: { slug: 's', displayName: 'S', legalName: 'S LLC' } } },
      { listing: { ...DETAIL.listing, availability: 'pending' } },
      { listing: {} },
    ]) {
      const result = await readListing('a-listing', 'en', { env: ENV, fetch: apiReturns(200, bad) });
      expect(result.kind).toBe('unavailable');
    }
  });

  it('carries a listing that is no longer available, marker and all', async () => {
    const body = { listing: { ...DETAIL.listing, availability: 'no_longer_available' } };
    const result = await readListing('a-listing', 'en', { env: ENV, fetch: apiReturns(200, body) });
    expect(result).toMatchObject({ kind: 'found', listing: { availability: 'no_longer_available' } });
  });
});

describe('GET /api/listings/:slug', () => {
  it('answers 200 with the listing and never caches it', async () => {
    const response = await handleListing(
      new Request('https://web.test/api/listings/a-listing'),
      'a-listing',
      { env: ENV, fetch: apiReturns(200, DETAIL) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(DETAIL);
  });

  it('answers 301 to this origin, never to the API', async () => {
    const response = await handleListing(
      new Request('https://web.test/api/listings/old-slug'),
      'old-slug',
      {
        env: ENV,
        fetch: apiReturns(301, null, {}, { 'x-canonical-slug': 'a-listing', 'x-canonical-type': 'product' }),
      },
    );
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('/api/listings/a-listing');
  });

  it('answers 404 with nothing that says why', async () => {
    const response = await handleListing(
      new Request('https://web.test/api/listings/secret'),
      'secret',
      { env: ENV, fetch: apiReturns(404, { detail: 'listing is in draft for a suspended seller' }) },
    );
    expect(response.status).toBe(404);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(body).not.toContain('draft');
    expect(body).not.toContain('suspended');
  });

  it('answers 503 when the API cannot be reached', async () => {
    const response = await handleListing(
      new Request('https://web.test/api/listings/a-listing'),
      'a-listing',
      { env: ENV, fetch: apiUnreachable() },
    );
    expect(response.status).toBe(503);
  });

  it('passes the locale the browser asked for', async () => {
    const seen: { value?: Seen } = {};
    await handleListing(
      new Request('https://web.test/api/listings/a-listing?locale=ar'),
      'a-listing',
      { env: ENV, fetch: apiReturns(200, DETAIL, seen) },
    );
    expect(seen.value?.url).toBe('https://api.test/v1/listings/a-listing?locale=ar');
  });
});
