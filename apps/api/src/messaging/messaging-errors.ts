import type { ProblemCode } from '@repo/contracts';

/**
 * Messaging failures (Phase 5-C).
 *
 * Each error declares the problem it becomes, which is how every other error in this API reaches the
 * problem-details filter — there is no mapping table and no `try`/`catch` in a controller turning
 * outcomes into statuses, so a refusal cannot drift apart from a validation failure by accident.
 *
 * Two of these are security-shaped rather than merely descriptive.
 *
 * {@link ConversationNotAccessibleError} is the *only* answer a caller gets for a conversation that is
 * not theirs, and it is the same answer they get for a conversation that does not exist. There is
 * deliberately no separate "forbidden": a 403 would confirm that the conversation is real, which is
 * precisely what must not be learnable.
 *
 * {@link InvalidMessagingCursorError} covers a malformed cursor, a tampered one and one from a version
 * this API no longer reads. One code for all three, because the client's remedy is identical — drop the
 * cursor and start from the beginning — and naming which structural check failed would only help
 * somebody mapping the format.
 */

export class InvalidMessagingCursorError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 400,
    code: 'MESSAGING_CURSOR_INVALID',
  };

  constructor() {
    super('The cursor could not be used.');
    this.name = 'InvalidMessagingCursorError';
  }
}

export class ConversationNotAccessibleError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 404,
    code: 'MESSAGING_CONVERSATION_NOT_FOUND',
  };

  constructor() {
    super('The conversation could not be found.');
    this.name = 'ConversationNotAccessibleError';
  }
}

/**
 * The conversation is closed, so nothing further may be sent to it (Phase 5-E).
 *
 * Its own code, unlike {@link ConversationNotAccessibleError}: the caller is a participant and already
 * knows the conversation exists, so saying why the send failed reveals nothing and telling them nothing
 * would leave a composer that silently refuses.
 */
export class ConversationClosedError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 409,
    code: 'MESSAGING_CONVERSATION_CLOSED',
  };

  constructor() {
    super('The conversation is closed.');
    this.name = 'ConversationClosedError';
  }
}

/**
 * One of the two people has blocked the other (Phase 5-E).
 *
 * Reported rather than hidden, because the alternative is a message that appears to send and does not.
 * It says only that the exchange is not possible — never who blocked whom, or when.
 */
export class MessagingBlockedError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 409,
    code: 'MESSAGING_BLOCKED',
  };

  constructor() {
    super('The conversation is not available.');
    this.name = 'MessagingBlockedError';
  }
}

/**
 * The seller cannot receive a new conversation (Phase 5-E).
 *
 * One answer for a suspended seller, a closed seller, a listing the public cannot see and a listing that
 * does not exist. They are one answer on purpose: each of the others would tell a caller something about
 * a seller's standing or a listing's existence that the public surfaces do not.
 */
export class SellerNotContactableError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 409,
    code: 'MESSAGING_SELLER_NOT_CONTACTABLE',
  };

  constructor() {
    super('This seller cannot be contacted.');
    this.name = 'SellerNotContactableError';
  }
}

/**
 * The approved messaging rate limits refused the request (Phase 5-E).
 *
 * The same code the F4 contact change uses, because it is the same kind of refusal and a client's
 * remedy — wait and retry — is identical. It never says which bucket.
 */
/**
 * A message or conversation this caller cannot report (Phase 5-H).
 *
 * Its own class rather than a reuse of the conversation refusal, because the two surfaces differ, but
 * deliberately the same *shape*: one status and one code for a subject the caller may not read and one
 * that does not exist. There is no error anywhere that means "it exists but is not yours".
 */
export class ReportTargetNotAccessibleError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 404,
    code: 'MESSAGING_REPORT_TARGET_NOT_FOUND',
  };

  constructor() {
    super('The reported item could not be found.');
    this.name = 'ReportTargetNotAccessibleError';
  }
}

export class MessagingThrottledError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 429,
    code: 'THROTTLED',
  };
  readonly bucket: string;

  constructor(bucket: string) {
    super('Too many requests.');
    this.name = 'MessagingThrottledError';
    this.bucket = bucket;
  }
}

/**
 * The messaging read model could not be reached, or answered in a way this service does not understand.
 *
 * Never conflated with an empty inbox. A database failure rendered as "you have no conversations" is a
 * lie to the person and an outage nobody sees; 503 keeps the two apart. The cause is kept for logging
 * and never reaches the response.
 */
export class MessagingUnavailableError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 503,
    code: 'SERVICE_UNAVAILABLE',
  };

  constructor(override readonly cause: unknown) {
    super('The service is temporarily unavailable.');
    this.name = 'MessagingUnavailableError';
  }
}
