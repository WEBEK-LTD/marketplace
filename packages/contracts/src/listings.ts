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

/** The browse card: the eight approved fields, plus the minor unit its price cannot be read without. */
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
