import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  SellerVerification,
  SellerVerificationDocument,
  SellerVerificationDocumentRequest,
  SellerVerificationState,
  SellerVerificationUpload,
  SellerVerificationUploadRequest,
} from '@repo/contracts';
import { hashIdentifier } from '../auth/subject-hash.js';
import {
  SellerIdentityUnavailableError,
  SellerMediaObjectMissingError,
  SellerOnboardingInvalidError,
  SellerProfileNotEditableError,
  SellerProfileNotFoundError,
  SellerVerificationAlreadyVerifiedError,
  SellerVerificationDocumentPathTakenError,
  SellerVerificationExistsError,
  SellerVerificationNotEditableError,
} from './seller-errors.js';
import {
  SELLER_MEDIA_STORAGE,
  SellerMediaStorageUnavailableError,
  type SellerMediaStoragePort,
} from './seller-media.storage.js';
import { SellerThrottleService } from './seller-throttle.service.js';

/**
 * The seller's own verification submission (Phase 6-I).
 *
 * Five operations, and between them they are an application and nothing more: read what you have, open an
 * attempt, authorize a document upload, record the uploaded document, remove one, submit. **No operation here
 * reaches a decision**, and there is no code path in this file that could: no method takes a status, none
 * passes one to the database, and the six `app_private` functions behind them assign neither `reviewed_at`,
 * `reviewed_by` nor `decision_reason` — which the verification table's own constraints make load-bearing,
 * since `approved` and `rejected` are unreachable without a reviewer and a review time. The existing review
 * mechanism remains the sole authority for a verification decision, and this service does not imitate, call
 * or work around it.
 *
 * **Authorization is the database's.** Every decision this surface appears to make is made in a SECURITY
 * DEFINER function: whether the caller has a storefront, whether its state permits a write, whether an
 * attempt is open and in a state the applicant may still change, whether a document type and content type
 * are allowed, whether a size is within the bucket's own limit, and — most importantly — *what the object
 * path is*. This service passes the caller's own user id, forwards the outcome as the approved error, and
 * composes no path, validates no limit a second time and resolves no ownership itself.
 *
 * **The browser never names a destination.** An upload request carries a type, a content type and a size;
 * there is no path in it and the strict contract refuses one. The only path in play is the one the database
 * derived from the caller's own slug, and the confirmation sends that same path straight back, where the
 * database rebuilds the expected prefix from the caller's own row and refuses anything outside it.
 *
 * **Storage is reused, not rebuilt.** 6-E's {@link SellerMediaStoragePort} already signs an upload for one
 * object path and asks whether an object is there. Those are exactly the two provider calls this increment
 * needs, against a different bucket, so it takes the port unchanged: one adapter, one place for Final QA to
 * confirm the provider's surface, and no second hand-rolled HTTP client to keep honest.
 *
 * **Nothing sensitive is logged.** A signed URL is a bearer credential for one object; an object path names
 * somebody's identity documents inside a private bucket. Neither appears in a log line here, nor does a
 * filename, a document type, an account id or any decision — and no line below could take one.
 */

export interface SellerVerificationRow {
  readonly outcome: string;
  readonly status: string | null;
  readonly submittedAt: Date | string | null;
  readonly createdAt: Date | string | null;
  readonly emailVerified: boolean | null;
  readonly phoneVerified: boolean | null;
  readonly documentCount: number | null;
  readonly documents: unknown;
}

export interface SellerVerificationStateRow {
  readonly outcome: string;
  readonly status: string | null;
}

export interface SellerVerificationTargetInput {
  readonly userId: string;
  readonly documentType: string;
  readonly contentType: string;
  readonly byteSize: number;
}

export interface SellerVerificationTargetRow {
  readonly outcome: string;
  readonly bucketId: string | null;
  readonly objectPath: string | null;
  readonly maxByteSize: number | null;
}

export interface SellerVerificationAttachInput {
  readonly userId: string;
  readonly documentType: string;
  readonly objectPath: string;
  readonly originalFilename: string;
  readonly contentType: string;
  readonly byteSize: number;
}

export interface SellerVerificationCountRow {
  readonly outcome: string;
  readonly documentCount: number | null;
}

export interface SellerVerificationStore {
  /** `app_private.seller_verification(uuid)` (0063). */
  sellerVerification(userId: string): Promise<SellerVerificationRow>;
  /** `app_private.seller_verification_start(uuid)` (0063). */
  sellerVerificationStart(userId: string): Promise<SellerVerificationStateRow>;
  /** `app_private.seller_verification_document_target(...)` (0063). */
  sellerVerificationDocumentTarget(
    input: SellerVerificationTargetInput,
  ): Promise<SellerVerificationTargetRow>;
  /** `app_private.seller_verification_document_attach(...)` (0063). */
  sellerVerificationDocumentAttach(
    input: SellerVerificationAttachInput,
  ): Promise<SellerVerificationCountRow>;
  /** `app_private.seller_verification_document_remove(uuid, uuid)` (0063). */
  sellerVerificationDocumentRemove(
    userId: string,
    documentId: string,
  ): Promise<SellerVerificationCountRow>;
  /** `app_private.seller_verification_submit(uuid)` (0063). */
  sellerVerificationSubmit(userId: string): Promise<SellerVerificationStateRow>;
}

export const SELLER_VERIFICATION_STORE = Symbol('SELLER_VERIFICATION_STORE');

/** The bucket 0012 defined for verification documents. Named here only to ask storage about an object. */
const VERIFICATION_BUCKET = 'verification-documents';

@Injectable()
export class SellerVerificationService {
  private readonly logger = new Logger(SellerVerificationService.name);

  constructor(
    @Inject(SELLER_VERIFICATION_STORE) private readonly store: SellerVerificationStore,
    @Inject(SELLER_MEDIA_STORAGE) private readonly storage: SellerMediaStoragePort,
    private readonly throttle: SellerThrottleService,
  ) {}

  /**
   * The caller's own attempt, or `null` when they have never applied.
   *
   * Not rate limited: reading your own application is not a mutation, and counting it against the daily
   * submission allowance would mean that looking at the page could stop you using it.
   */
  async read(userId: string): Promise<SellerVerification | null> {
    let row: SellerVerificationRow;
    try {
      row = await this.store.sellerVerification(userId);
    } catch (error) {
      this.logger.error('A seller verification could not be read.');
      throw new SellerIdentityUnavailableError(error);
    }

    if (row.outcome === 'none') return null;
    if (row.outcome === 'not_found') throw new SellerProfileNotFoundError();
    if (row.outcome !== 'found') {
      this.logger.error('A seller verification read returned an outcome this service does not understand.');
      throw new SellerIdentityUnavailableError(new Error('unexpected outcome'));
    }

    if (
      row.status === null ||
      row.createdAt === null ||
      row.emailVerified === null ||
      row.phoneVerified === null ||
      row.documentCount === null
    ) {
      this.logger.error('A seller verification came back incomplete.');
      throw new SellerIdentityUnavailableError(new Error('incomplete verification'));
    }

    return {
      status: row.status as SellerVerificationState,
      submittedAt: toIsoOrNull(row.submittedAt),
      createdAt: toIso(row.createdAt),
      emailVerified: row.emailVerified,
      phoneVerified: row.phoneVerified,
      documentCount: row.documentCount,
      documents: this.#projectDocuments(row.documents),
    };
  }

  /** Opens one attempt, as a draft. */
  async start(userId: string): Promise<SellerVerificationState> {
    await this.throttle.assertCanSubmitVerification(hashIdentifier(userId));

    let row: SellerVerificationStateRow;
    try {
      row = await this.store.sellerVerificationStart(userId);
    } catch (error) {
      this.logger.error('A seller verification could not be started.');
      throw new SellerIdentityUnavailableError(error);
    }
    return this.#state(row, 'created');
  }

  /** Authorizes one document upload and signs it. */
  async authorizeUpload(
    userId: string,
    request: SellerVerificationUploadRequest,
  ): Promise<SellerVerificationUpload> {
    await this.throttle.assertCanUploadMedia(hashIdentifier(userId));

    let target: SellerVerificationTargetRow;
    try {
      target = await this.store.sellerVerificationDocumentTarget({
        userId,
        documentType: request.documentType,
        contentType: request.contentType,
        byteSize: request.byteSize,
      });
    } catch (error) {
      this.logger.error('A verification document upload could not be authorized.');
      throw new SellerIdentityUnavailableError(error);
    }

    this.#assertDocumentOutcome(target.outcome, 'authorized');
    if (target.bucketId === null || target.objectPath === null || target.maxByteSize === null) {
      this.logger.error('An authorized verification upload came back without its target.');
      throw new SellerIdentityUnavailableError(new Error('incomplete upload target'));
    }

    // Only now does anything leave this process for the provider, with a path the database composed.
    let signed: Awaited<ReturnType<SellerMediaStoragePort['signUpload']>>;
    try {
      signed = await this.storage.signUpload(
        target.bucketId,
        target.objectPath,
        request.contentType,
      );
    } catch (error) {
      if (error instanceof SellerMediaStorageUnavailableError) {
        throw new SellerIdentityUnavailableError(error);
      }
      this.logger.error('Signing a verification document upload failed.');
      throw new SellerIdentityUnavailableError(error);
    }

    return {
      documentType: request.documentType,
      uploadUrl: signed.uploadUrl,
      objectPath: target.objectPath,
      expiresAt: signed.expiresAt.toISOString(),
      maxByteSize: target.maxByteSize,
    };
  }

  /** Records a document that was uploaded, and answers with the attempt's count. */
  async recordDocument(
    userId: string,
    request: SellerVerificationDocumentRequest,
  ): Promise<number> {
    await this.throttle.assertCanUploadMedia(hashIdentifier(userId));

    // The object first, exactly as 6-E does it. A path outside the caller's namespace is refused by the
    // database below whatever storage says, and asking storage first means a confirmation for a file nobody
    // uploaded never reaches a write — a verification that points at absent evidence is the state that wastes
    // a reviewer's time.
    let exists: boolean;
    try {
      exists = await this.storage.objectExists(VERIFICATION_BUCKET, request.objectPath);
    } catch (error) {
      throw new SellerIdentityUnavailableError(error);
    }
    if (!exists) throw new SellerMediaObjectMissingError();

    let row: SellerVerificationCountRow;
    try {
      row = await this.store.sellerVerificationDocumentAttach({
        userId,
        documentType: request.documentType,
        objectPath: request.objectPath,
        originalFilename: request.originalFilename,
        contentType: request.contentType,
        byteSize: request.byteSize,
      });
    } catch (error) {
      this.logger.error('A verification document could not be recorded.');
      throw new SellerIdentityUnavailableError(error);
    }

    this.#assertDocumentOutcome(row.outcome, 'attached');
    return this.#count(row);
  }

  /**
   * Removes one of the caller's own documents.
   *
   * The window — `draft` or `submitted` only (owner decision 3) — is the database's to enforce, and it does:
   * a document on an attempt that has reached the reviewer answers `not_found`, indistinguishable from one
   * that does not exist, and so does another seller's. This method therefore has no ownership check and no
   * state check of its own to get wrong.
   */
  async removeDocument(userId: string, documentId: string): Promise<number> {
    await this.throttle.assertCanUploadMedia(hashIdentifier(userId));

    let row: SellerVerificationCountRow;
    try {
      row = await this.store.sellerVerificationDocumentRemove(userId, documentId);
    } catch (error) {
      this.logger.error('A verification document could not be removed.');
      throw new SellerIdentityUnavailableError(error);
    }

    this.#assertDocumentOutcome(row.outcome, 'removed');
    return this.#count(row);
  }

  /** Submits the caller's draft for review. Requires no document (owner decision 1). */
  async submit(userId: string): Promise<SellerVerificationState> {
    await this.throttle.assertCanSubmitVerification(hashIdentifier(userId));

    let row: SellerVerificationStateRow;
    try {
      row = await this.store.sellerVerificationSubmit(userId);
    } catch (error) {
      this.logger.error('A seller verification could not be submitted.');
      throw new SellerIdentityUnavailableError(error);
    }
    return this.#state(row, 'submitted');
  }

  /**
   * The documents, projected field by field.
   *
   * The database already returns exactly seven fields per document, and this rebuilds them one at a time
   * rather than passing the parsed value through. That is deliberate: a projection written out by hand cannot
   * acquire an `objectPath`, a `reviewNote` or a reviewer if somebody later widens the function's `jsonb`, and
   * a spread would have carried all three outward silently. An object path in particular is a capability in a
   * private bucket; it leaves this API exactly once, in an upload authorization, and never in a readback.
   */
  #projectDocuments(raw: unknown): SellerVerificationDocument[] {
    if (!Array.isArray(raw)) return [];
    const documents: SellerVerificationDocument[] = [];
    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null) continue;
      const row = entry as Record<string, unknown>;
      const id = typeof row['id'] === 'string' ? row['id'] : null;
      const documentType = typeof row['documentType'] === 'string' ? row['documentType'] : null;
      const originalFilename =
        typeof row['originalFilename'] === 'string' ? row['originalFilename'] : null;
      const contentType = typeof row['contentType'] === 'string' ? row['contentType'] : null;
      const byteSize = typeof row['byteSize'] === 'string' ? row['byteSize'] : null;
      const status = typeof row['status'] === 'string' ? row['status'] : null;
      const uploadedAt = row['uploadedAt'];
      if (
        id === null ||
        documentType === null ||
        originalFilename === null ||
        contentType === null ||
        byteSize === null ||
        status === null ||
        (typeof uploadedAt !== 'string' && !(uploadedAt instanceof Date))
      ) {
        this.logger.error('A verification document came back in a shape this service does not project.');
        throw new SellerIdentityUnavailableError(new Error('incomplete verification document'));
      }
      documents.push({
        id,
        documentType: documentType as SellerVerificationDocument['documentType'],
        originalFilename,
        contentType,
        byteSize,
        status: status as SellerVerificationDocument['status'],
        uploadedAt: toIso(uploadedAt),
      });
    }
    return documents;
  }

  /**
   * The refusals the two state-changing operations share.
   *
   * `exists` and `already_verified` are conflicts the caller can act on, and they stay distinct because the
   * remedies differ entirely: work on the attempt you have, or nothing, because you are verified already.
   * `not_editable` covers a suspended or closed storefront *and* an attempt that has reached the reviewer, one
   * code for both, naming no reviewer and no decision.
   */
  #state(row: SellerVerificationStateRow, success: 'created' | 'submitted'): SellerVerificationState {
    if (row.outcome === success) {
      if (row.status === null) {
        this.logger.error('A seller verification write came back without a status.');
        throw new SellerIdentityUnavailableError(new Error('incomplete verification state'));
      }
      return row.status as SellerVerificationState;
    }
    if (row.outcome === 'exists') throw new SellerVerificationExistsError();
    if (row.outcome === 'already_verified') throw new SellerVerificationAlreadyVerifiedError();
    if (row.outcome === 'not_found') throw new SellerProfileNotFoundError();
    if (row.outcome === 'not_editable') throw new SellerVerificationNotEditableError();
    if (row.outcome === 'invalid') throw new SellerOnboardingInvalidError();
    this.logger.error('A seller verification write returned an outcome this service does not understand.');
    throw new SellerIdentityUnavailableError(new Error('unexpected outcome'));
  }

  /**
   * The refusals the three document operations share.
   *
   * `not_found` is the ordinary not-found: no storefront, no open attempt, or no removable document of the
   * caller's with that id — including one of their own on an attempt that has reached the reviewer, and
   * including another seller's, which must not be distinguishable from absence. `not_editable` is the
   * suspended-or-closed refusal. `invalid` covers a document type, a content type, a size or a path the
   * database would not accept and names none of them: the strict contract has already told an honest client
   * which field is wrong, and a path refusal in particular must not explain what shape would have worked.
   */
  #assertDocumentOutcome(outcome: string, success: 'authorized' | 'attached' | 'removed'): void {
    if (outcome === success) return;
    if (outcome === 'not_found') throw new SellerProfileNotFoundError();
    if (outcome === 'not_editable') throw new SellerProfileNotEditableError();
    if (outcome === 'path_taken') throw new SellerVerificationDocumentPathTakenError();
    if (outcome === 'invalid') throw new SellerOnboardingInvalidError();
    this.logger.error('A verification document operation returned an outcome this service does not understand.');
    throw new SellerIdentityUnavailableError(new Error('unexpected outcome'));
  }

  #count(row: SellerVerificationCountRow): number {
    if (row.documentCount === null) {
      this.logger.error('A verification document operation came back without a count.');
      throw new SellerIdentityUnavailableError(new Error('incomplete document count'));
    }
    return row.documentCount;
  }
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toIsoOrNull(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}
