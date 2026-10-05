import { describe, expect, it } from 'vitest';
import {
  PublicSeoMetadataResponseSchema,
  SEO_CANONICAL_PATH_PATTERN,
  SEO_DIRECTIVES,
  SEO_META_TITLE_MAX,
  SEO_METADATA_ENTITY_TYPES,
  SEO_METADATA_WRITABLE_ENTITY_TYPES,
  SEO_RESTRICTIVE_DIRECTIVES,
  SEO_ROUTE_PATH_PATTERN,
  SaveSeoMetadataRequestSchema,
  SeoMetadataDetailResponseSchema,
  SeoMetadataEntriesResponseSchema,
  seoDirectivesAreConsistent,
} from '../src/seo-metadata.js';

/**
 * The per-entity metadata contract.
 *
 * Everything asserted here is a rule migration 0030 states as a constraint, plus the two owner decisions the
 * database enforces. These tests prove the restatement matches in both directions: a value the database would
 * refuse is refused here, and a value it would **accept** is not refused here — a contract narrower than its table
 * silently removes behaviour nobody decided to remove.
 */

describe('the vocabulary', () => {
  it('lists exactly 0030’s eight entity kinds, and no service', () => {
    expect([...SEO_METADATA_ENTITY_TYPES]).toEqual([
      'page',
      'blog_post',
      'blog_category',
      'blog_tag',
      'category',
      'listing',
      'seller',
      'route',
    ]);
    expect(SEO_METADATA_ENTITY_TYPES as readonly string[]).not.toContain('service');
  });

  it('offers for writing only the kinds that have a public surface today', () => {
    expect([...SEO_METADATA_WRITABLE_ENTITY_TYPES]).toEqual(['page', 'category', 'listing', 'seller', 'route']);
    // Storable, and with no page to read them, so the console does not offer them.
    for (const blog of ['blog_post', 'blog_category', 'blog_tag']) {
      expect(SEO_METADATA_WRITABLE_ENTITY_TYPES as readonly string[]).not.toContain(blog);
    }
    // Every writable kind is one the table allows.
    for (const kind of SEO_METADATA_WRITABLE_ENTITY_TYPES) {
      expect(SEO_METADATA_ENTITY_TYPES as readonly string[]).toContain(kind);
    }
  });

  it('separates what may be stored from what may reach a page', () => {
    // The restrictive set is a strict subset, and the three it leaves out are exactly the permissive ones.
    for (const directive of SEO_RESTRICTIVE_DIRECTIVES) {
      expect(SEO_DIRECTIVES as readonly string[]).toContain(directive);
    }
    const permissive = SEO_DIRECTIVES.filter(
      (directive) => !(SEO_RESTRICTIVE_DIRECTIVES as readonly string[]).includes(directive),
    );
    expect(permissive).toEqual(['index', 'follow', 'max-snippet:-1']);
  });

  it('knows which directive sets contradict themselves', () => {
    expect(seoDirectivesAreConsistent(['index', 'follow'])).toBe(true);
    expect(seoDirectivesAreConsistent(['noindex', 'nofollow', 'nosnippet'])).toBe(true);
    expect(seoDirectivesAreConsistent(['index', 'noindex'])).toBe(false);
    expect(seoDirectivesAreConsistent(['follow', 'nofollow'])).toBe(false);
  });
});

describe('the two path shapes', () => {
  it('accepts an ordinary relative path and refuses anything else', () => {
    expect(SEO_ROUTE_PATH_PATTERN.test('/listings')).toBe(true);
    expect(SEO_ROUTE_PATH_PATTERN.test('/')).toBe(true);
    expect(SEO_ROUTE_PATH_PATTERN.test('listings')).toBe(false);
    expect(SEO_ROUTE_PATH_PATTERN.test('https://evil.test/x')).toBe(false);
    // A protocol-relative path is a URL to another host for a browser, and 0030 forbids it with its own condition.
    expect(SEO_ROUTE_PATH_PATTERN.test('//evil.test')).toBe(false);
  });

  it('lets a canonical carry a query string, as 0030 does, and a route path not', () => {
    expect(SEO_CANONICAL_PATH_PATTERN.test('/search?q=chairs')).toBe(true);
    expect(SEO_ROUTE_PATH_PATTERN.test('/search?q=chairs')).toBe(false);
    expect(SEO_CANONICAL_PATH_PATTERN.test('//evil.test')).toBe(false);
  });
});

describe('writing an override', () => {
  const ENTITY = { entityType: 'category', entityId: '11111111-1111-4111-8111-111111111111', localeCode: 'en' } as const;
  const ROUTE = { entityType: 'route', routePath: '/listings', localeCode: 'en' } as const;

  it('accepts the smallest valid entity request and the smallest valid route request', () => {
    expect(SaveSeoMetadataRequestSchema.safeParse(ENTITY).success).toBe(true);
    expect(SaveSeoMetadataRequestSchema.safeParse(ROUTE).success).toBe(true);
  });

  it('requires an identifier for an entity and a path for a route, and never both', () => {
    expect(SaveSeoMetadataRequestSchema.safeParse({ entityType: 'category', localeCode: 'en' }).success).toBe(false);
    expect(SaveSeoMetadataRequestSchema.safeParse({ entityType: 'route', localeCode: 'en' }).success).toBe(false);
    expect(SaveSeoMetadataRequestSchema.safeParse({ ...ENTITY, routePath: '/also' }).success).toBe(false);
    expect(
      SaveSeoMetadataRequestSchema.safeParse({
        ...ROUTE,
        entityId: '11111111-1111-4111-8111-111111111111',
      }).success,
    ).toBe(false);
  });

  it('refuses an entity kind with no public surface, and one 0030 does not list', () => {
    for (const entityType of ['blog_post', 'blog_category', 'blog_tag', 'service', 'widget']) {
      expect(
        SaveSeoMetadataRequestSchema.safeParse({ ...ENTITY, entityType }).success,
        entityType,
      ).toBe(false);
    }
  });

  it('refuses a self-contradicting directive set, and an empty one', () => {
    expect(SaveSeoMetadataRequestSchema.safeParse({ ...ENTITY, robotsDirectives: ['index', 'noindex'] }).success).toBe(
      false,
    );
    expect(SaveSeoMetadataRequestSchema.safeParse({ ...ENTITY, robotsDirectives: ['follow', 'nofollow'] }).success).toBe(
      false,
    );
    expect(SaveSeoMetadataRequestSchema.safeParse({ ...ENTITY, robotsDirectives: [] }).success).toBe(false);
    expect(SaveSeoMetadataRequestSchema.safeParse({ ...ENTITY, robotsDirectives: ['sometimes'] }).success).toBe(false);
  });

  it('accepts every directive 0030 allows, including the permissive ones', () => {
    // Accepted on the way in and dropped on the way out: an operator may store `index`, it simply has no effect.
    for (const directive of SEO_DIRECTIVES) {
      expect(
        SaveSeoMetadataRequestSchema.safeParse({ ...ENTITY, robotsDirectives: [directive] }).success,
        directive,
      ).toBe(true);
    }
  });

  it('accepts a canonical for a kind that will not read it, because storing is not reading', () => {
    // The withholding happens in the database. Refusing it here would hide from an operator that the value is
    // stored, and 0030 stores it.
    const parsed = SaveSeoMetadataRequestSchema.safeParse({ ...ENTITY, canonicalPath: '/elsewhere' });
    expect(parsed.success).toBe(true);
  });

  it('refuses a canonical that would leave the site', () => {
    for (const canonicalPath of ['https://evil.test/', '//evil.test', 'relative-but-not-a-path']) {
      expect(SaveSeoMetadataRequestSchema.safeParse({ ...ENTITY, canonicalPath }).success, canonicalPath).toBe(false);
    }
  });

  it('refuses a value past one of 0030’s length bounds', () => {
    expect(
      SaveSeoMetadataRequestSchema.safeParse({ ...ENTITY, metaTitle: 't'.repeat(SEO_META_TITLE_MAX + 1) }).success,
    ).toBe(false);
    expect(SaveSeoMetadataRequestSchema.safeParse({ ...ENTITY, metaTitle: 't'.repeat(SEO_META_TITLE_MAX) }).success).toBe(
      true,
    );
  });

  it('has no field for structured data, so nothing can send one', () => {
    const parsed = SaveSeoMetadataRequestSchema.safeParse({ ...ENTITY, structuredData: { '@type': 'Product' } });
    expect(parsed.success).toBe(true);
    expect(parsed.success && 'structuredData' in parsed.data).toBe(false);
  });

  it('drops any other field nobody declared', () => {
    const parsed = SaveSeoMetadataRequestSchema.safeParse({ ...ENTITY, updatedBy: 'someone-else', twitterSite: '@x' });
    expect(parsed.success).toBe(true);
    expect(parsed.success && 'updatedBy' in parsed.data).toBe(false);
  });

  it('refuses a locale that is not a two-letter code', () => {
    for (const localeCode of ['', 'eng', 'EN', 'e']) {
      expect(SaveSeoMetadataRequestSchema.safeParse({ ...ENTITY, localeCode }).success, localeCode).toBe(false);
    }
  });
});

describe('what a public surface receives', () => {
  it('accepts an override and accepts none', () => {
    const override = {
      metaTitle: 'A lovely chair',
      metaDescription: 'A chair worth having.',
      canonicalPath: null,
      robotsDirectives: ['nosnippet'],
      ogTitle: null,
      ogDescription: null,
      shareObjectPath: 'cms-media/share/card.png',
    };
    expect(PublicSeoMetadataResponseSchema.safeParse({ override }).success).toBe(true);
    expect(PublicSeoMetadataResponseSchema.safeParse({ override: null }).success).toBe(true);
  });

  it('cannot carry a permissive directive, because the database does not emit one', () => {
    const base = {
      metaTitle: null,
      metaDescription: null,
      canonicalPath: null,
      ogTitle: null,
      ogDescription: null,
      shareObjectPath: null,
    };
    for (const directive of ['index', 'follow', 'max-snippet:-1']) {
      expect(
        PublicSeoMetadataResponseSchema.safeParse({ override: { ...base, robotsDirectives: [directive] } }).success,
        directive,
      ).toBe(false);
    }
    for (const directive of SEO_RESTRICTIVE_DIRECTIVES) {
      expect(
        PublicSeoMetadataResponseSchema.safeParse({ override: { ...base, robotsDirectives: [directive] } }).success,
        directive,
      ).toBe(true);
    }
  });

  it('refuses a canonical that would leave the site, even if the API claims one', () => {
    const base = {
      metaTitle: null,
      metaDescription: null,
      robotsDirectives: [],
      ogTitle: null,
      ogDescription: null,
      shareObjectPath: null,
    };
    expect(
      PublicSeoMetadataResponseSchema.safeParse({ override: { ...base, canonicalPath: 'https://evil.test/' } }).success,
    ).toBe(false);
  });

  it('refuses a field the contract does not name rather than stripping it', () => {
    const base = {
      metaTitle: null,
      metaDescription: null,
      canonicalPath: null,
      robotsDirectives: [],
      ogTitle: null,
      ogDescription: null,
      shareObjectPath: null,
    };
    expect(
      PublicSeoMetadataResponseSchema.safeParse({ override: { ...base, structuredData: {} } }).success,
    ).toBe(false);
  });
});

describe('the admin responses', () => {
  const ENTRY = {
    id: '11111111-1111-4111-8111-111111111111',
    entityType: 'listing',
    entityId: '22222222-2222-4222-8222-222222222222',
    routePath: null,
    targetSlug: 'a-chair',
    localeCode: 'en',
    metaTitle: 'A lovely chair',
    metaDescription: null,
    canonicalPath: '/elsewhere',
    robotsDirectives: ['index', 'follow'],
    ogTitle: null,
    ogDescription: null,
    shareMediaId: null,
    canonicalIsHonoured: false,
    updatedAt: '2026-05-02T09:00:00.000Z',
  } as const;

  it('accepts a page of entries, and an empty one', () => {
    expect(SeoMetadataEntriesResponseSchema.safeParse({ items: [ENTRY], nextCursor: null }).success).toBe(true);
    expect(SeoMetadataEntriesResponseSchema.safeParse({ items: [], nextCursor: null }).success).toBe(true);
  });

  it('shows the stored value beside what the public will receive', () => {
    const parsed = SeoMetadataDetailResponseSchema.safeParse({
      entry: {
        ...ENTRY,
        shareObjectPath: null,
        effectiveCanonicalPath: null,
        effectiveRobotsDirectives: [],
        createdAt: '2026-05-01T09:00:00.000Z',
        updatedBy: '33333333-3333-4333-8333-333333333333',
        canManage: true,
      },
    });
    expect(parsed.success).toBe(true);
    // The stored canonical is shown; its effect is nothing, because a listing does not honour one.
    expect(parsed.success && parsed.data.entry.canonicalPath).toBe('/elsewhere');
    expect(parsed.success && parsed.data.entry.effectiveCanonicalPath).toBeNull();
    expect(parsed.success && parsed.data.entry.effectiveRobotsDirectives).toEqual([]);
  });

  it('refuses a detail with no manage capability on it', () => {
    const parsed = SeoMetadataDetailResponseSchema.safeParse({
      entry: {
        ...ENTRY,
        shareObjectPath: null,
        effectiveCanonicalPath: null,
        effectiveRobotsDirectives: [],
        createdAt: '2026-05-01T09:00:00.000Z',
        updatedBy: null,
      },
    });
    // A console renders its controls from that field, so its absence must be a failure rather than a falsy default.
    expect(parsed.success).toBe(false);
  });

  it('lets a list row carry any kind 0030 allows, including one the console cannot write', () => {
    // An existing blog row must read back rather than breaking the screen that lists it.
    expect(
      SeoMetadataEntriesResponseSchema.safeParse({
        items: [{ ...ENTRY, entityType: 'blog_post' }],
        nextCursor: null,
      }).success,
    ).toBe(true);
  });
});
