import { z } from './zod.js';

/**
 * Support — the requester side (Phase 7-K).
 *
 * The shapes below are what somebody who needs help sends, and what they are allowed to see back. Both
 * halves are decisions rather than conveniences.
 *
 *   * **No request names an account.** A caller addresses a *ticket*, a *message* or an *attachment*, all
 *     of which name rows, and their own identity is resolved from their session upstream. There is no
 *     `requesterUserId`, `userId` or `authorUserId` field in any schema in this module.
 *   * **No request names a status, an agent, a priority or a queue position.** Opening a ticket sends a
 *     subject, a category and a first message; replying sends a body; closing sends nothing at all. The
 *     status is the database's, the priority is 0028's `normal` default, and assignment is the console's.
 *   * **Nothing internal is representable.** There is no schema here for an internal note, and none of
 *     the response schemas carries an assigned agent, an assignment time, a priority, a first-response
 *     time, a membership version or the account identifier of whoever wrote a message. A field that does
 *     not exist in the contract cannot be rendered by a page, and a response carrying one would fail
 *     validation at the boundary instead of reaching a browser.
 *   * **A message says which side wrote it, and nothing more about them.** `authorRole` is `requester` or
 *     `agent` — 0028's own two values — and `isOwnMessage` is the answer the database already worked out.
 *   * **An attachment travels as what a page displays plus the identifier a link operation takes.** The
 *     object path is not in any response schema: a browser learns one exactly once, as the destination of
 *     an upload the database authorized, and never learns another.
 *
 * The five statuses and the eight categories are 0028's closed vocabularies, read off the table's own
 * constraints. This module defines no ninth category, no status a requester could ask for, and no
 * priority, severity, SLA or escalation level of any kind.
 */

/** `support_tickets_status_allowed`. Read-only here: no request schema carries a status. */
export const SUPPORT_TICKET_STATUSES = [
  'open',
  'pending_agent',
  'pending_requester',
  'resolved',
  'closed',
] as const;
export type SupportTicketStatus = (typeof SUPPORT_TICKET_STATUSES)[number];
export const SupportTicketStatusSchema = z
  .enum(SUPPORT_TICKET_STATUSES)
  .openapi('SupportTicketStatus');

/**
 * `support_tickets_category_allowed`, in the table's own order.
 *
 * The one closed vocabulary a requester does choose from. It is exposed because the column is `not null`
 * and has no default, so a ticket cannot be opened without one.
 */
export const SUPPORT_TICKET_CATEGORIES = [
  'account',
  'orders',
  'payments',
  'payouts',
  'listings',
  'verification',
  'technical',
  'other',
] as const;
export type SupportTicketCategory = (typeof SUPPORT_TICKET_CATEGORIES)[number];
export const SupportTicketCategorySchema = z
  .enum(SUPPORT_TICKET_CATEGORIES)
  .openapi('SupportTicketCategory');

/** `support_messages_author_role_allowed`. Which side wrote a message, and the whole of what is said. */
export const SUPPORT_MESSAGE_AUTHOR_ROLES = ['requester', 'agent'] as const;
export type SupportMessageAuthorRole = (typeof SUPPORT_MESSAGE_AUTHOR_ROLES)[number];
export const SupportMessageAuthorRoleSchema = z
  .enum(SUPPORT_MESSAGE_AUTHOR_ROLES)
  .openapi('SupportMessageAuthorRole');

export const SUPPORT_TICKETS_DEFAULT_LIMIT = 20;
export const SUPPORT_TICKETS_MAX_LIMIT = 50;
export const SUPPORT_MESSAGES_DEFAULT_LIMIT = 20;
export const SUPPORT_MESSAGES_MAX_LIMIT = 50;

/** `support_tickets_subject_length`. */
export const SupportSubjectSchema = z.string().trim().min(1).max(200);
/** `support_messages_body_length`, which governs the first message and every reply alike. */
export const SupportBodySchema = z.string().trim().min(1).max(8000);

/** The four types 0012's `support-attachments` bucket allows, in its own order. */
export const SUPPORT_ATTACHMENT_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const;
export type SupportAttachmentContentType = (typeof SUPPORT_ATTACHMENT_CONTENT_TYPES)[number];
export const SupportAttachmentContentTypeSchema = z
  .enum(SUPPORT_ATTACHMENT_CONTENT_TYPES)
  .openapi('SupportAttachmentContentType');

/**
 * The bucket's own 20 MiB ceiling, restated here for one reason: so somebody choosing a 40 MB photograph
 * is told before it is uploaded rather than after. The database reads the limit from the bucket row and
 * applies it again, and that application is the authoritative one.
 */
export const SUPPORT_ATTACHMENT_MAX_BYTES = 20_971_520;

/** A stored `bigint` byte size, carried as a decimal string because a JSON number is a double. */
export const SupportByteSizeSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);

/**
 * One row of the requester's ticket list.
 *
 * `reference` is what somebody quotes back to an agent, which is exactly why it is here.
 * `attachmentCount` is how many files the whole ticket carries. There is no agent, no priority and no
 * position in a queue.
 */
export const SupportTicketSummarySchema = z
  .object({
    id: z.uuid(),
    /** Null only for the instant before 0028's trigger has generated one, which no read can observe. */
    reference: z.string().nullable(),
    subject: z.string().min(1),
    category: SupportTicketCategorySchema,
    status: SupportTicketStatusSchema,
    messageCount: z.number().int().nonnegative(),
    attachmentCount: z.number().int().nonnegative(),
    lastMessageAt: z.string().nullable(),
    resolvedAt: z.string().nullable(),
    closedAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .strict()
  .openapi('SupportTicketSummary');

export const SupportTicketsResponseSchema = z
  .object({
    items: z.array(SupportTicketSummarySchema),
    nextCursor: z.string().nullable(),
  })
  .strict()
  .openapi('SupportTicketsResponse');

/**
 * One ticket, as the account that raised it sees it.
 *
 * The same fields as a list row. There is deliberately nothing extra: a ticket's detail *is* its
 * conversation, which is a separate operation with its own pagination, and everything a console would add
 * to this shape is the console's.
 */
export const SupportTicketDetailSchema = z
  .object({
    id: z.uuid(),
    reference: z.string().nullable(),
    subject: z.string().min(1),
    category: SupportTicketCategorySchema,
    status: SupportTicketStatusSchema,
    messageCount: z.number().int().nonnegative(),
    lastMessageAt: z.string().nullable(),
    resolvedAt: z.string().nullable(),
    closedAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .strict()
  .openapi('SupportTicketDetail');

export const SupportTicketDetailResponseSchema = z
  .object({ ticket: SupportTicketDetailSchema })
  .strict()
  .openapi('SupportTicketDetailResponse');

/** One file on a message: what a page displays, and the identifier the link operation takes. */
export const SupportAttachmentSchema = z
  .object({
    id: z.uuid(),
    /** The name the requester's own file had, trimmed by the database. Null when it had none. */
    originalFilename: z.string().min(1).nullable(),
    contentType: z.string().min(1).nullable(),
    byteSize: SupportByteSizeSchema.nullable(),
  })
  .strict()
  .openapi('SupportAttachment');

/** One message in a ticket's conversation. It names a side, never an account. */
export const SupportMessageSchema = z
  .object({
    id: z.uuid(),
    authorRole: SupportMessageAuthorRoleSchema,
    isOwnMessage: z.boolean(),
    body: z.string().min(1),
    createdAt: z.string(),
    attachments: z.array(SupportAttachmentSchema),
  })
  .strict()
  .openapi('SupportMessage');

/** One page of a conversation, in reading order. `nextCursor` names the page *before* this one. */
export const SupportMessagesResponseSchema = z
  .object({
    items: z.array(SupportMessageSchema),
    nextCursor: z.string().nullable(),
  })
  .strict()
  .openapi('SupportMessagesResponse');

/**
 * Opening a ticket.
 *
 * A subject, one of the eight categories, and the first message. **No priority**, because a requester does
 * not triage and 0028's `normal` default is the right answer; **no status**, because the schema owns it;
 * **no assignee**, because that is the console's; and **no related order**, because nothing in this
 * application yet gives a buyer a list of their orders to name one from.
 */
export const OpenSupportTicketSchema = z
  .object({
    subject: SupportSubjectSchema,
    category: SupportTicketCategorySchema,
    body: SupportBodySchema,
  })
  .strict()
  .openapi('OpenSupportTicket');

/** Replying. The ticket is named in the route, so the body is the message and nothing else. */
export const PostSupportMessageSchema = z
  .object({ body: SupportBodySchema })
  .strict()
  .openapi('PostSupportMessage');

/**
 * What opening a ticket answers.
 *
 * `messageId` is the first message's, so a file can be recorded against it without a second read; the
 * reference is what to quote to an agent; the status is whatever 0028's writers left the row at, read back
 * rather than assumed.
 */
export const OpenSupportTicketResponseSchema = z
  .object({
    ticketId: z.uuid(),
    messageId: z.uuid(),
    reference: z.string().nullable(),
    status: SupportTicketStatusSchema,
  })
  .strict()
  .openapi('OpenSupportTicketResponse');

/** What replying answers: the message that now exists, and which side the ticket is waiting on. */
export const SupportMessageMutationResponseSchema = z
  .object({
    messageId: z.uuid(),
    status: SupportTicketStatusSchema,
  })
  .strict()
  .openapi('SupportMessageMutationResponse');

/**
 * What closing answers.
 *
 * One field, and it can only ever say `closed`: the operation names the transition, there is no status in
 * the request, and the database passes the literal to 0028's writer. Recording `resolved` is the agent
 * outcome and has no representation anywhere in this module.
 */
export const SupportTicketClosureResponseSchema = z
  .object({ status: SupportTicketStatusSchema })
  .strict()
  .openapi('SupportTicketClosureResponse');

/**
 * Asking for somewhere to put one file.
 *
 * The message is named in the route together with its ticket. The body says what kind of file it is and
 * how large — both of which the bucket has the final say on — and **carries no path**: a strict schema with
 * no `objectPath` field is the first of the two walls that keep a browser from choosing a destination.
 */
export const SupportAttachmentUploadRequestSchema = z
  .object({
    contentType: SupportAttachmentContentTypeSchema,
    byteSize: z.number().int().positive().max(SUPPORT_ATTACHMENT_MAX_BYTES),
  })
  .strict()
  .openapi('SupportAttachmentUploadRequest');

export const SupportAttachmentUploadSchema = z
  .object({
    /** Where the bytes go. Opaque, short-lived and bound to `objectPath` alone. */
    uploadUrl: z.string().url(),
    /**
     * The path that was authorized. The client sends it back to confirm and chose no part of it: the
     * bucket, the ticket, the message and a fresh uuid are all the server's. This is the one place a path
     * is disclosed, and no readback ever returns one.
     */
    objectPath: z.string().min(1),
    expiresAt: z.string().datetime(),
    maxByteSize: z.number().int().positive(),
  })
  .strict()
  .openapi('SupportAttachmentUpload');

export const SupportAttachmentUploadResponseSchema = z
  .object({ upload: SupportAttachmentUploadSchema })
  .strict()
  .openapi('SupportAttachmentUploadResponse');

/** Confirming an upload that happened. The path is the one the server issued, sent back unchanged. */
export const SupportAttachmentRecordSchema = z
  .object({
    objectPath: z.string().min(1).max(512),
    originalFilename: z.string().trim().min(1).max(255),
    contentType: SupportAttachmentContentTypeSchema,
    byteSize: z.number().int().positive().max(SUPPORT_ATTACHMENT_MAX_BYTES),
  })
  .strict()
  .openapi('SupportAttachmentRecord');

/** What confirming answers: the attachment, and how many that message now carries. Never a path. */
export const SupportAttachmentRecordResponseSchema = z
  .object({
    attachmentId: z.uuid(),
    attachmentCount: z.number().int().positive(),
  })
  .strict()
  .openapi('SupportAttachmentRecordResponse');

/** A short-lived authorization to look at one file. The URL is the credential; the path is not returned. */
export const SupportAttachmentLinkResponseSchema = z
  .object({
    attachmentId: z.uuid(),
    url: z.string().url(),
    expiresAt: z.string().datetime(),
  })
  .strict()
  .openapi('SupportAttachmentLinkResponse');

export type SupportTicketSummary = z.infer<typeof SupportTicketSummarySchema>;
export type SupportTicketsResponse = z.infer<typeof SupportTicketsResponseSchema>;
export type SupportTicketDetail = z.infer<typeof SupportTicketDetailSchema>;
export type SupportTicketDetailResponse = z.infer<typeof SupportTicketDetailResponseSchema>;
export type SupportAttachment = z.infer<typeof SupportAttachmentSchema>;
export type SupportMessage = z.infer<typeof SupportMessageSchema>;
export type SupportMessagesResponse = z.infer<typeof SupportMessagesResponseSchema>;
export type OpenSupportTicket = z.infer<typeof OpenSupportTicketSchema>;
export type PostSupportMessage = z.infer<typeof PostSupportMessageSchema>;
export type OpenSupportTicketResponse = z.infer<typeof OpenSupportTicketResponseSchema>;
export type SupportMessageMutationResponse = z.infer<typeof SupportMessageMutationResponseSchema>;
export type SupportTicketClosureResponse = z.infer<typeof SupportTicketClosureResponseSchema>;
export type SupportAttachmentUploadRequest = z.infer<typeof SupportAttachmentUploadRequestSchema>;
export type SupportAttachmentUpload = z.infer<typeof SupportAttachmentUploadSchema>;
export type SupportAttachmentUploadResponse = z.infer<typeof SupportAttachmentUploadResponseSchema>;
export type SupportAttachmentRecord = z.infer<typeof SupportAttachmentRecordSchema>;
export type SupportAttachmentRecordResponse = z.infer<typeof SupportAttachmentRecordResponseSchema>;
export type SupportAttachmentLinkResponse = z.infer<typeof SupportAttachmentLinkResponseSchema>;
