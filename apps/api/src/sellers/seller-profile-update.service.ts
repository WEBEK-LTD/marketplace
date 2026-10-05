import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  SellerIdentity,
  SellerProfileUpdateRequest,
  SellerStatus,
  SellerVerificationStatus,
} from '@repo/contracts';
import { hashIdentifier } from '../auth/subject-hash.js';
import {
  SellerIdentityUnavailableError,
  SellerOnboardingInvalidError,
  SellerProfileNotEditableError,
  SellerProfileNotFoundError,
} from './seller-errors.js';
import { SellerThrottleService } from './seller-throttle.service.js';

/**
 * Editing the caller's own storefront (Phase 6-D).
 *
 * Every rule this service appears to apply is migration 0059's, reported back as an outcome string; this
 * layer turns those outcomes into the approved errors and does nothing else. There is no second status
 * check, no second country rule and no second length limit — which is what keeps two copies of a rule from
 * drifting apart, and why a refusal cannot be produced here that the database would have allowed.
 *
 * **The caller cannot name the owner, the slug or the state.** `userId` is the account the API resolved
 * from the caller's own access token. The request type has no `slug`, no `status` and no
 * `verificationStatus` — the strict contract refuses them before this method is reached — and this method
 * passes no such value onward, because `app_private.seller_update_profile` has no parameter that would take
 * one.
 *
 * **Absent and null are different requests, and this is where that is encoded.** JSON distinguishes them;
 * the database function takes a set-flag and a value per field; this method is the translation between the
 * two. `field === undefined` means the flag is false and the column keeps its value. Anything else — a
 * value or an explicit `null` — sets the flag, and `null` clears the column where 0009 allows it.
 * `Object.hasOwn` rather than a truthiness test, because `null` is a meaningful value here and a falsy one.
 *
 * **The limit runs before the database is touched**, so a flood costs a counter round trip rather than a
 * transaction, and it fails closed: an unreadable counter refuses the attempt.
 *
 * **Nothing else happens.** No role is assigned, no verification record is created or invalidated, no media
 * is touched, no state moves and nobody is notified. The audit entry is 0009's existing trigger doing its
 * ordinary job on an update.
 */

export interface SellerUpdateProfileInput {
  readonly userId: string;
  readonly setDisplayName: boolean;
  readonly displayName: string | null;
  readonly setLegalName: boolean;
  readonly legalName: string | null;
  readonly setBio: boolean;
  readonly bio: string | null;
  readonly setContentLanguage: boolean;
  readonly contentLanguage: string | null;
  readonly setCountryCode: boolean;
  readonly countryCode: string | null;
  readonly setGovernorate: boolean;
  readonly governorate: string | null;
  readonly setCity: boolean;
  readonly city: string | null;
  readonly setContactEmail: boolean;
  readonly contactEmail: string | null;
  readonly setContactPhone: boolean;
  readonly contactPhone: string | null;
}

export interface SellerUpdateProfileResult {
  readonly outcome: string;
  readonly slug: string | null;
  readonly displayName: string | null;
  readonly status: string | null;
  readonly verificationStatus: string | null;
  readonly city: string | null;
  readonly countryCode: string | null;
}

export interface SellerProfileUpdateStore {
  /** `app_private.seller_update_profile(...)` (0059). */
  sellerUpdateProfile(input: SellerUpdateProfileInput): Promise<SellerUpdateProfileResult>;
}

export const SELLER_PROFILE_UPDATE_STORE = Symbol('SELLER_PROFILE_UPDATE_STORE');

const STATUSES: readonly SellerStatus[] = ['pending', 'active', 'suspended', 'closed'];
const VERIFICATION_STATUSES: readonly SellerVerificationStatus[] = [
  'unverified',
  'pending',
  'verified',
  'rejected',
];

/** A field that was sent — with a value or as an explicit null — versus one that was not sent at all. */
function present(request: SellerProfileUpdateRequest, field: keyof SellerProfileUpdateRequest): boolean {
  return Object.hasOwn(request, field) && request[field] !== undefined;
}

function valueOf(
  request: SellerProfileUpdateRequest,
  field: keyof SellerProfileUpdateRequest,
): string | null {
  const value = request[field];
  return value === undefined || value === null ? null : value;
}

@Injectable()
export class SellerProfileUpdateService {
  private readonly logger = new Logger(SellerProfileUpdateService.name);

  constructor(
    @Inject(SELLER_PROFILE_UPDATE_STORE) private readonly store: SellerProfileUpdateStore,
    private readonly throttle: SellerThrottleService,
  ) {}

  /** Applies the edit and returns the storefront as stored, or raises the approved refusal. */
  async updateForUser(userId: string, request: SellerProfileUpdateRequest): Promise<SellerIdentity> {
    await this.throttle.assertCanUpdateProfile(hashIdentifier(userId));

    let result: SellerUpdateProfileResult;
    try {
      result = await this.store.sellerUpdateProfile({
        userId,
        setDisplayName: present(request, 'displayName'),
        displayName: valueOf(request, 'displayName'),
        setLegalName: present(request, 'legalName'),
        legalName: valueOf(request, 'legalName'),
        setBio: present(request, 'bio'),
        bio: valueOf(request, 'bio'),
        setContentLanguage: present(request, 'contentLanguage'),
        contentLanguage: valueOf(request, 'contentLanguage'),
        setCountryCode: present(request, 'countryCode'),
        countryCode: valueOf(request, 'countryCode'),
        setGovernorate: present(request, 'governorate'),
        governorate: valueOf(request, 'governorate'),
        setCity: present(request, 'city'),
        city: valueOf(request, 'city'),
        setContactEmail: present(request, 'contactEmail'),
        contactEmail: valueOf(request, 'contactEmail'),
        setContactPhone: present(request, 'contactPhone'),
        contactPhone: valueOf(request, 'contactPhone'),
      });
    } catch (error) {
      // No detail reaches the response, and none is logged: an edit carries a legal name, an address and
      // contact details, and the way to keep those out of a log is to have no line that could take them.
      this.logger.error('A seller profile could not be updated.');
      throw new SellerIdentityUnavailableError(error);
    }

    if (result.outcome === 'not_found') throw new SellerProfileNotFoundError();
    if (result.outcome === 'not_editable') throw new SellerProfileNotEditableError();
    if (result.outcome === 'invalid') throw new SellerOnboardingInvalidError();
    if (result.outcome !== 'updated') {
      this.logger.error('Updating a seller profile returned an outcome this service does not understand.');
      throw new SellerIdentityUnavailableError(new Error('unexpected outcome'));
    }

    return this.#projection(result);
  }

  /**
   * The row that committed, projected onto the 6-A contract.
   *
   * Field by field, and validated rather than trusted: a status the contract does not know would otherwise
   * reach a browser as a string nothing can render, and an `updated` outcome with no row behind it would
   * become a storefront made of nulls.
   */
  #projection(result: SellerUpdateProfileResult): SellerIdentity {
    const { slug, displayName, status, verificationStatus, countryCode } = result;
    if (
      slug === null ||
      displayName === null ||
      status === null ||
      verificationStatus === null ||
      countryCode === null
    ) {
      this.logger.error('An updated seller profile came back without its own fields.');
      throw new SellerIdentityUnavailableError(new Error('incomplete updated profile'));
    }
    if (!STATUSES.includes(status as SellerStatus)) {
      this.logger.error('An updated seller profile carried a status this API does not know.');
      throw new SellerIdentityUnavailableError(new Error('unknown seller status'));
    }
    if (!VERIFICATION_STATUSES.includes(verificationStatus as SellerVerificationStatus)) {
      this.logger.error('An updated seller profile carried a verification status this API does not know.');
      throw new SellerIdentityUnavailableError(new Error('unknown verification status'));
    }

    return {
      slug,
      displayName,
      status: status as SellerStatus,
      verificationStatus: verificationStatus as SellerVerificationStatus,
      city: result.city,
      countryCode,
    };
  }
}
