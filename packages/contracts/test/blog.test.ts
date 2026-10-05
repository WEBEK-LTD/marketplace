import { describe, expect, it } from 'vitest';
import {
  BLOG_EXCERPT_MAX,
  BLOG_META_DESCRIPTION_MAX,
  BLOG_META_TITLE_MAX,
  BLOG_POST_STATUSES,
  BLOG_SLUG_PATTERN,
  BLOG_TAG_NAME_MAX,
  BLOG_TITLE_MAX,
  BlogPostDetailSchema,
  BlogPostStatusRequestSchema,
  BlogTaxonomyResponseSchema,
  CreateBlogPostRequestSchema,
  PublicBlogIndexResponseSchema,
  PublicBlogPostLookupResponseSchema,
  PublicBlogPostSchema,
  PublicBlogTaxonomyResponseSchema,
  SaveBlogCategoryRequestSchema,
  SaveBlogPostTagsRequestSchema,
  SaveBlogPostTranslationRequestSchema,
  UpdateBlogPostRequestSchema,
} from '../src/index.js';

/**
 * The blog's contract (0092).
 *
 * What matters here: the vocabulary matches 0030's own constraints; the lookup is a union a caller cannot read
 * wrongly; every response is strict, so a value the database could not have produced is refused; and the two
 * owner decisions are visible as absences — no sitemap entry type and no metadata-override field anywhere.
 */

const POST = {
  slug: 'a-post',
  isIndexable: true,
  isFeatured: false,
  categorySlug: 'news',
  categoryName: 'News',
  resolvedLocale: 'en',
  title: 'A Post',
  excerpt: 'Short.',
  body: 'The body.',
  metaTitle: 'A Post | Meta',
  metaDescription: 'What the post is about.',
  coverObjectPath: 'cms-media/blog/cover.png',
  tags: [{ slug: 'shipping', name: 'Shipping' }],
  publishedAt: '2026-05-01T09:00:00.000Z',
  updatedAt: '2026-05-02T09:00:00.000Z',
} as const;

describe('the blog vocabulary', () => {
  it('is 0030s four states and nothing else', () => {
    expect(BLOG_POST_STATUSES).toEqual(['draft', 'scheduled', 'published', 'archived']);
  });

  it('accepts the slugs 0030 accepts and refuses the rest', () => {
    for (const slug of ['a', 'a-post', 'post-2026', 'a'.repeat(120)]) {
      expect(BLOG_SLUG_PATTERN.test(slug), slug).toBe(true);
    }
    for (const slug of ['', '-leading', 'trailing-', 'Upper', 'with space', 'a'.repeat(121), 'a--b/c']) {
      expect(BLOG_SLUG_PATTERN.test(slug), slug).toBe(false);
    }
  });

  it('carries the lengths the database constrains', () => {
    expect([BLOG_TITLE_MAX, BLOG_EXCERPT_MAX, BLOG_META_TITLE_MAX, BLOG_META_DESCRIPTION_MAX, BLOG_TAG_NAME_MAX])
      .toEqual([200, 500, 70, 320, 60]);
  });
});

describe('the public post', () => {
  it('accepts a post the database could produce', () => {
    expect(PublicBlogPostSchema.parse(POST).title).toBe('A Post');
  });

  it('allows an uncategorised post, an untagged one and one with no cover', () => {
    const bare = PublicBlogPostSchema.parse({
      ...POST,
      categorySlug: null,
      categoryName: null,
      coverObjectPath: null,
      excerpt: null,
      metaTitle: null,
      metaDescription: null,
      tags: [],
    });
    expect(bare.categorySlug).toBeNull();
    expect(bare.tags).toEqual([]);
  });

  it('refuses a field nobody declared, including a metadata override', () => {
    // 0092 decision B: a post's head comes from its own translation fields. There is no override to carry,
    // so a body that carries one is a body from something this contract does not describe.
    for (const extra of [{ seoMetadata: {} }, { canonicalPath: '/elsewhere' }, { robotsDirectives: [] }, { structuredData: {} }]) {
      expect(PublicBlogPostSchema.safeParse({ ...POST, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
  });

  it('refuses a locale it does not serve', () => {
    expect(PublicBlogPostSchema.safeParse({ ...POST, resolvedLocale: 'fr' }).success).toBe(false);
  });

  it('refuses a tag carrying more than a slug and a name', () => {
    expect(
      PublicBlogPostSchema.safeParse({ ...POST, tags: [{ slug: 'shipping', name: 'Shipping', id: 'x' }] }).success,
    ).toBe(false);
  });
});

describe('the lookup union', () => {
  it('reads a post and a redirect as two different bodies', () => {
    const post = PublicBlogPostLookupResponseSchema.parse({ outcome: 'post', post: POST });
    expect(post.outcome === 'post' && post.post.slug).toBe('a-post');
    const moved = PublicBlogPostLookupResponseSchema.parse({ outcome: 'moved', movedTo: 'a-post-renamed' });
    expect(moved.outcome === 'moved' && moved.movedTo).toBe('a-post-renamed');
  });

  it('has no third outcome, because absence is a 404 rather than a body', () => {
    expect(PublicBlogPostLookupResponseSchema.safeParse({ outcome: 'not_found' }).success).toBe(false);
  });

  it('will not let a moved answer carry a post, so a renderer cannot show one by accident', () => {
    expect(
      PublicBlogPostLookupResponseSchema.safeParse({ outcome: 'moved', movedTo: 'x', post: POST }).success,
    ).toBe(false);
  });
});

describe('the public index and taxonomy', () => {
  it('pages with a cursor that may be absent', () => {
    const page = PublicBlogIndexResponseSchema.parse({
      items: [
        {
          slug: 'a-post',
          isFeatured: true,
          categorySlug: null,
          categoryName: null,
          resolvedLocale: 'ar',
          title: 'مقال',
          excerpt: null,
          coverObjectPath: null,
          publishedAt: '2026-05-01T09:00:00.000Z',
          updatedAt: '2026-05-01T09:00:00.000Z',
        },
      ],
      nextCursor: null,
    });
    expect(page.items[0]?.isFeatured).toBe(true);
  });

  it('reports a filter with nothing behind it rather than omitting it', () => {
    const taxonomy = PublicBlogTaxonomyResponseSchema.parse({
      categories: [{ slug: 'news', name: 'News', postCount: 0 }],
      tags: [],
    });
    expect(taxonomy.categories[0]?.postCount).toBe(0);
  });

  it('refuses a negative count', () => {
    expect(
      PublicBlogTaxonomyResponseSchema.safeParse({
        categories: [{ slug: 'news', name: 'News', postCount: -1 }],
        tags: [],
      }).success,
    ).toBe(false);
  });
});

describe('creating and updating a post', () => {
  it('cannot set a status or a featured flag at creation', () => {
    expect(CreateBlogPostRequestSchema.parse({ slug: 'a-post' }).slug).toBe('a-post');
    for (const extra of [{ status: 'published' }, { isFeatured: true }, { publishedAt: 'now' }]) {
      const parsed = CreateBlogPostRequestSchema.parse({ slug: 'a-post', ...extra }) as Record<string, unknown>;
      // The request schema is permissive about unknown keys, so what matters is that nothing from the extra
      // object survives into the parsed value the service will act on.
      expect(Object.keys(parsed), JSON.stringify(extra)).toEqual(['slug']);
    }
  });

  it('needs at least one field to update, so an empty body is a 400 rather than a no-op write', () => {
    expect(UpdateBlogPostRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateBlogPostRequestSchema.parse({ slug: 'renamed' }).slug).toBe('renamed');
  });

  it('distinguishes an absent reference from an explicit null, because they mean different things', () => {
    const absent = UpdateBlogPostRequestSchema.parse({ slug: 'renamed' });
    expect('categoryId' in absent).toBe(false);
    const cleared = UpdateBlogPostRequestSchema.parse({ categoryId: null });
    expect(cleared.categoryId).toBeNull();
  });

  it('has no status field at all, so a rename cannot publish a post', () => {
    const parsed = UpdateBlogPostRequestSchema.parse({ slug: 'renamed', status: 'published' }) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['slug']);
  });
});

describe('the lifecycle request', () => {
  it('requires a moment for a schedule and refuses one otherwise', () => {
    expect(
      BlogPostStatusRequestSchema.safeParse({ status: 'scheduled', scheduledFor: '2026-06-01T09:00:00.000Z' })
        .success,
    ).toBe(true);
    expect(BlogPostStatusRequestSchema.safeParse({ status: 'scheduled' }).success).toBe(false);
    expect(
      BlogPostStatusRequestSchema.safeParse({ status: 'published', scheduledFor: '2026-06-01T09:00:00.000Z' })
        .success,
    ).toBe(false);
    expect(BlogPostStatusRequestSchema.safeParse({ status: 'published' }).success).toBe(true);
    expect(BlogPostStatusRequestSchema.safeParse({ status: 'published', scheduledFor: null }).success).toBe(true);
  });

  it('refuses a status 0030 does not have', () => {
    expect(BlogPostStatusRequestSchema.safeParse({ status: 'live' }).success).toBe(false);
  });
});

describe('the translation and tag requests', () => {
  it('needs real text, and holds the meta fields that are the only source of the head', () => {
    const saved = SaveBlogPostTranslationRequestSchema.parse({
      title: 'A Post',
      body: 'Body.',
      metaTitle: 'A Post | Meta',
      metaDescription: 'About.',
    });
    expect(saved.metaTitle).toBe('A Post | Meta');
    expect(SaveBlogPostTranslationRequestSchema.safeParse({ title: '   ', body: 'Body.' }).success).toBe(false);
    expect(SaveBlogPostTranslationRequestSchema.safeParse({ title: 'A Post', body: '  ' }).success).toBe(false);
  });

  it('refuses a meta title longer than the column', () => {
    expect(
      SaveBlogPostTranslationRequestSchema.safeParse({
        title: 'A Post',
        body: 'Body.',
        metaTitle: 'x'.repeat(BLOG_META_TITLE_MAX + 1),
      }).success,
    ).toBe(false);
  });

  it('takes the whole tag set, including an empty one', () => {
    expect(SaveBlogPostTagsRequestSchema.parse({ tagIds: [] }).tagIds).toEqual([]);
    expect(
      SaveBlogPostTagsRequestSchema.safeParse({ tagIds: ['not-a-uuid'] }).success,
    ).toBe(false);
  });
});

describe('the authoring detail and taxonomy', () => {
  const DETAIL = {
    id: '11111111-1111-4111-8111-111111111111',
    slug: 'a-post',
    status: 'published',
    categoryId: '22222222-2222-4222-8222-222222222222',
    categorySlug: 'news',
    isIndexable: true,
    isFeatured: false,
    coverMediaId: null,
    coverObjectPath: null,
    coverAltTextEn: null,
    coverAltTextAr: null,
    authorUserId: '33333333-3333-4333-8333-333333333333',
    scheduledFor: null,
    publishedAt: '2026-05-01T09:00:00.000Z',
    archivedAt: null,
    createdAt: '2026-04-01T09:00:00.000Z',
    updatedAt: '2026-05-02T09:00:00.000Z',
    canManage: true,
    previousSlugs: ['an-older-slug'],
    tagIds: ['44444444-4444-4444-8444-444444444444'],
    translations: [
      {
        localeCode: 'en',
        title: 'A Post',
        excerpt: null,
        body: 'Body.',
        metaTitle: null,
        metaDescription: null,
        updatedAt: '2026-05-02T09:00:00.000Z',
      },
    ],
  } as const;

  it('reports the manage capability rather than a role name', () => {
    expect(BlogPostDetailSchema.parse(DETAIL).canManage).toBe(true);
    const { canManage: _omitted, ...withoutCapability } = DETAIL;
    expect(BlogPostDetailSchema.safeParse(withoutCapability).success).toBe(false);
  });

  it('carries the retired slugs, because each one still redirects', () => {
    expect(BlogPostDetailSchema.parse(DETAIL).previousSlugs).toEqual(['an-older-slug']);
  });

  it('refuses a field nobody declared', () => {
    expect(BlogPostDetailSchema.safeParse({ ...DETAIL, authorName: 'Someone' }).success).toBe(false);
  });

  it('reports both names of a category and whether the caller may change it', () => {
    const taxonomy = BlogTaxonomyResponseSchema.parse({
      categories: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          slug: 'news',
          nameEn: 'News',
          nameAr: 'أخبار',
          descriptionEn: null,
          descriptionAr: null,
          sortOrder: 10,
          isActive: true,
          postCount: 3,
          updatedAt: '2026-05-02T09:00:00.000Z',
        },
      ],
      tags: [],
      canManage: false,
    });
    expect(taxonomy.categories[0]?.nameAr).toBe('أخبار');
    expect(taxonomy.canManage).toBe(false);
  });

  it('lets a category be saved without touching its order or its activity', () => {
    // The database writer treats null as "leave it alone", and an absent field here is what produces that.
    const parsed = SaveBlogCategoryRequestSchema.parse({ nameEn: 'Renamed' });
    expect('sortOrder' in parsed).toBe(false);
    expect('isActive' in parsed).toBe(false);
  });

  it('clears an optional Arabic name with an empty string', () => {
    expect(SaveBlogCategoryRequestSchema.parse({ nameAr: '' }).nameAr).toBe('');
    expect(SaveBlogCategoryRequestSchema.safeParse({ nameAr: 'x'.repeat(121) }).success).toBe(false);
  });
});
