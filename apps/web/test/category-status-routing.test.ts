import type { ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startBuiltApp, type RunningApp } from './support/next-server.js';
import { startStubApi, type StubApi } from './support/stub-api.js';

/**
 * The public category landing page, over real HTTP against the built app (Phase 4-D).
 *
 * The 404 has to be a real one. Next.js 16 streams, so a `notFound()` inside the page would render the
 * right body under a 200 — the soft-404 already fixed for listings — and the category surface resolves
 * in the middleware for exactly that reason. These tests assert the status, the language, the document
 * head and the robots policy together, because a landing page is only correct when all four are.
 *
 * No browser, no Playwright, no live provider, no deployment.
 */

const CANARY_CREDENTIAL = 'test-web-cat-canary-credential-not-a-realxx';

const SEATING = { id: '22222222-2222-4222-8222-222222222222', slug: 'seating', name: 'Seating' } as const;
const TABLES = { id: '33333333-3333-4333-8333-333333333333', slug: 'tables', name: 'Tables' } as const;

const FURNITURE = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'furniture',
  name: 'Furniture',
  description: 'Everything for the home.',
  parent: null,
  children: [SEATING, TABLES],
} as const;

const SEO = {
  metaTitle: 'Furniture | Marketplace',
  metaDescription: 'Browse furniture on the marketplace.',
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

/** The API as it behaves for this fixture: one root with two children, one childless leaf. */
function apiServesCategories(): void {
  api.reply((request, response) => {
    const [path, query = ''] = request.url.split('?');
    const arabic = query.includes('locale=ar');

    if (path === '/v1/categories/furniture') {
      return json(response, {
        category: arabic
          ? { ...FURNITURE, name: 'أثاث', description: 'كل ما يخص المنزل.' }
          : FURNITURE,
        seo: arabic ? { metaTitle: 'أثاث | السوق', metaDescription: 'تصفح الأثاث.' } : SEO,
      });
    }
    if (path === '/v1/categories/seating') {
      return json(response, {
        category: {
          ...SEATING,
          description: null,
          parent: { id: FURNITURE.id, slug: FURNITURE.slug, name: FURNITURE.name },
          children: [],
        },
        seo: { metaTitle: null, metaDescription: null },
      });
    }
    if (path === '/v1/categories') return json(response, { categories: [] });
    return notFound(response);
  });
}

beforeEach(() => {
  api.seen.length = 0;
  apiServesCategories();
});

interface Page {
  readonly status: number;
  readonly robotsHeader: string | null;
  readonly robotsMeta: string | null;
  readonly title: string | null;
  readonly description: string | null;
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
    description: pick(/<meta name="description" content="([^"]*)"\/?>/),
    canonical: pick(/<link rel="canonical" href="([^"]*)"\/?>/),
    alternates: [...html.matchAll(/<link rel="alternate" hrefLang="([^"]*)" href="([^"]*)"\/?>/g)].map(
      (m) => `${m[1]}=${m[2]}`,
    ),
    html,
  };
}

describe('a valid category', () => {
  it('answers 200 and renders its name, description and children', async () => {
    const page = await load('/category/furniture');
    expect(page.status).toBe(200);
    expect(page.html).toContain('Furniture');
    expect(page.html).toContain('Everything for the home.');
    expect(page.html).toContain('Seating');
    expect(page.html).toContain('Tables');
  });

  it('links each child to its own landing page', async () => {
    const page = await load('/category/furniture');
    expect(page.html).toContain('href="/category/seating"');
    expect(page.html).toContain('href="/category/tables"');
  });

  it('renders in Arabic under /ar, right-to-left, with Arabic child links', async () => {
    const page = await load('/ar/category/furniture');
    expect(page.status).toBe(200);
    expect(page.html).toContain('<html lang="ar" dir="rtl">');
    expect(page.html).toContain('أثاث');
    expect(page.html).toContain('href="/ar/category/seating"');
  });

  it('names its parent when it has one', async () => {
    const page = await load('/category/seating');
    expect(page.status).toBe(200);
    expect(page.html).toContain('href="/category/furniture"');
  });
});

describe('a valid category with no children', () => {
  it('is still a 200, still indexable, and says so in words', async () => {
    const page = await load('/category/seating');
    expect(page.status).toBe(200);
    expect(page.robotsHeader).toBeNull();
    expect(page.robotsMeta ?? '').not.toContain('noindex');
    expect(page.html).toContain('No subcategories are available.');
  });

  it('says it in Arabic too', async () => {
    const page = await load('/ar/category/seating');
    expect(page.status).toBe(200);
    expect(page.html).toContain('لا توجد فئات فرعية متاحة.');
  });
});

describe('the document head', () => {
  it('uses the admin meta title and description when there are any', async () => {
    const page = await load('/category/furniture');
    expect(page.title).toBe('Furniture | Marketplace');
    expect(page.description).toBe('Browse furniture on the marketplace.');
  });

  it('falls back to the category name and description when there are none', async () => {
    const page = await load('/category/seating');
    expect(page.title).toBe('Seating');
    // Seating has no description either, so there is no description meta rather than an invented one.
    expect(page.description).toBeNull();
  });

  it('carries a self-referencing canonical and both hreflang alternates', async () => {
    const english = await load('/category/furniture');
    expect(english.canonical).toBe('/category/furniture');
    expect(english.alternates).toEqual(['en=/category/furniture', 'ar=/ar/category/furniture']);

    const arabic = await load('/ar/category/furniture');
    expect(arabic.canonical).toBe('/ar/category/furniture');
  });

  it('never hands the document-head fields to the client', async () => {
    // The `seo` object reaches `generateMetadata` and nothing else, so its field names appear nowhere in
    // the document — not in the markup and not in the serialized payload the client hydrates from.
    const page = await load('/category/furniture');
    expect(page.html).not.toContain('metaTitle');
    expect(page.html).not.toContain('metaDescription');
  });
});

describe('a category the public may not see', () => {
  it('is a real 404, not a soft one', async () => {
    const page = await load('/category/retired');
    expect(page.status).toBe(404);
  });

  it('is a real 404 in Arabic too, with the localized view', async () => {
    const page = await load('/ar/category/retired');
    expect(page.status).toBe(404);
    expect(page.html).toContain('<html lang="ar" dir="rtl">');
    expect(page.html).toContain('الفئة غير موجودة');
  });

  it('is noindex, and says nothing about why', async () => {
    const page = await load('/category/retired');
    expect(page.robotsMeta ?? '').toContain('noindex');
    for (const leak of ['inactive', 'is_active', 'Furniture']) {
      expect(page.html, leak).not.toContain(leak);
    }
  });

  it('asks its own reader exactly once, and consults the redirect map once', async () => {
    api.seen.length = 0;
    await load('/category/retired');
    // Still one read of this surface: the page does not read again behind the middleware's decision.
    expect(api.seen.map((s) => s.url).filter((url) => url.startsWith('/v1/categories/'))).toEqual([
      '/v1/categories/retired?locale=en',
    ]);
    // And exactly one more call, which is 8-E's redirect map being consulted — a path that would answer 404 is
    // precisely when it may be, and the answer here leaves the 404 alone.
    expect(
      api.seen.map((s) => s.url).filter((url) => url.startsWith('/v1/seo/redirects/resolve')),
    ).toHaveLength(1);
    // And nothing else of this page's own: 0094's composed chrome is one further read on every public surface,
    // which is counted out here rather than left to make this inventory look open.
    expect(api.seen.filter((entry) => !entry.url.startsWith('/v1/navigation'))).toHaveLength(2);
  });
});

describe('the robots policy covers the category surface', () => {
  it('/category/[slug] is not globally noindex', async () => {
    for (const path of ['/category/furniture', '/ar/category/furniture', '/category/seating']) {
      const page = await load(path);
      expect(page.robotsHeader, path).toBeNull();
      expect(page.robotsMeta ?? '', path).not.toContain('noindex');
    }
  });

  it('a lookalike or traversal path cannot claim the category exemption', async () => {
    for (const path of [
      '/categoryfoo',
      '/category/furniture/edit',
      '/category/Furniture',
      '/category/..%2Fdashboard',
    ]) {
      const page = await load(path);
      expect(page.robotsHeader, path).toBe('noindex');
      expect(page.html, path).not.toContain('Everything for the home.');
    }
  });

  it('leaves the Phase 4-A tree page alone', async () => {
    const page = await load('/categories');
    expect(page.status).toBe(200);
    expect(page.robotsHeader).toBeNull();
  });
});

describe('the internal boundary', () => {
  it('reaches the API with the internal credential and no browser cookie', async () => {
    api.seen.length = 0;
    await load('/ar/category/furniture');
    const first = api.seen[0];
    expect(first?.url).toBe('/v1/categories/furniture?locale=ar');
    expect(first?.credential).toBe(CANARY_CREDENTIAL);
    expect(first?.cookie).toBeNull();
  });

  it('never exposes the internal credential to the browser', async () => {
    const page = await load('/category/furniture');
    expect(page.html).not.toContain(CANARY_CREDENTIAL);
  });
});
