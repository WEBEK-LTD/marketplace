import type { ProblemCode } from '@repo/contracts';

/**
 * Blog authoring failures (0092).
 *
 * **There is no "forbidden" here.** A post that does not exist, and a caller who does not hold
 * `cms.blog.read` at `aal2`, both become {@link BlogNotFoundError} — identical in status, code and sentence.
 * Every admin surface in this console follows that rule, for the same reason: a distinguishable refusal is a
 * way to ask whether a row exists, and here it would also tell a Moderator or a Support Agent that an
 * unpublished post is sitting in the console.
 *
 * **The refusal class is separate from the not-found class**, because this surface has writes and their
 * refusals are not absences. A caller who may manage the blog and is told that a published post cannot lose its
 * last locale has learned nothing they did not already have the right to know, and hiding it behind a 404 would
 * make the console unusable.
 */

/** Nothing here for this caller. One answer for absence and for a missing permission. */
export class BlogNotFoundError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 404,
    code: 'NOT_FOUND',
  };

  constructor() {
    super('The requested resource was not found.');
    this.name = 'BlogNotFoundError';
  }
}

/**
 * The post exists, the caller may change it, and the change itself is refused.
 *
 * Four things arrive here: an illegal lifecycle edge or a constraint such as featuring an unpublished post,
 * publishing a post nobody has written, removing the last locale of a live post, and an address that belongs to
 * another post's history. All four are decided in the database — by 0030's constraints and triggers or by
 * 0092's own guards — so this class reports a refusal it did not make.
 */
export class BlogRefusedError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode };

  constructor(code: BlogRefusalCode, detail: string) {
    super(detail);
    this.name = 'BlogRefusedError';
    this.problem = { status: 409, code };
  }
}

/** The four refusals this surface can report, each decided in the database. */
export type BlogRefusalCode =
  | 'BLOG_LOCALE_REQUIRED'
  | 'BLOG_CHANGE_NOT_ALLOWED'
  | 'BLOG_SLUG_TAKEN'
  | 'BLOG_REFERENCE_UNKNOWN';

/** An unusable cursor. One code for every way a cursor can fail to be one. */
export class BlogCursorInvalidError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 400,
    code: 'VALIDATION_FAILED',
  };

  constructor() {
    super('The cursor could not be read.');
    this.name = 'BlogCursorInvalidError';
  }
}

/** Raised when a read or a write could not be performed at all. Becomes a 503. */
export class BlogUnavailableError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 503,
    code: 'SERVICE_UNAVAILABLE',
  };

  constructor(cause?: unknown) {
    super('The service is temporarily unavailable.');
    this.name = 'BlogUnavailableError';
    if (cause !== undefined) this.cause = cause;
  }
}
