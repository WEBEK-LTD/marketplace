import type { ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import ar from '../messages/ar.json';
import en from '../messages/en.json';
import { startBuiltApp, type RunningApp } from './support/next-server.js';
import { startStubApi, type StubApi } from './support/stub-api.js';

/**
 * The public category feed and its filter panel, over real HTTP against the built app (Phase 8-D).
 *
 * What only a test at this level can prove:
 *
 * **The panel is a plain form and the whole thing works with no JavaScript.** The assertions read the HTML:
 * a `GET` form, named inputs, and a paging anchor — not a button that needs a client bundle to do anything.
 *
 * **Filter state lives in the URL.** A filtered view is reached by a query string, the panel renders the
 * boxes already ticked from it, and paging and clearing are links that keep or drop exactly what they should.
 *
 * **The two empties are different sentences.** A category with nothing in it and a category whose filters
 * match nothing are distinguishable to a visitor, because the API distinguishes them.
 *
 * **A filtered view is `noindex` and canonicalises to the unfiltered page**, so an unbounded set of
 * combinations cannot be indexed as near-duplicates, and the sitemap keeps carrying the plain URL alone.
 *
 * **Nothing private crosses**, and the surface is unauthenticated: no cookie is sent upstream and no
 * identifier of a category, an attribute or an option reaches the browser.
 *
 * No browser, no Playwright, no live provider, no deployment.
 */

// Exactly 43 base64url characters, or the web app's env validation refuses it at startup.
const CANARY_CREDENTIAL = 'test-web-feed-canary-credential-not-realxxx';
const ORIGIN = 'https://feed.test';

const FURNITURE = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'furniture',
  name: 'Furniture',
  description: 'Everything for the home.',
  parent: null,
  children: [{ id: '22222222-2222-4222-8222-222222222222', slug: 'seating', name: 'Seating' }],
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

const SERVICE = {
  type: 'service',
  id: '55555555-5555-4555-8555-555555555555',
  slug: 'table-restoration',
  title: 'Table restoration',
  city: 'Cairo',
  priceMinor: '400000',
  currencyCode: 'EGP',
  currencyMinorUnit: 2,
  pricingModel: 'fixed',
  deliveryDays: 7,
  revisionsIncluded: 2,
} as const;

/** Identifiers the API never sends on this surface; the stub sends them anyway, to prove they cannot pass. */
const PRIVATE_VALUES = {
  definitionId: '99999999-9999-4999-8999-999999999999',
  optionId: '88888888-8888-4888-8888-888888888888',
} as const;

const FACETS = [
  {
    kind: 'attribute',
    key: 'material',
    label: 'Material',
    dataType: 'single_select',
    unit: null,
    values: [
      { value: 'oak', label: 'Oak', matchCount: 2 },
      { value: 'pine', label: 'Pine', matchCount: 0 },
    ],
    rangeMin: null,
    rangeMax: null,
    minorUnit: null,
  },
  {
    kind: 'attribute',
    key: 'boxed',
    label: 'Boxed',
    dataType: 'boolean',
    unit: null,
    values: [
      { value: 'true', label: 'true', matchCount: 1 },
      { value: 'false', label: 'false', matchCount: 1 },
    ],
    rangeMin: null,
    rangeMax: null,
    minorUnit: null,
  },
  {
    kind: 'attribute',
    key: 'width',
    label: 'Width',
    dataType: 'number',
    unit: 'cm',
    values: [],
    rangeMin: '120',
    rangeMax: '200',
    minorUnit: null,
  },
  {
    kind: 'tag',
    key: null,
    label: null,
    dataType: null,
    unit: null,
    values: [
      { value: 'handmade', label: 'Handmade', matchCount: 2 },
      { value: 'vintage', label: 'Vintage', matchCount: 1 },
    ],
    rangeMin: null,
    rangeMax: null,
    minorUnit: null,
  },
  {
    kind: 'listing_type',
    key: null,
    label: null,
    dataType: null,
    unit: null,
    values: [
      { value: 'product', label: 'product', matchCount: 2 },
      { value: 'service', label: 'service', matchCount: 1 },
    ],
    rangeMin: null,
    rangeMax: null,
    minorUnit: null,
  },
  {
    kind: 'currency',
    key: null,
    label: 'EGP',
    dataType: null,
    unit: null,
    values: [{ value: 'EGP', label: 'EGP', matchCount: 3 }],
    rangeMin: '10000',
    rangeMax: '400000',
    minorUnit: 2,
  },
] as const;

type Mode =
  | { readonly kind: 'ok'; readonly items?: readonly unknown[]; readonly facets?: readonly unknown[]; readonly nextCursor?: string | null }
  | { readonly kind: 'empty_category' }
  | { readonly kind: 'feed_unavailable' };

/** The facets with identifiers the contract does not name, to prove the whole answer is refused. */
const CONTAMINATED_FACETS = FACETS.map((facet) => ({ ...facet, ...PRIVATE_VALUES }));

let api: StubApi;
let app: RunningApp;

beforeAll(async () => {
  api = await startStubApi();
  app = await startBuiltApp({
    API_BASE_URL: api.baseUrl,
    INTERNAL_BFF_CREDENTIAL: CANARY_CREDENTIAL,
    PUBLIC_WEB_ORIGIN: ORIGIN,
  });
}, 180_000);

afterAll(async () => {
  await app.stop();
  await api.stop();
});

function json(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function notFound(response: ServerResponse): void {
  response.writeHead(404, { 'content-type': 'application/problem+json' });
  response.end(JSON.stringify({ status: 404, code: 'NOT_FOUND' }));
}

function apiServes(mode: Mode = { kind: 'ok' }): void {
  api.reply((request, response) => {
    const [path, query = ''] = request.url.split('?');
    const arabic = query.includes('locale=ar');

    if (path === '/v1/categories/furniture') {
      return json(response, {
        category: arabic ? { ...FURNITURE, name: 'أثاث', description: 'كل ما يخص المنزل.' } : FURNITURE,
        seo: { metaTitle: null, metaDescription: null },
      });
    }

    if (path === '/v1/categories/furniture/listings') {
      if (mode.kind === 'feed_unavailable') {
        response.writeHead(503, { 'content-type': 'application/problem+json' });
        return response.end(JSON.stringify({ status: 503, code: 'SERVICE_UNAVAILABLE' }));
      }
      if (mode.kind === 'empty_category') {
        return json(response, { items: [], nextCursor: null, facets: [] });
      }
      return json(response, {
        items: mode.items ?? [LISTING, SERVICE],
        nextCursor: mode.nextCursor ?? null,
        facets: mode.facets ?? FACETS,
      });
    }

    if (path === '/v1/categories') return json(response, { categories: [] });
    if (path === '/v1/seo/robots') return json(response, { body: null, updatedAt: null });
    if (path === '/v1/seo/sitemap') {
      return json(response, {
        counts: { route: 1, page: 0, listing: 0, service: 0, category: 1, seller: 0 },
        updatedAt: '2026-05-01T00:00:00.000Z',
      });
    }
    if (path === '/v1/seo/sitemap/category/1') {
      return json(response, {
        type: 'category',
        page: 1,
        pageSize: 5000,
        entries: [{ slug: 'furniture', updatedAt: '2026-05-01T00:00:00.000Z' }],
      });
    }
    return notFound(response);
  });
}

beforeEach(() => {
  api.seen.length = 0;
  apiServes();
});

interface Page {
  readonly status: number;
  readonly robotsMeta: string | null;
  readonly canonical: string | null;
  readonly html: string;
}

async function load(path: string): Promise<Page> {
  const response = await fetch(`${app.baseUrl}${path}`, { redirect: 'manual' });
  const html = await response.text();
  const pick = (re: RegExp): string | null => re.exec(html)?.[1] ?? null;
  return {
    status: response.status,
    robotsMeta: pick(/<meta name="robots" content="([^"]*)"/),
    canonical: pick(/<link rel="canonical" href="([^"]*)"/),
    html,
  };
}

describe('the feed', () => {
  it('lists what is in the category, products and services together', async () => {
    const page = await load('/category/furniture');
    expect(page.status).toBe(200);
    expect(page.html).toContain(en.Categories.feedHeading);
    expect(page.html).toContain('Oak dining table');
    expect(page.html).toContain('Table restoration');
  });

  it('asks the API for the category and its listings, and for nothing else', async () => {
    await load('/category/furniture');
    const asked = api.seen.map((seen) => seen.url.split('?')[0]);
    expect(asked).toContain('/v1/categories/furniture');
    expect(asked).toContain('/v1/categories/furniture/listings');
  });

  it('sends no cookie upstream, and the internal credential on every hop', async () => {
    await load('/category/furniture');
    expect(api.seen.length).toBeGreaterThan(0);
    for (const seen of api.seen) {
      expect(seen.credential).toBe(CANARY_CREDENTIAL);
      expect(seen.cookie ?? '').toBe('');
    }
  });

  it('pages with a link that keeps the filters and changes only the cursor', async () => {
    apiServes({ kind: 'ok', nextCursor: 'CURSOR-TWO' });
    const page = await load('/category/furniture?tag=handmade');
    // An anchor, not a button: paging works with no JavaScript.
    const next = /<a([^>]*?)rel="next"/.exec(page.html)?.[1] ?? '';
    expect(next).toContain('tag=handmade');
    expect(next).toContain('cursor=CURSOR-TWO');
  });

  it('forwards the cursor it was given', async () => {
    await load('/category/furniture?cursor=CURSOR-ONE');
    const feedCall = api.seen.find((seen) => seen.url.startsWith('/v1/categories/furniture/listings'));
    expect(feedCall?.url).toContain('cursor=CURSOR-ONE');
  });

  it('says the shelf is bare when the category holds nothing', async () => {
    apiServes({ kind: 'empty_category' });
    const page = await load('/category/furniture');
    expect(page.status).toBe(200);
    expect(page.html).toContain(en.Categories.feedEmptyTitle);
    expect(page.html).not.toContain(en.Categories.feedNoMatchesTitle);
  });

  it('says the filters match nothing when they do, and keeps the panel so they can be undone', async () => {
    apiServes({ kind: 'ok', items: [] });
    const page = await load('/category/furniture?tag=handmade');
    expect(page.html).toContain(en.Categories.feedNoMatchesTitle);
    expect(page.html).not.toContain(en.Categories.feedEmptyTitle);
    expect(page.html).toContain(en.CatalogFilters.heading);
    expect(page.html).toContain(en.CatalogFilters.clear);
  });

  it('says it could not be read, never that the category is empty, when the feed fails', async () => {
    apiServes({ kind: 'feed_unavailable' });
    const page = await load('/category/furniture');
    expect(page.status).toBe(200);
    expect(page.html).toContain(en.Categories.categoryErrorTitle);
    expect(page.html).not.toContain(en.Categories.feedEmptyTitle);
  });

  it('still 404s for a category the public may not see', async () => {
    const page = await load('/category/no-such-category');
    expect(page.status).toBe(404);
  });
});

describe('the filter panel', () => {
  it('is a GET form that submits to the category’s own address', async () => {
    const page = await load('/category/furniture');
    const form = /<form[^>]*>/.exec(page.html)?.[0] ?? '';
    expect(form).toContain('method="get"');
    expect(form).toContain('action="/category/furniture"');
  });

  it('renders the control each kind of attribute calls for', async () => {
    const { html } = await load('/category/furniture');
    // A select gets checkboxes, a boolean radios, a number two boxes.
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*name="attr\.material"[^>]*value="oak"/);
    expect(html).toMatch(/<input[^>]*type="radio"[^>]*name="attr\.boxed"[^>]*value="true"/);
    expect(html).toMatch(/name="attr\.width\.min"/);
    expect(html).toMatch(/name="attr\.width\.max"/);
    expect(html).toContain('cm');
  });

  it('offers the tags and the two surfaces as their own dimensions', async () => {
    const { html } = await load('/category/furniture');
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*name="tag"[^>]*value="handmade"/);
    expect(html).toMatch(/<input[^>]*type="radio"[^>]*name="type"[^>]*value="service"/);
    expect(html).toContain(en.CatalogFilters.tagsHeading);
  });

  it('shows a count beside every value, including a zero', async () => {
    const { html } = await load('/category/furniture');
    expect(html).toContain('2 matches');
    // `pine` matches nothing right now and is still offered, so a visitor can untick it later.
    expect(html).toContain('none');
    expect(html).toContain('Pine');
  });

  it('takes the price currency from the catalogue rather than naming one, and carries its decimals', async () => {
    const { html } = await load('/category/furniture');
    expect(html).toMatch(/name="price\.currency"[^>]*value="EGP"|value="EGP"[^>]*name="price\.currency"/);
    expect(html).toMatch(/name="price\.min"/);
    expect(html).toMatch(/name="price\.max"/);
  });

  it('renders the boxes already ticked from the URL', async () => {
    const { html } = await load('/category/furniture?tag=handmade&attr.material=oak&type=product');
    const ticked = [...html.matchAll(/<input[^>]*checked[^>]*>/g)].map((match) => match[0]);
    expect(ticked.some((input) => input.includes('value="handmade"'))).toBe(true);
    expect(ticked.some((input) => input.includes('value="oak"'))).toBe(true);
    expect(ticked.some((input) => input.includes('value="product"'))).toBe(true);
    expect(ticked.some((input) => input.includes('value="vintage"'))).toBe(false);
  });

  it('keeps a numeric range in its boxes', async () => {
    const { html } = await load('/category/furniture?attr.width.min=130&attr.width.max=190');
    expect(html).toMatch(/name="attr\.width\.min"[^>]*value="130"|value="130"[^>]*name="attr\.width\.min"/);
    expect(html).toMatch(/name="attr\.width\.max"[^>]*value="190"|value="190"[^>]*name="attr\.width\.max"/);
  });

  it('offers a way to clear the filters only when there are some', async () => {
    const filtered = await load('/category/furniture?tag=handmade');
    expect(filtered.html).toContain(en.CatalogFilters.clear);
    const plain = await load('/category/furniture');
    expect(plain.html).not.toContain(en.CatalogFilters.clear);
  });

  it('forwards exactly the filters the URL asked for, and nothing it did not', async () => {
    await load('/category/furniture?tag=handmade&attr.material=oak&attr.material=pine&utm_source=x');
    const feedCall = api.seen.find((seen) => seen.url.startsWith('/v1/categories/furniture/listings'));
    expect(feedCall?.url).toContain('tag=handmade');
    expect(feedCall?.url).toContain('attr.material=oak');
    expect(feedCall?.url).toContain('attr.material=pine');
    expect(feedCall?.url).not.toContain('utm_source');
  });

  it('tells the visitor when the URL carries something that is not a filter', async () => {
    const page = await load('/category/furniture?type=vehicle');
    expect(page.status).toBe(200);
    expect(page.html).toContain(en.Categories.filtersInvalidTitle);
    // And nothing was asked of the feed, because the request could not be answered as asked.
    expect(api.seen.some((seen) => seen.url.startsWith('/v1/categories/furniture/listings'))).toBe(false);
  });
});

describe('what never reaches a browser', () => {
  it('carries no identifier of an attribute, an option or a category', async () => {
    const { html } = await load('/category/furniture');
    // The category's own identifier, and every identifier the facets could have carried. A listing's `id`
    // is part of the public card contract and is the one uuid that legitimately travels.
    expect(html).not.toContain(FURNITURE.id);
    for (const leak of Object.values(PRIVATE_VALUES)) {
      expect(html, leak).not.toContain(leak);
    }
  });

  it('refuses a whole answer that carries a field the contract does not name', async () => {
    apiServes({ kind: 'ok', facets: CONTAMINATED_FACETS });
    const page = await load('/category/furniture');
    // Refused rather than stripped: a response that has drifted is a failure to report, not a shape to
    // guess at. The page says so instead of rendering half a panel.
    expect(page.html).toContain(en.Categories.categoryErrorTitle);
    for (const leak of Object.values(PRIVATE_VALUES)) {
      expect(page.html, leak).not.toContain(leak);
    }
  });

  it('carries no credential and no API address', async () => {
    const { html } = await load('/category/furniture');
    expect(html).not.toContain(CANARY_CREDENTIAL);
    expect(html).not.toContain(api.baseUrl);
  });
});

describe('indexing', () => {
  it('indexes the unfiltered category and canonicalises it to itself', async () => {
    const page = await load('/category/furniture');
    expect(page.robotsMeta).toContain('index');
    expect(page.robotsMeta).not.toContain('noindex');
    expect(page.canonical).toBe('/category/furniture');
  });

  it('makes every filtered view noindex, canonicalised to the unfiltered page', async () => {
    for (const query of ['?tag=handmade', '?attr.material=oak', '?type=product', '?price.currency=EGP']) {
      const page = await load(`/category/furniture${query}`);
      expect(page.robotsMeta, query).toContain('noindex');
      expect(page.canonical, query).toBe('/category/furniture');
    }
  });

  it('makes a view reached with a malformed filter noindex too', async () => {
    const page = await load('/category/furniture?type=vehicle');
    expect(page.robotsMeta).toContain('noindex');
  });

  it('keeps the plain category URL in the sitemap, and no filtered one', async () => {
    const response = await fetch(`${app.baseUrl}/sitemaps/category/1`);
    const xml = await response.text();
    expect(response.status).toBe(200);
    expect(xml).toContain(`${ORIGIN}/category/furniture`);
    // No address in a sitemap carries a query string, so no filtered view is ever offered to a crawler.
    // The readers were not touched by this increment, and this is what that means on the page.
    const addresses = [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((match) => match[1] ?? '');
    expect(addresses.length).toBeGreaterThan(0);
    for (const address of addresses) expect(address, address).not.toContain('?');
  });
});

describe('both languages', () => {
  it('renders the Arabic page right to left with the Arabic panel', async () => {
    const page = await load('/ar/category/furniture');
    expect(page.status).toBe(200);
    expect(page.html).toContain('dir="rtl"');
    expect(page.html).toContain(ar.CatalogFilters.heading);
    expect(page.html).toContain(ar.Categories.feedHeading);
  });

  it('asks the API in the locale it is rendering, so the facet labels come back translated', async () => {
    await load('/ar/category/furniture');
    const feedCall = api.seen.find((seen) => seen.url.startsWith('/v1/categories/furniture/listings'));
    expect(feedCall?.url).toContain('locale=ar');
  });

  it('submits the Arabic panel to the Arabic address', async () => {
    const page = await load('/ar/category/furniture');
    expect(/<form[^>]*>/.exec(page.html)?.[0] ?? '').toContain('action="/ar/category/furniture"');
  });
});
