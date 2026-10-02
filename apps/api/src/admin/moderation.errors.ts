import type { ProblemCode } from '@repo/contracts';

/**
 * Moderation failures, the admin side (Phase 7-N).
 *
 * Each declares the problem it becomes, which is how every other error in this API reaches the
 * problem-details filter.
 *
 * **There is no "forbidden" here.** A report or a listing that does not exist, and a caller who does not
 * hold the key at `aal2`, all become {@link ModerationNotFoundError} — identical in status, code and
 * sentence. That is 7-G's and 7-L's rule on the admin surfaces and it holds for the same reason: a
 * distinguishable refusal is a way to ask whether a row exists.
 *
 * The four refusals below are the cases where naming the reason discloses nothing, because each is about
 * the caller's own request or about a row they are already reading.
 */

/** Nothing here for this caller. One answer for absence and for a missing permission. */
export class ModerationNotFoundError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 404,
    code: 'NOT_FOUND',
  };

  constructor() {
    super('The requested resource was not found.');
    this.name = 'ModerationNotFoundError';
  }
}

/**
 * The report is already actioned, dismissed or a duplicate.
 *
 * 0027's own rule — "a closed report cannot be reopened by this path" — reported before it becomes an
 * exception. Its own code because the remedy is to reload and read the decision, not to try again.
 */
export class ReportAlreadyFinalError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 409,
    code: 'REPORT_ALREADY_FINAL',
  };

  constructor() {
    super('This report has already been decided.');
    this.name = 'ReportAlreadyFinalError';
  }
}

/**
 * The caller filed this report.
 *
 * 0027 refuses it — "nobody rules on their own report". It discloses nothing, because the only account it
 * concerns is the caller's, and the remedy is for a colleague to take it.
 */
export class ReportIsOwnError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 409,
    code: 'REPORT_IS_OWN',
  };

  constructor() {
    super('Nobody rules on their own report.');
    this.name = 'ReportIsOwnError';
  }
}

/** The caller sells this listing. `moderate_listing`'s own refusal, for the same reason. */
export class ListingIsOwnError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 409,
    code: 'LISTING_IS_OWN',
  };

  constructor() {
    super('Nobody moderates their own listing.');
    this.name = 'ListingIsOwnError';
  }
}

/**
 * The action would leave the listing's status where it is.
 *
 * `listing_moderation_actions_status_moved` refuses it. This is what a repeat looks like, and what the loser
 * of two colleagues acting at once receives — so the remedy is to reload, because somebody already did it.
 */
export class ListingModerationNoChangeError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 409,
    code: 'LISTING_MODERATION_NO_CHANGE',
  };

  constructor() {
    super('This listing is already in that state.');
    this.name = 'ListingModerationNoChangeError';
  }
}

/**
 * The listing cannot hold the status this action would give it.
 *
 * It has no price and would have gone live, or it was never approved and cannot be reinstated to `active`.
 * Its own code because retrying will never help: the remedy is elsewhere.
 */
export class ListingModerationNotApplicableError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 409,
    code: 'LISTING_MODERATION_NOT_APPLICABLE',
  };

  constructor() {
    super('This action cannot be applied to this listing.');
    this.name = 'ListingModerationNotApplicableError';
  }
}

/** An unusable request the database refused. */
export class ModerationInvalidError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 400,
    code: 'VALIDATION_FAILED',
  };

  constructor() {
    super('The request is invalid.');
    this.name = 'ModerationInvalidError';
  }
}

/** An unusable queue cursor. One code for every way a cursor can fail to be one. */
export class ModerationCursorInvalidError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 400,
    code: 'VALIDATION_FAILED',
  };

  constructor() {
    super('The cursor could not be read.');
    this.name = 'ModerationCursorInvalidError';
  }
}

/** Raised when a read or a write could not be performed at all. Becomes a 503. */
export class ModerationUnavailableError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 503,
    code: 'SERVICE_UNAVAILABLE',
  };

  constructor(cause?: unknown) {
    super('The service is temporarily unavailable.');
    this.name = 'ModerationUnavailableError';
    if (cause !== undefined) this.cause = cause;
  }
}
