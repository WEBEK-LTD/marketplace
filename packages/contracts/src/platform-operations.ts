import { z } from './zod.js';

/**
 * Platform job runs and outbox health — the admin side (Phase 7-Q).
 *
 * 0007 owns everything substantive: `job_runs`, `outbox_events`, the four run statuses, the four event
 * states, and every function that writes either. 0032 owns the schedule — the contract table, the dispatcher
 * and the guard that compares the two. This module invents no vocabulary.
 *
 * ---------------------------------------------------------------------------------------------------
 * **EVERY SCHEMA IN THIS FILE IS A RESPONSE. THERE IS NOT ONE REQUEST SCHEMA.**
 *
 * Nothing on this surface changes anything, because nothing in this repository authorizes a console to. The
 * workers own every write: `start_job_run` and `finish_job_run` are the only writers of a run, and
 * `claim_outbox_events`, `complete_outbox_event`, `sweep_outbox_events` and `dead_letter_outbox_event` are
 * the only writers of an event — all four granted to `app_worker`, none of them wrapped by this increment.
 *
 * So there is no retry, no cancel, no requeue, no re-run and no dead-letter replay in this file, and no
 * request body through which one could be asked for. Adding any of them means an owner decision about what a
 * console may do to a queue, and then a writer that does not exist yet.
 * ---------------------------------------------------------------------------------------------------
 *
 * **No request names an actor, a role, a permission or an assurance level**, because no request exists at
 * all. The one key — `platform.job.read`, held by `admin` and `super_admin` alone (0033) — is resolved from
 * the caller's own validated session and re-tested in the database as a literal.
 *
 * **Nobody is named and nothing is identified beyond a run.** A run has an id because a run has a detail
 * page; an outbox event has no id here, no aggregate id, no aggregate type, no payload and no `created_by`,
 * because nothing acts on an event and an identifier would therefore enable nothing.
 *
 * ---------------------------------------------------------------------------------------------------
 * **THE RAW ERROR MESSAGE IS ABSENT FROM THIS FILE ON PURPOSE.**
 *
 * `job_runs.details` is free-form jsonb, and both copies of 0032's dispatcher write a failure as
 * `jsonb_build_object('job_key', …, 'sqlstate', sqlstate, 'message', left(sqlerrm, 500))`. A raw PostgreSQL
 * error message embeds row data — a check-constraint violation quotes the failing row, a unique violation
 * quotes the key values — so `details` is a disclosure surface wearing the clothes of a diagnostic field.
 *
 * What crosses is `errorType` (the column, constrained to `^[A-Za-z][A-Za-z0-9_]*$`), `errorSqlstate` (five
 * characters of error class) and `detailJobKey` (the contract key the row already carries). There is no
 * `message`, no `details` and no field of any other name carrying either.
 * ---------------------------------------------------------------------------------------------------
 *
 * **No threshold and no verdict.** Ages cross as timestamps; nothing here says whether a number is
 * acceptable. `sweep_outbox_events` takes its staleness from its caller, so a "stale" flag in a contract
 * would be a rule this platform has deliberately not written down.
 */

/* ------------------------------------------------------------------------------------------------ */
/* Paging                                                                                            */
/* ------------------------------------------------------------------------------------------------ */

export const PLATFORM_OPS_DEFAULT_LIMIT = 20;
export const PLATFORM_OPS_MAX_LIMIT = 50;
/** How many dead-letter groups one read returns. A fixed page: the grouping is short and is not paged. */
export const PLATFORM_DEAD_LETTER_LIMIT = 50;

export const PlatformOpsLimitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(PLATFORM_OPS_MAX_LIMIT)
  .default(PLATFORM_OPS_DEFAULT_LIMIT);

/** Opaque and versioned per kind, as everywhere else. Never parsed or constructed by a browser. */
export const PlatformOpsCursorSchema = z.string().min(1).max(512);

/* ------------------------------------------------------------------------------------------------ */
/* Vocabulary                                                                                        */
/* ------------------------------------------------------------------------------------------------ */

/** 0007's `job_runs_status_allowed`, and nothing else. */
export const JOB_RUN_STATUSES = ['running', 'succeeded', 'failed', 'skipped'] as const;
export type JobRunStatus = (typeof JOB_RUN_STATUSES)[number];
export const JobRunStatusSchema = z.enum(JOB_RUN_STATUSES).openapi('JobRunStatus', {
  description:
    'A job run’s state, in the four values 0007 allows. `running` is exactly the rows with no finish time, which `job_runs_finished_when_done` guarantees.',
});

/**
 * A job name, as 0007 constrains it: `^[a-z][a-z0-9_.]*$`.
 *
 * Checked on the way in as a filter so nothing that could not be a job name reaches a parameter binding, and
 * described on the way out so a drifted API cannot put free text on a screen.
 */
export const JOB_NAME_PATTERN = /^[a-z][a-z0-9_.]*$/;
export const JobNameSchema = z.string().min(1).max(200).regex(JOB_NAME_PATTERN);

/**
 * An error class, as 0007 constrains both `job_runs.error_type` and `outbox_events.last_error_type`:
 * `^[A-Za-z][A-Za-z0-9_]*$`. A class name, never a message.
 */
export const ERROR_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
export const ErrorTypeSchema = z.string().min(1).max(200).regex(ERROR_TYPE_PATTERN);

/** Five characters of PostgreSQL error class, out of `details -> 'sqlstate'`. Never a message. */
export const SqlstateSchema = z.string().regex(/^[0-9A-Z]{5}$/);

/**
 * An event type, as 0007 constrains it: `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$`.
 *
 * It names a kind of thing that happened — `order.placed`, `review.moderated` — and identifies no instance
 * of one.
 */
export const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
export const EventTypeSchema = z.string().min(1).max(200).regex(EVENT_TYPE_PATTERN);

/* ------------------------------------------------------------------------------------------------ */
/* The run list                                                                                      */
/* ------------------------------------------------------------------------------------------------ */

export const JobRunQuerySchema = z
  .object({
    status: JobRunStatusSchema.optional(),
    jobName: JobNameSchema.optional(),
    limit: PlatformOpsLimitSchema.optional(),
    cursor: PlatformOpsCursorSchema.optional(),
  })
  .strict()
  .openapi('JobRunQuery');

/**
 * One job run in the list.
 *
 * `durationMs` is computed from the two timestamps the row carries and is null exactly while a run is still
 * going, which `job_runs_finished_when_done` makes equivalent to `status === 'running'` — so a null duration
 * is a running row and never a missing measurement.
 *
 * `processedCount` is nullable and its null is meaningful: a job that failed processed nothing *and recorded
 * nothing*, which is a different fact from a job that ran and processed zero.
 *
 * `isContracted` says whether 0032's schedule still names this job key. A run of a key the contract has
 * dropped stays readable and is labelled rather than hidden.
 */
export const JobRunRowSchema = z
  .object({
    id: z.string().uuid(),
    jobName: JobNameSchema,
    status: JobRunStatusSchema,
    scheduledFor: z.string().datetime({ offset: true }).nullable(),
    startedAt: z.string().datetime({ offset: true }),
    finishedAt: z.string().datetime({ offset: true }).nullable(),
    durationMs: z.number().int().nonnegative().nullable(),
    errorType: ErrorTypeSchema.nullable(),
    processedCount: z.number().int().nullable(),
    isContracted: z.boolean(),
  })
  .strict()
  .openapi('JobRunRow');

export const JobRunPageResponseSchema = z
  .object({
    items: z.array(JobRunRowSchema),
    nextCursor: z.string().nullable(),
  })
  .strict()
  .openapi('JobRunPageResponse');

/* ------------------------------------------------------------------------------------------------ */
/* One run                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

/**
 * One job run, with the contract row it belongs to when the schedule still names its key.
 *
 * `targetSignature` names the `app_private` or `audit` function the job calls and is constrained by 0032 to
 * that shape. It is a schema fact rather than a secret, and it is what tells somebody reading a failure which
 * function failed; a page showing a job key with no indication of what it runs would send them to the
 * migrations to find out.
 *
 * **`errorSqlstate` and `detailJobKey` are the only two things read out of `details`.** The third key the
 * dispatcher writes is `message`, and it is absent — see the module note.
 */
export const JobRunDetailSchema = z
  .object({
    id: z.string().uuid(),
    jobName: JobNameSchema,
    status: JobRunStatusSchema,
    scheduledFor: z.string().datetime({ offset: true }).nullable(),
    startedAt: z.string().datetime({ offset: true }),
    finishedAt: z.string().datetime({ offset: true }).nullable(),
    durationMs: z.number().int().nonnegative().nullable(),
    errorType: ErrorTypeSchema.nullable(),
    errorSqlstate: SqlstateSchema.nullable(),
    detailJobKey: JobNameSchema.nullable(),
    processedCount: z.number().int().nullable(),
    isContracted: z.boolean(),
    cronSchedule: z.string().nullable(),
    targetSignature: z.string().nullable(),
    purpose: z.string().nullable(),
  })
  .strict()
  .openapi('JobRunDetail');

export const JobRunDetailResponseSchema = z
  .object({ run: JobRunDetailSchema })
  .strict()
  .openapi('JobRunDetailResponse');

/* ------------------------------------------------------------------------------------------------ */
/* The schedule                                                                                      */
/* ------------------------------------------------------------------------------------------------ */

/**
 * One contracted job, with the facts of its most recent run.
 *
 * Every `last*` field is nullable together: a contracted job that has never run reports nulls rather than
 * zeros, because nothing having run is a different fact from something running and processing nothing.
 *
 * **This list contains no worker repeatable job.** v5.2 lists seven of them and says every job run is
 * recorded in `job_runs`, but the worker calls neither writer and 0032's contract names only the pg_cron
 * jobs. Reported as a capability gap rather than filled with rows this repository cannot produce.
 */
export const ScheduledJobSchema = z
  .object({
    jobKey: JobNameSchema,
    cronSchedule: z.string(),
    targetSignature: z.string(),
    purpose: z.string(),
    runCount: z.number().int().nonnegative(),
    failureCount: z.number().int().nonnegative(),
    lastStatus: JobRunStatusSchema.nullable(),
    lastStartedAt: z.string().datetime({ offset: true }).nullable(),
    lastFinishedAt: z.string().datetime({ offset: true }).nullable(),
    lastDurationMs: z.number().int().nonnegative().nullable(),
    lastErrorType: ErrorTypeSchema.nullable(),
    lastProcessedCount: z.number().int().nullable(),
  })
  .strict()
  .openapi('ScheduledJob');

export const ScheduledJobCatalogueResponseSchema = z
  .object({ items: z.array(ScheduledJobSchema) })
  .strict()
  .openapi('ScheduledJobCatalogueResponse');

/**
 * One disagreement between the real pg_cron catalogue and 0032's contract.
 *
 * 0032's own two columns, unchanged. `problem` is a sentence that function composes; it is not translated,
 * because it is a database fact rather than console copy, and paraphrasing it would mean this contract
 * deciding what each of its clauses means.
 */
export const ScheduleProblemSchema = z
  .object({ object: z.string(), problem: z.string() })
  .strict()
  .openapi('ScheduleProblem');

export const ScheduleProblemsResponseSchema = z
  .object({ items: z.array(ScheduleProblemSchema) })
  .strict()
  .openapi('ScheduleProblemsResponse');

/* ------------------------------------------------------------------------------------------------ */
/* Outbox health                                                                                     */
/* ------------------------------------------------------------------------------------------------ */

/**
 * The transactional outbox as counts and ages.
 *
 * The four states are 0007's own partial-index predicates and they partition every event exactly once:
 *
 *   * `pendingCount` — unpublished and not dead-lettered (`outbox_events_pending`)
 *   * `dueCount` — of those, the ones whose `available_at` has passed, which is `claim_outbox_events`' own
 *     claiming condition
 *   * `inFlightCount` — published, not completed, not dead-lettered (`outbox_events_in_flight`)
 *   * `completedCount` — completed
 *   * `deadLetteredCount` — dead-lettered (`outbox_events_dead_lettered`)
 *
 * **Not one identifier.** No event id, no aggregate id or type, no payload, no `created_by`.
 *
 * **No verdict.** Three timestamps and a maximum attempt count cross; nothing says whether any of it is
 * acceptable. At the time of writing every event is pending, because no relay exists in this repository yet —
 * a fact the console states in words beside these numbers rather than one this contract encodes.
 */
export const OutboxHealthSchema = z
  .object({
    pendingCount: z.number().int().nonnegative(),
    dueCount: z.number().int().nonnegative(),
    inFlightCount: z.number().int().nonnegative(),
    completedCount: z.number().int().nonnegative(),
    deadLetteredCount: z.number().int().nonnegative(),
    oldestPendingAt: z.string().datetime({ offset: true }).nullable(),
    oldestInFlightAt: z.string().datetime({ offset: true }).nullable(),
    latestDeadLetteredAt: z.string().datetime({ offset: true }).nullable(),
    maxAttempts: z.number().int().nonnegative().nullable(),
  })
  .strict()
  .openapi('OutboxHealth');

export const OutboxHealthResponseSchema = z
  .object({ health: OutboxHealthSchema })
  .strict()
  .openapi('OutboxHealthResponse');

/**
 * Dead-lettered events, grouped by kind rather than listed.
 *
 * Both grouping columns are constrained by 0007 and neither can carry free text. There is no event id and no
 * aggregate id: a list would have to identify each event to be worth listing, and identifying one means
 * naming the order, conversation or account it is about — while there is no action here to take on one.
 */
export const OutboxDeadLetterGroupSchema = z
  .object({
    eventType: EventTypeSchema,
    lastErrorType: ErrorTypeSchema.nullable(),
    eventCount: z.number().int().positive(),
    firstDeadLetteredAt: z.string().datetime({ offset: true }),
    lastDeadLetteredAt: z.string().datetime({ offset: true }),
    maxAttempts: z.number().int().nonnegative(),
  })
  .strict()
  .openapi('OutboxDeadLetterGroup');

export const OutboxDeadLettersResponseSchema = z
  .object({ items: z.array(OutboxDeadLetterGroupSchema) })
  .strict()
  .openapi('OutboxDeadLettersResponse');

/**
 * The outbox screen, as one response.
 *
 * Health and the dead-letter groups travel together because they are one screen and neither is meaningful
 * without the other: a dead-letter count with no breakdown says something is wrong and not what, and a
 * breakdown with no totals gives no sense of scale.
 *
 * Defined here once rather than merged at each layer, because both halves are `.strict()`: validating the
 * combined body against either half alone would refuse it for carrying the other half's key. One schema means
 * the API, the BFF and the OpenAPI document cannot disagree about that.
 */
export const OutboxResponseSchema = OutboxHealthResponseSchema.extend(
  OutboxDeadLettersResponseSchema.shape,
)
  .strict()
  .openapi('OutboxResponse');

/* ------------------------------------------------------------------------------------------------ */
/* Types                                                                                             */
/* ------------------------------------------------------------------------------------------------ */

export type JobRunQuery = z.infer<typeof JobRunQuerySchema>;
export type JobRunRow = z.infer<typeof JobRunRowSchema>;
export type JobRunPageResponse = z.infer<typeof JobRunPageResponseSchema>;
export type JobRunDetail = z.infer<typeof JobRunDetailSchema>;
export type JobRunDetailResponse = z.infer<typeof JobRunDetailResponseSchema>;
export type ScheduledJob = z.infer<typeof ScheduledJobSchema>;
export type ScheduledJobCatalogueResponse = z.infer<typeof ScheduledJobCatalogueResponseSchema>;
export type ScheduleProblem = z.infer<typeof ScheduleProblemSchema>;
export type ScheduleProblemsResponse = z.infer<typeof ScheduleProblemsResponseSchema>;
export type OutboxHealth = z.infer<typeof OutboxHealthSchema>;
export type OutboxHealthResponse = z.infer<typeof OutboxHealthResponseSchema>;
export type OutboxDeadLetterGroup = z.infer<typeof OutboxDeadLetterGroupSchema>;
export type OutboxDeadLettersResponse = z.infer<typeof OutboxDeadLettersResponseSchema>;
export type OutboxResponse = z.infer<typeof OutboxResponseSchema>;
