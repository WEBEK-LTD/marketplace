import { z } from './zod.js';

/**
 * The CMS media library — what an operator uploads and what a console shows (Phase 8, increment 0098).
 *
 * **Two steps, because that is what a signed upload is.** The API authorizes one upload and returns a URL and the
 * object path it was issued for; the browser puts the bytes there; the API confirms and records the row. The same
 * flow Phase 6-E established for seller media, against the same storage port.
 *
 * **A client never chooses a path.** {@link CmsMediaUploadRequest} carries a content type and a byte size and
 * nothing else — the strict object refuses a path outright — and the path in {@link CmsMediaUpload} is the one the
 * database composed. The confirmation sends that path back, and the database re-checks its whole shape before
 * anything is recorded, so a path a client invented cannot be attached even if it reaches the API.
 *
 * **No SVG.** The `cms-media` bucket allows four raster types. 0030's own column constraint still lists
 * `image/svg+xml` and is untouched; the bucket is deliberately narrower, because an SVG is a script container and
 * site imagery has no need to be one. This list is restated here only so a browser is refused before a round trip —
 * the bucket row remains the authority and the database refuses anything this list would let through.
 *
 * **An object path is not an address.** `objectPath` is a relative path inside a private bucket. Nothing in this
 * file is a URL except `uploadUrl` and `previewUrl`, and both are short-lived credentials for one object, issued by
 * the API and never stored or cached. A public image URL does not exist in this increment.
 *
 * **Nothing here is read by a public surface.** A page cover, a blog cover, a share image, an `og:image`, a Twitter
 * card and any structured data are all exactly where 0085, 0091, 0092, 0095, 0096 and 0097 left them. This is the
 * library and its staff preview, and that is all.
 *
 * Every bound is 0030's own: the 300-character alt texts, positive dimensions, and a positive byte size.
 */

// ---------------------------------------------------------------------------------------------------
// Bounds, every one of them the bucket's or 0030's
// ---------------------------------------------------------------------------------------------------
/**
 * The image types the `cms-media` bucket allows.
 *
 * SVG is deliberately absent (owner decision 2). 0030's `cms_media_mime_allowed` still lists it and is unchanged;
 * the bucket narrows it rather than contradicting it.
 */
export const CMS_MEDIA_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'] as const;
export const CmsMediaContentTypeSchema = z.enum(CMS_MEDIA_CONTENT_TYPES).openapi('CmsMediaContentType');
export type CmsMediaContentType = (typeof CMS_MEDIA_CONTENT_TYPES)[number];

/** The bucket's own ceiling, restated for the same reason and no other: a browser refused before a round trip. */
export const CMS_MEDIA_MAX_BYTES = 10_485_760;

/** 0030's `cms_media_alt_text_en_length` and `cms_media_alt_text_ar_length`. */
export const CMS_MEDIA_ALT_TEXT_MAX = 300;

/** A boundary bound on the stored path, not the column's: `cms_media.object_path` is `text` with a format. */
export const CMS_MEDIA_OBJECT_PATH_MAX = 512;

/** How many entries one page of the library carries. Not a business rule. */
export const CMS_MEDIA_DEFAULT_LIMIT = 24;
export const CMS_MEDIA_MAX_LIMIT = 96;

/**
 * The shape the database composes and the only shape it will record.
 *
 * Restated here so a forged path is refused at the boundary rather than one layer down. The database re-checks it
 * regardless, which is what actually makes a traversal unattachable; this is the early no.
 */
export const CMS_MEDIA_OBJECT_PATH_PATTERN =
  /^cms-media\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|avif)$/;

// ---------------------------------------------------------------------------------------------------
// Authorizing an upload
// ---------------------------------------------------------------------------------------------------
/** A content type and a size. **No path**, and the strict object refuses one (owner decision 3). */
export const CmsMediaUploadRequestSchema = z
  .object({
    contentType: CmsMediaContentTypeSchema,
    byteSize: z.number().int().positive().max(CMS_MEDIA_MAX_BYTES),
  })
  .strict()
  .openapi('CmsMediaUploadRequest');
export type CmsMediaUploadRequest = z.infer<typeof CmsMediaUploadRequestSchema>;

export const CmsMediaUploadSchema = z
  .object({
    /** Where the bytes go. Opaque, short-lived, and bound to `objectPath` alone. */
    uploadUrl: z.string().url(),
    /** The path that was authorized. The client sends it back to confirm, and chooses none of it. */
    objectPath: z.string().regex(CMS_MEDIA_OBJECT_PATH_PATTERN),
    expiresAt: z.string().datetime(),
    maxByteSize: z.number().int().positive(),
  })
  .strict()
  .openapi('CmsMediaUpload');
export type CmsMediaUpload = z.infer<typeof CmsMediaUploadSchema>;

export const CmsMediaUploadResponseSchema = z
  .object({ upload: CmsMediaUploadSchema })
  .strict()
  .openapi('CmsMediaUploadResponse');
export type CmsMediaUploadResponse = z.infer<typeof CmsMediaUploadResponseSchema>;

// ---------------------------------------------------------------------------------------------------
// Confirming it
// ---------------------------------------------------------------------------------------------------
/**
 * The path that was authorized, and what was actually stored there.
 *
 * The dimensions are the browser's own reading of the image it uploaded. They are display metadata and nothing
 * depends on them, which is why they are optional and why 0030's "positive or absent" rule is the only one that
 * governs them. The type and the size are re-checked against the bucket, and the extension must agree with the
 * type, so a file cannot be recorded as something it is not.
 */
export const CmsMediaAttachRequestSchema = z
  .object({
    objectPath: z.string().max(CMS_MEDIA_OBJECT_PATH_MAX).regex(CMS_MEDIA_OBJECT_PATH_PATTERN),
    contentType: CmsMediaContentTypeSchema,
    byteSize: z.number().int().positive().max(CMS_MEDIA_MAX_BYTES),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    altTextEn: z.string().max(CMS_MEDIA_ALT_TEXT_MAX).nullable().optional(),
    altTextAr: z.string().max(CMS_MEDIA_ALT_TEXT_MAX).nullable().optional(),
  })
  .strict()
  .openapi('CmsMediaAttachRequest');
export type CmsMediaAttachRequest = z.infer<typeof CmsMediaAttachRequestSchema>;

export const CmsMediaAttachResponseSchema = z
  .object({ id: z.string().uuid() })
  .strict()
  .openapi('CmsMediaAttachResponse');
export type CmsMediaAttachResponse = z.infer<typeof CmsMediaAttachResponseSchema>;

// ---------------------------------------------------------------------------------------------------
// What a console reads
// ---------------------------------------------------------------------------------------------------
/** One entry. `objectPath` is a path inside a private bucket and is never an address. */
export const CmsMediaEntrySchema = z
  .object({
    id: z.string().uuid(),
    objectPath: z.string(),
    contentType: z.string(),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
    byteSize: z.number().int().positive(),
    altTextEn: z.string().nullable(),
    altTextAr: z.string().nullable(),
    /** How many CMS rows point at this entry. Zero means deleting it blanks nothing. */
    usageCount: z.number().int().min(0),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .openapi('CmsMediaEntry');
export type CmsMediaEntry = z.infer<typeof CmsMediaEntrySchema>;

export const CmsMediaPageResponseSchema = z
  .object({
    items: z.array(CmsMediaEntrySchema),
    nextCursor: z.string().nullable(),
    canManage: z.boolean(),
  })
  .strict()
  .openapi('CmsMediaPageResponse');
export type CmsMediaPageResponse = z.infer<typeof CmsMediaPageResponseSchema>;

// ---------------------------------------------------------------------------------------------------
// Where an entry is used
// ---------------------------------------------------------------------------------------------------
/** The kinds of row that can point at a media entry. 0030's six columns across five tables. */
export const CMS_MEDIA_USAGE_TYPES = ['page', 'blog_post', 'banner', 'seo_settings', 'seo_metadata'] as const;
export const CmsMediaUsageTypeSchema = z.enum(CMS_MEDIA_USAGE_TYPES).openapi('CmsMediaUsageType');
export type CmsMediaUsageType = (typeof CMS_MEDIA_USAGE_TYPES)[number];

/**
 * One row that points at an entry.
 *
 * `entityId` is null for the SEO settings, whose primary key is a locale code rather than an identifier; `label`
 * carries the human-recognisable part for every kind, and `column` says which of a table's columns points at it —
 * a banner has two.
 */
export const CmsMediaUsageSchema = z
  .object({
    entityType: CmsMediaUsageTypeSchema,
    entityId: z.string().uuid().nullable(),
    label: z.string(),
    column: z.string(),
  })
  .strict()
  .openapi('CmsMediaUsage');
export type CmsMediaUsage = z.infer<typeof CmsMediaUsageSchema>;

/**
 * Every reference to one entry, which a console shows **before** offering to delete it (owner decision 5).
 *
 * All six referencing columns are `on delete set null`, so deleting an entry blanks whatever points at it. An
 * operator has to be able to see that first rather than discover it afterwards.
 */
export const CmsMediaUsageResponseSchema = z
  .object({
    id: z.string().uuid(),
    references: z.array(CmsMediaUsageSchema),
  })
  .strict()
  .openapi('CmsMediaUsageResponse');
export type CmsMediaUsageResponse = z.infer<typeof CmsMediaUsageResponseSchema>;

// ---------------------------------------------------------------------------------------------------
// The staff preview
// ---------------------------------------------------------------------------------------------------
/**
 * A short-lived signed URL for one stored object.
 *
 * Issued per request and never stored: it is a bearer credential for one object for a few minutes. This is a
 * **staff** preview — it is not, and must not become, how a public page shows an image (owner decision 4).
 */
export const CmsMediaPreviewResponseSchema = z
  .object({
    id: z.string().uuid(),
    url: z.string().url(),
    expiresAt: z.string().datetime(),
  })
  .strict()
  .openapi('CmsMediaPreviewResponse');
export type CmsMediaPreviewResponse = z.infer<typeof CmsMediaPreviewResponseSchema>;

// ---------------------------------------------------------------------------------------------------
// The one editable field
// ---------------------------------------------------------------------------------------------------
/**
 * Both alt texts, neither required (owner decision 7).
 *
 * Nothing else about a stored object is editable: the path, the type, the size and the dimensions describe a file
 * that has already been uploaded, and changing any of them would make the row disagree with the bucket. Replacing
 * an image means uploading another one.
 */
export const CmsMediaAltTextRequestSchema = z
  .object({
    altTextEn: z.string().max(CMS_MEDIA_ALT_TEXT_MAX).nullable().optional(),
    altTextAr: z.string().max(CMS_MEDIA_ALT_TEXT_MAX).nullable().optional(),
  })
  .strict()
  .openapi('CmsMediaAltTextRequest');
export type CmsMediaAltTextRequest = z.infer<typeof CmsMediaAltTextRequestSchema>;

/** Every write on this surface that returns nothing else answers the same way. */
export const CmsMediaWriteResponseSchema = z
  .object({ ok: z.literal(true) })
  .strict()
  .openapi('CmsMediaWriteResponse');
export type CmsMediaWriteResponse = z.infer<typeof CmsMediaWriteResponseSchema>;
