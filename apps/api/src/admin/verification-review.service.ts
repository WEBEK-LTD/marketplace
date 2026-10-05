import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  VerificationDecision,
  VerificationDocumentLinkResponse,
  VerificationQueueFilter,
  VerificationQueueItem,
  VerificationReview,
  VerificationReviewDocument,
  VerificationStatus,
} from '@repo/contracts';
import {
  SELLER_MEDIA_STORAGE,
  SellerMediaStorageUnavailableError,
  type SellerMediaStoragePort,
} from '../sellers/seller-media.storage.js';
import { isAal2 } from '../auth/access-token-claims.js';
import { StaffConsoleService } from './staff-console.service.js';
import {
  VerificationContactsUnverifiedError,
  VerificationCursorInvalidError,
  VerificationNotDecidableError,
  VerificationNotFoundError,
  VerificationReasonRequiredError,
  VerificationReviewUnavailableError,
} from './verification-review.errors.js';
import {
  REVIEW_PERMISSION,
  decodeVerificationQueueCursor,
  encodeVerificationQueueCursor,
} from './verification-review.cursor.js';

/**
 * The reviewer's side of seller verification (Phase 7-G).
 *
 * **Authorization, in the one order it is ever done.**
 *
 *   1. The **provider** validates the caller's access token and says whose it is — reused from 7-F, which
 *      is why there is no second token path here.
 *   2. The **assurance level** is read from that same, now-vouched-for token.
 *   3. The **database** reports the caller's *effective* permissions under 0003's own `requires_mfa` rule.
 *      Because `roles_console_requires_mfa` makes every console role require MFA, staff at aal1 hold no
 *      permission at all — so asking whether the effective set contains `sellers.verification.review` is
 *      simultaneously the AAL2 check and the permission check, and there is no separate assurance test
 *      here that could be forgotten on one route.
 *   4. Every `app_private` function below **re-applies the same permission test itself**, with the
 *      reviewer and the assurance level as parameters. That is not belt and braces for its own sake: it
 *      means no bug in this file can turn into somebody's identity documents.
 *
 * **No role name appears in any decision this file makes.** The four staff roles exist in the contract,
 * but nothing here branches on one. Authorization is the permission key and only the permission key,
 * exactly as it is in the database.
 *
 * **Nothing about the caller comes from the request.** There is no method below that takes a reviewer, a
 * permission, an assurance level or a seller: the reviewer is resolved from their own session on every
 * call, and the only identifiers a caller supplies name rows.
 *
 * **A caller who may not review is a not-found, never a 403.** A refusal that distinguished "you
 * may not see this one" from "there is no such one" would confirm that a particular application exists.
 * The admin shell has already refused such a person at the page boundary; this is what the API says if
 * anything reaches it anyway.
 *
 * **Nothing here logs an identifier.** A verification names a person's identity documents. The log lines
 * below carry a sentence and no value, and none of them could take one.
 */

export interface VerificationQueueRow {
  readonly id: string;
  readonly status: string;
  readonly submittedAt: Date | string | null;
  readonly createdAt: Date | string | null;
  readonly reviewedAt: Date | string | null;
  readonly emailVerified: boolean | null;
  readonly phoneVerified: boolean | null;
  readonly documentCount: number | null;
  readonly sellerSlug: string | null;
  readonly sellerDisplayName: string | null;
  readonly sellerStatus: string | null;
  readonly sellerVerificationStatus: string | null;
}

export interface VerificationDetailRow {
  readonly outcome: string;
  readonly id: string | null;
  readonly status: string | null;
  readonly submittedAt: Date | string | null;
  readonly createdAt: Date | string | null;
  readonly updatedAt: Date | string | null;
  readonly reviewedAt: Date | string | null;
  readonly decisionReason: string | null;
  readonly expiresAt: Date | string | null;
  readonly emailVerified: boolean | null;
  readonly phoneVerified: boolean | null;
  readonly sellerSlug: string | null;
  readonly sellerDisplayName: string | null;
  readonly sellerLegalName: string | null;
  readonly sellerCountryCode: string | null;
  readonly sellerGovernorate: string | null;
  readonly sellerCity: string | null;
  readonly sellerContactEmail: string | null;
  readonly sellerContactPhone: string | null;
  readonly sellerStatus: string | null;
  readonly sellerVerificationStatus: string | null;
  readonly sellerCreatedAt: Date | string | null;
  readonly documents: unknown;
}

export interface VerificationDocumentRow {
  readonly outcome: string;
  readonly verificationId: string | null;
  readonly bucketId: string | null;
  readonly objectPath: string | null;
  readonly contentType: string | null;
  readonly originalFilename: string | null;
}

export interface VerificationDecisionRow {
  readonly outcome: string;
  readonly status: string | null;
}

export interface VerificationReviewStore {
  /** `app_private.verification_review_queue(...)` (0069). */
  verificationReviewQueue(input: {
    reviewerId: string;
    isAal2: boolean;
    status: string | null;
    limit: number;
    cursorSubmittedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly VerificationQueueRow[]>;
  /** `app_private.verification_review_detail(uuid, boolean, uuid)` (0069). */
  verificationReviewDetail(input: {
    reviewerId: string;
    isAal2: boolean;
    verificationId: string;
  }): Promise<VerificationDetailRow>;
  /** `app_private.verification_review_document(uuid, boolean, uuid)` (0069). */
  verificationReviewDocument(input: {
    reviewerId: string;
    isAal2: boolean;
    documentId: string;
  }): Promise<VerificationDocumentRow>;
  /** `app_private.verification_review_decide(uuid, boolean, uuid, text, text)` (0069). */
  verificationReviewDecide(input: {
    reviewerId: string;
    isAal2: boolean;
    verificationId: string;
    decision: string;
    reason: string | null;
  }): Promise<VerificationDecisionRow>;
}

export const VERIFICATION_REVIEW_STORE = Symbol('VERIFICATION_REVIEW_STORE');

/** The statuses a decision can still be made from. Mirrors 0069, which is the authority. */
const DECIDABLE = new Set(['submitted', 'under_review']);

@Injectable()
export class VerificationReviewService {
  private readonly logger = new Logger(VerificationReviewService.name);

  constructor(
    private readonly console: StaffConsoleService,
    @Inject(VERIFICATION_REVIEW_STORE) private readonly store: VerificationReviewStore,
    @Inject(SELLER_MEDIA_STORAGE) private readonly storage: SellerMediaStoragePort,
  ) {}

  /** One page of the queue, oldest submission first. */
  async queue(input: {
    accessToken: string;
    status: VerificationQueueFilter | null;
    limit: number;
    cursor: string | null;
  }): Promise<{ items: VerificationQueueItem[]; nextCursor: string | null }> {
    const reviewer = await this.reviewer(input.accessToken);

    let position: { submittedAt: Date; id: string } | null = null;
    if (input.cursor !== null) {
      position = decodeVerificationQueueCursor(input.cursor);
      // One refusal for malformed, altered and outdated. Silently paging from the beginning instead
      // would hide a client bug and quietly repeat rows a reviewer had already worked through.
      if (position === null) throw new VerificationCursorInvalidError();
    }

    let rows: readonly VerificationQueueRow[];
    try {
      rows = await this.store.verificationReviewQueue({
        reviewerId: reviewer.id,
        isAal2: reviewer.isAal2,
        status: input.status,
        limit: input.limit + 1,
        cursorSubmittedAt: position?.submittedAt ?? null,
        cursorId: position?.id ?? null,
      });
    } catch (error) {
      this.logger.error('The verification review queue could not be read.');
      throw new VerificationReviewUnavailableError(error);
    }

    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    const nextCursor =
      rows.length > input.limit && last !== undefined && last.submittedAt !== null
        ? encodeVerificationQueueCursor({ submittedAt: toDate(last.submittedAt), id: last.id })
        : null;

    return { items: page.map((row) => this.#queueItem(row)), nextCursor };
  }

  /** One submission, in full. */
  async detail(input: { accessToken: string; verificationId: string }): Promise<VerificationReview> {
    const reviewer = await this.reviewer(input.accessToken);

    let row: VerificationDetailRow;
    try {
      row = await this.store.verificationReviewDetail({
        reviewerId: reviewer.id,
        isAal2: reviewer.isAal2,
        verificationId: input.verificationId,
      });
    } catch (error) {
      this.logger.error('A verification submission could not be read.');
      throw new VerificationReviewUnavailableError(error);
    }

    if (row.outcome === 'not_found') throw new VerificationNotFoundError();
    if (row.outcome !== 'found') {
      this.logger.error('A verification read returned an outcome this service does not understand.');
      throw new VerificationReviewUnavailableError(new Error('unexpected outcome'));
    }

    if (
      row.id === null ||
      row.status === null ||
      row.createdAt === null ||
      row.updatedAt === null ||
      row.emailVerified === null ||
      row.phoneVerified === null ||
      row.sellerSlug === null ||
      row.sellerDisplayName === null ||
      row.sellerStatus === null ||
      row.sellerVerificationStatus === null ||
      row.sellerCreatedAt === null
    ) {
      this.logger.error('A verification submission came back incomplete.');
      throw new VerificationReviewUnavailableError(new Error('incomplete verification'));
    }

    return {
      id: row.id,
      status: row.status as VerificationStatus,
      submittedAt: toIsoOrNull(row.submittedAt),
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
      reviewedAt: toIsoOrNull(row.reviewedAt),
      decisionReason: row.decisionReason,
      expiresAt: toIsoOrNull(row.expiresAt),
      emailVerified: row.emailVerified,
      phoneVerified: row.phoneVerified,
      decidable: DECIDABLE.has(row.status),
      seller: {
        slug: row.sellerSlug,
        displayName: row.sellerDisplayName,
        legalName: row.sellerLegalName,
        countryCode: row.sellerCountryCode,
        governorate: row.sellerGovernorate,
        city: row.sellerCity,
        contactEmail: row.sellerContactEmail,
        contactPhone: row.sellerContactPhone,
        status: row.sellerStatus,
        verificationStatus: row.sellerVerificationStatus,
        createdAt: toIso(row.sellerCreatedAt),
      },
      documents: this.#projectDocuments(row.documents),
    };
  }

  /**
   * The decision.
   *
   * Every refusal below comes back from the database as an outcome rather than as a thrown statement,
   * because each one is something the surface acts on differently. This method adds no rule of its own:
   * there is no status check here, no ownership check and no second state machine — the row is locked and
   * examined inside the function, which is the only place that can do it without a race.
   */
  async decide(input: {
    accessToken: string;
    verificationId: string;
    decision: VerificationDecision;
    reason: string | null;
  }): Promise<VerificationStatus> {
    const reviewer = await this.reviewer(input.accessToken);

    let row: VerificationDecisionRow;
    try {
      row = await this.store.verificationReviewDecide({
        reviewerId: reviewer.id,
        isAal2: reviewer.isAal2,
        verificationId: input.verificationId,
        decision: input.decision,
        reason: input.reason,
      });
    } catch (error) {
      this.logger.error('A verification decision could not be recorded.');
      throw new VerificationReviewUnavailableError(error);
    }

    if (row.outcome === 'decided') {
      if (row.status === null) {
        this.logger.error('A recorded decision came back without a status.');
        throw new VerificationReviewUnavailableError(new Error('incomplete decision'));
      }
      return row.status as VerificationStatus;
    }
    // "Not found", "you may not review" and "it is a draft" are one answer, deliberately.
    if (row.outcome === 'not_found' || row.outcome === 'invalid') throw new VerificationNotFoundError();
    if (row.outcome === 'conflict') throw new VerificationNotDecidableError();
    // Unreachable from the controller, which refuses a reasonless rejection before this point; kept so a
    // direct caller receives the same field-level answer a form does rather than a 500.
    if (row.outcome === 'reason_required') throw new VerificationReasonRequiredError();
    if (row.outcome === 'contacts_unverified') throw new VerificationContactsUnverifiedError();
    this.logger.error('A verification decision returned an outcome this service does not understand.');
    throw new VerificationReviewUnavailableError(new Error('unexpected outcome'));
  }

  /**
   * A short-lived authorization to look at one document.
   *
   * **The caller names a document; the path comes from the row.** Nothing in this method's signature can
   * carry a path, and the only value that reaches the provider is `row.objectPath`, which the database
   * composed in 0063 from the applicant's own slug. The verification in the route must also be the
   * document's own, so a document id cannot be spent against a different case.
   */
  async documentLink(input: {
    accessToken: string;
    verificationId: string;
    documentId: string;
  }): Promise<VerificationDocumentLinkResponse> {
    const reviewer = await this.reviewer(input.accessToken);

    let row: VerificationDocumentRow;
    try {
      row = await this.store.verificationReviewDocument({
        reviewerId: reviewer.id,
        isAal2: reviewer.isAal2,
        documentId: input.documentId,
      });
    } catch (error) {
      this.logger.error('A verification document could not be located.');
      throw new VerificationReviewUnavailableError(error);
    }

    if (row.outcome !== 'authorized') throw new VerificationNotFoundError();
    if (row.bucketId === null || row.objectPath === null || row.verificationId === null) {
      this.logger.error('An authorized verification document came back without its location.');
      throw new VerificationReviewUnavailableError(new Error('incomplete document location'));
    }
    // The route and the row have to agree. A mismatch is absence, like everything else here.
    if (row.verificationId !== input.verificationId) throw new VerificationNotFoundError();

    let signed: Awaited<ReturnType<SellerMediaStoragePort['signDownload']>>;
    try {
      signed = await this.storage.signDownload(row.bucketId, row.objectPath);
    } catch (error) {
      if (!(error instanceof SellerMediaStorageUnavailableError)) {
        this.logger.error('Signing a verification document read failed.');
      }
      throw new VerificationReviewUnavailableError(error);
    }

    return {
      documentId: input.documentId,
      url: signed.url,
      expiresAt: signed.expiresAt.toISOString(),
    };
  }

  /* ------------------------------------------------------------------------------------------------ */

  /**
   * Who is asking, and may they.
   *
   * One place, called first by every method above, so there is no route on this surface that could be
   * added without it. It reuses 7-F's console session unchanged: the provider validates the token, the
   * assurance level comes from that validated token, and the database reports the effective set.
   */
  private async reviewer(accessToken: string): Promise<{ id: string; isAal2: boolean }> {
    // The provider validates the token inside `forToken`; only then is a claim read from it. That order
    // is 7-F's and is not varied here — reading a claim first would be reading an attacker's JSON.
    const session = await this.console.forToken(accessToken);
    if (!session.permissions.includes(REVIEW_PERMISSION)) throw new VerificationNotFoundError();
    // The level is read from the same validated token rather than assumed from the permission being
    // present. Today every console role is `requires_mfa`, so the two can only agree; passing the real
    // level means that if that ever stopped being true, the database would still apply its own rule to
    // the truth rather than to something this file asserted.
    return { id: session.id, isAal2: isAal2(accessToken) };
  }

  #queueItem(row: VerificationQueueRow): VerificationQueueItem {
    if (
      row.submittedAt === null ||
      row.createdAt === null ||
      row.emailVerified === null ||
      row.phoneVerified === null ||
      row.documentCount === null ||
      row.sellerSlug === null ||
      row.sellerDisplayName === null ||
      row.sellerStatus === null ||
      row.sellerVerificationStatus === null
    ) {
      this.logger.error('A queue row came back incomplete.');
      throw new VerificationReviewUnavailableError(new Error('incomplete queue row'));
    }
    return {
      id: row.id,
      status: row.status as VerificationStatus,
      submittedAt: toIso(row.submittedAt),
      createdAt: toIso(row.createdAt),
      reviewedAt: toIsoOrNull(row.reviewedAt),
      emailVerified: row.emailVerified,
      phoneVerified: row.phoneVerified,
      documentCount: row.documentCount,
      sellerSlug: row.sellerSlug,
      sellerDisplayName: row.sellerDisplayName,
      sellerStatus: row.sellerStatus,
      sellerVerificationStatus: row.sellerVerificationStatus,
    };
  }

  /**
   * The documents, projected field by field.
   *
   * Written out by hand rather than spread, for the same reason 6-I's readback is: a projection that
   * names its fields cannot acquire an `objectPath`, a `reviewNote` or a reviewer if somebody later
   * widens the function's `jsonb`, and a spread would have carried all three outward silently.
   */
  #projectDocuments(raw: unknown): VerificationReviewDocument[] {
    if (!Array.isArray(raw)) return [];
    const documents: VerificationReviewDocument[] = [];
    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null) continue;
      const row = entry as Record<string, unknown>;
      const id = typeof row['id'] === 'string' ? row['id'] : null;
      const documentType = typeof row['documentType'] === 'string' ? row['documentType'] : null;
      const status = typeof row['status'] === 'string' ? row['status'] : null;
      const uploadedAt = row['uploadedAt'];
      if (
        id === null ||
        documentType === null ||
        status === null ||
        (typeof uploadedAt !== 'string' && !(uploadedAt instanceof Date))
      ) {
        this.logger.error('A verification document came back in a shape this service does not project.');
        throw new VerificationReviewUnavailableError(new Error('incomplete verification document'));
      }
      documents.push({
        id,
        documentType: documentType as VerificationReviewDocument['documentType'],
        originalFilename: typeof row['originalFilename'] === 'string' ? row['originalFilename'] : null,
        contentType: typeof row['contentType'] === 'string' ? row['contentType'] : null,
        byteSize: typeof row['byteSize'] === 'string' ? row['byteSize'] : null,
        status: status as VerificationReviewDocument['status'],
        uploadedAt: toIso(uploadedAt),
      });
    }
    return documents;
  }
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toIso(value: Date | string): string {
  return toDate(value).toISOString();
}

function toIsoOrNull(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}
