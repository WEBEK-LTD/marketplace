import { z } from './zod.js';
import { SELLER_REVIEW_STATUSES } from './sellers.js';
import { ModerationActionKindSchema } from './moderation.js';

/**
 * Review moderation — the admin side (Phase 7-P).
 *
 * 0026 owns everything substantive: the reviews, the replies, the four statuses, the rating view, the
 * automatic reassessment and `moderate_review` itself. This module invents no vocabulary — the status list is
 * the one `sellers.ts` already reads off `reviews_status_allowed` for 6-J's seller surface, and the action
 * kinds are the ones `moderation.ts` reads off 0027. A second copy of a closed list is a second list that can
 * drift from the first.
 *
 * **No request names an actor, a role, a permission or an assurance level.** The moderator is resolved from
 * their own validated session and their assurance level from that same token; every request schema below is
 * `.strict()` and has no field through which any of it could be claimed.
 *
 * **A review is addressed by its id**, which is what 0026's writer takes and what a colleague holding
 * `reviews.review.read` legitimately holds. What authorizes the read is the permission and the assurance
 * level, tested in the database before any row is reached — never the shape of the identifier.
 *
 * **No transition matrix.** 0026 accepts any of its four statuses from any of them, so this module expresses
 * none: a reduced list would refuse a legal decision and an invented one would offer an illegal one.
 * Re-recording the status a review already holds is how a decision is re-affirmed, with a fresh reason.
 *
 * **Nobody is named.** A review carries a buyer, a seller and the colleague who last ruled, and not one of
 * them has a place in any schema here. The storefront is named by the slug its own public projection
 * publishes; the buyer is not named at all, because a moderation screen judges what was written; and a
 * colleague who already ruled is reported as `moderatedByMe`. The order behind the review is absent too —
 * only the publication block it produces crosses.
 *
 * ---------------------------------------------------------------------------------------------------
 * **MODERATING A REVIEW *REPLY* IS MISSING FROM THIS FILE ON PURPOSE.**
 *
 * A review's reply is returned so a moderator can read the whole exchange, and there is **no request schema
 * that changes it**. `public.review_replies` carries the same four statuses together with a moderation reason,
 * time and moderator, and `review_replies_staff_moderate` authorizes setting them — but nothing in this
 * repository writes them: the only write to that table anywhere is the seller's own insert inside
 * `reply_to_review`, and `moderate_review` updates `public.reviews` alone.
 *
 * The gap is narrower than it looks. A reply is publicly readable only while its **parent review** is
 * published, so hiding or removing a review already hides its reply with no reply row written. What the
 * missing writer would add is the ability to act on an abusive reply while leaving a fair review published.
 * Reported as a capability gap for an owner decision rather than invented here.
 * ---------------------------------------------------------------------------------------------------
 */

/* ------------------------------------------------------------------------------------------------ */
/* Paging                                                                                            */
/* ------------------------------------------------------------------------------------------------ */

export const REVIEW_MODERATION_DEFAULT_LIMIT = 20;
export const REVIEW_MODERATION_MAX_LIMIT = 50;
/** How many trail entries one review returns. A fixed page: the trail is not paged. */
export const REVIEW_MODERATION_HISTORY_LIMIT = 50;

export const ReviewModerationLimitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(REVIEW_MODERATION_MAX_LIMIT)
  .default(REVIEW_MODERATION_DEFAULT_LIMIT);

/** Opaque and versioned per kind, as everywhere else. Never parsed or constructed by a browser. */
export const ReviewModerationCursorSchema = z.string().min(1).max(512);

/* ------------------------------------------------------------------------------------------------ */
/* Vocabulary                                                                                        */
/* ------------------------------------------------------------------------------------------------ */

/**
 * 0026's `reviews_status_allowed`, reused from the sellers module rather than restated.
 *
 * All four are both a state a review can be in and a decision a moderator can record, because
 * `moderate_review` accepts any of them from any of them.
 */
export { SELLER_REVIEW_STATUSES as REVIEW_STATUSES } from './sellers.js';
export type { SellerReviewStatus as ReviewStatus } from './sellers.js';

export const ReviewStatusSchema = z.enum(SELLER_REVIEW_STATUSES).openapi('ReviewStatus', {
  description:
    'A review’s state, in the four values 0026 allows. All four are also decisions a moderator can record: the writer imposes no transition matrix, so any of them may follow any other, and re-recording the current one re-affirms it with a fresh reason.',
});

/** `review_publication_block`'s two answers. Read back as a fact; never sent. */
export const REVIEW_PUBLICATION_BLOCKS = ['order_refunded', 'payment_disputed'] as const;
export type ReviewPublicationBlock = (typeof REVIEW_PUBLICATION_BLOCKS)[number];
export const ReviewPublicationBlockSchema = z
  .enum(REVIEW_PUBLICATION_BLOCKS)
  .openapi('ReviewPublicationBlock', {
    description:
      'Why the automatic reassessment would hide this review — its order was refunded, or its payment is disputed. Reported so a moderator publishing one can see what they are overriding. A moderator’s decision is final: once recorded, the reassessment leaves that review alone.',
  });

/**
 * `reviews.auto_hidden_reason` carries the same two values the publication block does, and it is a free text
 * column rather than a constrained one — so it is typed as text here and not as the enum. A column the
 * schema does not constrain is not a vocabulary to promise.
 */
export const ReviewAutoHiddenReasonSchema = z.string();

/* ------------------------------------------------------------------------------------------------ */
/* The queue                                                                                         */
/* ------------------------------------------------------------------------------------------------ */

export const ReviewQueueQuerySchema = z
  .object({
    status: ReviewStatusSchema.optional(),
    limit: ReviewModerationLimitSchema.optional(),
    cursor: ReviewModerationCursorSchema.optional(),
  })
  .strict()
  .openapi('ReviewQueueQuery');

/**
 * One review in the queue.
 *
 * `hasBody` rather than the body: a queue row says there is prose to read without carrying four thousand
 * characters of it, and the body is on the detail. `isParty` is returned because 0026 refuses a moderator who
 * is the buyer or the seller, so a console that could not see it would offer a control the database rejects.
 */
export const ReviewQueueRowSchema = z
  .object({
    id: z.string().uuid(),
    rating: z.number().int().min(1).max(5),
    title: z.string().nullable(),
    status: ReviewStatusSchema,
    hasBody: z.boolean(),
    autoHiddenReason: ReviewAutoHiddenReasonSchema.nullable(),
    isModerated: z.boolean(),
    moderatedByMe: z.boolean(),
    isParty: z.boolean(),
    sellerSlug: z.string(),
    sellerDisplayName: z.string(),
    hasReply: z.boolean(),
    replyStatus: ReviewStatusSchema.nullable(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .openapi('ReviewQueueRow');

export const ReviewQueueResponseSchema = z
  .object({
    items: z.array(ReviewQueueRowSchema),
    nextCursor: z.string().nullable(),
  })
  .strict()
  .openapi('ReviewQueueResponse');

/* ------------------------------------------------------------------------------------------------ */
/* One review                                                                                        */
/* ------------------------------------------------------------------------------------------------ */

/**
 * One review, with the seller's reply beside it.
 *
 * `canModerate` is a capability, not a permission: whether this same validated session may record a decision.
 * It is here because the read is gated on `reviews.review.read` and the write on `reviews.review.moderate`,
 * so a screen would otherwise have to guess.
 *
 * The reply fields are **read-only**. There is no request schema in this file that changes a reply's status,
 * because no writer for one exists — see the module note.
 */
export const ReviewDetailSchema = z
  .object({
    id: z.string().uuid(),
    rating: z.number().int().min(1).max(5),
    title: z.string().nullable(),
    body: z.string().nullable(),
    status: ReviewStatusSchema,
    autoHiddenReason: ReviewAutoHiddenReasonSchema.nullable(),
    moderationReason: z.string().nullable(),
    moderatedAt: z.string().datetime({ offset: true }).nullable(),
    moderatedByMe: z.boolean(),
    isParty: z.boolean(),
    canModerate: z.boolean(),
    publicationBlock: ReviewPublicationBlockSchema.nullable(),
    sellerSlug: z.string(),
    sellerDisplayName: z.string(),
    sellerStatus: z.string(),
    replyBody: z.string().nullable(),
    replyStatus: ReviewStatusSchema.nullable(),
    replyModerationReason: z.string().nullable(),
    replyCreatedAt: z.string().datetime({ offset: true }).nullable(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .openapi('ReviewDetail');

export const ReviewDetailResponseSchema = z
  .object({ review: ReviewDetailSchema })
  .strict()
  .openapi('ReviewDetailResponse');

/* ------------------------------------------------------------------------------------------------ */
/* The trail                                                                                         */
/* ------------------------------------------------------------------------------------------------ */

/**
 * One moderation action recorded against this review.
 *
 * 0027's generic trail, reused rather than duplicated, and gated on `moderation.action.read` — which is what
 * 0027's own policy requires and is **not** the review read key. It names no moderator: the reader learns
 * only whether an action was their own.
 */
export const ReviewModerationActionSchema = z
  .object({
    id: z.string().uuid(),
    action: ModerationActionKindSchema,
    reason: z.string(),
    notes: z.string().nullable(),
    reportId: z.string().uuid().nullable(),
    isOwnAction: z.boolean(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .openapi('ReviewModerationAction');

export const ReviewModerationActionsResponseSchema = z
  .object({ items: z.array(ReviewModerationActionSchema) })
  .strict()
  .openapi('ReviewModerationActionsResponse');

/* ------------------------------------------------------------------------------------------------ */
/* The decision                                                                                      */
/* ------------------------------------------------------------------------------------------------ */

/** `reviews_moderated_has_reason` requires one; this is the bound the contract sets on the way in. */
export const ReviewModerationReasonSchema = z.string().trim().min(1).max(4000);

/**
 * Recording a decision on one review.
 *
 * Two fields, and a reason is required for **every** decision — not only for the three that hide something —
 * because that is `moderate_review`'s own rule and `reviews_moderated_has_reason` enforces it in the schema.
 *
 * There is no moderator field, no timestamp, no `autoHiddenReason` and no `publishedAt`: the writer records
 * who ruled and when, clears the automatic reason and moves the publication time only when publishing. There
 * is nothing here that reaches the reply, the order or the rating either.
 */
export const ModerateReviewRequestSchema = z
  .object({
    status: ReviewStatusSchema,
    reason: ReviewModerationReasonSchema,
  })
  .strict()
  .openapi('ModerateReviewRequest');

export const ModerateReviewResponseSchema = z
  .object({
    outcome: z.literal('moderated'),
    status: ReviewStatusSchema,
  })
  .strict()
  .openapi('ModerateReviewResponse');

/* ------------------------------------------------------------------------------------------------ */
/* Types                                                                                             */
/* ------------------------------------------------------------------------------------------------ */

export type ReviewQueueQuery = z.infer<typeof ReviewQueueQuerySchema>;
export type ReviewQueueRow = z.infer<typeof ReviewQueueRowSchema>;
export type ReviewQueueResponse = z.infer<typeof ReviewQueueResponseSchema>;
export type ReviewDetail = z.infer<typeof ReviewDetailSchema>;
export type ReviewDetailResponse = z.infer<typeof ReviewDetailResponseSchema>;
export type ReviewModerationAction = z.infer<typeof ReviewModerationActionSchema>;
export type ReviewModerationActionsResponse = z.infer<typeof ReviewModerationActionsResponseSchema>;
export type ModerateReviewRequest = z.infer<typeof ModerateReviewRequestSchema>;
export type ModerateReviewResponse = z.infer<typeof ModerateReviewResponseSchema>;
