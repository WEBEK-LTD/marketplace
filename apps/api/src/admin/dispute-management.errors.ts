import type { ProblemCode } from '@repo/contracts';

/**
 * Dispute management failures, the admin side (Phase 7-R).
 *
 * Each declares the problem it becomes, which is how every other error in this API reaches the
 * problem-details filter.
 *
 * **There is no "forbidden" here.** A dispute that does not exist, and a caller who does not hold the key at
 * `aal2`, both become {@link DisputeNotFoundError} — identical in status, code and sentence. That is the rule
 * every admin surface in Phase 7 follows, and it matters more here than on most: only Admin and Super Admin
 * hold a dispute key, and a Moderator is deliberately not granted either, so a distinguishable refusal would
 * tell a Moderator that this section exists and has something in it.
 *
 * ---------------------------------------------------------------------------------------------------
 * **THERE IS NO FINANCIAL FAILURE IN THIS FILE, BECAUSE NOTHING HERE MOVES MONEY.**
 *
 * No refund-failed, no insufficient-balance, no provider-rejected, no reversal-declined, no
 * currency-mismatch-on-settlement. A resolution records a decision; the refund it may imply is a separate,
 * later operation that does not exist in this platform yet, and its failures will be its own.
 *
 * If somebody later adds a control that does move money, this file is where its refusals would have to land —
 * and the fact that it is empty of them is part of what makes the boundary visible.
 * ---------------------------------------------------------------------------------------------------
 */

/** Nothing here for this caller. One answer for absence and for a missing permission. */
export class DisputeNotFoundError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 404,
    code: 'NOT_FOUND',
  };

  constructor() {
    super('The requested resource was not found.');
    this.name = 'DisputeNotFoundError';
  }
}

/**
 * The caller is the dispute's buyer or its seller.
 *
 * 0027 refuses it twice over — "nobody resolves a dispute they are a party to", and an internal note from a
 * party — and one code covers both, because both concern only the caller's own relationship to a dispute they
 * are already reading, and both have the same remedy: a colleague takes it.
 */
export class DisputeIsPartyError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 409,
    code: 'DISPUTE_IS_PARTY',
  };

  constructor() {
    super('Nobody rules on a dispute they are a party to.');
    this.name = 'DisputeIsPartyError';
  }
}

/** A message on a dispute that is resolved or cancelled. 0027's own refusal. */
export class DisputeThreadClosedError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 409,
    code: 'DISPUTE_THREAD_CLOSED',
  };

  constructor() {
    super('This dispute is closed and its thread takes no more messages.');
    this.name = 'DisputeThreadClosedError';
  }
}

/** Somebody else ruled first, or the page is stale. */
export class DisputeAlreadyResolvedError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 409,
    code: 'DISPUTE_ALREADY_RESOLVED',
  };

  constructor() {
    super('This dispute has already been resolved.');
    this.name = 'DisputeAlreadyResolvedError';
  }
}

/**
 * A decision with no reason.
 *
 * `disputes_resolved_has_note` enforces it in the schema and the contract checks it before the request leaves
 * validation, so this is the floor rather than the path.
 */
export class DisputeReasonRequiredError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 409,
    code: 'DISPUTE_REASON_REQUIRED',
  };

  constructor() {
    super('A dispute is never resolved without a reason.');
    this.name = 'DisputeReasonRequiredError';
  }
}

/**
 * An amount against a resolution that is not a refund.
 *
 * `disputes_resolution_amount_is_for_a_refund` is the rule. It is an explicit refusal rather than a silently
 * dropped field, so a console that sent one is told.
 */
export class DisputeAmountNotAllowedError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 409,
    code: 'DISPUTE_AMOUNT_NOT_ALLOWED',
  };

  constructor() {
    super('An amount belongs only to a refund resolution.');
    this.name = 'DisputeAmountNotAllowedError';
  }
}

/** An unusable request the database refused. */
export class DisputeInvalidError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 400,
    code: 'VALIDATION_FAILED',
  };

  constructor() {
    super('The request is invalid.');
    this.name = 'DisputeInvalidError';
  }
}

/** An unusable queue cursor. One code for every way a cursor can fail to be one. */
export class DisputeCursorInvalidError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 400,
    code: 'VALIDATION_FAILED',
  };

  constructor() {
    super('The cursor could not be read.');
    this.name = 'DisputeCursorInvalidError';
  }
}

/** Raised when a read or a write could not be performed at all. Becomes a 503. */
export class DisputeUnavailableError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 503,
    code: 'SERVICE_UNAVAILABLE',
  };

  constructor(cause?: unknown) {
    super('The service is temporarily unavailable.');
    this.name = 'DisputeUnavailableError';
    if (cause !== undefined) this.cause = cause;
  }
}
