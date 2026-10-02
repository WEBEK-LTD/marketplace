import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  JobRunDetail,
  JobRunRow,
  JobRunStatus,
  OutboxDeadLetterGroup,
  OutboxHealth,
  ScheduleProblem,
  ScheduledJob,
} from '@repo/contracts';
import { isAal2 } from '../auth/access-token-claims.js';
import { StaffConsoleService } from './staff-console.service.js';
import {
  PlatformCursorInvalidError,
  PlatformNotFoundError,
  PlatformUnavailableError,
} from './platform-operations.errors.js';
import { decodeJobRunCursor, encodeJobRunCursor } from './platform-operations.cursor.js';

/**
 * Platform job runs and outbox health (Phase 7-Q).
 *
 * **Authorization, in the one order it is ever done**, which is 7-F's and is not varied:
 *
 *   1. The **provider** validates the caller's access token and says whose it is.
 *   2. The **assurance level** is read from that same, now-vouched-for token. Reading a claim first would be
 *      reading an attacker's JSON.
 *   3. The **database** reports the caller's *effective* permissions under the platform's own `requires_mfa`
 *      rule. Both roles that hold `platform.job.read` — `admin` and `super_admin` — require MFA, so staff at
 *      `aal1` hold nothing at all; asking whether the effective set contains the key is therefore the AAL2
 *      check and the permission check at once.
 *   4. Every `app_private` function below **re-applies the same permission test itself**, with the account and
 *      the assurance level as parameters and the key as a **literal**. No bug in this file can turn into
 *      somebody's job history.
 *
 * **One key, and it is the narrowest one in the console.** `platform.job.read` is held by `admin` and
 * `super_admin` alone; Moderator and Support Agent hold it in neither direction. No role name is checked
 * anywhere in this file.
 *
 * ---------------------------------------------------------------------------------------------------
 * **THIS SERVICE HAS NO METHOD THAT CHANGES ANYTHING, AND THAT IS THE WHOLE POINT OF IT.**
 *
 * The workers own every write. `start_job_run` and `finish_job_run` are the only writers of a run;
 * `claim_outbox_events`, `complete_outbox_event`, `sweep_outbox_events` and `dead_letter_outbox_event` are the
 * only writers of an event; all four are granted to `app_worker` and none is wrapped by this increment. There
 * is no retry, no cancel, no requeue, no re-run and no dead-letter replay here, because no authoritative
 * writer for any of them exists — building one would mean this service deciding what a console may do to a
 * live queue.
 * ---------------------------------------------------------------------------------------------------
 *
 * **The raw error message never crosses this layer, because it never reaches it.** `job_runs.details` holds
 * `message: left(sqlerrm, 500)` on a failure, and a PostgreSQL error message embeds the row that caused it.
 * The database functions read two keys out of that object — the SQLSTATE and the job key — and this service
 * cannot read a third: there is no field on any row type below through which `details` could arrive.
 *
 * **Every rule this surface appears to apply is applied in the database.** The four run statuses, the four
 * event states, the limit clamp, the newest-first order, whether a run's key is still contracted, and what
 * the scheduled-job guard considers a problem — all of it is decided inside migration 0081 or in the 0007 and
 * 0032 definitions it reads. This service passes the caller's account, shapes the answer, and **checks
 * nothing a second time**.
 *
 * **A refusal and an absence are the same answer.** A run that does not exist and a caller without the key
 * both arrive as `not_found` and become one {@link PlatformNotFoundError}. Outbox health answers the same
 * way, which is why its database function carries an outcome rather than aggregating: a count over rows the
 * authorization removed would otherwise be a row of zeros, and zeros are not a refusal.
 */

export const PLATFORM_JOB_READ = 'platform.job.read';

export const PLATFORM_OPERATIONS_STORE = Symbol('PLATFORM_OPERATIONS_STORE');

/* ------------------------------------------------------------------------------------------------ */
/* The rows each function returns                                                                    */
/* ------------------------------------------------------------------------------------------------ */

/** One row of `app_private.job_run_page` (0081). */
export interface JobRunDbRow {
  readonly id: string;
  readonly jobName: string;
  readonly status: string;
  readonly scheduledFor: Date | string | null;
  readonly startedAt: Date | string;
  readonly finishedAt: Date | string | null;
  readonly durationMs: number | string | null;
  readonly errorType: string | null;
  readonly processedCount: number | null;
  readonly isContracted: boolean;
}

/** One row of `app_private.job_run_detail` (0081). */
export interface JobRunDetailDbRow {
  readonly outcome: string;
  readonly id: string | null;
  readonly jobName: string | null;
  readonly status: string | null;
  readonly scheduledFor: Date | string | null;
  readonly startedAt: Date | string | null;
  readonly finishedAt: Date | string | null;
  readonly durationMs: number | string | null;
  readonly errorType: string | null;
  readonly errorSqlstate: string | null;
  readonly detailJobKey: string | null;
  readonly processedCount: number | null;
  readonly isContracted: boolean | null;
  readonly cronSchedule: string | null;
  readonly targetSignature: string | null;
  readonly purpose: string | null;
}

/** One row of `app_private.scheduled_job_catalogue` (0081). */
export interface ScheduledJobDbRow {
  readonly jobKey: string;
  readonly cronSchedule: string;
  readonly targetSignature: string;
  readonly purpose: string;
  readonly runCount: number | string;
  readonly failureCount: number | string;
  readonly lastStatus: string | null;
  readonly lastStartedAt: Date | string | null;
  readonly lastFinishedAt: Date | string | null;
  readonly lastDurationMs: number | string | null;
  readonly lastErrorType: string | null;
  readonly lastProcessedCount: number | null;
}

/** The single row of `app_private.outbox_health` (0081). */
export interface OutboxHealthDbRow {
  readonly outcome: string;
  readonly pendingCount: number | string | null;
  readonly dueCount: number | string | null;
  readonly inFlightCount: number | string | null;
  readonly completedCount: number | string | null;
  readonly deadLetteredCount: number | string | null;
  readonly oldestPendingAt: Date | string | null;
  readonly oldestInFlightAt: Date | string | null;
  readonly latestDeadLetteredAt: Date | string | null;
  readonly maxAttempts: number | null;
}

/** One row of `app_private.outbox_dead_letters` (0081). */
export interface OutboxDeadLetterDbRow {
  readonly eventType: string;
  readonly lastErrorType: string | null;
  readonly eventCount: number | string;
  readonly firstDeadLetteredAt: Date | string;
  readonly lastDeadLetteredAt: Date | string;
  readonly maxAttempts: number;
}

/** One row of `app_private.platform_schedule_problems` (0081). */
export interface ScheduleProblemDbRow {
  readonly object: string;
  readonly problem: string;
}

/**
 * Five readers, and not one writer.
 *
 * The absence is the interface's most important property: a store that could retry an event would have to
 * declare the method here first, and there is nowhere for it to go.
 */
export interface PlatformOperationsStore {
  jobRunPage(input: {
    userId: string;
    isAal2: boolean;
    limit: number;
    status: string | null;
    jobName: string | null;
    cursorStartedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly JobRunDbRow[]>;

  jobRunDetail(input: {
    userId: string;
    isAal2: boolean;
    runId: string;
  }): Promise<JobRunDetailDbRow>;

  scheduledJobCatalogue(input: {
    userId: string;
    isAal2: boolean;
  }): Promise<readonly ScheduledJobDbRow[]>;

  outboxHealth(input: { userId: string; isAal2: boolean }): Promise<OutboxHealthDbRow>;

  outboxDeadLetters(input: {
    userId: string;
    isAal2: boolean;
    limit: number;
  }): Promise<readonly OutboxDeadLetterDbRow[]>;

  platformScheduleProblems(input: {
    userId: string;
    isAal2: boolean;
  }): Promise<readonly ScheduleProblemDbRow[]>;
}

export interface JobRunPage {
  readonly items: readonly JobRunRow[];
  readonly nextCursor: string | null;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toIsoOrNull(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

/** `count(*)` and `extract(epoch …)::bigint` arrive as strings from `pg`; a count is a number here. */
function toNumber(value: number | string): number {
  return typeof value === 'number' ? value : Number(value);
}

function toNumberOrNull(value: number | string | null): number | null {
  return value === null ? null : toNumber(value);
}

@Injectable()
export class PlatformOperationsService {
  private readonly logger = new Logger(PlatformOperationsService.name);

  constructor(
    @Inject(PLATFORM_OPERATIONS_STORE) private readonly store: PlatformOperationsStore,
    private readonly console: StaffConsoleService,
  ) {}

  /**
   * One page of job runs, **newest first**.
   *
   * The page is read one row longer than asked for, so `nextCursor` is null exactly when the page is the last
   * one rather than one request later.
   */
  async runs(input: {
    accessToken: string;
    limit: number;
    status: string | null;
    jobName: string | null;
    cursor: string | null;
  }): Promise<JobRunPage> {
    const staff = await this.#staff(input.accessToken);

    let position: { startedAt: Date; id: string } | null = null;
    if (input.cursor !== null) {
      position = decodeJobRunCursor(input.cursor);
      // One refusal for malformed, altered and outdated — including a position from any other list on this
      // platform, whose rows sit behind different keys entirely.
      if (position === null) throw new PlatformCursorInvalidError();
    }

    let rows: readonly JobRunDbRow[];
    try {
      rows = await this.store.jobRunPage({
        userId: staff.id,
        isAal2: staff.isAal2,
        limit: input.limit + 1,
        // Passed as parameters. An unknown value matches nothing in the database rather than being refused
        // here, which is the reader's own documented behaviour and means a stale filter in a bookmark shows
        // an empty page instead of an error.
        status: input.status,
        jobName: input.jobName,
        cursorStartedAt: position?.startedAt ?? null,
        cursorId: position?.id ?? null,
      });
    } catch (error) {
      this.logger.error('The job run list could not be read.');
      throw new PlatformUnavailableError(error);
    }

    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        id: row.id,
        jobName: row.jobName,
        status: row.status as JobRunStatus,
        scheduledFor: toIsoOrNull(row.scheduledFor),
        startedAt: toIso(row.startedAt),
        finishedAt: toIsoOrNull(row.finishedAt),
        durationMs: toNumberOrNull(row.durationMs),
        errorType: row.errorType,
        processedCount: row.processedCount,
        isContracted: row.isContracted,
      })),
      nextCursor:
        hasMore && last !== undefined
          ? encodeJobRunCursor({ startedAt: new Date(toIso(last.startedAt)), id: last.id })
          : null,
    };
  }

  /** One run, with its contract row. A missing one and a caller without the key are the same answer. */
  async run(input: { accessToken: string; runId: string }): Promise<JobRunDetail> {
    const staff = await this.#staff(input.accessToken);

    let row: JobRunDetailDbRow;
    try {
      row = await this.store.jobRunDetail({
        userId: staff.id,
        isAal2: staff.isAal2,
        runId: input.runId,
      });
    } catch (error) {
      this.logger.error('A job run could not be read.');
      throw new PlatformUnavailableError(error);
    }

    if (row.outcome !== 'found') throw new PlatformNotFoundError();
    return {
      id: row.id ?? '',
      jobName: row.jobName ?? '',
      status: (row.status ?? 'running') as JobRunStatus,
      scheduledFor: toIsoOrNull(row.scheduledFor),
      startedAt: toIso(row.startedAt ?? new Date(0)),
      finishedAt: toIsoOrNull(row.finishedAt),
      durationMs: toNumberOrNull(row.durationMs),
      errorType: row.errorType,
      errorSqlstate: row.errorSqlstate,
      detailJobKey: row.detailJobKey,
      processedCount: row.processedCount,
      isContracted: row.isContracted ?? false,
      cronSchedule: row.cronSchedule,
      targetSignature: row.targetSignature,
      purpose: row.purpose,
    };
  }

  /** Every contracted job, with the facts of its most recent run. */
  async scheduledJobs(input: { accessToken: string }): Promise<readonly ScheduledJob[]> {
    const staff = await this.#staff(input.accessToken);

    let rows: readonly ScheduledJobDbRow[];
    try {
      rows = await this.store.scheduledJobCatalogue({ userId: staff.id, isAal2: staff.isAal2 });
    } catch (error) {
      this.logger.error('The scheduled job catalogue could not be read.');
      throw new PlatformUnavailableError(error);
    }

    return rows.map((row) => ({
      jobKey: row.jobKey,
      cronSchedule: row.cronSchedule,
      targetSignature: row.targetSignature,
      purpose: row.purpose,
      runCount: toNumber(row.runCount),
      failureCount: toNumber(row.failureCount),
      lastStatus: row.lastStatus === null ? null : (row.lastStatus as JobRunStatus),
      lastStartedAt: toIsoOrNull(row.lastStartedAt),
      lastFinishedAt: toIsoOrNull(row.lastFinishedAt),
      lastDurationMs: toNumberOrNull(row.lastDurationMs),
      lastErrorType: row.lastErrorType,
      lastProcessedCount: row.lastProcessedCount,
    }));
  }

  /**
   * Where the real schedule and the contract disagree.
   *
   * An empty list is the good answer. It is also what a caller without the key gets, and the two are
   * indistinguishable on purpose — but the caller without the key never reaches here, because `#staff`
   * refuses first.
   */
  async scheduleProblems(input: { accessToken: string }): Promise<readonly ScheduleProblem[]> {
    const staff = await this.#staff(input.accessToken);

    try {
      const rows = await this.store.platformScheduleProblems({
        userId: staff.id,
        isAal2: staff.isAal2,
      });
      return rows.map((row) => ({ object: row.object, problem: row.problem }));
    } catch (error) {
      this.logger.error('The scheduled job guard could not be read.');
      throw new PlatformUnavailableError(error);
    }
  }

  /**
   * The outbox, as counts and ages, with its dead-letter groups.
   *
   * Two reads behind one permission, returned together because they are one screen and neither is meaningful
   * without the other: a dead-letter count with no breakdown says something is wrong and not what, and a
   * breakdown with no totals gives no sense of scale.
   */
  async outbox(input: {
    accessToken: string;
    limit: number;
  }): Promise<{ health: OutboxHealth; items: readonly OutboxDeadLetterGroup[] }> {
    const staff = await this.#staff(input.accessToken);

    let health: OutboxHealthDbRow;
    let groups: readonly OutboxDeadLetterDbRow[];
    try {
      [health, groups] = await Promise.all([
        this.store.outboxHealth({ userId: staff.id, isAal2: staff.isAal2 }),
        this.store.outboxDeadLetters({ userId: staff.id, isAal2: staff.isAal2, limit: input.limit }),
      ]);
    } catch (error) {
      this.logger.error('The outbox could not be read.');
      throw new PlatformUnavailableError(error);
    }

    // The aggregate reader states its refusal rather than returning a row of zeros, so this is a real
    // refusal and not a suspiciously empty outbox.
    if (health.outcome !== 'found') throw new PlatformNotFoundError();

    return {
      health: {
        pendingCount: toNumber(health.pendingCount ?? 0),
        dueCount: toNumber(health.dueCount ?? 0),
        inFlightCount: toNumber(health.inFlightCount ?? 0),
        completedCount: toNumber(health.completedCount ?? 0),
        deadLetteredCount: toNumber(health.deadLetteredCount ?? 0),
        oldestPendingAt: toIsoOrNull(health.oldestPendingAt),
        oldestInFlightAt: toIsoOrNull(health.oldestInFlightAt),
        latestDeadLetteredAt: toIsoOrNull(health.latestDeadLetteredAt),
        maxAttempts: health.maxAttempts,
      },
      items: groups.map((row) => ({
        eventType: row.eventType,
        lastErrorType: row.lastErrorType,
        eventCount: toNumber(row.eventCount),
        firstDeadLetteredAt: toIso(row.firstDeadLetteredAt),
        lastDeadLetteredAt: toIso(row.lastDeadLetteredAt),
        maxAttempts: row.maxAttempts,
      })),
    };
  }

  /* ---------------------------------------------------------------------------------------------- */

  /**
   * The caller, and the one key every route here needs.
   *
   * A colleague who does not hold it is answered exactly as a missing row is. The database will apply the same
   * test again with the key as a literal, so this is the first of two rather than the only one.
   */
  async #staff(accessToken: string): Promise<{ id: string; isAal2: boolean }> {
    const session = await this.console.forToken(accessToken);
    if (!session.permissions.includes(PLATFORM_JOB_READ)) throw new PlatformNotFoundError();
    return { id: session.id, isAal2: isAal2(accessToken) };
  }
}
