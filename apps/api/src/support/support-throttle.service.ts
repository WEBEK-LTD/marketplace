import { Inject, Injectable, Logger } from '@nestjs/common';
import { EnforcementUnavailableError } from '../auth/auth-errors.js';
import {
  DURABLE_THROTTLE_COUNTER,
  REDIS_THROTTLE_COUNTER,
  type ThrottleBucket,
  type ThrottleCounter,
} from '../auth/login-throttle.service.js';
import { SupportThrottledError } from './support.errors.js';

/**
 * The support rate limits, requester side (Phase 7-K, owner Decision 1).
 *
 * **This is not a second limiter.** It injects the same two counters the login throttle, the messaging
 * throttle and the seller throttle inject — the Redis fixed window and the durable
 * `app_private.rate_limit_hit` of migration 0004 — counts in the same aligned windows, falls back in the
 * same order and fails closed the same way. What is new is **three buckets and nothing else**: the
 * mechanism is shared, the numbers are per surface, and no migration was required because a bucket name is
 * free text to `app_private.rate_limits` (`^[a-z][a-z0-9_.]*$`).
 *
 * **Fail closed, in the same order.** Redis first, because it is shared across API instances and cheap. If
 * Redis cannot answer, the durable counter decides, continuing the same window rather than opening a fresh
 * allowance. If the durable counter cannot answer either, the request is refused — a counter that cannot be
 * read is not a counter that says zero, and an attacker who can take Redis down must not thereby remove the
 * limit.
 *
 * **The subject is the caller's own account, hashed.** It is the account the provider vouched for, never a
 * value from a request, and it is hashed with the same `hashIdentifier` every other bucket uses, so Redis
 * holds no identifier. Two accounts therefore have two counters, and nothing a browser can send changes
 * which counter it is counted against.
 *
 * **Attachment authorization is not here.** Owner Decision 1 puts it on 6-E's existing storage limiter
 * rather than a second storage-specific one, so `SupportService` calls `SellerThrottleService` for that
 * step and this file has no storage bucket at all.
 *
 * **Reads are not limited.** No reader on this surface passes through this service, by Decision 1.
 */

/** The approved numbers, and nothing derived from them. */
export const SUPPORT_THROTTLE_BUCKETS = Object.freeze({
  /**
   * Opening a ticket: five per account per **24 hours**, successful or not.
   *
   * A day, not an hour — the same shape as 6-I's verification submission, and written out rather than as
   * `24 * 3600` so the approved number is legible as itself.
   */
  openTicket: Object.freeze({ name: 'support_ticket_open', limit: 5, windowSeconds: 86_400 }),
  /** Messages, per minute. The burst window. */
  messageMinute: Object.freeze({ name: 'support_message_minute', limit: 30, windowSeconds: 60 }),
  /** Messages, per hour. The sustained window. */
  messageHour: Object.freeze({ name: 'support_message_hour', limit: 300, windowSeconds: 3600 }),
}) satisfies Readonly<Record<string, ThrottleBucket>>;

@Injectable()
export class SupportThrottleService {
  private readonly logger = new Logger(SupportThrottleService.name);

  constructor(
    @Inject(REDIS_THROTTLE_COUNTER) private readonly redis: ThrottleCounter | null,
    @Inject(DURABLE_THROTTLE_COUNTER) private readonly durable: ThrottleCounter,
  ) {}

  /** One attempt to open a ticket: five per account per 24 hours, successful or not. */
  async assertCanOpenTicket(subject: Buffer): Promise<void> {
    await this.#assert([SUPPORT_THROTTLE_BUCKETS.openTicket], subject);
  }

  /**
   * One message attempt, against both windows.
   *
   * Both are counted even when the first has already rejected: a refused request still happened, and not
   * counting it would let a client stay under the hourly limit forever by tripping the per-minute one.
   * That is 5-E's reasoning, applied to 5-E's own two numbers.
   */
  async assertCanPostMessage(subject: Buffer): Promise<void> {
    await this.#assert(
      [SUPPORT_THROTTLE_BUCKETS.messageMinute, SUPPORT_THROTTLE_BUCKETS.messageHour],
      subject,
    );
  }

  async #assert(buckets: readonly ThrottleBucket[], subject: Buffer): Promise<void> {
    let rejected: string | null = null;
    for (const bucket of buckets) {
      const allowed = await this.#count(bucket, subject);
      if (!allowed && rejected === null) rejected = bucket.name;
    }
    if (rejected !== null) throw new SupportThrottledError(rejected);
  }

  async #count(bucket: ThrottleBucket, subject: Buffer): Promise<boolean> {
    if (this.redis !== null) {
      try {
        return await this.redis.hit(bucket.name, subject, bucket.windowSeconds, bucket.limit);
      } catch {
        // Expected and handled: the durable counter is the approved fallback. The line carries no
        // subject and no address.
        this.logger.warn(`Redis throttle counter unavailable for ${bucket.name}; using the durable counter.`);
      }
    }

    try {
      return await this.durable.hit(bucket.name, subject, bucket.windowSeconds, bucket.limit);
    } catch (error) {
      this.logger.error('Durable throttle counter unavailable; refusing the support request.');
      throw new EnforcementUnavailableError(error);
    }
  }
}
