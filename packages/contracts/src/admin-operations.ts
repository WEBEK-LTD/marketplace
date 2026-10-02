import { z } from './zod.js';
import { SellerStatusSchema, SellerVerificationStatusSchema } from './sellers.js';

/**
 * Seller and user reads, role reads, recovery review and the audit trail — the admin side (Phase 7-O).
 *
 * 0003, 0005, 0006, 0009 and 0028 own everything substantive. This module invents no vocabulary: the seller
 * statuses, the verification statuses, the account statuses, the eight recovery statuses, the six evidence
 * types and the four audit actions are each read off the constraint that defines them, and each is written
 * out once here rather than twice anywhere.
 *
 * **No request names an actor, a role, a permission or an assurance level.** The colleague is resolved from
 * their own validated session and their assurance level from that same token; every request schema below is
 * `.strict()` and has no field through which any of it could be claimed. There is no `actorUserId`, no
 * `roleKey`, no `permissionKey`, no `isAal2` anywhere in this file — the last two by design rather than by
 * omission, because this is privilege-adjacent code and a permission key arriving in a request body is the
 * exact shape of the bug it would cause.
 *
 * **A seller is addressed by slug and a user by account id**, and the difference is deliberate. A storefront
 * has a public handle and the account behind it never needs to cross; an account under administration *is*
 * the subject, `users.profile.read` is precisely the permission to read it, and `profiles` has no slug. What
 * authorizes either read is the permission and the assurance level checked in the database before any row is
 * reached — never the shape of the identifier.
 *
 * ---------------------------------------------------------------------------------------------------
 * **ROLE ASSIGNMENT IS MISSING FROM THIS FILE ON PURPOSE. SELLER STATUS IS NOT.**
 *
 * There is **no request schema for assigning or removing a role**, and there is no operation anywhere in
 * this API that creates, changes or removes one. `public.user_roles` is written by nothing in `app_private`,
 * and the rules that would make a writer correct — which roles a holder of `users.role.manage` may grant,
 * whether self-grant is refused, what revocation does to live sessions and open step-up grants — are an
 * owner decision that has been taken and **deferred to a dedicated security-focused increment after
 * Phase 7**. Until then the role surface here is read-only, and there is no schema through which a grant
 * could travel.
 *
 * **Seller account status is now writable**, under the transitions the owner decided: the seven legal pairs,
 * `closed` terminal, `pending → active` reserved to 7-G's verification approval, a reason required for a
 * suspension, and the two reinstatement conditions. See {@link SellerStatusChangeRequestSchema}. It carries
 * a target status and a reason and nothing else — no timestamp, no verification value, and nothing that
 * reaches another domain.
 * ---------------------------------------------------------------------------------------------------
 *
 * **Nothing here returns a value from the audit trail.** `audit.audit_logs` carries `old_values` and
 * `new_values` as whole-row jsonb, redacted per calling trigger, so a projection carrying them would hand an
 * audit reader every unredacted column of every audited table. The row schema below has `changedColumns` —
 * the names — and no place for a value.
 *
 * **Nothing here returns a contact, a credential or a path.** Recovery contacts are stored as digests, so
 * only the channel crosses; evidence is reported by kind, file name and size, with no object path; the user
 * reads report whether a contact was verified as a boolean rather than returning the contact.
 */

/* ------------------------------------------------------------------------------------------------ */
/* Paging                                                                                            */
/* ------------------------------------------------------------------------------------------------ */

export const ADMIN_OPS_DEFAULT_LIMIT = 20;
export const ADMIN_OPS_MAX_LIMIT = 50;

export const AdminOpsLimitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(ADMIN_OPS_MAX_LIMIT)
  .default(ADMIN_OPS_DEFAULT_LIMIT);

/** Opaque and versioned per kind, as everywhere else. Never parsed or constructed by a browser. */
export const AdminOpsCursorSchema = z.string().min(1).max(512);

/* ------------------------------------------------------------------------------------------------ */
/* Sellers — read only                                                                               */
/* ------------------------------------------------------------------------------------------------ */

/**
 * 0009's `seller_profiles_status_allowed` and `seller_profiles_verification_status_allowed`, both reused
 * from the sellers module rather than restated. A second copy of a closed list is a second list that can
 * drift from the first, and these two are the ones a storefront's own public projection already uses.
 *
 * Both are **read only on this surface**. No writer in this repository sets a seller's account status, so it
 * is reported and never sent; 7-G owns every move between the verification statuses and this is not 7-G.
 */
export { SELLER_STATUSES as SELLER_ACCOUNT_STATUSES, SELLER_VERIFICATION_STATUSES } from './sellers.js';
export type { SellerStatus as SellerAccountStatus, SellerVerificationStatus } from './sellers.js';

export const AdminSellerQuerySchema = z
  .object({
    status: SellerStatusSchema.optional(),
    verificationStatus: SellerVerificationStatusSchema.optional(),
    limit: AdminOpsLimitSchema.optional(),
    cursor: AdminOpsCursorSchema.optional(),
  })
  .strict()
  .openapi('AdminSellerQuery');

export const AdminSellerRowSchema = z
  .object({
    slug: z.string(),
    displayName: z.string(),
    status: SellerStatusSchema,
    verificationStatus: SellerVerificationStatusSchema,
    countryCode: z.string().nullable(),
    city: z.string().nullable(),
    listingCount: z.number().int().min(0),
    openReportCount: z.number().int().min(0),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .openapi('AdminSellerRow');

export const AdminSellerPageResponseSchema = z
  .object({
    items: z.array(AdminSellerRowSchema),
    nextCursor: z.string().nullable(),
  })
  .strict()
  .openapi('AdminSellerPageResponse');

/**
 * One storefront.
 *
 * It carries the standing and none of the owner's personal details: no legal name, no contact email, no
 * phone, no logo or banner path. Those belong to the owner and to 7-G's verification review, neither of
 * which this surface is.
 */
export const AdminSellerDetailSchema = z
  .object({
    slug: z.string(),
    displayName: z.string(),
    bio: z.string().nullable(),
    contentLanguage: z.string().nullable(),
    status: SellerStatusSchema,
    suspendedAt: z.string().datetime({ offset: true }).nullable(),
    suspensionReason: z.string().nullable(),
    closedAt: z.string().datetime({ offset: true }).nullable(),
    verificationStatus: SellerVerificationStatusSchema,
    verifiedAt: z.string().datetime({ offset: true }).nullable(),
    countryCode: z.string().nullable(),
    governorate: z.string().nullable(),
    city: z.string().nullable(),
    listingCount: z.number().int().min(0),
    liveListingCount: z.number().int().min(0),
    openReportCount: z.number().int().min(0),
    isOwnStorefront: z.boolean(),
    /**
     * Whether this caller may change the storefront's status — that is, whether the same validated session
     * holds `sellers.profile.manage` at aal2.
     *
     * It is here because the detail read is gated on `sellers.profile.read`, which a moderator holds and the
     * manage key is not: without it a screen would have to guess, and would ship a control the database is
     * going to refuse. It is a capability, not a permission: the key itself never crosses.
     */
    canManage: z.boolean(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .openapi('AdminSellerDetail');

export const AdminSellerDetailResponseSchema = z
  .object({ seller: AdminSellerDetailSchema })
  .strict()
  .openapi('AdminSellerDetailResponse');

/**
 * The target statuses this surface accepts.
 *
 * All four of 0009's values, because three of them are reachable as a destination and `active` is reachable
 * from `suspended`. What constrains a request is not the value but the **pair**: the database holds the
 * seven legal transitions and refuses the rest, so this schema deliberately does not try to express the
 * matrix. A reduced list here would refuse a legal move; an invented one would offer an illegal one.
 */
export const SellerStatusTargetSchema = SellerStatusSchema.openapi('SellerStatusTarget', {
  description:
    'Where the storefront should end up. The legal transitions are decided in the database: `closed` is terminal, `active → pending` is refused, and `pending → active` belongs to the verification approval rather than to this operation.',
});

export const SellerSuspensionReasonSchema = z.string().trim().min(1).max(2000);

/**
 * Changing one storefront's account status.
 *
 * Two fields. A reason is required exactly when the target is `suspended`, which is the writer's own rule
 * checked here so a missing one is a validation failure rather than a refusal from the database.
 *
 * There is no `suspendedAt`, no `closedAt`, no `verificationStatus` and no `verifiedAt`: the writer sets the
 * timestamps its CHECK constraints require and touches neither verification column. There is no field that
 * reaches a listing, an offer, an order, a balance or a payout, because this operation cascades into none of
 * them — public visibility already follows seller status without a row being written anywhere else.
 */
export const SellerStatusChangeRequestSchema = z
  .object({
    status: SellerStatusTargetSchema,
    reason: SellerSuspensionReasonSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === 'suspended' && value.reason === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'A suspension is always recorded with its reason.',
      });
    }
  })
  .openapi('SellerStatusChangeRequest');

export const SellerStatusChangeResponseSchema = z
  .object({
    outcome: z.literal('updated'),
    status: SellerStatusSchema,
  })
  .strict()
  .openapi('SellerStatusChangeResponse');

/* ------------------------------------------------------------------------------------------------ */
/* Users — read only                                                                                 */
/* ------------------------------------------------------------------------------------------------ */

/** 0005's `profiles_status_allowed`. `deleted` never appears in a result: those rows are not returned. */
export const ACCOUNT_STATUSES = ['active', 'suspended', 'deleted'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];
export const AccountStatusSchema = z.enum(ACCOUNT_STATUSES).openapi('AccountStatus');

export const AdminUserQuerySchema = z
  .object({
    status: AccountStatusSchema.optional(),
    limit: AdminOpsLimitSchema.optional(),
    cursor: AdminOpsCursorSchema.optional(),
  })
  .strict()
  .openapi('AdminUserQuery');

/**
 * One account in the list.
 *
 * `hasVerifiedEmail` and `hasVerifiedPhone` are booleans rather than the contacts themselves, which is the
 * whole point: an administrative list needs to know whether a channel was confirmed, never what it is. There
 * is no legal name, no phone number, no email address and no avatar path in this schema.
 */
export const AdminUserRowSchema = z
  .object({
    id: z.string().uuid(),
    displayName: z.string().nullable(),
    status: AccountStatusSchema,
    localeCode: z.string().nullable(),
    hasVerifiedEmail: z.boolean(),
    hasVerifiedPhone: z.boolean(),
    isStaff: z.boolean(),
    isSeller: z.boolean(),
    isSelf: z.boolean(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .openapi('AdminUserRow');

export const AdminUserPageResponseSchema = z
  .object({
    items: z.array(AdminUserRowSchema),
    nextCursor: z.string().nullable(),
  })
  .strict()
  .openapi('AdminUserPageResponse');

export const AdminUserDetailSchema = z
  .object({
    id: z.string().uuid(),
    displayName: z.string().nullable(),
    status: AccountStatusSchema,
    localeCode: z.string().nullable(),
    timezone: z.string().nullable(),
    hasVerifiedEmail: z.boolean(),
    hasVerifiedPhone: z.boolean(),
    isStaff: z.boolean(),
    isSeller: z.boolean(),
    sellerSlug: z.string().nullable(),
    isSelf: z.boolean(),
    lastSeenAt: z.string().datetime({ offset: true }).nullable(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .openapi('AdminUserDetail');

export const AdminUserDetailResponseSchema = z
  .object({ user: AdminUserDetailSchema })
  .strict()
  .openapi('AdminUserDetailResponse');

/* ------------------------------------------------------------------------------------------------ */
/* Roles — read only, and there is nothing else                                                      */
/* ------------------------------------------------------------------------------------------------ */

/**
 * One role granted to one account.
 *
 * `isEffective` is 0003's own rule — not revoked, not expired — reported rather than recomputed by a page,
 * so a console and the database can never disagree about whether somebody currently holds something.
 *
 * There is no request schema anywhere in this file that creates, changes or removes one of these. Role
 * assignment has no authoritative writer in this repository and the rules for one are not stated; it is
 * reported as a capability gap rather than invented here.
 */
export const AdminUserRoleSchema = z
  .object({
    roleKey: z.string(),
    nameEn: z.string(),
    nameAr: z.string(),
    requiresMfa: z.boolean(),
    isAdminConsole: z.boolean(),
    grantedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }).nullable(),
    revokedAt: z.string().datetime({ offset: true }).nullable(),
    isEffective: z.boolean(),
    permissionCount: z.number().int().min(0),
  })
  .strict()
  .openapi('AdminUserRole');

export const AdminUserRolesResponseSchema = z
  .object({ items: z.array(AdminUserRoleSchema) })
  .strict()
  .openapi('AdminUserRolesResponse');

export const AdminRoleCatalogueEntrySchema = z
  .object({
    roleKey: z.string(),
    nameEn: z.string(),
    nameAr: z.string(),
    requiresMfa: z.boolean(),
    isAdminConsole: z.boolean(),
    isAssignable: z.boolean(),
    permissionCount: z.number().int().min(0),
    holderCount: z.number().int().min(0),
  })
  .strict()
  .openapi('AdminRoleCatalogueEntry');

export const AdminRoleCatalogueResponseSchema = z
  .object({ items: z.array(AdminRoleCatalogueEntrySchema) })
  .strict()
  .openapi('AdminRoleCatalogueResponse');

/* ------------------------------------------------------------------------------------------------ */
/* One account's security timeline                                                                   */
/* ------------------------------------------------------------------------------------------------ */

/**
 * `details` is the identifier-only object 0004's own comment describes: "identifiers only, never credentials
 * or message bodies". The request address and the device are not in this schema.
 */
export const AdminSecurityEventSchema = z
  .object({
    id: z.string(),
    eventType: z.string(),
    details: z.record(z.string(), z.unknown()).nullable(),
    occurredAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .openapi('AdminSecurityEvent');

export const AdminSecurityEventsResponseSchema = z
  .object({ items: z.array(AdminSecurityEventSchema) })
  .strict()
  .openapi('AdminSecurityEventsResponse');

/* ------------------------------------------------------------------------------------------------ */
/* Account recovery                                                                                  */
/* ------------------------------------------------------------------------------------------------ */

/**
 * 0028's `account_recovery_requests_status_allowed`, all eight.
 *
 * `approved` is in the list because the constraint has it, and **nothing in this repository sets it**: an
 * approval moves the request to `contact_verification` instead. The console never offers it and never
 * expects it; it is here so that a row carrying it would still parse rather than being silently dropped.
 */
export const RECOVERY_STATUSES = [
  'submitted',
  'under_review',
  'approved',
  'rejected',
  'contact_verification',
  'completed',
  'cancelled',
  'expired',
] as const;
export type RecoveryStatus = (typeof RECOVERY_STATUSES)[number];
export const RecoveryStatusSchema = z.enum(RECOVERY_STATUSES).openapi('RecoveryStatus', {
  description:
    'Where a recovery request stands. `approved` is a value the table allows that no writer sets — an approval moves a request to `contact_verification`.',
});

/** `account_recovery_requests_claimed_channel_allowed`. The channel crosses; the contact never does. */
export const RECOVERY_CHANNELS = ['email', 'phone'] as const;
export type RecoveryChannel = (typeof RECOVERY_CHANNELS)[number];
export const RecoveryChannelSchema = z.enum(RECOVERY_CHANNELS).openapi('RecoveryChannel');

/** `account_recovery_evidence_type_allowed`. */
export const RECOVERY_EVIDENCE_TYPES = [
  'national_id',
  'passport',
  'selfie',
  'proof_of_address',
  'purchase_proof',
  'other',
] as const;
export type RecoveryEvidenceType = (typeof RECOVERY_EVIDENCE_TYPES)[number];
export const RecoveryEvidenceTypeSchema = z
  .enum(RECOVERY_EVIDENCE_TYPES)
  .openapi('RecoveryEvidenceType');

export const RecoveryQueueQuerySchema = z
  .object({
    status: RecoveryStatusSchema.optional(),
    limit: AdminOpsLimitSchema.optional(),
    cursor: AdminOpsCursorSchema.optional(),
  })
  .strict()
  .openapi('RecoveryQueueQuery');

/**
 * One request in the queue.
 *
 * `isOwnRequest` and `isTheReviewer` are the two booleans the workflow needs before a colleague acts:
 * 0028 refuses the account holder at every step and refuses the reviewer as the second approver, so a
 * console that cannot see either would offer a control the database is going to reject. Neither names
 * anybody — there is no account identifier and no colleague in this schema.
 */
export const RecoveryQueueRowSchema = z
  .object({
    id: z.string().uuid(),
    status: RecoveryStatusSchema,
    claimedContactChannel: RecoveryChannelSchema,
    newContactChannel: RecoveryChannelSchema.nullable(),
    matchedAnAccount: z.boolean(),
    isOwnRequest: z.boolean(),
    isTheReviewer: z.boolean(),
    hasBeenReviewed: z.boolean(),
    contactVerified: z.boolean(),
    evidenceCount: z.number().int().min(0),
    expiresAt: z.string().datetime({ offset: true }),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .openapi('RecoveryQueueRow');

export const RecoveryQueueResponseSchema = z
  .object({
    items: z.array(RecoveryQueueRowSchema),
    nextCursor: z.string().nullable(),
  })
  .strict()
  .openapi('RecoveryQueueResponse');

/**
 * One request.
 *
 * The three effect timestamps — `sessionsRevokedAt`, `mfaResetAt`, `holdUntil` — are 0028's own record of
 * what completing a recovery did. They are read back so a reviewer can see it happened; no request schema in
 * this file can set, shorten or clear any of them.
 */
export const RecoveryRequestDetailSchema = z
  .object({
    id: z.string().uuid(),
    status: RecoveryStatusSchema,
    claimedContactChannel: RecoveryChannelSchema,
    newContactChannel: RecoveryChannelSchema.nullable(),
    matchedAnAccount: z.boolean(),
    isOwnRequest: z.boolean(),
    isTheReviewer: z.boolean(),
    reviewedByMe: z.boolean(),
    reviewNote: z.string().nullable(),
    reviewedAt: z.string().datetime({ offset: true }).nullable(),
    approvedAt: z.string().datetime({ offset: true }).nullable(),
    rejectionReason: z.string().nullable(),
    contactVerifiedAt: z.string().datetime({ offset: true }).nullable(),
    sessionsRevokedAt: z.string().datetime({ offset: true }).nullable(),
    mfaResetAt: z.string().datetime({ offset: true }).nullable(),
    holdUntil: z.string().datetime({ offset: true }).nullable(),
    completedAt: z.string().datetime({ offset: true }).nullable(),
    closedAt: z.string().datetime({ offset: true }).nullable(),
    expiresAt: z.string().datetime({ offset: true }),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .openapi('RecoveryRequestDetail');

export const RecoveryRequestDetailResponseSchema = z
  .object({ request: RecoveryRequestDetailSchema })
  .strict()
  .openapi('RecoveryRequestDetailResponse');

/** What was supplied, so a reviewer knows whether it is enough. There is no object path in this schema. */
export const RecoveryEvidenceRowSchema = z
  .object({
    id: z.string().uuid(),
    evidenceType: RecoveryEvidenceTypeSchema,
    originalFilename: z.string().nullable(),
    contentType: z.string().nullable(),
    byteSize: z.number().int().min(0).nullable(),
    uploadedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .openapi('RecoveryEvidenceRow');

export const RecoveryEvidenceResponseSchema = z
  .object({ items: z.array(RecoveryEvidenceRowSchema) })
  .strict()
  .openapi('RecoveryEvidenceResponse');

export const RecoveryNoteSchema = z.string().trim().min(1).max(2000);

/** Recording the identity review. The reviewer is the caller, fixed by the writer, never sent. */
export const RecoveryReviewRequestSchema = z
  .object({ note: RecoveryNoteSchema.optional() })
  .strict()
  .openapi('RecoveryReviewRequest');

export const RecoveryReviewResponseSchema = z
  .object({
    outcome: z.literal('reviewed'),
    status: RecoveryStatusSchema,
  })
  .strict()
  .openapi('RecoveryReviewResponse');

/**
 * The second approver's decision: 0028's own two words and no third.
 *
 * A rejection is always recorded with its reason — the writer's rule, checked here so a missing one is a
 * validation failure rather than a database refusal. There is no field for an approver: the writer refuses
 * the reviewer and the account holder by identity, from the session.
 */
export const RECOVERY_DECISIONS = ['approved', 'rejected'] as const;
export type RecoveryDecision = (typeof RECOVERY_DECISIONS)[number];
export const RecoveryDecisionSchema = z.enum(RECOVERY_DECISIONS).openapi('RecoveryDecision');

export const RecoveryDecisionRequestSchema = z
  .object({
    decision: RecoveryDecisionSchema,
    note: RecoveryNoteSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.decision === 'rejected' && value.note === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['note'],
        message: 'A rejection is always recorded with its reason.',
      });
    }
  })
  .openapi('RecoveryDecisionRequest');

export const RecoveryDecisionResponseSchema = z
  .object({
    outcome: z.literal('decided'),
    status: RecoveryStatusSchema,
  })
  .strict()
  .openapi('RecoveryDecisionResponse');

/**
 * Finishing a recovery.
 *
 * `mfaWasReset` records what the colleague actually did out of band; it is the only field, and it changes
 * nothing about whether the recovery may complete. The hold is computed by the writer from the site setting
 * and is returned, never sent.
 */
export const RecoveryCompletionRequestSchema = z
  .object({ mfaWasReset: z.boolean().default(false) })
  .strict()
  .openapi('RecoveryCompletionRequest');

export const RecoveryCompletionResponseSchema = z
  .object({
    outcome: z.literal('completed'),
    holdUntil: z.string().datetime({ offset: true }).nullable(),
  })
  .strict()
  .openapi('RecoveryCompletionResponse');

/* ------------------------------------------------------------------------------------------------ */
/* The audit trail — read only                                                                       */
/* ------------------------------------------------------------------------------------------------ */

/** 0006 writes exactly these four. */
export const AUDIT_ACTIONS = ['insert', 'update', 'delete', 'truncate'] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
export const AuditActionSchema = z.enum(AUDIT_ACTIONS).openapi('AuditAction');

/** `audit_logs_actor_type_allowed`. */
export const AUDIT_ACTOR_TYPES = ['user', 'system', 'worker', 'anonymous'] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];
export const AuditActorTypeSchema = z.enum(AUDIT_ACTOR_TYPES).openapi('AuditActorType');

/**
 * The two filters 0006's own `audit_logs_record` index supports, and no others.
 *
 * There is no actor filter and no free-text search: neither has an index behind it, and an actor filter
 * would be a way to assemble one colleague's activity, which is not what an audit read is for.
 */
export const AuditQuerySchema = z
  .object({
    tableSchema: z
      .string()
      .trim()
      .min(1)
      .max(63)
      .regex(/^[a-z_][a-z0-9_]*$/)
      .optional(),
    tableName: z
      .string()
      .trim()
      .min(1)
      .max(63)
      .regex(/^[a-z_][a-z0-9_]*$/)
      .optional(),
    recordId: z.string().trim().min(1).max(256).optional(),
    limit: AdminOpsLimitSchema.optional(),
    cursor: AdminOpsCursorSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.recordId !== undefined && (value.tableSchema === undefined || value.tableName === undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['recordId'],
        message: 'A record is named within a table.',
      });
    }
  })
  .openapi('AuditQuery');

/**
 * One audit row.
 *
 * `changedColumns` is the names of the columns that changed. **There is no place in this schema for a
 * value**, old or new: those are whole-row jsonb redacted per calling trigger, so a projection carrying them
 * would expose every unredacted column of every audited table to anybody holding `audit.read`.
 *
 * `isOwnAction` says whether the reader did this; the actor is not otherwise named.
 */
export const AuditRowSchema = z
  .object({
    id: z.string(),
    occurredAt: z.string().datetime({ offset: true }),
    actorType: AuditActorTypeSchema.nullable(),
    isOwnAction: z.boolean(),
    action: AuditActionSchema,
    tableSchema: z.string().nullable(),
    tableName: z.string().nullable(),
    recordId: z.string().nullable(),
    changedColumns: z.array(z.string()),
    requestId: z.string().nullable(),
  })
  .strict()
  .openapi('AuditRow');

export const AuditPageResponseSchema = z
  .object({
    items: z.array(AuditRowSchema),
    nextCursor: z.string().nullable(),
  })
  .strict()
  .openapi('AuditPageResponse');

/* ------------------------------------------------------------------------------------------------ */
/* Types                                                                                             */
/* ------------------------------------------------------------------------------------------------ */

export type AdminSellerQuery = z.infer<typeof AdminSellerQuerySchema>;
export type AdminSellerRow = z.infer<typeof AdminSellerRowSchema>;
export type AdminSellerPageResponse = z.infer<typeof AdminSellerPageResponseSchema>;
export type AdminSellerDetail = z.infer<typeof AdminSellerDetailSchema>;
export type AdminSellerDetailResponse = z.infer<typeof AdminSellerDetailResponseSchema>;
export type SellerStatusChangeRequest = z.infer<typeof SellerStatusChangeRequestSchema>;
export type SellerStatusChangeResponse = z.infer<typeof SellerStatusChangeResponseSchema>;
export type AdminUserQuery = z.infer<typeof AdminUserQuerySchema>;
export type AdminUserRow = z.infer<typeof AdminUserRowSchema>;
export type AdminUserPageResponse = z.infer<typeof AdminUserPageResponseSchema>;
export type AdminUserDetail = z.infer<typeof AdminUserDetailSchema>;
export type AdminUserDetailResponse = z.infer<typeof AdminUserDetailResponseSchema>;
export type AdminUserRole = z.infer<typeof AdminUserRoleSchema>;
export type AdminUserRolesResponse = z.infer<typeof AdminUserRolesResponseSchema>;
export type AdminRoleCatalogueEntry = z.infer<typeof AdminRoleCatalogueEntrySchema>;
export type AdminRoleCatalogueResponse = z.infer<typeof AdminRoleCatalogueResponseSchema>;
export type AdminSecurityEvent = z.infer<typeof AdminSecurityEventSchema>;
export type AdminSecurityEventsResponse = z.infer<typeof AdminSecurityEventsResponseSchema>;
export type RecoveryQueueQuery = z.infer<typeof RecoveryQueueQuerySchema>;
export type RecoveryQueueRow = z.infer<typeof RecoveryQueueRowSchema>;
export type RecoveryQueueResponse = z.infer<typeof RecoveryQueueResponseSchema>;
export type RecoveryRequestDetail = z.infer<typeof RecoveryRequestDetailSchema>;
export type RecoveryRequestDetailResponse = z.infer<typeof RecoveryRequestDetailResponseSchema>;
export type RecoveryEvidenceRow = z.infer<typeof RecoveryEvidenceRowSchema>;
export type RecoveryEvidenceResponse = z.infer<typeof RecoveryEvidenceResponseSchema>;
export type RecoveryReviewRequest = z.infer<typeof RecoveryReviewRequestSchema>;
export type RecoveryReviewResponse = z.infer<typeof RecoveryReviewResponseSchema>;
export type RecoveryDecisionRequest = z.infer<typeof RecoveryDecisionRequestSchema>;
export type RecoveryDecisionResponse = z.infer<typeof RecoveryDecisionResponseSchema>;
export type RecoveryCompletionRequest = z.infer<typeof RecoveryCompletionRequestSchema>;
export type RecoveryCompletionResponse = z.infer<typeof RecoveryCompletionResponseSchema>;
export type AuditQuery = z.infer<typeof AuditQuerySchema>;
export type AuditRow = z.infer<typeof AuditRowSchema>;
export type AuditPageResponse = z.infer<typeof AuditPageResponseSchema>;
