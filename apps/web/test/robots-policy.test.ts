import type { ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startBuiltApp, type RunningApp } from './support/next-server.js';
import { startStubApi, type StubApi } from './support/stub-api.js';

/**
 * The public catalogue robots policy, proved on the wire against the built app.
 *
 * Until now the whole web app sent `X-Robots-Tag: noindex` on every response. That was correct while
 * nothing public existed, but a header and a `<meta name="robots">` combine to the most restrictive of
 * the two, so the SEO metadata Phase 4-A and Phase 4-B render was being silently overridden: the
 * catalogue said "index" in the page and "noindex" on the wire, and a crawler obeys the wire.
 *
 * These tests are therefore about the *combination*, not about either half. For each route they assert
 * both what the response header says and what the page's own metadata says, because a page is indexable
 * only when neither of them forbids it. Anything not in the public catalogue must still be refused by the
 * header alone, whatever its page metadata happens to say.
 *
 * No browser and no live provider: the built app runs under `next start` against a stub API.
 */

/** Obviously fake, 43 base64url characters. */
const CANARY_CREDENTIAL = 'test-web-robots-canary-credential-not-realx';

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

/**
 * The card shape, which is **not** the detail shape.
 *
 * `ListingSummarySchema` is `.strict()` and carries nine fields; the browse list validates against it and a
 * body with the detail's extra fields is rejected, so a stub that answered the list with `LISTING` was
 * answering with something the reader throws away. That went unnoticed while nothing asserted more than the
 * robots value — the page rendered its unavailable region and still sent the header under test. It is a real
 * difference now that indexability depends on whether the read succeeded, which is the point of the fix: the
 * page says `noindex` precisely when it has nothing to show.
 */
const SUMMARY = {
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

/**
 * The stub answers the catalogue reads; anything else it is asked for is a test bug.
 *
 * `homepage: false` withholds the homepage composition alone, which is how the unreadable homepage is proved
 * without disturbing any other route.
 */
function serveListing(
  availability: 'available' | 'no_longer_available',
  options: { readonly homepage?: boolean } = {},
): void {
  const homepage = options.homepage ?? true;
  api.reply((request, response: ServerResponse) => {
    if (request.url.startsWith('/v1/listings/')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ listing: { ...LISTING, availability } }));
      return;
    }
    if (request.url.startsWith('/v1/listings')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ items: [SUMMARY], nextCursor: 'Y3Vyc29y' }));
      return;
    }
    if (request.url.startsWith('/v1/categories')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ categories: [] }));
      return;
    }
    if (homepage && request.url.startsWith('/v1/homepage')) {
      // An uncomposed homepage, which is a *successful* read of a site nobody has arranged yet: the page
      // falls back to its own entry points, which is content, so it is indexable.
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ sections: [] }));
      return;
    }
    response.writeHead(404).end();
  });
}

beforeEach(() => {
  serveListing('available');
});

interface Page {
  readonly status: number;
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
    robotsHeader: response.headers.get('x-robots-tag'),
    robotsMeta: meta === null ? null : (meta[1] ?? null),
    html,
  };
}

/** Indexable means nothing forbids it: no header, and no page-level `noindex`. */
function expectIndexable(page: Page, path: string): void {
  expect(page.robotsHeader, `${path} header`).toBeNull();
  expect(page.robotsMeta ?? '', `${path} meta`).not.toContain('noindex');
}

describe('the public catalogue is no longer globally noindex', () => {
  it.each(['/categories', '/ar/categories', '/listings', '/ar/listings'])(
    '%s sends no blanket robots header and no page-level noindex',
    async (path) => {
      const page = await load(path);
      expect(page.status).toBe(200);
      expectIndexable(page, path);
    },
  );

  it('the home page is indexable in both languages, and the header does not deny it', async () => {
    // Owner decision E (0093): `/` is explicitly indexable. The blanket header had to stop firing for it too, because
    // a header `noindex` is the most restrictive directive on the response and would silently overrule the page.
    //
    // This asserts the readable homepage. The earlier version of this test left `/v1/homepage` unanswered and
    // called the resulting `index, follow` the stricter proof — that indexability is a property of the route
    // rather than of whether a section came back. That reading is what the corrective fix overturns: a page whose
    // read failed renders an explanation of the failure, and a crawler must not be offered that explanation as
    // the page's content. The route-level claim is still proved — it is proved below, where `/` is `noindex`
    // only because the read failed and not because the route is refused, and where the header is still withheld.
    for (const path of ['/', '/ar']) {
      const page = await load(path);
      expect(page.status, path).toBe(200);
      expect(page.robotsHeader, path).toBeNull();
      expect(page.robotsMeta, path).toBe('index, follow');
    }
  });

  it('a home page that could not be read is noindex, follow — and still answers 200', async () => {
    // The other half of the pair above, and the assertion the corrective fix exists for. `follow`, not
    // `nofollow`: the fallback's entry points still lead to real pages, so a crawler should walk through them.
    serveListing('available', { homepage: false });
    for (const path of ['/', '/ar']) {
      const page = await load(path);
      expect(page.status, path).toBe(200);
      expect(page.robotsHeader, path).toBeNull();
      expect(page.robotsMeta, path).toBe('noindex, follow');
    }
  });

  it('a path that only begins with the home page is not the home page', async () => {
    // `/` is exempted by exact match, so the exemption cannot be widened by a prefix.
    for (const path of ['/nope', '/arabic', '/ar-nope']) {
      const page = await load(path);
      expect(page.robotsHeader, path).toBe('noindex');
    }
  });

  it('a listing that is available is indexable in both languages', async () => {
    for (const path of ['/listing/a-chair', '/ar/listing/a-chair']) {
      const page = await load(path);
      expect(page.status, path).toBe(200);
      expect(page.html, path).toContain('A chair');
      expectIndexable(page, path);
    }
  });
});

describe('page-level SEO policy still decides, and still says noindex where it should', () => {
  it('a cursor page of the browse list is noindex, follow', async () => {
    for (const path of ['/listings?cursor=Y3Vyc29y', '/ar/listings?cursor=Y3Vyc29y']) {
      const page = await load(path);
      expect(page.status, path).toBe(200);
      // The header is withheld, so the page's own metadata is the one that answers — and it refuses.
      expect(page.robotsHeader, path).toBeNull();
      expect(page.robotsMeta, path).toBe('noindex, follow');
    }
  });

  it('a listing that is no longer available is noindex, and still renders', async () => {
    serveListing('no_longer_available');
    const page = await load('/listing/a-chair');
    expect(page.status).toBe(200);
    expect(page.html).toContain('A chair');
    expect(page.robotsHeader).toBeNull();
    expect(page.robotsMeta ?? '').toContain('noindex');
  });

  it('a listing the public may not see is a real 404 and never indexable', async () => {
    api.reply((_request, response: ServerResponse) => {
      response.writeHead(404, { 'content-type': 'application/problem+json' });
      response.end(JSON.stringify({ status: 404, code: 'NOT_FOUND' }));
    });
    const page = await load('/listing/whatever');
    expect(page.status).toBe(404);
    expect(page.robotsMeta ?? '').toContain('noindex');
    expect(page.html).not.toContain('A chair');
  });
});

describe('everything outside the public catalogue keeps its blanket noindex', () => {
  it.each([
    '/login',
    '/ar/login',
    '/forgot-password',
    '/forgot-password/verify',
    '/reset-password',
    '/register',
    '/register/verify',
    '/ar/register',
    '/dashboard',
    '/dashboard/notifications',
    '/ar/dashboard/notifications',
    '/dashboard/settings',
    '/ar/dashboard/settings',
    '/dashboard/support',
    '/ar/dashboard/support',
    '/nope',
  ])('%s is refused by the header, whatever the page says', async (path) => {
    const page = await load(path);
    expect(page.robotsHeader, path).toBe('noindex');
  });

  it('a path that merely looks like a catalogue route is not treated as one', async () => {
    for (const path of [
      '/listingsomething',
      '/categories-secret',
      '/listing/a-chair/edit',
      // 0097 exempted the blog index and one slug-shaped segment beneath it, and nothing wider.
      '/blogsomething',
      '/blog-secret',
      '/blog/a-lovely-post/edit',
      '/blog/category/news',
      '/blog/tag/news',
    ]) {
      const page = await load(path);
      expect(page.robotsHeader, path).toBe('noindex');
    }
  });

  it('the catalogue exemption is by path, so it cannot be reached with a crafted one', async () => {
    // A traversal that resolves to a dashboard path must be judged on where it resolves, not how it reads.
    for (const path of ['/listing/..%2fdashboard', '/listings/../dashboard/settings']) {
      const page = await load(path);
      expect(page.robotsHeader, path).toBe('noindex');
    }
  });
});
