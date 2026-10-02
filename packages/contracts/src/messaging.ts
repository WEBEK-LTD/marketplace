import { z } from './zod.js';

/**
 * The messaging read contracts (Phase 5-C).
 *
 * Every schema here mirrors a projection migration 0053 already returns — field for field, name for
 * name, nullability for nullability. Nothing is added, nothing is renamed and nothing is reshaped: if a
 * value is not in the reader, it is not in the contract, and the API has no field of its own to fill.
 * That is what makes a drifting response a clean failure rather than a half-rendered page.
 *
 * Three things are worth stating about the shapes below.
 *
 * **Sequences are digit strings, not numbers.** `messages.seq` is a PostgreSQL `bigint`, and the
 * repository already represents bigint money the same way (`MinorAmountSchema`). Carrying it as a JSON
 * number would be a quiet promise that it fits in a double, which for an identity column is a promise
 * nobody should make. Counts are different: an unread count is bounded by how many messages a person
 * can plausibly have, so it is a number, and the API refuses a value that is not a safe integer rather
 * than truncating one.
 *
 * **There is no attachment field.** 0014 has a `message_attachments` table and 0053 deliberately does
 * not read it; these contracts deliberately cannot describe it. Attachments are a later increment and
 * adding the shape now would be the first half of building them.
 *
 * **A listing reference is two shapes, not one optional shape.** N8 says an unavailable listing keeps
 * its identity and loses everything else, and a discriminated union is how that becomes impossible to
 * get wrong: the `no_longer_available` member has no slug, no price and no currency to populate, so no
 * caller can leak them by forgetting a conditional.
 */

/** Page sizes, as migration 0053 clamps them. Restated here so the API refuses before the database does. */
export const MESSAGING_INBOX_DEFAULT_LIMIT = 20;
export const MESSAGING_INBOX_MAX_LIMIT = 50;
export const MESSAGING_MESSAGES_DEFAULT_LIMIT = 50;
export const MESSAGING_MESSAGES_MAX_LIMIT = 100;

/**
 * A PostgreSQL `bigint` as it crosses JSON: the digits, with no leading zero.
 *
 * `seq` is `generated always as identity`, so it starts at 1 and never takes a zero or a negative
 * value; the pattern says so rather than leaving a wider shape for a future reader to fill wrongly.
 */
export const MessageSequenceSchema = z.string().regex(/^[1-9][0-9]*$/);

/** What a conversation is about. Exactly the `conversations_subject_type_allowed` vocabulary of 0014. */
export const CONVERSATION_SUBJECT_TYPES = ['direct', 'listing', 'service_request', 'order'] as const;
export const ConversationSubjectTypeSchema = z
  .enum(CONVERSATION_SUBJECT_TYPES)
  .openapi('ConversationSubjectType');

/**
 * Whether the caller is still in the conversation.
 *
 * Both values exist in the contract although the inbox only ever returns `active`, because the reader
 * computes it from `left_at` rather than asserting it — and a contract that could only say `active`
 * would have to change before the truth could.
 */
export const CONVERSATION_MEMBERSHIP_STATES = ['active', 'left'] as const;
export const ConversationMembershipStateSchema = z
  .enum(CONVERSATION_MEMBERSHIP_STATES)
  .openapi('ConversationMembershipState');

/** Exactly the `messages_type_allowed` vocabulary of 0014. */
export const MESSAGE_TYPES = ['text', 'system', 'reference'] as const;
export const MessageTypeSchema = z.enum(MESSAGE_TYPES).openapi('MessageType');

/** Exactly the `messages_reference_type_allowed` vocabulary of 0014. */
export const MESSAGE_REFERENCE_TYPES = ['listing', 'offer', 'service_request', 'service_quote', 'order'] as const;
export const MessageReferenceTypeSchema = z
  .enum(MESSAGE_REFERENCE_TYPES)
  .openapi('MessageReferenceType');

/**
 * One row of the caller's inbox.
 *
 * The last-message summary is carried as flat `lastMessage…` fields rather than a nested object,
 * because that is exactly how 0053 returns it; grouping them would be a shape this layer invented. All
 * seven are null together for a conversation that has no messages yet.
 *
 * Nothing here describes another participant beyond the sender id of the newest message, which the
 * caller can already see by reading that message.
 */
export const InboxItemSchema = z
  .object({
    conversationId: z.string().uuid(),
    subjectType: ConversationSubjectTypeSchema,
    listingId: z.string().uuid().nullable(),
    listingTitleSnapshot: z.string().nullable(),
    membershipState: ConversationMembershipStateSchema,
    isMuted: z.boolean(),
    isClosed: z.boolean(),
    closedAt: z.string().datetime().nullable(),
    unreadCount: z.number().int().min(0),
    lastMessageId: z.string().uuid().nullable(),
    lastMessageSeq: MessageSequenceSchema.nullable(),
    lastMessageAt: z.string().datetime().nullable(),
    lastMessageType: MessageTypeSchema.nullable(),
    lastMessageBody: z.string().nullable(),
    lastMessageSenderUserId: z.string().uuid().nullable(),
    lastMessageDeletedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict()
  .openapi('InboxItem');

export const MessagingInboxResponseSchema = z
  .object({
    items: z.array(InboxItemSchema),
    nextCursor: z.string().nullable(),
  })
  .strict()
  .openapi('MessagingInboxResponse');

/**
 * One message.
 *
 * `isOwnMessage` comes from the reader rather than being derived here, so "whose message is this" has
 * one answer computed in one place. A system message belongs to nobody: its sender is null and it is
 * nobody's own.
 *
 * `deletedAt` is reported exactly as the schema holds it. 0014 records that a message was deleted and
 * 0053 does not mask anything on that basis; what a surface does with it is a decision neither this
 * contract nor that reader pre-empts.
 */
export const MessageItemSchema = z
  .object({
    id: z.string().uuid(),
    seq: MessageSequenceSchema,
    conversationId: z.string().uuid(),
    senderUserId: z.string().uuid().nullable(),
    isOwnMessage: z.boolean(),
    messageType: MessageTypeSchema,
    body: z.string().nullable(),
    referenceType: MessageReferenceTypeSchema.nullable(),
    referenceId: z.string().uuid().nullable(),
    createdAt: z.string().datetime(),
    editedAt: z.string().datetime().nullable(),
    deletedAt: z.string().datetime().nullable(),
  })
  .strict()
  .openapi('MessageItem');

/**
 * One page of a conversation.
 *
 * `items` is oldest-first, ready to render in reading order. `nextCursor` continues the traversal, which
 * for a chat means *older* messages: the surface opens at the end of the conversation and pages
 * backwards, so "next page" and "further back" are the same direction.
 */
export const ConversationMessagesResponseSchema = z
  .object({
    items: z.array(MessageItemSchema),
    nextCursor: z.string().nullable(),
  })
  .strict()
  .openapi('ConversationMessagesResponse');

export const UnreadCountResponseSchema = z
  .object({
    unreadCount: z.number().int().min(0),
  })
  .strict()
  .openapi('UnreadCountResponse');

/**
 * A listing referenced inside a conversation, in its available form.
 *
 * `canonicalType` names the public surface the listing's URL belongs to — a product lives at one path
 * and a service at another — and the address itself is assembled by the application's single URL
 * builder from that plus the slug. Deliberately no URL string: one place decides public addresses.
 */
export const AvailableListingReferenceSchema = z
  .object({
    status: z.literal('available'),
    id: z.string().uuid(),
    slug: z.string(),
    canonicalType: z.enum(['product', 'service']),
    title: z.string(),
    priceMinor: z.string().regex(/^(0|[1-9][0-9]*)$/).nullable(),
    currencyCode: z.string().length(3),
    currencyMinorUnit: z.number().int().min(0).max(4),
  })
  .strict()
  .openapi('AvailableListingReference');

/**
 * The same listing once it is no longer available — sold, expired, archived, withdrawn, or belonging to
 * a seller who is not active.
 *
 * It carries an id and, when that title was already public, a title. There is no slug, so no URL can be
 * built from it at all; there is no price, no currency, no media, no seller and no moderation state,
 * because the shape has nowhere to put them. `title` is null when the listing never had a public title
 * or had one withdrawn, and the surface falls back to the conversation's own stored snapshot.
 */
export const UnavailableListingReferenceSchema = z
  .object({
    status: z.literal('no_longer_available'),
    id: z.string().uuid(),
    title: z.string().nullable(),
  })
  .strict()
  .openapi('UnavailableListingReference');

export const ListingReferenceSchema = z
  .discriminatedUnion('status', [AvailableListingReferenceSchema, UnavailableListingReferenceSchema])
  .openapi('ListingReference');

export type InboxItem = z.infer<typeof InboxItemSchema>;
export type MessagingInboxResponse = z.infer<typeof MessagingInboxResponseSchema>;
export type MessageItem = z.infer<typeof MessageItemSchema>;
export type ConversationMessagesResponse = z.infer<typeof ConversationMessagesResponseSchema>;
export type UnreadCountResponse = z.infer<typeof UnreadCountResponseSchema>;
export type AvailableListingReference = z.infer<typeof AvailableListingReferenceSchema>;
export type UnavailableListingReference = z.infer<typeof UnavailableListingReferenceSchema>;
export type ListingReference = z.infer<typeof ListingReferenceSchema>;
export type ConversationSubjectType = z.infer<typeof ConversationSubjectTypeSchema>;
export type ConversationMembershipState = z.infer<typeof ConversationMembershipStateSchema>;
export type MessageType = z.infer<typeof MessageTypeSchema>;
export type MessageReferenceType = z.infer<typeof MessageReferenceTypeSchema>;

/**
 * Parses a `limit` query parameter against one of the two approved page sizes.
 *
 * Absent means the default. A value that is not a whole positive number is invalid rather than
 * silently corrected — the same rule the catalogue surfaces use — but a value **above** the maximum is
 * clamped down to it rather than refused, which is the approved behaviour for these two routes.
 */
export function parseMessagingLimit(
  value: unknown,
  bounds: { readonly fallback: number; readonly maximum: number },
): { ok: true; limit: number } | { ok: false } {
  if (value === undefined || value === null || value === '') return { ok: true, limit: bounds.fallback };
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,3}$/.test(value)) return { ok: false };
  return { ok: true, limit: Math.min(Number(value), bounds.maximum) };
}

/**
 * The messaging write contracts (Phase 5-E).
 *
 * The read contracts above are unchanged. What follows is the six write operations and nothing more: no
 * edit, no delete, no reopen, no attachment, no reference composition. Each request schema is `.strict()`
 * and carries only what the operation needs, which is how a field nobody approved fails to arrive.
 *
 * **No request names a user.** The caller is resolved from their own session, so there is no `userId`,
 * `senderId` or `participantId` anywhere below. A schema that had one would be a schema somebody could
 * use to act as somebody else.
 *
 * **Outcomes are values, not statuses alone.** Starting a conversation reports whether it was created or
 * an existing one was reused, because the surface needs to know where to navigate and both are success.
 * Failures stay in the problem-details envelope.
 */

/** Where a conversation may be started from. Exactly the two approved entry points. */
export const CONVERSATION_ENTRY_POINTS = ['listing', 'direct'] as const;

/**
 * Starting a conversation.
 *
 * A listing entry names the listing; a direct entry names the seller **by their public slug**. The union
 * is discriminated so neither can be sent with the other's field, and `.strict()` means a request cannot
 * carry both.
 *
 * The slug rather than a user id is the whole point of the direct shape. 4-E decided that the public
 * seller profile exposes five fields and that the seller's identifier is not one of them, so the page
 * that offers "message this seller" has no user id to send. Resolution happens inside the database, which
 * means no surface, contract or log on the way there ever holds it.
 */
export const StartListingConversationRequestSchema = z
  .object({
    subjectType: z.literal('listing'),
    listingId: z.string().uuid(),
  })
  .strict()
  .openapi('StartListingConversationRequest');

export const StartDirectConversationRequestSchema = z
  .object({
    subjectType: z.literal('direct'),
    sellerSlug: z.string().min(1).max(50),
  })
  .strict()
  .openapi('StartDirectConversationRequest');

export const StartConversationRequestSchema = z
  .discriminatedUnion('subjectType', [
    StartListingConversationRequestSchema,
    StartDirectConversationRequestSchema,
  ])
  .openapi('StartConversationRequest');

/** `reused` is a success: the surface navigates to the conversation that already existed. */
export const StartConversationResponseSchema = z
  .object({
    outcome: z.enum(['created', 'reused']),
    conversationId: z.string().uuid(),
  })
  .strict()
  .openapi('StartConversationResponse');

/** The longest a text message may be, matching 0014's own constraint. */
export const MESSAGE_BODY_MAX_LENGTH = 5000;

export const SendMessageRequestSchema = z
  .object({
    body: z.string().min(1).max(MESSAGE_BODY_MAX_LENGTH),
  })
  .strict()
  .openapi('SendMessageRequest');

/** The message as stored, so a surface renders what committed rather than what it hoped for. */
export const SendMessageResponseSchema = z
  .object({
    message: MessageItemSchema,
  })
  .strict()
  .openapi('SendMessageResponse');

export const MarkReadRequestSchema = z
  .object({
    seq: MessageSequenceSchema,
  })
  .strict()
  .openapi('MarkReadRequest');

/** The marker as it now stands, which may be lower than asked for: it clamps and never moves back. */
export const MarkReadResponseSchema = z
  .object({
    lastReadSeq: MessageSequenceSchema.nullable(),
  })
  .strict()
  .openapi('MarkReadResponse');

export const SetMutedRequestSchema = z
  .object({
    isMuted: z.boolean(),
  })
  .strict()
  .openapi('SetMutedRequest');

export const SetMutedResponseSchema = z
  .object({
    isMuted: z.boolean(),
  })
  .strict()
  .openapi('SetMutedResponse');

/** Leaving and closing take no body: the conversation is in the path and the caller is in the session. */
export const LeaveConversationResponseSchema = z
  .object({
    membershipState: z.literal('left'),
  })
  .strict()
  .openapi('LeaveConversationResponse');

export const CloseConversationResponseSchema = z
  .object({
    isClosed: z.literal(true),
    closedAt: z.string().datetime(),
  })
  .strict()
  .openapi('CloseConversationResponse');

export type StartConversationRequest = z.infer<typeof StartConversationRequestSchema>;
export type StartConversationResponse = z.infer<typeof StartConversationResponseSchema>;
export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;
export type SendMessageResponse = z.infer<typeof SendMessageResponseSchema>;
export type MarkReadRequest = z.infer<typeof MarkReadRequestSchema>;
export type MarkReadResponse = z.infer<typeof MarkReadResponseSchema>;
export type SetMutedRequest = z.infer<typeof SetMutedRequestSchema>;
export type SetMutedResponse = z.infer<typeof SetMutedResponseSchema>;
export type LeaveConversationResponse = z.infer<typeof LeaveConversationResponseSchema>;
export type CloseConversationResponse = z.infer<typeof CloseConversationResponseSchema>;

/**
 * Reporting a message or a conversation (Phase 5-H).
 *
 * A thin contract over 0027's reporting, which owns everything substantive: the table, the reason
 * vocabulary, the one-open-report-per-reporter-per-subject rule, and the outbox event. Three fields go
 * out and two come back.
 *
 * **What is deliberately absent.** No reporter: the caller is resolved from their own session, so a
 * request that could name one would be a request somebody could use to report as somebody else. No
 * `details` field either — a free-text box on this surface is an invitation to paste the message into the
 * report, and the message is already identified by `subjectId`. If details are ever wanted, they are a
 * decision to take deliberately rather than a field left open in case.
 */

/** The two things a conversation can produce a report about. Both are 0027's own subject types. */
export const MESSAGING_REPORT_SUBJECTS = ['message', 'conversation'] as const;
export const MessagingReportSubjectSchema = z.enum(MESSAGING_REPORT_SUBJECTS);

/**
 * 0027's reason vocabulary, unchanged and not extended.
 *
 * Messaging invents no reason of its own: these are the eleven the reports table already allows, and the
 * surface sends `other` when the reporter has not been asked to choose, which is what that value is for.
 */
export const REPORT_REASON_CODES = [
  'prohibited_item',
  'counterfeit',
  'intellectual_property',
  'fraud_or_scam',
  'harassment',
  'adult_content',
  'violence',
  'spam',
  'misleading',
  'off_platform',
  'other',
] as const;
export const ReportReasonCodeSchema = z.enum(REPORT_REASON_CODES);

export const FileMessagingReportRequestSchema = z
  .object({
    subjectType: MessagingReportSubjectSchema,
    subjectId: z.string().uuid(),
    reasonCode: ReportReasonCodeSchema,
  })
  .strict()
  .openapi('FileMessagingReportRequest');

/**
 * The report that is now open for this reporter and this subject.
 *
 * One outcome, because there is only one: 0027 returns the same report for a repeat as for the first
 * filing, so "created" and "already open" are the same fact from the reporter's side and the surface says
 * the same thing either way. The id is the reporter's own report, which is why it may cross to them.
 */
export const FileMessagingReportResponseSchema = z
  .object({
    outcome: z.literal('filed'),
    reportId: z.string().uuid(),
  })
  .strict()
  .openapi('FileMessagingReportResponse');

export type MessagingReportSubject = z.infer<typeof MessagingReportSubjectSchema>;
export type ReportReasonCode = z.infer<typeof ReportReasonCodeSchema>;
export type FileMessagingReportRequest = z.infer<typeof FileMessagingReportRequestSchema>;
export type FileMessagingReportResponse = z.infer<typeof FileMessagingReportResponseSchema>;
