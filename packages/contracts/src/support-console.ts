import { z } from './zod.js';
import {
  SupportAttachmentSchema,
  SupportMessageAuthorRoleSchema,
  SupportTicketCategorySchema,
  SupportTicketStatusSchema,
} from './support.js';

/**
 * The support agent console (Phase 7-L).
 *
 * The staff side of the surface 7-K built for requesters, and it reuses 7-K's vocabularies rather than
 * restating them: the five statuses, the eight categories, the two author roles and the attachment shape
 * are all imported from `support.ts`, so there is exactly one definition of each in the repository and a
 * change to one cannot leave the two sides disagreeing.
 *
 * What is different here, and why:
 *
 *   * **A ticket says who holds it without saying who anybody is.** `isMine` and `isAssigned` are derived
 *     in the database from the account the API established. There is no `assignedTo`, no agent name and no
 *     agent identifier in any schema in this module — a console that cannot represent a colleague's
 *     account cannot leak one.
 *   * **`priority` is read, never written.** It appears on a ticket because it is a fact a colleague should
 *     see, and in **no request schema at all**: nothing on this surface sets it, and the queue is not
 *     ordered by it.
 *   * **An internal note says whether it is the caller's own and nothing else about its author.** It exists
 *     in this module and in no other, and no requester response schema anywhere can carry one.
 *   * **The two agent outcomes are a closed pair.** The decision request admits `resolved` and `closed`
 *     only — the two values 0028's own writer defines — and nothing else is expressible. There is no
 *     reopen request, because nothing in the repository reopens a ticket.
 *   * **Claiming and releasing take no agent.** Each is a request with no body at all: the account comes
 *     from the session, so one agent can never be assigned by another.
 *   * **No request names an account, a role, a permission or an assurance level.** Those are resolved from
 *     the caller's own staff session upstream, and the database applies its own permission test again.
 */

export const SUPPORT_CONSOLE_DEFAULT_LIMIT = 20;
export const SUPPORT_CONSOLE_MAX_LIMIT = 50;

/** `support_tickets_priority_allowed`. Read-only here: no request schema carries a priority. */
export const SUPPORT_TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type SupportTicketPriority = (typeof SUPPORT_TICKET_PRIORITIES)[number];
export const SupportTicketPrioritySchema = z
  .enum(SUPPORT_TICKET_PRIORITIES)
  .openapi('SupportTicketPriority');

/**
 * The two outcomes an agent may record.
 *
 * 0028's `close_support_ticket` admits exactly these, and the requester's own closure is pinned to
 * `closed` by a different function with no status parameter at all. So this is the only place in the
 * repository where a status crosses the wire, and it is a closed pair of two.
 */
export const SUPPORT_AGENT_DECISIONS = ['resolved', 'closed'] as const;
export type SupportAgentDecision = (typeof SUPPORT_AGENT_DECISIONS)[number];
export const SupportAgentDecisionSchema = z
  .enum(SUPPORT_AGENT_DECISIONS)
  .openapi('SupportAgentDecision');

/** `support_messages_body_length`, which governs an agent's reply exactly as it does a requester's. */
export const SupportConsoleBodySchema = z.string().trim().min(1).max(8000);
/** `support_internal_notes_body_length`. */
export const SupportNoteBodySchema = z.string().trim().min(1).max(8000);

/**
 * One row of the shared queue.
 *
 * The queue is the tickets assigned to nobody, so there is no assignment field on this shape at all — not
 * even `isAssigned`, which would be false on every row.
 */
export const SupportQueueItemSchema = z
  .object({
    id: z.uuid(),
    reference: z.string().nullable(),
    subject: z.string().min(1),
    category: SupportTicketCategorySchema,
    priority: SupportTicketPrioritySchema,
    status: SupportTicketStatusSchema,
    /** The requester's display name. The only thing about them this surface carries. */
    requesterName: z.string().nullable(),
    messageCount: z.number().int().nonnegative(),
    attachmentCount: z.number().int().nonnegative(),
    noteCount: z.number().int().nonnegative(),
    lastMessageAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .strict()
  .openapi('SupportQueueItem');

export const SupportQueueResponseSchema = z
  .object({
    items: z.array(SupportQueueItemSchema),
    nextCursor: z.string().nullable(),
  })
  .strict()
  .openapi('SupportQueueResponse');

/** One row of the agent's own list. Every row is theirs, so it carries no holder field either. */
export const SupportAssignedItemSchema = z
  .object({
    id: z.uuid(),
    reference: z.string().nullable(),
    subject: z.string().min(1),
    category: SupportTicketCategorySchema,
    priority: SupportTicketPrioritySchema,
    status: SupportTicketStatusSchema,
    requesterName: z.string().nullable(),
    messageCount: z.number().int().nonnegative(),
    attachmentCount: z.number().int().nonnegative(),
    noteCount: z.number().int().nonnegative(),
    lastMessageAt: z.string().nullable(),
    resolvedAt: z.string().nullable(),
    closedAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .strict()
  .openapi('SupportAssignedItem');

export const SupportAssignedResponseSchema = z
  .object({
    items: z.array(SupportAssignedItemSchema),
    nextCursor: z.string().nullable(),
  })
  .strict()
  .openapi('SupportAssignedResponse');

/**
 * One ticket, as the agent who may work on it sees it.
 *
 * `isMine` and `isAssigned` are what the console needs to decide which controls exist: a ticket that is
 * nobody's offers a claim, one that is the caller's offers the work, and one that is somebody else's is
 * never returned at all. Both are derived in the database.
 */
export const SupportConsoleTicketSchema = z
  .object({
    id: z.uuid(),
    reference: z.string().nullable(),
    subject: z.string().min(1),
    category: SupportTicketCategorySchema,
    priority: SupportTicketPrioritySchema,
    status: SupportTicketStatusSchema,
    requesterName: z.string().nullable(),
    isMine: z.boolean(),
    isAssigned: z.boolean(),
    messageCount: z.number().int().nonnegative(),
    noteCount: z.number().int().nonnegative(),
    firstResponseAt: z.string().nullable(),
    lastMessageAt: z.string().nullable(),
    resolvedAt: z.string().nullable(),
    closedAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .strict()
  .openapi('SupportConsoleTicket');

export const SupportConsoleTicketResponseSchema = z
  .object({ ticket: SupportConsoleTicketSchema })
  .strict()
  .openapi('SupportConsoleTicketResponse');

/** One message, as an agent sees it. The same shape the requester reads, with `isOwnMessage` theirs. */
export const SupportConsoleMessageSchema = z
  .object({
    id: z.uuid(),
    authorRole: SupportMessageAuthorRoleSchema,
    isOwnMessage: z.boolean(),
    body: z.string().min(1),
    createdAt: z.string(),
    attachments: z.array(SupportAttachmentSchema),
  })
  .strict()
  .openapi('SupportConsoleMessage');

export const SupportConsoleMessagesResponseSchema = z
  .object({
    items: z.array(SupportConsoleMessageSchema),
    nextCursor: z.string().nullable(),
  })
  .strict()
  .openapi('SupportConsoleMessagesResponse');

/**
 * One internal note.
 *
 * It exists in this module and nowhere else. `isOwnNote` is the whole of what it says about its author: a
 * colleague's account is not this console's to disclose, and there is no field here that could carry one.
 */
export const SupportInternalNoteSchema = z
  .object({
    id: z.uuid(),
    isOwnNote: z.boolean(),
    body: z.string().min(1),
    createdAt: z.string(),
  })
  .strict()
  .openapi('SupportInternalNote');

export const SupportInternalNotesResponseSchema = z
  .object({
    items: z.array(SupportInternalNoteSchema),
    nextCursor: z.string().nullable(),
  })
  .strict()
  .openapi('SupportInternalNotesResponse');

/** An agent's reply. The ticket is in the route; there is no author and no role in the body. */
export const PostSupportAgentMessageSchema = z
  .object({ body: SupportConsoleBodySchema })
  .strict()
  .openapi('PostSupportAgentMessage');

/** An internal note. The same shape, a different table, and never visible to a requester. */
export const AddSupportInternalNoteSchema = z
  .object({ body: SupportNoteBodySchema })
  .strict()
  .openapi('AddSupportInternalNote');

/**
 * The agent's decision.
 *
 * The one request in the repository that carries a support status, and it admits two values. `open`,
 * `pending_agent` and `pending_requester` are not expressible here, and neither is anything else.
 */
export const SupportAgentDecisionRequestSchema = z
  .object({ status: SupportAgentDecisionSchema })
  .strict()
  .openapi('SupportAgentDecisionRequest');

/**
 * What claiming or releasing answers.
 *
 * `isMine` says where the ticket ended up, so a console does not have to infer it from which button was
 * pressed; `status` is read back from the row rather than assumed, because claiming an `open` ticket moves
 * it and claiming anything else does not.
 */
export const SupportAssignmentResponseSchema = z
  .object({
    status: SupportTicketStatusSchema,
    isMine: z.boolean(),
  })
  .strict()
  .openapi('SupportAssignmentResponse');

/** What an agent's reply answers: the message that now exists, and where the ticket now stands. */
export const SupportConsoleMessageMutationResponseSchema = z
  .object({
    messageId: z.uuid(),
    status: SupportTicketStatusSchema,
  })
  .strict()
  .openapi('SupportConsoleMessageMutationResponse');

/** What a note answers: the note, and how many the ticket now carries. Never a body echoed back. */
export const SupportInternalNoteMutationResponseSchema = z
  .object({
    noteId: z.uuid(),
    noteCount: z.number().int().positive(),
  })
  .strict()
  .openapi('SupportInternalNoteMutationResponse');

/** What a decision answers: the status the ticket now holds, which is one of the two it asked for. */
export const SupportAgentDecisionResponseSchema = z
  .object({ status: SupportTicketStatusSchema })
  .strict()
  .openapi('SupportAgentDecisionResponse');

/** A short-lived authorization to look at one file on a ticket the agent may work on. */
export const SupportConsoleAttachmentLinkResponseSchema = z
  .object({
    attachmentId: z.uuid(),
    url: z.string().url(),
    expiresAt: z.string().datetime(),
  })
  .strict()
  .openapi('SupportConsoleAttachmentLinkResponse');

export type SupportQueueItem = z.infer<typeof SupportQueueItemSchema>;
export type SupportQueueResponse = z.infer<typeof SupportQueueResponseSchema>;
export type SupportAssignedItem = z.infer<typeof SupportAssignedItemSchema>;
export type SupportAssignedResponse = z.infer<typeof SupportAssignedResponseSchema>;
export type SupportConsoleTicket = z.infer<typeof SupportConsoleTicketSchema>;
export type SupportConsoleTicketResponse = z.infer<typeof SupportConsoleTicketResponseSchema>;
export type SupportConsoleMessage = z.infer<typeof SupportConsoleMessageSchema>;
export type SupportConsoleMessagesResponse = z.infer<typeof SupportConsoleMessagesResponseSchema>;
export type SupportInternalNote = z.infer<typeof SupportInternalNoteSchema>;
export type SupportInternalNotesResponse = z.infer<typeof SupportInternalNotesResponseSchema>;
export type PostSupportAgentMessage = z.infer<typeof PostSupportAgentMessageSchema>;
export type AddSupportInternalNote = z.infer<typeof AddSupportInternalNoteSchema>;
export type SupportAgentDecisionRequest = z.infer<typeof SupportAgentDecisionRequestSchema>;
export type SupportAssignmentResponse = z.infer<typeof SupportAssignmentResponseSchema>;
export type SupportConsoleMessageMutationResponse = z.infer<
  typeof SupportConsoleMessageMutationResponseSchema
>;
export type SupportInternalNoteMutationResponse = z.infer<
  typeof SupportInternalNoteMutationResponseSchema
>;
export type SupportAgentDecisionResponse = z.infer<typeof SupportAgentDecisionResponseSchema>;
export type SupportConsoleAttachmentLinkResponse = z.infer<
  typeof SupportConsoleAttachmentLinkResponseSchema
>;
