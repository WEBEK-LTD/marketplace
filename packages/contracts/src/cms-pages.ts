import { z } from './zod.js';
import { PublicLocaleSchema } from './categories.js';

/**
 * CMS static pages — the public surface and the authoring surface.
 *
 * The public half is the smallest thing that can render a page: its text, the metadata a `<head>` needs, and
 * whether the page may be indexed. The authoring half is what a console needs to write one.
 *
 * **The three-answer shape is the contract's, not a convention.** `/v1/cms/pages/:slug` answers with a page,
 * with the slug it moved to, or with nothing — and the first two are different response bodies rather than one
 * body with optional fields, so a client cannot read a redirect as a page by forgetting to check a flag. The
 * API turns the third into a 404 and the second into a 301, and the BFF validates whichever came back.
 *
 * `resolvedLocale` is not decoration. A page may exist in English and not in Arabic (D7 forbids machine
 * translation, so an untranslated page falls back to real text somebody wrote), and the renderer has to know
 * which language it actually received in order to set `lang` and `dir` on the content it is about to show.
 */

// ---------------------------------------------------------------------------------------------------
// Shared vocabulary — every value below is one the database already constrains
// ---------------------------------------------------------------------------------------------------
/** 0030's four page states. */
export const CMS_PAGE_STATUSES = ['draft', 'scheduled', 'published', 'archived'] as const;
export type CmsPageStatus = (typeof CMS_PAGE_STATUSES)[number];
export const CmsPageStatusSchema = z.enum(CMS_PAGE_STATUSES);

/** 0030's four templates. A template chooses a layout; it is not a permission and not a content type. */
export const CMS_PAGE_TEMPLATES = ['standard', 'legal', 'help', 'landing'] as const;
export type CmsPageTemplate = (typeof CMS_PAGE_TEMPLATES)[number];
export const CmsPageTemplateSchema = z.enum(CMS_PAGE_TEMPLATES);

/** The slug shape `pages_slug_format` enforces, restated so a bad address is a 400 and never a 500. */
export const CMS_PAGE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$/;
export const CmsPageSlugSchema = z.string().regex(CMS_PAGE_SLUG_PATTERN);

/** The page-key shape `pages_page_key_format` enforces. An empty string clears the key. */
export const CMS_PAGE_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

/** The lengths 0030's translation constraints enforce. */
export const CMS_PAGE_TITLE_MAX = 200;
export const CMS_PAGE_EXCERPT_MAX = 500;
export const CMS_PAGE_META_TITLE_MAX = 70;
export const CMS_PAGE_META_DESCRIPTION_MAX = 320;

// ---------------------------------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------------------------------
export const PublicCmsPageSchema = z.object({
  slug: CmsPageSlugSchema,
  /** The stable key for a well-known page, where the admin gave it one. */
  pageKey: z.string().nullable(),
  template: CmsPageTemplateSchema,
  /** False means the page says `noindex`. The admin's decision, carried through rather than re-derived. */
  isIndexable: z.boolean(),
  /** Which language the text below is actually in, which may not be the one that was asked for. */
  resolvedLocale: PublicLocaleSchema,
  title: z.string(),
  excerpt: z.string().nullable(),
  body: z.string(),
  metaTitle: z.string().nullable(),
  metaDescription: z.string().nullable(),
  /** The storage path of the cover image, or null. Never a signed URL: the caller builds that. */
  coverObjectPath: z.string().nullable(),
  publishedAt: z.string(),
  updatedAt: z.string(),
});
export type PublicCmsPage = z.infer<typeof PublicCmsPageSchema>;

/**
 * What a slug lookup answers, as a discriminated union on `outcome`.
 *
 * The database reader answers with one of three kinds; two of them are a 200 here and the third is a 404.
 * Carrying the distinction in the body rather than in the status line is deliberate: a 301 from the API would
 * be followed transparently by `fetch`, so the BFF would receive the renamed page with a 200 and never learn
 * that it should redirect the browser. An `outcome` field cannot be followed by accident.
 *
 * The two members share no content fields, so a renderer cannot show an empty page by forgetting to branch:
 * there is no `title` on the moved member to be null.
 */
export const PublicCmsPageLookupResponseSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('page'), page: PublicCmsPageSchema }),
  z.object({ outcome: z.literal('moved'), movedTo: CmsPageSlugSchema }),
]);
export type PublicCmsPageLookupResponse = z.infer<typeof PublicCmsPageLookupResponseSchema>;

/** One entry of the published index — enough for a footer link, and nothing more. */
export const PublicCmsPageLinkSchema = z.object({
  slug: CmsPageSlugSchema,
  pageKey: z.string().nullable(),
  template: CmsPageTemplateSchema,
  isIndexable: z.boolean(),
  resolvedLocale: PublicLocaleSchema,
  title: z.string(),
  updatedAt: z.string(),
});
export type PublicCmsPageLink = z.infer<typeof PublicCmsPageLinkSchema>;

export const PublicCmsPagesResponseSchema = z.object({ pages: z.array(PublicCmsPageLinkSchema) });
export type PublicCmsPagesResponse = z.infer<typeof PublicCmsPagesResponseSchema>;

// ---------------------------------------------------------------------------------------------------
// Authoring
// ---------------------------------------------------------------------------------------------------
export const CMS_PAGES_DEFAULT_LIMIT = 25;
export const CMS_PAGES_MAX_LIMIT = 100;

export const CmsPageSummarySchema = z.object({
  id: z.string().uuid(),
  slug: CmsPageSlugSchema,
  pageKey: z.string().nullable(),
  status: CmsPageStatusSchema,
  template: CmsPageTemplateSchema,
  isIndexable: z.boolean(),
  sortOrder: z.number().int(),
  scheduledFor: z.string().nullable(),
  publishedAt: z.string().nullable(),
  archivedAt: z.string().nullable(),
  updatedAt: z.string(),
  /** Which locales exist. An empty array is a page nobody has written yet, and cannot be published. */
  translatedLocales: z.array(z.string()),
  /** The title in any locale, for the list. Null for a page with no locale at all. */
  title: z.string().nullable(),
});
export type CmsPageSummary = z.infer<typeof CmsPageSummarySchema>;

export const CmsPagePageResponseSchema = z.object({
  items: z.array(CmsPageSummarySchema),
  nextCursor: z.string().nullable(),
});
export type CmsPagePageResponse = z.infer<typeof CmsPagePageResponseSchema>;

export const CmsPageTranslationSchema = z.object({
  localeCode: z.string(),
  title: z.string(),
  excerpt: z.string().nullable(),
  body: z.string(),
  metaTitle: z.string().nullable(),
  metaDescription: z.string().nullable(),
  updatedAt: z.string(),
});
export type CmsPageTranslation = z.infer<typeof CmsPageTranslationSchema>;

export const CmsPageDetailSchema = z.object({
  id: z.string().uuid(),
  slug: CmsPageSlugSchema,
  pageKey: z.string().nullable(),
  status: CmsPageStatusSchema,
  template: CmsPageTemplateSchema,
  isIndexable: z.boolean(),
  sortOrder: z.number().int(),
  scheduledFor: z.string().nullable(),
  publishedAt: z.string().nullable(),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /**
   * Whether this caller may change the page. Reported rather than inferred from the caller's role, because
   * reading and managing are separate seeded keys and a reader legitimately holds only the first.
   */
  canManage: z.boolean(),
  /** Every slug this page has had, newest first. Each one permanently 301s to the current slug. */
  previousSlugs: z.array(CmsPageSlugSchema),
  /**
   * The cover image attached to this page, or nulls throughout when there is none (0099).
   *
   * **A stored object path, never a URL.** The `cms-media` bucket is private and has no read policy, so
   * there is nothing to link to and nothing here is signed. The path and the alt text are what an editor
   * needs to recognise which entry is attached; the naming is flat and matches what `BlogPostDetail` has
   * carried since 0092 rather than introducing a second shape for the same thing.
   */
  coverMediaId: z.string().uuid().nullable(),
  coverObjectPath: z.string().nullable(),
  coverAltTextEn: z.string().nullable(),
  coverAltTextAr: z.string().nullable(),
  translations: z.array(CmsPageTranslationSchema),
});
export type CmsPageDetail = z.infer<typeof CmsPageDetailSchema>;

export const CmsPageDetailResponseSchema = z.object({ page: CmsPageDetailSchema });
export type CmsPageDetailResponse = z.infer<typeof CmsPageDetailResponseSchema>;

/** Creating a page. It is always born a draft, so there is no status here to set. */
export const CreateCmsPageRequestSchema = z.object({
  slug: CmsPageSlugSchema,
  pageKey: z.string().regex(CMS_PAGE_KEY_PATTERN).nullable().optional(),
  template: CmsPageTemplateSchema.optional(),
  sortOrder: z.number().int().min(0).max(100000).optional(),
  isIndexable: z.boolean().optional(),
});
export type CreateCmsPageRequest = z.infer<typeof CreateCmsPageRequestSchema>;

export const CreateCmsPageResponseSchema = z.object({ id: z.string().uuid() });
export type CreateCmsPageResponse = z.infer<typeof CreateCmsPageResponseSchema>;

/**
 * Changing a page's address or presentation.
 *
 * Every field is optional and an absent field changes nothing. **`status` is deliberately not here**: the
 * lifecycle has its own request below, so renaming a page can never publish or archive it by accident.
 * `pageKey: ""` clears the key, which is why it is a string rather than only a pattern.
 */
export const UpdateCmsPageRequestSchema = z
  .object({
    slug: CmsPageSlugSchema.optional(),
    pageKey: z.union([z.string().regex(CMS_PAGE_KEY_PATTERN), z.literal('')]).nullable().optional(),
    template: CmsPageTemplateSchema.optional(),
    sortOrder: z.number().int().min(0).max(100000).optional(),
    isIndexable: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'at least one field must be present' });
export type UpdateCmsPageRequest = z.infer<typeof UpdateCmsPageRequestSchema>;

/**
 * Moving a page through the lifecycle.
 *
 * `scheduledFor` is required for `scheduled` and refused for everything else, which mirrors 0030's own
 * `pages_scheduled_has_time` constraint rather than adding a rule of its own.
 */
export const CmsPageStatusRequestSchema = z
  .object({
    status: CmsPageStatusSchema,
    scheduledFor: z.string().datetime().nullable().optional(),
  })
  .refine(
    (value) =>
      value.status === 'scheduled'
        ? typeof value.scheduledFor === 'string'
        : value.scheduledFor === undefined || value.scheduledFor === null,
    { message: 'scheduledFor is required for scheduled and not allowed otherwise' },
  );
export type CmsPageStatusRequest = z.infer<typeof CmsPageStatusRequestSchema>;

/**
 * Attaching, or removing, a page's cover image (0099).
 *
 * **`mediaId` is required and nullable, and the two cases are the two operations**: a uuid attaches that
 * library entry, and an explicit `null` removes whatever is attached. Leaving a cover alone is not a
 * request at all — it is not sending one — so there is no third value here, while the database writer
 * underneath keeps all three behaviours because a nullable reference needs them.
 *
 * There is no object path here and no upload: the entry must already exist in the library, and 0030's own
 * foreign key is what decides whether the id names one.
 */
export const CmsPageCoverRequestSchema = z
  .object({
    mediaId: z.string().uuid().nullable(),
  })
  .strict();
export type CmsPageCoverRequest = z.infer<typeof CmsPageCoverRequestSchema>;

/** Writing one locale of a page. Creating and replacing are the same request. */
export const SaveCmsPageTranslationRequestSchema = z.object({
  title: z.string().trim().min(1).max(CMS_PAGE_TITLE_MAX),
  body: z.string().trim().min(1),
  excerpt: z.string().max(CMS_PAGE_EXCERPT_MAX).nullable().optional(),
  metaTitle: z.string().max(CMS_PAGE_META_TITLE_MAX).nullable().optional(),
  metaDescription: z.string().max(CMS_PAGE_META_DESCRIPTION_MAX).nullable().optional(),
});
export type SaveCmsPageTranslationRequest = z.infer<typeof SaveCmsPageTranslationRequestSchema>;

export const CmsPageWriteResponseSchema = z.object({ ok: z.literal(true) });
export type CmsPageWriteResponse = z.infer<typeof CmsPageWriteResponseSchema>;
