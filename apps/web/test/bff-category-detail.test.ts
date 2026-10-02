import { describe, expect, it } from 'vitest';
import { handleCategory, readCategory } from '../src/server/bff/categories';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/server/bff/internal-credential';

/**
 * The BFF half of the public category landing page (Phase 4-D).
 *
 * One credentialled internal call, and whatever comes back checked against the shared contract before a
 * page may render it. The assertion that matters most here is the last one: the document-head fields
 * reach the server component and never the browser.
 */

const ENV = {
  API_BASE_URL: 'https://api.test',
  PUBLIC_WEB_ORIGIN: 'https://web.test',
  INTERNAL_BFF_CREDENTIAL: 'test-current-credential-value-not-a-real-se',
} as const;

const CATEGORY = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'furniture',
  name: 'Furniture',
  description: 'Everything for the home.',
  parent: null,
  children: [{ id: '22222222-2222-4222-8222-222222222222', slug: 'seating', name: 'Seating' }],
};

const SEO = { metaTitle: 'Furniture | Marketplace', metaDescription: 'Browse furniture.' };
const BODY = { category: CATEGORY, seo: SEO };

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

describe('reading one category', () => {
  it('makes exactly one credentialled GET, with the slug encoded and the locale named', async () => {
    const seen: { value?: Seen } = {};
    await readCategory('furniture', 'ar', { env: ENV, fetch: apiReturns(200, BODY, seen) });
    expect(seen.value?.method).toBe('GET');
    expect(seen.value?.url).toBe('https://api.test/v1/categories/furniture?locale=ar');
    expect(seen.value?.credential).toBe(ENV.INTERNAL_BFF_CREDENTIAL);

    await readCategory('a category/../../admin', 'en', { env: ENV, fetch: apiReturns(404, {}, seen) });
    expect(seen.value?.url).toBe('https://api.test/v1/categories/a%20category%2F..%2F..%2Fadmin?locale=en');
  });

  it('normalises a locale it does not serve', async () => {
    const seen: { value?: Seen } = {};
    await readCategory('furniture', 'de', { env: ENV, fetch: apiReturns(200, BODY, seen) });
    expect(seen.value?.url).toBe('https://api.test/v1/categories/furniture?locale=en');
  });

  it('reports the three outcomes a page has to render', async () => {
    const found = await readCategory('furniture', 'en', { env: ENV, fetch: apiReturns(200, BODY) });
    expect(found).toMatchObject({ kind: 'found', category: { slug: 'furniture' }, seo: SEO });

    expect((await readCategory('nothing', 'en', { env: ENV, fetch: apiReturns(404, {}) })).kind).toBe('not_found');
    expect((await readCategory('furniture', 'en', { env: ENV, fetch: apiUnreachable() })).kind).toBe('unavailable');
    expect((await readCategory('furniture', 'en', { env: ENV, fetch: apiReturns(503, {}) })).kind).toBe('unavailable');
  });

  it('refuses a body that does not match the contract', async () => {
    for (const bad of [
      { category: { ...CATEGORY, listingCount: 4 }, seo: SEO },
      { category: { ...CATEGORY, isActive: true }, seo: SEO },
      { category: { ...CATEGORY, children: [{ id: 'x', slug: 's', name: 'S', children: [] }] }, seo: SEO },
      { category: CATEGORY },
      { category: {}, seo: SEO },
      'not json at all',
    ]) {
      const result = await readCategory('furniture', 'en', { env: ENV, fetch: apiReturns(200, bad) });
      expect(result.kind, JSON.stringify(bad).slice(0, 40)).toBe('unavailable');
    }
  });

  it('carries a category with no children and no description', async () => {
    const bare = { category: { ...CATEGORY, description: null, children: [] }, seo: SEO };
    const result = await readCategory('furniture', 'en', { env: ENV, fetch: apiReturns(200, bare) });
    expect(result).toMatchObject({ kind: 'found', category: { description: null, children: [] } });
  });
});

describe('GET /api/categories/:slug', () => {
  it('answers 200 with the category and never caches it', async () => {
    const response = await handleCategory(
      new Request('https://web.test/api/categories/furniture'),
      'furniture',
      { env: ENV, fetch: apiReturns(200, BODY) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ category: CATEGORY });
  });

  it('never sends the document-head fields to the browser', async () => {
    const response = await handleCategory(
      new Request('https://web.test/api/categories/furniture'),
      'furniture',
      { env: ENV, fetch: apiReturns(200, BODY) },
    );
    const body = await response.text();
    expect(body).not.toContain('metaTitle');
    expect(body).not.toContain('metaDescription');
    expect(body).not.toContain('Furniture | Marketplace');
  });

  it('answers 404 with nothing that says why', async () => {
    const response = await handleCategory(
      new Request('https://web.test/api/categories/retired'),
      'retired',
      { env: ENV, fetch: apiReturns(404, { detail: 'category is inactive' }) },
    );
    expect(response.status).toBe(404);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(body).not.toContain('inactive');
  });

  it('answers 503 when the API cannot be reached', async () => {
    const response = await handleCategory(
      new Request('https://web.test/api/categories/furniture'),
      'furniture',
      { env: ENV, fetch: apiUnreachable() },
    );
    expect(response.status).toBe(503);
  });

  it('passes the locale the browser asked for', async () => {
    const seen: { value?: Seen } = {};
    await handleCategory(
      new Request('https://web.test/api/categories/furniture?locale=ar'),
      'furniture',
      { env: ENV, fetch: apiReturns(200, BODY, seen) },
    );
    expect(seen.value?.url).toBe('https://api.test/v1/categories/furniture?locale=ar');
  });
});
