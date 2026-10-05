import type { ProblemCode } from '@repo/contracts';

/**
 * Service request and quote failures (Phase 7-I).
 *
 * Each declares the problem it becomes, which is how every other error in this API reaches the
 * problem-details filter.
 *
 * **There is no "forbidden" here.** A request or a quote that is not the caller's — on either side — becomes
 * {@link ServiceRequestNotFoundError}, identical in status, code and sentence to one that does not exist. A
 * buyer asking to quote, a seller asking to accept, a third party guessing an identifier, and a quote id
 * spent against the wrong request all get the same answer, so none of them can learn that a particular
 * exchange is real.
 *
 * The conflicts below are the opposite case: each is a fact about the listing, the request or the quote in
 * front of the caller, each has a different remedy, and none names the other party.
 */

/** Nothing here for this caller. One answer for absence and for the wrong side of an exchange. */
export class ServiceRequestNotFoundError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 404,
    code: 'NOT_FOUND',
  };

  constructor() {
    super('The requested resource was not found.');
    this.name = 'ServiceRequestNotFoundError';
  }
}

/** The service listing is not in a state that can be bought, so it is not one that can be briefed. */
export class ServiceRequestNotAvailableError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 409,
    code: 'SERVICE_REQUEST_NOT_AVAILABLE',
  };

  constructor() {
    super('This service is not available for requests.');
    this.name = 'ServiceRequestNotAvailableError';
  }
}

/**
 * The service is fixed-price (Phase 7-I).
 *
 * v5.2's own division: a fixed-price service is bought through the cart and a custom one runs request →
 * quote. Its own code because the remedy is specific — buy it — and a generic refusal would leave somebody
 * rewriting their brief.
 */
export class ServiceRequestNotCustomError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 409,
    code: 'SERVICE_REQUEST_NOT_CUSTOM',
  };

  constructor() {
    super('This service is bought directly rather than quoted.');
    this.name = 'ServiceRequestNotCustomError';
  }
}

/** The schema's not-self rule. The public service page cannot know who is looking. */
export class ServiceRequestOwnListingError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 409,
    code: 'SERVICE_REQUEST_OWN_LISTING',
  };

  constructor() {
    super('You cannot send a request for your own service.');
    this.name = 'ServiceRequestOwnListingError';
  }
}

/** One party has blocked the other. It never says which, and never when. */
export class ServiceRequestBlockedError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 409,
    code: 'SERVICE_REQUEST_BLOCKED',
  };

  constructor() {
    super('This request is not available.');
    this.name = 'ServiceRequestBlockedError';
  }
}

/**
 * The request is closed, or the quote has already been decided (Phase 7-I).
 *
 * One code for both, because the remedy is the same in both: reload and look at what happened. It is also
 * what both parties must be told when they acted at the same moment, and it names no party.
 */
export class ServiceRequestNotActionableError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 409,
    code: 'SERVICE_REQUEST_NOT_ACTIONABLE',
  };

  constructor() {
    super('This has already been decided.');
    this.name = 'ServiceRequestNotActionableError';
  }
}

/**
 * The quote's validity window has passed (Phase 7-I).
 *
 * Distinct from {@link ServiceRequestNotActionableError} because the status has not moved yet: the
 * scheduled sweeper records it within minutes, and until then the honest answer is that the window closed,
 * not that somebody decided.
 */
export class ServiceQuoteLapsedError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 409,
    code: 'SERVICE_QUOTE_LAPSED',
  };

  constructor() {
    super('This quote has passed its deadline.');
    this.name = 'ServiceQuoteLapsedError';
  }
}

/**
 * The payment window is absent or unusable (Phase 7-I).
 *
 * A 503 and an integrity failure, deliberately — **never a default**. `payment_due_at` is the moment a
 * buyer's money becomes due, and an acceptance recorded with a guessed deadline would be worse than no
 * acceptance at all. The body says only that the service is unavailable: an admin-configuration problem is
 * not something to explain to a buyer mid-negotiation.
 */
export class ServiceQuotePaymentPolicyMissingError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 503,
    code: 'SERVICE_QUOTE_PAYMENT_POLICY_MISSING',
  };

  constructor() {
    super('The service is temporarily unavailable.');
    this.name = 'ServiceQuotePaymentPolicyMissingError';
  }
}

/** The list cursor cannot be read. One answer for malformed, altered and outdated. */
export class ServiceRequestsCursorInvalidError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 400,
    code: 'SERVICE_REQUESTS_CURSOR_INVALID',
  };

  constructor() {
    super('The cursor is invalid.');
    this.name = 'ServiceRequestsCursorInvalidError';
  }
}

/** A dependency could not answer. Never rendered as a refusal. */
export class ServiceRequestsUnavailableError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 503,
    code: 'SERVICE_UNAVAILABLE',
  };

  constructor(override readonly cause: unknown) {
    super('The service is temporarily unavailable.');
    this.name = 'ServiceRequestsUnavailableError';
  }
}

/**
 * The platform has no default currency (Phase 7-J).
 *
 * An Admin Only brief has no listing to take a currency from, so it takes the platform's own default. A 503
 * and an integrity failure, deliberately — **never a guess**. A brief written in a currency nobody chose
 * would be worse than no brief, and the body says only that the service is unavailable: an
 * admin-configuration problem is not something to explain to a buyer mid-form.
 */
export class ServiceRequestCurrencyUnavailableError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 503,
    code: 'SERVICE_REQUEST_CURRENCY_UNAVAILABLE',
  };

  constructor() {
    super('The service is temporarily unavailable.');
    this.name = 'ServiceRequestCurrencyUnavailableError';
  }
}
