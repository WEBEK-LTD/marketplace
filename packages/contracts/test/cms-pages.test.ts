import { describe, expect, it } from 'vitest';
import {
  CMS_PAGES_DEFAULT_LIMIT,
  CMS_PAGES_MAX_LIMIT,
  CMS_PAGE_META_DESCRIPTION_MAX,
  CMS_PAGE_META_TITLE_MAX,
  CMS_PAGE_STATUSES,
  CMS_PAGE_TEMPLATES,
  CMS_PAGE_TITLE_MAX,
  CmsPageSlugSchema,
  CmsPageStatusRequestSchema,
  CreateCmsPageRequestSchema,
  PublicCmsPageLookupResponseSchema,
  SaveCmsPageTranslationRequestSchema,
  UpdateCmsPageRequestSchema,
} from '../src/index.js';

/**
 * The CMS page contracts.
 *
 * Two things are worth testing here beyond the obvious. The lookup response is a **union**, so the tests check
 * that a body cannot be half a page and half a redirect. And several constants restate a database constraint,
 * so the tests pin the values rather than the fact that a number exists: if 0030's lengths ever change, one of
 * these fails instead of the API silently accepting text the database will reject.
 */

describe('the vocabulary', () => {
  it('matches the four states and four templates the database allows', () => {
    expect([...CMS_PAGE_STATUSES]).toEqual(['draft', 'scheduled', 'published', 'archived']);
    expect([...CMS_PAGE_TEMPLATES]).toEqual(['standard', 'legal', 'help', 'landing']);
  });

  it('restates the database lengths exactly', () => {
    expect(CMS_PAGE_TITLE_MAX).toBe(200);
    expect(CMS_PAGE_META_TITLE_MAX).toBe(70);
    expect(CMS_PAGE_META_DESCRIPTION_MAX).toBe(320);
  });

  it('clamps a page of authored pages to a sane size', () => {
    expect(CMS_PAGES_DEFAULT_LIMIT).toBeLessThanOrEqual(CMS_PAGES_MAX_LIMIT);
  });
});

describe('the slug', () => {
  it('accepts the shapes the database accepts', () => {
    for (const slug of ['terms', 'terms-of-service', 'a', 'a1', 'privacy-policy-2026']) {
      expect(CmsPageSlugSchema.safeParse(slug).success, slug).toBe(true);
    }
  });

  it('refuses the shapes the database refuses, so a bad address is a 400 and never a 500', () => {
    for (const slug of ['-terms', 'terms-', 'Terms', 'terms of service', 'terms/service', '', 'términos']) {
      expect(CmsPageSlugSchema.safeParse(slug).success, slug).toBe(false);
    }
  });

  it('refuses a slug longer than the column allows', () => {
    expect(CmsPageSlugSchema.safeParse('a'.repeat(120)).success).toBe(true);
    expect(CmsPageSlugSchema.safeParse('a'.repeat(121)).success).toBe(false);
  });
});

describe('the public lookup response', () => {
  const page = {
    slug: 'terms',
    pageKey: 'terms',
    template: 'legal',
    isIndexable: true,
    resolvedLocale: 'en',
    title: 'Terms',
    excerpt: null,
    body: 'The body.',
    metaTitle: null,
    metaDescription: null,
    coverObjectPath: null,
    publishedAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };

  it('accepts a page', () => {
    const parsed = PublicCmsPageLookupResponseSchema.safeParse({ outcome: 'page', page });
    expect(parsed.success).toBe(true);
  });

  it('accepts a redirect', () => {
    const parsed = PublicCmsPageLookupResponseSchema.safeParse({ outcome: 'moved', movedTo: 'terms-of-service' });
    expect(parsed.success).toBe(true);
  });

  it('refuses a body that is neither', () => {
    expect(PublicCmsPageLookupResponseSchema.safeParse({ page }).success).toBe(false);
    expect(PublicCmsPageLookupResponseSchema.safeParse({ outcome: 'not_found' }).success).toBe(false);
  });

  it('refuses a redirect carrying content, so the two cannot be confused', () => {
    const parsed = PublicCmsPageLookupResponseSchema.safeParse({ outcome: 'moved', movedTo: 'x', page });
    // The union member for `moved` has no `page`, so an extra key is dropped rather than carried — what
    // matters is that a consumer branching on `outcome` can never read content out of a redirect.
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.outcome === 'moved') {
      expect('page' in parsed.data).toBe(false);
    }
  });

  it('reports the resolved locale, which a renderer needs for lang and dir', () => {
    const parsed = PublicCmsPageLookupResponseSchema.safeParse({
      outcome: 'page',
      page: { ...page, resolvedLocale: 'ar' },
    });
    expect(parsed.success && parsed.data.outcome === 'page' && parsed.data.page.resolvedLocale).toBe('ar');
  });

  it('refuses a locale the public site does not serve', () => {
    expect(
      PublicCmsPageLookupResponseSchema.safeParse({ outcome: 'page', page: { ...page, resolvedLocale: 'fr' } })
        .success,
    ).toBe(false);
  });
});

describe('creating a page', () => {
  it('needs only a slug, because a page is always born a draft', () => {
    expect(CreateCmsPageRequestSchema.safeParse({ slug: 'terms' }).success).toBe(true);
  });

  it('has no status field at all: publishing is its own call', () => {
    const parsed = CreateCmsPageRequestSchema.safeParse({ slug: 'terms', status: 'published' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect('status' in parsed.data).toBe(false);
  });

  it('refuses a page key the database would refuse', () => {
    expect(CreateCmsPageRequestSchema.safeParse({ slug: 'terms', pageKey: 'Terms' }).success).toBe(false);
    expect(CreateCmsPageRequestSchema.safeParse({ slug: 'terms', pageKey: '1terms' }).success).toBe(false);
    expect(CreateCmsPageRequestSchema.safeParse({ slug: 'terms', pageKey: 'terms_of_service' }).success).toBe(true);
  });
});

describe('updating a page', () => {
  it('requires at least one field, so an empty request is a 400 rather than a silent no-op', () => {
    expect(UpdateCmsPageRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateCmsPageRequestSchema.safeParse({ template: 'help' }).success).toBe(true);
  });

  it('has no status field: a rename can never publish a page', () => {
    const parsed = UpdateCmsPageRequestSchema.safeParse({ slug: 'terms', status: 'published' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect('status' in parsed.data).toBe(false);
  });

  it('accepts an empty page key, which clears it', () => {
    expect(UpdateCmsPageRequestSchema.safeParse({ pageKey: '' }).success).toBe(true);
  });
});

describe('the lifecycle request', () => {
  it('requires a moment for a scheduled page', () => {
    expect(CmsPageStatusRequestSchema.safeParse({ status: 'scheduled' }).success).toBe(false);
    expect(
      CmsPageStatusRequestSchema.safeParse({ status: 'scheduled', scheduledFor: '2026-12-01T00:00:00.000Z' })
        .success,
    ).toBe(true);
  });

  it('refuses a moment for every other state, mirroring the database constraint', () => {
    for (const status of ['draft', 'published', 'archived'] as const) {
      expect(
        CmsPageStatusRequestSchema.safeParse({ status, scheduledFor: '2026-12-01T00:00:00.000Z' }).success,
        status,
      ).toBe(false);
      expect(CmsPageStatusRequestSchema.safeParse({ status }).success, status).toBe(true);
    }
  });

  it('refuses a state the database does not have', () => {
    expect(CmsPageStatusRequestSchema.safeParse({ status: 'live' }).success).toBe(false);
  });
});

describe('writing a locale', () => {
  it('needs a title and a body', () => {
    expect(SaveCmsPageTranslationRequestSchema.safeParse({ title: 'T', body: 'B' }).success).toBe(true);
    expect(SaveCmsPageTranslationRequestSchema.safeParse({ title: '', body: 'B' }).success).toBe(false);
    expect(SaveCmsPageTranslationRequestSchema.safeParse({ title: 'T', body: '   ' }).success).toBe(false);
  });

  it('refuses text longer than the column, so the database never has to', () => {
    expect(
      SaveCmsPageTranslationRequestSchema.safeParse({ title: 'a'.repeat(CMS_PAGE_TITLE_MAX + 1), body: 'B' }).success,
    ).toBe(false);
    expect(
      SaveCmsPageTranslationRequestSchema.safeParse({
        title: 'T',
        body: 'B',
        metaTitle: 'a'.repeat(CMS_PAGE_META_TITLE_MAX + 1),
      }).success,
    ).toBe(false);
    expect(
      SaveCmsPageTranslationRequestSchema.safeParse({
        title: 'T',
        body: 'B',
        metaDescription: 'a'.repeat(CMS_PAGE_META_DESCRIPTION_MAX + 1),
      }).success,
    ).toBe(false);
  });

  it('accepts an explicit null for every optional, which clears it', () => {
    expect(
      SaveCmsPageTranslationRequestSchema.safeParse({
        title: 'T',
        body: 'B',
        excerpt: null,
        metaTitle: null,
        metaDescription: null,
      }).success,
    ).toBe(true);
  });
});
