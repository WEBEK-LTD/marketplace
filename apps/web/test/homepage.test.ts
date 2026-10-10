import type { ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startBuiltApp, type RunningApp } from './support/next-server.js';
import { startStubApi, type StubApi } from './support/stub-api.js';

/**
 * The text a reader actually gets, with the markup taken out.
 *
 * 0110 sets a price as a composed figure — the currency code in a small raised mark, the amount large and
 * tabular — so "EGP 2500.00" is no longer one contiguous run in the HTML source: there is a `</span>` between
 * the code and the number, and React puts its own separator between adjacent text nodes. The invariant was
 * never about the markup, though. It is that the price **reads** as "EGP 2500.00" — to a person, to a screen
 * reader, and to anyone who copies it — and that is what this asserts.
 */
function textOf(html: string): string {
  return html
    .replace(/<!--.*?-->/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');
}




/**
 * The public homepage, over real HTTP against the built app (0093).
 *
 * What this suite exists to prove:
 *
 *   * **the composed homepage renders**, every served section type, in the order the API returned;
 *   * **a homepage nobody has composed still works** — the site name and the entry points that have always been
 *     there, rather than a blank page, and no claim that anything is broken;
 *   * **an outage is told apart from an uncomposed homepage**, because they are different facts;
 *   * **`/` is indexable** with a self-referencing canonical, and the robots *header* agrees with the meta tag —
 *     owner decision E, which needed both halves to change together;
 *   * **the blog highlights link to the blog** that 0092 built, which is what makes the two increments one site;
 *   * **`rich_text` is rendered as text**, with no markup interpreted (owner decision D);
 *   * **the homepage is still absent from the sitemap** (that decision was not made), and the redirect map is never
 *     consulted for it because it is a live address.
 *
 * No browser, no Playwright, no live provider, no deployment.
 */

/** Obviously fake, 43 base64url characters. */
const CANARY_CREDENTIAL = 'test-web-homepage-canary-notreal0123456789a';

const LISTING_CARD = {
  resultType: 'listing',
  slug: 'a-chair',
  title: 'A lovely chair',
  city: 'Cairo',
  priceMinor: '250000',
  currencyCode: 'EGP',
  currencyMinorUnit: 2,
  isNegotiable: true,
} as const;

const SECTIONS = [
  {
    sectionType: 'hero',
    sectionKey: 'home_hero',
    title: 'Welcome to the marketplace',
    subtitle: 'Everything, from everyone',
    hero: { lead: 'Find what you need.', ctaLabel: 'Browse listings', ctaPath: '/listings' },
  },
  {
    sectionType: 'featured_listings',
    sectionKey: 'home_picks',
    title: 'Our picks',
    subtitle: null,
    listings: [LISTING_CARD],
  },
  {
    sectionType: 'featured_categories',
    sectionKey: 'home_shelves',
    title: 'Shop by category',
    subtitle: null,
    categories: [{ slug: 'furniture', name: 'Furniture', listingTypeCode: null, icon: 'sofa' }],
  },
  {
    sectionType: 'featured_sellers',
    sectionKey: 'home_shops',
    title: 'Shops we like',
    subtitle: null,
    sellers: [{ slug: 'good-shop', displayName: 'Good Shop', city: 'Cairo', bio: 'A good shop.' }],
  },
  {
    sectionType: 'latest_listings',
    sectionKey: 'home_latest',
    title: 'Just listed',
    subtitle: null,
    listings: [
      { ...LISTING_CARD, slug: 'a-table', title: 'A sturdy table' },
      // A service priced on request: the ordinary shape of a listing with no amount.
      {
        ...LISTING_CARD,
        resultType: 'service',
        slug: 'some-help',
        title: 'Some help',
        priceMinor: null,
        isNegotiable: null,
      },
    ],
  },
  {
    sectionType: 'blog_highlights',
    sectionKey: 'home_blog',
    title: 'From the blog',
    subtitle: null,
    posts: [
      {
        slug: 'a-lovely-post',
        resolvedLocale: 'en',
        title: 'A Lovely Post',
        excerpt: 'Worth reading.',
        categorySlug: 'news',
        categoryName: 'Marketplace news',
        publishedAt: '2026-05-01T09:00:00.000Z',
      },
    ],
  },
  {
    sectionType: 'value_props',
    sectionKey: 'home_props',
    title: 'Why here',
    subtitle: null,
    items: [{ title: 'Every seller checked', body: 'We verify before anybody lists.' }],
  },
  {
    sectionType: 'rich_text',
    sectionKey: 'home_about',
    title: 'About us',
    subtitle: null,
    body: 'First line.\nSecond line, with <b>angle brackets</b> that are text.',
  },
] as const;

type Mode = 'composed' | 'empty' | 'unavailable';

let api: StubApi;
let app: RunningApp;
let mode: Mode;
let mapAnswers: ReadonlyMap<string, { toPath: string; statusCode: number }>;

function json(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function notFound(response: ServerResponse): void {
  response.writeHead(404, { 'content-type': 'application/problem+json' });
  response.end(JSON.stringify({ status: 404, code: 'NOT_FOUND' }));
}

function serveApi(): void {
  api.reply((request, response) => {
    const [pathname, search] = request.url.split('?');
    const path = pathname ?? '';

    if (path === '/v1/seo/redirects/resolve') {
      const asked = new URLSearchParams(search ?? '').get('path') ?? '';
      const answer = mapAnswers.get(asked);
      return json(response, answer === undefined ? { outcome: 'none' } : { outcome: 'redirect', ...answer });
    }

    if (path === '/v1/homepage') {
      if (mode === 'unavailable') {
        response.writeHead(503, { 'content-type': 'application/problem+json' });
        response.end(JSON.stringify({ status: 503, code: 'SERVICE_UNAVAILABLE' }));
        return;
      }
      return json(response, { sections: mode === 'empty' ? [] : SECTIONS });
    }

    return notFound(response);
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
  mode = 'composed';
  mapAnswers = new Map();
  serveApi();
});

interface Hit {
  readonly status: number;
  readonly html: string;
  readonly robotsHeader: string | null;
}

async function load(path: string): Promise<Hit> {
  const response = await fetch(`${app.baseUrl}${path}`, { redirect: 'manual' });
  return {
    status: response.status,
    html: await response.text(),
    robotsHeader: response.headers.get('x-robots-tag'),
  };
}

function meta(html: string, name: string): string | null {
  const match = new RegExp(`<meta name="${name}" content="([^"]*)"`).exec(html);
  return match?.[1] ?? null;
}

function canonical(html: string): string | null {
  const match = /<link rel="canonical" href="([^"]*)"/.exec(html);
  return match?.[1] ?? null;
}

/* ------------------------------------------------------------------------------------------------ */
/* The composed homepage                                                                             */
/* ------------------------------------------------------------------------------------------------ */

describe('a composed homepage', () => {
  it('renders every served section, in the order the API returned', async () => {
    const hit = await load('/');
    expect(hit.status).toBe(200);
    const positions = [
      'Welcome to the marketplace',
      'Our picks',
      'Shop by category',
      'Shops we like',
      'Just listed',
      'From the blog',
      'Why here',
      'About us',
    ].map((heading) => hit.html.indexOf(heading));
    // Every one present, and each after the one before it: the administrator's order, preserved to the page.
    expect(positions.every((at) => at >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('links each card to the surface that owns it', async () => {
    const hit = await load('/');
    expect(hit.html).toContain('href="/listing/a-chair"');
    expect(hit.html).toContain('href="/category/furniture"');
    expect(hit.html).toContain('href="/seller/good-shop"');
    // The blog that 0092 built, which is what makes the two increments one site.
    expect(hit.html).toContain('href="/blog/a-lovely-post"');
    expect(hit.html).toContain('href="/blog"');
  });

  it('formats a price from its own currencys minor unit, with the catalogues own words', async () => {
    const hit = await load('/');
    expect(textOf(hit.html)).toContain('EGP 2500.00');
    // The same component the browse list uses, so the negotiable badge appears here too.
    expect(hit.html).toContain('Negotiable');
  });

  it('says contact for price where a listing carries no amount, and never shows a zero', async () => {
    const hit = await load('/');
    expect(hit.html).toContain('Some help');
    expect(hit.html).toContain('Contact for price');
    // The defect this guards: a null amount coerced to '0' would advertise a free item on the front page.
    expect(textOf(hit.html)).not.toContain('EGP 0.00');
  });

  it('links a service card to the service surface and a listing card to the listing one', async () => {
    const hit = await load('/');
    expect(hit.html).toContain('href="/service/some-help"');
    expect(hit.html).toContain('href="/listing/a-table"');
  });

  it('renders the hero call to action as a link to a path on this site', async () => {
    const hit = await load('/');
    expect(hit.html).toContain('href="/listings"');
    expect(hit.html).toContain('Browse listings');
  });

  it('renders rich text as text, never as markup', async () => {
    const hit = await load('/');
    // Owner decision D: the angle brackets are the author's characters, so they are escaped rather than parsed.
    expect(hit.html).toContain('&lt;b&gt;angle brackets&lt;/b&gt;');
    expect(hit.html).not.toContain('<b>angle brackets</b>');
  });

  it('localises the Arabic homepage and links into the Arabic site', async () => {
    const hit = await load('/ar');
    expect(hit.status).toBe(200);
    expect(hit.html).toContain('dir="rtl"');
    expect(hit.html).toContain('href="/ar/listing/a-chair"');
    expect(hit.html).toContain('href="/ar/blog/a-lovely-post"');
  });

  it('marks a highlighted post with the language it was actually written in', async () => {
    const hit = await load('/ar');
    // A post written only in English, asked for in Arabic: the card says `lang="en"` rather than claiming Arabic.
    expect(hit.html).toContain('lang="en"');
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* Owner decision E — the homepage is indexable                                                      */
/* ------------------------------------------------------------------------------------------------ */

describe('the homepage is indexable', () => {
  it('says so in its metadata, and the header agrees', async () => {
    for (const path of ['/', '/ar']) {
      const hit = await load(path);
      expect(meta(hit.html, 'robots'), path).toBe('index, follow');
      // Both halves had to change together: a header is the most restrictive directive on a response, so a page
      // claiming to be indexable under a `noindex` header would be indexable nowhere.
      expect(hit.robotsHeader, path).toBeNull();
    }
  });

  it('carries a self-referencing canonical in each locale', async () => {
    expect(canonical((await load('/')).html)).toBe('/');
    expect(canonical((await load('/ar')).html)).toBe('/ar');
  });

  it('is indexable even when nothing has been composed', async () => {
    mode = 'empty';
    const hit = await load('/');
    // The fallback is a real page with real entry points, so there is nothing to hide from a crawler.
    expect(meta(hit.html, 'robots')).toBe('index, follow');
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* An uncomposed homepage, and an outage                                                             */
/* ------------------------------------------------------------------------------------------------ */

describe('a homepage nobody has composed', () => {
  it('still offers somewhere to go', async () => {
    mode = 'empty';
    const hit = await load('/');
    expect(hit.status).toBe(200);
    expect(hit.html).toContain('href="/listings"');
    expect(hit.html).toContain('href="/services"');
    expect(hit.html).toContain('href="/categories"');
  });

  it('does not claim anything is broken', async () => {
    mode = 'empty';
    const hit = await load('/');
    expect(hit.html).not.toContain('could not be loaded');
  });

  it('is told apart from an outage, which does say so', async () => {
    mode = 'unavailable';
    const hit = await load('/');
    expect(hit.status).toBe(200);
    // The same entry points, because a visitor needs somewhere to go either way — plus the admission.
    expect(hit.html).toContain('href="/listings"');
    expect(hit.html).toContain('could not be loaded');
  });

  it('refuses to be indexed while it is an outage, and is indexable otherwise', async () => {
    // The front page answers 200 and says what happened, which is right for a visitor. A crawler must not
    // take that admission for the page's content, so the read decides the robots value.
    mode = 'unavailable';
    expect(meta((await load('/')).html, 'robots') ?? '').toContain('noindex');

    // An uncomposed homepage is not a broken one — a fresh marketplace has a front page — so it stays
    // indexable, and so does a composed one.
    mode = 'empty';
    expect(meta((await load('/')).html, 'robots') ?? '').not.toContain('noindex');
    mode = 'composed';
    expect(meta((await load('/')).html, 'robots') ?? '').not.toContain('noindex');
  });

  it('renders the Arabic fallback with Arabic entry points', async () => {
    mode = 'empty';
    const hit = await load('/ar');
    expect(hit.html).toContain('href="/ar/listings"');
    expect(hit.html).toContain('dir="rtl"');
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* What the homepage still is not                                                                    */
/* ------------------------------------------------------------------------------------------------ */

describe('what 0093 did not change', () => {
  it('is advertised among the fixed routes rather than as a sitemap kind of its own (0097)', async () => {
    // 0093 made the homepage indexable and left sitemap membership open; owner decision 3 of 0097 settled it. The
    // homepage joined `indexableExactRoutes`, which the `route` child sitemap is built from — so there is still no
    // `home` kind and no child document named after it. The exact addresses it is advertised at are asserted in
    // `seo-routes.test.ts`, which is the suite booted with a production origin; this app has none, so every sitemap
    // here is a 404 and that is all this assertion can honestly check.
    const hit = await load('/sitemap.xml');
    expect(hit.status).toBe(404);
    expect(hit.html).not.toContain('/sitemaps/home');
  });

  it('never consults the redirect map, because the homepage is a live address', async () => {
    mapAnswers = new Map([['/', { toPath: '/listings', statusCode: 301 }]]);
    const hit = await load('/');
    expect(hit.status).toBe(200);
    expect(api.seen.some((entry) => entry.url.startsWith('/v1/seo/redirects/resolve'))).toBe(false);
  });

  it('asks the API for the homepage and its own route override, and nothing else', async () => {
    await load('/');
    // A closed inventory on purpose. The chrome read is 0094's navigation, which every public surface carries. The
    // override read is owner decision E keeping 0091's route-level support, and
    // `/` is a `route` entry so its stored canonical is honoured. Everything else is absent: owner decision A means
    // no promotion, package, placement or ranking is read anywhere on this page.
    expect([...new Set(api.seen.map((entry) => entry.url.split('?')[0]))].sort()).toEqual([
      '/v1/homepage',
      '/v1/navigation',
      '/v1/seo/metadata',
    ]);
    const override = api.seen.filter((entry) => entry.url.startsWith('/v1/seo/metadata'));
    expect(override).toHaveLength(1);
    expect(override[0]?.url).toContain(`routePath=${encodeURIComponent('/')}`);
    expect(override[0]?.url).not.toContain('entityType=');
  });

  it('serves no image from any section, because there is no media origin', async () => {
    const hit = await load('/');
    expect(hit.html).not.toContain('<img');
    expect(hit.html).not.toContain('cms-media/');
  });
});
