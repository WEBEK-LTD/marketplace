import type { ProblemCode } from '@repo/contracts';

/**
 * Homepage authoring failures (0093).
 *
 * **There is no "forbidden" here.** A section that does not exist, and a caller who does not hold
 * `cms.homepage.read` at `aal2`, both become {@link HomepageNotFoundError} — identical in status, code and
 * sentence. Every admin surface in this console follows that rule: a distinguishable refusal is a way to ask
 * whether a row exists.
 *
 * **The refusal class is separate from the not-found class**, because this surface has writes and their refusals
 * are not absences. A caller who may compose the homepage and is told that a key is already taken has learned
 * nothing they did not already have the right to know.
 */

/** Nothing here for this caller. One answer for absence and for a missing permission. */
export class HomepageNotFoundError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 404,
    code: 'NOT_FOUND',
  };

  constructor() {
    super('The requested resource was not found.');
    this.name = 'HomepageNotFoundError';
  }
}

/**
 * The section exists, the caller may change it, and the change itself is refused.
 *
 * Two things arrive here: a key another section already holds, and a value one of 0030's own constraints refuses
 * — a key that is not a key, a type it does not have, a title longer than the column, or a `config` that is not
 * a JSON object. Both are decided in the database, so this class reports a refusal it did not make.
 */
export class HomepageRefusedError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode };

  constructor(code: HomepageRefusalCode, detail: string) {
    super(detail);
    this.name = 'HomepageRefusedError';
    this.problem = { status: 409, code };
  }
}

/** The two refusals this surface can report, each decided in the database. */
export type HomepageRefusalCode = 'HOMEPAGE_SECTION_KEY_TAKEN' | 'HOMEPAGE_SECTION_NOT_ALLOWED';

/** Raised when a read or a write could not be performed at all. Becomes a 503. */
export class HomepageUnavailableError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 503,
    code: 'SERVICE_UNAVAILABLE',
  };

  constructor(cause?: unknown) {
    super('The service is temporarily unavailable.');
    this.name = 'HomepageUnavailableError';
    if (cause !== undefined) this.cause = cause;
  }
}
