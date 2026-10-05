import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  LISTING_ANALYTICS_DEFAULT_DAYS,
  LISTING_ANALYTICS_DEFAULT_LIMIT,
  LISTING_ANALYTICS_MAX_DAYS,
  LISTING_ANALYTICS_MAX_LIMIT,
  type ListingAnalyticsResponse,
  type ListingAnalyticsRow,
} from '@repo/contracts';
import { isAal2 } from '../auth/access-token-claims.js';
import { StaffConsoleService } from '../admin/staff-console.service.js';
import {
  ListingAnalyticsCursorInvalidError,
  ListingAnalyticsUnavailableError,
} from './listing-events.errors.js';
import {
  decodeListingAnalyticsCursor,
  encodeListingAnalyticsCursor,
} from './listing-analytics.cursor.js';

export const LISTING_ANALYTICS_STORE = Symbol('LISTING_ANALYTICS_STORE');

/** One row of `app_private.listing_analytics_page`, as the database hands it over. */
export interface ListingAnalyticsDbRow {
  readonly day: Date | string;
  readonly listingSlug: string;
  readonly listingTitle: string;
  readonly listingStatus: string;
  readonly sellerSlug: string | null;
  readonly clicks: string;
  readonly contacts: string;
  readonly favorites: string;
  readonly shares: string;
  readonly computedAt: Date | string;
  readonly cursorDay: Date | string;
  readonly cursorListingId: string;
}

export interface ListingAnalyticsStore {
  /** `app_private.listing_analytics_page(uuid, boolean, integer, integer, date, uuid)` (0102). */
  listingAnalyticsPage(input: {
    userId: string;
    isAal2: boolean;
    days: number;
    limit: number;
    cursorDay: string | null;
    cursorListingId: string | null;
  }): Promise<readonly ListingAnalyticsDbRow[]>;
}

/** A `date` column, as the ten characters a calendar day is. */
function toDay(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * The staff listing analytics surface (0102).
 *
 * **The first consumer of `analytics.listing.read`**, a key seeded since 0033 and until now reached by nothing
 * but two RLS policies. The gate is the database's: `listing_analytics_page` re-applies the permission and the
 * assurance level as parameters, so this service never decides who may read.
 *
 * **A refusal looks like an empty page, and that is deliberate.** A caller without the key at AAL2 gets no rows,
 * which is the same answer as a window with nothing in it, so this surface cannot be used to find out whether
 * any listing has traffic. There is no 403 and no 404 here.
 *
 * **It reads, and nothing else.** There is no write anywhere in 0102: a day is corrected by re-running the
 * scheduled job for it. Every number comes from the rollup — no rate, no ratio, no click-through, and no
 * impressions or views, because 0101 ingests neither.
 */
@Injectable()
export class ListingAnalyticsService {
  private readonly logger = new Logger(ListingAnalyticsService.name);

  constructor(
    @Inject(LISTING_ANALYTICS_STORE) private readonly store: ListingAnalyticsStore,
    private readonly console: StaffConsoleService,
  ) {}

  async page(input: {
    accessToken: string;
    days: number | undefined;
    limit: number | undefined;
    cursor: string | null;
  }): Promise<ListingAnalyticsResponse> {
    const days = clamp(input.days, LISTING_ANALYTICS_DEFAULT_DAYS, LISTING_ANALYTICS_MAX_DAYS);
    const limit = clamp(input.limit, LISTING_ANALYTICS_DEFAULT_LIMIT, LISTING_ANALYTICS_MAX_LIMIT);

    // Decoded before anything is read, so a malformed position is a client's mistake to correct rather than a
    // page guessed at. One refusal for malformed, altered, outdated, and for a position from another list.
    const position = input.cursor === null ? null : decodeListingAnalyticsCursor(input.cursor);
    if (input.cursor !== null && position === null) throw new ListingAnalyticsCursorInvalidError();

    // The session, for the account only. **The permission is not checked here**: the database applies it, so a
    // caller who does not hold it receives an empty page rather than a refusal, and a non-staff caller reaches
    // a session with no permissions at all rather than an error.
    const session = await this.console.forToken(input.accessToken);
    const aal2 = isAal2(input.accessToken);

    let rows: readonly ListingAnalyticsDbRow[];
    try {
      rows = await this.store.listingAnalyticsPage({
        userId: session.id,
        isAal2: aal2,
        days,
        // One more than asked, which is how "is there another page" is answered without a count. The
        // reader's ceiling is the public maximum plus one so this row survives the clamp (0106).
        limit: limit + 1,
        cursorDay: position?.day ?? null,
        cursorListingId: position?.listingId ?? null,
      });
    } catch (error) {
      this.logger.error('Listing analytics could not be read.');
      throw new ListingAnalyticsUnavailableError(error);
    }

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);

    return {
      days,
      items: page.map((row) => this.#row(row)),
      nextCursor:
        hasMore && last !== undefined
          ? encodeListingAnalyticsCursor({
              day: toDay(last.cursorDay),
              listingId: last.cursorListingId,
            })
          : null,
    };
  }

  /**
   * One row, with the cursor's own position left behind.
   *
   * `cursorDay` and `cursorListingId` are how the next page is found and are not part of the response: the
   * listing's identifier reaches a browser only inside the opaque cursor, never as a field.
   */
  #row(row: ListingAnalyticsDbRow): ListingAnalyticsRow {
    return {
      day: toDay(row.day),
      listingSlug: row.listingSlug,
      listingTitle: row.listingTitle,
      listingStatus: row.listingStatus as ListingAnalyticsRow['listingStatus'],
      sellerSlug: row.sellerSlug,
      clicks: row.clicks,
      contacts: row.contacts,
      favorites: row.favorites,
      shares: row.shares,
      computedAt: toIso(row.computedAt),
    };
  }
}

/** A bound the client cannot widen. An absent or unusable value is the default, never an error. */
function clamp(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), 1), max);
}
