import { Inject, Injectable, Logger } from '@nestjs/common';
import { EnforcementUnavailableError } from '../auth/auth-errors.js';
import {
  DURABLE_THROTTLE_COUNTER,
  REDIS_THROTTLE_COUNTER,
  type ThrottleBucket,
  type ThrottleCounter,
} from '../auth/login-throttle.service.js';
import { MessagingThrottledError } from './messaging-errors.js';

/**
 * The messaging rate limits (Phase 5-E).
 *
 * **This is not a second limiter.** It injects the same two counters the login throttle uses — the Redis
 * fixed window and the durable `app_private.rate_limit_hit` — counts in the same aligned windows, and
 * falls back and fails closed the same way. What is new is three buckets, exactly as the login buckets
 * are three buckets: the mechanism is shared, the numbers are per surface.
 *
 * **Fail closed, in the same order.** Redis first because it is shared across API instances and cheap. If
 * Redis cannot answer, the durable counter decides, continuing the same window rather than starting a
 * fresh allowance. If the durable counter cannot answer either, the request is refused. A counter that
 * cannot be read is not a counter that says zero — an attacker who can take Redis down must not thereby
 * remove the limit.
 *
 * The subject is the caller's own account, hashed, so Redis holds no identifier.
 */

/** The approved numbers, and nothing derived from them. */
export const MESSAGING_THROTTLE_BUCKETS = Object.freeze({
  startConversation: Object.freeze({ name: 'messaging_start_conversation', limit: 10, windowSeconds: 3600 }),
  sendMinute: Object.freeze({ name: 'messaging_send_minute', limit: 30, windowSeconds: 60 }),
  sendHour: Object.freeze({ name: 'messaging_send_hour', limit: 300, windowSeconds: 3600 }),
  report: Object.freeze({ name: 'messaging_report', limit: 10, windowSeconds: 3600 }),
}) satisfies Readonly<Record<string, ThrottleBucket>>;

@Injectable()
export class MessagingThrottleService {
  private readonly logger = new Logger(MessagingThrottleService.name);

  constructor(
    @Inject(REDIS_THROTTLE_COUNTER) private readonly redis: ThrottleCounter | null,
    @Inject(DURABLE_THROTTLE_COUNTER) private readonly durable: ThrottleCounter,
  ) {}

  /** One conversation-start attempt. */
  async assertCanStartConversation(subject: Buffer): Promise<void> {
    await this.#assert([MESSAGING_THROTTLE_BUCKETS.startConversation], subject);
  }

  /** One report attempt. */
  async assertCanFileReport(subject: Buffer): Promise<void> {
    await this.#assert([MESSAGING_THROTTLE_BUCKETS.report], subject);
  }

  /**
   * One send attempt, against both windows.
   *
   * Both are counted even when the first has already rejected: a refused request still happened, and not
   * counting it would let a client stay under the hourly limit forever by tripping the per-minute one.
   */
  async assertCanSendMessage(subject: Buffer): Promise<void> {
    await this.#assert([MESSAGING_THROTTLE_BUCKETS.sendMinute, MESSAGING_THROTTLE_BUCKETS.sendHour], subject);
  }

  async #assert(buckets: readonly ThrottleBucket[], subject: Buffer): Promise<void> {
    let rejected: string | null = null;
    for (const bucket of buckets) {
      const allowed = await this.#count(bucket, subject);
      if (!allowed && rejected === null) rejected = bucket.name;
    }
    if (rejected !== null) throw new MessagingThrottledError(rejected);
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
      this.logger.error('Durable throttle counter unavailable; refusing the messaging request.');
      throw new EnforcementUnavailableError(error);
    }
  }
}
