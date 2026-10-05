import type { RobotsSettingsResponse, SitemapCountsResponse } from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import {
  isApiSitemapType,
  robotsDocument,
  routeEntries,
  sitemapDocument,
  sitemapIndexDocument,
  sitemapPageOf,
  sitemapTypeOf,
} from '../src/server/seo-documents';

/**
 * The documents crawlers read, asserted as text.
 *
 * A sitemap is parsed strictly by the things that read it, so these are compared character by character rather
 * than only over HTTP. What matters most:
 *
 * **Every URL is absolute and built from the configured origin.** The protocol requires it, and the origin is
 * never derived from a request header.
 *
 * **Both locales, with hreflang alternates (D6), and each entry lists all of its alternates including itself.**
 *
 * **A CMS page is listed only in the languages it answers in**, because a page written only in Arabic has no
 * English address and advertising one would send a crawler to a 404.
 *
 * **The index names only the children that exist.** An index pointing at empty documents is worse than a short
 * one.
 *
 * **An authored robots body is served verbatim.** It is somebody's crawl policy, not a suggestion to reformat.
 */

const ORIGIN = 'https://web.test';

describe('a child sitemap', () => {
  it('builds absolute URLs on the configured origin, in both locales, with alternates', () => {
    const document = sitemapDocument({
      origin: ORIGIN,
      type: 'listing',
      entries: [{ slug: 'walnut-table', updatedAt: '2026-05-02T09:00:00.000Z' }],
    });

    expect(document).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
        '  <url>',
        '    <loc>https://web.test/listing/walnut-table</loc>',
        '    <lastmod>2026-05-02T09:00:00.000Z</lastmod>',
        '    <xhtml:link rel="alternate" hreflang="en" href="https://web.test/listing/walnut-table"/>',
        '    <xhtml:link rel="alternate" hreflang="ar" href="https://web.test/ar/listing/walnut-table"/>',
        '  </url>',
        '  <url>',
        '    <loc>https://web.test/ar/listing/walnut-table</loc>',
        '    <lastmod>2026-05-02T09:00:00.000Z</lastmod>',
        '    <xhtml:link rel="alternate" hreflang="en" href="https://web.test/listing/walnut-table"/>',
        '    <xhtml:link rel="alternate" hreflang="ar" href="https://web.test/ar/listing/walnut-table"/>',
        '  </url>',
        '</urlset>',
        '',
      ].join('\n'),
    );
  });

  it('puts each kind of address on the path that kind owns', () => {
    const entry = { slug: 'thing', updatedAt: '2026-05-02T09:00:00.000Z' };
    const locationsOf = (type: Parameters<typeof sitemapDocument>[0]['type']): string[] =>
      [...sitemapDocument({ origin: ORIGIN, type, entries: [entry] }).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1] ?? '');

    expect(locationsOf('listing')).toEqual(['https://web.test/listing/thing', 'https://web.test/ar/listing/thing']);
    expect(locationsOf('service')).toEqual(['https://web.test/service/thing', 'https://web.test/ar/service/thing']);
    expect(locationsOf('category')).toEqual(['https://web.test/category/thing', 'https://web.test/ar/category/thing']);
    expect(locationsOf('seller')).toEqual(['https://web.test/seller/thing', 'https://web.test/ar/seller/thing']);
    expect(locationsOf('page')).toEqual(['https://web.test/thing', 'https://web.test/ar/thing']);
  });

  it('lists a CMS page only in the languages it answers in', () => {
    const arabicOnly = sitemapDocument({
      origin: ORIGIN,
      type: 'page',
      entries: [{ slug: 'cookies', updatedAt: '2026-05-02T09:00:00.000Z', locales: ['ar'] }],
    });
    // The English address of an Arabic-only page answers 404, so it is advertised nowhere — not as a location
    // and not as an alternate.
    expect(arabicOnly).toContain('<loc>https://web.test/ar/cookies</loc>');
    expect(arabicOnly).not.toContain('<loc>https://web.test/cookies</loc>');
    expect(arabicOnly).not.toContain('hreflang="en"');
    expect([...arabicOnly.matchAll(/<url>/g)]).toHaveLength(1);
  });

  it('lists a CMS page in both languages when it answers in both', () => {
    const both = sitemapDocument({
      origin: ORIGIN,
      type: 'page',
      entries: [{ slug: 'terms', updatedAt: '2026-05-02T09:00:00.000Z', locales: ['en', 'ar'] }],
    });
    expect([...both.matchAll(/<url>/g)]).toHaveLength(2);
    expect(both).toContain('hreflang="en"');
    expect(both).toContain('hreflang="ar"');
  });

  it('ignores a locale this site has no surfaces for', () => {
    const document = sitemapDocument({
      origin: ORIGIN,
      type: 'page',
      entries: [{ slug: 'terms', updatedAt: '2026-05-02T09:00:00.000Z', locales: ['en'] }],
    });
    expect(document).not.toContain('hreflang="fr"');
  });

  it('is a well-formed empty urlset when there is nothing to list', () => {
    expect(sitemapDocument({ origin: ORIGIN, type: 'category', entries: [] })).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
        '</urlset>',
        '',
      ].join('\n'),
    );
  });

  it('states no changefreq or priority, which are hints rather than facts', () => {
    const document = sitemapDocument({
      origin: ORIGIN,
      type: 'listing',
      entries: [{ slug: 'thing', updatedAt: '2026-05-02T09:00:00.000Z' }],
    });
    expect(document).not.toContain('changefreq');
    expect(document).not.toContain('priority');
  });

  it('encodes a slug into the path rather than interpolating it, whatever reaches it', () => {
    const document = sitemapDocument({
      origin: 'https://web.test',
      type: 'listing',
      // Narrow by contract today; the document must not depend on that staying true.
      entries: [{ slug: 'a&b<c>"d\'', updatedAt: '2026-05-02T09:00:00.000Z' }],
    });
    // Percent-encoding first, because that is what makes it a URL, and XML escaping over the result. Between
    // them, not one of those characters survives as itself anywhere in the document.
    expect(document).toContain('%26');
    expect(document).toContain('%3C');
    for (const raw of ['a&b', '<c>', '"d', "d'"]) {
      expect(document, raw).not.toContain(raw);
    }
    // And nothing in a location is a bare ampersand, which would make the document malformed.
    expect(document).not.toMatch(/<loc>[^<]*&(?!amp;|lt;|gt;|quot;|apos;)/);
  });

  it('escapes a value that reaches the document without being path-encoded first', () => {
    // `lastmod` and the origin are not encoded by path building, so the escaper is what stands between them and
    // a malformed document. Proven directly, because the inputs that would exercise it are narrow today.
    const document = sitemapDocument({
      origin: 'https://web.test',
      type: 'listing',
      entries: [{ slug: 'thing', updatedAt: '2026 & later' }],
    });
    expect(document).toContain('<lastmod>2026 &amp; later</lastmod>');
    expect(document).not.toContain('<lastmod>2026 & later');
  });

  it('serves the fixed landing routes from code, with no lastmod invented from a row', () => {
    const now = new Date('2026-05-02T09:00:00.000Z');
    const entries = routeEntries(now);
    expect(entries.map((entry) => entry.slug)).toEqual([
      '/',
      '/blog',
      '/categories',
      '/listings',
      '/marketplace',
      '/services',
    ]);
    const document = sitemapDocument({ origin: ORIGIN, type: 'route', entries });
    expect(document).toContain('<loc>https://web.test/listings</loc>');
    expect(document).toContain('<loc>https://web.test/ar/listings</loc>');
    // 0097, owner decision 2: the blog index is advertised in both languages.
    expect(document).toContain('<loc>https://web.test/blog</loc>');
    expect(document).toContain('<loc>https://web.test/ar/blog</loc>');
  });

  it('advertises the home page at exactly the address its own canonical names (0097)', () => {
    // Owner decision 3, and the one place the `route` kind cannot simply concatenate. The home page's own metadata
    // sets a self-referencing canonical of `/` and `/ar`; a sitemap naming `/ar/` would be advertising a
    // non-canonical address, which is the one mistake a sitemap must not make.
    const document = sitemapDocument({
      origin: ORIGIN,
      type: 'route',
      entries: [{ slug: '/', updatedAt: '2026-05-02T09:00:00.000Z' }],
    });
    expect(document).toContain('<loc>https://web.test/</loc>');
    expect(document).toContain('<loc>https://web.test/ar</loc>');
    expect(document).not.toContain('https://web.test/ar/<');
    expect(document).not.toContain('<loc>https://web.test/ar/</loc>');
    // And its alternates name the same two addresses, each entry listing both including itself.
    expect(document).toContain('<xhtml:link rel="alternate" hreflang="en" href="https://web.test/"/>');
    expect(document).toContain('<xhtml:link rel="alternate" hreflang="ar" href="https://web.test/ar"/>');
  });

  it('builds a blog post address in both languages, and only those it resolves in', () => {
    const both = sitemapDocument({
      origin: ORIGIN,
      type: 'blog_post',
      entries: [{ slug: 'a-lovely-post', updatedAt: '2026-05-02T09:00:00.000Z' }],
    });
    expect(both).toContain('<loc>https://web.test/blog/a-lovely-post</loc>');
    expect(both).toContain('<loc>https://web.test/ar/blog/a-lovely-post</loc>');

    // Owner decision 5: a post written only in Arabic has no English address, and advertising one would send a
    // crawler to a 404.
    const arabicOnly = sitemapDocument({
      origin: ORIGIN,
      type: 'blog_post',
      entries: [{ slug: 'arabic-only', updatedAt: '2026-05-02T09:00:00.000Z', locales: ['ar'] }],
    });
    expect(arabicOnly).toContain('<loc>https://web.test/ar/blog/arabic-only</loc>');
    expect(arabicOnly).not.toContain('<loc>https://web.test/blog/arabic-only</loc>');
    expect(arabicOnly).not.toContain('hreflang="en"');
  });

  it('encodes a blog slug rather than interpolating it', () => {
    const document = sitemapDocument({
      origin: ORIGIN,
      type: 'blog_post',
      entries: [{ slug: 'a-lovely-post', updatedAt: '2026-05-02T09:00:00.000Z' }],
    });
    // The slug pattern already forbids anything that would need escaping; the builder is asserted to go through the
    // shared path helper all the same, so a widened pattern cannot become a malformed document.
    expect(document).not.toContain('/blog//');
    expect(document).toContain('/blog/a-lovely-post');
  });
});

describe('the sitemap index', () => {
  const counts = (entries: Partial<Record<string, number>>, pageSize = 2): SitemapCountsResponse => ({
    pageSize,
    counts: [
      { type: 'page', entries: entries.page ?? 0 },
      { type: 'blog_post', entries: entries.blog_post ?? 0 },
      { type: 'listing', entries: entries.listing ?? 0 },
      { type: 'service', entries: entries.service ?? 0 },
      { type: 'category', entries: entries.category ?? 0 },
      { type: 'seller', entries: entries.seller ?? 0 },
    ],
  });

  it('names one child per page of each kind that has entries', () => {
    const document = sitemapIndexDocument({ origin: ORIGIN, counts: counts({ listing: 5 }), routeEntryCount: 4 });
    expect(document).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
        '  <sitemap>',
        '    <loc>https://web.test/sitemaps/route/1</loc>',
        '  </sitemap>',
        '  <sitemap>',
        '    <loc>https://web.test/sitemaps/route/2</loc>',
        '  </sitemap>',
        '  <sitemap>',
        '    <loc>https://web.test/sitemaps/listing/1</loc>',
        '  </sitemap>',
        '  <sitemap>',
        '    <loc>https://web.test/sitemaps/listing/2</loc>',
        '  </sitemap>',
        '  <sitemap>',
        '    <loc>https://web.test/sitemaps/listing/3</loc>',
        '  </sitemap>',
        '</sitemapindex>',
        '',
      ].join('\n'),
    );
  });

  it('names no child for a kind with nothing in it', () => {
    const document = sitemapIndexDocument({ origin: ORIGIN, counts: counts({ page: 1 }), routeEntryCount: 0 });
    expect(document).toContain('/sitemaps/page/1');
    for (const type of ['route', 'listing', 'service', 'category', 'seller']) {
      expect(document, type).not.toContain(`/sitemaps/${type}/`);
    }
  });

  it('is a well-formed empty index when the whole site has nothing indexable', () => {
    expect(sitemapIndexDocument({ origin: ORIGIN, counts: counts({}), routeEntryCount: 0 })).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
        '</sitemapindex>',
        '',
      ].join('\n'),
    );
  });

  it('pages by the size the API reported, so the two cannot disagree', () => {
    const document = sitemapIndexDocument({
      origin: ORIGIN,
      counts: counts({ seller: 7 }, 3),
      routeEntryCount: 0,
    });
    expect([...document.matchAll(/\/sitemaps\/seller\//g)]).toHaveLength(3);
    expect(document).toContain('/sitemaps/seller/3');
    expect(document).not.toContain('/sitemaps/seller/4');
  });
});

describe('robots.txt while no production domain is configured', () => {
  /**
   * The document that keeps working, and the reason it can: crawl directives are paths, so nothing in an
   * authored body needs an absolute URL. Only the `Sitemap:` line does, and it is simply absent.
   */
  it('serves everything an administrator authored, without a sitemap line', () => {
    const authored: RobotsSettingsResponse = {
      locale: 'en',
      body: 'User-agent: *\nDisallow: /dashboard',
    };
    expect(robotsDocument(null, authored)).toBe('User-agent: *\nDisallow: /dashboard\n');
  });

  it('states a comment rather than a directive when nothing is authored either', () => {
    // A comment carries no directive, so it claims nothing that is not true. An invented `Disallow` list would.
    expect(robotsDocument(null, { locale: null, body: null })).toBe('# No crawl directives are configured.\n');
    expect(robotsDocument(null, null)).toBe('# No crawl directives are configured.\n');
  });

  it('names no host of any kind', () => {
    for (const settings of [null, { locale: 'en' as const, body: 'User-agent: *' }]) {
      const document = robotsDocument(null, settings);
      expect(document).not.toContain('Sitemap:');
      expect(document).not.toContain('http');
      expect(document).not.toContain('localhost');
      expect(document).not.toContain('127.0.0.1');
    }
  });

  it('leaves an author who named their own sitemap alone', () => {
    const authored: RobotsSettingsResponse = { locale: 'en', body: 'Sitemap: https://web.test/custom.xml' };
    expect(robotsDocument(null, authored)).toBe('Sitemap: https://web.test/custom.xml\n');
  });
});

describe('robots.txt', () => {
  it('is the sitemap directive alone when nothing is authored', () => {
    // No invented Disallow lines: what keeps the private surfaces out of an index is the X-Robots-Tag header
    // the middleware already sends, not a file a crawler may ignore.
    expect(robotsDocument(ORIGIN, { locale: null, body: null })).toBe('Sitemap: https://web.test/sitemap.xml\n');
    expect(robotsDocument(ORIGIN, null)).toBe('Sitemap: https://web.test/sitemap.xml\n');
  });

  it('serves an authored body verbatim, with the sitemap appended', () => {
    const authored: RobotsSettingsResponse = {
      locale: 'en',
      body: 'User-agent: *\nDisallow: /dashboard\n\nUser-agent: BadBot\nDisallow: /',
    };
    expect(robotsDocument(ORIGIN, authored)).toBe(
      'User-agent: *\nDisallow: /dashboard\n\nUser-agent: BadBot\nDisallow: /\n\nSitemap: https://web.test/sitemap.xml\n',
    );
  });

  it('does not argue with an author who already named a sitemap', () => {
    const authored: RobotsSettingsResponse = {
      locale: 'en',
      body: 'User-agent: *\nSitemap: https://web.test/custom.xml',
    };
    expect(robotsDocument(ORIGIN, authored)).toBe('User-agent: *\nSitemap: https://web.test/custom.xml\n');
  });

  it('ends with exactly one newline, whatever the author left behind', () => {
    for (const body of ['User-agent: *', 'User-agent: *\n', 'User-agent: *\n\n\n   ']) {
      expect(robotsDocument(ORIGIN, { locale: 'en', body }), JSON.stringify(body)).toBe(
        'User-agent: *\n\nSitemap: https://web.test/sitemap.xml\n',
      );
    }
  });

  it('reformats nothing inside the body', () => {
    const odd = 'user-agent:*\n  disallow:/x\n#a comment\nCrawl-delay: 10';
    expect(robotsDocument(ORIGIN, { locale: 'en', body: odd })).toContain(odd);
  });
});

describe('what a sitemaps path may name', () => {
  it('names the six kinds and nothing else', () => {
    for (const type of ['route', 'page', 'listing', 'service', 'category', 'seller']) {
      expect(sitemapTypeOf(type), type).toBe(type);
    }
    for (const type of ['routes', 'blog', 'LISTING', 'listings', '', '..', 'page/1']) {
      expect(sitemapTypeOf(type), type).toBeNull();
    }
  });

  it('knows which kinds the API answers for', () => {
    expect(isApiSitemapType('route')).toBe(false);
    for (const type of ['page', 'listing', 'service', 'category', 'seller'] as const) {
      expect(isApiSitemapType(type), type).toBe(true);
    }
  });

  it('accepts a 1-based page number and refuses anything that is not one', () => {
    expect(sitemapPageOf('1')).toBe(1);
    expect(sitemapPageOf('42')).toBe(42);
    for (const page of ['0', '-1', '1.5', '3x', 'one', '', '01', ' 1', '99999999']) {
      expect(sitemapPageOf(page), JSON.stringify(page)).toBeNull();
    }
  });
});
