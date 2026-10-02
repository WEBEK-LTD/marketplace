import type { ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startBuiltApp, type RunningApp } from './support/next-server.js';
import { startStubApi, type StubApi } from './support/stub-api.js';

/**
 * The SEO redirect map, over real HTTP against the built app (Phase 8-E).
 *
 * **What these tests exist to prove is the precedence**, because it is the owner's approved rule and no unit test of
 * a decision function can show it: LIVE PAGE WINS. A path that resolves to a live page, listing, service, category,
 * seller or CMS page is **served**, and the map is not even consulted for it — asserted on the stub API's record of
 * what was asked, not only on the status line, because a map that was consulted and ignored would be one refactor
 * away from winning.
 *
 * The rest follows from that:
 *
 *   * a path that would otherwise 404 — an address nobody wrote a route for, or a catalogue address whose row is
 *     gone — redirects, with the **stored status code** and the stored destination;
 *   * an entry that is switched off, a chain that loops, and an address the map does not name all leave the 404
 *     exactly as it was;
 *   * a chain is followed to its end by the database, and the browser is sent there in one hop;
 *   * the map can never send a visitor off this site, and never to the address they just asked for.
 *
 * The status line is what matters and it can only be decided in the middleware: Next.js 16 streams, so a redirect
 * chosen inside a page arrives as a 200 with the right body. These run the built app under `next start` against a
 * stub API: no browser, no Playwright, no live provider, no deployment.
 */

/** Obviously fake, 43 base64url characters. */
const CANARY_CREDENTIAL = 'test-web-redirect-canary-credential-notreal';

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

const CATEGORY = {
  category: {
    id: '22222222-2222-4222-8222-222222222222',
    slug: 'furniture',
    name: 'Furniture',
    description: null,
    parent: null,
    children: [],
    listingCount: 0,
  },
  seo: { metaTitle: null, metaDescription: null },
} as const;

/** A published CMS static page, so `/about` is genuinely live in these tests rather than merely routed. */
const CMS_PAGE = {
  outcome: 'page',
  page: {
    slug: 'about',
    pageKey: 'about',
    template: 'standard',
    isIndexable: true,
    resolvedLocale: 'en',
    title: 'About us',
    excerpt: null,
    body: 'Who we are, at enough length to be a real page.',
    metaTitle: null,
    metaDescription: null,
    coverObjectPath: null,
    publishedAt: '2026-01-01T12:00:00.000Z',
    updatedAt: '2026-01-02T12:00:00.000Z',
  },
} as const;

/** What the map answers, keyed by the path that was asked about. */
type MapAnswer = { toPath: string; statusCode: number } | null;

let api: StubApi;
let app: RunningApp;
let answers: ReadonlyMap<string, MapAnswer>;
/** Whether the catalogue reads answer at all, so a 404 from a missing row can be produced on demand. */
let catalogueFound: boolean;

function json(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function notFound(response: ServerResponse): void {
  response.writeHead(404, { 'content-type': 'application/problem+json' });
  response.end(JSON.stringify({ status: 404, code: 'NOT_FOUND' }));
}

beforeAll(async () => {
  api = await startStubApi();
  api.reply((request, response) => {
    const [pathname, search] = request.url.split('?');
    const path = pathname ?? '';

    if (path === '/v1/seo/redirects/resolve') {
      const asked = new URLSearchParams(search ?? '').get('path') ?? '';
      const answer = answers.get(asked) ?? null;
      return json(response, answer === null ? { outcome: 'none' } : { outcome: 'redirect', ...answer });
    }

    if (path.startsWith('/v1/listings/')) {
      return catalogueFound ? json(response, { listing: LISTING }) : notFound(response);
    }
    if (path.startsWith('/v1/categories/')) {
      return catalogueFound ? json(response, CATEGORY) : notFound(response);
    }
    if (path.startsWith('/v1/cms/pages/')) {
      return catalogueFound ? json(response, CMS_PAGE) : notFound(response);
    }

    return notFound(response);
  });
  app = await startBuiltApp({ API_BASE_URL: api.baseUrl, INTERNAL_BFF_CREDENTIAL: CANARY_CREDENTIAL });
}, 180_000);

afterAll(async () => {
  await app?.stop();
  await api?.stop();
});

beforeEach(() => {
  api.seen.length = 0;
  catalogueFound = true;
  answers = new Map();
});

function mapHas(entries: Record<string, MapAnswer>): void {
  answers = new Map(Object.entries(entries));
}

interface Hit {
  readonly status: number;
  readonly location: string | null;
  readonly html: string;
}

async function load(path: string): Promise<Hit> {
  const response = await fetch(`${app.baseUrl}${path}`, { redirect: 'manual' });
  return { status: response.status, location: response.headers.get('location'), html: await response.text() };
}

/** Whether the map was consulted at all during the last request. */
function mapWasConsulted(): boolean {
  return api.seen.some((entry) => entry.url.startsWith('/v1/seo/redirects/resolve'));
}

/* ------------------------------------------------------------------------------------------------ */
/* LIVE PAGE WINS                                                                                    */
/* ------------------------------------------------------------------------------------------------ */

describe('a live page always wins', () => {
  it('serves a live listing and never consults the map, even with an entry for that exact address', async () => {
    mapHas({ '/listing/a-chair': { toPath: '/listings', statusCode: 301 } });
    const hit = await load('/listing/a-chair');
    expect(hit.status).toBe(200);
    expect(hit.location).toBeNull();
    expect(hit.html).toContain('A chair');
    // The assertion that matters: not merely that the redirect lost, but that it was never asked about.
    expect(mapWasConsulted()).toBe(false);
  });

  it('serves a live category the same way', async () => {
    mapHas({ '/category/furniture': { toPath: '/categories', statusCode: 301 } });
    const hit = await load('/category/furniture');
    expect(hit.status).toBe(200);
    expect(mapWasConsulted()).toBe(false);
  });

  it('serves a fixed public page the same way', async () => {
    mapHas({
      '/about': { toPath: '/contact', statusCode: 301 },
      '/search': { toPath: '/listings', statusCode: 301 },
      '/': { toPath: '/listings', statusCode: 301 },
    });
    for (const path of ['/about', '/search', '/']) {
      const hit = await load(path);
      expect(hit.status, path).toBe(200);
      expect(hit.location, path).toBeNull();
      expect(mapWasConsulted(), path).toBe(false);
      api.seen.length = 0;
    }
  });

  it('serves an Arabic live page the same way', async () => {
    mapHas({ '/ar/about': { toPath: '/ar/contact', statusCode: 301 } });
    const hit = await load('/ar/about');
    expect(hit.status).toBe(200);
    expect(mapWasConsulted()).toBe(false);
  });

  it('never consults the map for a BFF route or a crawler document', async () => {
    mapHas({
      '/robots.txt': { toPath: '/about', statusCode: 301 },
      '/sitemap.xml': { toPath: '/about', statusCode: 301 },
      '/api/search': { toPath: '/about', statusCode: 301 },
    });
    for (const path of ['/robots.txt', '/sitemap.xml', '/api/search?q=chair']) {
      await load(path);
      expect(mapWasConsulted(), path).toBe(false);
      api.seen.length = 0;
    }
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* An address that would otherwise be a 404                                                          */
/* ------------------------------------------------------------------------------------------------ */

describe('an address nobody wrote a route for', () => {
  it('redirects with the stored destination and the stored status code', async () => {
    for (const statusCode of [301, 302, 307, 308]) {
      mapHas({ '/old-campaign': { toPath: '/listings', statusCode } });
      const hit = await load('/old-campaign');
      expect(hit.status, String(statusCode)).toBe(statusCode);
      expect(hit.location, String(statusCode)).toContain('/listings');
      api.seen.length = 0;
    }
  });

  it('answers the ordinary 404 when the map names nothing for it', async () => {
    mapHas({});
    const hit = await load('/old-campaign');
    expect(hit.status).toBe(404);
    expect(hit.location).toBeNull();
    // It was asked, and it said no. Both halves matter: asked, because that is the feature; said no, because that
    // is the default.
    expect(mapWasConsulted()).toBe(true);
  });

  it('keeps the locale prefix out of the question: the address is the address', async () => {
    mapHas({ '/ar/old-campaign': { toPath: '/ar/listings', statusCode: 301 } });
    const arabic = await load('/ar/old-campaign');
    expect(arabic.status).toBe(301);
    expect(arabic.location).toContain('/ar/listings');

    // The English address was not written, so it is still a 404 — the map is keyed on what an operator typed.
    api.seen.length = 0;
    const english = await load('/old-campaign');
    expect(english.status).toBe(404);
  });

  it('redirects a deeper address too', async () => {
    mapHas({ '/old/campaign/spring': { toPath: '/marketplace', statusCode: 301 } });
    const hit = await load('/old/campaign/spring');
    expect(hit.status).toBe(301);
    expect(hit.location).toContain('/marketplace');
  });
});

describe('a catalogue address whose row is gone', () => {
  it('redirects rather than answering 404, because that 404 is a 404 like any other', async () => {
    catalogueFound = false;
    mapHas({ '/listing/a-discontinued-chair': { toPath: '/listings', statusCode: 301 } });
    const hit = await load('/listing/a-discontinued-chair');
    expect(hit.status).toBe(301);
    expect(hit.location).toContain('/listings');
  });

  it('still answers 404 when the map names nothing for it', async () => {
    catalogueFound = false;
    mapHas({});
    const hit = await load('/listing/a-discontinued-chair');
    expect(hit.status).toBe(404);
    expect(mapWasConsulted()).toBe(true);
  });

  it('does the same for a category that is gone', async () => {
    catalogueFound = false;
    mapHas({ '/category/retired': { toPath: '/categories', statusCode: 308 } });
    const hit = await load('/category/retired');
    expect(hit.status).toBe(308);
    expect(hit.location).toContain('/categories');
  });

  it('and for a CMS static page nobody has published', async () => {
    // The third of the three ways a path can 404, and the one that looks most like a live page from the outside:
    // `/about` has a route file, so only the page reader can say there is nothing to render.
    catalogueFound = false;
    mapHas({ '/about': { toPath: '/contact', statusCode: 302 } });
    const hit = await load('/about');
    expect(hit.status).toBe(302);
    expect(hit.location).toContain('/contact');
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* What the map will not do                                                                          */
/* ------------------------------------------------------------------------------------------------ */

describe('what the map will not do', () => {
  it('leaves the 404 alone for an entry that is switched off', async () => {
    // Switched off is modelled where it is decided: the database's resolver does not see an inactive entry, so the
    // API answers `none` and nothing here has to know why.
    mapHas({ '/old-campaign': null });
    const hit = await load('/old-campaign');
    expect(hit.status).toBe(404);
  });

  it('leaves the 404 alone for a chain that comes back to where it started', async () => {
    // A loop is stopped in the database, and the API answers `none` for a destination equal to the path asked for.
    mapHas({ '/loop-a': null });
    const hit = await load('/loop-a');
    expect(hit.status).toBe(404);
  });

  it('follows a chain in one hop, because the database resolved it to its end', async () => {
    mapHas({ '/first': { toPath: '/third', statusCode: 301 } });
    const hit = await load('/first');
    expect(hit.status).toBe(301);
    // One hop: the destination is the end of the chain, not the next link.
    expect(hit.location).toContain('/third');
    expect(hit.location).not.toContain('/second');
  });

  it('never sends a visitor off this site, whatever the API claims', async () => {
    for (const toPath of ['https://evil.test/', '//evil.test', 'javascript:alert(1)']) {
      mapHas({ '/old-campaign': { toPath, statusCode: 301 } });
      const hit = await load('/old-campaign');
      expect(hit.status, toPath).toBe(404);
      expect(hit.location, toPath).toBeNull();
      api.seen.length = 0;
    }
  });

  it('never sends a visitor to the address they just asked for', async () => {
    mapHas({ '/old-campaign': { toPath: '/old-campaign', statusCode: 301 } });
    const hit = await load('/old-campaign');
    expect(hit.status).toBe(404);
  });

  it('never uses a status code the table could not hold', async () => {
    for (const statusCode of [200, 303, 404, 410]) {
      mapHas({ '/old-campaign': { toPath: '/listings', statusCode } });
      const hit = await load('/old-campaign');
      expect(hit.status, String(statusCode)).toBe(404);
      api.seen.length = 0;
    }
  });

  it('does not let a redirect stand in for a signed-out visitor’s login', async () => {
    // `/dashboard` is a served route and the session check runs above the map, so a signed-out visitor is sent to
    // login and the map is never consulted. An entry claiming that address changes nothing.
    mapHas({ '/dashboard': { toPath: '/listings', statusCode: 301 } });
    const hit = await load('/dashboard');
    expect(hit.status).toBe(307);
    expect(hit.location).toContain('/login');
    expect(mapWasConsulted()).toBe(false);
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* When the map itself cannot be read                                                                */
/* ------------------------------------------------------------------------------------------------ */

describe('when the map cannot be read', () => {
  it('leaves the 404 exactly as it was', async () => {
    api.reply((_request, response) => {
      response.writeHead(503, { 'content-type': 'application/problem+json' });
      response.end(JSON.stringify({ status: 503, code: 'SERVICE_UNAVAILABLE' }));
    });
    const hit = await load('/old-campaign');
    // A redirect that cannot be confirmed is not a redirect. The visitor gets the answer they were getting before
    // the map existed, which is the one honest option.
    expect(hit.status).toBe(404);
    expect(hit.location).toBeNull();
  });
});
