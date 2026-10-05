import { z } from 'zod';

/**
 * Batched listing analytics ingestion (0101).
 *
 * **The four V1 event types, and only those** (owner decision 2). 0013's column constraint permits six;
 * `impression` and `view` are deliberately absent here, because the impression definition — visibility
 * threshold and dedupe window — is a Phase 9 decision and Phase 6-J recorded the same gap for views.
 * Sending either is a validation failure rather than a silently dropped event, so nothing starts collecting
 * data under a definition nobody has agreed.
 *
 * **What this request cannot carry.** There is no `userId` and no `sessionHash` field, and the schema is
 * strict, so neither can be smuggled in:
 *
 *   * the account is taken from the authenticated request context and from nowhere else (owner decision 6),
 *     and an unauthenticated request simply produces events with no account;
 *   * the session digest is computed on the server from the opaque session identifier, under a dedicated
 *     domain-separated key, so a caller cannot choose what lands in `listing_events.session_hash`
 *     (owner decision 4).
 *
 * A caller can therefore describe *what happened to which listing*, and nothing about *who they are*.
 */

/** The four event types this increment ingests. A discrete user action, each of them. */
export const TRACK_EVENT_TYPES = ['click', 'contact', 'favorite', 'share'] as const;
export type TrackEventType = (typeof TRACK_EVENT_TYPES)[number];
export const TrackEventTypeSchema = z.enum(TRACK_EVENT_TYPES);

/** Where the event happened, matching 0013's own `source` constraint exactly. */
export const TRACK_SOURCES = ['search', 'category', 'listing', 'seller', 'home', 'external'] as const;
export type TrackSource = (typeof TRACK_SOURCES)[number];
export const TrackSourceSchema = z.enum(TRACK_SOURCES);

/**
 * The most events one request may carry (owner decision 5).
 *
 * Fifty is the approved ceiling. A batch over it is refused whole rather than truncated: truncating would
 * silently lose events and teach a client that oversending works.
 */
export const TRACK_MAX_EVENTS = 50;

/** 0013's own bound on `referrer_host`. */
export const TRACK_REFERRER_HOST_MAX = 255;

/**
 * One event.
 *
 * `eventId` is the client's idempotency key and the only reason at-least-once delivery is safe: the database
 * de-duplicates on it — on `event_id` alone, in `public.listing_event_ids` (0107) — so a retried batch inserts
 * nothing twice however its `occurredAt` was stamped. It is a uuid the browser generates per event, not per
 * request.
 *
 * `occurredAt` is optional and may be earlier than the request, because a batch is flushed after the fact —
 * that is the point of batching. It may not be in the future, which would let a client write into a
 * partition that does not exist yet.
 */
export const TrackEventSchema = z
  .object({
    eventId: z.string().uuid(),
    listingId: z.string().uuid(),
    eventType: TrackEventTypeSchema,
    occurredAt: z.string().datetime().optional(),
    source: TrackSourceSchema.optional(),
    referrerHost: z.string().max(TRACK_REFERRER_HOST_MAX).optional(),
    promotionId: z.string().uuid().optional(),
  })
  .strict()
  .openapi('TrackEvent');

/**
 * A batch.
 *
 * `sessionId` is the opaque value this server issued to the browser, carried back so two events can be known
 * to belong to one visit. It is **not** a digest and is never stored as given: the API hashes it under the
 * analytics key. A malformed one is treated as absent rather than refused, so a cleared cookie costs a
 * session boundary and not a dropped batch.
 */
export const TrackRequestSchema = z
  .object({
    sessionId: z.string().min(1).max(64).nullable().optional(),
    events: z.array(TrackEventSchema).min(1).max(TRACK_MAX_EVENTS),
  })
  .strict()
  .openapi('TrackRequest');

/**
 * What ingestion answers.
 *
 * `accepted` is how many events the request carried that the server took responsibility for — not how many
 * rows were written, because de-duplication happens later and a retry legitimately writes none. A client has
 * no use for the row count and giving it one would invite it to retry on a zero.
 */
export const TrackResponseSchema = z
  .object({
    accepted: z.number().int().min(0),
  })
  .strict()
  .openapi('TrackResponse');

export type TrackEvent = z.infer<typeof TrackEventSchema>;
export type TrackRequest = z.infer<typeof TrackRequestSchema>;
export type TrackResponse = z.infer<typeof TrackResponseSchema>;
