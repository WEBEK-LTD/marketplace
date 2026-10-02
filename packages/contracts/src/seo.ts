import { z } from './zod.js';
import { PublicLocaleSchema } from './categories.js';

/**
 * Public SEO delivery — what `robots.txt` and the sitemaps are built from.
 *
 * Both documents are assembled by the public web and read by crawlers. Nothing here is authenticated, nothing
 * here is written, and nothing here is private: the whole purpose of every value is to be served to a robot.
 *
 * **What a sitemap entry is.** A slug and the moment the thing it names last changed. The web app turns the
 * slug into an absolute URL, because only it knows the origin and the path shape each surface owns; the API
 * does not deal in URLs. A CMS static page additionally reports the locales it actually resolves in, since a
 * page written only in Arabic has no English address and a sitemap must not advertise one that answers 404.
 *
 * **Why the index is counts rather than URLs.** `sitemap.ts` names its children, and a child exists only if
 * there is at least one entry for it. Counting is the smallest answer that lets the index name exactly the
 * sitemaps that exist, and it is one call rather than one per kind.
 */

// ---------------------------------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------------------------------
/**
 * The kinds of address a sitemap is built from.
 *
 * `route` is the public web's own: a handful of fixed landing paths (`/listings`, `/services`, `/categories`,
 * `/marketplace`) that exist in code rather than in a table, so the API neither counts nor enumerates them.
 * It is in this list because the sitemap index names it alongside the rest.
 */
export const SITEMAP_ENTRY_TYPES = ['route', 'page', 'listing', 'service', 'category', 'seller'] as const;
export type SitemapEntryType = (typeof SITEMAP_ENTRY_TYPES)[number];
export const SitemapEntryTypeSchema = z.enum(SITEMAP_ENTRY_TYPES);

/** The kinds the API answers for: every kind except the one the web app holds in code. */
export const SITEMAP_API_ENTRY_TYPES = ['page', 'listing', 'service', 'category', 'seller'] as const;
export type SitemapApiEntryType = (typeof SITEMAP_API_ENTRY_TYPES)[number];
export const SitemapApiEntryTypeSchema = z.enum(SITEMAP_API_ENTRY_TYPES);

/**
 * How many entries one sitemap carries.
 *
 * The sitemap protocol allows at most 50,000 URLs or 50MB uncompressed in one document, and that limit is the
 * only reason a limit exists here. The page size is set well under it so that a document stays small enough to
 * build and serve in one request, and so that a page of entries is a reasonable read rather than a whole
 * catalogue. It is not a business rule and nothing depends on its exact value.
 */
export const SITEMAP_PROTOCOL_MAX_ENTRIES = 50_000;
export const SITEMAP_PAGE_SIZE = 5_000;

/** The slug shape every public surface already enforces, restated so a bad address is a 400 and not a 500. */
export const SITEMAP_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$/;

// ---------------------------------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------------------------------
/**
 * The authored `robots.txt` body, or `null` when nobody has authored one.
 *
 * `null` is a state and not a failure. `seo_settings` ships with no rows and the console that would write
 * them is not built, so the common answer today is "nothing authored" — and the web app then serves a minimal
 * correct document rather than inventing directives nobody asked for.
 *
 * The body is served to crawlers verbatim, so it travels as text and is never parsed here. `locale` says which
 * locale's row answered, which is the site's default: `robots.txt` is one document at the root of an origin
 * while `seo_settings` is keyed by locale.
 */
export const RobotsSettingsResponseSchema = z.object({
  locale: PublicLocaleSchema.nullable(),
  body: z.string().max(10_000).nullable(),
});
export type RobotsSettingsResponse = z.infer<typeof RobotsSettingsResponseSchema>;

// ---------------------------------------------------------------------------------------------------
// The sitemap index
// ---------------------------------------------------------------------------------------------------
/** How many entries one kind of address would produce. A kind with nothing in it reports zero. */
export const SitemapCountSchema = z.object({
  type: SitemapApiEntryTypeSchema,
  entries: z.number().int().min(0),
});
export type SitemapCount = z.infer<typeof SitemapCountSchema>;

export const SitemapCountsResponseSchema = z.object({
  pageSize: z.number().int().min(1).max(SITEMAP_PROTOCOL_MAX_ENTRIES),
  counts: z.array(SitemapCountSchema),
});
export type SitemapCountsResponse = z.infer<typeof SitemapCountsResponseSchema>;

// ---------------------------------------------------------------------------------------------------
// A page of entries
// ---------------------------------------------------------------------------------------------------
/**
 * One address a sitemap lists.
 *
 * `locales` is present only where it can differ from "both": a CMS static page absent in one language. Every
 * other surface resolves in both locales whatever language its content is in, because the readers that decide
 * their visibility take no locale and the surfaces fall back.
 */
export const SitemapEntrySchema = z.object({
  slug: z.string().regex(SITEMAP_SLUG_PATTERN),
  updatedAt: z.string().datetime(),
  locales: z.array(PublicLocaleSchema).min(1).optional(),
});
export type SitemapEntry = z.infer<typeof SitemapEntrySchema>;

export const SitemapPageResponseSchema = z.object({
  type: SitemapApiEntryTypeSchema,
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1).max(SITEMAP_PROTOCOL_MAX_ENTRIES),
  entries: z.array(SitemapEntrySchema),
});
export type SitemapPageResponse = z.infer<typeof SitemapPageResponseSchema>;
