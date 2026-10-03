import type { ProblemCode } from '@repo/contracts';

/**
 * Site-wide SEO settings failures (0096).
 *
 * **There is no "forbidden" here.** A caller who does not hold `seo.settings.manage` at `aal2`, and a locale that
 * is not an active locale, both become {@link SeoSettingsNotFoundError} — identical in status, code and sentence.
 * Every admin surface in this console follows that rule: a distinguishable refusal is a way to ask whether
 * something exists.
 *
 * This surface has one key, so the not-found answer covers reads and writes alike: a caller who can read these
 * settings can change them, and a caller who cannot gets the same absence from every route.
 *
 * **The refusal class is separate**, because a write refused by one of 0030's own constraints is not an absence. A
 * caller who may author the site's defaults and is told that a handle is malformed has learned nothing they did not
 * already have the right to know.
 */

/** Nothing here for this caller. One answer for absence and for a missing permission. */
export class SeoSettingsNotFoundError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 404,
    code: 'NOT_FOUND',
  };

  constructor() {
    super('The requested resource was not found.');
    this.name = 'SeoSettingsNotFoundError';
  }
}

/**
 * The locale exists, the caller may author it, and the change itself is refused.
 *
 * Everything that arrives here is decided in the database by one of 0030's five constraints — a site name that is
 * blank or too long, a default title or description past its bound, a handle that is not the column's format, an
 * organization document that is not a JSON object — or by the foreign key to `cms_media`. This class reports a
 * refusal it did not make.
 */
export class SeoSettingsRefusedError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode };

  constructor(code: SeoSettingsRefusalCode, detail: string) {
    super(detail);
    this.name = 'SeoSettingsRefusedError';
    this.problem = { status: 409, code };
  }
}

/** The two refusals this surface can report, each decided in the database. */
export type SeoSettingsRefusalCode = 'SEO_SETTINGS_NOT_ALLOWED' | 'SEO_SETTINGS_MEDIA_MISSING';

/** Raised when a read or a write could not be performed at all. Becomes a 503. */
export class SeoSettingsUnavailableError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 503,
    code: 'SERVICE_UNAVAILABLE',
  };

  constructor(cause?: unknown) {
    super('The service is temporarily unavailable.');
    this.name = 'SeoSettingsUnavailableError';
    if (cause !== undefined) this.cause = cause;
  }
}
