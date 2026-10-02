import { z } from './zod.js';

/**
 * Service requests and quotes — Option 1 (Phase 7-I).
 *
 * The approved flow is `service_request → service_quote → accepted quote → Phase 8 checkout`, from a buyer
 * to one named seller. The shapes below are decisions rather than conveniences.
 *
 *   * **No request names an account.** There is no buyer or seller field in any request schema here. A
 *     caller addresses a *service listing*, a *request* or a *quote*, all of which name a row rather than a
 *     person, and their own side is resolved from their session upstream.
 *   * **No request names a seller, a currency or a request status.** The seller and the currency come out of
 *     the listing; the quote's currency comes out of the request. The writes are named operations, not
 *     status assignments, so no client can move a row into a state the schema owns.
 *   * **No request names an acceptance time or a payment deadline.** `paymentDueAt` appears in **no** request
 *     schema in this module: it is derived in the database from the acceptance time and the admin-configured
 *     window, which is the same key and the same value offers use.
 *   * **`validForDays` is on the quote, and only on the quote.** The schema requires the seller to state how
 *     long their quote stands — `service_quotes.expires_at` has no default — and it is bounded by the same
 *     1–365 the schema bounds `delivery_days` with. It is not a payment deadline and cannot be mistaken for
 *     one: the two are separate fields with separate names and separate meanings.
 *   * **Money follows the repository's rule.** An amount is a decimal string of minor units, it travels with
 *     its `currencyCode`, and the authoritative decimal places travel beside it.
 *
 * Nothing here is Option 2: there is no routing field, no staff field and no admin field anywhere in this
 * module.
 */

/** The request vocabulary the schema defines. Read-only here; 7-I adds none. */
export const SERVICE_REQUEST_STATUSES = [
  'open',
  'quoted',
  'accepted',
  'declined',
  'cancelled',
  'expired',
] as const;
export const ServiceRequestStatusSchema = z
  .enum(SERVICE_REQUEST_STATUSES)
  .openapi('ServiceRequestStatus');

/** The quote vocabulary the schema defines. */
export const SERVICE_QUOTE_STATUSES = ['sent', 'accepted', 'rejected', 'withdrawn', 'expired'] as const;
export const ServiceQuoteStatusSchema = z
  .enum(SERVICE_QUOTE_STATUSES)
  .openapi('ServiceQuoteStatus');

/**
 * Which party answers a brief (D7-08, read-back only).
 *
 * It appears in **no request schema in this module**: the server decides which flow a brief belongs to, by
 * which writer created it, and a browser has no field for it. It is read back so that a surface can tell the
 * truth about what it is showing — "no quote yet, the seller will answer" is false for a brief no seller ever
 * sees, and a reader who cannot distinguish the two would say it anyway.
 */
export const SERVICE_REQUEST_ROUTING_MODES = ['seller', 'admin_only'] as const;
export const ServiceRequestRoutingModeSchema = z
  .enum(SERVICE_REQUEST_ROUTING_MODES)
  .openapi('ServiceRequestRoutingMode');

export const SERVICE_REQUESTS_DEFAULT_LIMIT = 20;
export const SERVICE_REQUESTS_MAX_LIMIT = 50;

/**
 * An amount in minor units, as a string.
 *
 * `bigint` columns and a JSON number is a double, so a large amount would lose precision on the way out.
 * The leading digit cannot be zero because both `service_requests_budget_positive` and
 * `service_quotes_amount_positive` require a positive amount.
 */
export const ServiceAmountMinorSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .openapi('ServiceAmountMinor');

/** 0015's `service_requests_title_length`. */
export const ServiceRequestTitleSchema = z.string().trim().min(3).max(140);
/** 0015's `service_requests_brief_length`. */
export const ServiceRequestBriefSchema = z.string().trim().min(10).max(10_000);
/** 0015's `service_quotes_scope_length`. */
export const ServiceQuoteScopeSchema = z.string().trim().min(10).max(10_000);
/** 0015's `service_quotes_delivery_days_range`, and the same bound the validity window reuses. */
export const ServiceDaysSchema = z.number().int().min(1).max(365);

/** A date the buyer states, `YYYY-MM-DD`. The column is a `date`; no time and no zone travels. */
export const ServiceNeededBySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .openapi('ServiceNeededBy');

/**
 * One row of either party's list.
 *
 * `counterpartyName` is the storefront on the buyer's list and the buyer's display name on the seller's: one
 * field, because a list shows "who is this with" and each side already knows which side it is on.
 * `acceptedPaymentDueAt` is the deadline of the request's accepted quote, if it has one — the only
 * obligation fact a list needs.
 */
export const ServiceRequestSummarySchema = z
  .object({
    id: z.uuid(),
    status: ServiceRequestStatusSchema,
    routingMode: ServiceRequestRoutingModeSchema,
    title: z.string().min(1),
    budgetMinor: ServiceAmountMinorSchema.nullable(),
    currencyCode: z.string().length(3),
    currencyMinorUnit: z.number().int().min(0).max(4),
    neededBy: z.string().nullable(),
    /** Null when the service listing has since been removed, and always on an admin-only brief. */
    listingSlug: z.string().nullable(),
    listingTitle: z.string().nullable(),
    counterpartyName: z.string().nullable(),
    quoteCount: z.number().int().nonnegative(),
    liveQuoteCount: z.number().int().nonnegative(),
    acceptedPaymentDueAt: z.string().nullable(),
    closedAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .strict()
  .openapi('ServiceRequestSummary');

export const ServiceRequestsResponseSchema = z
  .object({
    items: z.array(ServiceRequestSummarySchema),
    nextCursor: z.string().nullable(),
  })
  .strict()
  .openapi('ServiceRequestsResponse');

/**
 * One quote, as either party sees it.
 *
 * `isLapsed` is derived from the validity window and is not stored: the scheduled sweeper owns writing
 * `expired`, and this is how a surface tells the truth in the minutes before it runs, without a sixth status
 * being invented. `expiresAt` is the validity window; `paymentDueAt` is the payment deadline, set only on
 * acceptance. The two are never merged.
 */
export const ServiceQuoteSchema = z
  .object({
    id: z.uuid(),
    status: ServiceQuoteStatusSchema,
    amountMinor: ServiceAmountMinorSchema,
    deliveryDays: z.number().int().min(1).max(365),
    revisionsIncluded: z.number().int().nonnegative(),
    scope: z.string().min(1),
    isLapsed: z.boolean(),
    expiresAt: z.string(),
    respondedAt: z.string().nullable(),
    acceptedAt: z.string().nullable(),
    paymentDueAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .strict()
  .openapi('ServiceQuote');

/**
 * One request in full, with its quotes.
 *
 * `isBuyer` and `isSeller` are **derived in the database** from the account the API established, which is
 * how a surface knows which actions to offer. They travel one way: nothing in this module reads either back
 * from a request, and the two can never both be true because the schema forbids a self-request.
 */
export const ServiceRequestDetailSchema = z
  .object({
    id: z.uuid(),
    status: ServiceRequestStatusSchema,
    routingMode: ServiceRequestRoutingModeSchema,
    isBuyer: z.boolean(),
    isSeller: z.boolean(),
    title: z.string().min(1),
    brief: z.string().min(1),
    budgetMinor: ServiceAmountMinorSchema.nullable(),
    currencyCode: z.string().length(3),
    currencyMinorUnit: z.number().int().min(0).max(4),
    neededBy: z.string().nullable(),
    listingSlug: z.string().nullable(),
    listingTitle: z.string().nullable(),
    buyerName: z.string().nullable(),
    sellerSlug: z.string().nullable(),
    sellerName: z.string().nullable(),
    closedAt: z.string().nullable(),
    createdAt: z.string(),
    quotes: z.array(ServiceQuoteSchema),
  })
  .strict()
  .openapi('ServiceRequestDetail');

export const ServiceRequestDetailResponseSchema = z
  .object({ request: ServiceRequestDetailSchema })
  .strict()
  .openapi('ServiceRequestDetailResponse');

/**
 * Sending a brief.
 *
 * Five fields, and the listing is the only thing that names anything outside the request. There is no
 * seller and no currency: both come out of the listing row inside the database.
 */
export const CreateServiceRequestSchema = z
  .object({
    listingId: z.uuid(),
    title: ServiceRequestTitleSchema,
    brief: ServiceRequestBriefSchema,
    budgetMinor: ServiceAmountMinorSchema.optional(),
    neededBy: ServiceNeededBySchema.optional(),
  })
  .strict()
  .openapi('CreateServiceRequest');

/**
 * Quoting.
 *
 * The request being answered is named in the route, not in the body, and the currency is copied from it in
 * the database — so there is no `serviceRequestId` and no `currencyCode` field here.
 *
 * `validForDays` is how long the quote stands. It is required because `service_quotes.expires_at` is
 * `not null` with no default and the repository defines no quote-validity setting; its bound is the
 * schema's own.
 */
export const CreateServiceQuoteSchema = z
  .object({
    amountMinor: ServiceAmountMinorSchema,
    deliveryDays: ServiceDaysSchema,
    revisionsIncluded: z.number().int().min(0).max(32_767).default(0),
    scope: ServiceQuoteScopeSchema,
    validForDays: ServiceDaysSchema,
  })
  .strict()
  .openapi('CreateServiceQuote');

export const ServiceRequestMutationResponseSchema = z
  .object({
    requestId: z.uuid(),
    status: ServiceRequestStatusSchema,
  })
  .strict()
  .openapi('ServiceRequestMutationResponse');

export const ServiceQuoteMutationResponseSchema = z
  .object({
    quoteId: z.uuid(),
    status: ServiceQuoteStatusSchema,
  })
  .strict()
  .openapi('ServiceQuoteMutationResponse');

/** What cancelling or declining a request produced. */
export const ServiceRequestStatusResponseSchema = z
  .object({ status: ServiceRequestStatusSchema })
  .strict()
  .openapi('ServiceRequestStatusResponse');

/**
 * What a quote decision produced.
 *
 * `acceptedAt` and `paymentDueAt` are present only on an acceptance, which is the only transition that
 * records an obligation. Neither is ever accepted from a request.
 */
export const ServiceQuoteDecisionResponseSchema = z
  .object({
    status: ServiceQuoteStatusSchema,
    acceptedAt: z.string().nullable(),
    paymentDueAt: z.string().nullable(),
  })
  .strict()
  .openapi('ServiceQuoteDecisionResponse');

export type ServiceRequestStatus = z.infer<typeof ServiceRequestStatusSchema>;
export type ServiceQuoteStatus = z.infer<typeof ServiceQuoteStatusSchema>;
export type ServiceRequestSummary = z.infer<typeof ServiceRequestSummarySchema>;
export type ServiceRequestsResponse = z.infer<typeof ServiceRequestsResponseSchema>;
export type ServiceQuote = z.infer<typeof ServiceQuoteSchema>;
export type ServiceRequestDetail = z.infer<typeof ServiceRequestDetailSchema>;
export type ServiceRequestDetailResponse = z.infer<typeof ServiceRequestDetailResponseSchema>;
export type CreateServiceRequest = z.infer<typeof CreateServiceRequestSchema>;
export type CreateServiceQuote = z.infer<typeof CreateServiceQuoteSchema>;
export type ServiceRequestMutationResponse = z.infer<typeof ServiceRequestMutationResponseSchema>;
export type ServiceQuoteMutationResponse = z.infer<typeof ServiceQuoteMutationResponseSchema>;
export type ServiceRequestStatusResponse = z.infer<typeof ServiceRequestStatusResponseSchema>;
export type ServiceQuoteDecisionResponse = z.infer<typeof ServiceQuoteDecisionResponseSchema>;

/* ------------------------------------------------------------------------------------------------ */
/* Option 2 — Admin Only (Phase 7-J, D7-09)                                                          */
/* ------------------------------------------------------------------------------------------------ */

/**
 * Option 2's contracts.
 *
 * The buyer sends a brief that no seller answers; authorized staff handle it. Every rule Option 1's
 * preamble states holds here too, and two more matter especially:
 *
 *   * **Nothing in a request names the flow.** There is no `routingMode`, no `sellerUserId`, no `listingId`
 *     and no `currencyCode` in the create schema below. The server writes the mode, leaves the seller null
 *     and takes the currency from the platform's own default — so a browser cannot move a brief between the
 *     two flows or choose what it will be priced in.
 *   * **The two payment fields are descriptive and are separated by permission, not by omission.** They live
 *     in their own response shape, returned by their own operation, which requires its own permission key.
 *     A staff caller without that key receives a document in which the fields **do not exist** — the shapes
 *     below make that structural rather than a matter of nulling two values.
 *
 * Nothing here is a payment instrument. There is no card, account, credential, secret or OTP field, no
 * provider, no amount owed, no deadline and no obligation: `preferred_payment_method` is a sentence a buyer
 * types, and it is never sent anywhere.
 */

/** 0073's `service_requests_payment_method_length`. Free text, no vocabulary, no enum. */
export const PreferredPaymentMethodSchema = z.string().trim().min(1).max(120);
/** 0073's `service_requests_payment_notes_length`. */
export const PaymentNotesSchema = z.string().trim().min(1).max(2000);

/**
 * Sending an Admin Only brief.
 *
 * Five fields, and not one of them names a seller, a listing, a currency, a routing mode or a status. The
 * payment method is required here because the table cannot require it: the approved retention job clears it
 * ninety days after the brief closes, and a column constraint would make that purge fail.
 */
export const CreateAdminOnlyServiceRequestSchema = z
  .object({
    title: ServiceRequestTitleSchema,
    brief: ServiceRequestBriefSchema,
    preferredPaymentMethod: PreferredPaymentMethodSchema,
    paymentNotes: PaymentNotesSchema.optional(),
    budgetMinor: ServiceAmountMinorSchema.optional(),
    neededBy: ServiceNeededBySchema.optional(),
  })
  .strict()
  .openapi('CreateAdminOnlyServiceRequest');

/**
 * One row of the staff queue.
 *
 * `hasPaymentNotes` is a boolean and not a value: a queue needs to show that there is more to read without
 * being the place it is read. Neither payment field is in this shape, and the database function behind it
 * does not select them either.
 */
export const AdminServiceRequestSummarySchema = z
  .object({
    id: z.uuid(),
    status: ServiceRequestStatusSchema,
    title: z.string().min(1),
    budgetMinor: ServiceAmountMinorSchema.nullable(),
    currencyCode: z.string().length(3),
    currencyMinorUnit: z.number().int().min(0).max(4),
    neededBy: z.string().nullable(),
    buyerName: z.string().nullable(),
    hasPaymentNotes: z.boolean(),
    closedAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict()
  .openapi('AdminServiceRequestSummary');

export const AdminServiceRequestsResponseSchema = z
  .object({
    items: z.array(AdminServiceRequestSummarySchema),
    nextCursor: z.string().nullable(),
  })
  .strict()
  .openapi('AdminServiceRequestsResponse');

/** One Admin Only brief in full, for staff. Again neither payment field. */
export const AdminServiceRequestDetailSchema = AdminServiceRequestSummarySchema.extend({
  brief: z.string().min(1),
})
  .strict()
  .openapi('AdminServiceRequestDetail');

export const AdminServiceRequestDetailResponseSchema = z
  .object({ request: AdminServiceRequestDetailSchema })
  .strict()
  .openapi('AdminServiceRequestDetailResponse');

/**
 * The payment information, in a shape of its own.
 *
 * Its own operation, its own permission key and its own response. A staff caller holding only
 * `service_requests.request.read` never receives this document at all, which is why the separation cannot be
 * undone by a mistake in a surface: there is no field to forget to hide. Both values are null once the
 * retention job has cleared them, and the brief they belonged to is unaffected.
 */
export const ServiceRequestPaymentInformationSchema = z
  .object({
    preferredPaymentMethod: z.string().nullable(),
    paymentNotes: z.string().nullable(),
  })
  .strict()
  .openapi('ServiceRequestPaymentInformation');

export const ServiceRequestPaymentInformationResponseSchema = z
  .object({ paymentInformation: ServiceRequestPaymentInformationSchema })
  .strict()
  .openapi('ServiceRequestPaymentInformationResponse');

/**
 * What the staff closure produced.
 *
 * A status and nothing else. There is no acceptance time and no payment deadline, because closing an Admin
 * Only brief creates no obligation — that is the whole difference between this and accepting a quote.
 */
export const AdminServiceRequestDecisionResponseSchema = z
  .object({ status: ServiceRequestStatusSchema })
  .strict()
  .openapi('AdminServiceRequestDecisionResponse');

export type ServiceRequestRoutingMode = z.infer<typeof ServiceRequestRoutingModeSchema>;
export type CreateAdminOnlyServiceRequest = z.infer<typeof CreateAdminOnlyServiceRequestSchema>;
export type AdminServiceRequestSummary = z.infer<typeof AdminServiceRequestSummarySchema>;
export type AdminServiceRequestsResponse = z.infer<typeof AdminServiceRequestsResponseSchema>;
export type AdminServiceRequestDetail = z.infer<typeof AdminServiceRequestDetailSchema>;
export type AdminServiceRequestDetailResponse = z.infer<typeof AdminServiceRequestDetailResponseSchema>;
export type ServiceRequestPaymentInformation = z.infer<typeof ServiceRequestPaymentInformationSchema>;
export type ServiceRequestPaymentInformationResponse = z.infer<
  typeof ServiceRequestPaymentInformationResponseSchema
>;
export type AdminServiceRequestDecisionResponse = z.infer<
  typeof AdminServiceRequestDecisionResponseSchema
>;
