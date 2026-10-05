import { z } from './zod.js';
import { SEO_ROBOTS_BODY_MAX } from './seo.js';

/**
 * Site-wide SEO settings — what an operator authors and what a console shows (Phase 8, increment 0096).
 *
 * **This is an authoring contract and nothing else.** Not one schema here is read by a public surface. The site
 * name does not become the header's or a page title's source; the default title and description are not wired into
 * any metadata resolver; the handle emits no Twitter metadata; and the organization document emits no JSON-LD.
 * Each of those is a stored value an operator maintains, and consuming any of them is a separate, explicitly
 * approved change. The one column that *is* already served — `robots_txt_body` — has had its reader since 0086,
 * and this file does not touch it.
 *
 * **Every bound here is 0030's own.** The 1–120 site name, the 70-character default title, the 320-character
 * default description, the `^@[A-Za-z0-9_]{1,15}$` handle and the organization document being a JSON object are
 * its five constraints, restated so a bad value is a 400 rather than a 500. The locale code is 0002's own format.
 *
 * **The robots body's two bounds are deliberately the same number.** {@link SEO_ROBOTS_BODY_MAX} is what the
 * public robots response has carried since 0086, and the authoring request below reuses that very constant rather
 * than naming its own. If authoring allowed a longer body than the public contract accepted, an operator could
 * save a document that made `/robots.txt` fail validation and answer 503 — a crawl policy that silently took the
 * site's robots document offline. One constant makes that unrepresentable.
 *
 * **`robotsIsServed` is read, never computed here** (owner decision 5). `robots.txt` is one document at the root of
 * an origin while these settings are per locale, so the database reports which locale's body actually reaches a
 * crawler, from the same `locales.is_default` column 0086's reader filters on. A console shows the answer; it does
 * not work it out.
 *
 * **`shareMediaObjectPath` is a relative object path in a private bucket and is never an address.** The
 * `cms-media` bucket is private, no media origin or signing capability exists, and nothing here builds a URL. A
 * console shows the stored identifier and says plainly that the image cannot be resolved or displayed (owner
 * decision 8).
 *
 * **There is no read key.** 0033 seeds `seo.settings.manage` and nothing else for this cluster, so whoever can
 * reach this surface may change it. `canManage` is reported all the same, because every console section in this
 * API reports it and a client should read the capability rather than infer it from having been served.
 */

// ---------------------------------------------------------------------------------------------------
// Bounds, every one of them 0030's or 0002's
// ---------------------------------------------------------------------------------------------------
/** 0030's `seo_settings_site_name_length`, upper bound. */
export const SEO_SITE_NAME_MAX = 120;

/** 0030's `seo_settings_default_meta_title_length`. */
export const SEO_DEFAULT_META_TITLE_MAX = 70;

/** 0030's `seo_settings_default_meta_description_length`. */
export const SEO_DEFAULT_META_DESCRIPTION_MAX = 320;

/** 0030's `seo_settings_twitter_site_format`, character for character. */
export const SEO_TWITTER_SITE_PATTERN = /^@[A-Za-z0-9_]{1,15}$/;

/** 0002's `locales_code_format`. A regional locale is representable because the column's own format allows one. */
export const SEO_SETTINGS_LOCALE_PATTERN = /^[a-z]{2}(-[A-Z]{2})?$/;

const localeCode = z.string().regex(SEO_SETTINGS_LOCALE_PATTERN);

// ---------------------------------------------------------------------------------------------------
// What a console reads
// ---------------------------------------------------------------------------------------------------
/**
 * One locale's settings as the console shows them, authored or not.
 *
 * Every authored field is nullable because an unauthored locale has none of them — `isAuthored` is how the two
 * states are told apart, and it is what makes the first save possible: the console lists the locales the platform
 * has rather than the rows the table holds.
 */
export const SeoSettingsLocaleSchema = z
  .object({
    localeCode,
    /** The locale's own names, so a panel reads as a language rather than as a code. */
    nameEn: z.string(),
    nameNative: z.string(),
    /** Whether this is the platform's default locale. */
    isDefaultLocale: z.boolean(),
    /** Whether anything has been stored for this locale at all. */
    isAuthored: z.boolean(),
    /**
     * Whether this locale's `robotsTxtBody` is the one `/robots.txt` serves (owner decision 5).
     *
     * True for the default locale and only the default locale. A body may be authored on any locale; on a locale
     * where this is false it is stored and never served, and the console says so.
     */
    robotsIsServed: z.boolean(),
    siteName: z.string().nullable(),
    defaultMetaTitle: z.string().nullable(),
    defaultMetaDescription: z.string().nullable(),
    /** The stored identifier. The image itself cannot be resolved or displayed (owner decision 8). */
    defaultShareMediaId: z.string().uuid().nullable(),
    /** A relative object path inside the private `cms-media` bucket. Not an address, and never resolvable here. */
    shareMediaObjectPath: z.string().nullable(),
    twitterSite: z.string().nullable(),
    robotsTxtBody: z.string().nullable(),
    /** An operator-authored JSON object. Stored only: nothing emits it (owner decision 4). */
    organizationStructuredData: z.record(z.string(), z.unknown()).nullable(),
    updatedAt: z.string().nullable(),
  })
  .strict()
  .openapi('SeoSettingsLocale');
export type SeoSettingsLocale = z.infer<typeof SeoSettingsLocaleSchema>;

/**
 * Every active locale, default locale first.
 *
 * An empty list is not a normal answer — the platform always has at least one active locale — but it is the honest
 * shape for a caller who holds nothing, which this API reports as an absence before it ever reaches here.
 */
export const SeoSettingsResponseSchema = z
  .object({
    locales: z.array(SeoSettingsLocaleSchema),
    canManage: z.boolean(),
  })
  .strict()
  .openapi('SeoSettingsResponse');
export type SeoSettingsResponse = z.infer<typeof SeoSettingsResponseSchema>;

// ---------------------------------------------------------------------------------------------------
// What a console writes
// ---------------------------------------------------------------------------------------------------
/**
 * One locale's settings, in full.
 *
 * **A save is a replace**, exactly as 0091's metadata save is: creating and replacing are one request, and an
 * omitted optional field is stored as absent rather than left alone. The console sends the form, and the form is
 * the row. That is also how an authored crawl policy is withdrawn without deleting the locale — send the form
 * without a body.
 *
 * `siteName` is the one required field, because 0030 declares the column `not null`.
 *
 * `robotsTxtBody` is the only field whose content is served to anybody, and it is served verbatim. It is a string
 * here and is never parsed, split or structured: a crawl policy's meaning is the author's.
 */
export const SaveSeoSettingsRequestSchema = z
  .object({
    siteName: z.string().trim().min(1).max(SEO_SITE_NAME_MAX),
    defaultMetaTitle: z.string().max(SEO_DEFAULT_META_TITLE_MAX).nullable().optional(),
    defaultMetaDescription: z.string().max(SEO_DEFAULT_META_DESCRIPTION_MAX).nullable().optional(),
    defaultShareMediaId: z.string().uuid().nullable().optional(),
    twitterSite: z.string().regex(SEO_TWITTER_SITE_PATTERN).nullable().optional(),
    robotsTxtBody: z.string().max(SEO_ROBOTS_BODY_MAX).nullable().optional(),
    organizationStructuredData: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict()
  .openapi('SaveSeoSettingsRequest');
export type SaveSeoSettingsRequest = z.infer<typeof SaveSeoSettingsRequestSchema>;

/** Every write on this surface answers the same way. */
export const SeoSettingsWriteResponseSchema = z
  .object({ ok: z.literal(true) })
  .strict()
  .openapi('SeoSettingsWriteResponse');
export type SeoSettingsWriteResponse = z.infer<typeof SeoSettingsWriteResponseSchema>;
