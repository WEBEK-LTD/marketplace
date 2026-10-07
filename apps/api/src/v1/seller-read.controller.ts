import { Controller, Get, Query, Req } from '@nestjs/common';
import {
  SESSION_TOKEN_HEADER,
  type SellerAnalyticsResponse,
  type SellerListingAnalyticsResponse,
  type SellerEarningsResponse,
  type SellerOrdersResponse,
  type SellerPromotionsResponse,
  type SellerReviewsResponse,
} from '@repo/contracts';
import { AuthenticationRequiredError } from '../auth/auth-errors.js';
import { SellerReadService } from '../sellers/seller-read.service.js';
import { CurrentUserService } from '../users/current-user.service.js';

/** Fastify's request, reduced to the one thing these routes read. */
interface SellerReadRequestContext {
  readonly headers: Record<string, unknown>;
}

function header(context: SellerReadRequestContext, name: string): string | null {
  const value = context.headers[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
}

function asInteger(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * The read-only seller surfaces (Phase 6-J).
 *
 * Five routes under `/v1/sellers/me`, all GET. **There is no POST, PATCH, PUT or DELETE in this controller**,
 * and no handler takes a body: the only inputs are a page size, a cursor and an analytics window, each of
 * which selects rows and decides nothing about them.
 *
 * Every route resolves the caller from their own access token before anything else is used, and passes only
 * that id downstream. None of them accepts a seller, an owner, a buyer or a status from the request, so there
 * is nothing for a caller to forge and nothing to authorize against but their own session.
 *
 * **No rate limit.** A read consumes no seller write bucket, so `SellerThrottleService` is not injected here
 * at all — there is nothing in this controller that could spend one of the approved Phase 6 numbers.
 *
 * **Why its own controller.** `SellerIdentityController` owns the profile, `SellerMediaController` the media,
 * `SellerListingsController` the listings, `SellerServicesController` the services and
 * `SellerVerificationController` the verification; these five reads are a sixth concern with their own store,
 * and keeping them apart is what leaves the frozen 6-A through 6-I routes untouched by this increment. Nest
 * mounts all six on `v1/sellers` without any shadowing another: `me/orders`, `me/reviews`, `me/earnings`,
 * `me/promotions` and `me/analytics` are static prefixes that cannot collide with `me`, `me/media`,
 * `me/listings`, `me/services`, `me/verification` or the parametric `:slug`.
 */
@Controller('v1/sellers')
export class SellerReadController {
  constructor(
    private readonly users: CurrentUserService,
    private readonly read: SellerReadService,
  ) {}

  /** `GET /v1/sellers/me/orders` — one page of the caller's own orders. */
  @Get('me/orders')
  async orders(
    @Req() request: SellerReadRequestContext,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<SellerOrdersResponse> {
    const userId = await this.caller(request);
    const page = await this.read.orders(
      userId,
      asInteger(limit),
      cursor === undefined || cursor === '' ? null : cursor,
    );
    return { orders: [...page.orders], nextCursor: page.nextCursor };
  }

  /** `GET /v1/sellers/me/reviews` — one page of reviews, and the rating summary beside it. */
  @Get('me/reviews')
  async reviews(
    @Req() request: SellerReadRequestContext,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<SellerReviewsResponse> {
    const userId = await this.caller(request);
    const page = await this.read.reviews(
      userId,
      asInteger(limit),
      cursor === undefined || cursor === '' ? null : cursor,
    );
    return { summary: page.summary, reviews: [...page.reviews], nextCursor: page.nextCursor };
  }

  /**
   * `GET /v1/sellers/me/earnings` — the caller's own balances.
   *
   * A read, and only a read. There is no withdrawal, payout or transfer route in this controller or anywhere
   * else in this API.
   */
  @Get('me/earnings')
  async earnings(@Req() request: SellerReadRequestContext): Promise<SellerEarningsResponse> {
    const userId = await this.caller(request);
    const result = await this.read.earnings(userId);
    return { balances: [...result.balances] };
  }

  /** `GET /v1/sellers/me/promotions` — one page of the caller's own promotions. */
  @Get('me/promotions')
  async promotions(
    @Req() request: SellerReadRequestContext,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<SellerPromotionsResponse> {
    const userId = await this.caller(request);
    const page = await this.read.promotions(
      userId,
      asInteger(limit),
      cursor === undefined || cursor === '' ? null : cursor,
    );
    return { promotions: [...page.promotions], nextCursor: page.nextCursor };
  }

  /**
   * `GET /v1/sellers/me/analytics` — the rollup's totals for the caller's own promotions.
   *
   * 0102 added a sibling route for listing-level analytics below. This one's shape is unchanged by it.
   */
  @Get('me/analytics')
  async analytics(
    @Req() request: SellerReadRequestContext,
    @Query('days') days?: string,
  ): Promise<SellerAnalyticsResponse> {
    const userId = await this.caller(request);
    const result = await this.read.analytics(userId, asInteger(days));
    return { days: result.days, promotions: [...result.promotions] };
  }

  /**
   * `GET /v1/sellers/me/listing-analytics` — the rollup's totals for the caller's own listings (0102).
   *
   * A separate route rather than a field on the one above, so 6-J's closed response shape stays as it is. Four
   * counts, every one of them the rollup's: no impressions, no views, no rate and nothing derived.
   */
  @Get('me/listing-analytics')
  async listingAnalytics(
    @Req() request: SellerReadRequestContext,
    @Query('days') days?: string,
  ): Promise<SellerListingAnalyticsResponse> {
    const userId = await this.caller(request);
    const result = await this.read.listingAnalytics(userId, asInteger(days));
    return { days: result.days, listings: [...result.listings] };
  }

  /** The caller, from their own token. No route here accepts an identifier from anywhere else. */
  private async caller(request: SellerReadRequestContext): Promise<string> {
    const accessToken = header(request, SESSION_TOKEN_HEADER);
    if (accessToken === null || accessToken === '') throw new AuthenticationRequiredError();
    const user = await this.users.forToken(accessToken);
    return user.id;
  }
}
