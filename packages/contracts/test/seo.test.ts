import { describe, expect, it } from 'vitest';
import {
  RobotsSettingsResponseSchema,
  SITEMAP_API_ENTRY_TYPES,
  SITEMAP_ENTRY_TYPES,
  SITEMAP_PAGE_SIZE,
  SITEMAP_PROTOCOL_MAX_ENTRIES,
  SitemapCountsResponseSchema,
  SitemapEntrySchema,
  SitemapPageResponseSchema,
} from '../src/index.js';

/**
 * The public SEO contracts.
 *
 * What is worth proving: that "nobody has authored a robots body" is expressible as a value rather than only as
 * an absent field; that a sitemap entry carries a slug and never a URL, because only the web app knows the
 * origin; that `locales` is optional because it means something only for CMS static pages; and that the page
 * size stays inside the limit the sitemap protocol itself sets.
 */

describe('the robots settings response', () => {
  it('accepts an authored body with the locale that answered', () => {
    const parsed = RobotsSettingsResponseSchema.parse({
      locale: 'en',
      body: 'User-agent: *\nDisallow: /dashboard',
    });
    expect(parsed.body).toContain('Disallow: /dashboard');
    expect(parsed.locale).toBe('en');
  });

  it('accepts "nothing authored" as a value rather than as an absence', () => {
    // The common answer today: `seo_settings` ships with no rows. A caller must be able to tell this apart
    // from a failure, which is why it is nulls and not a 404.
    expect(RobotsSettingsResponseSchema.parse({ locale: null, body: null })).toEqual({ locale: null, body: null });
  });

  it('requires both fields to be present, so neither can be forgotten', () => {
    expect(RobotsSettingsResponseSchema.safeParse({ locale: 'en' }).success).toBe(false);
    expect(RobotsSettingsResponseSchema.safeParse({ body: null }).success).toBe(false);
  });

  it('refuses a locale that is not one of the public ones', () => {
    expect(RobotsSettingsResponseSchema.safeParse({ locale: 'fr', body: null }).success).toBe(false);
  });

  it('bounds the body, so a runaway setting cannot become an unbounded response', () => {
    expect(RobotsSettingsResponseSchema.safeParse({ locale: 'en', body: 'x'.repeat(10_000) }).success).toBe(true);
    expect(RobotsSettingsResponseSchema.safeParse({ locale: 'en', body: 'x'.repeat(10_001) }).success).toBe(false);
  });
});

describe('the sitemap vocabulary', () => {
  it('names the fixed routes only in the list the web app uses, not in the one the API answers for', () => {
    // The landing routes live in code, so the API neither counts nor enumerates them; the sitemap index
    // still names that child, which is why the two lists differ by exactly that entry.
    expect(SITEMAP_ENTRY_TYPES).toContain('route');
    expect(SITEMAP_API_ENTRY_TYPES).not.toContain('route');
    expect([...SITEMAP_ENTRY_TYPES].filter((type) => type !== 'route')).toEqual([...SITEMAP_API_ENTRY_TYPES]);
  });

  it('carries the blog, and exactly one kind for it (0097)', () => {
    // 0092 shipped the blog with no sitemap entry and recorded that as deliberate; 0097 added one, by owner
    // decision. Owner decision 6 keeps a blog category and a blog tag as filters on the index rather than
    // addresses of their own, so there is one blog kind and not three.
    expect(SITEMAP_ENTRY_TYPES).toContain('blog_post');
    expect(SITEMAP_API_ENTRY_TYPES).toContain('blog_post');
    expect([...SITEMAP_ENTRY_TYPES].filter((type) => type.includes('blog'))).toEqual(['blog_post']);
    for (const absent of ['blog_category', 'blog_tag', 'blog']) {
      expect([...SITEMAP_ENTRY_TYPES], absent).not.toContain(absent);
    }
  });

  it('keeps the six kinds the sitemap index names, and no others', () => {
    // A closed inventory: a kind added here produces child documents a crawler will fetch, so it is not a list to
    // extend quietly.
    expect([...SITEMAP_ENTRY_TYPES]).toEqual([
      'route',
      'page',
      'blog_post',
      'listing',
      'service',
      'category',
      'seller',
    ]);
  });

  it('keeps the page size inside the limit the protocol sets', () => {
    expect(SITEMAP_PROTOCOL_MAX_ENTRIES).toBe(50_000);
    expect(SITEMAP_PAGE_SIZE).toBeLessThanOrEqual(SITEMAP_PROTOCOL_MAX_ENTRIES);
    expect(SITEMAP_PAGE_SIZE).toBeGreaterThan(0);
  });
});

describe('a sitemap entry', () => {
  const entry = { slug: 'walnut-table', updatedAt: '2026-05-02T09:00:00.000Z' };

  it('is a slug and a time, never a URL', () => {
    expect(SitemapEntrySchema.parse(entry)).toEqual(entry);
    // Only the web app knows the origin and the path each surface owns, so a URL here would be the API
    // deciding something it has no business deciding — and the slug pattern refuses one anyway.
    expect(SitemapEntrySchema.safeParse({ ...entry, slug: 'https://web.test/listing/walnut-table' }).success).toBe(false);
    expect(SitemapEntrySchema.safeParse({ ...entry, slug: '/walnut-table' }).success).toBe(false);
  });

  it('refuses a slug that is not slug-shaped', () => {
    for (const slug of ['', 'Walnut-Table', 'walnut table', '-walnut', 'walnut-', '../dashboard', 'a'.repeat(121)]) {
      expect(SitemapEntrySchema.safeParse({ ...entry, slug }).success, slug).toBe(false);
    }
  });

  it('requires a real timestamp', () => {
    for (const updatedAt of ['', 'yesterday', '2026-05-02']) {
      expect(SitemapEntrySchema.safeParse({ ...entry, updatedAt }).success, updatedAt).toBe(false);
    }
  });

  it('carries locales only where an address can be absent in one language', () => {
    expect(SitemapEntrySchema.parse(entry).locales).toBeUndefined();
    expect(SitemapEntrySchema.parse({ ...entry, locales: ['ar'] }).locales).toEqual(['ar']);
    expect(SitemapEntrySchema.parse({ ...entry, locales: ['en', 'ar'] }).locales).toEqual(['en', 'ar']);
    // An empty list would advertise nothing at all, which is not an entry.
    expect(SitemapEntrySchema.safeParse({ ...entry, locales: [] }).success).toBe(false);
    expect(SitemapEntrySchema.safeParse({ ...entry, locales: ['fr'] }).success).toBe(false);
  });
});

describe('the counts response', () => {
  it('carries one count per kind and the page size the enumerations use', () => {
    const parsed = SitemapCountsResponseSchema.parse({
      pageSize: SITEMAP_PAGE_SIZE,
      counts: [
        { type: 'page', entries: 3 },
        { type: 'listing', entries: 0 },
      ],
    });
    expect(parsed.counts).toHaveLength(2);
    expect(parsed.counts[1]?.entries).toBe(0);
  });

  it('accepts zero, because an empty kind reports zero rather than disappearing', () => {
    expect(SitemapCountsResponseSchema.safeParse({ pageSize: 10, counts: [{ type: 'seller', entries: 0 }] }).success).toBe(true);
    expect(SitemapCountsResponseSchema.safeParse({ pageSize: 10, counts: [{ type: 'seller', entries: -1 }] }).success).toBe(false);
  });

  it('refuses the one type the API does not answer for', () => {
    expect(SitemapCountsResponseSchema.safeParse({ pageSize: 10, counts: [{ type: 'route', entries: 4 }] }).success).toBe(false);
  });

  it('refuses a page size outside the protocol limit', () => {
    expect(SitemapCountsResponseSchema.safeParse({ pageSize: 0, counts: [] }).success).toBe(false);
    expect(SitemapCountsResponseSchema.safeParse({ pageSize: SITEMAP_PROTOCOL_MAX_ENTRIES + 1, counts: [] }).success).toBe(false);
  });
});

describe('a page of entries', () => {
  const body = {
    type: 'category' as const,
    page: 1,
    pageSize: SITEMAP_PAGE_SIZE,
    entries: [{ slug: 'furniture', updatedAt: '2026-05-02T09:00:00.000Z' }],
  };

  it('echoes the type and the page number back', () => {
    expect(SitemapPageResponseSchema.parse(body)).toEqual(body);
  });

  it('accepts an empty page, because a set may shrink between the index and the child', () => {
    expect(SitemapPageResponseSchema.parse({ ...body, entries: [] }).entries).toEqual([]);
  });

  it('counts pages from one', () => {
    expect(SitemapPageResponseSchema.safeParse({ ...body, page: 0 }).success).toBe(false);
    expect(SitemapPageResponseSchema.safeParse({ ...body, page: -1 }).success).toBe(false);
    expect(SitemapPageResponseSchema.safeParse({ ...body, page: 1.5 }).success).toBe(false);
  });

  it('refuses an unknown type', () => {
    expect(SitemapPageResponseSchema.safeParse({ ...body, type: 'route' }).success).toBe(false);
    expect(SitemapPageResponseSchema.safeParse({ ...body, type: 'blog' }).success).toBe(false);
  });
});
