import { z } from './zod.js';
import { ReportReasonCodeSchema } from './messaging.js';

/**
 * Reports — the reporter side (Phase 7-M).
 *
 * 0027 owns reporting. This module adds no vocabulary of its own: the eleven reason codes are imported
 * from the messaging module, which read them off 0027's `reports_reason_code_allowed` in 5-H, because a
 * second copy of a closed list is a second list that can drift from the first.
 *
 * **The subject is named by its public slug, never by an id.** That is not a stylistic choice. 0050's
 * `public_seller_by_slug` returns five public fields and explicitly never the seller id, and a seller
 * report's subject is a *user* id — the very thing that projection exists to withhold. So a page has no
 * subject id to send, and giving it one would mean publishing an identifier in order to accept it back.
 * The slug is what the page is addressed by, the database resolves it through the same readers that decide
 * whether the page renders at all, and the consequence is that "an arbitrary uuid aimed at the report
 * writer" is not a request this contract can express.
 *
 * **Two subject types, and the other six are absent on purpose.** 0027 allows eight. `message` and
 * `conversation` are already filed by 5-H from inside the conversation they belong to, and a second path
 * to them would be a second reporting system. `review`, `review_reply`, `user` and `promotion` have no
 * surface on which one person sees another person's: reviews are read by the seller they are about,
 * promotions by the seller who owns them, and there is no public page for a person. A subject type with no
 * page to report it from would be a field waiting for a caller to guess at.
 *
 * **Nothing about moderation is representable.** No request carries a status, a priority, an assignee or a
 * resolution, and no response schema has a place for one. The history projection carries the status in
 * 0027's own five-value vocabulary and stops there: no priority, no assignee, no resolution, no resolution
 * note, no resolver, no duplicate-of, and not even the subject id — a report is read back by the slug it
 * was filed by.
 *
 * **One outcome for a filing, as 5-H has.** 0027's C10 early return makes a repeat land on the report
 * already open and return its id, so "created" and "already open" are the same fact from the reporter's
 * side, and this contract does not invent a second word for it.
 */

/** Re-exported rather than redeclared: 0027's eleven, already read off the constraint in 5-H. */
export { REPORT_REASON_CODES, ReportReasonCodeSchema } from './messaging.js';
export type { ReportReasonCode } from './messaging.js';

/**
 * The two subject types a public page can produce a report about.
 *
 * Both are 0027's own. The header says why the other six are not here.
 */
export const REPORT_SUBJECT_TYPES = ['listing', 'seller'] as const;
export type ReportSubjectType = (typeof REPORT_SUBJECT_TYPES)[number];
export const ReportSubjectTypeSchema = z
  .enum(REPORT_SUBJECT_TYPES)
  .openapi('ReportSubjectType', {
    description:
      'What is being reported: a listing (a product or a service, which share one table and one slug namespace) or a seller. Both are subject types the reports table already allows.',
  });

/** 0027's five statuses, read off `reports_status_allowed` and never reduced or renamed. */
export const REPORT_STATUSES = ['open', 'triaged', 'actioned', 'dismissed', 'duplicate'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];
export const ReportStatusSchema = z.enum(REPORT_STATUSES).openapi('ReportStatus', {
  description:
    'What has become of the report, in the vocabulary the reports table itself uses. A reduced reporter-facing vocabulary would be an invented one.',
});

/**
 * `listings_slug_format` and `seller_profiles_slug_format`, which are the same shape.
 *
 * Bounded and checked here so a page cannot send a thousand characters of anything and have the database
 * decide what it was. It is still the database that decides what the slug *names*.
 */
export const ReportSubjectSlugSchema = z
  .string()
  .min(3)
  .max(120)
  .regex(/^[a-z0-9](?:[a-z0-9-]{1,118}[a-z0-9])$/u);

/** `reports_details_length`: absent, or one to four thousand characters once trimmed. */
export const ReportDetailsSchema = z.string().min(1).max(4000);

export const FileReportRequestSchema = z
  .object({
    subjectType: ReportSubjectTypeSchema,
    subjectSlug: ReportSubjectSlugSchema,
    reasonCode: ReportReasonCodeSchema,
    details: ReportDetailsSchema.optional(),
  })
  .strict()
  .openapi('FileReportRequest');

/**
 * The report that is now open for this reporter and this subject.
 *
 * One outcome, for 5-H's reason: a first filing and a repeat are the same answer with the same id. The id
 * is the reporter's own report, which is why it may cross to them.
 */
export const FileReportResponseSchema = z
  .object({
    outcome: z.literal('filed'),
    reportId: z.string().uuid(),
  })
  .strict()
  .openapi('FileReportResponse');

/**
 * One of the reporter's own reports.
 *
 * `subjectSlug` and `subjectLabel` are looked up rather than stored: a report outlives its subject, which
 * is 0027's own design and exactly when a report matters most, so a subject that has since left public
 * view carries neither. `subjectType` always survives, because it is on the report itself.
 */
export const ReporterReportSchema = z
  .object({
    id: z.string().uuid(),
    subjectType: ReportSubjectTypeSchema,
    subjectSlug: ReportSubjectSlugSchema.nullable(),
    subjectLabel: z.string().nullable(),
    reasonCode: ReportReasonCodeSchema,
    details: ReportDetailsSchema.nullable(),
    status: ReportStatusSchema,
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .openapi('ReporterReport');

export const ReporterReportsResponseSchema = z
  .object({
    items: z.array(ReporterReportSchema),
    nextCursor: z.string().nullable(),
  })
  .strict()
  .openapi('ReporterReportsResponse');

/** The page size for the reporter's own history. The same twenty every other list on this platform uses. */
export const REPORTS_DEFAULT_LIMIT = 20;
export const REPORTS_MAX_LIMIT = 50;

export type FileReportRequest = z.infer<typeof FileReportRequestSchema>;
export type FileReportResponse = z.infer<typeof FileReportResponseSchema>;
export type ReporterReport = z.infer<typeof ReporterReportSchema>;
export type ReporterReportsResponse = z.infer<typeof ReporterReportsResponseSchema>;
