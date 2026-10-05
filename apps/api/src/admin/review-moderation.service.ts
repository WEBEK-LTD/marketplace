import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  ModerateReviewResponse,
  ModerationActionKind,
  ReviewDetail,
  ReviewModerationAction,
  ReviewPublicationBlock,
  ReviewQueueRow,
  ReviewStatus,
} from '@repo/contracts';
import { isAal2 } from '../auth/access-token-claims.js';
import { StaffConsoleService } from './staff-console.service.js';
import {
  ReviewCursorInvalidError,
  ReviewInvalidError,
  ReviewIsPartyError,
  ReviewNotFoundError,
  ReviewReasonRequiredError,
  ReviewUnavailableError,
} from './review-moderation.errors.js';
import {
  decodeReviewQueueCursor,
  encodeReviewQueueCursor,
} from './review-moderation.cursor.js';

/**
 * Review moderation (Phase 7-P).
 *
 * **Authorization, in the one order it is ever done**, which is 7-F's and is not varied:
 *
 *   1. The **provider** validates the caller's access token and says whose it is.
 *   2. The **assurance level** is read from that same, now-vouched-for token. Reading a claim first would be
 *      reading an attacker's JSON.
 *   3. The **database** reports the caller's *effective* permissions under 0003's own `requires_mfa` rule.
 *      All three roles that hold a review key require MFA, so staff at `aal1` hold nothing at all — asking
 *      whether the effective set contains a key is therefore the AAL2 check and the permission check at once.
 *   4. Every `app_private` function below **re-applies the same permission test itself**, with the account and
 *      the assurance level as parameters and the key as a literal. No bug in this file can turn into somebody's
 *      review.
 *
 * **Three keys, and each route requires exactly the one the database requires.**
 *
 *   * `reviews.review.read` — the queue and one review.
 *   * `reviews.review.moderate` — the decision. A different key, which is why the detail reports
 *     `canModerate` rather than leaving a screen to guess.
 *   * `moderation.action.read` — the trail. **Not** a review key: it is what 0027's own policy gates that
 *     table on, so a colleague holding both review keys and not this one gets an empty trail.
 *
 * **No role name is checked anywhere in this file.**
 *
 * **Every rule this surface appears to apply is applied in the database.** The four statuses, the absence of
 * any transition matrix, the required reason, the refusal of a moderator who is a party, the clearing of the
 * automatic hiding reason, the publication time moving only on publishing, and the decision standing against
 * the automatic reassessment — all of it is decided inside migration 0080's wrapper, which calls 0026's
 * `moderate_review` with the row locked. This service passes the caller's account, translates the outcome into
 * the approved error, and **checks nothing a second time**.
 *
 * **A refusal and an absence are the same answer.** A review that does not exist and a caller without the key
 * both arrive as `not_found` and become one {@link ReviewNotFoundError}.
 *
 * ---------------------------------------------------------------------------------------------------
 * **THERE IS NO METHOD HERE THAT MODERATES A REVIEW REPLY, AND THAT IS DELIBERATE.**
 *
 * A review's reply is read so a moderator can see the whole exchange. Nothing in this repository writes a
 * reply's status: the only write to `public.review_replies` anywhere is the seller's own insert inside 0026's
 * `reply_to_review`, and `moderate_review` updates `public.reviews` alone. Building a writer here would mean
 * this service inventing the rules for it. Reported as a capability gap for an owner decision.
 * ---------------------------------------------------------------------------------------------------
 */

export const REVIEWS_REVIEW_READ = 'reviews.review.read';
export const REVIEWS_REVIEW_MODERATE = 'reviews.review.moderate';
/** 0027's own key for the moderation trail. Deliberately not a review key. */
export const MODERATION_ACTION_READ_FOR_REVIEWS = 'moderation.action.read';

/* ------------------------------------------------------------------------------------------------ */
/* The rows each function returns                                                                    */
/* ------------------------------------------------------------------------------------------------ */

/** One row of `app_private.review_queue_for_staff` (0080). */
export interface ReviewQueueDbRow {
  readonly id: string;
  readonly rating: number;
  readonly title: string | null;
  readonly status: string;
  readonly hasBody: boolean;
  readonly autoHiddenReason: string | null;
  readonly isModerated: boolean;
  readonly moderatedByMe: boolean;
  readonly isParty: boolean;
  readonly sellerSlug: string;
  readonly sellerDisplayName: string;
  readonly hasReply: boolean;
  readonly replyStatus: string | null;
  readonly createdAt: Date | string;
}

/** One row of `app_private.review_for_staff` (0080). */
export interface ReviewDetailDbRow {
  readonly outcome: string;
  readonly id: string | null;
  readonly rating: number | null;
  readonly title: string | null;
  readonly body: string | null;
  readonly status: string | null;
  readonly autoHiddenReason: string | null;
  readonly moderationReason: string | null;
  readonly moderatedAt: Date | string | null;
  readonly moderatedByMe: boolean | null;
  readonly isParty: boolean | null;
  readonly canModerate: boolean | null;
  readonly publicationBlock: string | null;
  readonly sellerSlug: string | null;
  readonly sellerDisplayName: string | null;
  readonly sellerStatus: string | null;
  readonly replyBody: string | null;
  readonly replyStatus: string | null;
  readonly replyModerationReason: string | null;
  readonly replyCreatedAt: Date | string | null;
  readonly createdAt: Date | string | null;
  readonly updatedAt: Date | string | null;
}

/** One row of `app_private.review_moderation_actions` (0080). */
export interface ReviewActionDbRow {
  readonly id: string;
  readonly action: string;
  readonly reason: string;
  readonly notes: string | null;
  readonly reportId: string | null;
  readonly isOwnAction: boolean;
  readonly createdAt: Date | string;
}

/** One row of `app_private.review_moderate_for_staff` (0080). */
export interface ReviewModerateRow {
  readonly outcome: string;
  readonly status: string | null;
}

export interface ReviewModerationStore {
  reviewQueueForStaff(input: {
    userId: string;
    isAal2: boolean;
    limit: number;
    status: string | null;
    cursorCreatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly ReviewQueueDbRow[]>;

  reviewForStaff(input: {
    userId: string;
    isAal2: boolean;
    reviewId: string;
  }): Promise<ReviewDetailDbRow>;

  reviewModerationActions(input: {
    userId: string;
    isAal2: boolean;
    reviewId: string;
    limit: number;
  }): Promise<readonly ReviewActionDbRow[]>;

  reviewModerateForStaff(input: {
    userId: string;
    isAal2: boolean;
    reviewId: string;
    status: string;
    reason: string;
  }): Promise<ReviewModerateRow>;
}

export const REVIEW_MODERATION_STORE = Symbol('REVIEW_MODERATION_STORE');

export interface ReviewQueuePage {
  readonly items: readonly ReviewQueueRow[];
  readonly nextCursor: string | null;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toIsoOrNull(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

@Injectable()
export class ReviewModerationService {
  private readonly logger = new Logger(ReviewModerationService.name);

  constructor(
    @Inject(REVIEW_MODERATION_STORE) private readonly store: ReviewModerationStore,
    private readonly console: StaffConsoleService,
  ) {}

  /**
   * One page of the review queue, **newest first**.
   *
   * The page is read one row longer than asked for, so `nextCursor` is null exactly when the page is the last
   * one rather than one request later.
   */
  async queue(input: {
    accessToken: string;
    limit: number;
    status: string | null;
    cursor: string | null;
  }): Promise<ReviewQueuePage> {
    const staff = await this.#staff(input.accessToken, REVIEWS_REVIEW_READ);

    let position: { createdAt: Date; id: string } | null = null;
    if (input.cursor !== null) {
      position = decodeReviewQueueCursor(input.cursor);
      // One refusal for malformed, altered and outdated — including a position from any other list on this
      // platform, whose rows sit behind different keys entirely.
      if (position === null) throw new ReviewCursorInvalidError();
    }

    let rows: readonly ReviewQueueDbRow[];
    try {
      rows = await this.store.reviewQueueForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        limit: input.limit + 1,
        // Passed as a parameter. An unknown value matches nothing in the database rather than being refused
        // here, which is the reader's own documented behaviour.
        status: input.status,
        cursorCreatedAt: position?.createdAt ?? null,
        cursorId: position?.id ?? null,
      });
    } catch (error) {
      this.logger.error('The review queue could not be read.');
      throw new ReviewUnavailableError(error);
    }

    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        id: row.id,
        rating: Number(row.rating),
        title: row.title,
        status: row.status as ReviewStatus,
        hasBody: row.hasBody,
        autoHiddenReason: row.autoHiddenReason,
        isModerated: row.isModerated,
        moderatedByMe: row.moderatedByMe,
        isParty: row.isParty,
        sellerSlug: row.sellerSlug,
        sellerDisplayName: row.sellerDisplayName,
        hasReply: row.hasReply,
        replyStatus: row.replyStatus as ReviewStatus | null,
        createdAt: toIso(row.createdAt),
      })),
      nextCursor:
        hasMore && last !== undefined
          ? encodeReviewQueueCursor({ createdAt: new Date(toIso(last.createdAt)), id: last.id })
          : null,
    };
  }

  /** One review, with its reply. A missing one and a caller without the key are the same answer. */
  async review(input: { accessToken: string; reviewId: string }): Promise<ReviewDetail> {
    const staff = await this.#staff(input.accessToken, REVIEWS_REVIEW_READ);

    let row: ReviewDetailDbRow;
    try {
      row = await this.store.reviewForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        reviewId: input.reviewId,
      });
    } catch (error) {
      this.logger.error('A review could not be read.');
      throw new ReviewUnavailableError(error);
    }

    if (row.outcome !== 'found') this.#refusal(row.outcome);
    return {
      id: row.id ?? '',
      rating: Number(row.rating ?? 0),
      title: row.title,
      body: row.body,
      status: (row.status ?? 'published') as ReviewStatus,
      autoHiddenReason: row.autoHiddenReason,
      moderationReason: row.moderationReason,
      moderatedAt: toIsoOrNull(row.moderatedAt),
      moderatedByMe: row.moderatedByMe ?? false,
      isParty: row.isParty ?? false,
      canModerate: row.canModerate ?? false,
      // The two values 0026's own predicate answers, or nothing. A value it does not produce becomes null
      // rather than a string the contract does not describe.
      publicationBlock:
        row.publicationBlock === 'order_refunded' || row.publicationBlock === 'payment_disputed'
          ? (row.publicationBlock as ReviewPublicationBlock)
          : null,
      sellerSlug: row.sellerSlug ?? '',
      sellerDisplayName: row.sellerDisplayName ?? '',
      sellerStatus: row.sellerStatus ?? '',
      replyBody: row.replyBody,
      replyStatus: row.replyStatus as ReviewStatus | null,
      replyModerationReason: row.replyModerationReason,
      replyCreatedAt: toIsoOrNull(row.replyCreatedAt),
      createdAt: toIso(row.createdAt ?? new Date(0)),
      updatedAt: toIso(row.updatedAt ?? new Date(0)),
    };
  }

  /**
   * The moderation actions recorded against one review.
   *
   * Gated on `moderation.action.read`, which is 0027's own key and neither review key — so a colleague holding
   * both of those and not this one gets an empty list, identical to a review nobody has acted on.
   */
  async actions(input: {
    accessToken: string;
    reviewId: string;
    limit: number;
  }): Promise<readonly ReviewModerationAction[]> {
    const staff = await this.#staff(input.accessToken, MODERATION_ACTION_READ_FOR_REVIEWS);

    let rows: readonly ReviewActionDbRow[];
    try {
      rows = await this.store.reviewModerationActions({
        userId: staff.id,
        isAal2: staff.isAal2,
        reviewId: input.reviewId,
        limit: input.limit,
      });
    } catch (error) {
      this.logger.error('A review’s moderation actions could not be read.');
      throw new ReviewUnavailableError(error);
    }

    return rows.map((row) => ({
      id: row.id,
      action: row.action as ModerationActionKind,
      reason: row.reason,
      notes: row.notes,
      reportId: row.reportId,
      isOwnAction: row.isOwnAction,
      createdAt: toIso(row.createdAt),
    }));
  }

  /**
   * Records a decision on one review.
   *
   * Every rule is 0026's, applied inside 0080's wrapper with the row locked: the four statuses, the absence of
   * any transition matrix, the required reason, and the refusal of a moderator who is the review's buyer or
   * seller. The status this returns is the one the writer reached.
   */
  async moderate(input: {
    accessToken: string;
    reviewId: string;
    status: string;
    reason: string;
  }): Promise<ModerateReviewResponse> {
    const staff = await this.#staff(input.accessToken, REVIEWS_REVIEW_MODERATE);

    let row: ReviewModerateRow;
    try {
      row = await this.store.reviewModerateForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        reviewId: input.reviewId,
        status: input.status,
        reason: input.reason,
      });
    } catch (error) {
      this.logger.error('A review moderation decision could not be recorded.');
      throw new ReviewUnavailableError(error);
    }

    if (row.outcome !== 'moderated') this.#refusal(row.outcome);
    return { outcome: 'moderated', status: (row.status ?? 'published') as ReviewStatus };
  }

  /* ---------------------------------------------------------------------------------------------- */

  /**
   * The caller, and the one key this route needs.
   *
   * A colleague who does not hold it is answered exactly as a missing row is. The database will apply the same
   * test again with the key as a literal, so this is the first of two rather than the only one.
   */
  async #staff(accessToken: string, permission: string): Promise<{ id: string; isAal2: boolean }> {
    const session = await this.console.forToken(accessToken);
    if (!session.permissions.includes(permission)) throw new ReviewNotFoundError();
    return { id: session.id, isAal2: isAal2(accessToken) };
  }

  #refusal(outcome: string): never {
    if (outcome === 'not_found') throw new ReviewNotFoundError();
    if (outcome === 'is_party') throw new ReviewIsPartyError();
    if (outcome === 'reason_required') throw new ReviewReasonRequiredError();
    if (outcome === 'invalid') throw new ReviewInvalidError();
    this.logger.error('A review operation returned an outcome this service does not understand.');
    throw new ReviewUnavailableError(new Error('unexpected outcome'));
  }
}
