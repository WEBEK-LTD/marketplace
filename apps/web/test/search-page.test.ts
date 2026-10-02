import type { ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startBuiltApp, type RunningApp } from './support/next-server.js';
import { startStubApi, type StubApi } from './support/stub-api.js';

/**
 * The public search page, over real HTTP against the built app (Phase 4-F, V1).
 *
 * Three properties matter. That a search is a URL — a `GET` form, a cursor in the query string — so it
 * survives sharing and reloading. That a query too short to be worth running never reaches the API at
 * all. And that the page is `noindex, follow`: not an SEO landing page, but still crawled through to the
 * listings and services it names.
 *
 * No browser, no Playwright, no live provider, no deployment.
 */

const CANARY_CREDENTIAL = 'test-web-search-canary-credential-not-realx';

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
} as const;

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
} as const;

let api: StubApi;
let app: RunningApp;

beforeAll(async () => {
  api = await startStubApi();
  app = await startBuiltApp({ API_BASE_URL: api.baseUrl, INTERNAL_BFF_CREDENTIAL: CANARY_CREDENTIAL });
}, 120_000);

afterAll(async () => {
  await app.stop();
  await api.stop();
});

function json(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

/** The API as it behaves: "walnut" finds one of each kind and has another page; "nothing" finds none. */
function apiServesSearch(): void {
  api.reply((request, response) => {
    const [path, rawQuery = ''] = request.url.split('?');
    if (path !== '/v1/search') {
      response.writeHead(404, { 'content-type': 'application/problem+json' });
      response.end(JSON.stringify({ status: 404, code: 'NOT_FOUND' }));
      return;
    }
    const params = new URLSearchParams(rawQuery);
    const q = params.get('q') ?? '';
    if (q === 'nothing') return json(response, { items: [], nextCursor: null });
    if (params.get('cursor') !== null) return json(response, { items: [SERVICE], nextCursor: null });
    return json(response, { items: [LISTING, SERVICE], nextCursor: 'Y3Vyc29y' });
  });
}

beforeEach(() => {
  api.seen.length = 0;
  apiServesSearch();
});

interface Page {
  readonly status: number;
  readonly robotsHeader: string | null;
  readonly robotsMeta: string | null;
  readonly title: string | null;
  readonly html: string;
}

async function load(path: string): Promise<Page> {
  const response = await fetch(`${app.baseUrl}${path}`, { redirect: 'manual' });
  const html = await response.text();
  const pick = (re: RegExp): string | null => re.exec(html)?.[1] ?? null;
  return {
    status: response.status,
    robotsHeader: response.headers.get('x-robots-tag'),
    robotsMeta: pick(/<meta name="robots" content="([^"]*)"\/?>/),
    title: pick(/<title>([^<]*)<\/title>/),
    html,
  };
}

describe('the search page itself', () => {
  it('renders in both languages with a real search form', async () => {
    for (const [path, lang, label] of [
      ['/search', 'en', 'Search the marketplace'],
      ['/ar/search', 'ar', 'ابحث في السوق'],
    ] as const) {
      const page = await load(path);
      expect(page.status, path).toBe(200);
      expect(page.html, path).toContain(`<html lang="${lang}"`);
      expect(page.html, path).toContain('role="search"');
      expect(page.html, path).toContain('method="get"');
      expect(page.html, path).toContain('<label');
      expect(page.html, path).toContain(label);
    }
  });

  it('points the Arabic form at the Arabic route', async () => {
    const page = await load('/ar/search');
    expect(page.html).toContain('action="/ar/search"');
  });

  it('runs no search at all when nothing was asked', async () => {
    api.seen.length = 0;
    const page = await load('/search');
    expect(page.status).toBe(200);
    expect(api.seen).toHaveLength(0);
    expect(page.html).not.toContain('No results found.');
  });
});

describe('a query that is too short', () => {
  it('says so, in both languages, and never reaches the API', async () => {
    for (const [path, message] of [
      ['/search?q=a', 'Enter at least 2 characters to search.'],
      ['/ar/search?q=a', 'أدخل حرفين على الأقل للبحث.'],
    ] as const) {
      api.seen.length = 0;
      const page = await load(path);
      expect(page.status, path).toBe(200);
      expect(page.html, path).toContain(message);
      expect(api.seen, path).toHaveLength(0);
    }
  });

  it('treats a whitespace-only query as empty', async () => {
    api.seen.length = 0;
    const page = await load(`/search?q=${encodeURIComponent('   ')}`);
    expect(page.html).toContain('Enter at least 2 characters to search.');
    expect(api.seen).toHaveLength(0);
  });

  it('counts Unicode characters, so one emoji is too short and two are enough', async () => {
    api.seen.length = 0;
    await load(`/search?q=${encodeURIComponent('😀')}`);
    expect(api.seen).toHaveLength(0);

    api.seen.length = 0;
    await load(`/search?q=${encodeURIComponent('😀😀')}`);
    expect(api.seen).toHaveLength(1);
  });
});

describe('results', () => {
  it('renders a mixed result set with each card keeping its own fields', async () => {
    const page = await load('/search?q=walnut');
    expect(page.status).toBe(200);
    expect(page.html).toContain('Walnut dining table');
    expect(page.html).toContain('Walnut furniture restoration');
    // The service card's own fields, which a listing card does not have.
    expect(page.html).toContain('14 days');
    expect(page.html).toContain('Fixed price');
    // Each links to the surface that owns it.
    expect(page.html).toContain('href="/listing/walnut-table"');
    expect(page.html).toContain('href="/service/walnut-restoration"');
  });

  it('links results to the Arabic surfaces under /ar', async () => {
    const page = await load('/ar/search?q=walnut');
    expect(page.html).toContain('href="/ar/listing/walnut-table"');
    expect(page.html).toContain('href="/ar/service/walnut-restoration"');
  });

  it('trims the query before asking the API', async () => {
    api.seen.length = 0;
    await load(`/search?q=${encodeURIComponent('  walnut  ')}`);
    expect(api.seen[0]?.url).toContain('q=walnut&');
  });

  it('offers a next page as a link that carries the query and the cursor', async () => {
    const page = await load('/search?q=walnut');
    expect(page.html).toContain('rel="next"');
    expect(page.html).toContain('q=walnut&amp;cursor=Y3Vyc29y');
  });

  it('follows that cursor to the next page', async () => {
    const page = await load('/search?q=walnut&cursor=Y3Vyc29y');
    expect(page.status).toBe(200);
    expect(page.html).toContain('Walnut furniture restoration');
    expect(page.html).not.toContain('rel="next"');
  });

  it('says so when nothing matched', async () => {
    const page = await load('/search?q=nothing');
    expect(page.status).toBe(200);
    expect(page.html).toContain('No results found.');
    expect(page.html).toContain('role="status"');
  });

  it('says so in Arabic too', async () => {
    const page = await load('/ar/search?q=nothing');
    expect(page.html).toContain('لم يتم العثور على نتائج.');
  });
});

describe('when the search cannot run', () => {
  it('renders the error state rather than an empty result list', async () => {
    api.reply((_request, response) => {
      response.writeHead(503, { 'content-type': 'application/problem+json' });
      response.end(JSON.stringify({ status: 503, code: 'SERVICE_UNAVAILABLE' }));
    });
    const page = await load('/search?q=walnut');
    expect(page.status).toBe(200);
    expect(page.html).toContain("We couldn't complete the search.");
    expect(page.html).toContain('role="alert"');
    expect(page.html).not.toContain('No results found.');
  });

  it('says so in Arabic', async () => {
    api.reply((_request, response) => {
      response.writeHead(503, { 'content-type': 'application/problem+json' });
      response.end(JSON.stringify({ status: 503 }));
    });
    const page = await load('/ar/search?q=walnut');
    expect(page.html).toContain('تعذر إكمال البحث.');
  });
});

describe('search is not an SEO landing page', () => {
  it('is noindex, follow', async () => {
    for (const path of ['/search', '/search?q=walnut', '/ar/search?q=walnut']) {
      const page = await load(path);
      expect(page.robotsMeta, path).toBe('noindex, follow');
    }
  });

  it('keeps the blanket header too, since it is not a public catalogue route', async () => {
    const page = await load('/search?q=walnut');
    expect(page.robotsHeader).toBe('noindex');
  });

  it('leaves the catalogue surfaces indexable', async () => {
    // The route-aware policy must not have been widened by adding search to it.
    api.reply((_request, response) => json(response, { categories: [] }));
    const categories = await load('/categories');
    expect(categories.robotsHeader).toBeNull();
  });
});

describe('the internal boundary', () => {
  it('reaches the API with the internal credential and no browser cookie', async () => {
    api.seen.length = 0;
    await load('/ar/search?q=walnut');
    const first = api.seen[0];
    expect(first?.url).toContain('/v1/search?q=walnut&locale=ar');
    expect(first?.credential).toBe(CANARY_CREDENTIAL);
    expect(first?.cookie).toBeNull();
  });

  it('never exposes the internal credential to the browser', async () => {
    const page = await load('/search?q=walnut');
    expect(page.html).not.toContain(CANARY_CREDENTIAL);
  });
});
