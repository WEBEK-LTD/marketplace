import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PublicSellerProfile, SellerAvailability } from '@repo/contracts';
import { CatalogUnavailableError } from './catalog-errors.js';

/**
 * The public seller profile (Phase 4-E).
 *
 * Which sellers have a public page, and whether that page is live, are the database's decisions — and
 * they are deliberately *not* the same decisions as `public.is_seller_publicly_visible`, which governs
 * whether a seller's listings may be shown. A suspended seller has a page and no public listings.
 *
 * This layer turns the reader's row into the shared contract and a database failure into the approved
 * 503. It holds no user context: the profile is the same for a guest and for a signed-in person.
 */

export interface SellerProfileRow {
  readonly outcome: 'found' | 'not_found';
  readonly availability: SellerAvailability;
  readonly slug: string;
  readonly displayName: string;
  readonly bio: string | null;
  readonly contentLanguage: string | null;
  readonly city: string | null;
}

export interface SellerStore {
  /** `app_private.public_seller_by_slug(text)`. */
  publicSellerBySlug(slug: string): Promise<Pick<SellerProfileRow, 'outcome'> & Partial<SellerProfileRow>>;
}

export const SELLER_STORE = Symbol('SELLER_STORE');

/**
 * What a profile read resolved to.
 *
 * `not_found` is one outcome covering a pending seller, a closed seller and a slug that names nobody —
 * never three, because telling them apart is exactly what must not be possible.
 */
export type SellerLookup =
  | { readonly kind: 'found'; readonly seller: PublicSellerProfile; readonly availability: SellerAvailability }
  | { readonly kind: 'not_found' };

@Injectable()
export class SellersService {
  private readonly logger = new Logger(SellersService.name);

  constructor(@Inject(SELLER_STORE) private readonly store: SellerStore) {}

  async bySlug(slug: string): Promise<SellerLookup> {
    let row: Awaited<ReturnType<SellerStore['publicSellerBySlug']>>;
    try {
      row = await this.store.publicSellerBySlug(slug);
    } catch (error) {
      this.logger.error('A seller profile could not be read.');
      throw new CatalogUnavailableError(error);
    }

    if (row.outcome !== 'found') return { kind: 'not_found' };

    // A `found` row always carries the projection; anything missing means the reader and this service
    // disagree, which is a failure rather than a half-rendered page.
    if (row.slug === undefined || row.displayName === undefined || row.availability === undefined) {
      this.logger.error('A seller row arrived without its projection.');
      throw new CatalogUnavailableError(new Error('incomplete seller row'));
    }

    return {
      kind: 'found',
      availability: row.availability,
      seller: {
        slug: row.slug,
        displayName: row.displayName,
        bio: row.bio ?? null,
        contentLanguage: row.contentLanguage ?? null,
        city: row.city ?? null,
      },
    };
  }
}
