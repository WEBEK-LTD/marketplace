import { Inject, Injectable, Logger } from '@nestjs/common';
import { EnforcementUnavailableError, LoginThrottledError } from './auth-errors.js';

/**
 * A fixed-window counter. Resolves to whether the request is **allowed**.
 *
 * Two implementations exist: Redis, which is fast and shared across API instances, and the durable
 * PostgreSQL counter `app_private.rate_limit_hit`, which survives a Redis outage. Both count the same
 * way, so a fallback mid-window continues from the durable count rather than starting a fresh one.
 */
export interface ThrottleCounter {
  hit(bucket: string, subjectHash: Buffer, windowSeconds: number, limit: number): Promise<boolean>;
}

export const REDIS_THROTTLE_COUNTER = Symbol('REDIS_THROTTLE_COUNTER');
export const DURABLE_THROTTLE_COUNTER = Symbol('DURABLE_THROTTLE_COUNTER');

export interface ThrottleBucket {
  readonly name: string;
  readonly limit: number;
  readonly windowSeconds: number;
}

/**
 * Owner decision C-1, in full. Nothing here is derived, scaled or "tuned"; the three numbers are the
 * approved ones and the names are what a rejected request records internally.
 *
 * Every login request counts against all three, successful or failed. That is what separates a throttle
 * from the lockout: the lockout counts only failures and is about one account, while these count volume
 * and are about protecting the provider and the database from being used as an oracle at scale.
 */
export const LOGIN_THROTTLE_BUCKETS = Object.freeze({
  identifier: Object.freeze({ name: 'login_identifier', limit: 10, windowSeconds: 900 }),
  ip: Object.freeze({ name: 'login_ip', limit: 60, windowSeconds: 900 }),
  ipBurst: Object.freeze({ name: 'login_ip_burst', limit: 5, windowSeconds: 60 }),
}) satisfies Readonly<Record<string, ThrottleBucket>>;

export interface LoginThrottleSubjects {
  readonly identifierHash: Buffer;
  /** Null when the client IP is unknown; the IP buckets are then skipped rather than shared. */
  readonly ipHash: Buffer | null;
}

/**
 * The C-1 login throttle: Redis first, durable PostgreSQL second, and a refusal if neither answers.
 *
 * "Never fail open" is the whole design. A counter that cannot be read is not a counter that says zero:
 * if Redis is unreachable the durable counter decides, and if that is unreachable too the request is
 * refused. An attacker who can take down Redis must not thereby remove the limit.
 *
 * This runs before the durable lockout check and long before Supabase is contacted, so a flood costs a
 * Redis round trip rather than a provider call.
 */
@Injectable()
export class LoginThrottleService {
  private readonly logger = new Logger(LoginThrottleService.name);

  constructor(
    @Inject(REDIS_THROTTLE_COUNTER) private readonly redis: ThrottleCounter | null,
    @Inject(DURABLE_THROTTLE_COUNTER) private readonly durable: ThrottleCounter,
  ) {}

  /**
   * Counts this request in every applicable bucket and throws if any of them is over its limit.
   *
   * All buckets are counted even when an earlier one has already rejected: a request that was refused
   * still happened, and not counting it would let a client stay under the per-IP limit forever by
   * tripping the burst limit first.
   */
  async assertWithinLimits(subjects: LoginThrottleSubjects): Promise<void> {
    const checks: Array<{ bucket: ThrottleBucket; subject: Buffer }> = [
      { bucket: LOGIN_THROTTLE_BUCKETS.identifier, subject: subjects.identifierHash },
    ];
    if (subjects.ipHash !== null) {
      checks.push({ bucket: LOGIN_THROTTLE_BUCKETS.ip, subject: subjects.ipHash });
      checks.push({ bucket: LOGIN_THROTTLE_BUCKETS.ipBurst, subject: subjects.ipHash });
    }

    let rejected: string | null = null;
    for (const check of checks) {
      const allowed = await this.#count(check.bucket, check.subject);
      if (!allowed && rejected === null) rejected = check.bucket.name;
    }

    if (rejected !== null) throw new LoginThrottledError(rejected);
  }

  async #count(bucket: ThrottleBucket, subject: Buffer): Promise<boolean> {
    if (this.redis !== null) {
      try {
        return await this.redis.hit(bucket.name, subject, bucket.windowSeconds, bucket.limit);
      } catch {
        // Not fatal by itself: the durable counter is the approved fallback. The message carries no
        // subject and no address.
        this.logger.warn(`Redis throttle counter unavailable for ${bucket.name}; using the durable counter.`);
      }
    }

    try {
      return await this.durable.hit(bucket.name, subject, bucket.windowSeconds, bucket.limit);
    } catch (error) {
      this.logger.error('Durable throttle counter unavailable; refusing the login request.');
      throw new EnforcementUnavailableError(error);
    }
  }
}
