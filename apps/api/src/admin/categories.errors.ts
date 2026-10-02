import type { ProblemCode } from '@repo/contracts';

/**
 * Failures on the admin category surface.
 *
 * **A refusal and an absence are the same answer.** A category that does not exist, and a caller who holds
 * `catalog.category.read` but not `catalog.category.manage` attempting a write, both get `NOT_FOUND`. The
 * database answers the second with `42501`, and turning that into a 403 would make the console a way to ask which
 * categories exist without being allowed to see them.
 */
export class CategoryNotFoundError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 404,
    code: 'NOT_FOUND',
  };

  constructor() {
    super('No category was found.');
    this.name = 'CategoryNotFoundError';
  }
}

/** The refusals migration 0010's own rules raise, each mapped to its own code and its own sentence. */
export type CategoryRefusalCode =
  | 'CATEGORY_TREE_NOT_ALLOWED'
  | 'CATEGORY_SLUG_TAKEN'
  | 'CATEGORY_NAME_REQUIRED'
  | 'CATEGORY_VALUE_NOT_ALLOWED';

/**
 * The category exists and the change was refused.
 *
 * 409 rather than 400: the request was well formed and the state of the tree is what refused it, so repeating it
 * unchanged will not help while that state holds.
 */
export class CategoryRefusedError extends Error {
  readonly problem: { readonly status: number; readonly code: CategoryRefusalCode };

  constructor(code: CategoryRefusalCode, detail: string) {
    super(detail);
    this.name = 'CategoryRefusedError';
    this.problem = { status: 409, code };
  }
}

/**
 * The tree could not be read or written.
 *
 * Separate from a refusal on purpose: a console told "that is not allowed" when the truth is "we could not ask"
 * has been given a wrong answer rather than an honest failure.
 */
export class CategoryUnavailableError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 503,
    code: 'SERVICE_UNAVAILABLE',
  };

  constructor(cause?: unknown) {
    super('The service is temporarily unavailable.');
    this.name = 'CategoryUnavailableError';
    if (cause !== undefined) this.cause = cause;
  }
}
