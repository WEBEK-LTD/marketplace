import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  OpenSupportTicketResponse,
  SupportAttachment,
  SupportAttachmentLinkResponse,
  SupportAttachmentRecordResponse,
  SupportAttachmentUploadResponse,
  SupportMessage,
  SupportMessageAuthorRole,
  SupportMessageMutationResponse,
  SupportTicketCategory,
  SupportTicketClosureResponse,
  SupportTicketDetail,
  SupportTicketStatus,
  SupportTicketSummary,
} from '@repo/contracts';
import { hashIdentifier } from '../auth/subject-hash.js';
import {
  SELLER_MEDIA_STORAGE,
  SellerMediaStorageUnavailableError,
  type SellerMediaStoragePort,
} from '../sellers/seller-media.storage.js';
import { SellerThrottleService } from '../sellers/seller-throttle.service.js';
import { SupportThrottleService } from './support-throttle.service.js';
import {
  SupportAttachmentObjectMissingError,
  SupportCursorInvalidError,
  SupportInvalidError,
  SupportNotFoundError,
  SupportTicketNotActionableError,
  SupportUnavailableError,
} from './support.errors.js';
import {
  decodeSupportMessagesCursor,
  decodeSupportTicketsCursor,
  encodeSupportMessagesCursor,
  encodeSupportTicketsCursor,
} from './support-cursor.js';

/**
 * Support — the requester side (Phase 7-K).
 *
 * **Every rule this surface appears to apply is applied in the database.** Whether a ticket is the
 * caller's, whether a message is one they wrote, whether an attachment belongs to the ticket in the route,
 * whether the ticket still takes writes, what a subject or a body may contain, which status a reply leaves
 * behind, and where an uploaded file may go — all of it is decided inside a SECURITY DEFINER function in
 * migration 0074, which in turn calls 0028's own writers for every row it creates. This service passes the
 * caller's own account, translates the outcome into the approved error, and **checks nothing a second
 * time**: a second copy of an authorization rule is how two copies start to disagree, and here the second
 * copy would be the one without the row lock.
 *
 * **No method takes a party, a role, a status, a priority or an author.** The caller's account arrives from
 * their own token through {@link CurrentUserService}; the operations are named transitions; and there is no
 * parameter anywhere in this file through which a caller could name somebody else or claim a side.
 *
 * **A refusal and an absence are the same answer.** A ticket belonging to another account, an agent's
 * message on the caller's own ticket, an attachment of a different ticket and an identifier that names
 * nothing all arrive as `not_found` and all become one {@link SupportNotFoundError}. There is no branch
 * here that could tell them apart, so there is none that could leak the difference.
 *
 * **Internal notes are not representable.** No method reads them, no row shape carries them and the
 * contract has no schema for one — three independent reasons, on top of the table having no requester read
 * path at all.
 *
 * **No notification and no email.** The repository defines no support notification event type, template key
 * or writer, and 7-D owns transport. Nothing here calls either, and nothing here invents a sentence to put
 * in one.
 *
 * **The three write surfaces are rate limited; the reads are not** (owner Decision 1). Opening a ticket and
 * posting a message count against {@link SupportThrottleService}'s own buckets, and authorizing an
 * attachment upload counts against **6-E's existing storage limiter** rather than a second storage-specific
 * one. Every count happens *before* the operation, so a refused request still counts and a burst cannot be
 * spent by racing; and the subject is always `hashIdentifier(userId)` of the account the provider vouched
 * for, so no value from a browser decides which counter a request lands in.
 *
 * **Nothing here logs a value.** A ticket is somebody's problem in their own words and an attachment is
 * their file. The log lines below carry a sentence and no identifier, no body, no file name, no object path
 * and no signed URL.
 */

/** 0012's private bucket. The one bucket name this surface knows, and it is never taken from a request. */
const SUPPORT_BUCKET = 'support-attachments';

/** One row of `app_private.support_tickets_for_requester`. */
export interface SupportTicketRow {
  readonly id: string;
  readonly reference: string | null;
  readonly subject: string | null;
  readonly category: string | null;
  readonly status: string | null;
  readonly messageCount: number | null;
  readonly attachmentCount: number | null;
  readonly lastMessageAt: Date | string | null;
  readonly resolvedAt: Date | string | null;
  readonly closedAt: Date | string | null;
  readonly createdAt: Date | string | null;
}

/** One row of `app_private.support_ticket_for_requester`. */
export interface SupportTicketDetailRow {
  readonly outcome: string;
  readonly id: string | null;
  readonly reference: string | null;
  readonly subject: string | null;
  readonly category: string | null;
  readonly status: string | null;
  readonly messageCount: number | null;
  readonly lastMessageAt: Date | string | null;
  readonly resolvedAt: Date | string | null;
  readonly closedAt: Date | string | null;
  readonly createdAt: Date | string | null;
}

/** One row of `app_private.support_ticket_messages_for_requester`. */
export interface SupportMessageRow {
  readonly id: string;
  readonly authorRole: string | null;
  readonly isOwnMessage: boolean | null;
  readonly body: string | null;
  readonly createdAt: Date | string | null;
  readonly attachments: unknown;
}

export interface SupportTicketOpenRow {
  readonly outcome: string;
  readonly ticketId: string | null;
  readonly messageId: string | null;
  readonly reference: string | null;
  readonly status: string | null;
}

export interface SupportMessagePostRow {
  readonly outcome: string;
  readonly messageId: string | null;
  readonly status: string | null;
}

export interface SupportTicketClosureRow {
  readonly outcome: string;
  readonly status: string | null;
}

export interface SupportAttachmentTargetRow {
  readonly outcome: string;
  readonly bucketId: string | null;
  readonly objectPath: string | null;
  readonly maxByteSize: string | number | bigint | null;
}

export interface SupportAttachmentRecordRow {
  readonly outcome: string;
  readonly attachmentId: string | null;
  readonly attachmentCount: number | null;
}

export interface SupportAttachmentLocationRow {
  readonly outcome: string;
  readonly bucketId: string | null;
  readonly objectPath: string | null;
}

export interface SupportStore {
  /** `app_private.support_tickets_for_requester(...)` (0074). */
  supportTicketsForRequester(input: {
    userId: string;
    limit: number;
    cursorCreatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly SupportTicketRow[]>;
  /** `app_private.support_ticket_for_requester(uuid, uuid)` (0074). */
  supportTicketForRequester(input: {
    userId: string;
    ticketId: string;
  }): Promise<SupportTicketDetailRow>;
  /** `app_private.support_ticket_messages_for_requester(...)` (0074). */
  supportTicketMessagesForRequester(input: {
    userId: string;
    ticketId: string;
    limit: number;
    cursorCreatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly SupportMessageRow[]>;
  /** `app_private.support_ticket_open_for_requester(...)` (0074). */
  supportTicketOpenForRequester(input: {
    userId: string;
    subject: string;
    category: string;
    body: string;
  }): Promise<SupportTicketOpenRow>;
  /** `app_private.support_message_post_for_requester(...)` (0074). */
  supportMessagePostForRequester(input: {
    userId: string;
    ticketId: string;
    body: string;
  }): Promise<SupportMessagePostRow>;
  /** `app_private.support_ticket_close_for_requester(uuid, uuid)` (0074). */
  supportTicketCloseForRequester(input: {
    userId: string;
    ticketId: string;
  }): Promise<SupportTicketClosureRow>;
  /** `app_private.support_attachment_target_for_requester(...)` (0074). */
  supportAttachmentTargetForRequester(input: {
    userId: string;
    ticketId: string;
    messageId: string;
    contentType: string;
    byteSize: number;
  }): Promise<SupportAttachmentTargetRow>;
  /** `app_private.support_attachment_attach_for_requester(...)` (0074). */
  supportAttachmentAttachForRequester(input: {
    userId: string;
    ticketId: string;
    messageId: string;
    objectPath: string;
    originalFilename: string;
    contentType: string;
    byteSize: number;
  }): Promise<SupportAttachmentRecordRow>;
  /** `app_private.support_attachment_for_requester(uuid, uuid, uuid)` (0074). */
  supportAttachmentForRequester(input: {
    userId: string;
    ticketId: string;
    attachmentId: string;
  }): Promise<SupportAttachmentLocationRow>;
}

export const SUPPORT_STORE = Symbol('SUPPORT_STORE');

export interface SupportTicketsPage {
  readonly items: SupportTicketSummary[];
  readonly nextCursor: string | null;
}

export interface SupportMessagesPage {
  readonly items: SupportMessage[];
  readonly nextCursor: string | null;
}

/** ISO-8601 for a timestamp the driver may hand back as a `Date` or a string, or null. */
function toIsoOrNull(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** A `bigint` byte size as the decimal string the contract carries. */
function byteSize(value: string | number | bigint | null): string | null {
  if (value === null) return null;
  return typeof value === 'string' ? value : String(value);
}

@Injectable()
export class SupportService {
  private readonly logger = new Logger(SupportService.name);

  constructor(
    @Inject(SUPPORT_STORE) private readonly store: SupportStore,
    // The same port 6-E defined, 6-I reused and 7-G extended. There is no second storage client anywhere
    // in this repository and this surface does not introduce one.
    @Inject(SELLER_MEDIA_STORAGE) private readonly storage: SellerMediaStoragePort,
    private readonly throttle: SupportThrottleService,
    // 6-E's own limiter, injected rather than reimplemented: owner Decision 1 puts the attachment
    // authorization on the existing storage/upload allowance rather than on a second storage-specific one.
    private readonly storageThrottle: SellerThrottleService,
  ) {}

  /**
   * One page of the caller's own tickets.
   *
   * The page is read one row longer than asked for. If that extra row exists there is more to come, and the
   * cursor is built from the last row the caller actually receives — so `nextCursor` is null exactly when
   * the page is the last one, rather than one request later.
   */
  async tickets(input: {
    userId: string;
    limit: number;
    cursor: string | null;
  }): Promise<SupportTicketsPage> {
    let position: { createdAt: Date; id: string } | null = null;
    if (input.cursor !== null) {
      position = decodeSupportTicketsCursor(input.cursor);
      if (position === null) throw new SupportCursorInvalidError();
    }

    let rows: readonly SupportTicketRow[];
    try {
      rows = await this.store.supportTicketsForRequester({
        userId: input.userId,
        limit: input.limit + 1,
        cursorCreatedAt: position?.createdAt ?? null,
        cursorId: position?.id ?? null,
      });
    } catch (error) {
      this.logger.error('A support ticket list could not be read.');
      throw new SupportUnavailableError(error);
    }

    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    const last = page.at(-1);
    return {
      items: page.map((row) => this.#summary(row)),
      nextCursor:
        hasMore && last !== undefined && last.createdAt !== null
          ? encodeSupportTicketsCursor({
              createdAt: last.createdAt instanceof Date ? last.createdAt : new Date(last.createdAt),
              id: last.id,
            })
          : null,
    };
  }

  /** One ticket, for the account that raised it. */
  async ticket(input: { userId: string; ticketId: string }): Promise<SupportTicketDetail> {
    let row: SupportTicketDetailRow;
    try {
      row = await this.store.supportTicketForRequester(input);
    } catch (error) {
      this.logger.error('A support ticket could not be read.');
      throw new SupportUnavailableError(error);
    }

    if (row.outcome === 'not_found') throw new SupportNotFoundError();
    if (row.outcome !== 'found') {
      this.logger.error('A support ticket read returned an outcome this service does not understand.');
      throw new SupportUnavailableError(new Error('unexpected outcome'));
    }
    if (
      row.id === null ||
      row.subject === null ||
      row.category === null ||
      row.status === null ||
      row.messageCount === null ||
      row.createdAt === null
    ) {
      this.logger.error('A support ticket came back incomplete.');
      throw new SupportUnavailableError(new Error('incomplete support ticket'));
    }

    return {
      id: row.id,
      reference: row.reference,
      subject: row.subject,
      category: row.category as SupportTicketCategory,
      status: row.status as SupportTicketStatus,
      messageCount: row.messageCount,
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
   * the "extra row" trick works from the other end: the extra row is the *oldest* one, and the cursor is
   * built from the oldest row the caller keeps.
   *
   * An empty first page is the one ambiguous case, and it is resolved in favour of saying nothing: a caller
   * who may not read the ticket and a caller asking about a ticket that does not exist both get
   * {@link SupportNotFoundError}. A ticket genuinely without messages cannot exist — 0028's writer posts the
   * first one in the same transaction as the ticket — so nothing legitimate is lost.
   */
  async messages(input: {
    userId: string;
    ticketId: string;
    limit: number;
    cursor: string | null;
  }): Promise<SupportMessagesPage> {
    let position: { createdAt: Date; id: string } | null = null;
    if (input.cursor !== null) {
      position = decodeSupportMessagesCursor(input.cursor);
      if (position === null) throw new SupportCursorInvalidError();
    }

    let rows: readonly SupportMessageRow[];
    try {
      rows = await this.store.supportTicketMessagesForRequester({
        userId: input.userId,
        ticketId: input.ticketId,
        limit: input.limit + 1,
        cursorCreatedAt: position?.createdAt ?? null,
        cursorId: position?.id ?? null,
      });
    } catch (error) {
      this.logger.error('A support conversation could not be read.');
      throw new SupportUnavailableError(error);
    }

    if (rows.length === 0 && position === null) throw new SupportNotFoundError();

    const hasMore = rows.length > input.limit;
    // Rows arrive oldest-first, so the row beyond the page is the oldest of them.
    const page = hasMore ? rows.slice(rows.length - input.limit) : rows;
    const oldest = page.at(0);
    return {
      items: page.map((row) => this.#message(row)),
      nextCursor:
        hasMore && oldest !== undefined && oldest.createdAt !== null
          ? encodeSupportMessagesCursor({
              createdAt:
                oldest.createdAt instanceof Date ? oldest.createdAt : new Date(oldest.createdAt),
              id: oldest.id,
            })
          : null,
    };
  }

  /** Opens one ticket with its first message. */
  async open(input: {
    userId: string;
    subject: string;
    category: string;
    body: string;
  }): Promise<OpenSupportTicketResponse> {
    // Counted first, so a refused write still counts and no burst can be spent by racing the database.
    await this.throttle.assertCanOpenTicket(hashIdentifier(input.userId));

    let row: SupportTicketOpenRow;
    try {
      row = await this.store.supportTicketOpenForRequester(input);
    } catch (error) {
      this.logger.error('A support ticket could not be opened.');
      throw new SupportUnavailableError(error);
    }

    if (row.outcome === 'invalid') throw new SupportInvalidError();
    if (row.outcome !== 'created') {
      this.logger.error('Opening a support ticket returned an outcome this service does not understand.');
      throw new SupportUnavailableError(new Error('unexpected outcome'));
    }
    if (row.ticketId === null || row.messageId === null || row.status === null) {
      this.logger.error('An opened support ticket came back incomplete.');
      throw new SupportUnavailableError(new Error('incomplete support ticket write'));
    }

    return {
      ticketId: row.ticketId,
      messageId: row.messageId,
      reference: row.reference,
      status: row.status as SupportTicketStatus,
    };
  }

  /** Adds one requester message to a ticket that account raised. */
  async reply(input: {
    userId: string;
    ticketId: string;
    body: string;
  }): Promise<SupportMessageMutationResponse> {
    await this.throttle.assertCanPostMessage(hashIdentifier(input.userId));

    let row: SupportMessagePostRow;
    try {
      row = await this.store.supportMessagePostForRequester(input);
    } catch (error) {
      this.logger.error('A support message could not be posted.');
      throw new SupportUnavailableError(error);
    }

    if (row.outcome === 'posted') {
      if (row.messageId === null || row.status === null) {
        this.logger.error('A posted support message came back incomplete.');
        throw new SupportUnavailableError(new Error('incomplete support message write'));
      }
      return { messageId: row.messageId, status: row.status as SupportTicketStatus };
    }
    this.#refusal(row.outcome);
  }

  /**
   * Closes a ticket the caller raised.
   *
   * There is no status in the signature and none in the request that reaches it: the operation names the
   * transition and the database passes the literal to 0028's writer.
   */
  async close(input: { userId: string; ticketId: string }): Promise<SupportTicketClosureResponse> {
    let row: SupportTicketClosureRow;
    try {
      row = await this.store.supportTicketCloseForRequester(input);
    } catch (error) {
      this.logger.error('A support ticket could not be closed.');
      throw new SupportUnavailableError(error);
    }

    if (row.outcome === 'closed') {
      if (row.status === null) {
        this.logger.error('A closed support ticket came back without its status.');
        throw new SupportUnavailableError(new Error('incomplete support closure'));
      }
      return { status: row.status as SupportTicketStatus };
    }
    this.#refusal(row.outcome);
  }

  /**
   * Authorizes one attachment upload and signs it.
   *
   * The database decides whether this account may attach anything to that message of that ticket and *what
   * the object path is*; this method forwards the outcome and hands the returned bucket and path to the
   * storage port. It composes no path and validates no limit a second time.
   */
  async authorizeAttachment(input: {
    userId: string;
    ticketId: string;
    messageId: string;
    contentType: string;
    byteSize: number;
  }): Promise<SupportAttachmentUploadResponse> {
    // 6-E's allowance for signed upload authorizations, by owner Decision 1: each one asks the storage
    // provider to sign something, which is the resource being protected, and it is protected by one counter
    // rather than by a second limiter that would have to agree with it.
    await this.storageThrottle.assertCanUploadMedia(hashIdentifier(input.userId));

    let target: SupportAttachmentTargetRow;
    try {
      target = await this.store.supportAttachmentTargetForRequester(input);
    } catch (error) {
      this.logger.error('A support attachment upload could not be authorized.');
      throw new SupportUnavailableError(error);
    }

    if (target.outcome !== 'authorized') this.#refusal(target.outcome);
    if (target.bucketId === null || target.objectPath === null || target.maxByteSize === null) {
      this.logger.error('An authorized support upload came back without its target.');
      throw new SupportUnavailableError(new Error('incomplete upload target'));
    }

    // Only now does anything leave this process for the provider, with a path the database composed.
    let signed: Awaited<ReturnType<SellerMediaStoragePort['signUpload']>>;
    try {
      signed = await this.storage.signUpload(target.bucketId, target.objectPath, input.contentType);
    } catch (error) {
      if (!(error instanceof SellerMediaStorageUnavailableError)) {
        this.logger.error('Signing a support attachment upload failed.');
      }
      throw new SupportUnavailableError(error);
    }

    const maximum = Number(target.maxByteSize);
    if (!Number.isSafeInteger(maximum) || maximum <= 0) {
      this.logger.error('A support upload target came back with an unreadable ceiling.');
      throw new SupportUnavailableError(new Error('unreadable max byte size'));
    }

    return {
      upload: {
        uploadUrl: signed.uploadUrl,
        objectPath: target.objectPath,
        expiresAt: signed.expiresAt.toISOString(),
        maxByteSize: maximum,
      },
    };
  }

  /**
   * Records an upload that happened.
   *
   * Storage is asked first, exactly as 6-E and 6-I do it: a path outside the caller's own namespace is
   * refused by the database below whatever storage says, and asking storage first means a confirmation for
   * a file nobody uploaded never reaches a write — a ticket showing a file an agent cannot open is the
   * state that wastes their time.
   */
  async recordAttachment(input: {
    userId: string;
    ticketId: string;
    messageId: string;
    objectPath: string;
    originalFilename: string;
    contentType: string;
    byteSize: number;
  }): Promise<SupportAttachmentRecordResponse> {
    let exists: boolean;
    try {
      exists = await this.storage.objectExists(SUPPORT_BUCKET, input.objectPath);
    } catch (error) {
      if (!(error instanceof SellerMediaStorageUnavailableError)) {
        this.logger.error('A support attachment could not be checked with storage.');
      }
      throw new SupportUnavailableError(error);
    }
    if (!exists) throw new SupportAttachmentObjectMissingError();

    let row: SupportAttachmentRecordRow;
    try {
      row = await this.store.supportAttachmentAttachForRequester(input);
    } catch (error) {
      this.logger.error('A support attachment could not be recorded.');
      throw new SupportUnavailableError(error);
    }

    if (row.outcome === 'attached') {
      if (row.attachmentId === null || row.attachmentCount === null) {
        this.logger.error('A recorded support attachment came back incomplete.');
        throw new SupportUnavailableError(new Error('incomplete attachment write'));
      }
      return { attachmentId: row.attachmentId, attachmentCount: row.attachmentCount };
    }
    this.#refusal(row.outcome);
  }

  /**
   * A short-lived authorization to look at one file.
   *
   * **The caller names an attachment; the path comes from the row.** Nothing in this method's signature can
   * carry a path, and the only value that reaches the provider is `row.objectPath`, which the database
   * composed — and which it returns only when the attachment, its message's ticket and the ticket in the
   * route all agree.
   */
  async attachmentLink(input: {
    userId: string;
    ticketId: string;
    attachmentId: string;
  }): Promise<SupportAttachmentLinkResponse> {
    let row: SupportAttachmentLocationRow;
    try {
      row = await this.store.supportAttachmentForRequester(input);
    } catch (error) {
      this.logger.error('A support attachment could not be located.');
      throw new SupportUnavailableError(error);
    }

    if (row.outcome !== 'authorized') throw new SupportNotFoundError();
    if (row.bucketId === null || row.objectPath === null) {
      this.logger.error('An authorized support attachment came back without its location.');
      throw new SupportUnavailableError(new Error('incomplete attachment location'));
    }

    let signed: Awaited<ReturnType<SellerMediaStoragePort['signDownload']>>;
    try {
      signed = await this.storage.signDownload(row.bucketId, row.objectPath);
    } catch (error) {
      if (!(error instanceof SellerMediaStorageUnavailableError)) {
        this.logger.error('Signing a support attachment read failed.');
      }
      throw new SupportUnavailableError(error);
    }

    return {
      attachmentId: input.attachmentId,
      url: signed.url,
      expiresAt: signed.expiresAt.toISOString(),
    };
  }

  /* ------------------------------------------------------------------------------------------------ */

  /**
   * The one place an outcome that is not a success becomes an error.
   *
   * `not_found` is absence and the wrong caller at once; `conflict` is the closed ticket; `invalid` is the
   * request. An outcome this service does not recognise is a disagreement with the database rather than
   * something to pass through, so it fails as unavailable.
   */
  #refusal(outcome: string): never {
    if (outcome === 'not_found') throw new SupportNotFoundError();
    if (outcome === 'conflict') throw new SupportTicketNotActionableError();
    if (outcome === 'invalid') throw new SupportInvalidError();
    this.logger.error('A support operation returned an outcome this service does not understand.');
    throw new SupportUnavailableError(new Error('unexpected outcome'));
  }

  #summary(row: SupportTicketRow): SupportTicketSummary {
    if (
      row.subject === null ||
      row.category === null ||
      row.status === null ||
      row.messageCount === null ||
      row.attachmentCount === null ||
      row.createdAt === null
    ) {
      this.logger.error('A support ticket row came back incomplete.');
      throw new SupportUnavailableError(new Error('incomplete support ticket row'));
    }
    return {
      id: row.id,
      reference: row.reference,
      subject: row.subject,
      category: row.category as SupportTicketCategory,
      status: row.status as SupportTicketStatus,
      messageCount: row.messageCount,
      attachmentCount: row.attachmentCount,
      lastMessageAt: toIsoOrNull(row.lastMessageAt),
      resolvedAt: toIsoOrNull(row.resolvedAt),
      closedAt: toIsoOrNull(row.closedAt),
      createdAt: toIso(row.createdAt),
    };
  }

  #message(row: SupportMessageRow): SupportMessage {
    if (
      row.authorRole === null ||
      row.isOwnMessage === null ||
      row.body === null ||
      row.createdAt === null
    ) {
      this.logger.error('A support message row came back incomplete.');
      throw new SupportUnavailableError(new Error('incomplete support message row'));
    }
    return {
      id: row.id,
      authorRole: row.authorRole as SupportMessageAuthorRole,
      isOwnMessage: row.isOwnMessage,
      body: row.body,
      createdAt: toIso(row.createdAt),
      attachments: this.#attachments(row.attachments),
    };
  }

  /**
   * The attachments a message carries, projected field by field out of the reader's aggregate.
   *
   * The aggregate is built in SQL, so it is validated here rather than trusted: a shape this method does not
   * recognise fails as unavailable instead of reaching a browser. **`objectPath` is not read**, because the
   * reader does not return one — and if a later change made it, this projection would still not carry it.
   */
  #attachments(value: unknown): SupportAttachment[] {
    if (value === null || value === undefined) return [];
    const raw = typeof value === 'string' ? this.#parse(value) : value;
    if (!Array.isArray(raw)) {
      this.logger.error('A support message carried attachments in a shape this service cannot read.');
      throw new SupportUnavailableError(new Error('unreadable attachments'));
    }

    return raw.map((entry) => {
      if (typeof entry !== 'object' || entry === null) {
        this.logger.error('A support attachment came back in a shape this service cannot read.');
        throw new SupportUnavailableError(new Error('unreadable attachment'));
      }
      const item = entry as Record<string, unknown>;
      const id = item['id'];
      if (typeof id !== 'string') {
        this.logger.error('A support attachment came back without an identifier.');
        throw new SupportUnavailableError(new Error('incomplete attachment'));
      }
      const filename = item['originalFilename'];
      const contentType = item['contentType'];
      const size = item['byteSize'];
      return {
        id,
        originalFilename: typeof filename === 'string' && filename !== '' ? filename : null,
        contentType: typeof contentType === 'string' && contentType !== '' ? contentType : null,
        byteSize:
          typeof size === 'string' || typeof size === 'number' || typeof size === 'bigint'
            ? byteSize(size)
            : null,
      };
    });
  }

  #parse(value: string): unknown {
    try {
      return JSON.parse(value);
    } catch (error) {
      this.logger.error('A support attachment aggregate could not be parsed.');
      throw new SupportUnavailableError(error);
    }
  }
}
