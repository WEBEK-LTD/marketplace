import type { ProblemCode } from '@repo/contracts';

/**
 * Site settings failures (0113).
 *
 * **There is no "forbidden" here**, and no "unknown key" either. A caller who does not hold
 * `settings.site.manage` at `aal2`, and a key that names no setting, both become
 * {@link SiteSettingsNotFoundError} — identical in status, code and sentence. Every admin surface in this
 * console follows that rule: a distinguishable refusal is a way to ask whether something exists.
 *
 * That the two answers are the same is also what makes this surface safe to expose. The console cannot create
 * a setting, so "unknown key" is not an error state a caller should be able to probe for; it is an absence.
 *
 * **The refusal class is separate**, because a value of the wrong type is not an absence. A caller who may edit
 * these settings and is told that a number was sent where a string was declared has learned nothing they did
 * not already have the right to know.
 */

/** Nothing here for this caller: no such setting, or no permission. One answer for both. */
export class SiteSettingsNotFoundError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 404,
    code: 'NOT_FOUND',
  };

  constructor() {
    super('The requested resource was not found.');
    this.name = 'SiteSettingsNotFoundError';
  }
}

/**
 * The setting exists, the caller may change it, and the value itself is refused.
 *
 * Decided in the database: either the writer's own type test or 0008's
 * `site_settings_value_matches_type`. This class reports a refusal it did not make.
 */
export class SiteSettingsRefusedError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 409,
    code: 'SITE_SETTING_NOT_ALLOWED',
  };

  constructor(detail: string) {
    super(detail);
    this.name = 'SiteSettingsRefusedError';
  }
}

/** Raised when a read or a write could not be performed at all. Becomes a 503. */
export class SiteSettingsUnavailableError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 503,
    code: 'SERVICE_UNAVAILABLE',
  };

  constructor(cause?: unknown) {
    super('The service is temporarily unavailable.');
    this.name = 'SiteSettingsUnavailableError';
    if (cause !== undefined) this.cause = cause;
  }
}
