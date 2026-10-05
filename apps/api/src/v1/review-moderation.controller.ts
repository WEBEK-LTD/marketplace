import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import {
  ModerateReviewRequestSchema,
  REVIEW_MODERATION_DEFAULT_LIMIT,
  REVIEW_MODERATION_HISTORY_LIMIT,
  REVIEW_MODERATION_MAX_LIMIT,
  SESSION_TOKEN_HEADER,
  parseMessagingLimit,
  type ModerateReviewRequest,
  type ModerateReviewResponse,
  type ReviewDetailResponse,
  type ReviewModerationActionsResponse,
  type ReviewQueueResponse,
} from '@repo/contracts';
import { AuthenticationRequiredError } from '../auth/auth-errors.js';
import { ReviewModerationService } from '../admin/review-moderation.service.js';
import { RequestValidationException } from '../common/request-validation.exception.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

/** Fastify's request, reduced to the one thing these routes read. */
interface ReviewModerationRequestContext {
  readonly headers: Record<string, unknown>;
}

function header(request: ReviewModerationRequestContext, name: string): string | null {
  const value = request.headers[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Review moderation (Phase 7-P).
 *
 * Four operations: the queue, one review, that review's moderation trail, and the decision.
 *
 * **There is deliberately no fifth that moderates a review *reply*.** `public.review_replies` carries the
 * same four statuses together with a moderation reason, time and moderator, and 0026's
 * `review_replies_staff_moderate` policy authorizes setting them — but nothing in this repository writes
 * them: the only write to that table anywhere is the seller's own insert inside `reply_to_review`, and
 * `moderate_review` updates `public.reviews` alone. A reply is therefore **read-only** on this controller, and
 * no request body here has a field through which a reply's status could travel. Reported as a capability gap
 * rather than given an invented writer.
 *
 * **The caller's account and assurance level come from their own session**, resolved inside the service
 * through `StaffConsoleService.forToken` and then `isAal2` on that same now-validated token, in that order. No
 * route takes an actor, a moderator, a role, a permission key or an assurance level, and both request schemas
 * are `.strict()`, so none could.
 *
 * **Each route requires exactly the key the database requires**, and they are three different keys rather than
 * one bundle: `reviews.review.read` for the queue and one review, `reviews.review.moderate` for the decision —
 * which is why the detail reports `canModerate` rather than leaving the console to guess — and
 * `moderation.action.read` for the trail, which is 0027's own key and neither review key, so a colleague
 * holding both of those and not this one receives an empty trail. No role name is checked anywhere.
 *
 * **A review is addressed by its id**, which is what 0026's writer takes and what a colleague holding the read
 * key legitimately holds. The shape is checked here so nothing that is not an identifier reaches a parameter
 * binding — but what authorizes the read is the permission and the assurance level, tested in the database
 * before any row is reached, never the shape of the identifier.
 *
 * **The controller decides nothing.** The four statuses, the absence of any transition matrix, the required
 * reason, the refusal of a moderator who is the review's buyer or seller, the clearing of the automatic
 * hiding reason, the publication time moving only on publishing, and a human decision standing against the
 * automatic reassessment are all applied inside 0026's `moderate_review`, which 0080's wrapper calls with the
 * row locked. Restating any of them here would be a second copy of a rule, and the copy without the lock is
 * the one that would be wrong.
 */
@Controller('v1/admin')
export class ReviewModerationController {
  constructor(private readonly reviews: ReviewModerationService) {}

  /** One page of the queue, newest first. */
  @Get('reviews')
  async queue(
    @Req() request: ReviewModerationRequestContext,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('status') status?: string,
  ): Promise<ReviewQueueResponse> {
    const page = await this.reviews.queue({
      accessToken: this.token(request),
      limit: this.limit(limit),
      // Passed through as text. The database compares it as a parameter, so an unknown value matches nothing
      // rather than being refused — the reader's own documented behaviour, which means a stale filter in a
      // bookmark shows an empty page instead of an error.
      status: this.optional(status),
      cursor: this.optional(cursor),
    });
    return { items: [...page.items], nextCursor: page.nextCursor };
  }

  /** One review, with the seller's reply beside it read-only. */
  @Get('reviews/:reviewId')
  async review(
    @Req() request: ReviewModerationRequestContext,
    @Param('reviewId') reviewId: string,
  ): Promise<ReviewDetailResponse> {
    const review = await this.reviews.review({
      accessToken: this.token(request),
      reviewId: this.identifier(reviewId, 'reviewId'),
    });
    return { review };
  }

  /**
   * The moderation actions recorded against one review.
   *
   * A fixed page: 0027's trail for a single review is short and is not paged. Gated on a key neither review
   * key implies, so an empty list means either nothing recorded or the key not held — identically.
   */
  @Get('reviews/:reviewId/actions')
  async actions(
    @Req() request: ReviewModerationRequestContext,
    @Param('reviewId') reviewId: string,
  ): Promise<ReviewModerationActionsResponse> {
    const items = await this.reviews.actions({
      accessToken: this.token(request),
      reviewId: this.identifier(reviewId, 'reviewId'),
      limit: REVIEW_MODERATION_HISTORY_LIMIT,
    });
    return { items: [...items] };
  }

  /**
   * Records a decision on one review.
   *
   * The body names where the review should end up and why. It names no moderator and no time, because the
   * writer records both, and it cannot reach the reply, the order or the rating.
   */
  @Post('reviews/:reviewId/moderation')
  @HttpCode(200)
  async moderate(
    @Req() request: ReviewModerationRequestContext,
    @Param('reviewId') reviewId: string,
    @Body(new ZodValidationPipe(ModerateReviewRequestSchema)) body: ModerateReviewRequest,
  ): Promise<ModerateReviewResponse> {
    return this.reviews.moderate({
      accessToken: this.token(request),
      reviewId: this.identifier(reviewId, 'reviewId'),
      status: body.status,
      reason: body.reason,
    });
  }

  /* ---------------------------------------------------------------------------------------------- */

  /** The caller's own session token. A request without one never reaches a reader. */
  private token(request: ReviewModerationRequestContext): string {
    const accessToken = header(request, SESSION_TOKEN_HEADER);
    if (accessToken === null || accessToken === '') throw new AuthenticationRequiredError();
    return accessToken;
  }

  private optional(value: string | undefined): string | null {
    return value === undefined || value === '' ? null : value;
  }

  private limit(value: string | undefined): number {
    const parsed = parseMessagingLimit(value, {
      fallback: REVIEW_MODERATION_DEFAULT_LIMIT,
      maximum: REVIEW_MODERATION_MAX_LIMIT,
    });
    if (!parsed.ok) {
      throw new RequestValidationException([{ path: 'limit', message: 'The limit is invalid.' }]);
    }
    return parsed.limit;
  }

  /**
   * The path parameter that names a review.
   *
   * Checked for shape here so a malformed identifier is a validation failure rather than a database error,
   * and so nothing that is not an identifier ever reaches a parameter binding.
   */
  private identifier(value: string, path: string): string {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
      throw new RequestValidationException([{ path, message: 'The identifier is invalid.' }]);
    }
    return value.toLowerCase();
  }
}
