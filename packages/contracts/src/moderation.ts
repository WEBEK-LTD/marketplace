import { z } from './zod.js';
import { ReportReasonCodeSchema } from './messaging.js';
import { ReportStatusSchema } from './reports.js';

/**
 * Listing moderation and report management — the admin side (Phase 7-N).
 *
 * 0027 and 0011 own everything substantive. This module adds no vocabulary of its own: the eleven reason
 * codes come from the messaging module, which read them off `reports_reason_code_allowed` in 5-H, and the
 * five report statuses from the reports module, which read them off `reports_status_allowed` in 7-M. A
 * second copy of a closed list is a second list that can drift from the first.
 *
 * **No request names an actor, a role, a permission or an assurance level.** The moderator is resolved from
 * their own validated session and their assurance level from that same token; every request schema below is
 * `.strict()` and has no field through which any of it could be claimed. There is no `moderatorUserId`, no
 * `isAal2` and no `permission` anywhere in this file.
 *
 * **A report is addressed by its id and a listing by its id**, which is what 0027's own writers take. That
 * is the opposite of 7-M's slug, and for the opposite reason: a public page has no listing id to send
 * because nothing publishes one, while a colleague holding `catalog.listing.read` reads listings *by* their
 * ids. What authorizes the write is the permission and the assurance level, checked in the database before
 * the writer is reached — not the shape of the identifier. No operation here accepts a storage path or a
 * bucket, because moderating a listing touches no storage at all.
 *
 * **The transitions are the writers'.** A report resolution carries one of `triaged`, `actioned`,
 * `dismissed` and `duplicate` — the four `resolve_report` accepts — and **not `open`**, which it refuses:
 * there is no un-triage and no reopen in this repository, so there is no schema for one here. A listing
 * moderation carries one of `approve`, `reject`, `suspend`, `reinstate` and `request_changes`, the five
 * `moderate_listing` defines.
 *
 * **No account identifier crosses, in either direction.** No response schema has a place for a reporter, a
 * seller or a colleague moderator. A report reports `isOwnReport`, an action reports `isOwnAction`, and a
 * resolved report reports `resolvedByMe` — the booleans the workflow needs, because `resolve_report` refuses
 * a moderator their own report and a colleague needs to know that before they try.
 *
 * **Nothing here is a reversal API.** `moderation_actions.reverses_action_id` is read back where it exists
 * and there is no request field that could set one: no writer in this repository ever has, and
 * reinstatement is one of the five actions rather than a reversal of another.
 */

export { ReportStatusSchema, REPORT_STATUSES } from './reports.js';
export type { ReportStatus } from './reports.js';

/** 0027's eight report subject types, read off `reports_subject_type_allowed`. Display only. */
export const REPORT_SUBJECT_TYPES_ALL = [
  'listing',
  'review',
  'review_reply',
  'message',
  'conversation',
  'seller',
  'user',
  'promotion',
] as const;
export type ReportSubjectTypeAll = (typeof REPORT_SUBJECT_TYPES_ALL)[number];
export const ReportSubjectTypeAllSchema = z
  .enum(REPORT_SUBJECT_TYPES_ALL)
  .openapi('ReportSubjectTypeAll', {
    description:
      'What a report is about, in the reports table’s own eight values. Only `listing` and `seller` can be resolved to a summary on this surface: the other six have no staff read path in this repository.',
  });

/** `reports_priority_allowed`. Displayed as a fact and never used as an order; see the queue’s description. */
export const REPORT_PRIORITIES = ['low', 'normal', 'high'] as const;
export type ReportPriority = (typeof REPORT_PRIORITIES)[number];
export const ReportPrioritySchema = z.enum(REPORT_PRIORITIES).openapi('ReportPriority');

/**
 * The four statuses `resolve_report` accepts.
 *
 * `open` is deliberately absent: the writer raises on it, so a request carrying it would be a request the
 * database refuses. A reduced or extended list would be an invented one either way.
 */
export const REPORT_RESOLUTIONS = ['triaged', 'actioned', 'dismissed', 'duplicate'] as const;
export type ReportResolution = (typeof REPORT_RESOLUTIONS)[number];
export const ReportResolutionSchema = z.enum(REPORT_RESOLUTIONS).openapi('ReportResolution', {
  description:
    'What a moderator is recording. `triaged` means picked up with no decision yet; the other three are decisions and each requires a note. There is no `open`, because nothing in this repository moves a report back to it.',
});

/** `moderation_actions_action_allowed`. Read back on the trail; never sent. */
export const MODERATION_ACTIONS = [
  'none',
  'warn',
  'hide',
  'remove',
  'restrict',
  'suspend',
  'reinstate',
  'escalate',
] as const;
export type ModerationActionKind = (typeof MODERATION_ACTIONS)[number];
export const ModerationActionKindSchema = z.enum(MODERATION_ACTIONS).openapi('ModerationActionKind');

/** `listing_moderation_actions_action_allowed`, which is also `moderate_listing`'s own five. */
export const LISTING_MODERATION_ACTIONS = [
  'approve',
  'reject',
  'suspend',
  'reinstate',
  'request_changes',
] as const;
export type ListingModerationAction = (typeof LISTING_MODERATION_ACTIONS)[number];
export const ListingModerationActionSchema = z
  .enum(LISTING_MODERATION_ACTIONS)
  .openapi('ListingModerationAction', {
    description:
      'What a moderator is doing to a listing. `request_changes` is the one action that moves no status; the other four each land on the status the writer’s own mapping names.',
  });

/** `listings_status_allowed`. Read back only: no request names a listing status. */
export const LISTING_STATUSES = [
  'draft',
  'pending_review',
  'approved',
  'active',
  'sold',
  'expired',
  'archived',
  'rejected',
  'suspended',
  'deleted',
] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];
export const ListingStatusSchema = z.enum(LISTING_STATUSES).openapi('ListingStatus');

/** `reports_resolution_allowed`. The decision recorded, which is narrower than the status. */
export const ReportResolutionRecordedSchema = z
  .enum(['actioned', 'dismissed', 'duplicate'])
  .openapi('ReportResolutionRecorded');

/** `moderation_actions_reason_length` and `listing_moderation_actions_reason_length`: 1 to 500. */
export const ModerationReasonSchema = z.string().min(1).max(500);

/** `reports_resolved_has_note` requires one on every close; the column itself is unbounded text. */
export const ResolutionNoteSchema = z.string().min(1).max(4000);

/* ------------------------------------------------------------------------------------------------ */
/* The report queue and one report                                                                   */
/* ------------------------------------------------------------------------------------------------ */

export const ModerationReportRowSchema = z
  .object({
    id: z.string().uuid(),
    subjectType: ReportSubjectTypeAllSchema,
    subjectLabel: z.string().nullable(),
    reasonCode: ReportReasonCodeSchema,
    status: ReportStatusSchema,
    priority: ReportPrioritySchema,
    isOwnReport: z.boolean(),
    actionCount: z.number().int().min(0),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .openapi('ModerationReportRow');

export const ModerationReportQueueResponseSchema = z
  .object({
    items: z.array(ModerationReportRowSchema),
    nextCursor: z.string().nullable(),
  })
  .strict()
  .openapi('ModerationReportQueueResponse');

/**
 * One report, as a moderator reads it.
 *
 * `subjectIsResolvable` is false for the six subject types this repository has no staff read path for, so
 * the console says so rather than rendering an empty summary. `subjectStatus` is a listing's own status and
 * is null for every other subject: acting on a report about a listing that is already suspended is the
 * stale-state case this surface has to be able to see.
 */
export const ModerationReportDetailSchema = z
  .object({
    id: z.string().uuid(),
    subjectType: ReportSubjectTypeAllSchema,
    subjectSlug: z.string().nullable(),
    subjectLabel: z.string().nullable(),
    subjectStatus: ListingStatusSchema.nullable(),
    subjectIsResolvable: z.boolean(),
    reasonCode: ReportReasonCodeSchema,
    details: z.string().nullable(),
    status: ReportStatusSchema,
    priority: ReportPrioritySchema,
    isOwnReport: z.boolean(),
    resolution: ReportResolutionRecordedSchema.nullable(),
    resolutionNote: z.string().nullable(),
    resolvedAt: z.string().datetime({ offset: true }).nullable(),
    resolvedByMe: z.boolean(),
    duplicateOfReportId: z.string().uuid().nullable(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .openapi('ModerationReportDetail');

export const ModerationReportDetailResponseSchema = z
  .object({ report: ModerationReportDetailSchema })
  .strict()
  .openapi('ModerationReportDetailResponse');

/**
 * Recording a decision on a report.
 *
 * A note is required for the three decisions and optional for `triaged`, which is the writer's own rule; the
 * API checks the pairing so a missing note is a validation failure rather than a database refusal. An
 * original is required exactly when the status is `duplicate`, which is
 * `reports_duplicate_names_the_original`.
 */
export const ResolveReportRequestSchema = z
  .object({
    status: ReportResolutionSchema,
    resolutionNote: ResolutionNoteSchema.optional(),
    duplicateOfReportId: z.string().uuid().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status !== 'triaged' && value.resolutionNote === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['resolutionNote'],
        message: 'A report is never closed without a reason.',
      });
    }
    if (value.status === 'duplicate' && value.duplicateOfReportId === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['duplicateOfReportId'],
        message: 'A duplicate names the report it duplicates.',
      });
    }
    if (value.status !== 'duplicate' && value.duplicateOfReportId !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['duplicateOfReportId'],
        message: 'Only a duplicate names another report.',
      });
    }
  })
  .openapi('ResolveReportRequest');

export const ResolveReportResponseSchema = z
  .object({
    outcome: z.literal('resolved'),
    status: ReportStatusSchema,
  })
  .strict()
  .openapi('ResolveReportResponse');

/* ------------------------------------------------------------------------------------------------ */
/* The moderation trails                                                                             */
/* ------------------------------------------------------------------------------------------------ */

export const ModerationActionRowSchema = z
  .object({
    id: z.string().uuid(),
    action: ModerationActionKindSchema,
    reason: z.string(),
    notes: z.string().nullable(),
    reportId: z.string().uuid().nullable(),
    expiresAt: z.string().datetime({ offset: true }).nullable(),
    reversesActionId: z.string().uuid().nullable(),
    isOwnAction: z.boolean(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .openapi('ModerationActionRow');

export const ModerationActionsResponseSchema = z
  .object({ items: z.array(ModerationActionRowSchema) })
  .strict()
  .openapi('ModerationActionsResponse');

/** The listing-shaped trail, which carries the status move the generic one does not. */
export const ListingModerationRowSchema = z
  .object({
    id: z.string().uuid(),
    action: ListingModerationActionSchema,
    fromStatus: ListingStatusSchema,
    toStatus: ListingStatusSchema,
    reason: z.string(),
    reportId: z.string().uuid().nullable(),
    isOwnAction: z.boolean(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .openapi('ListingModerationRow');

export const ListingModerationHistoryResponseSchema = z
  .object({ items: z.array(ListingModerationRowSchema) })
  .strict()
  .openapi('ListingModerationHistoryResponse');

/* ------------------------------------------------------------------------------------------------ */
/* The listing queue and one listing                                                                 */
/* ------------------------------------------------------------------------------------------------ */

export const ModerationListingRowSchema = z
  .object({
    id: z.string().uuid(),
    slug: z.string(),
    title: z.string(),
    status: ListingStatusSchema,
    listingTypeCode: z.string(),
    currencyCode: z.string().length(3),
    priceMinor: z.string().nullable(),
    isOwnListing: z.boolean(),
    reportCount: z.number().int().min(0),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .openapi('ModerationListingRow');

export const ModerationListingQueueResponseSchema = z
  .object({
    items: z.array(ModerationListingRowSchema),
    nextCursor: z.string().nullable(),
  })
  .strict()
  .openapi('ModerationListingQueueResponse');

/**
 * One listing, as a moderator reads it before deciding.
 *
 * `canModerate` is the database's answer to whether this caller holds `catalog.listing.moderate` at `aal2`,
 * so a page ships the controls it means rather than guessing. `isOwnListing` is the writer's own refusal,
 * reported before it is met.
 */
export const ModerationListingDetailSchema = z
  .object({
    id: z.string().uuid(),
    slug: z.string(),
    title: z.string(),
    description: z.string(),
    contentLanguage: z.string(),
    status: ListingStatusSchema,
    listingTypeCode: z.string(),
    currencyCode: z.string().length(3),
    priceMinor: z.string().nullable(),
    city: z.string().nullable(),
    sellerSlug: z.string().nullable(),
    sellerDisplayName: z.string().nullable(),
    isOwnListing: z.boolean(),
    canModerate: z.boolean(),
    openReportCount: z.number().int().min(0),
    createdAt: z.string().datetime({ offset: true }),
    approvedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict()
  .openapi('ModerationListingDetail');

export const ModerationListingDetailResponseSchema = z
  .object({ listing: ModerationListingDetailSchema })
  .strict()
  .openapi('ModerationListingDetailResponse');

/** A decision about a listing. The reason is required, because both writers require one. */
export const ModerateListingRequestSchema = z
  .object({
    action: ListingModerationActionSchema,
    reason: ModerationReasonSchema,
    reportId: z.string().uuid().optional(),
  })
  .strict()
  .openapi('ModerateListingRequest');

export const ModerateListingResponseSchema = z
  .object({
    outcome: z.literal('moderated'),
    status: ListingStatusSchema,
  })
  .strict()
  .openapi('ModerateListingResponse');

/** The page sizes, the same twenty and fifty every other list on this platform uses. */
export const MODERATION_DEFAULT_LIMIT = 20;
export const MODERATION_MAX_LIMIT = 50;
/** How much of a trail a detail page shows. Not paged: a subject's history is short by construction. */
export const MODERATION_HISTORY_LIMIT = 50;

export type ModerationReportRow = z.infer<typeof ModerationReportRowSchema>;
export type ModerationReportQueueResponse = z.infer<typeof ModerationReportQueueResponseSchema>;
export type ModerationReportDetail = z.infer<typeof ModerationReportDetailSchema>;
export type ModerationReportDetailResponse = z.infer<typeof ModerationReportDetailResponseSchema>;
export type ResolveReportRequest = z.infer<typeof ResolveReportRequestSchema>;
export type ResolveReportResponse = z.infer<typeof ResolveReportResponseSchema>;
export type ModerationActionRow = z.infer<typeof ModerationActionRowSchema>;
export type ModerationActionsResponse = z.infer<typeof ModerationActionsResponseSchema>;
export type ListingModerationRow = z.infer<typeof ListingModerationRowSchema>;
export type ListingModerationHistoryResponse = z.infer<typeof ListingModerationHistoryResponseSchema>;
export type ModerationListingRow = z.infer<typeof ModerationListingRowSchema>;
export type ModerationListingQueueResponse = z.infer<typeof ModerationListingQueueResponseSchema>;
export type ModerationListingDetail = z.infer<typeof ModerationListingDetailSchema>;
export type ModerationListingDetailResponse = z.infer<typeof ModerationListingDetailResponseSchema>;
export type ModerateListingRequest = z.infer<typeof ModerateListingRequestSchema>;
export type ModerateListingResponse = z.infer<typeof ModerateListingResponseSchema>;
