import { z } from './zod.js';

/**
 * Offers: negotiation and acceptance (Phase 7-H).
 *
 * Two reads and five writes, and the shapes below are decisions rather than conveniences.
 *
 *   * **No request names an account.** There is no buyer, seller or reviewer field in any request schema
 *     here. A caller addresses a *listing* or an *offer*, both of which name a row rather than a person,
 *     and their own side of the negotiation is resolved from their session upstream.
 *   * **No request names a seller, a currency or an expiry.** All three come out of the listing — or, for
 *     a counter, out of the offer being replaced — inside the database. That is what makes a
 *     cross-listing or cross-seller counter impossible rather than merely refused: there is no field to
 *     put one in.
 *   * **No request names a status, an acceptance time or a payment deadline.** The five writes are named
 *     operations, not status assignments, so `draft`-style state juggling is not expressible. In
 *     particular `paymentDueAt` appears in **no** request schema in this module: it is derived in the
 *     database from the acceptance time and the admin-configured window.
 *   * **Money follows the repository's rule.** An amount is a decimal string of minor units, it travels
 *     with its `currencyCode`, and the authoritative decimal places travel beside it as
 *     `currencyMinorUnit`. No amount anywhere in this module is a JSON number.
 *
 * {@link OfferStatusSchema} is 0015's six-name vocabulary, verbatim. 7-H adds no status, and `expired` is
 * written only by the existing scheduled sweeper — never by an operation here.
 */

/** 0015's status vocabulary. Read-only here; nothing in 7-H adds to it. */
export const OFFER_STATUSES = [
  'pending',
  'accepted',
  'rejected',
  'countered',
  'withdrawn',
  'expired',
] as const;
export const OfferStatusSchema = z.enum(OFFER_STATUSES).openapi('OfferStatus');

export const OFFERS_DEFAULT_LIMIT = 20;
export const OFFERS_MAX_LIMIT = 50;

/**
 * An amount in minor units, as a string.
 *
 * `offers.amount_minor` is a 64-bit integer and a JSON number is a double, so a large amount would lose
 * precision on the way out — the same reason {@link MinorAmountSchema} exists for listing prices. The
 * leading digit cannot be zero because `offers_amount_positive` requires a positive amount, so "0" is not
 * a representable offer.
 */
export const OfferAmountMinorSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .openapi('OfferAmountMinor');

/** 0015's `offers_quantity_positive`, and the integer column behind it. */
export const OfferQuantitySchema = z.number().int().min(1).max(2_147_483_647);

/** 0015's `offers_message_length`. Trimmed, and absent rather than blank. */
export const OfferMessageSchema = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .openapi('OfferMessage');

/** The fields both sides of a negotiation see on one offer. */
const offerCore = {
  id: z.uuid(),
  listingId: z.uuid(),
  listingSlug: z.string().min(1),
  listingTitle: z.string().min(1),
  amountMinor: OfferAmountMinorSchema,
  currencyCode: z.string().length(3),
  currencyMinorUnit: z.number().int().min(0).max(4),
  quantity: z.number().int().min(1),
  message: z.string().nullable(),
  status: OfferStatusSchema,
  /**
   * Whether a `pending` offer's window has already passed.
   *
   * Derived from `expires_at`, never stored: the scheduled sweeper owns writing `expired`, and this is how
   * a surface tells the truth in the minutes between the window closing and the sweep, without a seventh
   * status being invented.
   */
  isLapsed: z.boolean(),
  /** The negotiation window. Distinct from `paymentDueAt` in meaning and in source. */
  expiresAt: z.string(),
  respondedAt: z.string().nullable(),
  acceptedAt: z.string().nullable(),
  /** The payment deadline, set only on acceptance and derived only in the database. */
  paymentDueAt: z.string().nullable(),
  /** The offer this one replaced, when it is a counter. */
  parentOfferId: z.uuid().nullable(),
  createdAt: z.string(),
} as const;

/** One of the caller's own offers, as the buyer who made it sees it. */
export const OfferSchema = z
  .object({
    ...offerCore,
    sellerSlug: z.string().min(1),
    sellerDisplayName: z.string().min(1),
  })
  .strict()
  .openapi('Offer');

/**
 * One offer made to the caller's storefront, as the seller sees it.
 *
 * The buyer is named by display name and by nothing else: a seller deciding on an offer needs no account
 * identifier, no email address and no telephone number, and this shape has no field for one.
 */
export const SellerOfferSchema = z
  .object({
    ...offerCore,
    buyerDisplayName: z.string().nullable(),
  })
  .strict()
  .openapi('SellerOffer');

export const OffersResponseSchema = z
  .object({
    items: z.array(OfferSchema),
    nextCursor: z.string().nullable(),
  })
  .strict()
  .openapi('OffersResponse');

export const SellerOffersResponseSchema = z
  .object({
    items: z.array(SellerOfferSchema),
    nextCursor: z.string().nullable(),
  })
  .strict()
  .openapi('SellerOffersResponse');

/**
 * Opening an offer.
 *
 * Four fields, and the listing is the only thing that names anything outside the offer itself. There is
 * no seller, no currency and no expiry: the first two come out of the listing row and the third from the
 * admin-configured negotiation window, all inside the database.
 */
export const CreateOfferRequestSchema = z
  .object({
    listingId: z.uuid(),
    amountMinor: OfferAmountMinorSchema,
    quantity: OfferQuantitySchema.default(1),
    message: OfferMessageSchema.optional(),
  })
  .strict()
  .openapi('CreateOfferRequest');

/**
 * Countering.
 *
 * The offer being replaced is named in the route, not in the body, and everything the replacement
 * inherits — listing, seller, currency — is copied from it in the database. So there is deliberately no
 * `parentOfferId` field here: a client cannot point a counter at an offer other than the one it is
 * addressing.
 */
export const CounterOfferRequestSchema = z
  .object({
    amountMinor: OfferAmountMinorSchema,
    quantity: OfferQuantitySchema.default(1),
    message: OfferMessageSchema.optional(),
  })
  .strict()
  .openapi('CounterOfferRequest');

/** What opening or countering produced. */
export const OfferMutationResponseSchema = z
  .object({
    offerId: z.uuid(),
    status: OfferStatusSchema,
  })
  .strict()
  .openapi('OfferMutationResponse');

/**
 * What a decision produced.
 *
 * `acceptedAt` and `paymentDueAt` are present only on an acceptance, which is the only transition that
 * records an obligation. Neither is ever accepted from a request.
 */
export const OfferDecisionResponseSchema = z
  .object({
    status: OfferStatusSchema,
    acceptedAt: z.string().nullable(),
    paymentDueAt: z.string().nullable(),
  })
  .strict()
  .openapi('OfferDecisionResponse');

export type OfferStatus = z.infer<typeof OfferStatusSchema>;
export type Offer = z.infer<typeof OfferSchema>;
export type SellerOffer = z.infer<typeof SellerOfferSchema>;
export type OffersResponse = z.infer<typeof OffersResponseSchema>;
export type SellerOffersResponse = z.infer<typeof SellerOffersResponseSchema>;
export type CreateOfferRequest = z.infer<typeof CreateOfferRequestSchema>;
export type CounterOfferRequest = z.infer<typeof CounterOfferRequestSchema>;
export type OfferMutationResponse = z.infer<typeof OfferMutationResponseSchema>;
export type OfferDecisionResponse = z.infer<typeof OfferDecisionResponseSchema>;
