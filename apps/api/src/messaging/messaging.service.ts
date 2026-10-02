import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  ConversationMembershipState,
  ConversationSubjectType,
  InboxItem,
  MessageItem,
  MessageReferenceType,
  MessageType,
} from '@repo/contracts';
import {
  ConversationNotAccessibleError,
  InvalidMessagingCursorError,
  MessagingUnavailableError,
} from './messaging-errors.js';
import {
  decodeInboxCursor,
  decodeMessagesCursor,
  encodeInboxCursor,
  encodeMessagesCursor,
} from './messaging-cursor.js';

/**
 * One row of `app_private.messaging_inbox`, as the driver returns it.
 *
 * `bigint` columns arrive as strings, which is node-postgres's default and the right one: a `bigint`
 * does not fit a double, and the repository already carries bigint money the same way.
 */
export interface InboxRow {
  readonly conversationId: string;
  readonly subjectType: string;
  readonly listingId: string | null;
  readonly listingTitleSnapshot: string | null;
  readonly membershipState: string;
  readonly isMuted: boolean;
  readonly isClosed: boolean;
  readonly closedAt: Date | null;
  readonly unreadCount: string;
  readonly lastMessageId: string | null;
  readonly lastMessageSeq: string | null;
  readonly lastMessageAt: Date | null;
  readonly lastMessageType: string | null;
  readonly lastMessageBody: string | null;
  readonly lastMessageSenderUserId: string | null;
  readonly lastMessageDeletedAt: Date | null;
  readonly createdAt: Date;
}

/** One row of `app_private.messaging_conversation_messages`. */
export interface MessageRow {
  readonly id: string;
  readonly seq: string;
  readonly conversationId: string;
  readonly senderUserId: string | null;
  readonly isOwnMessage: boolean;
  readonly messageType: string;
  readonly body: string | null;
  readonly referenceType: string | null;
  readonly referenceId: string | null;
  readonly createdAt: Date;
  readonly editedAt: Date | null;
  readonly deletedAt: Date | null;
}

export interface MessagingStore {
  /** `app_private.messaging_inbox(uuid, integer, timestamptz, uuid)`. */
  messagingInbox(input: {
    userId: string;
    limit: number;
    cursorLastMessageAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly InboxRow[]>;

  /** `app_private.messaging_conversation_messages(uuid, uuid, integer, bigint)`. */
  messagingConversationMessages(input: {
    userId: string;
    conversationId: string;
    limit: number;
    cursorSeq: string | null;
  }): Promise<readonly MessageRow[]>;

  /** `app_private.messaging_unread_count(uuid)`. */
  messagingUnreadCount(userId: string): Promise<string>;
}

export const MESSAGING_STORE = Symbol('MESSAGING_STORE');

export interface InboxPage {
  readonly items: readonly InboxItem[];
  readonly nextCursor: string | null;
}

export interface MessagesPage {
  readonly items: readonly MessageItem[];
  readonly nextCursor: string | null;
}

/** ISO-8601 for a timestamp, or null. The only date formatting this service does. */
function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/**
 * A `bigint` count as a number, or a failure.
 *
 * Silently truncating would turn an impossible number into a plausible wrong one, so a value a double
 * cannot hold exactly is treated as a disagreement between this service and the reader rather than
 * rounded into the response.
 */
function count(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new MessagingUnavailableError(new Error('unreadable count'));
  }
  return parsed;
}

/**
 * Messaging reads (Phase 5-C).
 *
 * Every question this service answers is answered by migration 0053: which conversations the caller is
 * in, which messages they may read, how many they have not read, and whether a conversation is theirs
 * at all. None of it is re-decided here. This layer encodes and decodes the opaque cursor, converts
 * rows into the shared contract, and turns a database failure into the approved 503 — and that is the
 * whole of it.
 *
 * **The caller is never named by a request.** `userId` is always the value the API resolved from the
 * caller's own access token before this service was reached; no method here takes a user identifier
 * from anywhere else, and the readers enforce the relationship again on their side.
 *
 * **A refusal and an absence are the same answer.** A conversation the caller is not in returns no
 * rows, exactly as a conversation id that names nothing does, and this service turns both into one
 * {@link ConversationNotAccessibleError}. There is no branch here that could tell them apart, so there
 * is none that could leak the difference.
 */
@Injectable()
export class MessagingService {
  private readonly logger = new Logger(MessagingService.name);

  constructor(@Inject(MESSAGING_STORE) private readonly store: MessagingStore) {}

  /**
   * One page of the caller's inbox.
   *
   * The page is read one row longer than asked for. If that extra row exists there is more to come, and
   * the cursor is built from the last row the caller actually receives — so `nextCursor` is null exactly
   * when the page is the last one, rather than one request later.
   */
  async inbox(input: { userId: string; limit: number; cursor: string | null }): Promise<InboxPage> {
    let position: { lastMessageAt: Date | null; conversationId: string } | null = null;
    if (input.cursor !== null) {
      position = decodeInboxCursor(input.cursor);
      if (position === null) throw new InvalidMessagingCursorError();
    }

    let rows: readonly InboxRow[];
    try {
      rows = await this.store.messagingInbox({
        userId: input.userId,
        limit: input.limit + 1,
        cursorLastMessageAt: position?.lastMessageAt ?? null,
        cursorId: position?.conversationId ?? null,
      });
    } catch (error) {
      this.logger.error('An inbox could not be read.');
      throw new MessagingUnavailableError(error);
    }

    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    const last = page.at(-1);
    return {
      items: page.map((row) => this.toInboxItem(row)),
      nextCursor:
        hasMore && last !== undefined
          ? encodeInboxCursor({ lastMessageAt: last.lastMessageAt, conversationId: last.conversationId })
          : null,
    };
  }

  /**
   * One page of a conversation, oldest-first.
   *
   * The reader returns the page already in reading order, having chosen it newest-first from the cursor,
   * so the "extra row" trick works from the other end: the extra row is the *oldest* one, and the cursor
   * is built from the oldest row the caller keeps.
   *
   * An empty first page is the one ambiguous case, and it is resolved in favour of saying nothing: a
   * caller who may not read the conversation and a caller asking about a conversation that does not
   * exist both get {@link ConversationNotAccessibleError}. A participant whose conversation genuinely
   * has no messages is rare, and telling them apart would require asking a question whose answer is the
   * very thing being protected.
   */
  async messages(input: {
    userId: string;
    conversationId: string;
    limit: number;
    cursor: string | null;
  }): Promise<MessagesPage> {
    let position: { seq: string } | null = null;
    if (input.cursor !== null) {
      position = decodeMessagesCursor(input.cursor);
      if (position === null) throw new InvalidMessagingCursorError();
    }

    let rows: readonly MessageRow[];
    try {
      rows = await this.store.messagingConversationMessages({
        userId: input.userId,
        conversationId: input.conversationId,
        limit: input.limit + 1,
        cursorSeq: position?.seq ?? null,
      });
    } catch (error) {
      this.logger.error('A conversation could not be read.');
      throw new MessagingUnavailableError(error);
    }

    if (rows.length === 0 && position === null) throw new ConversationNotAccessibleError();

    const hasMore = rows.length > input.limit;
    // Rows arrive oldest-first, so the row beyond the page is the oldest of them.
    const page = hasMore ? rows.slice(rows.length - input.limit) : rows;
    const oldest = page.at(0);
    return {
      items: page.map((row) => this.toMessageItem(row)),
      nextCursor: hasMore && oldest !== undefined ? encodeMessagesCursor({ seq: oldest.seq }) : null,
    };
  }

  /** The caller's total unread count, straight from the reader. */
  async unreadCount(userId: string): Promise<number> {
    let value: string;
    try {
      value = await this.store.messagingUnreadCount(userId);
    } catch (error) {
      this.logger.error('An unread count could not be read.');
      throw new MessagingUnavailableError(error);
    }
    return count(value);
  }

  /**
   * Turns one inbox row into the contract.
   *
   * A vocabulary the contract does not know is a disagreement between this service and the database, not
   * something to pass through: it fails as unavailable rather than producing a row the caller cannot
   * validate.
   */
  private toInboxItem(row: InboxRow): InboxItem {
    return {
      conversationId: row.conversationId,
      subjectType: row.subjectType as ConversationSubjectType,
      listingId: row.listingId,
      listingTitleSnapshot: row.listingTitleSnapshot,
      membershipState: row.membershipState as ConversationMembershipState,
      isMuted: row.isMuted,
      isClosed: row.isClosed,
      closedAt: iso(row.closedAt),
      unreadCount: count(row.unreadCount),
      lastMessageId: row.lastMessageId,
      lastMessageSeq: row.lastMessageSeq,
      lastMessageAt: iso(row.lastMessageAt),
      lastMessageType: row.lastMessageType as MessageType | null,
      lastMessageBody: row.lastMessageBody,
      lastMessageSenderUserId: row.lastMessageSenderUserId,
      lastMessageDeletedAt: iso(row.lastMessageDeletedAt),
      createdAt: row.createdAt.toISOString(),
    };
  }

  private toMessageItem(row: MessageRow): MessageItem {
    return {
      id: row.id,
      seq: row.seq,
      conversationId: row.conversationId,
      senderUserId: row.senderUserId,
      isOwnMessage: row.isOwnMessage,
      messageType: row.messageType as MessageType,
      body: row.body,
      referenceType: row.referenceType as MessageReferenceType | null,
      referenceId: row.referenceId,
      createdAt: row.createdAt.toISOString(),
      editedAt: iso(row.editedAt),
      deletedAt: iso(row.deletedAt),
    };
  }
}
