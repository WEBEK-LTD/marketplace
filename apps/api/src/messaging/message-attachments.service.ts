import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  MESSAGE_ATTACHMENT_MAX_BYTES,
  type MessageAttachmentContentType,
  type MessageAttachmentLinkResponse,
  type MessageAttachmentRecordResponse,
  type MessageAttachmentUploadResponse,
  type ProblemCode,
} from '@repo/contracts';
import {
  SELLER_MEDIA_STORAGE,
  SellerMediaStorageUnavailableError,
  type SellerMediaStoragePort,
} from '../sellers/seller-media.storage.js';

/**
 * Conversation message attachments (0104).
 *
 * Three operations, and the middle one is the reason there are three.
 *
 *   1. **Authorize** — the database decides whether this caller may attach to this message and composes the
 *      object path; the storage provider signs an upload for exactly that path. **Nothing is recorded.**
 *   2. The client uploads. This service is not involved.
 *   3. **Confirm** — the storage provider is asked whether the object is actually there, and only then is the
 *      row written. A row that existed because an upload was *allowed* would be a row pointing at nothing, and
 *      no retry could fix it because the row would already exist.
 *
 * And a fourth, separate from all of them: **link**, which mints a short-lived signed read for one attachment
 * a participant may already see.
 *
 * **Every question of authority is the database's.** Whose message this is, whether the caller is still a live
 * participant, whether the pair is blocked, whether the message already holds five, whether the type and size
 * are permitted, and whether the path belongs to this message — all of it is decided inside migration 0104's
 * functions, and none of it is re-decided here. This layer turns named outcomes into the approved problems and
 * a storage failure into the approved 503, and that is the whole of it.
 *
 * **The path is never composed here and never accepted from a browser as a target.** `objectPath` crosses once
 * in each direction — out of the authorization and back into the confirmation — and the confirmation re-derives
 * the expected prefix in the database rather than trusting what came back. The signed read never takes a path
 * at all: it takes an attachment id, and the path comes out of the row.
 *
 * **Nothing here logs a path, a URL or a filename.** The way to keep one out of a log is to have no line that
 * could take it.
 */

/* ------------------------------------------------------------------------------------------------ */
/* Failures                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

/**
 * There is no such message, or no such attachment, for this caller.
 *
 * The same answer for a message that does not exist, one in a conversation the caller is not in, and one
 * belonging to the other party — 0104's predicates are scoped in the statement, so the three are genuinely
 * indistinguishable here and there is no branch that could tell them apart.
 */
export class MessageAttachmentNotFoundError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 404,
    code: 'NOT_FOUND',
  };

  constructor() {
    super('The requested resource was not found.');
    this.name = 'MessageAttachmentNotFoundError';
  }
}

/**
 * The pair is blocked.
 *
 * `MESSAGING_BLOCKED` already exists and already means this; no new code is introduced. A new attachment on an
 * existing message is new content reaching the other party, which is why this refusal exists at all: the
 * message-insert trigger cannot see it, because no message is being inserted.
 */
export class MessageAttachmentBlockedError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 409,
    code: 'MESSAGING_BLOCKED',
  };

  constructor() {
    super('This conversation cannot take new messages.');
    this.name = 'MessageAttachmentBlockedError';
  }
}

/** The message already holds as many attachments as it may. A limit, not a refusal of the caller. */
export class MessageAttachmentLimitReachedError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 409,
    code: 'MESSAGE_ATTACHMENT_LIMIT_REACHED',
  };

  constructor() {
    super('That message already has as many attachments as it can hold.');
    this.name = 'MessageAttachmentLimitReachedError';
  }
}

/**
 * The file is not one this platform will take, or the path did not belong to this message.
 *
 * One code for both, because the remedy differs only in a way the caller cannot act on: a client that sends a
 * path it was not given is a broken client, and telling it which check failed would describe the namespace.
 */
export class MessageAttachmentInvalidError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 400,
    code: 'VALIDATION_FAILED',
  };

  constructor() {
    super('That file could not be attached.');
    this.name = 'MessageAttachmentInvalidError';
  }
}

/**
 * The upload did not arrive.
 *
 * Its own refusal rather than a generic one, because this is the single most likely thing to go wrong in a
 * three-step flow and the remedy is specific: upload again. **Nothing is recorded** — which is the whole point
 * of confirming before writing.
 */
export class MessageAttachmentNotUploadedError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 409,
    code: 'MESSAGE_ATTACHMENT_OBJECT_MISSING',
  };

  constructor() {
    super('That file has not finished uploading.');
    this.name = 'MessageAttachmentNotUploadedError';
  }
}

/** The database or the storage provider could not be reached. Never rendered as "no attachments". */
export class MessageAttachmentUnavailableError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 503,
    code: 'SERVICE_UNAVAILABLE',
  };

  constructor(override readonly cause: unknown) {
    super('The service is temporarily unavailable.');
    this.name = 'MessageAttachmentUnavailableError';
  }
}

/* ------------------------------------------------------------------------------------------------ */
/* Rows                                                                                              */
/* ------------------------------------------------------------------------------------------------ */

export interface MessageAttachmentTargetRow {
  readonly outcome: 'authorized' | 'blocked' | 'conflict' | 'invalid' | 'not_found';
  readonly bucketId: string | null;
  readonly objectPath: string | null;
  readonly maxByteSize: number | null;
}

export interface MessageAttachmentAttachRow {
  readonly outcome: 'attached' | 'blocked' | 'conflict' | 'invalid' | 'not_found';
  readonly attachmentId: string | null;
  readonly attachmentCount: number | null;
}

export interface MessageAttachmentObjectRow {
  readonly outcome: 'authorized' | 'not_found';
  readonly bucketId: string | null;
  readonly objectPath: string | null;
  readonly contentType: string | null;
}

/* ------------------------------------------------------------------------------------------------ */
/* The store                                                                                         */
/* ------------------------------------------------------------------------------------------------ */

/**
 * The three database operations attachments need, and nothing else.
 *
 * Each takes the account as its first argument, and that value is always the one the API resolved from the
 * caller's own access token.
 */
export interface MessageAttachmentStore {
  /** `app_private.message_attachment_target(uuid, uuid, uuid, text, bigint)`. Writes nothing. */
  messageAttachmentTarget(input: {
    userId: string;
    conversationId: string;
    messageId: string;
    contentType: string;
    byteSize: number;
  }): Promise<MessageAttachmentTargetRow>;

  /** `app_private.message_attachment_attach(uuid, uuid, uuid, text, text, bigint)`. */
  messageAttachmentAttach(input: {
    userId: string;
    conversationId: string;
    messageId: string;
    objectPath: string;
    contentType: string;
    byteSize: number;
  }): Promise<MessageAttachmentAttachRow>;

  /** `app_private.message_attachment_for_participant(uuid, uuid, uuid)`. */
  messageAttachmentForParticipant(input: {
    userId: string;
    conversationId: string;
    attachmentId: string;
  }): Promise<MessageAttachmentObjectRow>;
}

export const MESSAGE_ATTACHMENT_STORE = Symbol('MESSAGE_ATTACHMENT_STORE');

/**
 * How long a signed read of an attachment lasts (owner decision 6).
 *
 * Ten minutes, and it is passed to the storage port per call rather than configured on the adapter, because
 * the adapter is shared with four closed surfaces whose two-minute reads must not silently lengthen.
 */
export const MESSAGE_ATTACHMENT_LINK_SECONDS = 600;

@Injectable()
export class MessageAttachmentsService {
  private readonly logger = new Logger(MessageAttachmentsService.name);

  constructor(
    @Inject(MESSAGE_ATTACHMENT_STORE) private readonly store: MessageAttachmentStore,
    @Inject(SELLER_MEDIA_STORAGE) private readonly storage: SellerMediaStoragePort,
  ) {}

  /**
   * Step one: may this caller attach this file to this message, and where would it go?
   *
   * The database answers both questions in one call and writes nothing. The provider then signs an upload for
   * exactly the path it composed — the path is never built here, and the signature is bound to that one object.
   */
  async authorizeUpload(input: {
    userId: string;
    conversationId: string;
    messageId: string;
    contentType: MessageAttachmentContentType;
    byteSize: number;
  }): Promise<MessageAttachmentUploadResponse> {
    const target = await this.read(() =>
      this.store.messageAttachmentTarget({
        userId: input.userId,
        conversationId: input.conversationId,
        messageId: input.messageId,
        contentType: input.contentType,
        byteSize: input.byteSize,
      }),
    );

    this.#refuse(target.outcome);
    if (target.bucketId === null || target.objectPath === null || target.maxByteSize === null) {
      // An `authorized` outcome with a missing field is a disagreement with the database, not an answer.
      this.logger.error('An attachment authorization arrived without a target.');
      throw new MessageAttachmentUnavailableError(new Error('incomplete authorization'));
    }

    let signed: Awaited<ReturnType<SellerMediaStoragePort['signUpload']>>;
    try {
      signed = await this.storage.signUpload(target.bucketId, target.objectPath, input.contentType);
    } catch (error) {
      if (!(error instanceof SellerMediaStorageUnavailableError)) {
        this.logger.error('An attachment upload could not be authorized.');
      }
      throw new MessageAttachmentUnavailableError(error);
    }

    return {
      upload: {
        uploadUrl: signed.uploadUrl,
        objectPath: target.objectPath,
        expiresAt: signed.expiresAt.toISOString(),
        // The database's ceiling, which is the tighter of its own figure and the bucket's. Reported rather than
        // recomputed, so a client is told the same number the next call will enforce.
        maxByteSize: Math.min(target.maxByteSize, MESSAGE_ATTACHMENT_MAX_BYTES),
      },
    };
  }

  /**
   * Step three: the object is claimed to exist, so ask storage, then record it.
   *
   * **Storage is asked first, and the order matters.** Asking the database first would mean a window in which a
   * row exists for an object that never arrived. Asking storage first means the worst case is an object with no
   * row — an orphan in a private bucket that nothing links to, which is a cost rather than a correctness
   * problem, and the lesser of the two by a wide margin.
   *
   * The path a client sends back is checked by the **database**, which re-derives the expected prefix. It is
   * passed to storage first only to ask whether that object is there; a path the database will refuse cannot
   * become a row however storage answers.
   */
  async confirmUpload(input: {
    userId: string;
    conversationId: string;
    messageId: string;
    objectPath: string;
    contentType: MessageAttachmentContentType;
    byteSize: number;
  }): Promise<MessageAttachmentRecordResponse> {
    let exists: boolean;
    try {
      exists = await this.storage.objectExists('message-attachments', input.objectPath);
    } catch (error) {
      if (!(error instanceof SellerMediaStorageUnavailableError)) {
        this.logger.error('An attachment could not be checked against storage.');
      }
      throw new MessageAttachmentUnavailableError(error);
    }
    if (!exists) throw new MessageAttachmentNotUploadedError();

    const recorded = await this.read(() =>
      this.store.messageAttachmentAttach({
        userId: input.userId,
        conversationId: input.conversationId,
        messageId: input.messageId,
        objectPath: input.objectPath,
        contentType: input.contentType,
        byteSize: input.byteSize,
      }),
    );

    this.#refuse(recorded.outcome);
    if (recorded.attachmentId === null || recorded.attachmentCount === null) {
      this.logger.error('An attachment was recorded without an identifier.');
      throw new MessageAttachmentUnavailableError(new Error('incomplete record'));
    }

    return { attachmentId: recorded.attachmentId, attachmentCount: recorded.attachmentCount };
  }

  /**
   * A short-lived signed read of one attachment.
   *
   * The caller names an attachment, never an object. The database decides whether they may see it and hands
   * back the path its own row stores, so the signature is always for that one object and a client cannot aim it
   * at another.
   */
  async link(input: {
    userId: string;
    conversationId: string;
    attachmentId: string;
  }): Promise<MessageAttachmentLinkResponse> {
    const row = await this.read(() => this.store.messageAttachmentForParticipant(input));

    if (row.outcome !== 'authorized' || row.bucketId === null || row.objectPath === null) {
      throw new MessageAttachmentNotFoundError();
    }

    let signed: Awaited<ReturnType<SellerMediaStoragePort['signDownload']>>;
    try {
      signed = await this.storage.signDownload(
        row.bucketId,
        row.objectPath,
        MESSAGE_ATTACHMENT_LINK_SECONDS,
      );
    } catch (error) {
      if (!(error instanceof SellerMediaStorageUnavailableError)) {
        this.logger.error('An attachment link could not be signed.');
      }
      throw new MessageAttachmentUnavailableError(error);
    }

    return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* Plumbing                                                                                        */
  /* ---------------------------------------------------------------------------------------------- */

  /** One named outcome to one approved problem. The success outcomes fall through. */
  #refuse(outcome: string): void {
    if (outcome === 'authorized' || outcome === 'attached') return;
    if (outcome === 'blocked') throw new MessageAttachmentBlockedError();
    if (outcome === 'conflict') throw new MessageAttachmentLimitReachedError();
    if (outcome === 'invalid') throw new MessageAttachmentInvalidError();
    throw new MessageAttachmentNotFoundError();
  }

  /**
   * One store call, with an unreachable database turned into the approved 503.
   *
   * The failures this service raises pass through: they are answers, not outages.
   */
  private async read<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (
        error instanceof MessageAttachmentNotFoundError ||
        error instanceof MessageAttachmentBlockedError ||
        error instanceof MessageAttachmentLimitReachedError ||
        error instanceof MessageAttachmentInvalidError ||
        error instanceof MessageAttachmentNotUploadedError
      ) {
        throw error;
      }
      // The message is never included: it can carry a constraint name, a path and a row's values.
      this.logger.warn('An attachment operation could not be completed.');
      throw new MessageAttachmentUnavailableError(error);
    }
  }
}
