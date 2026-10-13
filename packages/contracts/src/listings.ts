import { z } from './zod.js';

/**
 * The public listing contracts (Phase 4-B).
 *
 * Two surfaces: a browse list of cards and one detail document. Both carry exactly the approved public
 * projection and nothing else — no seller identifier, no view count, no coordinates, no lifecycle
 * history, and from the seller only a display name and a slug.
 *
 * V1 has no filters, no search and no distance. The only inputs are a page size and an opaque cursor.
 */

/** Whether the listing can still be acted on, or is one of the "No longer available" states (D2, N7). */
export const LISTING_AVAILABILITY = ['available', 'no_longer_available'] as const;
export type ListingAvailability = (typeof LISTING_AVAILABILITY)[number];
export const ListingAvailabilitySchema = z.enum(LISTING_AVAILABILITY);

/** Page size: the approved default and ceiling. */
export const LISTINGS_DEFAULT_LIMIT = 20;
export const LISTINGS_MAX_LIMIT = 50;

/**
 * A price in minor units, as a string.
 *
 * `price_minor` is a 64-bit integer and a JSON number is a double, so a large amount would lose
 * precision on the way out. The string is plain digits; the money package turns it into a `Money` with
 * the minor unit that travels beside it.
 */
export const MinorAmountSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);

/** The seller, as the public may see them. Two fields, by owner decision. */
export const PublicSellerSchema = z
  .object({
    slug: z.string().min(1),
    displayName: z.string().min(1),
  })
  .strict()
  .openapi('PublicSeller');

export const ListingCategorySchema = z
  .object({
    slug: z.string().min(1),
    name: z.string().min(1),
  })
  .strict()
  .openapi('ListingCategory');

/**
 * One answered attribute.
 *
 * The value arrives in the shape the attribute has rather than pre-rendered: `text` for text and
 * number attributes, `boolean` for booleans, `options` for the select types. Rendering is the client's,
 * because how a boolean or a unit reads is a matter of language, not of data.
 */
export const ListingAttributeSchema = z
  .object({
    key: z.string().min(1),
    label: z.string().min(1),
    unit: z.string().nullable(),
    kind: z.enum(['text', 'number', 'boolean', 'single_select', 'multi_select']),
    text: z.string().nullable(),
    boolean: z.boolean().nullable(),
    options: z.array(z.string()),
  })
  .strict()
  .openapi('ListingAttribute');

export const ListingTagSchema = z
  .object({
    slug: z.string().min(1),
    name: z.string().min(1),
  })
  .strict()
  .openapi('ListingTag');

/**
 * One size of one photograph (0114).
 *
 * **An absolute URL, and that is a property of the bucket rather than a looseness here.** `listing-variants`
 * is 0012's one public bucket and carries a read policy that names it, so a variant's address is an address:
 * nothing has to be signed and nothing expires. The private buckets elsewhere in this product hand over a
 * relative object path for exactly the opposite reason — there is nothing public to point at.
 *
 * The width and the height travel with it because a browser that knows them reserves the space before the
 * bytes arrive, and a catalogue that reflows as twenty photographs load is a catalogue that feels broken.
 */
export const ListingImageVariantSchema = z
  .object({
    /** `thumb`, `card` or `full` — the three sizes 0114 authorizes and nothing else. */
    key: z.enum(['thumb', 'card', 'full']),
    url: z.string().url(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict()
  .openapi('ListingImageVariant');
export type ListingImageVariant = z.infer<typeof ListingImageVariantSchema>;

/**
 * One photograph of a listing, in the sizes that were published for it.
 *
 * **There is no caption and no alt text, and that is the data rather than an omission.** 0011's
 * `listing_media` carries no text column, nothing in the console collects one, and inventing a field the
 * platform cannot fill would put an empty string on every image. The surfaces describe a photograph by the
 * listing it belongs to — "Photograph 2 of «title»" — which is true, useful to a screen reader, and derived
 * rather than stored.
 */
export const ListingImageSchema = z
  .object({
    id: z.uuid(),
    /** Ascending by width, so a caller builds a `srcset` without sorting. */
    variants: z.array(ListingImageVariantSchema).min(1),
  })
  .strict()
  .openapi('ListingImage');
export type ListingImage = z.infer<typeof ListingImageSchema>;

/**
 * The browse card: the eight approved fields, the minor unit its price cannot be read without, and — since
 * 0114 — the one photograph a card shows.
 *
 * **`primaryImage` is nullable, and a card must still work when it is null.** The platform shipped for eight
 * phases with no way to attach a photograph at all, so most listings have none, and a catalogue that only
 * reads well once every row has a picture is a catalogue that reads badly for a long time. `CatalogCard`
 * renders the media region only when there is media, which is the same rule.
 */
export const ListingSummarySchema = z
  .object({
    id: z.uuid(),
    slug: z.string().min(1),
    title: z.string().min(1),
    city: z.string().nullable(),
    priceMinor: MinorAmountSchema.nullable(),
    currencyCode: z.string().length(3),
    currencyMinorUnit: z.number().int().min(0).max(4),
    isNegotiable: z.boolean(),
    listingTypeCode: z.string().min(1),
    primaryImage: ListingImageSchema.nullable(),
  })
  .strict()
  .openapi('ListingSummary');

/** The detail document: every card field, plus what only the detail page shows. */
export const ListingDetailSchema = ListingSummarySchema.extend({
  description: z.string().min(1),
  contentLanguage: z.string().min(2),
  createdAt: z.iso.datetime(),
  availability: ListingAvailabilitySchema,
  category: ListingCategorySchema,
  seller: PublicSellerSchema,
  attributes: z.array(ListingAttributeSchema),
  tags: z.array(ListingTagSchema),
  /**
   * Every published photograph, in the order the owner arranged, primary first (0114).
   *
   * The detail page is where somebody looks at a property properly, so it gets all of them while the card
   * gets one. `primaryImage` is still present and is the first of these: a caller rendering a card from a
   * detail document should not have to work out which one that was.
   */
  images: z.array(ListingImageSchema),
})
  .strict()
  .openapi('ListingDetail');

/**
 * One page of the browse list.
 *
 * `nextCursor` is opaque: the client sends it back untouched and reads nothing from it. `null` means
 * this was the last page.
 */
export const ListingsResponseSchema = z
  .object({
    items: z.array(ListingSummarySchema),
    nextCursor: z.string().nullable(),
  })
  .strict()
  .openapi('ListingsResponse');

export const ListingDetailResponseSchema = z
  .object({
    listing: ListingDetailSchema,
  })
  .strict()
  .openapi('ListingDetailResponse');

export type PublicSeller = z.infer<typeof PublicSellerSchema>;
export type ListingCategory = z.infer<typeof ListingCategorySchema>;
export type ListingAttribute = z.infer<typeof ListingAttributeSchema>;
export type ListingTag = z.infer<typeof ListingTagSchema>;
export type ListingSummary = z.infer<typeof ListingSummarySchema>;
export type ListingDetail = z.infer<typeof ListingDetailSchema>;
export type ListingsResponse = z.infer<typeof ListingsResponseSchema>;
export type ListingDetailResponse = z.infer<typeof ListingDetailResponseSchema>;

/**
 * Parses the `limit` query parameter.
 *
 * Absent means the default. Anything that is not a whole number in range is invalid rather than
 * silently clamped: a client asking for 500 results has misunderstood the contract, and answering with
 * 50 would hide that.
 */
export function parseListingsLimit(value: unknown): { ok: true; limit: number } | { ok: false } {
  if (value === undefined || value === null || value === '') return { ok: true, limit: LISTINGS_DEFAULT_LIMIT };
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,3}$/.test(value)) return { ok: false };
  const limit = Number(value);
  return limit <= LISTINGS_MAX_LIMIT ? { ok: true, limit } : { ok: false };
}
