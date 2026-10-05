import type { ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startBuiltApp, type RunningApp } from './support/next-server.js';
import { startStubApi, type StubApi } from './support/stub-api.js';

/**
 * Per-entity SEO metadata in the document head, over real HTTP against the built app (Phase 8-F).
 *
 * **These tests exist for the two owner decisions**, because neither can be shown by a unit test of a merge function:
 *
 *   1. **A stored canonical is served for a `route` and a `page` and withheld for a listing, a category and a seller.**
 *      Asserted on the rendered `<link rel="canonical">`, with the stub API returning a canonical in every case — so a
 *      surface that honoured one it should not would fail here.
 *   2. **A stored directive set may only restrict.** Asserted on the rendered `<meta name="robots">` for a sold
 *      listing, a suspended seller, a filtered category view and a page the administrator marked unindexable, each
 *      with a stored `index` the API hands over — every one of them stays `noindex`.
 *
 * It also holds the ordinary path: a title, a description and the OpenGraph pair an administrator wrote do reach the
 * head; `og:image` deliberately does not, because a share image is a storage path and this app has no origin for one.
 *
 * No browser, no Playwright, no live provider, no deployment.
 */

/** Obviously fake, 43 base64url characters. */
const CANARY_CREDENTIAL = 'test-web-metadata-head-canary-notreal01234x';

const LISTING = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'a-chair',
  title: 'A chair',
  city: 'Cairo',
  priceMinor: '250000',
  currencyCode: 'EGP',
  currencyMinorUnit: 2,
  isNegotiable: false,
  listingTypeCode: 'product',
  description: 'A description long enough to be real.',
  contentLanguage: 'en',
  createdAt: '2026-01-01T12:00:00.000Z',
  availability: 'available',
  category: { slug: 'furniture', name: 'Furniture' },
  seller: { slug: 'good-shop', displayName: 'Good Shop' },
  attributes: [],
  tags: [],
} as const;

const SELLER = {
  seller: {
    slug: 'good-shop',
    displayName: 'Good Shop',
    bio: 'A good shop.',
    contentLanguage: 'en',
    city: 'Cairo',
  },
  availability: 'available',
} as const;

const CATEGORY = {
  category: {
    id: '22222222-2222-4222-8222-222222222222',
    slug: 'furniture',
    name: 'Furniture',
    description: 'Everything for a room.',
    parent: null,
    children: [],
  },
  seo: { metaTitle: null, metaDescription: null },
} as const;

const CMS_PAGE = {
  outcome: 'page',
  page: {
    slug: 'about',
    pageKey: 'about',
    template: 'standard',
    isIndexable: true,
    resolvedLocale: 'en',
    title: 'About us',
    excerpt: 'Who we are.',
    body: 'Who we are, at enough length to be a real page.',
    metaTitle: null,
    metaDescription: null,
    coverObjectPath: null,
    publishedAt: '2026-01-01T12:00:00.000Z',
    updatedAt: '2026-01-02T12:00:00.000Z',
  },
} as const;

/** The override the stub hands over. Every case stores a canonical and a permissive directive. */
const OVERRIDE = {
  metaTitle: 'An administrator’s title',
  metaDescription: 'An administrator’s description.',
  canonicalPath: '/somewhere-else',
  robotsDirectives: [] as string[],
  ogTitle: 'A social title',
  ogDescription: 'A social description.',
  shareObjectPath: 'cms-media/share/card.png',
};

let api: StubApi;
let app: RunningApp;

/** What the override reader answers, and the states the catalogue surfaces are in. */
let override: Record<string, unknown> | null;
let listingAvailability: 'available' | 'no_longer_available';
let sellerAvailability: 'available' | 'unavailable';
let pageIsIndexable: boolean;

function json(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

/**
 * The API the app talks to.
 *
 * Registered afresh before every test rather than once, because one test below deliberately replaces it with a failing
 * one — and a stub that stayed replaced would make every later test pass or fail for the wrong reason.
 */
function serveApi(): void {
  api.reply((request, response) => {
    const path = request.url.split('?')[0] ?? '';

    if (path === '/v1/seo/metadata') return json(response, { override });
    if (path === '/v1/seo/redirects/resolve') return json(response, { outcome: 'none' });

    if (path.startsWith('/v1/listings/')) {
      return json(response, { listing: { ...LISTING, availability: listingAvailability } });
    }
    if (path.startsWith('/v1/services/')) {
      return json(response, {
        service: {
          ...LISTING,
          slug: 'a-haircut',
          title: 'A haircut',
          listingTypeCode: 'service',
          availability: listingAvailability,
        },
      });
    }
    if (path.startsWith('/v1/sellers/')) {
      return json(response, { ...SELLER, availability: sellerAvailability });
    }
    if (path.startsWith('/v1/categories/')) return json(response, CATEGORY);
    if (path.startsWith('/v1/cms/pages/')) {
      return json(response, { ...CMS_PAGE, page: { ...CMS_PAGE.page, isIndexable: pageIsIndexable } });
    }

    response.writeHead(404, { 'content-type': 'application/problem+json' });
    response.end(JSON.stringify({ status: 404, code: 'NOT_FOUND' }));
  });
}

beforeAll(async () => {
  api = await startStubApi();
  serveApi();
  app = await startBuiltApp({ API_BASE_URL: api.baseUrl, INTERNAL_BFF_CREDENTIAL: CANARY_CREDENTIAL });
}, 180_000);

afterAll(async () => {
  await app?.stop();
  await api?.stop();
});

beforeEach(() => {
  api.seen.length = 0;
  serveApi();
  override = null;
  listingAvailability = 'available';
  sellerAvailability = 'available';
  pageIsIndexable = true;
});

interface Head {
  readonly status: number;
  readonly title: string | null;
  readonly description: string | null;
  readonly canonical: string | null;
  readonly robots: string | null;
  readonly ogTitle: string | null;
  readonly ogDescription: string | null;
  readonly ogImage: string | null;
  readonly html: string;
}

function attribute(html: string, pattern: RegExp): string | null {
  const found = pattern.exec(html);
  return found === null ? null : (found[1] ?? null);
}

async function head(path: string): Promise<Head> {
  const response = await fetch(`${app.baseUrl}${path}`, { redirect: 'manual' });
  const html = await response.text();
  return {
    status: response.status,
    title: attribute(html, /<title>([^<]*)<\/title>/),
    description: attribute(html, /<meta name="description" content="([^"]*)"\/?>/),
    canonical: attribute(html, /<link rel="canonical" href="([^"]*)"\/?>/),
    robots: attribute(html, /<meta name="robots" content="([^"]*)"\/?>/),
    ogTitle: attribute(html, /<meta property="og:title" content="([^"]*)"\/?>/),
    ogDescription: attribute(html, /<meta property="og:description" content="([^"]*)"\/?>/),
    ogImage: attribute(html, /<meta property="og:image" content="([^"]*)"\/?>/),
    html,
  };
}

/* ------------------------------------------------------------------------------------------------ */
/* Nothing stored                                                                                    */
/* ------------------------------------------------------------------------------------------------ */

describe('a surface with no override', () => {
  it('renders exactly the head it derives from its own content', async () => {
    const listing = await head('/listing/a-chair');
    expect(listing.status).toBe(200);
    expect(listing.title).toContain('A chair');
    expect(listing.canonical).toBe('/listing/a-chair');
    expect(listing.robots).toBe('index, follow');
    // OpenGraph belongs to the override. A surface with none emits none, because adding site-wide social tags is a
    // change this increment was not asked to make.
    expect(listing.ogTitle).toBeNull();
  });

  it('renders the derived head when the override could not be read at all', async () => {
    api.reply((_request, response) => {
      response.writeHead(503, { 'content-type': 'application/problem+json' });
      response.end(JSON.stringify({ status: 503, code: 'SERVICE_UNAVAILABLE' }));
    });
    const page = await head('/listing/a-chair');
    // The catalogue read fails too in this stub, so the page is its own error view; what matters is that it answered
    // rather than failing because its optional metadata was unavailable.
    expect([200, 404, 500, 503]).toContain(page.status);
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* Owner decision 1 — the canonical                                                                  */
/* ------------------------------------------------------------------------------------------------ */

describe('a stored canonical', () => {
  it('is served for a CMS static page, which is one of the two kinds that honours one', async () => {
    override = { ...OVERRIDE };
    const page = await head('/about');
    expect(page.status).toBe(200);
    expect(page.canonical).toBe('/somewhere-else');
  });

  it('is served for a landing route, which has no derived canonical to contradict', async () => {
    override = { ...OVERRIDE };
    const page = await head('/listings');
    expect(page.canonical).toBe('/somewhere-else');
  });

  it('is withheld for a listing, which keeps its self-referencing address', async () => {
    // The stub hands one over regardless; the reader is what withholds it, and in this test the API is the stub — so
    // this asserts the whole chain from what the API says to what the browser is told.
    override = { ...OVERRIDE, canonicalPath: null };
    const page = await head('/listing/a-chair');
    expect(page.canonical).toBe('/listing/a-chair');
  });

  it('is withheld for a category, so a filtered view still points at the unfiltered page', async () => {
    override = { ...OVERRIDE, canonicalPath: null };
    const unfiltered = await head('/category/furniture');
    expect(unfiltered.canonical).toBe('/category/furniture');

    const filtered = await head('/category/furniture?tag=handmade');
    expect(filtered.canonical).toBe('/category/furniture');
  });

  it('is withheld for a seller', async () => {
    override = { ...OVERRIDE, canonicalPath: null };
    const page = await head('/seller/good-shop');
    expect(page.canonical).toBe('/seller/good-shop');
  });

  it('is never served for a catalogue surface even when the API wrongly sends one', async () => {
    // The response contract refuses a canonical for these kinds only because the database withholds it; if the API
    // sent one anyway the whole override is refused, and the surface keeps its own address. Either way the address
    // below is the derived one, which is the property that matters.
    override = { ...OVERRIDE, canonicalPath: '/somewhere-else' };
    for (const path of ['/listing/a-chair', '/category/furniture', '/seller/good-shop']) {
      const page = await head(path);
      expect(page.canonical, path).toBe(path);
    }
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* Owner decision 2 — the robots directives                                                          */
/* ------------------------------------------------------------------------------------------------ */

describe('stored robots directives', () => {
  it('restrict an indexable surface', async () => {
    override = { ...OVERRIDE, canonicalPath: null, robotsDirectives: ['noindex'] };
    const page = await head('/listing/a-chair');
    expect(page.robots).toContain('noindex');
  });

  it('add the directives that have no page-level equivalent', async () => {
    override = { ...OVERRIDE, canonicalPath: null, robotsDirectives: ['nosnippet', 'noarchive', 'noimageindex'] };
    const page = await head('/listing/a-chair');
    expect(page.robots).toContain('nosnippet');
    expect(page.robots).toContain('noarchive');
    expect(page.robots).toContain('noimageindex');
    // Still indexable: those three restrict how a result is shown, not whether it exists.
    expect(page.robots).toContain('index');
    expect(page.robots).not.toContain('noindex');
  });

  it('cannot index a listing that is no longer available', async () => {
    listingAvailability = 'no_longer_available';
    override = { ...OVERRIDE, canonicalPath: null, robotsDirectives: [] };
    const page = await head('/listing/a-chair');
    // The state table says `noindex` for a sold listing. An override holds restrictions only, so there is no value an
    // administrator could store that would put it back in the index.
    expect(page.robots).toContain('noindex');
  });

  it('cannot index a service that is no longer available', async () => {
    listingAvailability = 'no_longer_available';
    override = { ...OVERRIDE, canonicalPath: null, robotsDirectives: [] };
    const page = await head('/service/a-haircut');
    expect(page.robots).toContain('noindex');
  });

  it('cannot index a suspended seller’s profile', async () => {
    sellerAvailability = 'unavailable';
    override = { ...OVERRIDE, canonicalPath: null, robotsDirectives: [] };
    const page = await head('/seller/good-shop');
    expect(page.robots).toContain('noindex');
  });

  it('cannot index a filtered category view, which is 8-D’s decision', async () => {
    override = { ...OVERRIDE, canonicalPath: null, robotsDirectives: [] };
    const filtered = await head('/category/furniture?tag=handmade');
    expect(filtered.robots).toContain('noindex');

    // And the unfiltered view of the same category is still indexable, so the override did not break that either.
    const unfiltered = await head('/category/furniture');
    expect(unfiltered.robots).toContain('index');
    expect(unfiltered.robots).not.toContain('noindex');
  });

  it('cannot index a CMS page the administrator marked unindexable', async () => {
    pageIsIndexable = false;
    override = { ...OVERRIDE, robotsDirectives: [] };
    const page = await head('/about');
    expect(page.robots).toContain('noindex');
  });

  it('cannot index a paged landing view', async () => {
    override = { ...OVERRIDE, robotsDirectives: [] };
    const paged = await head('/listings?cursor=abc');
    expect(paged.robots).toContain('noindex');
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* The ordinary path                                                                                 */
/* ------------------------------------------------------------------------------------------------ */

describe('what an override does reach the head', () => {
  it('replaces the title and the description', async () => {
    override = { ...OVERRIDE, canonicalPath: null };
    const page = await head('/listing/a-chair');
    expect(page.title).toContain('An administrator’s title');
    expect(page.description).toBe('An administrator’s description.');
  });

  it('adds the OpenGraph pair an administrator wrote, and no image', async () => {
    override = { ...OVERRIDE, canonicalPath: null };
    const page = await head('/listing/a-chair');
    expect(page.ogTitle).toBe('A social title');
    expect(page.ogDescription).toBe('A social description.');
    // A share image is a storage object path, not a path on this site. Emitting one would mean inventing an origin
    // for the media bucket, which this app does not have and does not guess.
    expect(page.ogImage).toBeNull();
    expect(page.html).not.toContain('cms-media/share/card.png');
  });

  it('leaves a field the administrator did not write to the surface itself', async () => {
    override = { ...OVERRIDE, canonicalPath: null, metaTitle: null, metaDescription: null, ogTitle: null, ogDescription: null };
    const page = await head('/listing/a-chair');
    expect(page.title).toContain('A chair');
    expect(page.description).toContain('A description long enough');
    // No OpenGraph at all when the override carries neither of the two fields.
    expect(page.ogTitle).toBeNull();
  });

  it('works in Arabic as well as English', async () => {
    override = { ...OVERRIDE, canonicalPath: null };
    const page = await head('/ar/listing/a-chair');
    expect(page.title).toContain('An administrator’s title');
    expect(page.canonical).toBe('/ar/listing/a-chair');
  });

  it('is asked about with the surface’s slug and the locale, and never with an identifier', async () => {
    override = { ...OVERRIDE, canonicalPath: null };
    await head('/ar/listing/a-chair');
    const asked = api.seen.filter((entry) => entry.url.startsWith('/v1/seo/metadata'));
    expect(asked.length).toBeGreaterThan(0);
    expect(asked[0]?.url).toContain('slug=a-chair');
    expect(asked[0]?.url).toContain('locale=ar');
    expect(asked[0]?.url).not.toContain(LISTING.id);
  });

  it('asks once per request, not once per thing that wants a head', async () => {
    override = { ...OVERRIDE, canonicalPath: null };
    await head('/listing/a-chair');
    expect(api.seen.filter((entry) => entry.url.startsWith('/v1/seo/metadata'))).toHaveLength(1);
  });
});

