import { z } from './zod.js';

/**
 * Dispute management — the admin side (Phase 7-R).
 *
 * 0027 owns everything substantive: the disputes, the thread, the six statuses, the eight reason codes, the
 * four resolutions, and the three writers `open_dispute`, `post_dispute_message` and `resolve_dispute`. This
 * module invents no vocabulary.
 *
 * ---------------------------------------------------------------------------------------------------
 * **A RESOLUTION RECORDS A DECISION. IT DOES NOT MOVE MONEY.**
 *
 * That is 0027's own sentence about its own writer, and it is the reason dispute management belongs to
 * Phase 7 at all: *"A resolution decides; any money it implies moves through the Refunds module, with its own
 * record and its own capability checks."*
 *
 * So `refund_buyer` and `partial_refund` are offered here in full, and choosing one creates **no refund row,
 * no payment reversal, no ledger entry, no balance change, no payout, no withdrawal and no provider call**.
 * Executing a refund is Phase 8's; `public.refunds` has no writer anywhere in this repository; and the keys
 * for it are `payments.refund.*`, which this surface never consumes. The console says so in words next to the
 * control, and {@link ResolveDisputeResponseSchema} says so in its own description.
 * ---------------------------------------------------------------------------------------------------
 *
 * **No request names an actor, a role, a permission or an assurance level.** The colleague is resolved from
 * their own validated session and their assurance level from that same token; every request schema below is
 * `.strict()` and has no field through which any of it could be claimed.
 *
 * **Nobody is named.** A dispute has a buyer, a seller, an opener and possibly a colleague who resolved it,
 * and not one of them has a place in any schema here. Which side opened it crosses as a **side**; the
 * storefront is named by the slug its own public projection publishes; a message names its author's **role**
 * and never the author; and the reader learns only whether they are a party and whether a decision was
 * their own. The order is named by its own reference, never by its id.
 *
 * **Money is a decimal string beside an explicit currency.** `claim_amount_minor`, `resolution_amount_minor`
 * and the order total are 64-bit integers, and a JSON number is an IEEE double: a large minor amount would
 * lose precision on the way out. Every amount below is therefore a digit string and never a `number`, and
 * never appears without `currencyCode` — the convention 0015's offers and 0016's listing prices already use.
 *
 * **Only the reachable statuses are selectable.** `awaiting_seller`, `awaiting_buyer`, `under_review` and
 * `cancelled` are in 0027's CHECK constraint and **nothing sets any of them** — `open_dispute` takes the
 * column default `open` and `resolve_dispute` sets `resolved`. Offering them as filters would offer four
 * values no dispute can hold. They remain in {@link DISPUTE_STATUSES} because a dispute could hold one if a
 * writer for it ever existed, and a response must still be able to describe it; they are absent only from
 * {@link SELECTABLE_DISPUTE_STATUSES}, which is what a query may name.
 *
 * **There is no evidence schema in this file.** `public.dispute_evidence` has read policies, a private bucket
 * and four constraints — and nothing inserts a row. By owner decision the whole evidence surface is deferred
 * until an increment defines the upload workflow, so there is no row schema, no signed-URL response and no
 * count.
 *
 * **There is nothing here for `assigned_to` or `due_at` either**, beyond reading the due date a dispute was
 * opened with: nothing assigns a dispute and nothing changes a due date afterwards.
 */

/* ------------------------------------------------------------------------------------------------ */
/* Paging                                                                                            */
/* ------------------------------------------------------------------------------------------------ */

export const DISPUTES_DEFAULT_LIMIT = 20;
export const DISPUTES_MAX_LIMIT = 50;
/** How many messages one thread returns. A fixed page: a dispute thread is short by construction. */
export const DISPUTE_THREAD_LIMIT = 200;

export const DisputeLimitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(DISPUTES_MAX_LIMIT)
  .default(DISPUTES_DEFAULT_LIMIT);

/** Opaque and versioned per kind, as everywhere else. Never parsed or constructed by a browser. */
export const DisputeCursorSchema = z.string().min(1).max(512);

/* ------------------------------------------------------------------------------------------------ */
/* Money                                                                                             */
/* ------------------------------------------------------------------------------------------------ */

/**
 * An amount in minor units, as a string.
 *
 * `disputes.claim_amount_minor` and `disputes.resolution_amount_minor` are `bigint` and a JSON number is a
 * double, so a large amount would lose precision on the way out. The leading digit cannot be zero because
 * `disputes_claim_positive` and `disputes_resolution_amount_positive` both require a positive amount, so "0"
 * is not a representable claim or decision.
 */
export const DisputeAmountMinorSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .openapi('DisputeAmountMinor');

/**
 * An order total in minor units, as a string.
 *
 * Separate from the two above because an order total may legitimately be zero, so it takes the wider shape
 * `MinorAmountSchema` uses for listing prices.
 */
export const DisputeOrderTotalMinorSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .openapi('DisputeOrderTotalMinor');

/** ISO-4217, as `disputes.currency_code` and `orders.currency_code` hold it. Never omitted beside an amount. */
export const DisputeCurrencyCodeSchema = z.string().length(3).openapi('DisputeCurrencyCode');

/* ------------------------------------------------------------------------------------------------ */
/* Vocabulary                                                                                        */
/* ------------------------------------------------------------------------------------------------ */

/** 0027's `disputes_status_allowed`, in full, because a response must be able to describe any of them. */
export const DISPUTE_STATUSES = [
  'open',
  'awaiting_seller',
  'awaiting_buyer',
  'under_review',
  'resolved',
  'cancelled',
] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];
export const DisputeStatusSchema = z.enum(DISPUTE_STATUSES).openapi('DisputeStatus', {
  description:
    'A dispute’s state, in the six values the schema allows. Only `open` and `resolved` are currently reachable: the writers that exist set those two, and no writer sets the other four. The remaining states are described here because a dispute could hold one if such a writer were added, and are deliberately not offered as filters.',
});

/**
 * The statuses a query may name.
 *
 * The two a writer can actually produce. This is a deliberate subset of {@link DISPUTE_STATUSES} rather than a
 * second vocabulary: a filter naming one of the other four would match nothing, for ever, and a console that
 * offered it would be promising a workflow that does not exist.
 */
export const SELECTABLE_DISPUTE_STATUSES = ['open', 'resolved'] as const;
export type SelectableDisputeStatus = (typeof SELECTABLE_DISPUTE_STATUSES)[number];
export const SelectableDisputeStatusSchema = z
  .enum(SELECTABLE_DISPUTE_STATUSES)
  .openapi('SelectableDisputeStatus', {
    description:
      'The dispute states a query may narrow to. Only these two are reachable by any writer in this platform, so the other four are not offered.',
  });

/** 0027's `disputes_reason_code_allowed`. Why the dispute was opened, as the opener chose it. */
export const DISPUTE_REASON_CODES = [
  'not_received',
  'not_as_described',
  'damaged',
  'incomplete',
  'late_delivery',
  'service_not_delivered',
  'unauthorised',
  'other',
] as const;
export type DisputeReasonCode = (typeof DISPUTE_REASON_CODES)[number];
export const DisputeReasonCodeSchema = z.enum(DISPUTE_REASON_CODES).openapi('DisputeReasonCode');

/**
 * 0027's `disputes_resolution_allowed`, all four.
 *
 * **Every one of them records a decision and moves no money.** The two refund values carry an amount because
 * `disputes.resolution_amount_minor` exists and 0027 permits one for exactly those two; it is the decided
 * amount, and paying it is Phase 8's.
 */
export const DISPUTE_RESOLUTIONS = [
  'refund_buyer',
  'partial_refund',
  'release_seller',
  'no_action',
] as const;
export type DisputeResolution = (typeof DISPUTE_RESOLUTIONS)[number];
export const DisputeResolutionSchema = z.enum(DISPUTE_RESOLUTIONS).openapi('DisputeResolution', {
  description:
    'What a colleague decided. All four record a decision and none moves money: `refund_buyer` and `partial_refund` record that a refund is owed, and issuing it is a separate, later, financial operation with its own record and its own permission.',
});

/** Which side opened the dispute. A side, never an account. */
export const DISPUTE_PARTY_ROLES = ['buyer', 'seller'] as const;
export type DisputePartyRole = (typeof DISPUTE_PARTY_ROLES)[number];
export const DisputePartyRoleSchema = z.enum(DISPUTE_PARTY_ROLES).openapi('DisputePartyRole');

/** 0027's `dispute_messages_author_role_allowed`. A role, never an account. */
export const DISPUTE_AUTHOR_ROLES = ['buyer', 'seller', 'staff'] as const;
export type DisputeAuthorRole = (typeof DISPUTE_AUTHOR_ROLES)[number];
export const DisputeAuthorRoleSchema = z.enum(DISPUTE_AUTHOR_ROLES).openapi('DisputeAuthorRole');

/**
 * The order statuses a dispute can be seen beside.
 *
 * Read back as text rather than as an enum: 0018 constrains `orders.status` per order type, and this surface
 * reports whatever the order holds without restating a two-branch CHECK it does not own.
 */
export const DisputeOrderStatusSchema = z.string().min(1).max(50);

/** 0018's `orders_type_allowed`. */
export const DISPUTE_ORDER_TYPES = ['product', 'service'] as const;
export const DisputeOrderTypeSchema = z.enum(DISPUTE_ORDER_TYPES).openapi('DisputeOrderType');

/* ------------------------------------------------------------------------------------------------ */
/* The queue                                                                                         */
/* ------------------------------------------------------------------------------------------------ */

export const DisputeQueueQuerySchema = z
  .object({
    status: SelectableDisputeStatusSchema.optional(),
    limit: DisputeLimitSchema.optional(),
    cursor: DisputeCursorSchema.optional(),
  })
  .strict()
  .openapi('DisputeQueueQuery');

/**
 * One dispute in the queue.
 *
 * `hasDetails` rather than the details: a queue row says there is prose to read without carrying four thousand
 * characters of it, and the prose is on the detail. `isParty` is returned because 0027 refuses a resolver who
 * is the buyer or the seller, so a console that could not see it would offer a control the writer rejects.
 */
export const DisputeQueueRowSchema = z
  .object({
    id: z.string().uuid(),
    status: DisputeStatusSchema,
    reasonCode: DisputeReasonCodeSchema,
    currencyCode: DisputeCurrencyCodeSchema,
    claimAmountMinor: DisputeAmountMinorSchema.nullable(),
    orderNumber: z.string().min(1),
    orderStatus: DisputeOrderStatusSchema,
    orderType: DisputeOrderTypeSchema,
    sellerSlug: z.string().nullable(),
    sellerDisplayName: z.string().nullable(),
    isParty: z.boolean(),
    resolvedByMe: z.boolean(),
    resolution: DisputeResolutionSchema.nullable(),
    messageCount: z.number().int().nonnegative(),
    hasDetails: z.boolean(),
    dueAt: z.string().datetime({ offset: true }).nullable(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .openapi('DisputeQueueRow');

export const DisputeQueueResponseSchema = z
  .object({
    items: z.array(DisputeQueueRowSchema),
    nextCursor: z.string().nullable(),
  })
  .strict()
  .openapi('DisputeQueueResponse');

/* ------------------------------------------------------------------------------------------------ */
/* One dispute                                                                                       */
/* ------------------------------------------------------------------------------------------------ */

/**
 * One dispute, with the order it is about.
 *
 * The order's total crosses so the claim can be judged against it, as a string beside the one `currencyCode`
 * the dispute and the order share by composite foreign key. `orderStatusBefore` is the snapshot the dispute
 * took when it opened and which a resolution restores.
 *
 * `canManage` is a capability, not a permission: whether this same validated session may post a message or
 * record a decision. It is here because the read is gated on one key and both writes on another.
 *
 * **No evidence count.** Nothing inserts evidence, so a permanent zero would imply a feature.
 */
export const DisputeDetailSchema = z
  .object({
    id: z.string().uuid(),
    status: DisputeStatusSchema,
    reasonCode: DisputeReasonCodeSchema,
    details: z.string().nullable(),
    currencyCode: DisputeCurrencyCodeSchema,
    claimAmountMinor: DisputeAmountMinorSchema.nullable(),
    orderNumber: z.string().min(1),
    orderStatus: DisputeOrderStatusSchema,
    orderType: DisputeOrderTypeSchema,
    orderGrandTotalMinor: DisputeOrderTotalMinorSchema,
    orderStatusBefore: DisputeOrderStatusSchema,
    orderPlacedAt: z.string().datetime({ offset: true }).nullable(),
    sellerSlug: z.string().nullable(),
    sellerDisplayName: z.string().nullable(),
    openedByRole: DisputePartyRoleSchema,
    resolution: DisputeResolutionSchema.nullable(),
    resolutionAmountMinor: DisputeAmountMinorSchema.nullable(),
    resolutionNote: z.string().nullable(),
    resolvedAt: z.string().datetime({ offset: true }).nullable(),
    resolvedByMe: z.boolean(),
    isParty: z.boolean(),
    canManage: z.boolean(),
    dueAt: z.string().datetime({ offset: true }).nullable(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .openapi('DisputeDetail');

export const DisputeDetailResponseSchema = z
  .object({ dispute: DisputeDetailSchema })
  .strict()
  .openapi('DisputeDetailResponse');

/* ------------------------------------------------------------------------------------------------ */
/* The thread                                                                                        */
/* ------------------------------------------------------------------------------------------------ */

/**
 * One message on a dispute.
 *
 * `isInternal` marks a staff note that a party cannot see — 0027's own column, gated for staff by the read
 * key. `isOwnMessage` is the only thing said about the reader, and no author is named: a screen that named the
 * staff author would be naming a colleague on a record the other side may later request.
 */
export const DisputeMessageSchema = z
  .object({
    id: z.string().uuid(),
    authorRole: DisputeAuthorRoleSchema,
    body: z.string(),
    isInternal: z.boolean(),
    isOwnMessage: z.boolean(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .openapi('DisputeMessage');

export const DisputeMessagesResponseSchema = z
  .object({ items: z.array(DisputeMessageSchema) })
  .strict()
  .openapi('DisputeMessagesResponse');

/** 0027's `dispute_messages_body_length`. Trimmed, and absent rather than blank. */
export const DisputeMessageBodySchema = z.string().trim().min(1).max(4000);

/**
 * Posting a staff message or an internal note.
 *
 * Two fields. There is no author, no role and no time: 0027's writer works the role out of the dispute itself
 * and records when. `isInternal` defaults to false, because the safe default for a note on a record two other
 * people can read is that they can read it too.
 */
export const PostDisputeMessageRequestSchema = z
  .object({
    body: DisputeMessageBodySchema,
    isInternal: z.boolean().default(false),
  })
  .strict()
  .openapi('PostDisputeMessageRequest');

export const PostDisputeMessageResponseSchema = z
  .object({
    outcome: z.literal('posted'),
    messageId: z.string().uuid(),
  })
  .strict()
  .openapi('PostDisputeMessageResponse');

/* ------------------------------------------------------------------------------------------------ */
/* The resolution                                                                                    */
/* ------------------------------------------------------------------------------------------------ */

/** `disputes_resolved_has_note` requires one; this is the bound the contract sets on the way in. */
export const DisputeResolutionNoteSchema = z.string().trim().min(1).max(4000);

/**
 * Recording a decision on one dispute.
 *
 * Three fields, one of them optional. A reason is required for **every** decision, which is 0027's own rule
 * and what `disputes_resolved_has_note` enforces.
 *
 * `resolutionAmountMinor` is permitted only for `refund_buyer` and `partial_refund` — `refined` below rather
 * than left to the database, so a console sending one against `no_action` is told rather than quietly ignored.
 * It carries no upper bound, because 0027 imposes none at resolution time; a claim is checked against the
 * order when a dispute is **opened**, and a decision is not.
 *
 * There is no resolver field, no timestamp, no order status and nothing naming a refund, a payment or a
 * ledger: the writer records who ruled and when, restores the order's snapshot status, and moves no money.
 */
export const ResolveDisputeRequestSchema = z
  .object({
    resolution: DisputeResolutionSchema,
    resolutionNote: DisputeResolutionNoteSchema,
    resolutionAmountMinor: DisputeAmountMinorSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.resolutionAmountMinor === undefined ||
      value.resolution === 'refund_buyer' ||
      value.resolution === 'partial_refund',
    {
      message: 'An amount belongs only to a refund resolution.',
      path: ['resolutionAmountMinor'],
    },
  )
  .openapi('ResolveDisputeRequest');

/**
 * What was recorded.
 *
 * **The decision, and nothing financial.** No refund identifier, no payment reference, no ledger journal and
 * no balance is returned, because none was created: recording `refund_buyer` here means a colleague decided a
 * refund is owed, and issuing it is a separate operation that does not exist yet.
 */
export const ResolveDisputeResponseSchema = z
  .object({
    outcome: z.literal('resolved'),
    status: z.literal('resolved'),
    resolution: DisputeResolutionSchema,
  })
  .strict()
  .openapi('ResolveDisputeResponse');

/* ------------------------------------------------------------------------------------------------ */
/* Types                                                                                             */
/* ------------------------------------------------------------------------------------------------ */

export type DisputeQueueQuery = z.infer<typeof DisputeQueueQuerySchema>;
export type DisputeQueueRow = z.infer<typeof DisputeQueueRowSchema>;
export type DisputeQueueResponse = z.infer<typeof DisputeQueueResponseSchema>;
export type DisputeDetail = z.infer<typeof DisputeDetailSchema>;
export type DisputeDetailResponse = z.infer<typeof DisputeDetailResponseSchema>;
export type DisputeMessage = z.infer<typeof DisputeMessageSchema>;
export type DisputeMessagesResponse = z.infer<typeof DisputeMessagesResponseSchema>;
export type PostDisputeMessageRequest = z.infer<typeof PostDisputeMessageRequestSchema>;
export type PostDisputeMessageResponse = z.infer<typeof PostDisputeMessageResponseSchema>;
export type ResolveDisputeRequest = z.infer<typeof ResolveDisputeRequestSchema>;
export type ResolveDisputeResponse = z.infer<typeof ResolveDisputeResponseSchema>;
