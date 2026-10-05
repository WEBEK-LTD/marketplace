import { z } from './zod.js';

/**
 * Per-entity SEO metadata — the override a public surface reads, and the surface that maintains it.
 *
 * **Every value here is one migration 0030 already constrains.** The entity kinds, both path shapes, every length
 * bound, the directive vocabulary and the rule that a directive set may not contradict itself are all constraints
 * on `public.seo_metadata`; they are restated here so a malformed request is a 400 at the edge instead of a 500
 * from a constraint, never so that this file decides them. Where the two could disagree the database wins.
 *
 * **Two owner decisions are enforced in the database, not here.** A stored `canonical_path` is read for `route` and
 * `page` only, and a stored directive set can only ever restrict. The reader applies both before anything leaves
 * the database, which is why {@link PublicSeoMetadataSchema} can say that its `robotsDirectives` are restrictive
 * and mean it: the permissive members cannot reach this type. The admin shapes carry the stored value *and* what
 * the public would receive, side by side, so a console can show an operator that a value they wrote has no effect
 * without working that out for itself.
 *
 * **`structuredData` is absent on purpose.** The column exists in 0030 and has no reader: what belongs in it is
 * fixed by the Blueprint SEO section, and emitting it would mean inventing schema.org shapes. It is not in any
 * shape here, so nothing can send one.
 *
 * **No absolute URLs.** A share image is a relative object path, exactly as a CMS page's cover is. The production
 * domain is not chosen, so nothing here builds an origin and nothing guesses one from a request header.
 */

// ---------------------------------------------------------------------------------------------------
// Shared vocabulary — every value below is one the database already constrains
// ---------------------------------------------------------------------------------------------------

/** The eight kinds `seo_metadata_entity_type_allowed` permits. There is deliberately no `service`. */
export const SEO_METADATA_ENTITY_TYPES = [
  'page',
  'blog_post',
  'blog_category',
  'blog_tag',
  'category',
  'listing',
  'seller',
  'route',
] as const;
export type SeoMetadataEntityType = (typeof SEO_METADATA_ENTITY_TYPES)[number];
export const SeoMetadataEntityTypeSchema = z.enum(SEO_METADATA_ENTITY_TYPES).openapi('SeoMetadataEntityType');

/**
 * The kinds that may be **written** from the console, which is the subset with a public surface today.
 *
 * `blog_post`, `blog_category` and `blog_tag` are storable — 0030 lists them and an existing row of one reads back
 * perfectly well — but no blog page exists to read the override, so offering them would be offering an operator a
 * form whose result reaches nobody. A service is absent for a different reason: it is a row in `listings`, so its
 * metadata is a `listing` entry.
 */
export const SEO_METADATA_WRITABLE_ENTITY_TYPES = ['page', 'category', 'listing', 'seller', 'route'] as const;
export type SeoMetadataWritableEntityType = (typeof SEO_METADATA_WRITABLE_ENTITY_TYPES)[number];
export const SeoMetadataWritableEntityTypeSchema = z
  .enum(SEO_METADATA_WRITABLE_ENTITY_TYPES)
  .openapi('SeoMetadataWritableEntityType');

/** The eight directives `seo_metadata_directives_allowed` permits — what an operator may store. */
export const SEO_DIRECTIVES = [
  'index',
  'noindex',
  'follow',
  'nofollow',
  'noarchive',
  'nosnippet',
  'noimageindex',
  'max-snippet:-1',
] as const;
export type SeoDirective = (typeof SEO_DIRECTIVES)[number];
export const SeoDirectiveSchema = z.enum(SEO_DIRECTIVES).openapi('SeoDirective');

/**
 * The restrictive subset — what a public surface can actually receive.
 *
 * `index`, `follow` and `max-snippet:-1` are the permissive members and the database drops them, so a stored value
 * can never widen indexing past what a platform rule already decided: a Sold, Expired or Archived listing and a
 * suspended seller's profile stay `noindex`, and a filtered category or search view stays `noindex`.
 */
export const SEO_RESTRICTIVE_DIRECTIVES = [
  'noindex',
  'nofollow',
  'noarchive',
  'nosnippet',
  'noimageindex',
] as const;
export type SeoRestrictiveDirective = (typeof SEO_RESTRICTIVE_DIRECTIVES)[number];
export const SeoRestrictiveDirectiveSchema = z
  .enum(SEO_RESTRICTIVE_DIRECTIVES)
  .openapi('SeoRestrictiveDirective');

/** The shape `seo_metadata_route_path_is_relative` enforces: relative, and never protocol-relative. */
export const SEO_ROUTE_PATH_PATTERN = /^\/(?!\/)[A-Za-z0-9/_\-.%]*$/;

/** The same rule for a canonical, which 0030 additionally lets carry a query string. */
export const SEO_CANONICAL_PATH_PATTERN = /^\/(?!\/)[A-Za-z0-9/_\-?=&.%]*$/;

/** The lengths 0030's own constraints enforce. */
export const SEO_META_TITLE_MAX = 70;
export const SEO_META_DESCRIPTION_MAX = 320;
export const SEO_OG_TITLE_MAX = 120;
export const SEO_OG_DESCRIPTION_MAX = 320;

/** A request-size guard, not a stored rule: 0030 puts no length on a path. 2048 is the practical URL limit. */
export const SEO_PATH_MAX = 2048;

const routePath = z.string().min(1).max(SEO_PATH_MAX).regex(SEO_ROUTE_PATH_PATTERN);
const canonicalPath = z.string().min(1).max(SEO_PATH_MAX).regex(SEO_CANONICAL_PATH_PATTERN);

/** Whether a directive set contradicts itself, which `seo_metadata_directives_are_consistent` refuses. */
export function seoDirectivesAreConsistent(directives: readonly string[]): boolean {
  const held = new Set(directives);
  return !(held.has('index') && held.has('noindex')) && !(held.has('follow') && held.has('nofollow'));
}

// ---------------------------------------------------------------------------------------------------
// What a public surface reads
// ---------------------------------------------------------------------------------------------------

/**
 * One surface's override, already reduced to what it may act on.
 *
 * `canonicalPath` is null for a `listing`, a `category` and a `seller` whatever was stored, because those keep the
 * self-referencing canonical the specification fixes for them. `robotsDirectives` holds restrictions only, so a
 * caller that merges them can only narrow indexing. Both of those happen in the database.
 */
export const PublicSeoMetadataSchema = z
  .object({
    metaTitle: z.string().nullable(),
    metaDescription: z.string().nullable(),
    canonicalPath: canonicalPath.nullable(),
    robotsDirectives: z.array(SeoRestrictiveDirectiveSchema),
    ogTitle: z.string().nullable(),
    ogDescription: z.string().nullable(),
    /** A storage path, never a URL. The caller resolves it against its own origin, or does not resolve it. */
    shareObjectPath: z.string().nullable(),
  })
  .strict()
  .openapi('PublicSeoMetadata');
export type PublicSeoMetadata = z.infer<typeof PublicSeoMetadataSchema>;

/**
 * The override, or that there is none.
 *
 * `null` rather than a 404, for the reason the redirect map's resolution is a union: "nothing stored for this
 * surface" is the common answer and must be distinguishable from the service being unreachable, or every page on
 * the site would have to choose between swallowing an outage and refusing to render.
 */
export const PublicSeoMetadataResponseSchema = z
  .object({ override: PublicSeoMetadataSchema.nullable() })
  .strict()
  .openapi('PublicSeoMetadataResponse');
export type PublicSeoMetadataResponse = z.infer<typeof PublicSeoMetadataResponseSchema>;

// ---------------------------------------------------------------------------------------------------
// The admin surface
// ---------------------------------------------------------------------------------------------------

export const SEO_METADATA_DEFAULT_LIMIT = 25;
export const SEO_METADATA_MAX_LIMIT = 100;

/** One entry as the list shows it: stored values, with a note of whether the canonical is read at all. */
export const SeoMetadataEntrySchema = z
  .object({
    id: z.string().uuid(),
    entityType: SeoMetadataEntityTypeSchema,
    entityId: z.string().uuid().nullable(),
    routePath: routePath.nullable(),
    /** The slug of whatever the entry points at, so a row reads as a thing rather than as an identifier. */
    targetSlug: z.string().nullable(),
    localeCode: z.string(),
    metaTitle: z.string().nullable(),
    metaDescription: z.string().nullable(),
    canonicalPath: canonicalPath.nullable(),
    robotsDirectives: z.array(SeoDirectiveSchema),
    ogTitle: z.string().nullable(),
    ogDescription: z.string().nullable(),
    shareMediaId: z.string().uuid().nullable(),
    /** Whether a stored canonical is read for this kind. False for a listing, a category and a seller. */
    canonicalIsHonoured: z.boolean(),
    updatedAt: z.string(),
  })
  .strict()
  .openapi('SeoMetadataEntry');
export type SeoMetadataEntry = z.infer<typeof SeoMetadataEntrySchema>;

export const SeoMetadataEntriesResponseSchema = z
  .object({
    items: z.array(SeoMetadataEntrySchema),
    nextCursor: z.string().nullable(),
  })
  .strict()
  .openapi('SeoMetadataEntriesResponse');
export type SeoMetadataEntriesResponse = z.infer<typeof SeoMetadataEntriesResponseSchema>;

/**
 * One entry, with what the public would actually receive beside what was stored.
 *
 * `effectiveCanonicalPath` and `effectiveRobotsDirectives` are the database's own answers, not this console's
 * reading of a rule. An operator who has written `index` into a row can therefore see that nothing will come of
 * it, and a screen cannot drift from the reader by explaining the rule differently.
 */
export const SeoMetadataDetailSchema = SeoMetadataEntrySchema.extend({
  shareObjectPath: z.string().nullable(),
  effectiveCanonicalPath: canonicalPath.nullable(),
  effectiveRobotsDirectives: z.array(SeoRestrictiveDirectiveSchema),
  createdAt: z.string(),
  updatedBy: z.string().uuid().nullable(),
  canManage: z.boolean(),
})
  .strict()
  .openapi('SeoMetadataDetail');
export type SeoMetadataDetail = z.infer<typeof SeoMetadataDetailSchema>;

export const SeoMetadataDetailResponseSchema = z
  .object({ entry: SeoMetadataDetailSchema })
  .strict()
  .openapi('SeoMetadataDetailResponse');
export type SeoMetadataDetailResponse = z.infer<typeof SeoMetadataDetailResponseSchema>;

/**
 * Writing one entity-and-locale's metadata.
 *
 * **It is a replace, not a patch.** One `(entity, locale)` has one row, and this request is that row: an absent
 * field clears the stored value. The form that drives it submits every field, which is the same arrangement a CMS
 * page translation uses and for the same reason — two endpoints for "create" and "change" would make a console
 * find out which it needed before it could save.
 *
 * `entityId` is required for every kind except `route`, and `routePath` for `route` alone, which is 0030's own
 * exclusivity constraint restated.
 */
export const SaveSeoMetadataRequestSchema = z
  .object({
    entityType: SeoMetadataWritableEntityTypeSchema,
    entityId: z.string().uuid().optional(),
    routePath: routePath.optional(),
    localeCode: z.string().regex(/^[a-z]{2}$/),
    metaTitle: z.string().max(SEO_META_TITLE_MAX).nullable().optional(),
    metaDescription: z.string().max(SEO_META_DESCRIPTION_MAX).nullable().optional(),
    canonicalPath: canonicalPath.nullable().optional(),
    robotsDirectives: z.array(SeoDirectiveSchema).min(1).max(SEO_DIRECTIVES.length).optional(),
    ogTitle: z.string().max(SEO_OG_TITLE_MAX).nullable().optional(),
    ogDescription: z.string().max(SEO_OG_DESCRIPTION_MAX).nullable().optional(),
    shareMediaId: z.string().uuid().nullable().optional(),
  })
  .refine(
    (value) =>
      value.entityType === 'route'
        ? typeof value.routePath === 'string' && value.entityId === undefined
        : typeof value.entityId === 'string' && value.routePath === undefined,
    { message: 'a route carries a path and no identifier; every other kind carries an identifier and no path' },
  )
  .refine((value) => value.robotsDirectives === undefined || seoDirectivesAreConsistent(value.robotsDirectives), {
    message: 'a directive set may not contradict itself',
  })
  .openapi('SaveSeoMetadataRequest');
export type SaveSeoMetadataRequest = z.infer<typeof SaveSeoMetadataRequestSchema>;

export const SaveSeoMetadataResponseSchema = z
  .object({ id: z.string().uuid() })
  .strict()
  .openapi('SaveSeoMetadataResponse');
export type SaveSeoMetadataResponse = z.infer<typeof SaveSeoMetadataResponseSchema>;

export const SeoMetadataWriteResponseSchema = z
  .object({ ok: z.literal(true) })
  .strict()
  .openapi('SeoMetadataWriteResponse');
export type SeoMetadataWriteResponse = z.infer<typeof SeoMetadataWriteResponseSchema>;
