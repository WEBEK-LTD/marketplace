import { z } from './zod.js';
import { ListingImageVariantSchema } from './listings.js';

/**
 * Attaching photographs to a listing (increment 0116, migration 0114).
 *
 * **The flow is 6-E's, widened to four objects at once.** The browser asks for authorization, uploads the
 * bytes itself, then confirms — the same three steps the seller's logo already uses, with the same property:
 * **the browser never names a destination.** A request carries a variant key, a content type and a size; the
 * object path comes back from `app_private.listing_media_upload_target`, which derives it from the listing's
 * own identifier. There is no path field in any request below except the confirmation, and the confirmation's
 * path is checked against the prefix the authorizer itself would have issued.
 *
 * **Four objects, one photograph, one transaction.** A photograph is an original plus three served sizes, and
 * `listing_media_attach` takes all four or none: a photograph with two of its three sizes is a card the
 * catalogue cannot render and a state every reader would have to handle. So authorization is asked for the
 * four together and confirmation names the four together.
 *
 * **The three served sizes are produced in the browser, by owner decision.** The owner chose browser-side
 * re-encoding over a server image pipeline, so a canvas draws each size and encodes it as WebP. That is why
 * `contentType` admits one value for a served size: whatever the seller selected, what is uploaded was drawn
 * by a canvas and encoded by `toBlob`, and anything else would be a file this platform never produced.
 *
 * **What that choice costs is recorded rather than hidden.** A canvas re-encode drops the source file's
 * metadata, including its EXIF location, because a canvas keeps pixels and nothing else — which is the reason
 * the owner chose it. But it is the *browser* that drops it, and the database cannot see what a caller
 * actually uploaded to its own signed target. So `listing_media.metadata_stripped_at` is deliberately never
 * set by this flow: the only honest value is one the server could stand behind, and no server-side byte check
 * exists yet. A caller that bypassed this console and uploaded an untouched photograph to its own authorized
 * path would have its EXIF served. That residual risk is recorded in migration 0114's header and needs a
 * byte-level check on the server before `metadata_stripped_at` means anything.
 */

/** The four objects one photograph is made of. `original` is private; the other three are served. */
export const ListingMediaVariantKeySchema = z.enum(['original', 'thumb', 'card', 'full']);
export type ListingMediaVariantKey = z.infer<typeof ListingMediaVariantKeySchema>;

/**
 * What the original may be, by type.
 *
 * The seller's own file, so the list is 0012's `listing-originals` bucket, which admits what a phone camera
 * and a desktop produce. The served sizes are not on this list: they were drawn by a canvas.
 */
export const LISTING_ORIGINAL_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/heic',
] as const;

/** 0012's own ceilings: 25 MiB for an original, 10 MiB for a served size. */
export const LISTING_ORIGINAL_MAX_BYTES = 26_214_400;
export const LISTING_VARIANT_MAX_BYTES = 10_485_760;

/** One object's authorization request. */
export const ListingMediaUploadItemSchema = z
  .object({
    variantKey: ListingMediaVariantKeySchema,
    contentType: z.enum(LISTING_ORIGINAL_CONTENT_TYPES),
    byteSize: z.number().int().positive().max(LISTING_ORIGINAL_MAX_BYTES),
  })
  .strict()
  .openapi('ListingMediaUploadItem');
export type ListingMediaUploadItem = z.infer<typeof ListingMediaUploadItemSchema>;

/**
 * The four objects, asked for together.
 *
 * Exactly four entries and four distinct keys, because that is what a photograph is. The database checks the
 * same thing on confirmation; this refuses a malformed request before anything is signed.
 */
export const ListingMediaUploadRequestSchema = z
  .object({
    variants: z
      .array(ListingMediaUploadItemSchema)
      .length(4)
      .refine(
        (items) => new Set(items.map((item) => item.variantKey)).size === 4,
        'each of the four variant keys exactly once',
      ),
  })
  .strict()
  .openapi('ListingMediaUploadRequest');
export type ListingMediaUploadRequest = z.infer<typeof ListingMediaUploadRequestSchema>;

/** One authorized destination. The path was composed by the database and is sent back on confirmation. */
export const ListingMediaUploadTargetSchema = z
  .object({
    variantKey: ListingMediaVariantKeySchema,
    /** Opaque, short-lived, and bound to `objectPath` alone. */
    uploadUrl: z.string().url(),
    objectPath: z.string().min(1).max(512),
    expiresAt: z.string().datetime(),
    maxByteSize: z.number().int().positive(),
  })
  .strict()
  .openapi('ListingMediaUploadTarget');
export type ListingMediaUploadTarget = z.infer<typeof ListingMediaUploadTargetSchema>;

export const ListingMediaUploadResponseSchema = z
  .object({ targets: z.array(ListingMediaUploadTargetSchema).length(4) })
  .strict()
  .openapi('ListingMediaUploadResponse');
export type ListingMediaUploadResponse = z.infer<typeof ListingMediaUploadResponseSchema>;

/** One uploaded object, as the confirmation describes it. */
export const ListingMediaAttachItemSchema = z
  .object({
    variantKey: ListingMediaVariantKeySchema,
    /** The path that came back from authorization, unchanged. Anything else is refused by the database. */
    objectPath: z.string().min(1).max(512),
    width: z.number().int().positive().max(20_000),
    height: z.number().int().positive().max(20_000),
    byteSize: z.number().int().positive().max(LISTING_ORIGINAL_MAX_BYTES),
  })
  .strict()
  .openapi('ListingMediaAttachItem');
export type ListingMediaAttachItem = z.infer<typeof ListingMediaAttachItemSchema>;

export const ListingMediaAttachRequestSchema = z
  .object({
    variants: z
      .array(ListingMediaAttachItemSchema)
      .length(4)
      .refine(
        (items) => new Set(items.map((item) => item.variantKey)).size === 4,
        'each of the four variant keys exactly once',
      ),
  })
  .strict()
  .openapi('ListingMediaAttachRequest');
export type ListingMediaAttachRequest = z.infer<typeof ListingMediaAttachRequestSchema>;

/**
 * One photograph as whoever manages it sees it.
 *
 * **It carries `status` and the whole list carries unpublished photographs**, which the public shape does
 * not: a seller adding pictures to a draft has to see what is there before the listing goes live, and "this
 * one is not published yet" is the fact that explains why the public page does not show it.
 *
 * The addresses are the same public ones the catalogue serves, composed the same way. `listing-variants` is a
 * public bucket and its read policy names the bucket rather than the row, so a variant of a draft is
 * reachable by anyone holding its URL — the random component in the path is what keeps it from being
 * guessable, and it is not an access control. Nothing is signed here, because signing would suggest one.
 */
export const ListingMediaItemSchema = z
  .object({
    id: z.uuid(),
    position: z.number().int().min(0),
    isPrimary: z.boolean(),
    status: z.enum(['pending', 'processing', 'ready', 'failed']),
    /** Published or not; a draft's photographs are not. */
    isPublished: z.boolean(),
    variants: z.array(ListingImageVariantSchema),
  })
  .strict()
  .openapi('ListingMediaItem');
export type ListingMediaItem = z.infer<typeof ListingMediaItemSchema>;

export const ListingMediaListResponseSchema = z
  .object({ items: z.array(ListingMediaItemSchema) })
  .strict()
  .openapi('ListingMediaListResponse');
export type ListingMediaListResponse = z.infer<typeof ListingMediaListResponseSchema>;

export const ListingMediaAttachResponseSchema = ListingMediaListResponseSchema.extend({
  /** The photograph that was just attached, so a client can point at it without matching on anything. */
  attachedId: z.uuid(),
})
  .strict()
  .openapi('ListingMediaAttachResponse');
export type ListingMediaAttachResponse = z.infer<typeof ListingMediaAttachResponseSchema>;
