import type { ProblemCode } from '@repo/contracts';

/**
 * Review moderation failures, the admin side (Phase 7-P).
 *
 * Each declares the problem it becomes, which is how every other error in this API reaches the
 * problem-details filter.
 *
 * **There is no "forbidden" here.** A review that does not exist, and a caller who does not hold the key at
 * `aal2`, both become {@link ReviewNotFoundError} — identical in status, code and sentence. That is the rule
 * every admin surface in Phase 7 follows, and it holds for the same reason: a distinguishable refusal is a way
 * to ask whether a row exists. It matters here because the two review keys and the action key are three
 * different keys, and a support agent holds none of them.
 *
 * The two refusals below are 0026's own, and each is about the caller's own relationship to a review they are
 * already reading, so naming the reason discloses nothing.
 *
 * **There is no error class for an illegal transition**, because `moderate_review` imposes no transition
 * matrix — any of its four statuses may follow any other. And none for moderating a reply, because there is no
 * operation that does: no writer for a reply's status exists in this repository.
 */

/** Nothing here for this caller. One answer for absence and for a missing permission. */
export class ReviewNotFoundError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 404,
    code: 'NOT_FOUND',
  };

  constructor() {
    super('The requested resource was not found.');
    this.name = 'ReviewNotFoundError';
  }
}

/**
 * The caller is the review's buyer or its seller.
 *
 * 0026 refuses it — "nobody moderates a review they are a party to". It discloses nothing, because the only
 * relationship it concerns is the caller's own, and the remedy is for a colleague to take it.
 */
export class ReviewIsPartyError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 409,
    code: 'REVIEW_IS_PARTY',
  };

  constructor() {
    super('Nobody moderates a review they are a party to.');
    this.name = 'ReviewIsPartyError';
  }
}

/**
 * A decision with no reason.
 *
 * `reviews_moderated_has_reason` enforces it in the schema and the contract checks it before the request
 * leaves validation, so this is the floor rather than the path.
 */
export class ReviewReasonRequiredError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 409,
    code: 'REVIEW_REASON_REQUIRED',
  };

  constructor() {
    super('A moderation decision is always recorded with its reason.');
    this.name = 'ReviewReasonRequiredError';
  }
}

/** An unusable request the database refused. */
export class ReviewInvalidError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 400,
    code: 'VALIDATION_FAILED',
  };

  constructor() {
    super('The request is invalid.');
    this.name = 'ReviewInvalidError';
  }
}

/** An unusable queue cursor. One code for every way a cursor can fail to be one. */
export class ReviewCursorInvalidError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 400,
    code: 'VALIDATION_FAILED',
  };

  constructor() {
    super('The cursor could not be read.');
    this.name = 'ReviewCursorInvalidError';
  }
}

/** Raised when a read or a write could not be performed at all. Becomes a 503. */
export class ReviewUnavailableError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 503,
    code: 'SERVICE_UNAVAILABLE',
  };

  constructor(cause?: unknown) {
    super('The service is temporarily unavailable.');
    this.name = 'ReviewUnavailableError';
    if (cause !== undefined) this.cause = cause;
  }
}
