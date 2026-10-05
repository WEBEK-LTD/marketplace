import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  CanonicalSurface,
  ListingAttribute,
  ListingCategory,
  ListingTag,
  PublicLocale,
  PublicSeller,
  ServiceDetail,
  ServicePricingModel,
  ServiceSummary,
} from '@repo/contracts';
import { CatalogUnavailableError } from './catalog-errors.js';
import { InvalidListingCursorError, decodeCursor, encodeCursor } from './listings.service.js';

/**
 * Public services (Phase 4-C).
 *
 * The same shape as the listing service and deliberately so: the two surfaces answer the same questions
 * about different halves of one table, and the cursor is the same cursor — `(created_at, id)` in the same
 * order — so it is imported rather than re-implemented.
 *
 * What differs is the projection and the redirect. A slug names exactly one listing, and if that listing
 * is a product then this surface does not own it: the answer is a redirect to the listing surface, not a
 * 404. `canonicalType` on a `moved` result is what says which surface to send the caller to.
 *
 * It holds no user context: the same answer goes to a guest and to a signed-in person.
 */

export interface ServiceRow {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly city: string | null;
  readonly priceMinor: string | null;
  readonly currencyCode: string;
  readonly currencyMinorUnit: number;
  readonly pricingModel: ServicePricingModel | null;
  readonly deliveryDays: number | null;
  readonly revisionsIncluded: number | null;
  readonly createdAt: Date;
}

/**
 * The detail projection carries no `created_at`: the owner's service detail field list does not include
 * one, so the reader does not return one and this row does not claim one.
 */
export interface ServiceDetailRow extends Omit<ServiceRow, 'createdAt'> {
  readonly outcome: 'found' | 'moved' | 'not_found';
  readonly canonicalSlug: string | null;
  readonly canonicalType: CanonicalSurface | null;
  readonly description: string;
  readonly contentLanguage: string;
  readonly requiresBrief: boolean | null;
  readonly scope: string | null;
  readonly availability: 'available' | 'no_longer_available';
  readonly category: ListingCategory;
  readonly seller: PublicSeller;
  readonly attributes: readonly ListingAttribute[];
  readonly tags: readonly ListingTag[];
}

export interface ServiceStore {
  /** `app_private.public_services(integer, timestamptz, uuid)`. */
  publicServices(input: {
    limit: number;
    cursorCreatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly ServiceRow[]>;
  /** `app_private.public_service_by_slug(text, text)`. */
  publicServiceBySlug(input: {
    slug: string;
    locale: PublicLocale;
  }): Promise<Pick<ServiceDetailRow, 'outcome' | 'canonicalSlug'> & Partial<ServiceDetailRow>>;
}

export const SERVICE_STORE = Symbol('SERVICE_STORE');

export type ServiceLookup =
  | { readonly kind: 'found'; readonly service: ServiceDetail }
  | { readonly kind: 'moved'; readonly canonicalSlug: string; readonly canonicalType: CanonicalSurface }
  | { readonly kind: 'not_found' };

export interface ServicesPage {
  readonly items: readonly ServiceSummary[];
  readonly nextCursor: string | null;
}

function toSummary(row: Omit<ServiceRow, 'createdAt'>): ServiceSummary {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    city: row.city,
    priceMinor: row.priceMinor,
    currencyCode: row.currencyCode,
    currencyMinorUnit: row.currencyMinorUnit,
    pricingModel: row.pricingModel,
    deliveryDays: row.deliveryDays,
    revisionsIncluded: row.revisionsIncluded,
  };
}

@Injectable()
export class ServicesService {
  private readonly logger = new Logger(ServicesService.name);

  constructor(@Inject(SERVICE_STORE) private readonly store: ServiceStore) {}

  /**
   * One page of the service list.
   *
   * Read one row longer than asked for, so `nextCursor` is null exactly when this page is the last one
   * rather than one request later.
   */
  async page(limit: number, cursor: string | null): Promise<ServicesPage> {
    let position: { createdAt: Date; id: string } | null = null;
    if (cursor !== null) {
      position = decodeCursor(cursor);
      if (position === null) throw new InvalidListingCursorError();
    }

    let rows: readonly ServiceRow[];
    try {
      rows = await this.store.publicServices({
        limit: limit + 1,
        cursorCreatedAt: position?.createdAt ?? null,
        cursorId: position?.id ?? null,
      });
    } catch (error) {
      this.logger.error('The service list could not be read.');
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

  /** One service by slug, a redirect to the surface that owns it, or nothing the public may see. */
  async bySlug(slug: string, locale: PublicLocale): Promise<ServiceLookup> {
    let row: Awaited<ReturnType<ServiceStore['publicServiceBySlug']>>;
    try {
      row = await this.store.publicServiceBySlug({ slug, locale });
    } catch (error) {
      this.logger.error('A service could not be read.');
      throw new CatalogUnavailableError(error);
    }

    if (row.outcome === 'moved' && row.canonicalSlug !== null && row.canonicalSlug !== undefined) {
      return {
        kind: 'moved',
        canonicalSlug: row.canonicalSlug,
        canonicalType: row.canonicalType ?? 'service',
      };
    }
    if (row.outcome !== 'found') return { kind: 'not_found' };

    // A `found` row always carries the full projection; anything missing means the reader and this
    // service disagree, which is a failure rather than a half-rendered page.
    if (row.id === undefined || row.description === undefined || row.category === undefined || row.seller === undefined) {
      this.logger.error('A service row arrived without its projection.');
      throw new CatalogUnavailableError(new Error('incomplete service row'));
    }

    return {
      kind: 'found',
      service: {
        ...toSummary(row as ServiceDetailRow),
        description: row.description,
        contentLanguage: row.contentLanguage ?? '',
        requiresBrief: row.requiresBrief ?? null,
        scope: row.scope ?? null,
        availability: row.availability ?? 'no_longer_available',
        category: row.category,
        seller: row.seller,
        attributes: [...(row.attributes ?? [])],
        tags: [...(row.tags ?? [])],
      },
    };
  }
}
