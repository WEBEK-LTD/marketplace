import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { analyticsSessionHash } from '@repo/server-config';
import type { TrackEvent } from '@repo/contracts';
import {
  DURABLE_THROTTLE_COUNTER,
  REDIS_THROTTLE_COUNTER,
  type ThrottleBucket,
  type ThrottleCounter,
} from '../auth/login-throttle.service.js';
import { CurrentUserService } from '../users/current-user.service.js';
import { TrackThrottledError, TrackUnavailableError } from './listing-events.errors.js';
import { LISTING_EVENT_STREAM_PORT, type ListingEventStreamPort } from './listing-events.stream.js';

export const LISTING_EVENT_STORE = Symbol('LISTING_EVENT_STORE');

/** The one database operation ingestion needs: the batched insert, which de-duplicates on `event_id` (0107). */
export interface ListingEventStore {
  recordListingEvents(rows: readonly Record<string, unknown>[]): Promise<number>;
}

/**
 * The ingestion limit (owner decision 5).
 *
 * Thirty requests a minute per address is the approved ceiling. The burst bucket is the same shape the C-1
 * login throttle uses — a short window that stops a single second of traffic spending the whole minute —
 * sized proportionally to that ceiling rather than invented from nothing: ten in ten seconds lets a page
 * flush a few batches in a row and stops a flood.
 *
 * Both are counted on every request, failed or not, so tripping the burst bucket cannot be used to stay
 * under the per-minute count for ever.
 */
export const TRACK_THROTTLE_BUCKETS = Object.freeze({
  ip: Object.freeze({ name: 'track.ip', limit: 30, windowSeconds: 60 }),
  ipBurst: Object.freeze({ name: 'track.ip_burst', limit: 10, windowSeconds: 10 }),
}) satisfies Readonly<Record<string, ThrottleBucket>>;

/**
 * How far back a client may date an event: seven days, in milliseconds.
 *
 * A technical bound on the partition range rather than a business rule — see `occurredAt` below.
 */
export const LISTING_EVENT_BACKDATE_LIMIT_MS = 7 * 24 * 60 * 60 * 1000;

/** How an event reaches the database, for the one line of telemetry ingestion emits. */
export type TrackPath = 'stream' | 'degraded';

export interface TrackIngestInput {
  readonly events: readonly TrackEvent[];
  /** The opaque value this server issued to the browser, or null. Never a digest. */
  readonly sessionId: string | null;
  /** The caller's session token, when they have one. Absent, invalid or expired all mean anonymous. */
  readonly accessToken: string | null;
  /** The request address, or null when it is unknown. */
  readonly requestIp: string | null;
}

/**
 * Listing event ingestion (0101).
 *
 * **Nothing a caller sends decides who they are.** The account comes from their session token and from
 * nowhere else, and the session digest is computed here under the analytics key; the request schema has no
 * field for either, so this is a property of the shape rather than a rule that could be skipped. An
 * anonymous request produces events with no account, which is the normal case for a public catalogue.
 *
 * **An unusable token means anonymous, not refused.** A beacon fires after a page has been open for a while
 * and the token may have expired in between. Refusing the batch would lose the events and teach the client
 * nothing it can act on, so the events are recorded without an account.
 *
 * **The stream first, the database second, a 503 third** (O-21). Both paths are approved; the order is about
 * where the burst lands, not about durability. If both are gone the caller is told, because an accepted
 * response for a dropped event is a lie the client cannot detect and the data cannot be recovered.
 */
@Injectable()
export class ListingEventIngestionService {
  private readonly logger = new Logger(ListingEventIngestionService.name);

  constructor(
    @Inject(LISTING_EVENT_STREAM_PORT) private readonly stream: ListingEventStreamPort | null,
    @Inject(LISTING_EVENT_STORE) private readonly store: ListingEventStore,
    @Inject(REDIS_THROTTLE_COUNTER) private readonly redisCounter: ThrottleCounter | null,
    @Inject(DURABLE_THROTTLE_COUNTER) private readonly durableCounter: ThrottleCounter,
    private readonly users: CurrentUserService,
    @Inject('ANALYTICS_SESSION_KEY') private readonly sessionKey: string,
  ) {}

  /** Accepts a batch, or refuses it. Answers how many events it took responsibility for. */
  async ingest(input: TrackIngestInput): Promise<{ accepted: number; path: TrackPath }> {
    await this.#assertWithinLimits(input.requestIp);

    const userId = await this.#accountFor(input.accessToken);
    const sessionHash = analyticsSessionHash(this.sessionKey, input.sessionId);
    const rows = input.events.map((event) => this.#row(event, userId, sessionHash));

    if (this.stream !== null) {
      try {
        await this.stream.publish(rows);
        return { accepted: rows.length, path: 'stream' };
      } catch {
        // Expected whenever Redis is unreachable or slow. The degraded path is durable, so this is a
        // change of route and not an incident; it is logged without the batch or any identifier in it.
        this.logger.warn('The listing event stream was unavailable; using the degraded direct path.');
      }
    }

    try {
      await this.store.recordListingEvents(rows);
    } catch (error) {
      this.logger.error('Listing events could not be recorded on either path.');
      throw new TrackUnavailableError(error);
    }

    return { accepted: rows.length, path: 'degraded' };
  }

  /**
   * Both buckets, counted, and a refusal if either is over — or if neither counter can answer.
   *
   * The address is hashed before it is counted, so neither Redis nor the durable table holds one.
   */
  async #assertWithinLimits(requestIp: string | null): Promise<void> {
    // No address means no per-address limit to apply. The buckets are skipped rather than shared under a
    // constant subject, which would make every such request compete with every other one.
    if (requestIp === null || requestIp === '') return;

    const subject = createHash('sha256').update(`track-ip-v1:${requestIp}`).digest();
    let allowed = true;

    for (const bucket of [TRACK_THROTTLE_BUCKETS.ip, TRACK_THROTTLE_BUCKETS.ipBurst]) {
      if (!(await this.#count(bucket, subject))) allowed = false;
    }

    if (!allowed) throw new TrackThrottledError();
  }

  /** Redis first, the durable PostgreSQL counter second, and a refusal if neither answers. */
  async #count(bucket: ThrottleBucket, subject: Buffer): Promise<boolean> {
    if (this.redisCounter !== null) {
      try {
        return await this.redisCounter.hit(bucket.name, subject, bucket.windowSeconds, bucket.limit);
      } catch {
        this.logger.warn('The Redis ingestion counter was unavailable; using the durable counter.');
      }
    }

    try {
      return await this.durableCounter.hit(bucket.name, subject, bucket.windowSeconds, bucket.limit);
    } catch {
      // Never fail open. A counter that cannot be read is not a counter that says zero.
      this.logger.error('No ingestion rate counter could answer; refusing the batch.');
      throw new TrackThrottledError();
    }
  }

  /**
   * When the event happened, bounded to a range that has a partition.
   *
   * A batch is flushed after the fact, so a timestamp slightly in the past is normal and is kept. Two cases
   * are not kept, and both are **clamped to now rather than refused**, because one odd timestamp must not
   * cost a whole batch of otherwise good events:
   *
   *   * the future, which would target a partition that does not exist yet;
   *   * further back than the window below, which would target one that retention has already dropped.
   *
   * The seven days is a **technical bound on the partition range, not a business rule**: it is far inside the
   * ninety-day retention window, so a partition always exists, and far outside any real flush delay, so no
   * genuine event is moved.
   */
  static occurredAt(supplied: string | undefined): string {
    const now = Date.now();
    if (supplied === undefined) return new Date(now).toISOString();
    const at = Date.parse(supplied);
    if (!Number.isFinite(at)) return new Date(now).toISOString();
    if (at > now) return new Date(now).toISOString();
    if (at < now - LISTING_EVENT_BACKDATE_LIMIT_MS) return new Date(now).toISOString();
    return new Date(at).toISOString();
  }

  /** The account, from the token and from nothing else. Anything unusable is anonymous. */
  async #accountFor(accessToken: string | null): Promise<string | null> {
    if (accessToken === null || accessToken === '') return null;
    try {
      const user = await this.users.forToken(accessToken);
      return user.id;
    } catch {
      return null;
    }
  }

  /**
   * One row in the shape `app_private.record_listing_events` reads.
   *
   * `seller_user_id` is deliberately absent: 0013 lets it be null and the seller of a listing is a fact the
   * database already holds, so asking a browser for it would be asking a browser to assert somebody else's
   * identity. A later rollup joins it.
   */
  #row(event: TrackEvent, userId: string | null, sessionHash: string | null): Record<string, unknown> {
    return {
      event_id: event.eventId,
      listing_id: event.listingId,
      event_type: event.eventType,
      occurred_at: ListingEventIngestionService.occurredAt(event.occurredAt),
      user_id: userId,
      session_hash: sessionHash,
      source: event.source ?? null,
      referrer_host: event.referrerHost ?? null,
      promotion_id: event.promotionId ?? null,
    };
  }
}
