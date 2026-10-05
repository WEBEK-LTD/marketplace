import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  SellerMediaAttachRequest,
  SellerMediaState,
  SellerMediaUpload,
  SellerMediaUploadRequest,
} from '@repo/contracts';
import { hashIdentifier } from '../auth/subject-hash.js';
import {
  SellerIdentityUnavailableError,
  SellerMediaObjectMissingError,
  SellerOnboardingInvalidError,
  SellerProfileNotEditableError,
  SellerProfileNotFoundError,
} from './seller-errors.js';
import {
  SELLER_MEDIA_STORAGE,
  SellerMediaStorageUnavailableError,
  type SellerMediaStoragePort,
} from './seller-media.storage.js';
import { SellerThrottleService } from './seller-throttle.service.js';

/**
 * Seller profile media (Phase 6-E).
 *
 * Two operations, and between them they implement the approved flow's first and third steps: **the API issues
 * a signed URL, the browser uploads, the API confirms.**
 *
 * **Authorization is the database's, not this service's.** `app_private.seller_media_upload_target` decides
 * whether the caller has a storefront, whether its state allows a mutation, whether the media kind exists,
 * whether the content type and size are within the bucket's own limits, and — crucially — *what the object
 * path is*. This service passes the caller's user id, forwards the outcome as the approved error, and hands
 * the returned bucket and path to the storage port. It composes no path and validates no limit a second time.
 *
 * **The browser never names a destination.** The request carries a kind, a type and a size. There is no path
 * in it, and the strict contract refuses one; so the only path in play is the one the database derived from
 * the caller's own slug.
 *
 * **The confirmation verifies twice.** `app_private.seller_media_attach` re-derives the namespace from the
 * caller's own row and refuses anything outside it, and this service asks storage whether the object is
 * actually there before that write is attempted. Recording a path for a file nobody uploaded would be a
 * profile that points at nothing, which is exactly the state that rots quietly.
 *
 * **Nothing is logged.** A signed URL is a short-lived credential for one object; an object path names
 * somebody's storefront. Neither appears in a log line here, and no line below could take one.
 */

export interface SellerMediaTargetInput {
  readonly userId: string;
  readonly mediaKind: string;
  readonly contentType: string;
  readonly byteSize: number;
}

export interface SellerMediaTargetResult {
  readonly outcome: string;
  readonly bucketId: string | null;
  readonly objectPath: string | null;
  readonly maxByteSize: number | null;
}

export interface SellerMediaAttachInput {
  readonly userId: string;
  readonly mediaKind: string;
  readonly objectPath: string;
}

export interface SellerMediaAttachResult {
  readonly outcome: string;
  readonly hasLogo: boolean | null;
  readonly hasBanner: boolean | null;
}

export interface SellerMediaStore {
  /** `app_private.seller_media_upload_target(...)` (0060). */
  sellerMediaUploadTarget(input: SellerMediaTargetInput): Promise<SellerMediaTargetResult>;
  /** `app_private.seller_media_attach(...)` (0060). */
  sellerMediaAttach(input: SellerMediaAttachInput): Promise<SellerMediaAttachResult>;
}

export const SELLER_MEDIA_STORE = Symbol('SELLER_MEDIA_STORE');

@Injectable()
export class SellerMediaService {
  private readonly logger = new Logger(SellerMediaService.name);

  constructor(
    @Inject(SELLER_MEDIA_STORE) private readonly store: SellerMediaStore,
    @Inject(SELLER_MEDIA_STORAGE) private readonly storage: SellerMediaStoragePort,
    private readonly throttle: SellerThrottleService,
  ) {}

  /** Authorizes one upload and signs it. */
  async authorizeUpload(
    userId: string,
    request: SellerMediaUploadRequest,
  ): Promise<SellerMediaUpload> {
    await this.throttle.assertCanUploadMedia(hashIdentifier(userId));

    let target: SellerMediaTargetResult;
    try {
      target = await this.store.sellerMediaUploadTarget({
        userId,
        mediaKind: request.mediaKind,
        contentType: request.contentType,
        byteSize: request.byteSize,
      });
    } catch (error) {
      this.logger.error('A seller media upload could not be authorized.');
      throw new SellerIdentityUnavailableError(error);
    }

    this.assertOutcome(target.outcome, 'authorized');
    if (target.bucketId === null || target.objectPath === null || target.maxByteSize === null) {
      this.logger.error('An authorized upload came back without its target.');
      throw new SellerIdentityUnavailableError(new Error('incomplete upload target'));
    }

    // Only now does anything leave this process for the provider, with a path the database composed.
    let signed: Awaited<ReturnType<SellerMediaStoragePort['signUpload']>>;
    try {
      signed = await this.storage.signUpload(target.bucketId, target.objectPath, request.contentType);
    } catch (error) {
      if (error instanceof SellerMediaStorageUnavailableError) {
        throw new SellerIdentityUnavailableError(error);
      }
      this.logger.error('Signing a seller media upload failed.');
      throw new SellerIdentityUnavailableError(error);
    }

    return {
      mediaKind: request.mediaKind,
      uploadUrl: signed.uploadUrl,
      objectPath: target.objectPath,
      expiresAt: signed.expiresAt.toISOString(),
      maxByteSize: target.maxByteSize,
    };
  }

  /** Confirms an upload that happened, and records it. */
  async confirmUpload(userId: string, request: SellerMediaAttachRequest): Promise<SellerMediaState> {
    await this.throttle.assertCanUploadMedia(hashIdentifier(userId));

    // The object first. A path that is not in the caller's namespace is refused by the database below
    // whatever storage says, and asking storage first means a confirmation for a file that was never
    // uploaded never reaches a write.
    let exists: boolean;
    try {
      exists = await this.storage.objectExists('seller-media', request.objectPath);
    } catch (error) {
      throw new SellerIdentityUnavailableError(error);
    }
    if (!exists) throw new SellerMediaObjectMissingError();

    let result: SellerMediaAttachResult;
    try {
      result = await this.store.sellerMediaAttach({
        userId,
        mediaKind: request.mediaKind,
        objectPath: request.objectPath,
      });
    } catch (error) {
      this.logger.error('A seller media object could not be recorded.');
      throw new SellerIdentityUnavailableError(error);
    }

    this.assertOutcome(result.outcome, 'attached');
    if (result.hasLogo === null || result.hasBanner === null) {
      this.logger.error('A recorded media object came back without the resulting state.');
      throw new SellerIdentityUnavailableError(new Error('incomplete media state'));
    }
    return { hasLogo: result.hasLogo, hasBanner: result.hasBanner };
  }

  /**
   * The three refusals both functions share, in one place.
   *
   * `not_found` is the ordinary not-found an account without a storefront gets everywhere in Phase 6;
   * `not_editable` is the suspended-or-closed refusal, carrying no reason; `invalid` covers a media kind, a
   * content type, a size or a path the database would not accept, and names none of them — the strict contract
   * has already told an honest client which field is wrong.
   */
  private assertOutcome(outcome: string, success: 'authorized' | 'attached'): void {
    if (outcome === success) return;
    if (outcome === 'not_found') throw new SellerProfileNotFoundError();
    if (outcome === 'not_editable') throw new SellerProfileNotEditableError();
    if (outcome === 'invalid') throw new SellerOnboardingInvalidError();
    this.logger.error('A seller media operation returned an outcome this service does not understand.');
    throw new SellerIdentityUnavailableError(new Error('unexpected outcome'));
  }
}
