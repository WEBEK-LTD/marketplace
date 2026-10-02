import { z } from './zod.js';

/**
 * The admin seller-verification review surface (Phase 7-G).
 *
 * Three reads and one write, and the shapes below are decisions rather than conveniences.
 *
 *   * **No request names an account.** There is no seller identifier anywhere in a request schema here,
 *     and none in a response either. A reviewer addresses a *verification* and a *document*, both of
 *     which name a row rather than a person, and the reviewer themself is resolved from their own
 *     session upstream. There is no shape in which a browser could say whose application it wants, or
 *     who is asking.
 *   * **No request names a storage path.** {@link VerificationDocumentLinkResponse} is obtained by
 *     naming a document; the object path is looked up from that row in the database and never leaves it.
 *     A path is a capability inside a private bucket, and the surest way to stop one being supplied is
 *     to have no field that could carry one.
 *   * **No request names a status.** The one write takes `approved` or `rejected` — the two decisions
 *     0009's model reaches through a reviewer — and nothing else. `draft`, `submitted`, `under_review`
 *     and `expired` are unreachable from this contract, so no client can move an application into a
 *     state the seller's own flow owns or invent a transition.
 *   * **No request names a permission or an assurance level.** Both are established server-side, exactly
 *     as in 7-F, and neither appears in any schema in this module.
 *
 * {@link VerificationStatusSchema} is 0009's six-name vocabulary, verbatim. 7-G adds no status.
 */

/** 0009's status vocabulary for a verification attempt. Read-only here; nothing in 7-G adds to it. */
export const VERIFICATION_STATUSES = [
  'draft',
  'submitted',
  'under_review',
  'approved',
  'rejected',
  'expired',
] as const;
export const VerificationStatusSchema = z
  .enum(VERIFICATION_STATUSES)
  .openapi('VerificationStatus');

/** 0009's document taxonomy, verbatim. */
export const VERIFICATION_DOCUMENT_TYPES = [
  'national_id',
  'passport',
  'commercial_register',
  'tax_card',
  'bank_statement',
  'other',
] as const;
export const VerificationDocumentTypeSchema = z
  .enum(VERIFICATION_DOCUMENT_TYPES)
  .openapi('VerificationDocumentType');

/** 0009's per-document review states. 7-G renders them and writes none of them. */
export const VERIFICATION_DOCUMENT_STATUSES = ['pending', 'accepted', 'rejected'] as const;
export const VerificationDocumentStatusSchema = z
  .enum(VERIFICATION_DOCUMENT_STATUSES)
  .openapi('VerificationDocumentStatus');

/**
 * The statuses the queue may be filtered by.
 *
 * `draft` is deliberately absent: a draft is an application its owner has not submitted, and a review
 * queue is of submissions. Omitting the filter means "awaiting a decision", which is `submitted` and
 * `under_review` together.
 */
export const VERIFICATION_QUEUE_FILTERS = [
  'submitted',
  'under_review',
  'approved',
  'rejected',
  'expired',
] as const;
export const VerificationQueueFilterSchema = z
  .enum(VERIFICATION_QUEUE_FILTERS)
  .openapi('VerificationQueueFilter');

export const VERIFICATION_QUEUE_DEFAULT_LIMIT = 20;
export const VERIFICATION_QUEUE_MAX_LIMIT = 50;

/**
 * One row of the queue.
 *
 * Enough to choose what to open next and no more: no legal name, no contact details, no document
 * metadata and no account identifier. Those belong to the detail, which a reviewer opens deliberately.
 */
export const VerificationQueueItemSchema = z
  .object({
    id: z.uuid(),
    status: VerificationStatusSchema,
    /** Never null on this surface: every row the queue can return has been submitted. */
    submittedAt: z.string(),
    createdAt: z.string(),
    reviewedAt: z.string().nullable(),
    emailVerified: z.boolean(),
    phoneVerified: z.boolean(),
    documentCount: z.number().int().nonnegative(),
    sellerSlug: z.string(),
    sellerDisplayName: z.string(),
    sellerStatus: z.string(),
    sellerVerificationStatus: z.string(),
  })
  .strict()
  .openapi('VerificationQueueItem');

export const VerificationQueueResponseSchema = z
  .object({
    items: z.array(VerificationQueueItemSchema),
    nextCursor: z.string().nullable(),
  })
  .strict()
  .openapi('VerificationQueueResponse');

/**
 * One document's metadata, as a reviewer sees it.
 *
 * `byteSize` is a decimal string because the column is `bigint`: a size that crossed as a JSON number
 * would be a silent precision decision, and this project does not make those over the wire.
 *
 * **There is no `objectPath` field, and there is no reviewer or internal note.** The first is a
 * capability; the second two are not part of 7-G's approved scope.
 */
export const VerificationReviewDocumentSchema = z
  .object({
    id: z.uuid(),
    documentType: VerificationDocumentTypeSchema,
    originalFilename: z.string().nullable(),
    contentType: z.string().nullable(),
    byteSize: z.string().nullable(),
    status: VerificationDocumentStatusSchema,
    uploadedAt: z.string(),
  })
  .strict()
  .openapi('VerificationReviewDocument');

/** The storefront the evidence has to agree with. No account identifier is in it. */
export const VerificationReviewSellerSchema = z
  .object({
    slug: z.string(),
    displayName: z.string(),
    legalName: z.string().nullable(),
    countryCode: z.string().nullable(),
    governorate: z.string().nullable(),
    city: z.string().nullable(),
    contactEmail: z.string().nullable(),
    contactPhone: z.string().nullable(),
    status: z.string(),
    verificationStatus: z.string(),
    createdAt: z.string(),
  })
  .strict()
  .openapi('VerificationReviewSeller');

export const VerificationReviewSchema = z
  .object({
    id: z.uuid(),
    status: VerificationStatusSchema,
    submittedAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    /** The existing decision fields, read back. */
    reviewedAt: z.string().nullable(),
    decisionReason: z.string().nullable(),
    expiresAt: z.string().nullable(),
    emailVerified: z.boolean(),
    phoneVerified: z.boolean(),
    /** Whether this application is in a state the reviewer path can still decide from. */
    decidable: z.boolean(),
    seller: VerificationReviewSellerSchema,
    documents: z.array(VerificationReviewDocumentSchema),
  })
  .strict()
  .openapi('VerificationReview');

export const VerificationReviewResponseSchema = z
  .object({ verification: VerificationReviewSchema })
  .strict()
  .openapi('VerificationReviewResponse');

/**
 * The decision.
 *
 * Two values and one optional sentence. `reason` is required for a rejection by 0009's own
 * `seller_verifications_rejection_has_reason` CHECK, which the database answers as a refusal the form
 * can act on rather than as a failed statement; it is optional on an approval, where the same column is
 * simply a note. Nothing else is accepted: no status, no reviewer, no timestamp, no seller.
 */
export const VERIFICATION_DECISIONS = ['approved', 'rejected'] as const;
export const VerificationDecisionSchema = z
  .enum(VERIFICATION_DECISIONS)
  .openapi('VerificationDecision');

export const VERIFICATION_REASON_MAX_LENGTH = 2000;

export const VerificationDecisionRequestSchema = z
  .object({
    decision: VerificationDecisionSchema,
    reason: z.string().trim().min(1).max(VERIFICATION_REASON_MAX_LENGTH).optional(),
  })
  .strict()
  .openapi('VerificationDecisionRequest');

export const VerificationDecisionResponseSchema = z
  .object({ status: VerificationStatusSchema })
  .strict()
  .openapi('VerificationDecisionResponse');

/**
 * A short-lived, single-object authorization to read one private document.
 *
 * The URL is opaque and is not a permanent address: it expires, and it is issued for exactly the object
 * the named document row points at. No bucket name, no project key and no account identifier is in this
 * shape, and nothing in it is ever sent back to the API.
 */
export const VerificationDocumentLinkResponseSchema = z
  .object({
    documentId: z.uuid(),
    url: z.string(),
    expiresAt: z.string(),
  })
  .strict()
  .openapi('VerificationDocumentLinkResponse');

export type VerificationStatus = z.infer<typeof VerificationStatusSchema>;
export type VerificationDocumentType = z.infer<typeof VerificationDocumentTypeSchema>;
export type VerificationDocumentStatus = z.infer<typeof VerificationDocumentStatusSchema>;
export type VerificationQueueFilter = z.infer<typeof VerificationQueueFilterSchema>;
export type VerificationQueueItem = z.infer<typeof VerificationQueueItemSchema>;
export type VerificationQueueResponse = z.infer<typeof VerificationQueueResponseSchema>;
export type VerificationReviewDocument = z.infer<typeof VerificationReviewDocumentSchema>;
export type VerificationReviewSeller = z.infer<typeof VerificationReviewSellerSchema>;
export type VerificationReview = z.infer<typeof VerificationReviewSchema>;
export type VerificationReviewResponse = z.infer<typeof VerificationReviewResponseSchema>;
export type VerificationDecision = z.infer<typeof VerificationDecisionSchema>;
export type VerificationDecisionRequest = z.infer<typeof VerificationDecisionRequestSchema>;
export type VerificationDecisionResponse = z.infer<typeof VerificationDecisionResponseSchema>;
export type VerificationDocumentLinkResponse = z.infer<typeof VerificationDocumentLinkResponseSchema>;
