import type { ProblemCode } from '@repo/contracts';

/**
 * Navigation authoring failures (0094).
 *
 * **There is no "forbidden" here.** A menu that does not exist, and a caller who does not hold
 * `cms.navigation.read` at `aal2`, both become {@link NavigationNotFoundError} — identical in status, code and
 * sentence. Every admin surface in this console follows that rule: a distinguishable refusal is a way to ask
 * whether a row exists.
 *
 * **The refusal class is separate from the not-found class**, because this surface has writes and their refusals
 * are not absences. A caller who may arrange the navigation and is told that a key is taken has learned nothing
 * they did not already have the right to know.
 */

/** Nothing here for this caller. One answer for absence and for a missing permission. */
export class NavigationNotFoundError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 404,
    code: 'NOT_FOUND',
  };

  constructor() {
    super('The requested resource was not found.');
    this.name = 'NavigationNotFoundError';
  }
}

/**
 * The menu exists, the caller may change it, and the change itself is refused.
 *
 * Three things arrive here: a key another menu already holds; an arrangement one of 0030's own constraints or
 * triggers refuses — a key that is not a key, a label longer than the column, a path that is not relative, a
 * third level, a child in another menu; and a page, post, category, menu or parent that does not exist. All three
 * are decided in the database, so this class reports a refusal it did not make.
 */
export class NavigationRefusedError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode };

  constructor(code: NavigationRefusalCode, detail: string) {
    super(detail);
    this.name = 'NavigationRefusedError';
    this.problem = { status: 409, code };
  }
}

/** The three refusals this surface can report, each decided in the database. */
export type NavigationRefusalCode =
  | 'NAVIGATION_MENU_KEY_TAKEN'
  | 'NAVIGATION_NOT_ALLOWED'
  | 'NAVIGATION_REFERENCE_UNKNOWN';

/** Raised when a read or a write could not be performed at all. Becomes a 503. */
export class NavigationUnavailableError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 503,
    code: 'SERVICE_UNAVAILABLE',
  };

  constructor(cause?: unknown) {
    super('The service is temporarily unavailable.');
    this.name = 'NavigationUnavailableError';
    if (cause !== undefined) this.cause = cause;
  }
}
