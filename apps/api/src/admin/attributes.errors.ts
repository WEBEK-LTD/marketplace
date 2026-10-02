import type { ProblemCode } from '@repo/contracts';

/**
 * Failures on the admin attribute and tag surfaces.
 *
 * **A refusal and an absence are the same answer**, exactly as on the category surface: an attribute, option or
 * tag that does not exist and a caller who lacks the manage key both get `NOT_FOUND`. There is no separate read
 * key on either vocabulary — none was invented for this increment — so the database answers a caller without the
 * manage key with `42501` on reads and writes alike, and turning that into a 403 would make the console a way to
 * ask what exists without being allowed to see it.
 */
export class VocabularyNotFoundError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 404,
    code: 'NOT_FOUND',
  };

  constructor() {
    super('No attribute, option or tag was found.');
    this.name = 'VocabularyNotFoundError';
  }
}

/** The refusals migrations 0010 and 0011 raise on this surface, each with its own code and sentence. */
export type VocabularyRefusalCode =
  | 'ATTRIBUTE_KEY_TAKEN'
  | 'ATTRIBUTE_NOT_ANSWERABLE'
  | 'ATTRIBUTE_VALUE_NOT_ALLOWED';

/**
 * The thing exists and the change was refused.
 *
 * 409 rather than 400: the request was well formed and the state of the vocabulary is what refused it, so
 * repeating it unchanged will not help while that state holds.
 */
export class VocabularyRefusedError extends Error {
  readonly problem: { readonly status: number; readonly code: VocabularyRefusalCode };

  constructor(code: VocabularyRefusalCode, detail: string) {
    super(detail);
    this.name = 'VocabularyRefusedError';
    this.problem = { status: 409, code };
  }
}

/**
 * The vocabulary could not be read or written.
 *
 * Separate from a refusal on purpose: a console told "that is not allowed" when the truth is "we could not ask"
 * has been given a wrong answer rather than an honest failure.
 */
export class VocabularyUnavailableError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 503,
    code: 'SERVICE_UNAVAILABLE',
  };

  constructor(cause?: unknown) {
    super('The service is temporarily unavailable.');
    this.name = 'VocabularyUnavailableError';
    if (cause !== undefined) this.cause = cause;
  }
}
