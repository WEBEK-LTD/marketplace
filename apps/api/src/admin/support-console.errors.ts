import type { ProblemCode } from '@repo/contracts';

/**
 * Support agent console failures (Phase 7-L).
 *
 * Each declares the problem it becomes, which is how every other error in this API reaches the
 * problem-details filter.
 *
 * **There is no "forbidden" here.** A ticket held by another agent, a ticket that does not exist, a caller
 * who holds neither support key, a caller at `aal1`, and — on the four writes — a ticket nobody has claimed
 * all become {@link SupportConsoleNotFoundError}: identical in status, code and sentence. A colleague's
 * work cannot be confirmed to exist by anybody who may not see it, and a permission failure is not
 * distinguishable from absence, so nothing here is an oracle for either.
 *
 * The one conflict is a fact about a ticket the caller *may* work on, with its own remedy.
 */

/** Nothing here for this caller. One answer for absence, for another agent's ticket and for no permission. */
export class SupportConsoleNotFoundError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 404,
    code: 'NOT_FOUND',
  };

  constructor() {
    super('The requested resource was not found.');
    this.name = 'SupportConsoleNotFoundError';
  }
}

/**
 * The ticket cannot take this action.
 *
 * It is closed, or resolution was asked for on a ticket already resolved. Its own code rather than the
 * requester's `SUPPORT_TICKET_NOT_ACTIONABLE`, because the remedies differ: a colleague reloads and looks
 * at what happened rather than opening a new ticket.
 */
export class SupportTicketNotWorkableError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 409,
    code: 'SUPPORT_TICKET_NOT_WORKABLE',
  };

  constructor() {
    super('This ticket can no longer be worked on.');
    this.name = 'SupportTicketNotWorkableError';
  }
}

/** The request did not satisfy the contract the database applies. */
export class SupportConsoleInvalidError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 400,
    code: 'VALIDATION_FAILED',
  };

  constructor() {
    super('The request is invalid.');
    this.name = 'SupportConsoleInvalidError';
  }
}

/** One code for every unusable cursor, for the same reason every other list on this platform has one. */
export class SupportConsoleCursorInvalidError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 400,
    code: 'SUPPORT_TICKETS_CURSOR_INVALID',
  };

  constructor() {
    super('The cursor is invalid.');
    this.name = 'SupportConsoleCursorInvalidError';
  }
}

/**
 * A dependency could not answer.
 *
 * The database, or — for the attachment link — the storage provider. One code for both: which dependency
 * failed is an operational fact and a caller's remedy is to try again either way. The cause is carried for
 * the log and never for the response.
 */
export class SupportConsoleUnavailableError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 503,
    code: 'SERVICE_UNAVAILABLE',
  };

  constructor(override readonly cause: unknown) {
    super('The service is temporarily unavailable.');
    this.name = 'SupportConsoleUnavailableError';
  }
}
