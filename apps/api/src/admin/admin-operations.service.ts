import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  AccountStatus,
  AdminRoleCatalogueEntry,
  AdminSecurityEvent,
  AdminSellerDetail,
  AdminSellerRow,
  AdminUserDetail,
  AdminUserRole,
  AdminUserRow,
  AuditAction,
  AuditActorType,
  AuditRow,
  RecoveryChannel,
  RecoveryCompletionResponse,
  RecoveryDecisionResponse,
  RecoveryEvidenceRow,
  RecoveryEvidenceType,
  RecoveryQueueRow,
  RecoveryRequestDetail,
  RecoveryReviewResponse,
  RecoveryStatus,
  SellerStatusChangeResponse,
  SellerStatus,
  SellerVerificationStatus,
  StaffGrantableRole,
  StaffRoleWriteResponse,
} from '@repo/contracts';
import { isAal2 } from '../auth/access-token-claims.js';
import { StaffConsoleService } from './staff-console.service.js';
import {
  AdminOperationsCursorInvalidError,
  AdminOperationsNotFoundError,
  AdminOperationsUnavailableError,
  RecoveryInvalidError,
  RecoveryIsOwnError,
  RecoveryNeedsAnotherPersonError,
  RecoveryNotInStateError,
  SellerStatusRefusedError,
  StaffRoleRefusedError,
} from './admin-operations.errors.js';
import {
  decodeAdminAuditCursor,
  decodeAdminRecoveryCursor,
  decodeAdminSellersCursor,
  decodeAdminUsersCursor,
  encodeAdminAuditCursor,
  encodeAdminRecoveryCursor,
  encodeAdminSellersCursor,
  encodeAdminUsersCursor,
} from './admin-operations.cursor.js';

/**
 * Seller and user reads, role reads, recovery review and the audit trail (Phase 7-O).
 *
 * **Authorization, in the one order it is ever done**, which is 7-F's and is not varied:
 *
 *   1. The **provider** validates the caller's access token and says whose it is.
 *   2. The **assurance level** is read from that same, now-vouched-for token. Reading a claim first would be
 *      reading an attacker's JSON.
 *   3. The **database** reports the caller's *effective* permissions under 0003's own `requires_mfa` rule.
 *      Every role that holds one of these six keys requires MFA, so staff at `aal1` hold nothing at all —
 *      asking whether the effective set contains a key is therefore the AAL2 check and the permission check
 *      at once, and there is no separate assurance test here that could be forgotten on one route.
 *   4. Every `app_private` function below **re-applies the same permission test itself**, with the account
 *      and the assurance level as parameters and the key as a literal. No bug in this file can turn into
 *      somebody's account, somebody's roles or somebody's recovery.
 *
 * **Six keys, and each route requires exactly the one the database requires.** They are deliberately not
 * held together, and this file is where that separation is expressed:
 *
 *   * `sellers.profile.read` — the storefronts. A support agent does not hold it.
 *   * `users.profile.read` — the accounts. A moderator and a support agent both hold it.
 *   * `users.role.read` — what roles an account holds, and the role catalogue. **Only an administrator**:
 *      a moderator who can read an account still cannot read its roles.
 *   * `users.security.read` — one account's security timeline. **Only an administrator**, which is the
 *      catalogue's own decision and the reason this is a separate route from the account read.
 *   * `security.recovery.review` — the recovery queue and its three steps. A support agent holds it; a
 *      moderator does not.
 *   * `audit.read` — the audit trail. **Only an administrator.**
 *
 * **No role name is checked anywhere in this file.**
 *
 * **Every rule this surface appears to apply is applied in the database.** The recovery state machine, the
 * two-person rule, the refusal of the account holder at every step, the requirement that the new contact was
 * verified by a one-time code before completion, and the hold that completion starts — all of it is decided
 * inside 0028's writers, which 0078's wrappers call with the row locked. This service passes the caller's
 * account, translates the outcome into the approved error, and **checks nothing a second time**.
 *
 * **A refusal and an absence are the same answer.** A storefront, an account or a request that does not
 * exist, and a caller without the key, all arrive as `not_found` or as an empty page and become one
 * {@link AdminOperationsNotFoundError} or one empty list. There is no forbidden on any of these surfaces,
 * and that matters here more than anywhere: with six keys that are not held together, a distinguishable
 * refusal would let a colleague map what they are not trusted to read, and confirm that a particular person
 * has an account while doing it.
 *
 * ---------------------------------------------------------------------------------------------------
 * **THERE IS NO ROLE WRITER AND NO SELLER-STATUS WRITER IN THIS FILE, AND THAT IS DELIBERATE.**
 *
 * `public.user_roles` is written by nothing in `app_private`, and nothing sets `seller_profiles.status`.
 * Both capabilities are defined in this repository only as row-level policies for the `authenticated`
 * database role — which say who may write, and nothing about what a correct write is. Building either here
 * would mean this service inventing the platform's privilege-granting rules. Both are reported as capability
 * gaps for an owner decision, and until one is made there is no method on this class that assigns a role,
 * removes one, suspends a storefront or closes one.
 * ---------------------------------------------------------------------------------------------------
 */

export const SELLERS_PROFILE_READ = 'sellers.profile.read';
export const USERS_PROFILE_READ = 'users.profile.read';
export const USERS_ROLE_READ = 'users.role.read';
export const USERS_SECURITY_READ = 'users.security.read';
export const SECURITY_RECOVERY_REVIEW = 'security.recovery.review';
export const AUDIT_READ = 'audit.read';
/**
 * The one write key on this service, and the only one that is not a read.
 *
 * 0009's own admin update policy requires it, and 0033 gives it to `admin` and `super_admin` alone — so a
 * moderator, which holds `sellers.profile.read`, reads storefronts and cannot move one. That separation is
 * the whole reason this is a second key rather than the read key with a stronger check.
 */
export const SELLERS_PROFILE_MANAGE = 'sellers.profile.manage';
/** 0033 has seeded this since the beginning; 0100 is the first thing that can reach it. */
export const USERS_ROLE_MANAGE = 'users.role.manage';

/* ------------------------------------------------------------------------------------------------ */
/* The rows each reader returns                                                                      */
/* ------------------------------------------------------------------------------------------------ */

/** One row of `app_private.admin_seller_page`. */
export interface AdminSellerPageRow {
  readonly slug: string;
  readonly displayName: string;
  readonly status: string;
  readonly verificationStatus: string;
  readonly countryCode: string | null;
  readonly city: string | null;
  readonly listingCount: number;
  readonly openReportCount: number;
  readonly createdAt: Date | string;
}

/** One row of `app_private.admin_seller_detail`. */
export interface AdminSellerDetailRow {
  readonly outcome: string;
  readonly slug: string | null;
  readonly displayName: string | null;
  readonly bio: string | null;
  readonly contentLanguage: string | null;
  readonly status: string | null;
  readonly suspendedAt: Date | string | null;
  readonly suspensionReason: string | null;
  readonly closedAt: Date | string | null;
  readonly verificationStatus: string | null;
  readonly verifiedAt: Date | string | null;
  readonly countryCode: string | null;
  readonly governorate: string | null;
  readonly city: string | null;
  readonly listingCount: number | null;
  readonly liveListingCount: number | null;
  readonly openReportCount: number | null;
  readonly isOwnStorefront: boolean | null;
  readonly createdAt: Date | string | null;
}

/** One row of `app_private.seller_status_set_for_staff` (0079). */
export interface SellerStatusWriteRow {
  readonly outcome: string;
  readonly status: string | null;
}

/** One row of `app_private.admin_user_page`. */
export interface AdminUserPageRow {
  readonly id: string;
  readonly displayName: string | null;
  readonly status: string;
  readonly localeCode: string | null;
  readonly hasVerifiedEmail: boolean;
  readonly hasVerifiedPhone: boolean;
  readonly isStaff: boolean;
  readonly isSeller: boolean;
  readonly isSelf: boolean;
  readonly createdAt: Date | string;
}

/** One row of `app_private.admin_user_detail`. */
export interface AdminUserDetailRow {
  readonly outcome: string;
  readonly id: string | null;
  readonly displayName: string | null;
  readonly status: string | null;
  readonly localeCode: string | null;
  readonly timezone: string | null;
  readonly hasVerifiedEmail: boolean | null;
  readonly hasVerifiedPhone: boolean | null;
  readonly isStaff: boolean | null;
  readonly isSeller: boolean | null;
  readonly sellerSlug: string | null;
  readonly isSelf: boolean | null;
  readonly lastSeenAt: Date | string | null;
  readonly createdAt: Date | string | null;
}

/** One row of `app_private.admin_user_roles`. */
export interface AdminUserRoleRow {
  readonly roleKey: string;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly requiresMfa: boolean;
  readonly isAdminConsole: boolean;
  readonly grantedAt: Date | string;
  readonly expiresAt: Date | string | null;
  readonly revokedAt: Date | string | null;
  readonly isEffective: boolean;
  readonly permissionCount: number;
}

/** One row of `app_private.admin_role_catalogue`. */
export interface AdminRoleCatalogueRow {
  readonly roleKey: string;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly requiresMfa: boolean;
  readonly isAdminConsole: boolean;
  readonly isAssignable: boolean;
  readonly permissionCount: number;
  readonly holderCount: number;
}

/** One row of `app_private.staff_role_grantable` (0100). The database's own answer, not a filtered catalogue. */
export interface StaffGrantableRoleRow {
  readonly roleKey: string;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly requiresMfa: boolean;
  readonly isAdminConsole: boolean;
}

/** What `app_private.staff_role_grant` and `staff_role_revoke` answer (0100). */
export interface StaffRoleWriteRow {
  readonly outcome: string;
  readonly roleKey: string | null;
}

/** One row of `app_private.admin_account_security_timeline`. */
export interface AdminSecurityEventRow {
  readonly id: string | number | bigint;
  readonly eventType: string;
  readonly details: unknown;
  readonly occurredAt: Date | string;
}

/** One row of `app_private.recovery_review_queue`. */
export interface RecoveryQueueDbRow {
  readonly id: string;
  readonly status: string;
  readonly claimedContactChannel: string;
  readonly newContactChannel: string | null;
  readonly matchedAnAccount: boolean;
  readonly isOwnRequest: boolean;
  readonly isTheReviewer: boolean;
  readonly hasBeenReviewed: boolean;
  readonly contactVerified: boolean;
  readonly evidenceCount: number;
  readonly expiresAt: Date | string;
  readonly createdAt: Date | string;
}

/** One row of `app_private.recovery_request_for_staff`. */
export interface RecoveryRequestDetailDbRow {
  readonly outcome: string;
  readonly id: string | null;
  readonly status: string | null;
  readonly claimedContactChannel: string | null;
  readonly newContactChannel: string | null;
  readonly matchedAnAccount: boolean | null;
  readonly isOwnRequest: boolean | null;
  readonly isTheReviewer: boolean | null;
  readonly reviewedByMe: boolean | null;
  readonly reviewNote: string | null;
  readonly reviewedAt: Date | string | null;
  readonly approvedAt: Date | string | null;
  readonly rejectionReason: string | null;
  readonly contactVerifiedAt: Date | string | null;
  readonly sessionsRevokedAt: Date | string | null;
  readonly mfaResetAt: Date | string | null;
  readonly holdUntil: Date | string | null;
  readonly completedAt: Date | string | null;
  readonly closedAt: Date | string | null;
  readonly expiresAt: Date | string | null;
  readonly createdAt: Date | string | null;
}

/** One row of `app_private.recovery_evidence_for_staff`. */
export interface RecoveryEvidenceDbRow {
  readonly id: string;
  readonly evidenceType: string;
  readonly originalFilename: string | null;
  readonly contentType: string | null;
  readonly byteSize: string | number | bigint | null;
  readonly uploadedAt: Date | string;
}

/** One row of either of the two recovery wrappers that report a status. */
export interface RecoveryWriteRow {
  readonly outcome: string;
  readonly status: string | null;
}

/** One row of `app_private.recovery_complete_for_staff`. */
export interface RecoveryCompletionRow {
  readonly outcome: string;
  readonly holdUntil: Date | string | null;
}

/** One row of `app_private.admin_audit_page`. */
export interface AdminAuditDbRow {
  readonly id: string | number | bigint;
  readonly occurredAt: Date | string;
  readonly actorType: string | null;
  readonly isOwnAction: boolean;
  readonly action: string;
  readonly tableSchema: string | null;
  readonly tableName: string | null;
  readonly recordId: string | null;
  readonly changedColumns: readonly string[] | null;
  readonly requestId: string | null;
}

export interface AdminOperationsStore {
  adminSellerPage(input: {
    userId: string;
    isAal2: boolean;
    limit: number;
    status: string | null;
    verificationStatus: string | null;
    cursorCreatedAt: Date | null;
    cursorSlug: string | null;
  }): Promise<readonly AdminSellerPageRow[]>;

  adminSellerDetail(input: {
    userId: string;
    isAal2: boolean;
    slug: string;
  }): Promise<AdminSellerDetailRow>;

  sellerStatusSetForStaff(input: {
    userId: string;
    isAal2: boolean;
    slug: string;
    status: string;
    reason: string | null;
  }): Promise<SellerStatusWriteRow>;

  adminUserPage(input: {
    userId: string;
    isAal2: boolean;
    limit: number;
    status: string | null;
    cursorCreatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly AdminUserPageRow[]>;

  adminUserDetail(input: {
    userId: string;
    isAal2: boolean;
    targetUserId: string;
  }): Promise<AdminUserDetailRow>;

  adminUserRoles(input: {
    userId: string;
    isAal2: boolean;
    targetUserId: string;
  }): Promise<readonly AdminUserRoleRow[]>;

  adminRoleCatalogue(input: {
    userId: string;
    isAal2: boolean;
  }): Promise<readonly AdminRoleCatalogueRow[]>;

  /** 0100. The roles this caller may grant, as the database computes them. */
  staffRoleGrantable(input: {
    userId: string;
    isAal2: boolean;
  }): Promise<readonly StaffGrantableRoleRow[]>;

  /** 0100. The first writer public.user_roles has ever had. */
  staffRoleGrant(input: {
    userId: string;
    isAal2: boolean;
    targetUserId: string;
    roleKey: string;
    reason: string;
    expiresAt: Date | null;
  }): Promise<StaffRoleWriteRow>;

  /** 0100. An update that sets revoked_at and revoked_by. Never a delete. */
  staffRoleRevoke(input: {
    userId: string;
    isAal2: boolean;
    targetUserId: string;
    roleKey: string;
    reason: string;
  }): Promise<StaffRoleWriteRow>;

  adminAccountSecurityTimeline(input: {
    userId: string;
    isAal2: boolean;
    targetUserId: string;
    limit: number;
  }): Promise<readonly AdminSecurityEventRow[]>;

  recoveryReviewQueue(input: {
    userId: string;
    isAal2: boolean;
    limit: number;
    status: string | null;
    cursorCreatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly RecoveryQueueDbRow[]>;

  recoveryRequestForStaff(input: {
    userId: string;
    isAal2: boolean;
    requestId: string;
  }): Promise<RecoveryRequestDetailDbRow>;

  recoveryEvidenceForStaff(input: {
    userId: string;
    isAal2: boolean;
    requestId: string;
  }): Promise<readonly RecoveryEvidenceDbRow[]>;

  recoveryReviewForStaff(input: {
    userId: string;
    isAal2: boolean;
    requestId: string;
    note: string | null;
  }): Promise<RecoveryWriteRow>;

  recoveryDecideForStaff(input: {
    userId: string;
    isAal2: boolean;
    requestId: string;
    decision: string;
    note: string | null;
  }): Promise<RecoveryWriteRow>;

  recoveryCompleteForStaff(input: {
    userId: string;
    isAal2: boolean;
    requestId: string;
    mfaWasReset: boolean;
  }): Promise<RecoveryCompletionRow>;

  adminAuditPage(input: {
    userId: string;
    isAal2: boolean;
    limit: number;
    tableSchema: string | null;
    tableName: string | null;
    recordId: string | null;
    cursorOccurredAt: Date | null;
    cursorId: bigint | null;
  }): Promise<readonly AdminAuditDbRow[]>;
}

export const ADMIN_OPERATIONS_STORE = Symbol('ADMIN_OPERATIONS_STORE');

export interface AdminSellerPage {
  readonly items: readonly AdminSellerRow[];
  readonly nextCursor: string | null;
}

export interface AdminUserPage {
  readonly items: readonly AdminUserRow[];
  readonly nextCursor: string | null;
}

export interface RecoveryQueuePage {
  readonly items: readonly RecoveryQueueRow[];
  readonly nextCursor: string | null;
}

export interface AdminAuditPage {
  readonly items: readonly AuditRow[];
  readonly nextCursor: string | null;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toIsoOrNull(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

/**
 * A `details` object, or null.
 *
 * 0004's comment guarantees the column carries identifiers only. This still refuses anything that is not a
 * plain object, so a malformed row becomes an absent field rather than an array or a scalar arriving where
 * the contract promises a record.
 */
function detailsObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function byteSize(value: string | number | bigint | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

@Injectable()
export class AdminOperationsService {
  private readonly logger = new Logger(AdminOperationsService.name);

  constructor(
    @Inject(ADMIN_OPERATIONS_STORE) private readonly store: AdminOperationsStore,
    private readonly console: StaffConsoleService,
  ) {}

  /* ---------------------------------------------------------------------------------------------- */
  /* Storefronts                                                                                     */
  /* ---------------------------------------------------------------------------------------------- */

  /**
   * One page of storefronts, newest first.
   *
   * The page is read one row longer than asked for, so `nextCursor` is null exactly when the page is the
   * last one rather than one request later.
   */
  async sellerPage(input: {
    accessToken: string;
    limit: number;
    status: string | null;
    verificationStatus: string | null;
    cursor: string | null;
  }): Promise<AdminSellerPage> {
    const staff = await this.#staff(input.accessToken, SELLERS_PROFILE_READ);

    let position: { at: Date; slug: string } | null = null;
    if (input.cursor !== null) {
      position = decodeAdminSellersCursor(input.cursor);
      // One refusal for malformed, altered and outdated — including a position from any of the other three
      // lists, whose rows sit behind different keys entirely.
      if (position === null) throw new AdminOperationsCursorInvalidError();
    }

    let rows: readonly AdminSellerPageRow[];
    try {
      rows = await this.store.adminSellerPage({
        userId: staff.id,
        isAal2: staff.isAal2,
        limit: input.limit + 1,
        // Passed as parameters. An unknown value matches nothing in the database rather than being refused
        // here, which is the reader's own documented behaviour.
        status: input.status,
        verificationStatus: input.verificationStatus,
        cursorCreatedAt: position?.at ?? null,
        cursorSlug: position?.slug ?? null,
      });
    } catch (error) {
      this.logger.error('The storefront page could not be read.');
      throw new AdminOperationsUnavailableError(error);
    }

    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    const last = page.at(-1);
    return {
      items: page.map((row) => this.#sellerRow(row)),
      nextCursor:
        hasMore && last !== undefined
          ? encodeAdminSellersCursor({ at: new Date(toIso(last.createdAt)), slug: last.slug })
          : null,
    };
  }

  /** One storefront, by slug. A missing one and a caller without the key are the same answer. */
  async seller(input: { accessToken: string; slug: string }): Promise<AdminSellerDetail> {
    const staff = await this.#staff(input.accessToken, SELLERS_PROFILE_READ);

    let row: AdminSellerDetailRow;
    try {
      row = await this.store.adminSellerDetail({
        userId: staff.id,
        isAal2: staff.isAal2,
        slug: input.slug,
      });
    } catch (error) {
      this.logger.error('A storefront could not be read.');
      throw new AdminOperationsUnavailableError(error);
    }

    if (row.outcome !== 'found') this.#refusal(row.outcome);
    return {
      slug: row.slug ?? '',
      displayName: row.displayName ?? '',
      bio: row.bio,
      contentLanguage: row.contentLanguage,
      status: (row.status ?? 'pending') as SellerStatus,
      suspendedAt: toIsoOrNull(row.suspendedAt),
      suspensionReason: row.suspensionReason,
      closedAt: toIsoOrNull(row.closedAt),
      verificationStatus: (row.verificationStatus ?? 'unverified') as SellerVerificationStatus,
      verifiedAt: toIsoOrNull(row.verifiedAt),
      countryCode: row.countryCode,
      governorate: row.governorate,
      city: row.city,
      listingCount: row.listingCount ?? 0,
      liveListingCount: row.liveListingCount ?? 0,
      openReportCount: row.openReportCount ?? 0,
      isOwnStorefront: row.isOwnStorefront ?? false,
      // The same session, the same key, resolved from the effective set 0068 already computed under 0003's
      // `requires_mfa` rule — so a caller at aal1 holds nothing and this is false. The `isAal2` conjunct is
      // defence rather than the test: the database re-applies the whole rule on the write, with the key as a
      // literal, so a wrong answer here can only ever offer a control that is then refused.
      canManage: staff.permissions.includes(SELLERS_PROFILE_MANAGE) && staff.isAal2,
      createdAt: toIso(row.createdAt ?? new Date(0)),
    };
  }

  /**
   * Moves one storefront between the four statuses 0009 allows.
   *
   * The only write on this service that is not a recovery step, and the only one behind
   * `sellers.profile.manage`. **Every rule is 0079's**, applied with the row locked: the seven legal pairs,
   * `closed` terminal, `active → pending` refused, `pending → active` reserved to 7-G, a reason required for
   * a suspension, and the two reinstatement conditions. This method passes the caller's account, translates
   * the outcome into the approved error, and **checks nothing a second time**.
   *
   * It cascades nowhere. There is no listing, offer, order, balance or payout read or written on this path,
   * because public visibility already follows seller status through the catalogue's own rule — and the audit
   * row is 0009's trigger's, not this method's.
   */
  async setSellerStatus(input: {
    accessToken: string;
    slug: string;
    status: string;
    reason: string | null;
  }): Promise<SellerStatusChangeResponse> {
    const staff = await this.#staff(input.accessToken, SELLERS_PROFILE_MANAGE);

    let row: SellerStatusWriteRow;
    try {
      row = await this.store.sellerStatusSetForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        slug: input.slug,
        status: input.status,
        reason: input.reason,
      });
    } catch (error) {
      this.logger.error('A storefront status change could not be recorded.');
      throw new AdminOperationsUnavailableError(error);
    }

    if (row.outcome !== 'updated') this.#refusal(row.outcome);
    return { outcome: 'updated', status: (row.status ?? 'pending') as SellerStatus };
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* Accounts                                                                                        */
  /* ---------------------------------------------------------------------------------------------- */

  async userPage(input: {
    accessToken: string;
    limit: number;
    status: string | null;
    cursor: string | null;
  }): Promise<AdminUserPage> {
    const staff = await this.#staff(input.accessToken, USERS_PROFILE_READ);

    let position: { at: Date; id: string } | null = null;
    if (input.cursor !== null) {
      position = decodeAdminUsersCursor(input.cursor);
      if (position === null) throw new AdminOperationsCursorInvalidError();
    }

    let rows: readonly AdminUserPageRow[];
    try {
      rows = await this.store.adminUserPage({
        userId: staff.id,
        isAal2: staff.isAal2,
        limit: input.limit + 1,
        status: input.status,
        cursorCreatedAt: position?.at ?? null,
        cursorId: position?.id ?? null,
      });
    } catch (error) {
      this.logger.error('The account page could not be read.');
      throw new AdminOperationsUnavailableError(error);
    }

    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        id: row.id,
        displayName: row.displayName,
        status: row.status as AccountStatus,
        localeCode: row.localeCode,
        hasVerifiedEmail: row.hasVerifiedEmail,
        hasVerifiedPhone: row.hasVerifiedPhone,
        isStaff: row.isStaff,
        isSeller: row.isSeller,
        isSelf: row.isSelf,
        createdAt: toIso(row.createdAt),
      })),
      nextCursor:
        hasMore && last !== undefined
          ? encodeAdminUsersCursor({ at: new Date(toIso(last.createdAt)), id: last.id })
          : null,
    };
  }

  /** One account. An absent one, a deleted one and a caller without the key are the same answer. */
  async user(input: { accessToken: string; userId: string }): Promise<AdminUserDetail> {
    const staff = await this.#staff(input.accessToken, USERS_PROFILE_READ);

    let row: AdminUserDetailRow;
    try {
      row = await this.store.adminUserDetail({
        userId: staff.id,
        isAal2: staff.isAal2,
        targetUserId: input.userId,
      });
    } catch (error) {
      this.logger.error('An account could not be read.');
      throw new AdminOperationsUnavailableError(error);
    }

    if (row.outcome !== 'found') this.#refusal(row.outcome);
    return {
      id: row.id ?? '',
      displayName: row.displayName,
      status: (row.status ?? 'active') as AccountStatus,
      localeCode: row.localeCode,
      timezone: row.timezone,
      hasVerifiedEmail: row.hasVerifiedEmail ?? false,
      hasVerifiedPhone: row.hasVerifiedPhone ?? false,
      isStaff: row.isStaff ?? false,
      isSeller: row.isSeller ?? false,
      sellerSlug: row.sellerSlug,
      isSelf: row.isSelf ?? false,
      lastSeenAt: toIsoOrNull(row.lastSeenAt),
      createdAt: toIso(row.createdAt ?? new Date(0)),
    };
  }

  /**
   * What roles one account holds.
   *
   * Behind `users.role.read`, which is **not** the key that let the caller read the account itself — a
   * moderator and a support agent can reach the account and not this. A caller without it gets an empty
   * list, identical to an account that holds no role.
   *
   * **This reader is unchanged by 0100** (owner decision 8): it still reports no actor and no reason, so who
   * granted or withdrew a role is recorded on the row and nowhere a response can reach. The two methods that
   * change a grant are below, behind a different key.
   */
  async userRoles(input: {
    accessToken: string;
    userId: string;
  }): Promise<readonly AdminUserRole[]> {
    const staff = await this.#staff(input.accessToken, USERS_ROLE_READ);

    let rows: readonly AdminUserRoleRow[];
    try {
      rows = await this.store.adminUserRoles({
        userId: staff.id,
        isAal2: staff.isAal2,
        targetUserId: input.userId,
      });
    } catch (error) {
      this.logger.error('An account’s roles could not be read.');
      throw new AdminOperationsUnavailableError(error);
    }

    return rows.map((row) => ({
      roleKey: row.roleKey,
      nameEn: row.nameEn,
      nameAr: row.nameAr,
      requiresMfa: row.requiresMfa,
      isAdminConsole: row.isAdminConsole,
      grantedAt: toIso(row.grantedAt),
      expiresAt: toIsoOrNull(row.expiresAt),
      revokedAt: toIsoOrNull(row.revokedAt),
      isEffective: row.isEffective,
      permissionCount: row.permissionCount,
    }));
  }

  /**
   * The roles this caller may grant (0100).
   *
   * Read from the database, which is the point: the set is computed from the caller's own effective roles by
   * the same three tests the writer applies, so a console cannot offer a grant that would be refused and
   * cannot be made to offer one by a crafted request. Behind the manage key, not the read key — a colleague
   * who may only read roles is offered nothing to grant.
   *
   * An empty list is the answer for a caller without the key, so it is indistinguishable from a caller whose
   * ceiling happens to admit nothing.
   */
  async grantableRoles(input: { accessToken: string }): Promise<readonly StaffGrantableRole[]> {
    const staff = await this.#staff(input.accessToken, USERS_ROLE_MANAGE);

    let rows: readonly StaffGrantableRoleRow[];
    try {
      rows = await this.store.staffRoleGrantable({ userId: staff.id, isAal2: staff.isAal2 });
    } catch (error) {
      this.logger.error('The grantable roles could not be read.');
      throw new AdminOperationsUnavailableError(error);
    }

    return rows.map((row) => ({
      roleKey: row.roleKey,
      nameEn: row.nameEn,
      nameAr: row.nameAr,
      requiresMfa: row.requiresMfa,
      isAdminConsole: row.isAdminConsole,
    }));
  }

  /**
   * Grants a role, or reinstates one that was withdrawn (0100).
   *
   * **Nothing is decided here.** The ceiling, `super_admin`, `roles.is_assignable`, the self rule, the reason
   * and the expiry are all applied by the database writer against the caller's own effective roles; this
   * method carries the request and reports the refusal. Checking any of it twice would create a second rule
   * that could disagree with the first.
   */
  async grantRole(input: {
    accessToken: string;
    userId: string;
    roleKey: string;
    reason: string;
    expiresAt: string | null;
  }): Promise<StaffRoleWriteResponse> {
    const staff = await this.#staff(input.accessToken, USERS_ROLE_MANAGE);

    let row: StaffRoleWriteRow;
    try {
      row = await this.store.staffRoleGrant({
        userId: staff.id,
        isAal2: staff.isAal2,
        targetUserId: input.userId,
        roleKey: input.roleKey,
        reason: input.reason,
        expiresAt: input.expiresAt === null ? null : new Date(input.expiresAt),
      });
    } catch (error) {
      this.logger.error('A role grant could not be recorded.');
      throw new AdminOperationsUnavailableError(error);
    }

    if (row.outcome !== 'granted') this.#refusal(row.outcome);
    return { outcome: 'granted', roleKey: row.roleKey ?? input.roleKey };
  }

  /**
   * Withdraws a role (0100).
   *
   * An update, never a delete: the grant and its withdrawal stay on one row. The withdrawal takes effect when
   * the permission predicates are next evaluated, which is the target's next request — nothing in this
   * platform ends a session, and this method does not pretend otherwise.
   */
  async revokeRole(input: {
    accessToken: string;
    userId: string;
    roleKey: string;
    reason: string;
  }): Promise<StaffRoleWriteResponse> {
    const staff = await this.#staff(input.accessToken, USERS_ROLE_MANAGE);

    let row: StaffRoleWriteRow;
    try {
      row = await this.store.staffRoleRevoke({
        userId: staff.id,
        isAal2: staff.isAal2,
        targetUserId: input.userId,
        roleKey: input.roleKey,
        reason: input.reason,
      });
    } catch (error) {
      this.logger.error('A role withdrawal could not be recorded.');
      throw new AdminOperationsUnavailableError(error);
    }

    if (row.outcome !== 'revoked') this.#refusal(row.outcome);
    return { outcome: 'revoked', roleKey: row.roleKey ?? input.roleKey };
  }

  /** The role catalogue. Reference data behind the same key. */
  async roleCatalogue(input: {
    accessToken: string;
  }): Promise<readonly AdminRoleCatalogueEntry[]> {
    const staff = await this.#staff(input.accessToken, USERS_ROLE_READ);

    let rows: readonly AdminRoleCatalogueRow[];
    try {
      rows = await this.store.adminRoleCatalogue({ userId: staff.id, isAal2: staff.isAal2 });
    } catch (error) {
      this.logger.error('The role catalogue could not be read.');
      throw new AdminOperationsUnavailableError(error);
    }

    return rows.map((row) => ({
      roleKey: row.roleKey,
      nameEn: row.nameEn,
      nameAr: row.nameAr,
      requiresMfa: row.requiresMfa,
      isAdminConsole: row.isAdminConsole,
      isAssignable: row.isAssignable,
      permissionCount: row.permissionCount,
      holderCount: row.holderCount,
    }));
  }

  /**
   * One account's security timeline.
   *
   * A third key again — `users.security.read`, which the catalogue withholds from both a moderator and a
   * support agent. Reading it writes nothing.
   */
  async securityTimeline(input: {
    accessToken: string;
    userId: string;
    limit: number;
  }): Promise<readonly AdminSecurityEvent[]> {
    const staff = await this.#staff(input.accessToken, USERS_SECURITY_READ);

    let rows: readonly AdminSecurityEventRow[];
    try {
      rows = await this.store.adminAccountSecurityTimeline({
        userId: staff.id,
        isAal2: staff.isAal2,
        targetUserId: input.userId,
        limit: input.limit,
      });
    } catch (error) {
      this.logger.error('An account’s security timeline could not be read.');
      throw new AdminOperationsUnavailableError(error);
    }

    return rows.map((row) => ({
      id: String(row.id),
      eventType: row.eventType,
      details: detailsObject(row.details),
      occurredAt: toIso(row.occurredAt),
    }));
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* Account recovery                                                                                */
  /* ---------------------------------------------------------------------------------------------- */

  /** One page of the recovery queue, **oldest first**. */
  async recoveryQueue(input: {
    accessToken: string;
    limit: number;
    status: string | null;
    cursor: string | null;
  }): Promise<RecoveryQueuePage> {
    const staff = await this.#staff(input.accessToken, SECURITY_RECOVERY_REVIEW);

    let position: { at: Date; id: string } | null = null;
    if (input.cursor !== null) {
      position = decodeAdminRecoveryCursor(input.cursor);
      if (position === null) throw new AdminOperationsCursorInvalidError();
    }

    let rows: readonly RecoveryQueueDbRow[];
    try {
      rows = await this.store.recoveryReviewQueue({
        userId: staff.id,
        isAal2: staff.isAal2,
        limit: input.limit + 1,
        status: input.status,
        cursorCreatedAt: position?.at ?? null,
        cursorId: position?.id ?? null,
      });
    } catch (error) {
      this.logger.error('The recovery queue could not be read.');
      throw new AdminOperationsUnavailableError(error);
    }

    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        id: row.id,
        status: row.status as RecoveryStatus,
        claimedContactChannel: row.claimedContactChannel as RecoveryChannel,
        newContactChannel: row.newContactChannel as RecoveryChannel | null,
        matchedAnAccount: row.matchedAnAccount,
        isOwnRequest: row.isOwnRequest,
        isTheReviewer: row.isTheReviewer,
        hasBeenReviewed: row.hasBeenReviewed,
        contactVerified: row.contactVerified,
        evidenceCount: row.evidenceCount,
        expiresAt: toIso(row.expiresAt),
        createdAt: toIso(row.createdAt),
      })),
      nextCursor:
        hasMore && last !== undefined
          ? encodeAdminRecoveryCursor({ at: new Date(toIso(last.createdAt)), id: last.id })
          : null,
    };
  }

  /** One recovery request. */
  async recoveryRequest(input: {
    accessToken: string;
    requestId: string;
  }): Promise<RecoveryRequestDetail> {
    const staff = await this.#staff(input.accessToken, SECURITY_RECOVERY_REVIEW);

    let row: RecoveryRequestDetailDbRow;
    try {
      row = await this.store.recoveryRequestForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        requestId: input.requestId,
      });
    } catch (error) {
      this.logger.error('A recovery request could not be read.');
      throw new AdminOperationsUnavailableError(error);
    }

    if (row.outcome !== 'found') this.#refusal(row.outcome);
    return {
      id: row.id ?? '',
      status: (row.status ?? 'submitted') as RecoveryStatus,
      claimedContactChannel: (row.claimedContactChannel ?? 'email') as RecoveryChannel,
      newContactChannel: row.newContactChannel as RecoveryChannel | null,
      matchedAnAccount: row.matchedAnAccount ?? false,
      isOwnRequest: row.isOwnRequest ?? false,
      isTheReviewer: row.isTheReviewer ?? false,
      reviewedByMe: row.reviewedByMe ?? false,
      reviewNote: row.reviewNote,
      reviewedAt: toIsoOrNull(row.reviewedAt),
      approvedAt: toIsoOrNull(row.approvedAt),
      rejectionReason: row.rejectionReason,
      contactVerifiedAt: toIsoOrNull(row.contactVerifiedAt),
      sessionsRevokedAt: toIsoOrNull(row.sessionsRevokedAt),
      mfaResetAt: toIsoOrNull(row.mfaResetAt),
      holdUntil: toIsoOrNull(row.holdUntil),
      completedAt: toIsoOrNull(row.completedAt),
      closedAt: toIsoOrNull(row.closedAt),
      expiresAt: toIso(row.expiresAt ?? new Date(0)),
      createdAt: toIso(row.createdAt ?? new Date(0)),
    };
  }

  /** What one recovery request supplied. No object path crosses. */
  async recoveryEvidence(input: {
    accessToken: string;
    requestId: string;
  }): Promise<readonly RecoveryEvidenceRow[]> {
    const staff = await this.#staff(input.accessToken, SECURITY_RECOVERY_REVIEW);

    let rows: readonly RecoveryEvidenceDbRow[];
    try {
      rows = await this.store.recoveryEvidenceForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        requestId: input.requestId,
      });
    } catch (error) {
      this.logger.error('A recovery request’s evidence could not be read.');
      throw new AdminOperationsUnavailableError(error);
    }

    return rows.map((row) => ({
      id: row.id,
      evidenceType: row.evidenceType as RecoveryEvidenceType,
      originalFilename: row.originalFilename,
      contentType: row.contentType,
      byteSize: byteSize(row.byteSize),
      uploadedAt: toIso(row.uploadedAt),
    }));
  }

  /**
   * Records the identity review.
   *
   * Delegates to 0028's writer through 0078's wrapper, which locks the row, refuses the account holder and
   * refuses a request already past review. The reviewer is the caller — nothing about who they are is taken
   * from the request.
   */
  async recoveryReview(input: {
    accessToken: string;
    requestId: string;
    note: string | null;
  }): Promise<RecoveryReviewResponse> {
    const staff = await this.#staff(input.accessToken, SECURITY_RECOVERY_REVIEW);

    let row: RecoveryWriteRow;
    try {
      row = await this.store.recoveryReviewForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        requestId: input.requestId,
        note: input.note,
      });
    } catch (error) {
      this.logger.error('A recovery review could not be recorded.');
      throw new AdminOperationsUnavailableError(error);
    }

    if (row.outcome !== 'reviewed') this.#refusal(row.outcome);
    return { outcome: 'reviewed', status: (row.status ?? 'under_review') as RecoveryStatus };
  }

  /**
   * The second approver's decision.
   *
   * The two-person rule lives entirely in 0028's writer: it refuses the reviewer, and it refuses the account
   * holder. Both arrive here as `needs_another_person`. The status this returns is the one the request
   * actually reached, which for an approval is `contact_verification` and never `approved`.
   */
  async recoveryDecision(input: {
    accessToken: string;
    requestId: string;
    decision: string;
    note: string | null;
  }): Promise<RecoveryDecisionResponse> {
    const staff = await this.#staff(input.accessToken, SECURITY_RECOVERY_REVIEW);

    let row: RecoveryWriteRow;
    try {
      row = await this.store.recoveryDecideForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        requestId: input.requestId,
        decision: input.decision,
        note: input.note,
      });
    } catch (error) {
      this.logger.error('A recovery decision could not be recorded.');
      throw new AdminOperationsUnavailableError(error);
    }

    if (row.outcome !== 'decided') this.#refusal(row.outcome);
    return { outcome: 'decided', status: (row.status ?? 'under_review') as RecoveryStatus };
  }

  /**
   * Finishes a recovery.
   *
   * The writer revokes the account's sessions, records any MFA reset, starts the configured hold and writes
   * both the security event and the outbox event. Nothing here duplicates any of that, and the hold is read
   * back rather than computed: no argument this service passes can shorten or skip it.
   */
  async recoveryCompletion(input: {
    accessToken: string;
    requestId: string;
    mfaWasReset: boolean;
  }): Promise<RecoveryCompletionResponse> {
    const staff = await this.#staff(input.accessToken, SECURITY_RECOVERY_REVIEW);

    let row: RecoveryCompletionRow;
    try {
      row = await this.store.recoveryCompleteForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        requestId: input.requestId,
        mfaWasReset: input.mfaWasReset,
      });
    } catch (error) {
      this.logger.error('A recovery could not be completed.');
      throw new AdminOperationsUnavailableError(error);
    }

    if (row.outcome !== 'completed') this.#refusal(row.outcome);
    return { outcome: 'completed', holdUntil: toIsoOrNull(row.holdUntil) };
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* The audit trail                                                                                 */
  /* ---------------------------------------------------------------------------------------------- */

  /** One page of the audit trail, newest first. Read-only: nothing here writes an audit row. */
  async auditPage(input: {
    accessToken: string;
    limit: number;
    tableSchema: string | null;
    tableName: string | null;
    recordId: string | null;
    cursor: string | null;
  }): Promise<AdminAuditPage> {
    const staff = await this.#staff(input.accessToken, AUDIT_READ);

    let position: { at: Date; id: bigint } | null = null;
    if (input.cursor !== null) {
      position = decodeAdminAuditCursor(input.cursor);
      if (position === null) throw new AdminOperationsCursorInvalidError();
    }

    let rows: readonly AdminAuditDbRow[];
    try {
      rows = await this.store.adminAuditPage({
        userId: staff.id,
        isAal2: staff.isAal2,
        limit: input.limit + 1,
        tableSchema: input.tableSchema,
        tableName: input.tableName,
        recordId: input.recordId,
        cursorOccurredAt: position?.at ?? null,
        cursorId: position?.id ?? null,
      });
    } catch (error) {
      this.logger.error('The audit trail could not be read.');
      throw new AdminOperationsUnavailableError(error);
    }

    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        id: String(row.id),
        occurredAt: toIso(row.occurredAt),
        actorType: row.actorType as AuditActorType | null,
        isOwnAction: row.isOwnAction,
        action: row.action as AuditAction,
        tableSchema: row.tableSchema,
        tableName: row.tableName,
        recordId: row.recordId,
        // Names, never values. The row carries no `oldValues` or `newValues` to map.
        changedColumns: row.changedColumns === null ? [] : [...row.changedColumns],
        requestId: row.requestId,
      })),
      nextCursor:
        hasMore && last !== undefined
          ? encodeAdminAuditCursor({ at: new Date(toIso(last.occurredAt)), id: BigInt(String(last.id)) })
          : null,
    };
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* Shared                                                                                          */
  /* ---------------------------------------------------------------------------------------------- */

  #sellerRow(row: AdminSellerPageRow): AdminSellerRow {
    return {
      slug: row.slug,
      displayName: row.displayName,
      status: row.status as SellerStatus,
      verificationStatus: row.verificationStatus as SellerVerificationStatus,
      countryCode: row.countryCode,
      city: row.city,
      listingCount: row.listingCount,
      openReportCount: row.openReportCount,
      createdAt: toIso(row.createdAt),
    };
  }

  /**
   * The caller, and the one key this route needs.
   *
   * A colleague who does not hold it is answered exactly as a missing row is. The database will apply the
   * same test again with the key as a literal, so this is the first of two rather than the only one.
   */
  async #staff(
    accessToken: string,
    permission: string,
  ): Promise<{ id: string; isAal2: boolean; permissions: readonly string[] }> {
    const session = await this.console.forToken(accessToken);
    if (!session.permissions.includes(permission)) throw new AdminOperationsNotFoundError();
    // The whole effective set is carried back, not just the one key this route required, so a reader can
    // report a *capability* — `canManage` on the seller detail — without a second round trip and without the
    // key itself ever reaching a response.
    return { id: session.id, isAal2: isAal2(accessToken), permissions: session.permissions };
  }

  #refusal(outcome: string): never {
    if (outcome === 'not_found') throw new AdminOperationsNotFoundError();
    if (outcome === 'invalid') throw new RecoveryInvalidError();
    if (outcome === 'own_request') throw new RecoveryIsOwnError();
    if (outcome === 'needs_another_person') throw new RecoveryNeedsAnotherPersonError();
    if (outcome === 'not_reviewable') throw new RecoveryNotInStateError('RECOVERY_NOT_REVIEWABLE');
    if (outcome === 'not_decidable') throw new RecoveryNotInStateError('RECOVERY_NOT_DECIDABLE');
    if (outcome === 'not_completable') throw new RecoveryNotInStateError('RECOVERY_NOT_COMPLETABLE');
    if (outcome === 'not_allowed') throw new SellerStatusRefusedError('SELLER_STATUS_NOT_ALLOWED');
    if (outcome === 'no_change') throw new SellerStatusRefusedError('SELLER_STATUS_NO_CHANGE');
    if (outcome === 'reason_required') throw new SellerStatusRefusedError('SELLER_STATUS_REASON_REQUIRED');
    if (outcome === 'not_verified') throw new SellerStatusRefusedError('SELLER_STATUS_NOT_VERIFIED');
    if (outcome === 'already_verified') {
      throw new SellerStatusRefusedError('SELLER_STATUS_ALREADY_VERIFIED');
    }
    // 0100. Every one of these is a boundary the database decided, reported with the name of the boundary.
    if (outcome === 'role_is_self') throw new StaffRoleRefusedError('STAFF_ROLE_IS_SELF');
    if (outcome === 'role_above_ceiling') throw new StaffRoleRefusedError('STAFF_ROLE_ABOVE_CEILING');
    if (outcome === 'role_not_grantable') throw new StaffRoleRefusedError('STAFF_ROLE_NOT_GRANTABLE');
    if (outcome === 'role_not_revocable') throw new StaffRoleRefusedError('STAFF_ROLE_NOT_REVOCABLE');
    if (outcome === 'role_not_assignable') throw new StaffRoleRefusedError('STAFF_ROLE_NOT_ASSIGNABLE');
    if (outcome === 'role_already_revoked') throw new StaffRoleRefusedError('STAFF_ROLE_ALREADY_REVOKED');
    if (outcome === 'role_expiry_invalid') throw new StaffRoleRefusedError('STAFF_ROLE_EXPIRY_INVALID');
    if (outcome === 'role_reason_required') throw new StaffRoleRefusedError('STAFF_ROLE_REASON_REQUIRED');
    this.logger.error('An admin operation returned an outcome this service does not understand.');
    throw new AdminOperationsUnavailableError(new Error('unexpected outcome'));
  }
}
