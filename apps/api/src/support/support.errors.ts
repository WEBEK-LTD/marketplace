import type { ProblemCode } from '@repo/contracts';

/**
 * Support failures, the requester side (Phase 7-K).
 *
 * Each declares the problem it becomes, which is how every other error in this API reaches the
 * problem-details filter.
 *
 * **There is no "forbidden" here.** A ticket that is not the caller's, a message that is not theirs — an
 * agent's message on their own ticket included — an attachment that hangs off a different ticket, and an
 * identifier that names nothing at all, all become {@link SupportNotFoundError}: identical in status, code
 * and sentence. Nothing on this surface can tell somebody that a thing they may not see exists.
 *
 * The one conflict below is the opposite case: a fact about the caller's *own* ticket, with its own remedy,
 * which naming does not disclose anything by.
 */

/** Nothing here for this caller. One answer for absence and for somebody else's ticket. */
export class SupportNotFoundError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 404,
    code: 'NOT_FOUND',
  };

  constructor() {
    super('The requested resource was not found.');
    this.name = 'SupportNotFoundError';
  }
}

/**
 * The ticket is closed.
 *
 * 0028's own rule: a closed ticket takes no further message, no further attachment and no second closure.
 * Its own code because the remedy is specific and actionable — open a new ticket — and because nothing in
 * the repository reopens one, so "try again" would be wrong advice.
 */
export class SupportTicketNotActionableError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 409,
    code: 'SUPPORT_TICKET_NOT_ACTIONABLE',
  };

  constructor() {
    super('This ticket is closed.');
    this.name = 'SupportTicketNotActionableError';
  }
}

/** The request did not satisfy the contract the database applies. */
export class SupportInvalidError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 400,
    code: 'VALIDATION_FAILED',
  };

  constructor() {
    super('The request is invalid.');
    this.name = 'SupportInvalidError';
  }
}

/**
 * The cursor cannot be used.
 *
 * One code for a malformed cursor, an altered one and one from a version this API no longer reads, for the
 * same reason every other list on this platform has only one: the client's remedy is identical in all three
 * cases, and naming the flaw would only help somebody probing the format.
 */
export class SupportCursorInvalidError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 400,
    code: 'SUPPORT_TICKETS_CURSOR_INVALID',
  };

  constructor() {
    super('The cursor is invalid.');
    this.name = 'SupportCursorInvalidError';
  }
}

/**
 * A dependency could not answer.
 *
 * The database, or — for the two attachment operations — the storage provider. One code for both on
 * purpose: which dependency failed is an operational fact, and a caller's remedy is to try again either
 * way. The cause is carried for the log and never for the response.
 */
export class SupportUnavailableError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 503,
    code: 'SERVICE_UNAVAILABLE',
  };

  constructor(override readonly cause: unknown) {
    super('The service is temporarily unavailable.');
    this.name = 'SupportUnavailableError';
  }
}

/**
 * A confirmation arrived for a file the provider does not have (Phase 7-K).
 *
 * Its own code, as 6-E's and 6-I's equivalent has, because the remedy is specific: upload the bytes again.
 * Recording the row anyway would leave a ticket displaying a file nobody can open, which is exactly the
 * state that wastes an agent's time.
 */
export class SupportAttachmentObjectMissingError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 404,
    code: 'SUPPORT_ATTACHMENT_OBJECT_MISSING',
  };

  constructor() {
    super('The uploaded file could not be found.');
    this.name = 'SupportAttachmentObjectMissingError';
  }
}

/**
 * Too many requests (Phase 7-K, owner Decision 1).
 *
 * The same status and the same code every other throttled surface uses, so a client's handling of it does
 * not have to know which surface refused. The bucket that rejected is carried for the log and the tests and
 * **never reaches the response**: which limit somebody hit is operational detail, and naming it would tell
 * an abuser which window to wait out.
 */
export class SupportThrottledError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 429,
    code: 'THROTTLED',
  };
  readonly bucket: string;

  constructor(bucket: string) {
    super('Too many requests.');
    this.name = 'SupportThrottledError';
    this.bucket = bucket;
  }
}
