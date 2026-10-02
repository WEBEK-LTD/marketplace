import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ATTRIBUTE_DATA_TYPES,
  CATALOG_FACET_KINDS,
  type AttributeDataType,
  type CatalogFacet,
  type CatalogFacetKind,
  type CatalogFacetValue,
  type CatalogFilters,
  type PublicLocale,
  type SearchResult,
} from '@repo/contracts';
import { CatalogUnavailableError } from './catalog-errors.js';
import { InvalidListingCursorError, decodeCursor, encodeCursor } from './listings.service.js';
import { toSearchResult, type SearchRow } from './search.service.js';

/**
 * The listings in one public category, and the filter panel that produced them (Phase 8-D).
 *
 * **Every rule is the database's.** 0089 owns the rollup across descendants, the three visibility helpers,
 * what a filter means and what a facet count counts. This service decodes a cursor, calls two readers and
 * groups rows; it re-decides nothing, which is why a category feed and a filtered search cannot disagree
 * about what "oak" selects — they are the same two functions underneath.
 *
 * **The result shape is search's**, reused rather than reimplemented: a category may hold products,
 * services or both, so one page is mixed and `type` discriminates, exactly as a search page does.
 *
 * **Nothing is ranked.** Ordering is the database's provisional newest-first, and the facet counts are
 * counts: no weight, no promotion, no popularity, and nothing here reads a promotion setting.
 *
 * **An empty page is not an error, and two empties are different.** A category whose filters match nothing
 * returns no items with a populated panel; a category with nothing in it returns no items and no panel. The
 * surfaces above need to tell those apart to say the right sentence, so this service keeps them distinct
 * rather than flattening both to "empty".
 */

/** One facet row as 0089 returns it, before grouping. */
export interface CategoryFacetRow {
  readonly facetKind: string;
  readonly attributeKey: string | null;
  readonly attributeLabel: string | null;
  readonly dataType: string | null;
  readonly unit: string | null;
  readonly attributeSortOrder: number;
  readonly value: string | null;
  readonly label: string | null;
  readonly valueSortOrder: number;
  readonly matchCount: number;
  readonly numberMin: string | null;
  readonly numberMax: string | null;
}

/**
 * The port, at exactly the contract 0089 offers and no wider.
 *
 * Two methods, because a page of a category is two questions — what is in it, and what could narrow it —
 * and they are separate readers so a screen that needs only one pays for only one.
 */
export interface CategoryFeedPort {
  /** `app_private.public_category_feed(text, jsonb, integer, timestamptz, uuid)`. */
  publicCategoryFeed(input: {
    slug: string;
    filters: CatalogFilters;
    limit: number;
    cursorCreatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly SearchRow[]>;
  /** `app_private.public_category_facets(text, text, jsonb)`. */
  publicCategoryFacets(input: {
    slug: string;
    locale: PublicLocale;
    filters: CatalogFilters;
  }): Promise<readonly CategoryFacetRow[]>;
}

export const CATEGORY_FEED_PORT = Symbol('CATEGORY_FEED_PORT');

export interface CategoryFeedPage {
  readonly items: readonly SearchResult[];
  readonly nextCursor: string | null;
  readonly facets: readonly CatalogFacet[];
}

function facetKindOf(value: string): CatalogFacetKind | null {
  return (CATALOG_FACET_KINDS as readonly string[]).includes(value) ? (value as CatalogFacetKind) : null;
}

function dataTypeOf(value: string | null): AttributeDataType | null {
  if (value === null) return null;
  return (ATTRIBUTE_DATA_TYPES as readonly string[]).includes(value) ? (value as AttributeDataType) : null;
}

@Injectable()
export class CategoryFeedService {
  private readonly logger = new Logger(CategoryFeedService.name);

  constructor(@Inject(CATEGORY_FEED_PORT) private readonly port: CategoryFeedPort) {}

  /**
   * One page of a category's listings, with its panel.
   *
   * The page is read one row longer than asked for, so `nextCursor` is null exactly when this page is the
   * last one rather than one request later — the same keyset rule every other public list uses.
   */
  async page(input: {
    slug: string;
    locale: PublicLocale;
    filters: CatalogFilters;
    limit: number;
    cursor: string | null;
  }): Promise<CategoryFeedPage> {
    let position: { createdAt: Date; id: string } | null = null;
    if (input.cursor !== null) {
      position = decodeCursor(input.cursor);
      if (position === null) throw new InvalidListingCursorError();
    }

    let rows: readonly SearchRow[];
    let facetRows: readonly CategoryFacetRow[];
    try {
      [rows, facetRows] = await Promise.all([
        this.port.publicCategoryFeed({
          slug: input.slug,
          filters: input.filters,
          limit: input.limit + 1,
          cursorCreatedAt: position?.createdAt ?? null,
          cursorId: position?.id ?? null,
        }),
        this.port.publicCategoryFacets({
          slug: input.slug,
          locale: input.locale,
          filters: input.filters,
        }),
      ]);
    } catch (error) {
      // No detail and nothing about the rows: a listing carries seller-written prose and a price.
      this.logger.error('A category feed could not be read.');
      throw new CatalogUnavailableError(error);
    }

    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    const last = page.at(-1);

    return {
      items: page.map((row) => toSearchResult(row)),
      nextCursor: hasMore && last !== undefined ? encodeCursor(last.createdAt, last.id) : null,
      facets: this.#facets(facetRows),
    };
  }

  /**
   * Groups the facet rows into dimensions.
   *
   * One row per value arrives; a panel wants one entry per dimension with its values inside. The grouping
   * is by kind and, for an attribute, by key — and the database's own ordering is preserved rather than
   * re-sorted here, because the order a facet is presented in is the administrator's `sort_order`.
   *
   * A row whose kind or data type this API does not know is dropped rather than forwarded: a dimension a
   * screen cannot render is worse than one it never saw, and the drop is logged as the drift it would be.
   */
  #facets(rows: readonly CategoryFacetRow[]): readonly CatalogFacet[] {
    const facets: CatalogFacet[] = [];
    const attributeIndex = new Map<string, number>();
    let unknown = 0;

    for (const row of rows) {
      const kind = facetKindOf(row.facetKind);
      if (kind === null) {
        unknown += 1;
        continue;
      }

      if (kind === 'attribute') {
        const key = row.attributeKey;
        const dataType = dataTypeOf(row.dataType);
        if (key === null || dataType === null) {
          unknown += 1;
          continue;
        }

        const existing = attributeIndex.get(key);
        if (existing === undefined) {
          attributeIndex.set(key, facets.length);
          facets.push({
            kind,
            key,
            label: row.attributeLabel,
            dataType,
            unit: row.unit,
            // A number carries a span and no values: two boxes need bounds, and buckets would be a rule
            // nobody has written.
            values: row.value === null ? [] : [this.#value(row)],
            rangeMin: row.numberMin,
            rangeMax: row.numberMax,
            minorUnit: null,
          });
          continue;
        }

        const facet = facets[existing];
        if (facet === undefined || row.value === null) continue;
        facets[existing] = { ...facet, values: [...facet.values, this.#value(row)] };
        continue;
      }

      if (kind === 'currency') {
        // One dimension per currency, because each has its own decimal places and its own price span, and
        // a bound is only ever read inside one currency.
        facets.push({
          kind,
          key: null,
          label: row.label,
          dataType: null,
          unit: null,
          values: row.value === null ? [] : [this.#value(row)],
          rangeMin: row.numberMin,
          rangeMax: row.numberMax,
          minorUnit: row.valueSortOrder,
        });
        continue;
      }

      // Tags and listing types are one dimension each, however many values they carry.
      const existing = facets.findIndex((candidate) => candidate.kind === kind);
      if (existing === -1) {
        facets.push({
          kind,
          key: null,
          label: null,
          dataType: null,
          unit: null,
          values: row.value === null ? [] : [this.#value(row)],
          rangeMin: null,
          rangeMax: null,
          minorUnit: null,
        });
        continue;
      }
      const facet = facets[existing];
      if (facet === undefined || row.value === null) continue;
      facets[existing] = { ...facet, values: [...facet.values, this.#value(row)] };
    }

    if (unknown > 0) {
      this.logger.error('A facet row arrived in a shape this API does not know, and was not forwarded.');
    }
    return facets;
  }

  #value(row: CategoryFacetRow): CatalogFacetValue {
    return {
      value: row.value ?? '',
      label: row.label ?? row.value ?? '',
      matchCount: row.matchCount,
    };
  }
}
