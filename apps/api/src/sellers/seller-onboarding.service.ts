import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  SellerIdentity,
  SellerOnboardingRequest,
  SellerStatus,
  SellerVerificationStatus,
} from '@repo/contracts';
import { hashIdentifier } from '../auth/subject-hash.js';
import {
  SellerIdentityUnavailableError,
  SellerOnboardingInvalidError,
  SellerProfileExistsError,
  SellerSlugTakenError,
} from './seller-errors.js';
import { SellerThrottleService } from './seller-throttle.service.js';

/**
 * Creating the caller's own storefront (Phase 6-C).
 *
 * Every rule this service appears to apply is migration 0058's, reported back as an outcome string; this
 * layer turns those outcomes into the approved errors and does nothing else. There is no second slug check,
 * no second uniqueness check and no second country rule — which is what keeps two copies of a rule from
 * drifting apart, and why a refusal cannot be produced here that the database would have allowed.
 *
 * **The caller cannot name the owner or the state.** `userId` is the account the API resolved from the
 * caller's own access token. The request type carries no `userId`, no `status` and no `verificationStatus` —
 * the strict contract refuses them before this method is reached — and this method passes no such value
 * onward, because `app_private.seller_create_profile` has no parameter that would take one. A new storefront
 * is `pending` and `unverified` because the function writes those as literals.
 *
 * **The limit runs before the database is touched**, so a flood costs a counter round trip rather than a
 * transaction, and it fails closed: an unreadable counter refuses the attempt. Every successful attempt
 * takes a permanent public address, so a refused counter must not mean an open door.
 *
 * **Nothing else happens.** No role is assigned, no verification record is created, no media is uploaded,
 * nothing is activated and nobody is notified. The audit entry is 0009's existing trigger doing its ordinary
 * job on an insert.
 */

export interface SellerCreateProfileInput {
  readonly userId: string;
  readonly slug: string;
  readonly displayName: string;
  readonly legalName: string | null;
  readonly bio: string | null;
  readonly contentLanguage: string | null;
  readonly countryCode: string;
  readonly governorate: string | null;
  readonly city: string | null;
  readonly contactEmail: string | null;
  readonly contactPhone: string | null;
}

export interface SellerCreateProfileResult {
  readonly outcome: string;
  readonly slug: string | null;
  readonly displayName: string | null;
  readonly status: string | null;
  readonly verificationStatus: string | null;
  readonly city: string | null;
  readonly countryCode: string | null;
}

export interface SellerOnboardingStore {
  /** `app_private.seller_create_profile(...)` (0058). */
  sellerCreateProfile(input: SellerCreateProfileInput): Promise<SellerCreateProfileResult>;
}

export const SELLER_ONBOARDING_STORE = Symbol('SELLER_ONBOARDING_STORE');

const STATUSES: readonly SellerStatus[] = ['pending', 'active', 'suspended', 'closed'];
const VERIFICATION_STATUSES: readonly SellerVerificationStatus[] = [
  'unverified',
  'pending',
  'verified',
  'rejected',
];

/** An optional field arrives as a string, `null` or absent; the store takes one shape. */
function optional(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === '' ? null : value;
}

@Injectable()
export class SellerOnboardingService {
  private readonly logger = new Logger(SellerOnboardingService.name);

  constructor(
    @Inject(SELLER_ONBOARDING_STORE) private readonly store: SellerOnboardingStore,
    private readonly throttle: SellerThrottleService,
  ) {}

  /** Creates the storefront and returns it as stored, or raises the approved refusal. */
  async createForUser(userId: string, request: SellerOnboardingRequest): Promise<SellerIdentity> {
    await this.throttle.assertCanOnboard(hashIdentifier(userId));

    let result: SellerCreateProfileResult;
    try {
      result = await this.store.sellerCreateProfile({
        userId,
        slug: request.slug,
        displayName: request.displayName,
        legalName: optional(request.legalName),
        bio: optional(request.bio),
        contentLanguage: optional(request.contentLanguage),
        countryCode: request.countryCode,
        governorate: optional(request.governorate),
        city: optional(request.city),
        contactEmail: optional(request.contactEmail),
        contactPhone: optional(request.contactPhone),
      });
    } catch (error) {
      // No detail reaches the response, and none is logged: an onboarding body carries a legal name, an
      // address and contact details, and the way to keep those out of a log is to have no line that
      // could take them.
      this.logger.error('A seller profile could not be created.');
      throw new SellerIdentityUnavailableError(error);
    }

    if (result.outcome === 'exists') throw new SellerProfileExistsError();
    if (result.outcome === 'slug_taken') throw new SellerSlugTakenError();
    if (result.outcome === 'invalid') throw new SellerOnboardingInvalidError();
    if (result.outcome !== 'created') {
      this.logger.error('Creating a seller profile returned an outcome this service does not understand.');
      throw new SellerIdentityUnavailableError(new Error('unexpected outcome'));
    }

    return this.#projection(result);
  }

  /**
   * The row that committed, projected onto the 6-A contract.
   *
   * Field by field, and validated rather than trusted: a status the contract does not know would otherwise
   * reach a browser as a string nothing can render, and a `created` outcome with no row behind it would
   * become a storefront made of nulls.
   */
  #projection(result: SellerCreateProfileResult): SellerIdentity {
    const { slug, displayName, status, verificationStatus, countryCode } = result;
    if (
      slug === null ||
      displayName === null ||
      status === null ||
      verificationStatus === null ||
      countryCode === null
    ) {
      this.logger.error('A created seller profile came back without its own fields.');
      throw new SellerIdentityUnavailableError(new Error('incomplete created profile'));
    }
    if (!STATUSES.includes(status as SellerStatus)) {
      this.logger.error('A created seller profile carried a status this API does not know.');
      throw new SellerIdentityUnavailableError(new Error('unknown seller status'));
    }
    if (!VERIFICATION_STATUSES.includes(verificationStatus as SellerVerificationStatus)) {
      this.logger.error('A created seller profile carried a verification status this API does not know.');
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
