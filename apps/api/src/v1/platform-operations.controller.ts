import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import {
  JOB_NAME_PATTERN,
  PLATFORM_DEAD_LETTER_LIMIT,
  PLATFORM_OPS_DEFAULT_LIMIT,
  PLATFORM_OPS_MAX_LIMIT,
  SESSION_TOKEN_HEADER,
  parseMessagingLimit,
  type JobRunDetailResponse,
  type JobRunPageResponse,
  type OutboxResponse,
  type ScheduleProblemsResponse,
  type ScheduledJobCatalogueResponse,
} from '@repo/contracts';
import { AuthenticationRequiredError } from '../auth/auth-errors.js';
import { PlatformOperationsService } from '../admin/platform-operations.service.js';
import { RequestValidationException } from '../common/request-validation.exception.js';

/** Fastify's request, reduced to the one thing these routes read. */
interface PlatformRequestContext {
  readonly headers: Record<string, unknown>;
}

function header(request: PlatformRequestContext, name: string): string | null {
  const value = request.headers[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Platform job runs and outbox health (Phase 7-Q).
 *
 * ---------------------------------------------------------------------------------------------------
 * **FIVE OPERATIONS, AND EVERY ONE OF THEM IS A `GET`.**
 *
 * There is no `@Post`, no `@Patch`, no `@Put` and no `@Delete` on this controller, and no `@Body` anywhere in
 * it. That is not an omission: the workers own every write to a job run and to an outbox event
 * (`start_job_run`, `finish_job_run`, `claim_outbox_events`, `complete_outbox_event`,
 * `sweep_outbox_events`, `dead_letter_outbox_event` — all granted to `app_worker`), and this repository has no
 * authoritative writer for retrying an event, cancelling a run, requeueing a dead letter or re-running a job.
 *
 * Offering any of those would mean this controller deciding what a console may do to a live queue while money
 * and notifications depend on it. Each is an owner decision followed by a writer, in that order.
 * ---------------------------------------------------------------------------------------------------
 *
 * **One key for all five**, and it is the narrowest in the console: `platform.job.read`, held by Admin and
 * Super Admin alone. The caller's account and assurance level come from their own session, resolved inside the
 * service through `StaffConsoleService.forToken` and then `isAal2` on that same now-validated token, in that
 * order. No route takes an actor, a role, a permission key or an assurance level, and since no route takes a
 * body at all, none could. No role name is checked anywhere.
 *
 * **A run is addressed by its id**, which is what `job_runs` calls a run and what a holder of the key
 * legitimately holds. The shape is checked here so nothing that is not an identifier reaches a parameter
 * binding — but what authorizes the read is the permission and the assurance level, tested in the database
 * before any row is reached, never the shape of the identifier.
 *
 * **The controller decides nothing.** The four statuses, the four event states, the newest-first order, the
 * limit clamp, whether a run's key is still contracted, and what counts as a schedule problem are all decided
 * in the database — in migration 0081 and in the 0007 and 0032 definitions it reads. Restating any of them
 * here would be a second copy of a rule.
 *
 * **The raw error message cannot reach this file.** `job_runs.details` holds `left(sqlerrm, 500)` under a
 * `message` key; the database functions read the SQLSTATE and the job key out of that object and nothing else,
 * so there is no response field here through which the text could travel.
 */
@Controller('v1/admin/platform')
export class PlatformOperationsController {
  constructor(private readonly platform: PlatformOperationsService) {}

  /** One page of recorded runs, newest first. */
  @Get('job-runs')
  async runs(
    @Req() request: PlatformRequestContext,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('status') status?: string,
    @Query('jobName') jobName?: string,
  ): Promise<JobRunPageResponse> {
    const page = await this.platform.runs({
      accessToken: this.token(request),
      limit: this.limit(limit),
      // Passed through as text. The database compares each as a parameter, so an unknown value matches
      // nothing rather than being refused — which is the reader's own documented behaviour and means a stale
      // filter in a bookmark shows an empty page instead of an error.
      status: this.optional(status),
      jobName: this.jobName(jobName),
      cursor: this.optional(cursor),
    });
    return { items: [...page.items], nextCursor: page.nextCursor };
  }

  /** One run, with the contract row it belongs to. */
  @Get('job-runs/:runId')
  async run(
    @Req() request: PlatformRequestContext,
    @Param('runId') runId: string,
  ): Promise<JobRunDetailResponse> {
    const run = await this.platform.run({
      accessToken: this.token(request),
      runId: this.identifier(runId, 'runId'),
    });
    return { run };
  }

  /** The whole scheduled-job contract, with each job's last run. */
  @Get('scheduled-jobs')
  async scheduledJobs(
    @Req() request: PlatformRequestContext,
  ): Promise<ScheduledJobCatalogueResponse> {
    const items = await this.platform.scheduledJobs({ accessToken: this.token(request) });
    return { items: [...items] };
  }

  /**
   * Where the real schedule and the contract disagree.
   *
   * An empty list is the good answer, and it is the expected one.
   */
  @Get('schedule-problems')
  async scheduleProblems(
    @Req() request: PlatformRequestContext,
  ): Promise<ScheduleProblemsResponse> {
    const items = await this.platform.scheduleProblems({ accessToken: this.token(request) });
    return { items: [...items] };
  }

  /**
   * The outbox as counts and ages, with its dead-letter groups.
   *
   * One response rather than two, because they are one screen: a dead-letter count with no breakdown says
   * something is wrong and not what, and a breakdown with no totals gives no sense of scale. The group page is
   * fixed — the grouping is short by construction and is not paged.
   */
  @Get('outbox')
  async outbox(
    @Req() request: PlatformRequestContext,
  ): Promise<OutboxResponse> {
    const { health, items } = await this.platform.outbox({
      accessToken: this.token(request),
      limit: PLATFORM_DEAD_LETTER_LIMIT,
    });
    return { health, items: [...items] };
  }

  /* ---------------------------------------------------------------------------------------------- */

  /** The caller's own session token. A request without one never reaches a reader. */
  private token(request: PlatformRequestContext): string {
    const accessToken = header(request, SESSION_TOKEN_HEADER);
    if (accessToken === null || accessToken === '') throw new AuthenticationRequiredError();
    return accessToken;
  }

  private optional(value: string | undefined): string | null {
    return value === undefined || value === '' ? null : value;
  }

  private limit(value: string | undefined): number {
    const parsed = parseMessagingLimit(value, {
      fallback: PLATFORM_OPS_DEFAULT_LIMIT,
      maximum: PLATFORM_OPS_MAX_LIMIT,
    });
    if (!parsed.ok) {
      throw new RequestValidationException([{ path: 'limit', message: 'The limit is invalid.' }]);
    }
    return parsed.limit;
  }

  /**
   * The job-name filter, checked against the column's own format.
   *
   * `job_runs_name_format` constrains a job name to `^[a-z][a-z0-9_.]*$`, so anything else could not name a
   * run. It is refused rather than dropped, because a malformed name is a malformed request rather than a
   * stale bookmark — a *well-formed* name that matches nothing is the stale-bookmark case, and that one is
   * passed through and answered with an empty page.
   */
  private jobName(value: string | undefined): string | null {
    const text = this.optional(value);
    if (text === null) return null;
    if (text.length > 200 || !JOB_NAME_PATTERN.test(text)) {
      throw new RequestValidationException([{ path: 'jobName', message: 'The filter is invalid.' }]);
    }
    return text;
  }

  /**
   * The path parameter that names a run.
   *
   * Checked for shape here so a malformed identifier is a validation failure rather than a database error,
   * and so nothing that is not an identifier ever reaches a parameter binding.
   */
  private identifier(value: string, path: string): string {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
      throw new RequestValidationException([{ path, message: 'The identifier is invalid.' }]);
    }
    return value.toLowerCase();
  }
}
