import { z } from './zod.js';
import { PublicLocaleSchema } from './categories.js';

/**
 * The blog — the public surface and the authoring surface (Phase 8, increment 0092).
 *
 * The public half is the smallest thing that can render a post and an index. The authoring half is what a
 * console needs to write one, together with the taxonomy the index filters by.
 *
 * **The three-answer shape is the contract's, not a convention.** A slug answers with a post, with the slug it
 * moved to, or with nothing — and the first two are different response bodies rather than one body with
 * optional fields, so a client cannot read a redirect as a post by forgetting to check a flag. The API turns
 * the third into a 404 and the second into a 301, and the BFF validates whichever came back. A 301 from the
 * API itself would be followed transparently by `fetch`, so the browser would never learn to redirect.
 *
 * `resolvedLocale` is not decoration. A post may exist in English and not in Arabic (D7 forbids machine
 * translation, so an untranslated post falls back to real text somebody wrote), and the renderer has to know
 * which language it actually received in order to set `lang` and `dir` on the content it is about to show.
 *
 * **Two owner decisions for this increment are visible in what is absent here.** There is no sitemap entry
 * type for the blog, because the blog does not enter the sitemap in 0092. And there is no override field
 * anywhere: a post's `<head>` comes from `metaTitle` and `metaDescription` on its own translation, which is
 * why those columns exist, and `seo_metadata` does not reach a blog post at all.
 *
 * Every response schema is strict. A value the database could not have produced means something upstream is
 * wrong, and silently accepting it is how an unnoticed field becomes a dependency.
 */

// ---------------------------------------------------------------------------------------------------
// Shared vocabulary — every value below is one the database already constrains
// ---------------------------------------------------------------------------------------------------
/** 0030's four post states, shared with pages through `tg_cms_transition`. */
export const BLOG_POST_STATUSES = ['draft', 'scheduled', 'published', 'archived'] as const;
export type BlogPostStatus = (typeof BLOG_POST_STATUSES)[number];
export const BlogPostStatusSchema = z.enum(BLOG_POST_STATUSES);

/**
 * The slug shape `blog_posts_slug_format`, `blog_categories_slug_format` and `blog_tags_slug_format` all
 * enforce, restated so a bad address is a 400 and never a 500.
 */
export const BLOG_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$/;
export const BlogSlugSchema = z.string().regex(BLOG_SLUG_PATTERN);

/** The lengths 0030's own constraints enforce. */
export const BLOG_TITLE_MAX = 200;
export const BLOG_EXCERPT_MAX = 500;
export const BLOG_META_TITLE_MAX = 70;
export const BLOG_META_DESCRIPTION_MAX = 320;
export const BLOG_CATEGORY_NAME_MAX = 120;
export const BLOG_TAG_NAME_MAX = 60;

// ---------------------------------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------------------------------
/** One tag as the public sees it. Only active tags are ever served. */
export const PublicBlogTagSchema = z
  .object({
    slug: BlogSlugSchema,
    /** Named in the requested locale, falling back to English where no Arabic name was written (D7). */
    name: z.string(),
  })
  .strict();
export type PublicBlogTag = z.infer<typeof PublicBlogTagSchema>;

export const PublicBlogPostSchema = z
  .object({
    slug: BlogSlugSchema,
    /** False means the post says `noindex`. The admin's decision, carried through rather than re-derived. */
    isIndexable: z.boolean(),
    /** Reported so a surface can mark the post. It never changes the order of the index. */
    isFeatured: z.boolean(),
    /** Null for an uncategorised post, and for one whose category has been deactivated. */
    categorySlug: BlogSlugSchema.nullable(),
    categoryName: z.string().nullable(),
    /** Which language the text below is actually in, which may not be the one that was asked for. */
    resolvedLocale: PublicLocaleSchema,
    title: z.string(),
    excerpt: z.string().nullable(),
    body: z.string(),
    /** The only source of this post's `<head>`: 0092 decision B leaves `seo_metadata` out of it. */
    metaTitle: z.string().nullable(),
    metaDescription: z.string().nullable(),
    /** The storage path of the cover image, or null. Never a URL: no media origin exists to build one. */
    coverObjectPath: z.string().nullable(),
    tags: z.array(PublicBlogTagSchema),
    publishedAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type PublicBlogPost = z.infer<typeof PublicBlogPostSchema>;

/**
 * What a slug lookup answers, as a discriminated union on `outcome`.
 *
 * The two members share no content fields, so a renderer cannot show an empty post by forgetting to branch:
 * there is no `title` on the moved member to be null.
 */
export const PublicBlogPostLookupResponseSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('post'), post: PublicBlogPostSchema }).strict(),
  z.object({ outcome: z.literal('moved'), movedTo: BlogSlugSchema }).strict(),
]);
export type PublicBlogPostLookupResponse = z.infer<typeof PublicBlogPostLookupResponseSchema>;

/** One entry of the public index — enough for a card, and nothing more. */
export const PublicBlogPostSummarySchema = z
  .object({
    slug: BlogSlugSchema,
    isFeatured: z.boolean(),
    categorySlug: BlogSlugSchema.nullable(),
    categoryName: z.string().nullable(),
    resolvedLocale: PublicLocaleSchema,
    title: z.string(),
    excerpt: z.string().nullable(),
    coverObjectPath: z.string().nullable(),
    publishedAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type PublicBlogPostSummary = z.infer<typeof PublicBlogPostSummarySchema>;

export const BLOG_INDEX_DEFAULT_LIMIT = 12;
export const BLOG_INDEX_MAX_LIMIT = 48;

export const PublicBlogIndexResponseSchema = z
  .object({
    items: z.array(PublicBlogPostSummarySchema),
    nextCursor: z.string().nullable(),
  })
  .strict();
export type PublicBlogIndexResponse = z.infer<typeof PublicBlogIndexResponseSchema>;

/** One filter the index offers, with how many posts the public may actually see under it. */
export const PublicBlogTaxonomyEntrySchema = z
  .object({
    slug: BlogSlugSchema,
    name: z.string(),
    /** Zero is a real answer: a filter with nothing behind it is reported rather than omitted. */
    postCount: z.number().int().min(0),
  })
  .strict();
export type PublicBlogTaxonomyEntry = z.infer<typeof PublicBlogTaxonomyEntrySchema>;

export const PublicBlogTaxonomyResponseSchema = z
  .object({
    categories: z.array(PublicBlogTaxonomyEntrySchema),
    tags: z.array(PublicBlogTaxonomyEntrySchema),
  })
  .strict();
export type PublicBlogTaxonomyResponse = z.infer<typeof PublicBlogTaxonomyResponseSchema>;

// ---------------------------------------------------------------------------------------------------
// Authoring
// ---------------------------------------------------------------------------------------------------
export const BLOG_POSTS_DEFAULT_LIMIT = 25;
export const BLOG_POSTS_MAX_LIMIT = 100;
export const BLOG_SEARCH_MAX = 200;

export const BlogPostSummarySchema = z
  .object({
    id: z.string().uuid(),
    slug: BlogSlugSchema,
    status: BlogPostStatusSchema,
    categoryId: z.string().uuid().nullable(),
    categorySlug: BlogSlugSchema.nullable(),
    isIndexable: z.boolean(),
    isFeatured: z.boolean(),
    scheduledFor: z.string().nullable(),
    publishedAt: z.string().nullable(),
    archivedAt: z.string().nullable(),
    updatedAt: z.string(),
    /** Which locales exist. An empty array is a post nobody has written yet, and cannot be published. */
    translatedLocales: z.array(z.string()),
    tagCount: z.number().int().min(0),
    /** The title in any locale, for the list. Null for a post with no locale at all. */
    title: z.string().nullable(),
  })
  .strict();
export type BlogPostSummary = z.infer<typeof BlogPostSummarySchema>;

export const BlogPostPageResponseSchema = z
  .object({
    items: z.array(BlogPostSummarySchema),
    nextCursor: z.string().nullable(),
  })
  .strict();
export type BlogPostPageResponse = z.infer<typeof BlogPostPageResponseSchema>;

export const BlogPostTranslationSchema = z
  .object({
    localeCode: z.string(),
    title: z.string(),
    excerpt: z.string().nullable(),
    body: z.string(),
    metaTitle: z.string().nullable(),
    metaDescription: z.string().nullable(),
    updatedAt: z.string(),
  })
  .strict();
export type BlogPostTranslation = z.infer<typeof BlogPostTranslationSchema>;

export const BlogPostDetailSchema = z
  .object({
    id: z.string().uuid(),
    slug: BlogSlugSchema,
    status: BlogPostStatusSchema,
    categoryId: z.string().uuid().nullable(),
    categorySlug: BlogSlugSchema.nullable(),
    isIndexable: z.boolean(),
    isFeatured: z.boolean(),
    coverMediaId: z.string().uuid().nullable(),
    coverObjectPath: z.string().nullable(),
    /**
     * The alt text somebody wrote for the attached cover, in both languages, or null (0099).
     *
     * The id and the path have been here since 0092; the labels arrive with the attachment control, because
     * an editor choosing between library entries by uuid needs something human to recognise them by. Still
     * no URL: the bucket is private and nothing here is signed.
     */
    coverAltTextEn: z.string().nullable(),
    coverAltTextAr: z.string().nullable(),
    /** The byline: the staff member who created the post. Not changeable in this increment. */
    authorUserId: z.string().uuid().nullable(),
    scheduledFor: z.string().nullable(),
    publishedAt: z.string().nullable(),
    archivedAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    /**
     * Whether this caller may change the post. Reported rather than inferred from the caller's role, because
     * reading and managing are separate seeded keys and a reader legitimately holds only the first.
     */
    canManage: z.boolean(),
    /** Every slug this post has had, newest first. Each one permanently 301s to the current slug. */
    previousSlugs: z.array(BlogSlugSchema),
    tagIds: z.array(z.string().uuid()),
    translations: z.array(BlogPostTranslationSchema),
  })
  .strict();
export type BlogPostDetail = z.infer<typeof BlogPostDetailSchema>;

export const BlogPostDetailResponseSchema = z.object({ post: BlogPostDetailSchema }).strict();
export type BlogPostDetailResponse = z.infer<typeof BlogPostDetailResponseSchema>;

/** Creating a post. It is always born a draft and never featured, so neither is here to set. */
export const CreateBlogPostRequestSchema = z.object({
  slug: BlogSlugSchema,
  categoryId: z.string().uuid().nullable().optional(),
  isIndexable: z.boolean().optional(),
});
export type CreateBlogPostRequest = z.infer<typeof CreateBlogPostRequestSchema>;

export const CreateBlogPostResponseSchema = z.object({ id: z.string().uuid() }).strict();
export type CreateBlogPostResponse = z.infer<typeof CreateBlogPostResponseSchema>;

/**
 * Changing a post's address or presentation.
 *
 * Every field is optional and an absent field changes nothing. **`status` is deliberately not here**: the
 * lifecycle has its own request below, so renaming a post can never publish or archive it by accident.
 *
 * A nullable reference is cleared by sending `null` explicitly, which the service turns into the database's
 * own clear flag — absent and null have to mean different things here, or an edit to one field would wipe
 * another.
 */
export const UpdateBlogPostRequestSchema = z
  .object({
    slug: BlogSlugSchema.optional(),
    categoryId: z.string().uuid().nullable().optional(),
    coverMediaId: z.string().uuid().nullable().optional(),
    isIndexable: z.boolean().optional(),
    /** Only a published post may be featured; 0030's own constraint refuses the rest. */
    isFeatured: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'at least one field must be present' });
export type UpdateBlogPostRequest = z.infer<typeof UpdateBlogPostRequestSchema>;

/**
 * Moving a post through the lifecycle.
 *
 * `scheduledFor` is required for `scheduled` and refused for everything else, which mirrors 0030's own
 * `blog_posts_scheduled_has_time` constraint rather than adding a rule of its own.
 */
export const BlogPostStatusRequestSchema = z
  .object({
    status: BlogPostStatusSchema,
    scheduledFor: z.string().datetime().nullable().optional(),
  })
  .refine(
    (value) =>
      value.status === 'scheduled'
        ? typeof value.scheduledFor === 'string'
        : value.scheduledFor === undefined || value.scheduledFor === null,
    { message: 'scheduledFor is required for scheduled and not allowed otherwise' },
  );
export type BlogPostStatusRequest = z.infer<typeof BlogPostStatusRequestSchema>;

/** Writing one locale of a post. Creating and replacing are the same request. */
export const SaveBlogPostTranslationRequestSchema = z.object({
  title: z.string().trim().min(1).max(BLOG_TITLE_MAX),
  body: z.string().trim().min(1),
  excerpt: z.string().max(BLOG_EXCERPT_MAX).nullable().optional(),
  metaTitle: z.string().max(BLOG_META_TITLE_MAX).nullable().optional(),
  metaDescription: z.string().max(BLOG_META_DESCRIPTION_MAX).nullable().optional(),
});
export type SaveBlogPostTranslationRequest = z.infer<typeof SaveBlogPostTranslationRequestSchema>;

/**
 * Replacing a post's whole tag set.
 *
 * The set rather than a pair of add and remove calls: a set cannot leave a half-applied result, and a console
 * that renders checkboxes already knows the whole set it means.
 */
export const SaveBlogPostTagsRequestSchema = z.object({
  tagIds: z.array(z.string().uuid()).max(50),
});
export type SaveBlogPostTagsRequest = z.infer<typeof SaveBlogPostTagsRequestSchema>;

export const BlogWriteResponseSchema = z.object({ ok: z.literal(true) }).strict();
export type BlogWriteResponse = z.infer<typeof BlogWriteResponseSchema>;

// ---------------------------------------------------------------------------------------------------
// Authoring — the taxonomy
// ---------------------------------------------------------------------------------------------------
/**
 * One category as the console sees it: both names, both descriptions, and the count of every post in it.
 *
 * The count is of all posts rather than public ones. It is there to warn before a deactivation, which is a
 * different question from what the public site shows — the public taxonomy answers that one.
 */
export const BlogCategorySchema = z
  .object({
    id: z.string().uuid(),
    slug: BlogSlugSchema,
    nameEn: z.string(),
    nameAr: z.string().nullable(),
    descriptionEn: z.string().nullable(),
    descriptionAr: z.string().nullable(),
    sortOrder: z.number().int(),
    isActive: z.boolean(),
    postCount: z.number().int().min(0),
    updatedAt: z.string(),
  })
  .strict();
export type BlogCategory = z.infer<typeof BlogCategorySchema>;

export const BlogTagSchema = z
  .object({
    id: z.string().uuid(),
    slug: BlogSlugSchema,
    nameEn: z.string(),
    nameAr: z.string().nullable(),
    isActive: z.boolean(),
    postCount: z.number().int().min(0),
    updatedAt: z.string(),
  })
  .strict();
export type BlogTag = z.infer<typeof BlogTagSchema>;

export const BlogTaxonomyResponseSchema = z
  .object({
    categories: z.array(BlogCategorySchema),
    tags: z.array(BlogTagSchema),
    /** Whether this caller may change any of it, for the same reason the post detail reports it. */
    canManage: z.boolean(),
  })
  .strict();
export type BlogTaxonomyResponse = z.infer<typeof BlogTaxonomyResponseSchema>;

/**
 * Creating or replacing one category.
 *
 * English is required when creating and optional when replacing, which is 0030's own `name_en not null`
 * rather than a rule of this contract's. Arabic is optional throughout (D7), and an empty string clears it.
 */
export const SaveBlogCategoryRequestSchema = z.object({
  slug: BlogSlugSchema.optional(),
  nameEn: z.string().trim().min(1).max(BLOG_CATEGORY_NAME_MAX).optional(),
  nameAr: z.union([z.string().trim().min(1).max(BLOG_CATEGORY_NAME_MAX), z.literal('')]).nullable().optional(),
  descriptionEn: z.union([z.string().trim().min(1).max(4000), z.literal('')]).nullable().optional(),
  descriptionAr: z.union([z.string().trim().min(1).max(4000), z.literal('')]).nullable().optional(),
  sortOrder: z.number().int().min(0).max(100000).optional(),
  isActive: z.boolean().optional(),
});
export type SaveBlogCategoryRequest = z.infer<typeof SaveBlogCategoryRequestSchema>;

export const SaveBlogTagRequestSchema = z.object({
  slug: BlogSlugSchema.optional(),
  nameEn: z.string().trim().min(1).max(BLOG_TAG_NAME_MAX).optional(),
  nameAr: z.union([z.string().trim().min(1).max(BLOG_TAG_NAME_MAX), z.literal('')]).nullable().optional(),
  isActive: z.boolean().optional(),
});
export type SaveBlogTagRequest = z.infer<typeof SaveBlogTagRequestSchema>;

export const SaveBlogTaxonomyResponseSchema = z.object({ id: z.string().uuid() }).strict();
export type SaveBlogTaxonomyResponse = z.infer<typeof SaveBlogTaxonomyResponseSchema>;
