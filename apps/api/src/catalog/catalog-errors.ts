import type { ProblemCode } from '@repo/contracts';

/**
 * Catalogue failures (Phase 4-A).
 *
 * The approved status set for the public catalogue is 200, 500 and 503 and nothing else, so there is
 * exactly one error class here. A database that cannot answer becomes 503; anything unforeseen falls
 * through to the filter's 500 without this file's help.
 *
 * The error declares its own problem, which is how every other error in this API reaches the
 * problem-details filter. The cause is kept for logging and never reaches the response: a visitor
 * browsing categories learns that the catalogue is unavailable and nothing about why.
 */
export class CatalogUnavailableError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 503,
    code: 'SERVICE_UNAVAILABLE',
  };

  constructor(override readonly cause: unknown) {
    super('The service is temporarily unavailable.');
    this.name = 'CatalogUnavailableError';
  }
}
