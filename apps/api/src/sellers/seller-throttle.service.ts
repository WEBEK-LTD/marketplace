import { Inject, Injectable, Logger } from '@nestjs/common';
import { EnforcementUnavailableError } from '../auth/auth-errors.js';
import {
  DURABLE_THROTTLE_COUNTER,
  REDIS_THROTTLE_COUNTER,
  type ThrottleBucket,
  type ThrottleCounter,
} from '../auth/login-throttle.service.js';
import { SellerThrottledError } from './seller-errors.js';

/**
 * The seller onboarding rate limit (Phase 6-C).
 *
 * **This is not a second limiter.** It injects the same two counters the login throttle and the messaging
 * throttle inject — the Redis fixed window and the durable `app_private.rate_limit_hit` — counts in the same
 * aligned windows, falls back in the same order and fails closed the same way. What is new is one bucket,
 * exactly as 5-E's three buckets were new: the mechanism is shared and the numbers are per surface.
 *
 * **Fail closed, in the same order.** Redis first, because it is shared across API instances and cheap. If
 * Redis cannot answer, the durable counter decides, continuing the same window rather than opening a fresh
 * allowance. If the durable counter cannot answer either, the request is refused — a counter that cannot be
 * read is not a counter that says zero, and an attacker who can take Redis down must not thereby remove the
 * limit. That matters more here than almost anywhere: every successful attempt creates a permanent public
 * address, and unlimited attempts would be a slug-squatting tool.
 *
 * The subject is the caller's own account, hashed, so Redis holds no identifier.
 *
 * Each increment adds only the bucket its own operation needs: 6-C added onboarding, 6-D the profile update,
 * 6-E the media upload, 6-F the two listing buckets, and 6-I the verification submission — the last of the
 * S-15 numbers, added by the increment that implements the surface it limits. 6-G added none: a service is a
 * listing, so its writes count against 6-F's buckets rather than against numbers of their own.
 */

/** The approved numbers, and nothing derived from them. */
export const SELLER_THROTTLE_BUCKETS = Object.freeze({
  onboarding: Object.freeze({ name: 'seller_onboarding', limit: 10, windowSeconds: 3600 }),
  profileUpdate: Object.freeze({ name: 'seller_profile_update', limit: 20, windowSeconds: 3600 }),
  mediaUpload: Object.freeze({ name: 'seller_media_upload', limit: 20, windowSeconds: 3600 }),
  listingDraft: Object.freeze({ name: 'seller_listing_draft', limit: 20, windowSeconds: 3600 }),
  listingSubmission: Object.freeze({ name: 'seller_listing_submission', limit: 10, windowSeconds: 3600 }),
  // A day, not an hour: the approved figure is five per account per **24 hours**, and it is the only bucket
  // in this file whose window is not hourly. Written out rather than expressed as 24 * 3600 so the approved
  // number is legible as itself.
  verificationSubmission: Object.freeze({
    name: 'seller_verification_submission',
    limit: 5,
    windowSeconds: 86_400,
  }),
}) satisfies Readonly<Record<string, ThrottleBucket>>;

@Injectable()
export class SellerThrottleService {
  private readonly logger = new Logger(SellerThrottleService.name);

  constructor(
    @Inject(REDIS_THROTTLE_COUNTER) private readonly redis: ThrottleCounter | null,
    @Inject(DURABLE_THROTTLE_COUNTER) private readonly durable: ThrottleCounter,
  ) {}

  /** One onboarding attempt: ten per account per hour, successful or not. */
  async assertCanOnboard(subject: Buffer): Promise<void> {
    const bucket = SELLER_THROTTLE_BUCKETS.onboarding;
    if (!(await this.#count(bucket, subject))) throw new SellerThrottledError(bucket.name);
  }

  /**
   * One profile-edit attempt: twenty per account per hour, successful or not (Phase 6-D).
   *
   * Its own bucket rather than a share of the onboarding one, because they are different operations with
   * different numbers: a person creates a storefront once and edits it many times, and a limit that
   * conflated them would let a burst of failed edits lock somebody out of onboarding, or the reverse.
   */
  async assertCanUpdateProfile(subject: Buffer): Promise<void> {
    const bucket = SELLER_THROTTLE_BUCKETS.profileUpdate;
    if (!(await this.#count(bucket, subject))) throw new SellerThrottledError(bucket.name);
  }

  /**
   * One seller media operation: twenty per account per hour, successful or not (Phase 6-E).
   *
   * Its own bucket, and it counts **both** halves of an upload — the authorization and the confirmation — so
   * twenty covers ten complete uploads an hour. A logo is changed rarely; what the limit is really for is the
   * authorization, because each one asks the storage provider to sign something, and an unlimited supply of
   * signed URLs is an unlimited supply of writes into a bucket.
   *
   * Twenty per account per hour was ratified by the owner as an approved Phase 6 decision after 6-E shipped;
   * it is not a figure this service chose.
   */
  async assertCanUploadMedia(subject: Buffer): Promise<void> {
    const bucket = SELLER_THROTTLE_BUCKETS.mediaUpload;
    if (!(await this.#count(bucket, subject))) throw new SellerThrottledError(bucket.name);
  }

  /**
   * One listing draft write: twenty per account per hour, successful or not (Phase 6-F).
   *
   * It covers creation **and** editing, because both are the same kind of act on the same resource and a
   * draft's whole purpose is to be revised: a separate edit bucket would either be generous enough to be no
   * limit at all or tight enough to interrupt somebody writing a listing. It also covers archival, which the
   * owner ratified against this same bucket after 6-F shipped; the sentence that called it unsettled is
   * corrected here rather than left to mislead a later reader.
   *
   * 6-G's service drafts count here too, because a service *is* a listing: the service writers call the
   * listing writers, and one bucket for one resource is the whole point.
   */
  async assertCanWriteListingDraft(subject: Buffer): Promise<void> {
    const bucket = SELLER_THROTTLE_BUCKETS.listingDraft;
    if (!(await this.#count(bucket, subject))) throw new SellerThrottledError(bucket.name);
  }

  /**
   * One listing submission: ten per account per hour, successful or not (Phase 6-F).
   *
   * Its own bucket, and the tighter of the two on purpose. A submission is what puts work in front of a human
   * moderator, so the number that matters is the one bounding how much of somebody's day one account can
   * consume — and it must not be spendable by a burst of ordinary draft edits, which is exactly why this is
   * separate from the draft bucket rather than a share of it.
   */
  async assertCanSubmitListing(subject: Buffer): Promise<void> {
    const bucket = SELLER_THROTTLE_BUCKETS.listingSubmission;
    if (!(await this.#count(bucket, subject))) throw new SellerThrottledError(bucket.name);
  }

  /**
   * One verification state change: five per account per 24 hours, successful or not (Phase 6-I).
   *
   * **What this counts, exactly.** The two operations that change the attempt's own state: starting one and
   * submitting it. Nothing else. Reading the attempt is not counted, and the three document operations are
   * not counted here either — they are uploads, so they count against the approved media bucket above, which
   * is what bounds how many objects one account can push into a private bucket.
   *
   * The reason for that split is what each limit is protecting. Five per day is a *reviewer's* budget: a
   * submission puts identity documents in front of a human, and the number that matters is how often one
   * account can do that. Twenty per hour is a *bucket's* budget: it bounds writes into storage. Counting a
   * document upload against the daily figure would let five photographs exhaust a whole day's allowance of
   * submissions, which would punish somebody assembling their evidence carefully.
   *
   * Five per account per 24 hours is the owner's approved value. It is not derived, scaled or adjusted here,
   * and the window is a day rather than an hour for the same reason.
   */
  async assertCanSubmitVerification(subject: Buffer): Promise<void> {
    const bucket = SELLER_THROTTLE_BUCKETS.verificationSubmission;
    if (!(await this.#count(bucket, subject))) throw new SellerThrottledError(bucket.name);
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
      this.logger.error('Durable throttle counter unavailable; refusing the seller onboarding request.');
      throw new EnforcementUnavailableError(error);
    }
  }
}
