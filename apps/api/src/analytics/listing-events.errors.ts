import type { ProblemCode } from '@repo/contracts';

/**
 * Ingestion failures (0101).
 *
 * There are only two, and the absence of a third is deliberate: ingestion never reports whether a listing
 * exists, whether an event was a duplicate, or how many rows were written. A beacon that could ask those
 * questions would be a public read surface over the catalogue and over other people's traffic.
 */

/**
 * Over the rate limit (owner decision 5).
 *
 * `/v1/track` is reachable without a session, which makes it the one write surface anonymous traffic can
 * reach, so the limit is aggressive and **fails closed**: if neither the Redis counter nor the durable
 * PostgreSQL counter can answer, the request is refused rather than allowed. An attacker who can take Redis
 * down must not thereby remove the limit.
 */
export class TrackThrottledError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 429,
    code: 'TOO_MANY_REQUESTS',
  };

  constructor() {
    super('Too many requests.');
    this.name = 'TrackThrottledError';
  }
}

/**
 * Neither the stream nor the degraded direct path could take the batch.
 *
 * O-21 approves both, and this is what it looks like when both are gone: a 503, not a silent success. A
 * client that is told its events were accepted when they were dropped will not retry, and the events are
 * unbackfillable.
 */
export class TrackUnavailableError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 503,
    code: 'SERVICE_UNAVAILABLE',
  };

  constructor(cause?: unknown) {
    super('The service is temporarily unavailable.');
    this.name = 'TrackUnavailableError';
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * A list position this API did not issue (0102).
 *
 * One code for a malformed cursor, an altered one, one of the wrong kind and one from a retired version: the
 * remedy is the same in all four — drop it and start again — and naming which check failed would help only
 * somebody probing the format.
 */
export class ListingAnalyticsCursorInvalidError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 400,
    code: 'LISTING_ANALYTICS_CURSOR_INVALID',
  };

  constructor() {
    super('The list position could not be used.');
    this.name = 'ListingAnalyticsCursorInvalidError';
  }
}

/**
 * The rollup could not be read at all (0102).
 *
 * A 503 rather than an empty page: an empty page is a real answer here — it is what a caller who may not read
 * receives — so reporting a failure as one would be indistinguishable from a refusal and from a quiet window.
 */
export class ListingAnalyticsUnavailableError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 503,
    code: 'SERVICE_UNAVAILABLE',
  };

  constructor(cause?: unknown) {
    super('The service is temporarily unavailable.');
    this.name = 'ListingAnalyticsUnavailableError';
    if (cause !== undefined) this.cause = cause;
  }
}
