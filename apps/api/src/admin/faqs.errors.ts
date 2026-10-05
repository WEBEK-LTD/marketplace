import type { ProblemCode } from '@repo/contracts';

/**
 * Help-centre authoring failures (0095).
 *
 * **There is no "forbidden" here.** An entry that does not exist, and a caller who does not hold `cms.faq.read` at
 * `aal2`, both become {@link FaqNotFoundError} — identical in status, code and sentence. Every admin surface in
 * this console follows that rule: a distinguishable refusal is a way to ask whether a row exists.
 *
 * **The refusal class is separate from the not-found class**, because this surface has writes and their refusals
 * are not absences. A caller who may author the help centre and is told that a value is not one the column accepts
 * has learned nothing they did not already have the right to know.
 */

/** Nothing here for this caller. One answer for absence and for a missing permission. */
export class FaqNotFoundError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 404,
    code: 'NOT_FOUND',
  };

  constructor() {
    super('The requested resource was not found.');
    this.name = 'FaqNotFoundError';
  }
}

/**
 * The entry exists, the caller may change it, and the change itself is refused.
 *
 * One thing arrives here: a value one of 0030's own constraints refuses — a topic that is not a topic, a question
 * longer than the column, or an answer with nothing in it. All of those are decided in the database, so this class
 * reports a refusal it did not make.
 */
export class FaqRefusedError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode };

  constructor(code: FaqRefusalCode, detail: string) {
    super(detail);
    this.name = 'FaqRefusedError';
    this.problem = { status: 409, code };
  }
}

/** The one refusal this surface can report, decided in the database. */
export type FaqRefusalCode = 'FAQ_NOT_ALLOWED';

/** A cursor that is not a position. Its own class, because it is the client's mistake and not an absence. */
export class FaqCursorInvalidError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 400,
    code: 'VALIDATION_FAILED',
  };

  constructor() {
    super('The cursor is invalid.');
    this.name = 'FaqCursorInvalidError';
  }
}

/** Raised when a read or a write could not be performed at all. Becomes a 503. */
export class FaqUnavailableError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 503,
    code: 'SERVICE_UNAVAILABLE',
  };

  constructor(cause?: unknown) {
    super('The service is temporarily unavailable.');
    this.name = 'FaqUnavailableError';
    if (cause !== undefined) this.cause = cause;
  }
}
