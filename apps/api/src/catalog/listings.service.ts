import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  CanonicalSurface,
  ListingAttribute,
  ListingCategory,
  ListingDetail,
  ListingSummary,
  ListingTag,
  PublicSeller,
  PublicLocale,
} from '@repo/contracts';
import { CatalogUnavailableError } from './catalog-errors.js';

/**
 * Public listings (Phase 4-B).
 *
 * Two reads, both answered entirely by `app_private`: which listings are public, which are still
 * available, what a previous slug points at and what each field contains are all the database's
 * decisions. This service encodes and decodes the pagination cursor, converts the rows into the shared
 * contract, and turns a database failure into the approved 503.
 *
 * It holds no user context: the same answer goes to a guest and to a signed-in person.
 */

export interface ListingRow {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly city: string | null;
  readonly priceMinor: string | null;
  readonly currencyCode: string;
  readonly currencyMinorUnit: number;
  readonly isNegotiable: boolean;
  readonly listingTypeCode: string;
  readonly createdAt: Date;
}

export interface ListingDetailRow extends ListingRow {
  readonly outcome: 'found' | 'moved' | 'not_found';
  readonly canonicalSlug: string | null;
  /** Which public surface owns the canonical slug — the listing one, or the service one. */
  readonly canonicalType: CanonicalSurface | null;
  readonly description: string;
  readonly contentLanguage: string;
  readonly availability: 'available' | 'no_longer_available';
  readonly category: ListingCategory;
  readonly seller: PublicSeller;
  readonly attributes: readonly ListingAttribute[];
  readonly tags: readonly ListingTag[];
}

export interface ListingStore {
  /** `app_private.public_listings(integer, timestamptz, uuid)`. */
  publicListings(input: {
    limit: number;
    cursorCreatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly ListingRow[]>;
  /** `app_private.public_listing_by_slug(text, text)`. */
  publicListingBySlug(input: {
    slug: string;
    locale: PublicLocale;
  }): Promise<Pick<ListingDetailRow, 'outcome' | 'canonicalSlug'> & Partial<ListingDetailRow>>;
}

export const LISTING_STORE = Symbol('LISTING_STORE');

/**
 * What the detail read resolved to.
 *
 * `moved` carries both the slug a 301 should point at and the surface that owns it: a slug naming a
 * service is a redirect off this surface entirely, which is what keeps one listing from having two
 * public canonical URLs.
 */
export type ListingLookup =
  | { readonly kind: 'found'; readonly listing: ListingDetail }
  | { readonly kind: 'moved'; readonly canonicalSlug: string; readonly canonicalType: CanonicalSurface }
  | { readonly kind: 'not_found' };

export interface ListingsPage {
  readonly items: readonly ListingSummary[];
  readonly nextCursor: string | null;
}

/**
 * The opaque cursor.
 *
 * It encodes the exact keyset position — the sort key and the tie-breaker of the last row on the page —
 * because that is what a keyset query needs to resume without skipping or repeating a row. It is
 * base64url so that it survives a query string untouched, and opaque because its shape is this
 * service's business: a client that parsed it would be depending on the sort order, which is not part
 * of the contract.
 */
const CURSOR_PATTERN = /^([0-9T:.\-Z]+)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const match = CURSOR_PATTERN.exec(decoded);
  if (match === null) return null;
  const createdAt = new Date(match[1]!);
  return Number.isNaN(createdAt.getTime()) ? null : { createdAt, id: match[2]! };
}

function toSummary(row: ListingRow): ListingSummary {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    city: row.city,
    priceMinor: row.priceMinor,
    currencyCode: row.currencyCode,
    currencyMinorUnit: row.currencyMinorUnit,
    isNegotiable: row.isNegotiable,
    listingTypeCode: row.listingTypeCode,
  };
}

@Injectable()
export class ListingsService {
  private readonly logger = new Logger(ListingsService.name);

  constructor(@Inject(LISTING_STORE) private readonly store: ListingStore) {}

  /**
   * One page of the browse list.
   *
   * The page is read one row longer than asked for. If that extra row exists there is more to come, and
   * the cursor is built from the last row of the page the caller actually gets — so `nextCursor` is
   * null exactly when the page is the last one, rather than one request later.
   */
  async page(limit: number, cursor: string | null): Promise<ListingsPage> {
    let position: { createdAt: Date; id: string } | null = null;
    if (cursor !== null) {
      position = decodeCursor(cursor);
      if (position === null) throw new InvalidListingCursorError();
    }

    let rows: readonly ListingRow[];
    try {
      rows = await this.store.publicListings({
        limit: limit + 1,
        cursorCreatedAt: position?.createdAt ?? null,
        cursorId: position?.id ?? null,
      });
    } catch (error) {
      this.logger.error('The browse list could not be read.');
      throw new CatalogUnavailableError(error);
    }

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);
    return {
      items: page.map(toSummary),
      nextCursor: hasMore && last !== undefined ? encodeCursor(last.createdAt, last.id) : null,
    };
  }

  /** One listing by slug, a redirect to its current slug, or nothing the public may see. */
  async bySlug(slug: string, locale: PublicLocale): Promise<ListingLookup> {
    let row: Awaited<ReturnType<ListingStore['publicListingBySlug']>>;
    try {
      row = await this.store.publicListingBySlug({ slug, locale });
    } catch (error) {
      this.logger.error('A listing could not be read.');
      throw new CatalogUnavailableError(error);
    }

    if (row.outcome === 'moved' && row.canonicalSlug !== null && row.canonicalSlug !== undefined) {
      return {
        kind: 'moved',
        canonicalSlug: row.canonicalSlug,
        canonicalType: row.canonicalType ?? 'product',
      };
    }
    if (row.outcome !== 'found') return { kind: 'not_found' };

    // A `found` row always carries the full projection; anything missing means the reader and this
    // service disagree, which is a failure rather than a half-rendered page.
    if (
      row.id === undefined ||
      row.description === undefined ||
      row.category === undefined ||
      row.seller === undefined ||
      row.createdAt === undefined
    ) {
      this.logger.error('A listing row arrived without its projection.');
      throw new CatalogUnavailableError(new Error('incomplete listing row'));
    }

    return {
      kind: 'found',
      listing: {
        ...toSummary(row as ListingRow),
        description: row.description,
        contentLanguage: row.contentLanguage ?? '',
        createdAt: row.createdAt.toISOString(),
        availability: row.availability ?? 'no_longer_available',
        category: row.category,
        seller: row.seller,
        attributes: [...(row.attributes ?? [])],
        tags: [...(row.tags ?? [])],
      },
    };
  }
}

/** A cursor that did not come from this service. 400 by owner decision. */
export class InvalidListingCursorError extends Error {
  readonly problem = { status: 400, code: 'VALIDATION_FAILED' } as const;

  constructor() {
    super('The request is invalid.');
    this.name = 'InvalidListingCursorError';
  }
}
