import type { ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startBuiltApp, type RunningApp } from './support/next-server.js';
import { startStubApi, type StubApi } from './support/stub-api.js';

/**
 * The HTTP status of a listing detail request (Phase 4-B status correction).
 *
 * The page cannot decide this. Next.js 16 streams, so once the page component has awaited anything the
 * shell and its status line are already on the wire; `permanentRedirect` and `notFound` called from there
 * render the right body under a `200`. The decision therefore moved to the middleware, which resolves the
 * slug through the same `readListing` contract the BFF route uses — same internal API, same internal
 * credential, no second data path — and issues a real `301` or a real `404` before anything renders.
 *
 * What these tests hold to account is the *status*, because that is what was wrong and what no unit test
 * of the decision function can prove. They run the built app under `next start` against a stub API: no
 * browser, no Playwright, no live provider, no deployment.
 */

/** Obviously fake, 43 base64url characters. */
const CANARY_CREDENTIAL = 'test-web-status-canary-credential-not-realx';

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

/** The API answers as it really does for each listing state. */
function apiAnswers(kind: 'found' | 'sold' | 'moved' | 'not_found' | 'down'): void {
  api.reply((_request, response: ServerResponse) => {
    if (kind === 'moved') {
      response.writeHead(301, {
        location: '/v1/listings/a-chair',
        'x-canonical-slug': 'a-chair',
        'x-canonical-type': 'product',
      });
      response.end();
      return;
    }
    if (kind === 'not_found') {
      response.writeHead(404, { 'content-type': 'application/problem+json' });
      response.end(JSON.stringify({ status: 404, code: 'NOT_FOUND' }));
      return;
    }
    if (kind === 'down') {
      response.writeHead(503, { 'content-type': 'application/problem+json' });
      response.end(JSON.stringify({ status: 503, code: 'SERVICE_UNAVAILABLE' }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        listing: { ...LISTING, availability: kind === 'sold' ? 'no_longer_available' : 'available' },
      }),
    );
  });
}

beforeEach(() => {
  api.seen.length = 0;
  apiAnswers('found');
});

interface Page {
  readonly status: number;
  readonly location: string | null;
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
    robotsMeta: meta === null ? null : (meta[1] ?? null),
    html,
  };
}

describe('a listing that is live at its current slug', () => {
  it('answers 200 and renders the listing', async () => {
    const page = await load('/listing/a-chair');
    expect(page.status).toBe(200);
    expect(page.location).toBeNull();
    expect(page.html).toContain('A chair');
  });

  it('answers 200 in Arabic too', async () => {
    const page = await load('/ar/listing/a-chair');
    expect(page.status).toBe(200);
    expect(page.html).toContain('A chair');
    expect(page.html).toContain('<html lang="ar" dir="rtl">');
  });

  it('stays indexable', async () => {
    const page = await load('/listing/a-chair');
    expect(page.robotsMeta ?? '').not.toContain('noindex');
  });
});

describe('a previous slug', () => {
  it('answers 301 with a Location on the current slug', async () => {
    apiAnswers('moved');
    const page = await load('/listing/old-slug');
    expect(page.status).toBe(301);
    expect(page.location).toBe('/listing/a-chair');
  });

  it('keeps the locale it was asked in', async () => {
    apiAnswers('moved');
    const page = await load('/ar/listing/old-slug');
    expect(page.status).toBe(301);
    expect(page.location).toBe('/ar/listing/a-chair');
  });

  it('sends no body that could be mistaken for the listing', async () => {
    apiAnswers('moved');
    const page = await load('/listing/old-slug');
    expect(page.html).not.toContain('A chair');
  });
});

describe('a listing the public may not see', () => {
  // Nonexistent, draft, pending, rejected, deleted and suspended-seller listings are one case on the
  // wire: the API answers 404 for all of them, and so does this.
  it('answers 404 for a slug that names nothing', async () => {
    apiAnswers('not_found');
    const page = await load('/listing/nothing-here');
    expect(page.status).toBe(404);
  });

  it('answers 404 for a non-public listing, in both languages', async () => {
    apiAnswers('not_found');
    for (const path of ['/listing/hidden-one', '/ar/listing/hidden-one']) {
      const page = await load(path);
      expect(page.status, path).toBe(404);
    }
  });

  it('renders the localized not-found view under that status', async () => {
    apiAnswers('not_found');
    const english = await load('/listing/hidden-one');
    expect(english.html).toContain('<html lang="en" dir="ltr">');
    expect(english.html).toContain('Listing not found');

    const arabic = await load('/ar/listing/hidden-one');
    expect(arabic.html).toContain('<html lang="ar" dir="rtl">');
    expect(arabic.html).toContain('الإعلان غير موجود');
  });

  it('is noindex, and says nothing about why', async () => {
    apiAnswers('not_found');
    const page = await load('/listing/hidden-one');
    expect(page.robotsMeta ?? '').toContain('noindex');
    for (const leak of ['draft', 'suspended', 'rejected', 'pending', 'seller_user_id', 'A chair']) {
      expect(page.html, leak).not.toContain(leak);
    }
  });

  it('asks its own reader exactly once, and consults the redirect map once', async () => {
    apiAnswers('not_found');
    api.seen.length = 0;
    await load('/listing/hidden-one');
    // Still one read of this surface: the page does not read again behind the middleware's decision.
    expect(api.seen.map((s) => s.url).filter((url) => url.startsWith('/v1/listings/'))).toEqual([
      '/v1/listings/hidden-one?locale=en',
    ]);
    // And exactly one more call, which is 8-E's redirect map being consulted — a path that would answer 404 is
    // precisely when it may be, and the answer here leaves the 404 alone.
    expect(
      api.seen.map((s) => s.url).filter((url) => url.startsWith('/v1/seo/redirects/resolve')),
    ).toHaveLength(1);
    expect(api.seen).toHaveLength(2);
  });
});

describe('a listing that is no longer available', () => {
  it('stays a 200 with its content, and stays noindex', async () => {
    apiAnswers('sold');
    const page = await load('/listing/a-chair');
    expect(page.status).toBe(200);
    expect(page.html).toContain('A chair');
    expect(page.html).toContain('No longer available');
    expect(page.robotsMeta ?? '').toContain('noindex');
  });
});

describe('when the catalogue cannot be read', () => {
  it('does not turn an outage into a 404', async () => {
    apiAnswers('down');
    const page = await load('/listing/a-chair');
    expect(page.status).not.toBe(404);
    expect(page.status).not.toBe(301);
    expect(page.html).toContain("We couldn't load the listings.");
  });
});

describe('the resolution reaches the API the way the BFF does', () => {
  it('carries the internal credential and the locale, and nothing else', async () => {
    await load('/ar/listing/a-chair');
    const first = api.seen[0];
    expect(first?.method).toBe('GET');
    expect(first?.url).toBe('/v1/listings/a-chair?locale=ar');
    expect(first?.credential).toBe(CANARY_CREDENTIAL);
    // No browser cookie is forwarded: this read is the same for everyone.
    expect(first?.cookie).toBeNull();
  });

  it('never exposes the internal credential to the browser', async () => {
    const page = await load('/listing/a-chair');
    expect(page.html).not.toContain(CANARY_CREDENTIAL);
  });
});

describe('paths that are not listing detail pages are not resolved as one', () => {
  it('does not resolve a lookalike or a deeper path as a listing', async () => {
    for (const path of ['/listings', '/listingsomething', '/listing/a-chair/edit', '/listing', '/categories']) {
      apiAnswers('moved');
      const page = await load(path);
      // The middleware never classified these as listing detail, so its redirect cannot fire for them.
      expect(page.status, path).not.toBe(301);
      expect(page.location, path).toBeNull();
    }
  });

  it('refuses a traversal or an encoded separator instead of treating it as a slug', async () => {
    // A slug is `[a-z0-9][a-z0-9-]*`. Anything else is not a listing path, so it reaches neither the
    // redirect nor the catalogue robots exemption, and it certainly does not reach what it names.
    apiAnswers('moved');
    for (const path of ['/listing/..%2Fdashboard', '/listing/a-chair%2Fedit', '/listing/A-Chair']) {
      const response = await fetch(`${app.baseUrl}${path}`, { redirect: 'manual' });
      const html = await response.text();
      expect(response.status, path).not.toBe(301);
      expect(response.headers.get('location'), path).toBeNull();
      expect(response.headers.get('x-robots-tag'), path).toBe('noindex');
      expect(html, path).not.toContain('A chair');
    }
  });

  it('lets a traversal that resolves into the signed-in area be governed by that area, not by this one', async () => {
    // `/listing/../dashboard` is normalised to `/dashboard` before it reaches the server, so what
    // answers it is the Phase 5-A protection: a visitor with no session is sent to sign in. The point
    // this file cares about still holds — it is never treated as a listing slug, never a 301 to a
    // canonical listing, and never renders listing content.
    apiAnswers('moved');
    const response = await fetch(`${app.baseUrl}/listing/../dashboard`, { redirect: 'manual' });
    const html = await response.text();

    expect(response.status).not.toBe(301);
    expect(response.headers.get('location')).toContain('/login');
    expect(response.headers.get('x-robots-tag')).toBe('noindex');
    expect(html).not.toContain('A chair');
  });

  it('ignores a catalogue outcome header supplied by the browser', async () => {
    // Forging it must not be able to turn a live listing into a 404.
    const response = await fetch(`${app.baseUrl}/listing/a-chair`, {
      redirect: 'manual',
      headers: { 'x-catalog-outcome': 'not_found' },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('A chair');
  });
});

describe('the contact action (Phase 5-E)', () => {
  it('offers to message the seller about a live listing', async () => {
    apiAnswers('found');
    const page = await load('/listing/a-chair');
    expect(page.html).toContain('Message seller');
  });

  it('offers nothing about a listing that is no longer available', async () => {
    apiAnswers('sold');
    const page = await load('/listing/a-chair');
    expect(page.html).not.toContain('Message seller');
  });

  it('carries the action in Arabic', async () => {
    apiAnswers('found');
    const page = await load('/ar/listing/a-chair');
    expect(page.html).toContain('مراسلة البائع');
  });
});
