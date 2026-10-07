import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  LISTING_ANALYTICS_DEFAULT_DAYS,
  LISTING_ANALYTICS_MAX_DAYS,
  SELLER_ANALYTICS_DEFAULT_DAYS,
  SELLER_ANALYTICS_MAX_DAYS,
  SELLER_READ_DEFAULT_LIMIT,
  SELLER_READ_MAX_LIMIT,
  type SellerAnalyticsResponse,
  type SellerListingAnalyticsResponse,
  type SellerListingPerformance,
  type SellerBalance,
  type SellerOrder,
  type SellerOrderItem,
  type SellerPromotion,
  type SellerPromotionPerformance,
  type SellerReview,
  type SellerReviewSummary,
} from '@repo/contracts';
import {
  InvalidSellerListingCursorError,
  SellerIdentityUnavailableError,
  SellerProfileNotFoundError,
} from './seller-errors.js';
import {
  decodeSellerIdCursor,
  decodeSellerReferenceCursor,
  encodeSellerIdCursor,
  encodeSellerReferenceCursor,
} from './seller-read-cursor.js';

/**
 * The read-only seller surfaces (Phase 6-J).
 *
 * Five reads: orders, reviews (with the rating summary beside them), balances, promotions and promotion
 * performance. **There is no write method in this file** — no create, no update, no cancel, no refund, no
 * withdrawal, no status change — and no method that could acquire one without a new function in `app_private`
 * to call, because every one of these goes through a reader that is declared `stable` in the database.
 *
 * **Authorization is the database's.** Each reader is scoped to the caller's own storefront in its own where
 * clause, mirroring the RLS policy that already says what an authenticated seller may read
 * (`orders_party_read`, `reviews_seller_read`, `seller_balances_owner_read`, `promotions_seller_read`,
 * `promotion_analytics_read`). This service passes the caller's own user id and nothing else: no seller,
 * owner, buyer or status parameter exists anywhere below, so there is nothing for a request to forge.
 *
 * **No metric is computed here.** The rating summary is `public.seller_ratings`' own aggregate, average and
 * all, passed through in the basis points that view produces. The promotion totals are
 * `public.promotion_analytics`' own rollup rows, summed in the database by the reader. This service adds no
 * rate, ratio, average or total to either, and it deliberately computes no balance total: what a seller is
 * owed is a business statement no formula in this repository establishes.
 *
 * **No rate limit.** A read consumes no seller write bucket, and none of the approved Phase 6 numbers counts
 * one. The throttle service is not injected, so there is nothing here to spend.
 *
 * **Nothing private travels.** The row shapes coming back from `app_private` already exclude every
 * identifier, snapshot, moderation field and ledger reference; each projection below is nevertheless written
 * out field by field rather than spread, so a future widening of a reader cannot carry something new outward
 * silently.
 */

export interface SellerOrdersQuery {
  readonly userId: string;
  readonly limit: number;
  readonly cursorPlacedAt: Date | null;
  readonly cursorOrderNumber: string | null;
}

export interface SellerOrderRow {
  readonly outcome: string;
  readonly orderNumber: string | null;
  readonly orderType: string | null;
  readonly status: string | null;
  readonly currencyCode: string | null;
  readonly currencyDecimalPlaces: number | null;
  readonly subtotalMinor: string | null;
  readonly shippingTotalMinor: string | null;
  readonly taxTotalMinor: string | null;
  readonly discountTotalMinor: string | null;
  readonly commissionTotalMinor: string | null;
  readonly grandTotalMinor: string | null;
  readonly sellerNetMinor: string | null;
  readonly itemCount: number | null;
  readonly placedAt: Date | string | null;
  readonly paidAt: Date | string | null;
  readonly shippedAt: Date | string | null;
  readonly deliveredAt: Date | string | null;
  readonly completedAt: Date | string | null;
  readonly cancelledAt: Date | string | null;
  readonly items: unknown;
}

export interface SellerReviewsQuery {
  readonly userId: string;
  readonly limit: number;
  readonly cursorCreatedAt: Date | null;
  readonly cursorOrderNumber: string | null;
}

export interface SellerReviewRow {
  readonly outcome: string;
  readonly orderNumber: string | null;
  readonly rating: number | null;
  readonly title: string | null;
  readonly body: string | null;
  readonly status: string | null;
  readonly publishedAt: Date | string | null;
  readonly createdAt: Date | string | null;
  readonly replyBody: string | null;
  readonly replyStatus: string | null;
  readonly replyCreatedAt: Date | string | null;
}

export interface SellerReviewSummaryRow {
  readonly outcome: string;
  readonly reviewCount: number | null;
  readonly averageRatingBasisPoints: number | null;
  readonly fiveStarCount: number | null;
  readonly fourStarCount: number | null;
  readonly threeStarCount: number | null;
  readonly twoStarCount: number | null;
  readonly oneStarCount: number | null;
  readonly latestReviewAt: Date | string | null;
}

export interface SellerBalanceRow {
  readonly outcome: string;
  readonly currencyCode: string | null;
  readonly currencyDecimalPlaces: number | null;
  readonly pendingMinor: string | null;
  readonly availableMinor: string | null;
  readonly reservedMinor: string | null;
  readonly updatedAt: Date | string | null;
}

export interface SellerPromotionsQuery {
  readonly userId: string;
  readonly limit: number;
  readonly cursorCreatedAt: Date | null;
  readonly cursorId: string | null;
}

export interface SellerPromotionRow {
  readonly outcome: string;
  readonly listingSlug: string | null;
  readonly listingTitle: string | null;
  readonly status: string | null;
  readonly currencyCode: string | null;
  readonly currencyDecimalPlaces: number | null;
  readonly priceMinor: string | null;
  readonly refundedAmountMinor: string | null;
  readonly priority: number | null;
  readonly durationDays: number | null;
  readonly startsAt: Date | string | null;
  readonly endsAt: Date | string | null;
  readonly activatedAt: Date | string | null;
  readonly pausedAt: Date | string | null;
  readonly expiredAt: Date | string | null;
  readonly cancelledAt: Date | string | null;
  readonly createdAt: Date | string | null;
  /** The keyset tie-breaker, used to build the next cursor and stripped from the response. */
  readonly cursorId: string | null;
}

export interface SellerPromotionPerformanceRow {
  readonly outcome: string;
  readonly listingSlug: string | null;
  readonly listingTitle: string | null;
  readonly status: string | null;
  readonly firstDay: Date | string | null;
  readonly lastDay: Date | string | null;
  readonly impressions: string | null;
  readonly views: string | null;
  readonly clicks: string | null;
}

/**
 * One of the caller's listings, as `app_private.seller_listing_analytics` returns it (0102).
 *
 * The counts arrive as text because they are `bigint` sums. They are **counts, not money**: no currency, no
 * decimal places and nothing from the money package is involved anywhere on this path.
 */
export interface SellerListingPerformanceRow {
  readonly outcome: string;
  readonly listingSlug: string | null;
  readonly listingTitle: string | null;
  readonly listingStatus: string | null;
  readonly firstDay: Date | string | null;
  readonly lastDay: Date | string | null;
  readonly clicks: string | null;
  readonly contacts: string | null;
  readonly favorites: string | null;
  readonly shares: string | null;
}

export interface SellerReadStore {
  /** `app_private.seller_orders(...)` (0064). */
  sellerOrders(query: SellerOrdersQuery): Promise<readonly SellerOrderRow[]>;
  /** `app_private.seller_reviews(...)` (0064). */
  sellerReviews(query: SellerReviewsQuery): Promise<readonly SellerReviewRow[]>;
  /** `app_private.seller_reviews_summary(uuid)` (0064). */
  sellerReviewsSummary(userId: string): Promise<SellerReviewSummaryRow>;
  /** `app_private.seller_earnings(uuid)` (0064). */
  sellerEarnings(userId: string): Promise<readonly SellerBalanceRow[]>;
  /** `app_private.seller_promotions(...)` (0064). */
  sellerPromotions(query: SellerPromotionsQuery): Promise<readonly SellerPromotionRow[]>;
  /** `app_private.seller_promotion_analytics(uuid, integer)` (0064). */
  sellerPromotionAnalytics(
    userId: string,
    days: number,
  ): Promise<readonly SellerPromotionPerformanceRow[]>;
  /** `app_private.seller_listing_analytics(uuid, integer)` (0102). */
  sellerListingAnalytics(
    userId: string,
    days: number,
  ): Promise<readonly SellerListingPerformanceRow[]>;
}

export const SELLER_READ_STORE = Symbol('SELLER_READ_STORE');

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toIsoOrNull(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

/** A `date` column, as the ten characters a calendar day is. */
function toDay(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

/**
 * The page size for orders, reviews and promotions.
 *
 * **These three page differently from every other list here, deliberately (0106, owner decision 3).** They send
 * the reader `limit: size` — no probe row — and decide there is another page from `rows.length === size`. That
 * loses no rows; its cost is one wasted request when the total is an exact multiple of the page size, which
 * returns an empty page. Everywhere else in this API asks for `limit + 1` instead and reads the extra row.
 *
 * It was left as it is on purpose: unifying it would change when `nextCursor` is null on that boundary, which
 * is a cursor-semantics change 0106 was not permitted to make. Their readers therefore clamp at exactly the
 * public maximum, and the three are named in `PAGINATION_CEILING_EXEMPT` so the structural check that enforces
 * the probe-row contract everywhere else expects this shape here.
 */
function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return SELLER_READ_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), SELLER_READ_MAX_LIMIT);
}

@Injectable()
export class SellerReadService {
  private readonly logger = new Logger(SellerReadService.name);

  constructor(@Inject(SELLER_READ_STORE) private readonly store: SellerReadStore) {}

  /** One page of the caller's own orders. */
  async orders(
    userId: string,
    limit: number | undefined,
    cursor: string | null,
  ): Promise<{ readonly orders: readonly SellerOrder[]; readonly nextCursor: string | null }> {
    const size = clampLimit(limit);
    const position = this.#referenceCursor(cursor);

    let rows: readonly SellerOrderRow[];
    try {
      rows = await this.store.sellerOrders({
        userId,
        limit: size,
        cursorPlacedAt: position?.at ?? null,
        cursorOrderNumber: position?.reference ?? null,
      });
    } catch (error) {
      this.logger.error('A seller orders page could not be read.');
      throw new SellerIdentityUnavailableError(error);
    }

    this.#assertFound(rows, 'orders');
    const orders = rows
      .filter((row) => row.outcome === 'found')
      .map((row) => this.#order(row));
    const last = rows.at(-1);
    return {
      orders,
      nextCursor:
        orders.length === size && last?.placedAt != null && last.orderNumber !== null
          ? encodeSellerReferenceCursor(new Date(toIso(last.placedAt)), last.orderNumber)
          : null,
    };
  }

  /** One page of the caller's own reviews, and the summary beside it. */
  async reviews(
    userId: string,
    limit: number | undefined,
    cursor: string | null,
  ): Promise<{
    readonly summary: SellerReviewSummary | null;
    readonly reviews: readonly SellerReview[];
    readonly nextCursor: string | null;
  }> {
    const size = clampLimit(limit);
    const position = this.#referenceCursor(cursor);

    let rows: readonly SellerReviewRow[];
    let summaryRow: SellerReviewSummaryRow;
    try {
      // Two readers, one round trip each, in parallel: neither writes, so their order cannot matter.
      [rows, summaryRow] = await Promise.all([
        this.store.sellerReviews({
          userId,
          limit: size,
          cursorCreatedAt: position?.at ?? null,
          cursorOrderNumber: position?.reference ?? null,
        }),
        this.store.sellerReviewsSummary(userId),
      ]);
    } catch (error) {
      this.logger.error('A seller reviews page could not be read.');
      throw new SellerIdentityUnavailableError(error);
    }

    this.#assertFound(rows, 'reviews');
    if (summaryRow.outcome === 'not_found') throw new SellerProfileNotFoundError();

    const reviews = rows.filter((row) => row.outcome === 'found').map((row) => this.#review(row));
    const last = rows.at(-1);
    return {
      summary: summaryRow.outcome === 'found' ? this.#summary(summaryRow) : null,
      reviews,
      nextCursor:
        reviews.length === size && last?.createdAt != null && last.orderNumber !== null
          ? encodeSellerReferenceCursor(new Date(toIso(last.createdAt)), last.orderNumber)
          : null,
    };
  }

  /** The caller's own balances, one per currency. No pagination: there is nothing to page. */
  async earnings(userId: string): Promise<{ readonly balances: readonly SellerBalance[] }> {
    let rows: readonly SellerBalanceRow[];
    try {
      rows = await this.store.sellerEarnings(userId);
    } catch (error) {
      this.logger.error('Seller balances could not be read.');
      throw new SellerIdentityUnavailableError(error);
    }

    this.#assertFound(rows, 'earnings');
    return {
      balances: rows
        .filter((row) => row.outcome === 'found')
        .map((row) => {
          if (
            row.currencyCode === null ||
            row.currencyDecimalPlaces === null ||
            row.pendingMinor === null ||
            row.availableMinor === null ||
            row.reservedMinor === null ||
            row.updatedAt === null
          ) {
            this.logger.error('A seller balance came back incomplete.');
            throw new SellerIdentityUnavailableError(new Error('incomplete balance'));
          }
          // The three the ledger keeps. No fourth is computed from them.
          return {
            currencyCode: row.currencyCode,
            currencyDecimalPlaces: row.currencyDecimalPlaces,
            pendingMinor: row.pendingMinor,
            availableMinor: row.availableMinor,
            reservedMinor: row.reservedMinor,
            updatedAt: toIso(row.updatedAt),
          };
        }),
    };
  }

  /** One page of the caller's own promotions. */
  async promotions(
    userId: string,
    limit: number | undefined,
    cursor: string | null,
  ): Promise<{
    readonly promotions: readonly SellerPromotion[];
    readonly nextCursor: string | null;
  }> {
    const size = clampLimit(limit);
    let position: { at: Date; id: string } | null = null;
    if (cursor !== null && cursor !== '') {
      position = decodeSellerIdCursor(cursor);
      if (position === null) throw new InvalidSellerListingCursorError();
    }

    let rows: readonly SellerPromotionRow[];
    try {
      rows = await this.store.sellerPromotions({
        userId,
        limit: size,
        cursorCreatedAt: position?.at ?? null,
        cursorId: position?.id ?? null,
      });
    } catch (error) {
      this.logger.error('A seller promotions page could not be read.');
      throw new SellerIdentityUnavailableError(error);
    }

    this.#assertFound(rows, 'promotions');
    const promotions = rows
      .filter((row) => row.outcome === 'found')
      .map((row) => this.#promotion(row));
    const last = rows.at(-1);
    return {
      promotions,
      nextCursor:
        promotions.length === size && last?.createdAt != null && last.cursorId !== null
          ? encodeSellerIdCursor(new Date(toIso(last.createdAt)), last.cursorId)
          : null,
    };
  }

  /** The rollup's totals for the caller's own promotions. */
  async analytics(userId: string, days: number | undefined): Promise<SellerAnalyticsResponse> {
    const window =
      days === undefined || !Number.isFinite(days)
        ? SELLER_ANALYTICS_DEFAULT_DAYS
        : Math.min(Math.max(Math.trunc(days), 1), SELLER_ANALYTICS_MAX_DAYS);

    let rows: readonly SellerPromotionPerformanceRow[];
    try {
      rows = await this.store.sellerPromotionAnalytics(userId, window);
    } catch (error) {
      this.logger.error('Seller promotion analytics could not be read.');
      throw new SellerIdentityUnavailableError(error);
    }

    this.#assertFound(rows, 'analytics');
    return {
      days: window,
      promotions: rows
        .filter((row) => row.outcome === 'found')
        .map((row) => {
          if (
            row.listingSlug === null ||
            row.listingTitle === null ||
            row.status === null ||
            row.firstDay === null ||
            row.lastDay === null ||
            row.impressions === null ||
            row.views === null ||
            row.clicks === null
          ) {
            this.logger.error('A promotion performance row came back incomplete.');
            throw new SellerIdentityUnavailableError(new Error('incomplete performance row'));
          }
          // The rollup's three totals, and nothing derived from them.
          return {
            listingSlug: row.listingSlug,
            listingTitle: row.listingTitle,
            status: row.status as SellerPromotionPerformance['status'],
            firstDay: toDay(row.firstDay),
            lastDay: toDay(row.lastDay),
            impressions: row.impressions,
            views: row.views,
            clicks: row.clicks,
          };
        }),
    };
  }

  /**
   * The rollup's totals for the caller's own listings (0102).
   *
   * A sibling of `analytics` above rather than a field added to it: 6-J's response shape is closed and stays as
   * it is. Four counts, every one of them the rollup's. **No impressions and no views** — 0101 ingests neither —
   * and no rate, ratio or click-through, because none of them has a denominator in this schema.
   */
  async listingAnalytics(userId: string, days: number | undefined): Promise<SellerListingAnalyticsResponse> {
    const window =
      days === undefined || !Number.isFinite(days)
        ? LISTING_ANALYTICS_DEFAULT_DAYS
        : Math.min(Math.max(Math.trunc(days), 1), LISTING_ANALYTICS_MAX_DAYS);

    let rows: readonly SellerListingPerformanceRow[];
    try {
      rows = await this.store.sellerListingAnalytics(userId, window);
    } catch (error) {
      this.logger.error('Seller listing analytics could not be read.');
      throw new SellerIdentityUnavailableError(error);
    }

    this.#assertFound(rows, 'listing analytics');
    return {
      days: window,
      listings: rows
        .filter((row) => row.outcome === 'found')
        .map((row) => {
          if (
            row.listingSlug === null ||
            row.listingTitle === null ||
            row.listingStatus === null ||
            row.firstDay === null ||
            row.lastDay === null ||
            row.clicks === null ||
            row.contacts === null ||
            row.favorites === null ||
            row.shares === null
          ) {
            this.logger.error('A listing performance row came back incomplete.');
            throw new SellerIdentityUnavailableError(new Error('incomplete performance row'));
          }
          // The rollup's four totals, and nothing derived from them.
          return {
            listingSlug: row.listingSlug,
            listingTitle: row.listingTitle,
            listingStatus: row.listingStatus as SellerListingPerformance['listingStatus'],
            firstDay: toDay(row.firstDay),
            lastDay: toDay(row.lastDay),
            clicks: row.clicks,
            contacts: row.contacts,
            favorites: row.favorites,
            shares: row.shares,
          };
        }),
    };
  }

  /**
   * A cursor that decodes, or a 400.
   *
   * The same refusal 6-F's listings cursor gives, and for the same reason: a cursor this API did not issue is
   * a client's mistake to correct, not a page to guess at.
   */
  #referenceCursor(cursor: string | null): { at: Date; reference: string } | null {
    if (cursor === null || cursor === '') return null;
    const decoded = decodeSellerReferenceCursor(cursor);
    if (decoded === null) throw new InvalidSellerListingCursorError();
    return decoded;
  }

  /**
   * The one refusal every reader shares: the caller has no storefront.
   *
   * A reader answers `not_found` in exactly that case and returns no rows at all when the storefront simply
   * has nothing yet — which is why an empty array here is a legitimate empty page rather than a 404, and why
   * the two are never conflated.
   */
  #assertFound(rows: readonly { readonly outcome: string }[], what: string): void {
    const first = rows[0];
    if (first === undefined) return;
    if (first.outcome === 'found') return;
    if (first.outcome === 'not_found') throw new SellerProfileNotFoundError();
    if (first.outcome === 'none') return;
    this.logger.error(`A seller ${what} read returned an outcome this service does not understand.`);
    throw new SellerIdentityUnavailableError(new Error('unexpected outcome'));
  }

  /**
   * One order, projected field by field.
   *
   * Written out rather than spread so a reader that later grew a column could not carry it outward silently.
   * The items are rebuilt the same way, from the seven fields the reader's `jsonb` carries.
   */
  #order(row: SellerOrderRow): SellerOrder {
    if (
      row.orderNumber === null ||
      row.orderType === null ||
      row.status === null ||
      row.currencyCode === null ||
      row.currencyDecimalPlaces === null ||
      row.subtotalMinor === null ||
      row.shippingTotalMinor === null ||
      row.taxTotalMinor === null ||
      row.discountTotalMinor === null ||
      row.commissionTotalMinor === null ||
      row.grandTotalMinor === null ||
      row.sellerNetMinor === null ||
      row.itemCount === null ||
      row.placedAt === null
    ) {
      this.logger.error('A seller order came back incomplete.');
      throw new SellerIdentityUnavailableError(new Error('incomplete order'));
    }
    return {
      orderNumber: row.orderNumber,
      orderType: row.orderType as SellerOrder['orderType'],
      status: row.status as SellerOrder['status'],
      currencyCode: row.currencyCode,
      currencyDecimalPlaces: row.currencyDecimalPlaces,
      subtotalMinor: row.subtotalMinor,
      shippingTotalMinor: row.shippingTotalMinor,
      taxTotalMinor: row.taxTotalMinor,
      discountTotalMinor: row.discountTotalMinor,
      commissionTotalMinor: row.commissionTotalMinor,
      grandTotalMinor: row.grandTotalMinor,
      sellerNetMinor: row.sellerNetMinor,
      itemCount: row.itemCount,
      placedAt: toIso(row.placedAt),
      paidAt: toIsoOrNull(row.paidAt),
      shippedAt: toIsoOrNull(row.shippedAt),
      deliveredAt: toIsoOrNull(row.deliveredAt),
      completedAt: toIsoOrNull(row.completedAt),
      cancelledAt: toIsoOrNull(row.cancelledAt),
      items: this.#items(row.items),
    };
  }

  #items(raw: unknown): SellerOrderItem[] {
    if (!Array.isArray(raw)) return [];
    const items: SellerOrderItem[] = [];
    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null) continue;
      const item = entry as Record<string, unknown>;
      const title = typeof item['title'] === 'string' ? item['title'] : null;
      const slug = typeof item['slug'] === 'string' ? item['slug'] : null;
      const listingTypeCode =
        typeof item['listingTypeCode'] === 'string' ? item['listingTypeCode'] : null;
      const quantity = typeof item['quantity'] === 'number' ? item['quantity'] : null;
      const cancelledQuantity =
        typeof item['cancelledQuantity'] === 'number' ? item['cancelledQuantity'] : null;
      const unitPriceMinor =
        typeof item['unitPriceMinor'] === 'string' ? item['unitPriceMinor'] : null;
      const lineTotalMinor =
        typeof item['lineTotalMinor'] === 'string' ? item['lineTotalMinor'] : null;
      if (
        title === null ||
        slug === null ||
        listingTypeCode === null ||
        quantity === null ||
        cancelledQuantity === null ||
        unitPriceMinor === null ||
        lineTotalMinor === null
      ) {
        this.logger.error('An order item came back in a shape this service does not project.');
        throw new SellerIdentityUnavailableError(new Error('incomplete order item'));
      }
      items.push({
        title,
        slug,
        listingTypeCode: listingTypeCode as SellerOrderItem['listingTypeCode'],
        quantity,
        cancelledQuantity,
        unitPriceMinor,
        lineTotalMinor,
      });
    }
    return items;
  }

  #review(row: SellerReviewRow): SellerReview {
    if (
      row.orderNumber === null ||
      row.rating === null ||
      row.status === null ||
      row.publishedAt === null ||
      row.createdAt === null
    ) {
      this.logger.error('A seller review came back incomplete.');
      throw new SellerIdentityUnavailableError(new Error('incomplete review'));
    }
    return {
      orderNumber: row.orderNumber,
      rating: row.rating,
      title: row.title,
      body: row.body,
      status: row.status as SellerReview['status'],
      publishedAt: toIso(row.publishedAt),
      createdAt: toIso(row.createdAt),
      replyBody: row.replyBody,
      replyStatus: row.replyStatus === null ? null : (row.replyStatus as SellerReview['status']),
      replyCreatedAt: toIsoOrNull(row.replyCreatedAt),
    };
  }

  /** The view's numbers, passed through. Nothing is converted, re-rounded or rescaled. */
  #summary(row: SellerReviewSummaryRow): SellerReviewSummary {
    if (
      row.reviewCount === null ||
      row.averageRatingBasisPoints === null ||
      row.fiveStarCount === null ||
      row.fourStarCount === null ||
      row.threeStarCount === null ||
      row.twoStarCount === null ||
      row.oneStarCount === null
    ) {
      this.logger.error('A seller rating summary came back incomplete.');
      throw new SellerIdentityUnavailableError(new Error('incomplete summary'));
    }
    return {
      reviewCount: row.reviewCount,
      averageRatingBasisPoints: row.averageRatingBasisPoints,
      fiveStarCount: row.fiveStarCount,
      fourStarCount: row.fourStarCount,
      threeStarCount: row.threeStarCount,
      twoStarCount: row.twoStarCount,
      oneStarCount: row.oneStarCount,
      latestReviewAt: toIsoOrNull(row.latestReviewAt),
    };
  }

  #promotion(row: SellerPromotionRow): SellerPromotion {
    if (
      row.listingSlug === null ||
      row.listingTitle === null ||
      row.status === null ||
      row.currencyCode === null ||
      row.currencyDecimalPlaces === null ||
      row.priceMinor === null ||
      row.refundedAmountMinor === null ||
      row.priority === null ||
      row.durationDays === null ||
      row.createdAt === null
    ) {
      this.logger.error('A seller promotion came back incomplete.');
      throw new SellerIdentityUnavailableError(new Error('incomplete promotion'));
    }
    // `cursorId` is deliberately not among these fields: it is the keyset tie-breaker and stops here.
    return {
      listingSlug: row.listingSlug,
      listingTitle: row.listingTitle,
      status: row.status as SellerPromotion['status'],
      currencyCode: row.currencyCode,
      currencyDecimalPlaces: row.currencyDecimalPlaces,
      priceMinor: row.priceMinor,
      refundedAmountMinor: row.refundedAmountMinor,
      priority: row.priority,
      durationDays: row.durationDays,
      startsAt: toIsoOrNull(row.startsAt),
      endsAt: toIsoOrNull(row.endsAt),
      activatedAt: toIsoOrNull(row.activatedAt),
      pausedAt: toIsoOrNull(row.pausedAt),
      expiredAt: toIsoOrNull(row.expiredAt),
      cancelledAt: toIsoOrNull(row.cancelledAt),
      createdAt: toIso(row.createdAt),
    };
  }
}
