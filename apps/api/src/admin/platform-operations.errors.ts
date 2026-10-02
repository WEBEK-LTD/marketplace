import type { ProblemCode } from '@repo/contracts';

/**
 * Platform operations failures, the admin side (Phase 7-Q).
 *
 * Each declares the problem it becomes, which is how every other error in this API reaches the
 * problem-details filter.
 *
 * **There is no "forbidden" here.** A job run that does not exist, and a caller who does not hold
 * `platform.job.read` at `aal2`, both become {@link PlatformNotFoundError} — identical in status, code and
 * sentence. That is the rule every admin surface in Phase 7 follows, and it holds for the same reason: a
 * distinguishable refusal is a way to ask whether a row exists. It matters here because only Admin and Super
 * Admin hold the key, so a distinguishable refusal would also tell a Moderator or a Support Agent that this
 * section exists and has something in it.
 *
 * **There is no conflict error in this file, and no error naming an operation that was refused**, because
 * nothing on this surface operates on anything. No retry, no cancel, no requeue, no replay — so none of the
 * refusals such a thing could produce has a class here. If somebody later adds one of those controls, they
 * will have to add its refusal too, which is the point at which this file should stop being this short.
 */

/** Nothing here for this caller. One answer for absence and for a missing permission. */
export class PlatformNotFoundError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 404,
    code: 'NOT_FOUND',
  };

  constructor() {
    super('The requested resource was not found.');
    this.name = 'PlatformNotFoundError';
  }
}

/** An unusable cursor. One code for every way a cursor can fail to be one. */
export class PlatformCursorInvalidError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 400,
    code: 'VALIDATION_FAILED',
  };

  constructor() {
    super('The cursor could not be read.');
    this.name = 'PlatformCursorInvalidError';
  }
}

/** Raised when a read could not be performed at all. Becomes a 503. */
export class PlatformUnavailableError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 503,
    code: 'SERVICE_UNAVAILABLE',
  };

  constructor(cause?: unknown) {
    super('The service is temporarily unavailable.');
    this.name = 'PlatformUnavailableError';
    if (cause !== undefined) this.cause = cause;
  }
}
