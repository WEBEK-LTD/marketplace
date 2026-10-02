import type { ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startBuiltApp, type RunningApp } from './support/next-server.js';
import { startStubApi, type StubApi } from './support/stub-api.js';

/**
 * The listing/service surface split, over real HTTP against the built app (Phase 4-C).
 *
 * Products and services share one table and one slug namespace, so the split is a routing property, not
 * a data one: `/listings` must carry no service, `/services` must carry no product, and a slug asked of
 * the wrong surface must be a `301` to the right one rather than a page or a `404`. That is what makes
 * "no duplicate public canonical service URLs" true, and it is what these tests hold to account.
 *
 * The Phase 4-B regression is checked here too. No browser, no Playwright, no live provider.
 */

/** Obviously fake, 43 base64url characters. */
const CANARY_CREDENTIAL = 'test-web-svc-canary-credential-not-a-realxx';

const SERVICE = {
  id: '22220000-0000-4000-8000-000000000001',
  slug: 'logo-design',
  title: 'Logo design',
  city: 'Cairo',
  priceMinor: '150000',
  currencyCode: 'EGP',
  currencyMinorUnit: 2,
  pricingModel: 'fixed',
  deliveryDays: 5,
  revisionsIncluded: 2,
  description: 'A description long enough to be real.',
  contentLanguage: 'en',
  requiresBrief: true,
  scope: 'Three concepts, two rounds of revision.',
  availability: 'available',
  category: { slug: 'design', name: 'Design' },
  seller: { slug: 'good-shop', displayName: 'Good Shop' },
  attributes: [],
  tags: [],
} as const;

const LISTING = {
  id: '11110000-0000-4000-8000-000000000001',
  slug: 'a-sofa',
  title: 'A sofa',
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

/** The card projections. The list schemas are strict, so a detail-shaped row would be refused. */
const SERVICE_CARD = {
  id: SERVICE.id,
  slug: SERVICE.slug,
  title: SERVICE.title,
  city: SERVICE.city,
  priceMinor: SERVICE.priceMinor,
  currencyCode: SERVICE.currencyCode,
  currencyMinorUnit: SERVICE.currencyMinorUnit,
  pricingModel: SERVICE.pricingModel,
  deliveryDays: SERVICE.deliveryDays,
  revisionsIncluded: SERVICE.revisionsIncluded,
} as const;

const LISTING_CARD = {
  id: LISTING.id,
  slug: LISTING.slug,
  title: LISTING.title,
  city: LISTING.city,
  priceMinor: LISTING.priceMinor,
  currencyCode: LISTING.currencyCode,
  currencyMinorUnit: LISTING.currencyMinorUnit,
  isNegotiable: LISTING.isNegotiable,
  listingTypeCode: LISTING.listingTypeCode,
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

function notFound(response: ServerResponse): void {
  response.writeHead(404, { 'content-type': 'application/problem+json' });
  response.end(JSON.stringify({ status: 404, code: 'NOT_FOUND' }));
}

function movedTo(response: ServerResponse, slug: string, surface: 'product' | 'service'): void {
  response.writeHead(301, { 'x-canonical-slug': slug, 'x-canonical-type': surface });
  response.end();
}

/**
 * The API as it really behaves for this fixture: one service and one product, each canonical on its own
 * surface, each redirecting when asked for on the other.
 */
function apiRoutesBothSurfaces(): void {
  api.reply((request, response) => {
    const [path] = request.url.split('?');
    if (path === '/v1/services') return json(response, { items: [SERVICE_CARD], nextCursor: null });
    if (path === '/v1/listings') return json(response, { items: [LISTING_CARD], nextCursor: null });

    if (path === '/v1/services/logo-design') return json(response, { service: SERVICE });
    if (path === '/v1/services/old-logo-design') return movedTo(response, 'logo-design', 'service');
    if (path === '/v1/services/a-sofa') return movedTo(response, 'a-sofa', 'product');

    if (path === '/v1/listings/a-sofa') return json(response, { listing: LISTING });
    if (path === '/v1/listings/old-sofa') return movedTo(response, 'a-sofa', 'product');
    if (path === '/v1/listings/logo-design') return movedTo(response, 'logo-design', 'service');

    return notFound(response);
  });
}

beforeEach(() => {
  api.seen.length = 0;
  apiRoutesBothSurfaces();
});

interface Page {
  readonly status: number;
  readonly location: string | null;
  readonly robotsHeader: string | null;
  readonly robotsMeta: string | null;
  readonly html: string;
}

async function load(path: string): Promise<Page> {
  const response = await fetch(`${app.baseUrl}${path}`, { redirect: 'manual' });
  const html = await response.text();
  const meta = /<meta name="robots" content="([^"]*)"\/?>/.exec(html);
  return {
    status: response.status,
    location: response.headers.get('location'),
    robotsHeader: response.headers.get('x-robots-tag'),
    robotsMeta: meta === null ? null : (meta[1] ?? null),
    html,
  };
}

describe('the service surface', () => {
  it('lists services at /services in both languages', async () => {
    for (const path of ['/services', '/ar/services']) {
      const page = await load(path);
      expect(page.status, path).toBe(200);
      expect(page.html, path).toContain('Logo design');
    }
  });

  it('renders a service at /service/[slug] in both languages', async () => {
    for (const [path, lang] of [
      ['/service/logo-design', 'en'],
      ['/ar/service/logo-design', 'ar'],
    ] as const) {
      const page = await load(path);
      expect(page.status, path).toBe(200);
      expect(page.html, path).toContain('Logo design');
      expect(page.html, path).toContain(`<html lang="${lang}"`);
    }
  });

  it('shows the service-specific facts on the page', async () => {
    const page = await load('/service/logo-design');
    expect(page.html).toContain('5 days');
    expect(page.html).toContain('Fixed price');
    expect(page.html).toContain('Three concepts, two rounds of revision.');
  });
});

describe('the surfaces do not overlap', () => {
  it('a service asked for on the listing surface is a 301 to the service URL', async () => {
    const page = await load('/listing/logo-design');
    expect(page.status).toBe(301);
    expect(page.location).toBe('/service/logo-design');
    expect(page.html).not.toContain('Logo design');
  });

  it('and keeps the locale it was asked in', async () => {
    const page = await load('/ar/listing/logo-design');
    expect(page.status).toBe(301);
    expect(page.location).toBe('/ar/service/logo-design');
  });

  it('a product asked for on the service surface is a 301 to the listing URL', async () => {
    const page = await load('/service/a-sofa');
    expect(page.status).toBe(301);
    expect(page.location).toBe('/listing/a-sofa');
  });

  it('a previous service slug redirects within the service surface', async () => {
    const page = await load('/service/old-logo-design');
    expect(page.status).toBe(301);
    expect(page.location).toBe('/service/logo-design');
  });

  it('a previous product slug still redirects within the listing surface', async () => {
    const page = await load('/listing/old-sofa');
    expect(page.status).toBe(301);
    expect(page.location).toBe('/listing/a-sofa');
  });
});

describe('the Phase 4-B listing surface still works', () => {
  it('renders a product at /listing/[slug]', async () => {
    const page = await load('/listing/a-sofa');
    expect(page.status).toBe(200);
    expect(page.html).toContain('A sofa');
  });

  it('lists products at /listings', async () => {
    const page = await load('/listings');
    expect(page.status).toBe(200);
    expect(page.html).toContain('A sofa');
    expect(page.html).not.toContain('Logo design');
  });

  it('and the status correction is intact: a non-public slug is a real 404', async () => {
    const page = await load('/listing/nothing-here');
    expect(page.status).toBe(404);
    expect(page.robotsMeta ?? '').toContain('noindex');
  });
});

describe('a service the public may not see', () => {
  it('is a real 404, in both languages, with the localized not-found view', async () => {
    const english = await load('/service/hidden-service');
    expect(english.status).toBe(404);
    expect(english.html).toContain('Service not found');

    const arabic = await load('/ar/service/hidden-service');
    expect(arabic.status).toBe(404);
    expect(arabic.html).toContain('<html lang="ar"');
    expect(arabic.html).toContain('الخدمة غير موجودة');
  });

  it('is noindex and says nothing about why', async () => {
    const page = await load('/service/hidden-service');
    expect(page.robotsMeta ?? '').toContain('noindex');
    for (const leak of ['draft', 'suspended', 'rejected', 'Logo design']) {
      expect(page.html, leak).not.toContain(leak);
    }
  });

  it('asks its own reader exactly once, and consults the redirect map once', async () => {
    api.seen.length = 0;
    await load('/service/hidden-service');
    // Still one read of this surface: the page does not read again behind the middleware's decision.
    expect(api.seen.map((s) => s.url).filter((url) => url.startsWith('/v1/services/'))).toEqual([
      '/v1/services/hidden-service?locale=en',
    ]);
    // And exactly one more call, which is 8-E's redirect map being consulted — a path that would answer 404 is
    // precisely when it may be, and the answer here leaves the 404 alone.
    expect(
      api.seen.map((s) => s.url).filter((url) => url.startsWith('/v1/seo/redirects/resolve')),
    ).toHaveLength(1);
    expect(api.seen).toHaveLength(2);
  });
});

describe('a service that is no longer available', () => {
  it('stays a 200 with its content, and becomes noindex', async () => {
    api.reply((request, response) => {
      const [path] = request.url.split('?');
      if (path === '/v1/services/logo-design') {
        return json(response, { service: { ...SERVICE, availability: 'no_longer_available' } });
      }
      return notFound(response);
    });
    const page = await load('/service/logo-design');
    expect(page.status).toBe(200);
    expect(page.html).toContain('Logo design');
    expect(page.html).toContain('No longer available');
    expect(page.robotsMeta ?? '').toContain('noindex');
  });
});

describe('the robots policy covers the service surface', () => {
  it('/services and /service/[slug] are not globally noindex', async () => {
    for (const path of ['/services', '/ar/services', '/service/logo-design', '/ar/service/logo-design']) {
      const page = await load(path);
      expect(page.robotsHeader, path).toBeNull();
      expect(page.robotsMeta ?? '', path).not.toContain('noindex');
    }
  });

  it('a cursor page of the service list is noindex, follow', async () => {
    const page = await load('/services?cursor=Y3Vyc29y');
    expect(page.robotsHeader).toBeNull();
    expect(page.robotsMeta).toBe('noindex, follow');
  });

  it('a lookalike path is still refused by the header', async () => {
    for (const path of ['/servicesomething', '/service/logo-design/edit', '/service/A-Design']) {
      const page = await load(path);
      expect(page.robotsHeader, path).toBe('noindex');
      expect(page.status, path).not.toBe(301);
    }
  });
});

describe('the internal boundary', () => {
  it('reaches the API with the internal credential and no browser cookie', async () => {
    api.seen.length = 0;
    await load('/ar/service/logo-design');
    const first = api.seen[0];
    expect(first?.url).toBe('/v1/services/logo-design?locale=ar');
    expect(first?.credential).toBe(CANARY_CREDENTIAL);
    expect(first?.cookie).toBeNull();
  });

  it('never exposes the internal credential to the browser', async () => {
    const page = await load('/service/logo-design');
    expect(page.html).not.toContain(CANARY_CREDENTIAL);
  });
});
