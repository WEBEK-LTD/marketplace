import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  SupportAgentDecision,
  SupportAgentDecisionResponse,
  SupportAssignedItem,
  SupportAssignmentResponse,
  SupportConsoleAttachmentLinkResponse,
  SupportConsoleMessage,
  SupportConsoleMessageMutationResponse,
  SupportConsoleTicket,
  SupportInternalNote,
  SupportInternalNoteMutationResponse,
  SupportMessageAuthorRole,
  SupportQueueItem,
  SupportTicketCategory,
  SupportTicketPriority,
  SupportTicketStatus,
} from '@repo/contracts';
import { isAal2 } from '../auth/access-token-claims.js';
import {
  SELLER_MEDIA_STORAGE,
  SellerMediaStorageUnavailableError,
  type SellerMediaStoragePort,
} from '../sellers/seller-media.storage.js';
import {
  decodeSupportMessagesCursor,
  encodeSupportMessagesCursor,
} from '../support/support-cursor.js';
import { StaffConsoleService } from './staff-console.service.js';
import {
  SupportConsoleCursorInvalidError,
  SupportConsoleInvalidError,
  SupportConsoleNotFoundError,
  SupportConsoleUnavailableError,
  SupportTicketNotWorkableError,
} from './support-console.errors.js';
import {
  decodeSupportAssignedCursor,
  decodeSupportNotesCursor,
  decodeSupportQueueCursor,
  encodeSupportAssignedCursor,
  encodeSupportNotesCursor,
  encodeSupportQueueCursor,
} from './support-console.cursor.js';

/**
 * The support agent console (Phase 7-L).
 *
 * **Authorization, in the one order it is ever done**, which is 7-F's and is not varied:
 *
 *   1. The **provider** validates the caller's access token and says whose it is.
 *   2. The **assurance level** is read from that same, now-vouched-for token. Reading a claim first would be
 *      reading an attacker's JSON.
 *   3. The **database** reports the caller's *effective* permissions under 0003's own `requires_mfa` rule.
 *      All three roles that hold a support key require MFA, so staff at `aal1` hold nothing at all — asking
 *      whether the effective set contains a key is therefore the AAL2 check and the permission check at
 *      once, and there is no separate assurance test here that could be forgotten on one route.
 *   4. Every `app_private` function below **re-applies the same permission test itself**, with the account
 *      and the assurance level as parameters and the key as a literal. No bug in this file can turn into
 *      somebody's ticket.
 *
 * **No role name appears in any decision this file makes.** `support_agent` exists in the database and in no
 * branch here: authorization is the permission key and only the permission key. That is what makes "a
 * moderator cannot read a support ticket" true — they hold the key nowhere, not because a list of role names
 * excludes them.
 *
 * **Two keys, and they are not interchangeable.** `support.ticket.read` opens the queue, the ticket, the
 * conversation, the notes and an attachment link; `support.ticket.manage` is required by every one of the
 * four writes. A colleague with read and not manage can follow a ticket and change nothing.
 *
 * **Assignment is the whole of the queue model, and it is the database's.** An agent may see the tickets
 * assigned to them and the tickets assigned to nobody — 0028's own policy predicate — and the three writers
 * that call `can_access_support_ticket` admit only the *assigned* agent. So working a queued ticket starts
 * by claiming it, and nothing here invents a routing rule, a team or a priority ranking to decide that.
 *
 * **A colleague's identity is never learned.** No method returns an assignee, an author or a membership
 * version; a ticket reports `isMine` and `isAssigned` and a note reports `isOwnNote`, all derived in the
 * database. There is no operation here that lists agents, and none that assigns one — claiming assigns the
 * caller and takes no account parameter.
 *
 * **A refusal and an absence are the same answer.** A ticket held by another agent, a ticket that does not
 * exist, a caller holding no key, a caller at `aal1` and an unclaimed ticket on a write all arrive as
 * `not_found` and become one {@link SupportConsoleNotFoundError}. There is no branch here that could tell
 * them apart, so none that could leak the difference.
 *
 * **No notification and no email.** The repository defines no support notification event type, template key
 * or writer, and 7-D owns transport. Nothing here calls either, and nothing invents a sentence for one.
 *
 * **No event and no audit row.** 0028's triggers and writers record `created`, `assigned`, `unassigned`,
 * `status_changed`, `message_posted` and `note_added`, and the ticket table is audited by its own trigger.
 * Nothing in this file writes any of them a second time, and the missing actor on `status_changed` is left
 * exactly as it is rather than redesigned here.
 *
 * **Nothing here logs a value.** A ticket is somebody's problem in their own words, a note is a colleague's
 * assessment of it, and an attachment is a file. The log lines below carry a sentence and no identifier, no
 * body, no file name, no object path and no signed URL.
 */

/** 0033's two keys, as literals in one place. Neither is ever a parameter of a public method. */
export const SUPPORT_CONSOLE_READ_PERMISSION = 'support.ticket.read';
export const SUPPORT_CONSOLE_MANAGE_PERMISSION = 'support.ticket.manage';

/** 0012's private bucket. The one bucket name this surface knows; it is never taken from a request. */
const SUPPORT_BUCKET = 'support-attachments';

export interface SupportQueueRow {
  readonly id: string;
  readonly reference: string | null;
  readonly subject: string | null;
  readonly category: string | null;
  readonly priority: string | null;
  readonly status: string | null;
  readonly requesterName: string | null;
  readonly messageCount: number | null;
  readonly attachmentCount: number | null;
  readonly noteCount: number | null;
  readonly lastMessageAt: Date | string | null;
  readonly createdAt: Date | string | null;
}

export interface SupportAssignedRow extends SupportQueueRow {
  readonly resolvedAt: Date | string | null;
  readonly closedAt: Date | string | null;
}

export interface SupportConsoleTicketRow {
  readonly outcome: string;
  readonly id: string | null;
  readonly reference: string | null;
  readonly subject: string | null;
  readonly category: string | null;
  readonly priority: string | null;
  readonly status: string | null;
  readonly requesterName: string | null;
  readonly isMine: boolean | null;
  readonly isAssigned: boolean | null;
  readonly messageCount: number | null;
  readonly noteCount: number | null;
  readonly firstResponseAt: Date | string | null;
  readonly lastMessageAt: Date | string | null;
  readonly resolvedAt: Date | string | null;
  readonly closedAt: Date | string | null;
  readonly createdAt: Date | string | null;
}

export interface SupportConsoleMessageRow {
  readonly id: string;
  readonly authorRole: string | null;
  readonly isOwnMessage: boolean | null;
  readonly body: string | null;
  readonly createdAt: Date | string | null;
  readonly attachments: unknown;
}

export interface SupportInternalNoteRow {
  readonly id: string;
  readonly isOwnNote: boolean | null;
  readonly body: string | null;
  readonly createdAt: Date | string | null;
}

export interface SupportAssignmentRow {
  readonly outcome: string;
  readonly status: string | null;
  readonly isMine: boolean | null;
}

export interface SupportConsoleMessagePostRow {
  readonly outcome: string;
  readonly messageId: string | null;
  readonly status: string | null;
}

export interface SupportNoteAddRow {
  readonly outcome: string;
  readonly noteId: string | null;
  readonly noteCount: number | null;
}

export interface SupportConsoleDecisionRow {
  readonly outcome: string;
  readonly status: string | null;
}

export interface SupportConsoleAttachmentRow {
  readonly outcome: string;
  readonly bucketId: string | null;
  readonly objectPath: string | null;
}

export interface SupportConsoleStore {
  /** `app_private.support_queue_for_agent(...)` (0075). */
  supportQueueForAgent(input: {
    userId: string;
    isAal2: boolean;
    limit: number;
    cursorCreatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly SupportQueueRow[]>;
  /** `app_private.support_tickets_assigned_to_agent(...)` (0075). */
  supportTicketsAssignedToAgent(input: {
    userId: string;
    isAal2: boolean;
    limit: number;
    cursorCreatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly SupportAssignedRow[]>;
  /** `app_private.support_ticket_for_agent(uuid, boolean, uuid)` (0075). */
  supportTicketForAgent(input: {
    userId: string;
    isAal2: boolean;
    ticketId: string;
  }): Promise<SupportConsoleTicketRow>;
  /** `app_private.support_ticket_messages_for_agent(...)` (0075). */
  supportTicketMessagesForAgent(input: {
    userId: string;
    isAal2: boolean;
    ticketId: string;
    limit: number;
    cursorCreatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly SupportConsoleMessageRow[]>;
  /** `app_private.support_ticket_notes_for_agent(...)` (0075). */
  supportTicketNotesForAgent(input: {
    userId: string;
    isAal2: boolean;
    ticketId: string;
    limit: number;
    cursorCreatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly SupportInternalNoteRow[]>;
  /** `app_private.support_attachment_for_agent(uuid, boolean, uuid, uuid)` (0075). */
  supportAttachmentForAgent(input: {
    userId: string;
    isAal2: boolean;
    ticketId: string;
    attachmentId: string;
  }): Promise<SupportConsoleAttachmentRow>;
  /** `app_private.support_ticket_claim_for_agent(uuid, boolean, uuid)` (0075). */
  supportTicketClaimForAgent(input: {
    userId: string;
    isAal2: boolean;
    ticketId: string;
  }): Promise<SupportAssignmentRow>;
  /** `app_private.support_ticket_release_for_agent(uuid, boolean, uuid)` (0075). */
  supportTicketReleaseForAgent(input: {
    userId: string;
    isAal2: boolean;
    ticketId: string;
  }): Promise<SupportAssignmentRow>;
  /** `app_private.support_message_post_for_agent(uuid, boolean, uuid, text)` (0075). */
  supportMessagePostForAgent(input: {
    userId: string;
    isAal2: boolean;
    ticketId: string;
    body: string;
  }): Promise<SupportConsoleMessagePostRow>;
  /** `app_private.support_note_add_for_agent(uuid, boolean, uuid, text)` (0075). */
  supportNoteAddForAgent(input: {
    userId: string;
    isAal2: boolean;
    ticketId: string;
    body: string;
  }): Promise<SupportNoteAddRow>;
  /** `app_private.support_ticket_close_for_agent(uuid, boolean, uuid, text)` (0075). */
  supportTicketCloseForAgent(input: {
    userId: string;
    isAal2: boolean;
    ticketId: string;
    status: string;
  }): Promise<SupportConsoleDecisionRow>;
}

export const SUPPORT_CONSOLE_STORE = Symbol('SUPPORT_CONSOLE_STORE');

export interface SupportQueuePage {
  readonly items: SupportQueueItem[];
  readonly nextCursor: string | null;
}

export interface SupportAssignedPage {
  readonly items: SupportAssignedItem[];
  readonly nextCursor: string | null;
}

export interface SupportConsoleMessagesPage {
  readonly items: SupportConsoleMessage[];
  readonly nextCursor: string | null;
}

export interface SupportInternalNotesPage {
  readonly items: SupportInternalNote[];
  readonly nextCursor: string | null;
}

function toIsoOrNull(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

@Injectable()
export class SupportConsoleService {
  private readonly logger = new Logger(SupportConsoleService.name);

  constructor(
    @Inject(SUPPORT_CONSOLE_STORE) private readonly store: SupportConsoleStore,
    private readonly console: StaffConsoleService,
    // The same port 6-E defined, 6-I reused, 7-G extended and 7-K reused. There is no second storage client
    // anywhere in this repository and this surface does not introduce one.
    @Inject(SELLER_MEDIA_STORAGE) private readonly storage: SellerMediaStoragePort,
  ) {}

  /** One page of the shared queue: the tickets nobody has claimed, oldest first. */
  async queue(input: {
    accessToken: string;
    limit: number;
    cursor: string | null;
  }): Promise<SupportQueuePage> {
    const staff = await this.#staff(input.accessToken, SUPPORT_CONSOLE_READ_PERMISSION);

    let position: { createdAt: Date; id: string } | null = null;
    if (input.cursor !== null) {
      position = decodeSupportQueueCursor(input.cursor);
      // One refusal for malformed, altered and outdated — including a cursor from the agent's own list,
      // whose order is the opposite of this one. Paging silently from the beginning would repeat tickets a
      // colleague had already worked through.
      if (position === null) throw new SupportConsoleCursorInvalidError();
    }

    let rows: readonly SupportQueueRow[];
    try {
      rows = await this.store.supportQueueForAgent({
        userId: staff.id,
        isAal2: staff.isAal2,
        limit: input.limit + 1,
        cursorCreatedAt: position?.createdAt ?? null,
        cursorId: position?.id ?? null,
      });
    } catch (error) {
      this.logger.error('The support queue could not be read.');
      throw new SupportConsoleUnavailableError(error);
    }

    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    const last = page.at(-1);
    return {
      items: page.map((row) => this.#queueItem(row)),
      nextCursor:
        hasMore && last !== undefined && last.createdAt !== null
          ? encodeSupportQueueCursor({ createdAt: asDate(last.createdAt), id: last.id })
          : null,
    };
  }

  /** One page of the tickets assigned to the caller, any status, newest first. */
  async assigned(input: {
    accessToken: string;
    limit: number;
    cursor: string | null;
  }): Promise<SupportAssignedPage> {
    const staff = await this.#staff(input.accessToken, SUPPORT_CONSOLE_READ_PERMISSION);

    let position: { createdAt: Date; id: string } | null = null;
    if (input.cursor !== null) {
      position = decodeSupportAssignedCursor(input.cursor);
      if (position === null) throw new SupportConsoleCursorInvalidError();
    }

    let rows: readonly SupportAssignedRow[];
    try {
      rows = await this.store.supportTicketsAssignedToAgent({
        userId: staff.id,
        isAal2: staff.isAal2,
        limit: input.limit + 1,
        cursorCreatedAt: position?.createdAt ?? null,
        cursorId: position?.id ?? null,
      });
    } catch (error) {
      this.logger.error('An agent’s own support tickets could not be read.');
      throw new SupportConsoleUnavailableError(error);
    }

    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    const last = page.at(-1);
    return {
      items: page.map((row) => this.#assignedItem(row)),
      nextCursor:
        hasMore && last !== undefined && last.createdAt !== null
          ? encodeSupportAssignedCursor({ createdAt: asDate(last.createdAt), id: last.id })
          : null,
    };
  }

  /** One ticket the caller may work on. */
  async ticket(input: { accessToken: string; ticketId: string }): Promise<SupportConsoleTicket> {
    const staff = await this.#staff(input.accessToken, SUPPORT_CONSOLE_READ_PERMISSION);

    let row: SupportConsoleTicketRow;
    try {
      row = await this.store.supportTicketForAgent({
        userId: staff.id,
        isAal2: staff.isAal2,
        ticketId: input.ticketId,
      });
    } catch (error) {
      this.logger.error('A support ticket could not be read.');
      throw new SupportConsoleUnavailableError(error);
    }

    if (row.outcome === 'not_found') throw new SupportConsoleNotFoundError();
    if (row.outcome !== 'found') {
      this.logger.error('A support ticket read returned an outcome this service does not understand.');
      throw new SupportConsoleUnavailableError(new Error('unexpected outcome'));
    }
    if (
      row.id === null ||
      row.subject === null ||
      row.category === null ||
      row.priority === null ||
      row.status === null ||
      row.isMine === null ||
      row.isAssigned === null ||
      row.messageCount === null ||
      row.noteCount === null ||
      row.createdAt === null
    ) {
      this.logger.error('A support ticket came back incomplete.');
      throw new SupportConsoleUnavailableError(new Error('incomplete support ticket'));
    }

    return {
      id: row.id,
      reference: row.reference,
      subject: row.subject,
      category: row.category as SupportTicketCategory,
      priority: row.priority as SupportTicketPriority,
      status: row.status as SupportTicketStatus,
      requesterName: row.requesterName,
      isMine: row.isMine,
      isAssigned: row.isAssigned,
      messageCount: row.messageCount,
      noteCount: row.noteCount,
      firstResponseAt: toIsoOrNull(row.firstResponseAt),
      lastMessageAt: toIsoOrNull(row.lastMessageAt),
      resolvedAt: toIsoOrNull(row.resolvedAt),
      closedAt: toIsoOrNull(row.closedAt),
      createdAt: toIso(row.createdAt),
    };
  }

  /**
   * One page of a ticket's conversation, in reading order.
   *
   * The reader returns the page already in reading order, having chosen it newest-first from the cursor, so
   * the extra row is the *oldest* one and the cursor is built from the oldest row the caller keeps. An empty
   * first page is resolved in favour of saying nothing, exactly as the requester's is.
   */
  async messages(input: {
    accessToken: string;
    ticketId: string;
    limit: number;
    cursor: string | null;
  }): Promise<SupportConsoleMessagesPage> {
    const staff = await this.#staff(input.accessToken, SUPPORT_CONSOLE_READ_PERMISSION);

    let position: { createdAt: Date; id: string } | null = null;
    if (input.cursor !== null) {
      position = decodeSupportMessagesCursor(input.cursor);
      if (position === null) throw new SupportConsoleCursorInvalidError();
    }

    let rows: readonly SupportConsoleMessageRow[];
    try {
      rows = await this.store.supportTicketMessagesForAgent({
        userId: staff.id,
        isAal2: staff.isAal2,
        ticketId: input.ticketId,
        limit: input.limit + 1,
        cursorCreatedAt: position?.createdAt ?? null,
        cursorId: position?.id ?? null,
      });
    } catch (error) {
      this.logger.error('A support conversation could not be read.');
      throw new SupportConsoleUnavailableError(error);
    }

    if (rows.length === 0 && position === null) throw new SupportConsoleNotFoundError();

    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(rows.length - input.limit) : rows;
    const oldest = page.at(0);
    return {
      items: page.map((row) => this.#message(row)),
      nextCursor:
        hasMore && oldest !== undefined && oldest.createdAt !== null
          ? encodeSupportMessagesCursor({ createdAt: asDate(oldest.createdAt), id: oldest.id })
          : null,
    };
  }

  /**
   * One page of a ticket's internal notes.
   *
   * The only read of `support_internal_notes` in the API. An empty first page is **not** a not-found here:
   * a ticket with no notes is ordinary and common, and the ticket read has already decided whether the
   * caller may see it at all.
   */
  async notes(input: {
    accessToken: string;
    ticketId: string;
    limit: number;
    cursor: string | null;
  }): Promise<SupportInternalNotesPage> {
    const staff = await this.#staff(input.accessToken, SUPPORT_CONSOLE_READ_PERMISSION);

    let position: { createdAt: Date; id: string } | null = null;
    if (input.cursor !== null) {
      position = decodeSupportNotesCursor(input.cursor);
      if (position === null) throw new SupportConsoleCursorInvalidError();
    }

    let rows: readonly SupportInternalNoteRow[];
    try {
      rows = await this.store.supportTicketNotesForAgent({
        userId: staff.id,
        isAal2: staff.isAal2,
        ticketId: input.ticketId,
        limit: input.limit + 1,
        cursorCreatedAt: position?.createdAt ?? null,
        cursorId: position?.id ?? null,
      });
    } catch (error) {
      this.logger.error('A ticket’s internal notes could not be read.');
      throw new SupportConsoleUnavailableError(error);
    }

    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(rows.length - input.limit) : rows;
    const oldest = page.at(0);
    return {
      items: page.map((row) => this.#note(row)),
      nextCursor:
        hasMore && oldest !== undefined && oldest.createdAt !== null
          ? encodeSupportNotesCursor({ createdAt: asDate(oldest.createdAt), id: oldest.id })
          : null,
    };
  }

  /** Takes a ticket from the queue. It assigns the caller and takes no account parameter. */
  async claim(input: { accessToken: string; ticketId: string }): Promise<SupportAssignmentResponse> {
    const staff = await this.#staff(input.accessToken, SUPPORT_CONSOLE_MANAGE_PERMISSION);

    let row: SupportAssignmentRow;
    try {
      row = await this.store.supportTicketClaimForAgent({
        userId: staff.id,
        isAal2: staff.isAal2,
        ticketId: input.ticketId,
      });
    } catch (error) {
      this.logger.error('A support ticket could not be claimed.');
      throw new SupportConsoleUnavailableError(error);
    }
    return this.#assignment(row, 'assigned');
  }

  /** Returns a ticket the caller holds to the queue. It changes no status. */
  async release(input: { accessToken: string; ticketId: string }): Promise<SupportAssignmentResponse> {
    const staff = await this.#staff(input.accessToken, SUPPORT_CONSOLE_MANAGE_PERMISSION);

    let row: SupportAssignmentRow;
    try {
      row = await this.store.supportTicketReleaseForAgent({
        userId: staff.id,
        isAal2: staff.isAal2,
        ticketId: input.ticketId,
      });
    } catch (error) {
      this.logger.error('A support ticket could not be released.');
      throw new SupportConsoleUnavailableError(error);
    }
    return this.#assignment(row, 'released');
  }

  /** Replies to the requester on a ticket the caller holds. */
  async reply(input: {
    accessToken: string;
    ticketId: string;
    body: string;
  }): Promise<SupportConsoleMessageMutationResponse> {
    const staff = await this.#staff(input.accessToken, SUPPORT_CONSOLE_MANAGE_PERMISSION);

    let row: SupportConsoleMessagePostRow;
    try {
      row = await this.store.supportMessagePostForAgent({
        userId: staff.id,
        isAal2: staff.isAal2,
        ticketId: input.ticketId,
        body: input.body,
      });
    } catch (error) {
      this.logger.error('A support reply could not be posted.');
      throw new SupportConsoleUnavailableError(error);
    }

    if (row.outcome === 'posted') {
      if (row.messageId === null || row.status === null) {
        this.logger.error('A posted support reply came back incomplete.');
        throw new SupportConsoleUnavailableError(new Error('incomplete reply'));
      }
      return { messageId: row.messageId, status: row.status as SupportTicketStatus };
    }
    this.#refusal(row.outcome);
  }

  /** Writes an internal note on a ticket the caller holds. */
  async addNote(input: {
    accessToken: string;
    ticketId: string;
    body: string;
  }): Promise<SupportInternalNoteMutationResponse> {
    const staff = await this.#staff(input.accessToken, SUPPORT_CONSOLE_MANAGE_PERMISSION);

    let row: SupportNoteAddRow;
    try {
      row = await this.store.supportNoteAddForAgent({
        userId: staff.id,
        isAal2: staff.isAal2,
        ticketId: input.ticketId,
        body: input.body,
      });
    } catch (error) {
      this.logger.error('An internal note could not be written.');
      throw new SupportConsoleUnavailableError(error);
    }

    if (row.outcome === 'added') {
      if (row.noteId === null || row.noteCount === null) {
        this.logger.error('A written internal note came back incomplete.');
        throw new SupportConsoleUnavailableError(new Error('incomplete note'));
      }
      return { noteId: row.noteId, noteCount: row.noteCount };
    }
    this.#refusal(row.outcome);
  }

  /**
   * Records the agent's outcome.
   *
   * The status arrives already narrowed to `resolved` or `closed` by the contract, and the database checks
   * it against the same two literals before calling 0028's writer. There is no third value anywhere on the
   * path, and no reopen.
   */
  async decide(input: {
    accessToken: string;
    ticketId: string;
    status: SupportAgentDecision;
  }): Promise<SupportAgentDecisionResponse> {
    const staff = await this.#staff(input.accessToken, SUPPORT_CONSOLE_MANAGE_PERMISSION);

    let row: SupportConsoleDecisionRow;
    try {
      row = await this.store.supportTicketCloseForAgent({
        userId: staff.id,
        isAal2: staff.isAal2,
        ticketId: input.ticketId,
        status: input.status,
      });
    } catch (error) {
      this.logger.error('A support ticket decision could not be recorded.');
      throw new SupportConsoleUnavailableError(error);
    }

    if (row.outcome === 'closed') {
      if (row.status === null) {
        this.logger.error('A support decision came back without its status.');
        throw new SupportConsoleUnavailableError(new Error('incomplete decision'));
      }
      return { status: row.status as SupportTicketStatus };
    }
    this.#refusal(row.outcome);
  }

  /**
   * A short-lived authorization to look at one file.
   *
   * **The caller names an attachment; the path comes from the row.** Nothing in this method's signature can
   * carry a path, and the only value that reaches the provider is `row.objectPath`, which the database
   * returns only when the attachment, its message's ticket and the ticket in the route agree *and* the
   * ticket is one the caller may work on.
   */
  async attachmentLink(input: {
    accessToken: string;
    ticketId: string;
    attachmentId: string;
  }): Promise<SupportConsoleAttachmentLinkResponse> {
    const staff = await this.#staff(input.accessToken, SUPPORT_CONSOLE_READ_PERMISSION);

    let row: SupportConsoleAttachmentRow;
    try {
      row = await this.store.supportAttachmentForAgent({
        userId: staff.id,
        isAal2: staff.isAal2,
        ticketId: input.ticketId,
        attachmentId: input.attachmentId,
      });
    } catch (error) {
      this.logger.error('A support attachment could not be located.');
      throw new SupportConsoleUnavailableError(error);
    }

    if (row.outcome !== 'authorized') throw new SupportConsoleNotFoundError();
    if (row.bucketId === null || row.objectPath === null) {
      this.logger.error('An authorized support attachment came back without its location.');
      throw new SupportConsoleUnavailableError(new Error('incomplete attachment location'));
    }
    // The bucket is the database's answer, and it must be the one bucket this surface knows. A disagreement
    // is a drift between this file and the migration, not something to hand to a provider.
    if (row.bucketId !== SUPPORT_BUCKET) {
      this.logger.error('A support attachment named a bucket this service does not serve.');
      throw new SupportConsoleUnavailableError(new Error('unexpected bucket'));
    }

    let signed: Awaited<ReturnType<SellerMediaStoragePort['signDownload']>>;
    try {
      signed = await this.storage.signDownload(row.bucketId, row.objectPath);
    } catch (error) {
      if (!(error instanceof SellerMediaStorageUnavailableError)) {
        this.logger.error('Signing a support attachment read failed.');
      }
      throw new SupportConsoleUnavailableError(error);
    }

    return {
      attachmentId: input.attachmentId,
      url: signed.url,
      expiresAt: signed.expiresAt.toISOString(),
    };
  }

  /* ------------------------------------------------------------------------------------------------ */

  /**
   * The caller's account and assurance level, once they are known to hold one named key.
   *
   * A caller who does not is a not-found rather than a 403, for the reason set out in the errors file. The
   * key is a parameter of this private method only, never of a public one: no route and no body can name it.
   */
  async #staff(accessToken: string, permission: string): Promise<{ id: string; isAal2: boolean }> {
    // The provider validates the token inside `forToken`; only then is a claim read from it. That order is
    // 7-F's and is not varied here.
    const session = await this.console.forToken(accessToken);
    if (!session.permissions.includes(permission)) throw new SupportConsoleNotFoundError();
    // The level is read from the same validated token rather than assumed from the permission being present.
    return { id: session.id, isAal2: isAal2(accessToken) };
  }

  /** The one place an outcome that is not a success becomes an error. */
  #refusal(outcome: string): never {
    if (outcome === 'not_found') throw new SupportConsoleNotFoundError();
    if (outcome === 'conflict') throw new SupportTicketNotWorkableError();
    if (outcome === 'invalid') throw new SupportConsoleInvalidError();
    this.logger.error('A support console operation returned an outcome this service does not understand.');
    throw new SupportConsoleUnavailableError(new Error('unexpected outcome'));
  }

  #assignment(row: SupportAssignmentRow, expected: string): SupportAssignmentResponse {
    if (row.outcome === expected) {
      if (row.status === null || row.isMine === null) {
        this.logger.error('A support assignment came back incomplete.');
        throw new SupportConsoleUnavailableError(new Error('incomplete assignment'));
      }
      return { status: row.status as SupportTicketStatus, isMine: row.isMine };
    }
    this.#refusal(row.outcome);
  }

  #queueItem(row: SupportQueueRow): SupportQueueItem {
    return {
      id: row.id,
      reference: row.reference,
      subject: this.#required(row.subject, 'subject'),
      category: this.#required(row.category, 'category') as SupportTicketCategory,
      priority: this.#required(row.priority, 'priority') as SupportTicketPriority,
      status: this.#required(row.status, 'status') as SupportTicketStatus,
      requesterName: row.requesterName,
      messageCount: this.#count(row.messageCount),
      attachmentCount: this.#count(row.attachmentCount),
      noteCount: this.#count(row.noteCount),
      lastMessageAt: toIsoOrNull(row.lastMessageAt),
      createdAt: toIso(this.#requiredDate(row.createdAt)),
    };
  }

  #assignedItem(row: SupportAssignedRow): SupportAssignedItem {
    return {
      ...this.#queueItem(row),
      resolvedAt: toIsoOrNull(row.resolvedAt),
      closedAt: toIsoOrNull(row.closedAt),
    };
  }

  #message(row: SupportConsoleMessageRow): SupportConsoleMessage {
    return {
      id: row.id,
      authorRole: this.#required(row.authorRole, 'authorRole') as SupportMessageAuthorRole,
      isOwnMessage: row.isOwnMessage === true,
      body: this.#required(row.body, 'body'),
      createdAt: toIso(this.#requiredDate(row.createdAt)),
      attachments: this.#attachments(row.attachments),
    };
  }

  #note(row: SupportInternalNoteRow): SupportInternalNote {
    return {
      id: row.id,
      isOwnNote: row.isOwnNote === true,
      body: this.#required(row.body, 'body'),
      createdAt: toIso(this.#requiredDate(row.createdAt)),
    };
  }

  /**
   * The attachments a message carries, projected field by field out of the reader's aggregate.
   *
   * Validated rather than trusted: a shape this method does not recognise fails as unavailable instead of
   * reaching a browser. **`objectPath` is not read**, because the reader does not return one — and if a
   * later change made it, this projection would still not carry it.
   */
  #attachments(value: unknown): SupportConsoleMessage['attachments'] {
    if (value === null || value === undefined) return [];
    const raw = typeof value === 'string' ? this.#parse(value) : value;
    if (!Array.isArray(raw)) {
      this.logger.error('A support message carried attachments in a shape this service cannot read.');
      throw new SupportConsoleUnavailableError(new Error('unreadable attachments'));
    }

    return raw.map((entry) => {
      if (typeof entry !== 'object' || entry === null) {
        this.logger.error('A support attachment came back in a shape this service cannot read.');
        throw new SupportConsoleUnavailableError(new Error('unreadable attachment'));
      }
      const item = entry as Record<string, unknown>;
      const id = item['id'];
      if (typeof id !== 'string') {
        this.logger.error('A support attachment came back without an identifier.');
        throw new SupportConsoleUnavailableError(new Error('incomplete attachment'));
      }
      const filename = item['originalFilename'];
      const contentType = item['contentType'];
      const size = item['byteSize'];
      return {
        id,
        originalFilename: typeof filename === 'string' && filename !== '' ? filename : null,
        contentType: typeof contentType === 'string' && contentType !== '' ? contentType : null,
        byteSize:
          typeof size === 'string'
            ? size
            : typeof size === 'number' || typeof size === 'bigint'
              ? String(size)
              : null,
      };
    });
  }

  #parse(value: string): unknown {
    try {
      return JSON.parse(value);
    } catch (error) {
      this.logger.error('A support attachment aggregate could not be parsed.');
      throw new SupportConsoleUnavailableError(error);
    }
  }

  #required(value: string | null, field: string): string {
    if (value === null) {
      this.logger.error(`A support console row came back without its ${field}.`);
      throw new SupportConsoleUnavailableError(new Error('incomplete row'));
    }
    return value;
  }

  #requiredDate(value: Date | string | null): Date | string {
    if (value === null) {
      this.logger.error('A support console row came back without its creation time.');
      throw new SupportConsoleUnavailableError(new Error('incomplete row'));
    }
    return value;
  }

  #count(value: number | null): number {
    if (value === null || !Number.isSafeInteger(value) || value < 0) {
      this.logger.error('A support console row came back with an unreadable count.');
      throw new SupportConsoleUnavailableError(new Error('unreadable count'));
    }
    return value;
  }
}
