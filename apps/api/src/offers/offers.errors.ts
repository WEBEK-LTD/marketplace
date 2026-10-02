import type { ProblemCode } from '@repo/contracts';

/**
 * Offer failures (Phase 7-H).
 *
 * Each declares the problem it becomes, which is how every other error in this API reaches the
 * problem-details filter.
 *
 * **There is no "forbidden" here.** An offer that is not the caller's — on either side — becomes
 * {@link OfferNotFoundError}, identical in status, code and sentence to an offer that does not exist. A
 * buyer asking to accept, a seller asking to withdraw, and somebody guessing at an identifier all get the
 * same answer, so none of them can learn that a particular negotiation is real.
 *
 * The conflicts below are the opposite case: each is a fact about the offer or the listing in front of the
 * caller, each has a different remedy, and none of them names the other party.
 */

/** Nothing here for this caller. One answer for absence and for the wrong side of a negotiation. */
export class OfferNotFoundError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 404,
    code: 'NOT_FOUND',
  };

  constructor() {
    super('The requested resource was not found.');
    this.name = 'OfferNotFoundError';
  }
}

/** The caller already has a live offer on this listing (0015's one-open-per-buyer index). */
export class OfferAlreadyOpenError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 409,
    code: 'OFFER_ALREADY_OPEN',
  };

  constructor() {
    super('You already have an open offer on this listing.');
    this.name = 'OfferAlreadyOpenError';
  }
}

/** The listing is not in a state that can be bought, so it is not one that can be offered on. */
export class OfferNotAvailableError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 409,
    code: 'OFFER_NOT_AVAILABLE',
  };

  constructor() {
    super('This listing is not available for offers.');
    this.name = 'OfferNotAvailableError';
  }
}

/** 0015's `offers_not_self`. The public listing page cannot know who is looking, so this is the first
 * moment the caller can be told. */
export class OfferOwnListingError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 409,
    code: 'OFFER_OWN_LISTING',
  };

  constructor() {
    super('You cannot make an offer on your own listing.');
    this.name = 'OfferOwnListingError';
  }
}

/** One party has blocked the other. It never says which, and never when. */
export class OfferBlockedError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 409,
    code: 'OFFER_BLOCKED',
  };

  constructor() {
    super('This offer is not available.');
    this.name = 'OfferBlockedError';
  }
}

/**
 * The offer has already been decided (Phase 7-H).
 *
 * Accepted, rejected, withdrawn, countered or expired. Its own code because the remedy is specific —
 * reload and look at what happened — and because it is exactly what both parties must be told when they
 * acted at the same moment. The sentence names no party and quotes no amount.
 */
export class OfferNotActionableError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 409,
    code: 'OFFER_NOT_ACTIONABLE',
  };

  constructor() {
    super('This offer has already been decided.');
    this.name = 'OfferNotActionableError';
  }
}

/**
 * The offer's negotiation window has passed (Phase 7-H).
 *
 * Distinct from {@link OfferNotActionableError} because the status has not moved yet: the scheduled
 * sweeper records it within minutes, and until then the honest answer is that the window closed, not that
 * somebody decided.
 */
export class OfferLapsedError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 409,
    code: 'OFFER_LAPSED',
  };

  constructor() {
    super('This offer has passed its deadline.');
    this.name = 'OfferLapsedError';
  }
}

/**
 * The payment window is absent or unusable (Phase 7-H).
 *
 * A 503 and an integrity failure, deliberately — **never a default**. `payment_due_at` is the moment a
 * buyer's money becomes due, and an acceptance recorded with a guessed deadline would be worse than no
 * acceptance at all. The body says only that the service is unavailable: an admin-configuration problem
 * is not something to explain to a seller mid-negotiation.
 */
export class OfferPaymentPolicyMissingError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 503,
    code: 'OFFER_PAYMENT_POLICY_MISSING',
  };

  constructor() {
    super('The service is temporarily unavailable.');
    this.name = 'OfferPaymentPolicyMissingError';
  }
}

/** The list cursor cannot be read. One answer for malformed, altered and outdated. */
export class OffersCursorInvalidError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 400,
    code: 'OFFERS_CURSOR_INVALID',
  };

  constructor() {
    super('The cursor is invalid.');
    this.name = 'OffersCursorInvalidError';
  }
}

/** A dependency could not answer. Never rendered as a refusal. */
export class OffersUnavailableError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 503,
    code: 'SERVICE_UNAVAILABLE',
  };

  constructor(override readonly cause: unknown) {
    super('The service is temporarily unavailable.');
    this.name = 'OffersUnavailableError';
  }
}
