import type { ProblemCode } from '@repo/contracts';

/**
 * Failures on the public SEO surface.
 *
 * One class, because this surface has exactly one way to fail. There is no permission to refuse and no row
 * that could be missing: an empty catalogue is an empty array, nothing authored is a null, and a page past the
 * end of a set is an empty page. Everything that is left is the database being unreachable.
 *
 * A 503 rather than an empty document matters more here than it looks. An empty sitemap served with a 200 tells
 * a crawler that the site has no pages, and that is a statement it may act on; a 503 tells it to come back.
 */
export class SeoUnavailableError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 503,
    code: 'SERVICE_UNAVAILABLE',
  };

  constructor(cause?: unknown) {
    super('The service is temporarily unavailable.');
    this.name = 'SeoUnavailableError';
    if (cause !== undefined) this.cause = cause;
  }
}
