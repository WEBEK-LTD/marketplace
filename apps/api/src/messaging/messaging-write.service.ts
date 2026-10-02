import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  FileMessagingReportRequest,
  MessageItem,
  MessageReferenceType,
  MessageType,
  StartConversationRequest,
} from '@repo/contracts';
import { hashIdentifier } from '../auth/subject-hash.js';
import {
  ConversationClosedError,
  ConversationNotAccessibleError,
  MessagingBlockedError,
  MessagingUnavailableError,
  ReportTargetNotAccessibleError,
  SellerNotContactableError,
} from './messaging-errors.js';
import { MessagingThrottleService } from './messaging-throttle.service.js';
import type { MessageRow } from './messaging.service.js';

/** The six write operations of migration 0054, and nothing else. */
export interface MessagingWriteStore {
  messagingStartConversation(input: {
    userId: string;
    subjectType: 'listing' | 'direct';
    listingId: string | null;
    sellerSlug: string | null;
  }): Promise<{ outcome: string; conversationId: string | null }>;

  messagingSendMessage(input: {
    userId: string;
    conversationId: string;
    body: string;
  }): Promise<{ outcome: string; messageId: string | null; seq: string | null }>;

  messagingFileReport(input: {
    userId: string;
    subjectType: 'message' | 'conversation';
    subjectId: string;
    reasonCode: string;
  }): Promise<{ outcome: string; reportId: string | null }>;

  messagingMarkRead(input: {
    userId: string;
    conversationId: string;
    seq: string;
  }): Promise<{ outcome: string; lastReadSeq: string | null }>;

  messagingSetMuted(input: {
    userId: string;
    conversationId: string;
    isMuted: boolean;
  }): Promise<{ outcome: string; isMuted: boolean | null }>;

  messagingLeaveConversation(input: { userId: string; conversationId: string }): Promise<{ outcome: string }>;

  messagingCloseConversation(input: {
    userId: string;
    conversationId: string;
  }): Promise<{ outcome: string; closedAt: Date | null }>;

  /** Reads back the message that was just written, so a surface renders what committed. */
  messagingConversationMessages(input: {
    userId: string;
    conversationId: string;
    limit: number;
    cursorSeq: string | null;
  }): Promise<readonly MessageRow[]>;
}

export const MESSAGING_WRITE_STORE = Symbol('MESSAGING_WRITE_STORE');

export interface StartedConversation {
  readonly outcome: 'created' | 'reused';
  readonly conversationId: string;
}

/**
 * Messaging writes (Phase 5-E).
 *
 * Every rule this service appears to apply is actually migration 0054's, reported back as an outcome
 * string; this layer turns those outcomes into the approved errors and nothing more. There is no
 * authorization decision here, no block check, no closed check and no body-length check that the database
 * does not also make — which is what keeps two copies of a rule from drifting apart.
 *
 * **The caller is never named by a request.** `userId` is the account the API resolved from the caller's
 * own access token. No method below takes an identifier from anywhere else, so there is no way to send as,
 * mute, leave or close on behalf of somebody else.
 *
 * **Rate limits run before the database is touched**, so a flood costs a counter round trip rather than a
 * transaction, and they fail closed: an unreadable counter refuses the request.
 *
 * **Nothing is notified.** A send establishes the message and the outbox event 0014 writes with it, and
 * stops there. Durable notifications are a later increment, and creating one here would be a side effect
 * nobody approved.
 */
@Injectable()
export class MessagingWriteService {
  private readonly logger = new Logger(MessagingWriteService.name);

  constructor(
    @Inject(MESSAGING_WRITE_STORE) private readonly store: MessagingWriteStore,
    private readonly throttle: MessagingThrottleService,
  ) {}

  /** Starts a conversation, or resolves to the open one that already exists. Both are success. */
  async startConversation(userId: string, request: StartConversationRequest): Promise<StartedConversation> {
    await this.throttle.assertCanStartConversation(hashIdentifier(userId));

    let result: Awaited<ReturnType<MessagingWriteStore['messagingStartConversation']>>;
    try {
      result = await this.store.messagingStartConversation({
        userId,
        subjectType: request.subjectType,
        listingId: request.subjectType === 'listing' ? request.listingId : null,
        sellerSlug: request.subjectType === 'direct' ? request.sellerSlug : null,
      });
    } catch (error) {
      this.logger.error('A conversation could not be started.');
      throw new MessagingUnavailableError(error);
    }

    if (result.outcome === 'blocked') throw new MessagingBlockedError();
    if (result.outcome === 'not_contactable') throw new SellerNotContactableError();
    // `invalid` means the request described something this path does not create — a subject type with no
    // domain yet, a listing entry with no listing. It is refused as a not-found rather than described,
    // because describing it would be describing a surface that does not exist.
    if (result.outcome === 'invalid' || result.conversationId === null) {
      throw new ConversationNotAccessibleError();
    }
    if (result.outcome !== 'created' && result.outcome !== 'reused') {
      this.logger.error('Starting a conversation returned an outcome this service does not understand.');
      throw new MessagingUnavailableError(new Error('unexpected outcome'));
    }

    return { outcome: result.outcome, conversationId: result.conversationId };
  }

  /**
   * Sends one text message and returns it as stored.
   *
   * The message is read back rather than assembled from the request, so a surface renders exactly what
   * committed — the real id, the real `seq`, the real timestamp — and never a shape this layer imagined.
   */
  async sendMessage(userId: string, conversationId: string, body: string): Promise<MessageItem> {
    await this.throttle.assertCanSendMessage(hashIdentifier(userId));

    let result: Awaited<ReturnType<MessagingWriteStore['messagingSendMessage']>>;
    try {
      result = await this.store.messagingSendMessage({ userId, conversationId, body });
    } catch (error) {
      this.logger.error('A message could not be sent.');
      throw new MessagingUnavailableError(error);
    }

    if (result.outcome === 'not_found') throw new ConversationNotAccessibleError();
    if (result.outcome === 'closed') throw new ConversationClosedError();
    if (result.outcome === 'blocked') throw new MessagingBlockedError();
    // The contract already refused an empty or oversized body, so reaching here means the body was
    // whitespace: non-empty to a length check and empty to the database.
    if (result.outcome === 'invalid_body') throw new InvalidMessageBodyError();
    if (result.outcome !== 'sent' || result.messageId === null || result.seq === null) {
      this.logger.error('Sending a message returned an outcome this service does not understand.');
      throw new MessagingUnavailableError(new Error('unexpected outcome'));
    }

    return await this.#readBack(userId, conversationId, result.messageId, result.seq);
  }

  /** Moves the caller's own read marker forward. Returns where it now stands. */
  async markRead(userId: string, conversationId: string, seq: string): Promise<string | null> {
    let result: Awaited<ReturnType<MessagingWriteStore['messagingMarkRead']>>;
    try {
      result = await this.store.messagingMarkRead({ userId, conversationId, seq });
    } catch (error) {
      this.logger.error('A read marker could not be moved.');
      throw new MessagingUnavailableError(error);
    }

    if (result.outcome !== 'ok') throw new ConversationNotAccessibleError();
    return result.lastReadSeq;
  }

  /** Sets the caller's own mute flag. */
  async setMuted(userId: string, conversationId: string, isMuted: boolean): Promise<boolean> {
    let result: Awaited<ReturnType<MessagingWriteStore['messagingSetMuted']>>;
    try {
      result = await this.store.messagingSetMuted({ userId, conversationId, isMuted });
    } catch (error) {
      this.logger.error('A mute state could not be set.');
      throw new MessagingUnavailableError(error);
    }

    if (result.outcome !== 'ok' || result.isMuted === null) throw new ConversationNotAccessibleError();
    return result.isMuted;
  }

  /** The caller leaves their own membership. Idempotent. */
  async leaveConversation(userId: string, conversationId: string): Promise<void> {
    let result: { outcome: string };
    try {
      result = await this.store.messagingLeaveConversation({ userId, conversationId });
    } catch (error) {
      this.logger.error('A conversation could not be left.');
      throw new MessagingUnavailableError(error);
    }

    if (result.outcome !== 'left') throw new ConversationNotAccessibleError();
  }

  /** Closes the conversation. Idempotent: an already-closed one reports when it was closed. */
  async closeConversation(userId: string, conversationId: string): Promise<Date> {
    let result: Awaited<ReturnType<MessagingWriteStore['messagingCloseConversation']>>;
    try {
      result = await this.store.messagingCloseConversation({ userId, conversationId });
    } catch (error) {
      this.logger.error('A conversation could not be closed.');
      throw new MessagingUnavailableError(error);
    }

    if (result.outcome !== 'closed' || result.closedAt === null) throw new ConversationNotAccessibleError();
    return result.closedAt;
  }

  /**
   * Files a report about a message or a conversation the caller can read (Phase 5-H).
   *
   * Rate-limited before anything is read, on the same two counters every other messaging limit uses. The
   * reporter is the `userId` established from the session; the request carries no actor field at all.
   *
   * A repeat lands on the report already open and returns its id, which is 0027's own C10 behaviour and
   * not something re-implemented here — so there is one outcome rather than a created/reused pair.
   */
  async fileReport(userId: string, request: FileMessagingReportRequest): Promise<string> {
    await this.throttle.assertCanFileReport(hashIdentifier(userId));

    let result: Awaited<ReturnType<MessagingWriteStore['messagingFileReport']>>;
    try {
      result = await this.store.messagingFileReport({
        userId,
        subjectType: request.subjectType,
        subjectId: request.subjectId,
        reasonCode: request.reasonCode,
      });
    } catch (error) {
      this.logger.error('A report could not be filed.');
      throw new MessagingUnavailableError(error);
    }

    // `not_found` and `invalid` are one answer to the caller. `invalid` means a subject type this path
    // does not own, which the contract has already refused, so it cannot be reached from the API — and
    // describing it separately would be describing a surface that is not there.
    if (result.outcome !== 'filed' || result.reportId === null) {
      throw new ReportTargetNotAccessibleError();
    }
    return result.reportId;
  }

  /** Reads the one message that was just written, through the same reader every surface uses. */
  async #readBack(
    userId: string,
    conversationId: string,
    messageId: string,
    seq: string,
  ): Promise<MessageItem> {
    let rows: readonly MessageRow[];
    try {
      rows = await this.store.messagingConversationMessages({
        userId,
        conversationId,
        limit: 1,
        cursorSeq: null,
      });
    } catch (error) {
      this.logger.error('A sent message could not be read back.');
      throw new MessagingUnavailableError(error);
    }

    const row = rows.find((candidate) => candidate.id === messageId);
    if (row === undefined) {
      // The message committed but the read-back did not find it. Reporting success with an invented body
      // would be worse than reporting a failure the caller can retry into an idempotent-looking state.
      this.logger.error('A sent message was not found by the reader that should own it.');
      throw new MessagingUnavailableError(new Error('sent message not readable'));
    }

    return {
      id: row.id,
      seq: String(row.seq ?? seq),
      conversationId: row.conversationId,
      senderUserId: row.senderUserId,
      isOwnMessage: row.isOwnMessage,
      messageType: row.messageType as MessageType,
      body: row.body,
      referenceType: row.referenceType as MessageReferenceType | null,
      referenceId: row.referenceId,
      createdAt: row.createdAt.toISOString(),
      editedAt: row.editedAt === null ? null : row.editedAt.toISOString(),
      deletedAt: row.deletedAt === null ? null : row.deletedAt.toISOString(),
    };
  }
}

/**
 * A body the database refused after trimming (Phase 5-E).
 *
 * The contract catches an empty or oversized body before the request is accepted, so this is the narrow
 * case the schema cannot see: a body of nothing but whitespace, which is non-empty to a length check and
 * empty to the database.
 */
export class InvalidMessageBodyError extends Error {
  readonly problem = { status: 400, code: 'VALIDATION_FAILED' } as const;

  constructor() {
    super('The message is invalid.');
    this.name = 'InvalidMessageBodyError';
  }
}
