import { Inject, Injectable, Logger } from '@nestjs/common';
import type { SellerIdentity, SellerStatus, SellerVerificationStatus } from '@repo/contracts';
import { SellerIdentityUnavailableError, SellerProfileNotFoundError } from './seller-errors.js';

/**
 * The authenticated seller's own identity (Phase 6-A).
 *
 * One read, and the interesting decisions are all about what it is *not*.
 *
 * **It is not the public seller reader.** `SellersService` answers a guest's question about somebody
 * else's storefront and hides whether a pending or closed seller exists at all. This answers the owner's
 * question about their own, so it reports `pending`, `suspended` and `closed` plainly — hiding an
 * account's state from the person whose account it is would make the surface unusable without making
 * anything private. The two are separate services over separate readers so that neither can be reached
 * through the other by a mistaken argument.
 *
 * **It takes no seller identifier.** The caller arrives as a user id the API established from their own
 * access token, and there is no parameter here through which a browser could name a different seller. No
 * seller is ever resolved from a slug on this path.
 *
 * **It has no writer beside it.** 6-A adds a read; a seller profile cannot be created or changed through
 * anything in this module.
 *
 * **The projection is the database's.** `app_private.seller_identity` returns the six approved fields and
 * this service copies them across, so there is no place here where a seventh could be picked up. The two
 * status vocabularies are validated against the contract's own lists rather than trusted: a value the
 * contract does not know would otherwise reach a browser as a string nothing can render.
 */

export interface SellerIdentityRow {
  readonly slug: string;
  readonly displayName: string;
  readonly status: string;
  readonly verificationStatus: string;
  readonly city: string | null;
  readonly countryCode: string;
}

export interface SellerIdentityStore {
  /** `app_private.seller_identity(uuid)`. Null when the account has no seller profile. */
  sellerIdentity(userId: string): Promise<SellerIdentityRow | null>;
}

export const SELLER_IDENTITY_STORE = Symbol('SELLER_IDENTITY_STORE');

const STATUSES: readonly SellerStatus[] = ['pending', 'active', 'suspended', 'closed'];
const VERIFICATION_STATUSES: readonly SellerVerificationStatus[] = [
  'unverified',
  'pending',
  'verified',
  'rejected',
];

@Injectable()
export class SellerIdentityService {
  private readonly logger = new Logger(SellerIdentityService.name);

  constructor(@Inject(SELLER_IDENTITY_STORE) private readonly store: SellerIdentityStore) {}

  /** The caller's own storefront, or a not-found for an account that is not a seller. */
  async forUser(userId: string): Promise<SellerIdentity> {
    let row: SellerIdentityRow | null;
    try {
      row = await this.store.sellerIdentity(userId);
    } catch (error) {
      this.logger.error('A seller identity could not be read.');
      throw new SellerIdentityUnavailableError(error);
    }

    // No storefront is not an empty storefront. An account that has never applied has no seller state to
    // report, and inventing one — a blank slug, a `pending` status nobody asked for — would put a
    // surface in front of somebody who is not a seller.
    if (row === null) throw new SellerProfileNotFoundError();

    if (!STATUSES.includes(row.status as SellerStatus)) {
      this.logger.error('A seller identity carried a status this API does not know.');
      throw new SellerIdentityUnavailableError(new Error('unknown seller status'));
    }
    if (!VERIFICATION_STATUSES.includes(row.verificationStatus as SellerVerificationStatus)) {
      this.logger.error('A seller identity carried a verification status this API does not know.');
      throw new SellerIdentityUnavailableError(new Error('unknown verification status'));
    }

    return {
      slug: row.slug,
      displayName: row.displayName,
      status: row.status as SellerStatus,
      verificationStatus: row.verificationStatus as SellerVerificationStatus,
      city: row.city,
      countryCode: row.countryCode,
    };
  }
}
