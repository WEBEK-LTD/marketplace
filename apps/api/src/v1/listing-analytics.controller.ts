import { Controller, Get, Query, Req } from '@nestjs/common';
import {
  LISTING_ANALYTICS_DEFAULT_LIMIT,
  LISTING_ANALYTICS_MAX_LIMIT,
  SESSION_TOKEN_HEADER,
  parseMessagingLimit,
  type ListingAnalyticsResponse,
} from '@repo/contracts';
import { AuthenticationRequiredError } from '../auth/auth-errors.js';
import { ListingAnalyticsService } from '../analytics/listing-analytics.service.js';
import { RequestValidationException } from '../common/request-validation.exception.js';

/** Fastify's request, reduced to the one thing this route reads. */
interface ListingAnalyticsRequestContext {
  readonly headers: Record<string, unknown>;
}

function header(request: ListingAnalyticsRequestContext, name: string): string | null {
  const value = request.headers[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
}

function asInteger(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Staff listing analytics (0102).
 *
 * **One operation, and it is a `GET`.** There is no `@Post`, `@Patch`, `@Put` or `@Delete` here and no `@Body`
 * anywhere in it, because nothing in 0102 writes: the rollup is a scheduled job, and a day is corrected by
 * re-running that job rather than by a console. A console that could edit an aggregate would be a console that
 * could make the numbers say anything.
 *
 * **It decides nothing about access.** `analytics.listing.read` and the assurance level are applied by the
 * database reader with the account and the AAL as parameters, so a caller who does not hold the key at AAL2
 * receives an empty page — the same answer as a window with nothing in it. There is no 403 and no 404 here, and
 * this route cannot be used to find out whether any listing has traffic.
 *
 * **Every number is the rollup's.** No rate, no ratio, no click-through, no impressions and no views, because
 * 0101 ingests neither of the last two and their definitions are a later decision. The counts are `bigint` and
 * travel as decimal integer strings — counts, not money.
 */
@Controller('v1/admin/analytics')
export class ListingAnalyticsController {
  constructor(private readonly analytics: ListingAnalyticsService) {}

  @Get('listings')
  async listings(
    @Req() request: ListingAnalyticsRequestContext,
    @Query('days') days?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<ListingAnalyticsResponse> {
    const accessToken = header(request, SESSION_TOKEN_HEADER);
    if (accessToken === null || accessToken === '') throw new AuthenticationRequiredError();

    const page = await this.analytics.page({
      accessToken,
      days: asInteger(days),
      limit: this.#limit(limit),
      cursor: cursor === undefined || cursor === '' ? null : cursor,
    });
    return { days: page.days, items: [...page.items], nextCursor: page.nextCursor };
  }

  /** The page size, refused rather than silently defaulted when it is malformed. */
  #limit(value: string | undefined): number {
    const parsed = parseMessagingLimit(value, {
      fallback: LISTING_ANALYTICS_DEFAULT_LIMIT,
      maximum: LISTING_ANALYTICS_MAX_LIMIT,
    });
    if (!parsed.ok) {
      throw new RequestValidationException([{ path: 'limit', message: 'The limit is invalid.' }]);
    }
    return parsed.limit;
  }
}
