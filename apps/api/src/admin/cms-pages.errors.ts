import type { ProblemCode } from '@repo/contracts';

/**
 * CMS page failures.
 *
 * **There is no "forbidden" here.** A page that does not exist, and a caller who does not hold
 * `cms.page.read` at `aal2`, both become {@link CmsPageNotFoundError} — identical in status, code and
 * sentence. Every admin surface in this console follows that rule, for the same reason: a distinguishable
 * refusal is a way to ask whether a row exists, and here it would also tell a Moderator or a Support Agent
 * that an unpublished page is sitting in the console.
 *
 * **The refusal class is separate from the not-found class**, unlike on the read-only surfaces, because this
 * one has writes and their refusals are not absences. A caller who may manage pages and is told that a
 * published page cannot lose its last locale has learned nothing they did not already have the right to know,
 * and hiding it behind a 404 would make the console unusable.
 */

/** Nothing here for this caller. One answer for absence and for a missing permission. */
export class CmsPageNotFoundError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 404,
    code: 'NOT_FOUND',
  };

  constructor() {
    super('The requested resource was not found.');
    this.name = 'CmsPageNotFoundError';
  }
}

/**
 * The page exists, the caller may change it, and the change itself is refused.
 *
 * Three things arrive here: an illegal lifecycle edge, publishing a page nobody has written, and removing the
 * last locale of a live page. All three are decided in the database — the first by 0030's transition trigger
 * and the other two by 0085's own guards — so this class reports a refusal it did not make.
 */
export class CmsPageRefusedError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode };

  constructor(code: CmsPageRefusalCode, detail: string) {
    super(detail);
    this.name = 'CmsPageRefusedError';
    this.problem = { status: 409, code };
  }
}

/**
 * The four refusals this surface can report, each decided in the database.
 *
 * The fourth arrived with 0099: a cover image named by an id that is not in the library. 0030's own foreign
 * key refuses it, which is the only existence check on that path.
 */
export type CmsPageRefusalCode =
  | 'CMS_PAGE_LOCALE_REQUIRED'
  | 'CMS_PAGE_TRANSITION_NOT_ALLOWED'
  | 'CMS_PAGE_SLUG_TAKEN'
  | 'CMS_PAGE_COVER_MEDIA_MISSING';

/** An unusable cursor. One code for every way a cursor can fail to be one. */
export class CmsPageCursorInvalidError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 400,
    code: 'VALIDATION_FAILED',
  };

  constructor() {
    super('The cursor could not be read.');
    this.name = 'CmsPageCursorInvalidError';
  }
}

/** Raised when a read or a write could not be performed at all. Becomes a 503. */
export class CmsPageUnavailableError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 503,
    code: 'SERVICE_UNAVAILABLE',
  };

  constructor(cause?: unknown) {
    super('The service is temporarily unavailable.');
    this.name = 'CmsPageUnavailableError';
    if (cause !== undefined) this.cause = cause;
  }
}
