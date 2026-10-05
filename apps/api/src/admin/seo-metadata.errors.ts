import type { ProblemCode } from '@repo/contracts';

/**
 * Metadata-override failures.
 *
 * **There is no "forbidden" here.** An entry that does not exist, and a caller who does not hold
 * `seo.metadata.read` at `aal2`, both become {@link SeoMetadataNotFoundError} — identical in status, code and
 * sentence, like every other admin surface in this console.
 *
 * **The refusal class is separate**, because a write refusal is not an absence: an operator who may change the
 * overrides and is told that a directive set contradicts itself has learned nothing they were not entitled to know,
 * and hiding it behind a 404 would leave them no way to fix it.
 */

/** Nothing here for this caller. One answer for absence and for a missing permission. */
export class SeoMetadataNotFoundError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 404,
    code: 'NOT_FOUND',
  };

  constructor() {
    super('The requested resource was not found.');
    this.name = 'SeoMetadataNotFoundError';
  }
}

/**
 * The caller may change the overrides and the change itself is refused.
 *
 * Both reasons are migration 0030's constraints — an entry that is not a legal one, or a locale or share image that
 * names no row — so this class reports a refusal it did not make.
 */
export class SeoMetadataRefusedError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode };

  constructor(code: SeoMetadataRefusalCode, detail: string) {
    super(detail);
    this.name = 'SeoMetadataRefusedError';
    this.problem = { status: 409, code };
  }
}

/** The two refusals this surface can report, both decided in the database. */
export type SeoMetadataRefusalCode = 'SEO_METADATA_NOT_ALLOWED' | 'SEO_METADATA_TARGET_UNKNOWN';

/** An unusable cursor. One code for every way a cursor can fail to be one. */
export class SeoMetadataCursorInvalidError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 400,
    code: 'VALIDATION_FAILED',
  };

  constructor() {
    super('The cursor could not be read.');
    this.name = 'SeoMetadataCursorInvalidError';
  }
}

/** Raised when a read or a write could not be performed at all. Becomes a 503. */
export class SeoMetadataUnavailableError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 503,
    code: 'SERVICE_UNAVAILABLE',
  };

  constructor(cause?: unknown) {
    super('The service is temporarily unavailable.');
    this.name = 'SeoMetadataUnavailableError';
    if (cause !== undefined) this.cause = cause;
  }
}
