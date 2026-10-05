import {
  ListingAttributeSchema,
  ListingAvailabilitySchema,
  ListingCategorySchema,
  ListingTagSchema,
  MinorAmountSchema,
  PublicSellerSchema,
} from './listings.js';
import { z } from './zod.js';

/**
 * The public service contracts (Phase 4-C).
 *
 * Services live on their own surface — `/services` and `/service/<slug>` — but they are listings, so the
 * pieces a service shares with a product (the seller projection, the category, attributes, tags, the
 * availability marker, the minor-unit price) are the Phase 4-B schemas rather than copies of them. What
 * is new here is what makes a service a service: how it is priced, how long it takes, how many revisions
 * it includes, whether it needs a brief, and what it covers.
 *
 * As on the listing surface, the projection is exactly the approved one: no seller identifier, no legal
 * name, no contact details, no verification status, no coordinates and no lifecycle history.
 */

/** How the seller priced the work. A service with no details row states neither. */
export const SERVICE_PRICING_MODELS = ['fixed', 'custom'] as const;
export type ServicePricingModel = (typeof SERVICE_PRICING_MODELS)[number];
export const ServicePricingModelSchema = z.enum(SERVICE_PRICING_MODELS);

/** Page size: mirrored from the listing contract, by owner decision. */
export const SERVICES_DEFAULT_LIMIT = 20;
export const SERVICES_MAX_LIMIT = 50;

/**
 * The service card.
 *
 * `deliveryDays` is bounded by the database's own check (1–365). It and `revisionsIncluded` are nullable
 * because `listing_service_details` is a separate row: a service without one has nothing to state, and
 * defaulting it here would assert something no seller recorded.
 */
export const ServiceSummarySchema = z
  .object({
    id: z.uuid(),
    slug: z.string().min(1),
    title: z.string().min(1),
    city: z.string().nullable(),
    priceMinor: MinorAmountSchema.nullable(),
    currencyCode: z.string().length(3),
    currencyMinorUnit: z.number().int().min(0).max(4),
    pricingModel: ServicePricingModelSchema.nullable(),
    deliveryDays: z.number().int().min(1).max(365).nullable(),
    revisionsIncluded: z.number().int().min(0).nullable(),
  })
  .strict()
  .openapi('ServiceSummary');

/** The detail document: every card field, plus what only the detail page shows. */
export const ServiceDetailSchema = ServiceSummarySchema.extend({
  description: z.string().min(1),
  contentLanguage: z.string().min(2),
  requiresBrief: z.boolean().nullable(),
  scope: z.string().nullable(),
  availability: ListingAvailabilitySchema,
  category: ListingCategorySchema,
  seller: PublicSellerSchema,
  attributes: z.array(ListingAttributeSchema),
  tags: z.array(ListingTagSchema),
})
  .strict()
  .openapi('ServiceDetail');

/**
 * One page of the service browse list.
 *
 * `nextCursor` is opaque: the client sends it back untouched and reads nothing from it. `null` means
 * this was the last page.
 */
export const ServicesResponseSchema = z
  .object({
    items: z.array(ServiceSummarySchema),
    nextCursor: z.string().nullable(),
  })
  .strict()
  .openapi('ServicesResponse');

export const ServiceDetailResponseSchema = z
  .object({
    service: ServiceDetailSchema,
  })
  .strict()
  .openapi('ServiceDetailResponse');

export type ServiceSummary = z.infer<typeof ServiceSummarySchema>;
export type ServiceDetail = z.infer<typeof ServiceDetailSchema>;
export type ServicesResponse = z.infer<typeof ServicesResponseSchema>;
export type ServiceDetailResponse = z.infer<typeof ServiceDetailResponseSchema>;

/**
 * Which public surface owns a slug.
 *
 * One slug names one listing, and that listing is either a product or a service. When the wrong surface
 * is asked for it the answer is a redirect to the right one, so the type travels with the redirect —
 * over the wire as an internal response header, never as a field of a public document.
 */
export const CANONICAL_SURFACES = ['product', 'service'] as const;
export type CanonicalSurface = (typeof CANONICAL_SURFACES)[number];

export function isCanonicalSurface(value: unknown): value is CanonicalSurface {
  return typeof value === 'string' && (CANONICAL_SURFACES as readonly string[]).includes(value);
}

/**
 * Parses the `limit` query parameter for the service list.
 *
 * Absent means the default. Anything that is not a whole number in range is invalid rather than
 * silently clamped, exactly as on the listing surface.
 */
export function parseServicesLimit(value: unknown): { ok: true; limit: number } | { ok: false } {
  if (value === undefined || value === null || value === '') return { ok: true, limit: SERVICES_DEFAULT_LIMIT };
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,3}$/.test(value)) return { ok: false };
  const limit = Number(value);
  return limit <= SERVICES_MAX_LIMIT ? { ok: true, limit } : { ok: false };
}
