import type { ProblemCode } from '@repo/contracts';

/**
 * Admin Only service request failures (Phase 7-J).
 *
 * **There is no "forbidden" here, and that is the whole design.** A staff caller who does not hold the
 * permission, a caller at `aal1`, a request that does not exist, and a seller-routed request asked for on this
 * surface all become {@link AdminServiceRequestNotFoundError} — identical in status, code and sentence. A
 * refusal that distinguished "you may not see this one" from "there is no such one" would confirm that a
 * particular buyer sent a particular brief, and the payment-information path would confirm that a particular
 * brief has payment information worth guarding.
 *
 * The one conflict below is different in kind: it is a fact about the request in front of the caller, it has a
 * remedy (reload and look at what happened), and it names nobody.
 */

/** Nothing here for this caller. One answer for absence, for the wrong permission and for the wrong flow. */
export class AdminServiceRequestNotFoundError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 404,
    code: 'NOT_FOUND',
  };

  constructor() {
    super('The requested resource was not found.');
    this.name = 'AdminServiceRequestNotFoundError';
  }
}

/**
 * The request is no longer open (Phase 7-J).
 *
 * `open` is the only state the approved staff closure runs from. A request the buyer has already cancelled,
 * or one already declined, is finished — and two staff pressing at the same moment means one of them gets
 * this. Reuses Option 1's code because the remedy is the same and the sentence names no party.
 */
export class AdminServiceRequestNotActionableError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 409,
    code: 'SERVICE_REQUEST_NOT_ACTIONABLE',
  };

  constructor() {
    super('This has already been decided.');
    this.name = 'AdminServiceRequestNotActionableError';
  }
}

/** The queue cursor cannot be read. One answer for malformed, altered and outdated. */
export class AdminServiceRequestsCursorInvalidError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 400,
    code: 'SERVICE_REQUESTS_CURSOR_INVALID',
  };

  constructor() {
    super('The cursor is invalid.');
    this.name = 'AdminServiceRequestsCursorInvalidError';
  }
}

/** A dependency could not answer. Never rendered as a refusal. */
export class AdminServiceRequestsUnavailableError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 503,
    code: 'SERVICE_UNAVAILABLE',
  };

  constructor(override readonly cause: unknown) {
    super('The service is temporarily unavailable.');
    this.name = 'AdminServiceRequestsUnavailableError';
  }
}
