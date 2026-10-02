import type { ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startBuiltApp, type RunningApp } from './support/next-server.js';
import { startStubApi, type StubApi } from './support/stub-api.js';

/**
 * The public marketplace discovery hub, over real HTTP against the built app (Phase 4-G, V1).
 *
 * The page owns no data and adds no contract, so what is worth proving is the orchestration: that it
 * reads the two existing surfaces through their own approved endpoints, that the two sections fail
 * independently of each other, and that it invents nothing — no aggregation endpoint, no mixed cursor,
 * no CMS dependency.
 *
 * No browser, no Playwright, no live provider, no deployment.
 */

const CANARY_CREDENTIAL = 'test-web-market-canary-credential-not-realx';

const LISTING = {
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

function fails(response: ServerResponse): void {
  response.writeHead(503, { 'content-type': 'application/problem+json' });
  response.end(JSON.stringify({ status: 503, code: 'SERVICE_UNAVAILABLE' }));
}

/** Both surfaces answer with one item each. */
function apiServesBoth(options: { listings?: 'ok' | 'empty' | 'fails'; services?: 'ok' | 'empty' | 'fails' } = {}): void {
  const listings = options.listings ?? 'ok';
  const services = options.services ?? 'ok';
  api.reply((request, response) => {
    const [path] = request.url.split('?');
    if (path === '/v1/listings') {
      if (listings === 'fails') return fails(response);
      return json(response, { items: listings === 'empty' ? [] : [LISTING], nextCursor: null });
    }
    if (path === '/v1/services') {
      if (services === 'fails') return fails(response);
      return json(response, { items: services === 'empty' ? [] : [SERVICE], nextCursor: null });
    }
    response.writeHead(404, { 'content-type': 'application/problem+json' });
    response.end(JSON.stringify({ status: 404, code: 'NOT_FOUND' }));
  });
}

beforeEach(() => {
  api.seen.length = 0;
  apiServesBoth();
});

interface Page {
  readonly status: number;
  readonly robotsHeader: string | null;
  readonly robotsMeta: string | null;
  readonly title: string | null;
  readonly canonical: string | null;
  readonly alternates: readonly string[];
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
    canonical: pick(/<link rel="canonical" href="([^"]*)"\/?>/),
    alternates: [...html.matchAll(/<link rel="alternate" hrefLang="([^"]*)" href="([^"]*)"\/?>/g)].map(
      (m) => `${m[1]}=${m[2]}`,
    ),
    html,
  };
}

describe('the marketplace hub', () => {
  it('answers 200 in English with both sections and their headings', async () => {
    const page = await load('/marketplace');
    expect(page.status).toBe(200);
    expect(page.html).toContain('Marketplace');
    expect(page.html).toContain('Explore products and services available on the marketplace.');
    expect(page.html).toContain('>Listings</h2>');
    expect(page.html).toContain('>Services</h2>');
  });

  it('answers 200 in Arabic, right-to-left', async () => {
    const page = await load('/ar/marketplace');
    expect(page.status).toBe(200);
    expect(page.html).toContain('<html lang="ar" dir="rtl">');
    expect(page.html).toContain('السوق');
    expect(page.html).toContain('استكشف المنتجات والخدمات المتاحة في السوق.');
    expect(page.html).toContain('الإعلانات');
    expect(page.html).toContain('الخدمات');
  });

  it('labels each section for assistive technology', async () => {
    const page = await load('/marketplace');
    expect(page.html).toContain('aria-labelledby="marketplace-listings"');
    expect(page.html).toContain('aria-labelledby="marketplace-services"');
    expect(page.html.match(/<h1/g)).toHaveLength(1);
    expect(page.html.match(/<section/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe('the two sections', () => {
  it('shows a listing and a service, each rendered by its own card', async () => {
    const page = await load('/marketplace');
    expect(page.html).toContain('Walnut dining table');
    expect(page.html).toContain('Walnut furniture restoration');
    // Fields only the service card has, proving the existing cards are reused rather than flattened.
    expect(page.html).toContain('14 days');
    expect(page.html).toContain('Fixed price');
    expect(page.html).toContain('EGP 2500.00');
  });

  it('links each item to the surface that owns it, in the right locale', async () => {
    const english = await load('/marketplace');
    expect(english.html).toContain('href="/listing/walnut-table"');
    expect(english.html).toContain('href="/service/walnut-restoration"');

    const arabic = await load('/ar/marketplace');
    expect(arabic.html).toContain('href="/ar/listing/walnut-table"');
    expect(arabic.html).toContain('href="/ar/service/walnut-restoration"');
  });

  it('sends a visitor on to each full surface instead of paginating here', async () => {
    const english = await load('/marketplace');
    expect(english.html).toContain('href="/listings"');
    expect(english.html).toContain('View all listings');
    expect(english.html).toContain('href="/services"');
    expect(english.html).toContain('View all services');
    // No pagination control of its own, and therefore no marketplace cursor.
    expect(english.html).not.toContain('rel="next"');
    expect(english.html).not.toContain('cursor=');

    const arabic = await load('/ar/marketplace');
    expect(arabic.html).toContain('href="/ar/listings"');
    expect(arabic.html).toContain('عرض جميع الإعلانات');
    expect(arabic.html).toContain('href="/ar/services"');
    expect(arabic.html).toContain('عرض جميع الخدمات');
  });

  it('reads both surfaces through their own existing endpoints, with the approved page size', async () => {
    api.seen.length = 0;
    await load('/marketplace');
    const paths = api.seen.map((s) => s.url.split('?')[0]).sort();
    expect(paths).toEqual(['/v1/listings', '/v1/services']);
    // No aggregation endpoint was invented.
    expect(api.seen.some((s) => s.url.includes('/v1/marketplace'))).toBe(false);
    // The default limit is the surfaces' own; the hub does not ask for a different one.
    expect(api.seen.every((s) => !s.url.includes('limit='))).toBe(true);
  });

  it('carries the internal credential and no browser cookie', async () => {
    api.seen.length = 0;
    await load('/marketplace');
    for (const call of api.seen) {
      expect(call.credential).toBe(CANARY_CREDENTIAL);
      expect(call.cookie).toBeNull();
    }
  });
});

describe('each section stands or falls on its own', () => {
  it('shows the listings empty state without touching the services section', async () => {
    apiServesBoth({ listings: 'empty' });
    const page = await load('/marketplace');
    expect(page.status).toBe(200);
    expect(page.html).toContain('No listings are currently available.');
    expect(page.html).toContain('Walnut furniture restoration');
  });

  it('shows the services empty state without touching the listings section', async () => {
    apiServesBoth({ services: 'empty' });
    const page = await load('/marketplace');
    expect(page.status).toBe(200);
    expect(page.html).toContain('No services are currently available.');
    expect(page.html).toContain('Walnut dining table');
  });

  it('shows both empty states at once', async () => {
    apiServesBoth({ listings: 'empty', services: 'empty' });
    const page = await load('/marketplace');
    expect(page.html).toContain('No listings are currently available.');
    expect(page.html).toContain('No services are currently available.');
  });

  it('a failing listings surface does not take the services section down with it', async () => {
    apiServesBoth({ listings: 'fails' });
    const page = await load('/marketplace');
    expect(page.status).toBe(200);
    expect(page.html).toContain("We couldn't load the listings.");
    expect(page.html).toContain('Walnut furniture restoration');
    expect(page.html).not.toContain("We couldn't load the services.");
  });

  it('and the reverse', async () => {
    apiServesBoth({ services: 'fails' });
    const page = await load('/marketplace');
    expect(page.status).toBe(200);
    expect(page.html).toContain("We couldn't load the services.");
    expect(page.html).toContain('Walnut dining table');
    expect(page.html).not.toContain("We couldn't load the listings.");
  });

  it('says both failures in Arabic when both fail', async () => {
    apiServesBoth({ listings: 'fails', services: 'fails' });
    const page = await load('/ar/marketplace');
    expect(page.status).toBe(200);
    expect(page.html).toContain('تعذر تحميل الإعلانات.');
    expect(page.html).toContain('تعذر تحميل الخدمات.');
  });

  it('never turns a failed section into a 404 or 500', async () => {
    apiServesBoth({ listings: 'fails', services: 'fails' });
    const page = await load('/marketplace');
    expect(page.status).toBe(200);
  });
});

describe('what the hub deliberately does not have', () => {
  it('has no search box, filter or sort control', async () => {
    const page = await load('/marketplace');
    expect(page.html).not.toContain('role="search"');
    expect(page.html).not.toContain('name="q"');
    for (const absent of ['Sort', 'Filter', 'Featured', 'Popular', 'Deals']) {
      expect(page.html, absent).not.toContain(absent);
    }
  });

  it('reads nothing from the CMS tables', async () => {
    api.seen.length = 0;
    await load('/marketplace');
    for (const call of api.seen) {
      for (const cms of ['homepage', 'banner', 'navigation', 'cms']) {
        expect(call.url, cms).not.toContain(cms);
      }
    }
  });
});

describe('SEO and robots', () => {
  it('is indexable, with a self-referencing canonical and both hreflang alternates', async () => {
    const english = await load('/marketplace');
    expect(english.robotsHeader).toBeNull();
    expect(english.robotsMeta ?? '').not.toContain('noindex');
    expect(english.title).toBe('Marketplace');
    expect(english.canonical).toBe('/marketplace');
    expect(english.alternates).toEqual(['en=/marketplace', 'ar=/ar/marketplace']);

    const arabic = await load('/ar/marketplace');
    expect(arabic.robotsHeader).toBeNull();
    expect(arabic.canonical).toBe('/ar/marketplace');
  });

  it('leaves the undescribed discovery routes noindex and unrouted', async () => {
    for (const path of ['/featured', '/new', '/popular', '/deals', '/marketplaces', '/marketplace/x']) {
      const page = await load(path);
      expect(page.robotsHeader, path).toBe('noindex');
      expect(page.status, path).toBe(404);
    }
  });

  it('leaves the other catalogue surfaces exactly as they were', async () => {
    api.reply((request, response) => {
      const [path] = request.url.split('?');
      if (path === '/v1/listings') return json(response, { items: [LISTING], nextCursor: null });
      if (path === '/v1/services') return json(response, { items: [SERVICE], nextCursor: null });
      if (path === '/v1/categories') return json(response, { categories: [] });
      response.writeHead(404, { 'content-type': 'application/problem+json' });
      response.end(JSON.stringify({ status: 404 }));
    });
    for (const path of ['/listings', '/services', '/categories']) {
      const page = await load(path);
      expect(page.status, path).toBe(200);
      expect(page.robotsHeader, path).toBeNull();
    }
    // Search stays noindex, as Phase 4-F decided.
    const search = await load('/search');
    expect(search.robotsHeader).toBe('noindex');
  });
});
