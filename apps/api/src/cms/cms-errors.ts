import type { ProblemCode } from '@repo/contracts';

/**
 * Failures on the public CMS surface.
 *
 * One class, because the public surface has one way to fail that is not an absence. A page that does not exist
 * is a 404 raised by the controller from the reader's own answer; everything else is this.
 *
 * A 503 rather than an empty answer is the whole point: a visitor told that the terms of service do not exist,
 * when in truth the database could not be read, has been given a wrong answer rather than an honest failure.
 */
export class CmsPublicUnavailableError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 503,
    code: 'SERVICE_UNAVAILABLE',
  };

  constructor(cause?: unknown) {
    super('The service is temporarily unavailable.');
    this.name = 'CmsPublicUnavailableError';
    if (cause !== undefined) this.cause = cause;
  }
}
