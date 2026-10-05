import type { ProblemCode } from '@repo/contracts';

/**
 * Redirect-map failures.
 *
 * **There is no "forbidden" here.** An entry that does not exist, and a caller who does not hold
 * `seo.redirect.read` at `aal2`, both become {@link SeoRedirectNotFoundError} — identical in status, code and
 * sentence. Every admin surface in this console follows that rule, for the same reason: a distinguishable
 * refusal is a way to ask whether a row exists.
 *
 * **The refusal class is separate from the not-found class**, because a write refusal is not an absence. An
 * operator who may manage the map and is told that another entry already claims an address has learned nothing
 * they were not entitled to know, and hiding it behind a 404 would leave them with no way to fix it.
 */

/** Nothing here for this caller. One answer for absence and for a missing permission. */
export class SeoRedirectNotFoundError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 404,
    code: 'NOT_FOUND',
  };

  constructor() {
    super('The requested resource was not found.');
    this.name = 'SeoRedirectNotFoundError';
  }
}

/**
 * The caller may change the map and the change itself is refused.
 *
 * Both reasons are migration 0030's constraints — an address another entry already holds, or an entry that is
 * not a legal one at all — so this class reports a refusal it did not make.
 */
export class SeoRedirectRefusedError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode };

  constructor(code: SeoRedirectRefusalCode, detail: string) {
    super(detail);
    this.name = 'SeoRedirectRefusedError';
    this.problem = { status: 409, code };
  }
}

/** The two refusals this surface can report, both decided in the database. */
export type SeoRedirectRefusalCode = 'SEO_REDIRECT_PATH_TAKEN' | 'SEO_REDIRECT_NOT_ALLOWED';

/** An unusable cursor. One code for every way a cursor can fail to be one. */
export class SeoRedirectCursorInvalidError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 400,
    code: 'VALIDATION_FAILED',
  };

  constructor() {
    super('The cursor could not be read.');
    this.name = 'SeoRedirectCursorInvalidError';
  }
}

/** Raised when a read or a write could not be performed at all. Becomes a 503. */
export class SeoRedirectUnavailableError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 503,
    code: 'SERVICE_UNAVAILABLE',
  };

  constructor(cause?: unknown) {
    super('The service is temporarily unavailable.');
    this.name = 'SeoRedirectUnavailableError';
    if (cause !== undefined) this.cause = cause;
  }
}
