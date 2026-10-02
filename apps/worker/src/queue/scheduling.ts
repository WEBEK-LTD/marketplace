/**
 * The scheduler occurrence a repeatable job belongs to (Phase 8-A).
 *
 * A scheduled job run must be recorded once per **occurrence**, not once per attempt: 0007's
 * `job_runs_scheduled_once` unique index on `(job_name, scheduled_for)` is what makes a redelivery or a
 * retry of the same occurrence collapse into the one row it already has. That only works if
 * `scheduled_for` is the occurrence's own timestamp and is stable across retries.
 *
 * BullMQ gives it twice over, and both are stable because a retry re-runs the same job:
 *
 *   * `job.opts.prevMillis` — set by the job scheduler when it produces the delayed job;
 *   * `job.id` — `repeat:<schedulerId>:<millis>`, the id the scheduler derives from the same number.
 *
 * `prevMillis` is preferred and the id is the fallback, so neither one alone is load-bearing. A job that
 * carries neither is not a scheduled occurrence — an ordinary enqueued job, or a test double — and the
 * answer is `null` rather than an invented timestamp.
 */
const SCHEDULED_JOB_ID = /^repeat:.+:(\d+)$/;

export interface SchedulableJob {
  readonly id?: string | null;
  readonly opts?: { readonly prevMillis?: number } | undefined;
}

export function scheduledOccurrence(job: SchedulableJob): Date | null {
  const millis = job.opts?.prevMillis;
  if (typeof millis === 'number' && Number.isFinite(millis) && millis > 0) {
    return new Date(millis);
  }
  const match = typeof job.id === 'string' ? SCHEDULED_JOB_ID.exec(job.id) : null;
  if (match === null) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? new Date(parsed) : null;
}
