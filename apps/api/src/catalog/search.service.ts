import { Inject, Injectable, Logger } from '@nestjs/common';
import type { CatalogFilters, PublicLocale, SearchResult, ServicePricingModel } from '@repo/contracts';
import { CatalogUnavailableError } from './catalog-errors.js';
import { InvalidListingCursorError, decodeCursor, encodeCursor } from './listings.service.js';

/**
 * Public search (Phase 4-F, with 8-D's filters).
 *
 * The specification names a `SearchPort` abstraction; this is it, defined at exactly the contract that
 * exists and no wider. One method: take a query, a locale, the shared filter document and a keyset
 * position, and return a page of public results. It is still not a query builder — there is no sort, no
 * facet and no ranking parameter, because those need decisions nobody has made.
 *
 * The filters are 8-D's and are the same document a category feed takes: one language, judged once, in the
 * database. Filtering can only narrow, because every filter is applied on top of the same visibility rules.
 *
 * Ordering is the database's, and it is provisional: newest first, by owner decision, until Phase 9
 * settles the ranking formula. Nothing here computes a relevance score or reads a promotion setting.
 */

/** One row as the reader returns it: every card field of both surfaces, with `resultType` saying which. */
export interface SearchRow {
  readonly resultType: 'listing' | 'service';
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly city: string | null;
  readonly priceMinor: string | null;
  readonly currencyCode: string;
  readonly currencyMinorUnit: number;
  readonly isNegotiable: boolean | null;
  readonly listingTypeCode: string | null;
  readonly pricingModel: ServicePricingModel | null;
  readonly deliveryDays: number | null;
  readonly revisionsIncluded: number | null;
  readonly createdAt: Date;
}

/**
 * `SearchPort` — the whole of it.
 *
 * One method. 8-D widened it by exactly one input, the filter document, which is the increment that widened
 * search doing the widening; there is still no sort, no facet and no ranking parameter, because ordering is
 * the database's provisional newest-first and the ranking formula is a Phase 9 decision.
 */
export interface SearchPort {
  /** `app_private.public_catalog_search(text, text, jsonb, integer, timestamptz, uuid)`. */
  publicSearch(input: {
    query: string;
    locale: PublicLocale;
    filters: CatalogFilters;
    limit: number;
    cursorCreatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly SearchRow[]>;
}

export const SEARCH_PORT = Symbol('SEARCH_PORT');

export interface SearchPage {
  readonly items: readonly SearchResult[];
  readonly nextCursor: string | null;
}

/**
 * Turns one row into the discriminated result it belongs to.
 *
 * A row whose type does not match the fields it carries is a disagreement between this service and the
 * reader, so it fails rather than producing a half-populated card.
 *
 * Exported because 8-D's category feed returns the same rows from the same projection: one definition of
 * what a public card is, rather than two that could drift.
 */
export function toSearchResult(row: SearchRow): SearchResult {
  const shared = {
    id: row.id,
    slug: row.slug,
    title: row.title,
    city: row.city,
    priceMinor: row.priceMinor,
    currencyCode: row.currencyCode,
    currencyMinorUnit: row.currencyMinorUnit,
  };

  if (row.resultType === 'service') {
    return {
      type: 'service',
      ...shared,
      pricingModel: row.pricingModel,
      deliveryDays: row.deliveryDays,
      revisionsIncluded: row.revisionsIncluded,
    };
  }

  if (row.isNegotiable === null || row.listingTypeCode === null) {
    throw new CatalogUnavailableError(new Error('a listing result arrived without its card fields'));
  }

  return {
    type: 'listing',
    ...shared,
    isNegotiable: row.isNegotiable,
    listingTypeCode: row.listingTypeCode,
  };
}

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(@Inject(SEARCH_PORT) private readonly port: SearchPort) {}

  /**
   * One page of results.
   *
   * The page is read one row longer than asked for, so `nextCursor` is null exactly when this page is
   * the last one rather than one request later.
   */
  async search(input: {
    query: string;
    locale: PublicLocale;
    filters: CatalogFilters;
    limit: number;
    cursor: string | null;
  }): Promise<SearchPage> {
    let position: { createdAt: Date; id: string } | null = null;
    if (input.cursor !== null) {
      position = decodeCursor(input.cursor);
      if (position === null) throw new InvalidListingCursorError();
    }

    let rows: readonly SearchRow[];
    try {
      rows = await this.port.publicSearch({
        query: input.query,
        locale: input.locale,
        filters: input.filters,
        limit: input.limit + 1,
        cursorCreatedAt: position?.createdAt ?? null,
        cursorId: position?.id ?? null,
      });
    } catch (error) {
      this.logger.error('A search could not be run.');
      throw new CatalogUnavailableError(error);
    }

    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    const last = page.at(-1);
    return {
      items: page.map(toSearchResult),
      nextCursor: hasMore && last !== undefined ? encodeCursor(last.createdAt, last.id) : null,
    };
  }
}
