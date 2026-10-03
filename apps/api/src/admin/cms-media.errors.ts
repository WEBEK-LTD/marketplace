import type { ProblemCode } from '@repo/contracts';

/**
 * CMS media library failures (0098).
 *
 * **There is no "forbidden" here.** A caller who does not hold `cms.media.manage` at `aal2`, and an entry that does
 * not exist, both become {@link CmsMediaNotFoundError} — identical in status, code and sentence. Every admin surface
 * in this console follows that rule: a distinguishable refusal is a way to ask whether something exists.
 *
 * This surface has one key, so the not-found answer covers reads and writes alike.
 *
 * **The refusal class is separate**, because a write refused by the bucket or by one of 0030's constraints is not an
 * absence. A caller who may manage the library and is told that an SVG is not allowed has learned nothing they did
 * not already have the right to know.
 *
 * **Storage being unreachable is its own 503**, and it is deliberately not folded into anything else: a signed URL
 * could not be issued, an object could not be checked, or the provider could not be reached. None of those is a
 * refusal and none is an absence — the honest answer is "come back".
 */

/** Nothing here for this caller. One answer for absence and for a missing permission. */
export class CmsMediaNotFoundError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 404,
    code: 'NOT_FOUND',
  };

  constructor() {
    super('The requested resource was not found.');
    this.name = 'CmsMediaNotFoundError';
  }
}

/**
 * The caller may manage the library and the operation itself is refused.
 *
 * Three things arrive here, each decided somewhere this API does not own: the bucket's own type and size rules
 * (which is how SVG is refused), 0030's column constraints, and the path shape the authorizer issues.
 */
export class CmsMediaRefusedError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode };

  constructor(code: CmsMediaRefusalCode, detail: string) {
    super(detail);
    this.name = 'CmsMediaRefusedError';
    this.problem = { status: 409, code };
  }
}

/** The three refusals this surface can report, none of them decided here. */
export type CmsMediaRefusalCode = 'CMS_MEDIA_NOT_ALLOWED' | 'CMS_MEDIA_OBJECT_MISSING' | 'CMS_MEDIA_PATH_TAKEN';

/**
 * Raised when a read, a write or a provider call could not be performed at all. Becomes a 503.
 *
 * Failure-safe by construction: every path that cannot complete ends here, so a failure to sign an upload is "no
 * upload" rather than an upload nobody authorized, and a failure to check an object is "not recorded" rather than a
 * row pointing at nothing.
 */
export class CmsMediaUnavailableError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 503,
    code: 'SERVICE_UNAVAILABLE',
  };

  constructor(cause?: unknown) {
    super('The service is temporarily unavailable.');
    this.name = 'CmsMediaUnavailableError';
    if (cause !== undefined) this.cause = cause;
  }
}
