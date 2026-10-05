import { Inject, Injectable, Logger } from '@nestjs/common';
import { EnforcementUnavailableError } from '../auth/auth-errors.js';
import {
  DURABLE_THROTTLE_COUNTER,
  REDIS_THROTTLE_COUNTER,
  type ThrottleBucket,
  type ThrottleCounter,
} from '../auth/login-throttle.service.js';
import { ReportThrottledError } from './reports.errors.js';

/**
 * The report filing rate limit (Phase 7-M).
 *
 * **This is not a second limiter, and the number is not a new one.** It injects the same two counters every
 * other throttle on this platform injects — the Redis fixed window and the durable
 * `app_private.rate_limit_hit` of migration 0004 — counts in the same aligned windows, falls back in the
 * same order and fails closed the same way. No migration was needed, because a bucket name is free text to
 * `app_private.rate_limits` under `^[a-z][a-z0-9_.]*$` and the durable counter is already granted to
 * `app_system`.
 *
 * **Where the number comes from.** The repository already rate-limits *filing a report*: 5-E's
 * `messaging_report` bucket, **ten per account per hour**, which is the throttle 5-H's `POST
 * /v1/messaging/reports` passes through. That is this platform's own figure for this operation, so it is
 * the figure used here rather than one invented for the occasion. What is not reused is the *bucket*:
 * `messaging_report` is named for the surface it counts and counting listing and seller reports in it would
 * make its name false and let one surface exhaust the other's allowance. So the mechanism and the number
 * are the repository's, and only the counter is this surface's own.
 *
 * This is reported as a decision rather than treated as settled: the owner may set a different number for
 * this surface, and only this file and its test change if they do.
 *
 * **No support bucket and no unrelated bucket is touched.** This service knows one bucket name.
 *
 * **The subject is the caller's own account, hashed** with the same `hashIdentifier` every other bucket
 * uses, so Redis holds no identifier and nothing a browser can send changes which counter it is counted
 * against.
 *
 * **Reads are not limited.** The reporter's own history does not pass through this service, for the reason
 * 7-K's Decision 1 gives: a read that a caller is entitled to is not an abuse-sensitive write.
 */

/** One bucket, and nothing derived from it. */
export const REPORT_THROTTLE_BUCKETS = Object.freeze({
  /** Filing a report: ten per account per hour, successful or not — 5-E's own figure for this operation. */
  fileReport: Object.freeze({ name: 'report_file', limit: 10, windowSeconds: 3600 }),
}) satisfies Readonly<Record<string, ThrottleBucket>>;

@Injectable()
export class ReportsThrottleService {
  private readonly logger = new Logger(ReportsThrottleService.name);

  constructor(
    @Inject(REDIS_THROTTLE_COUNTER) private readonly redis: ThrottleCounter | null,
    @Inject(DURABLE_THROTTLE_COUNTER) private readonly durable: ThrottleCounter,
  ) {}

  /**
   * One attempt to file a report: ten per account per hour, successful or not.
   *
   * Counted before the subject is resolved, deliberately. A refused attempt still happened, and counting
   * only the ones that found something would turn the limit into a free instrument for discovering which
   * slugs exist.
   */
  async assertCanFileReport(subject: Buffer): Promise<void> {
    const allowed = await this.#count(REPORT_THROTTLE_BUCKETS.fileReport, subject);
    if (!allowed) throw new ReportThrottledError(REPORT_THROTTLE_BUCKETS.fileReport.name);
  }

  async #count(bucket: ThrottleBucket, subject: Buffer): Promise<boolean> {
    if (this.redis !== null) {
      try {
        return await this.redis.hit(bucket.name, subject, bucket.windowSeconds, bucket.limit);
      } catch {
        // Expected and handled: the durable counter is the approved fallback. The line carries no subject
        // and no address.
        this.logger.warn(`Redis throttle counter unavailable for ${bucket.name}; using the durable counter.`);
      }
    }

    try {
      return await this.durable.hit(bucket.name, subject, bucket.windowSeconds, bucket.limit);
    } catch (error) {
      this.logger.error('Durable throttle counter unavailable; refusing the report.');
      throw new EnforcementUnavailableError(error);
    }
  }
}
