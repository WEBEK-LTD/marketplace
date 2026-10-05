import { errorSummary, type WorkerLogger } from '../logging/logger.js';
import type { JobRunStatus, OutboxStore } from './outbox.store.js';

/**
 * Recording one scheduled execution in `job_runs` (Phase 8-A, F-4).
 *
 * v5.2: "Every job run is recorded in `job_runs`." The rule for 8-A is one row per **scheduled
 * occurrence** — not one row per event, and not one row per attempt — and 0007 already enforces exactly
 * that through `job_runs_scheduled_once`, its unique index on `(job_name, scheduled_for)`.
 *
 * So the mechanism is 0007's own and nothing is added: `start_job_run` returns the new run's id, or
 * **null** when that occurrence already has a row. Null means this execution is a retry or a
 * redelivery of an occurrence already recorded, and the work still runs — a retry exists because the
 * work has to happen — while the row stays as it is. One occurrence, one row, whatever the queue does
 * with its attempts.
 *
 * A consequence worth stating rather than hiding: when a first attempt fails and a later attempt
 * succeeds, the row keeps the first attempt's `failed` status, because 0007's `finish_job_run` only
 * settles a run that is still `running` and there is no reader that would hand a retry the earlier id.
 * The queue's own `job_failed_retrying` / `job_failed_final` lines carry the attempt-level story.
 *
 * Recording is never load-bearing. If `job_runs` cannot be written the tick still runs: losing a run
 * record is a reporting gap, and refusing to relay committed events over one would be an outage.
 */
export interface ScheduledRunResult<T> {
  readonly value: T;
  /** Null when this occurrence was already recorded, or when recording itself failed. */
  readonly runId: string | null;
}

export async function recordScheduledRun<T>(
  store: OutboxStore,
  jobName: string,
  scheduledFor: Date | null,
  logger: WorkerLogger,
  processed: (value: T) => number,
  work: () => Promise<T>,
): Promise<ScheduledRunResult<T>> {
  let runId: string | null = null;
  try {
    runId = await store.startJobRun(jobName, scheduledFor);
    if (runId === null) {
      logger.debug(
        { event: 'job_run_already_recorded', jobName },
        'This scheduled occurrence is already recorded; the work runs and no second row is written',
      );
    }
  } catch (error) {
    logger.warn({ event: 'job_run_start_failed', jobName, ...errorSummary(error) }, 'Could not open a job run');
  }

  let value: T;
  try {
    value = await work();
  } catch (error) {
    await settle(store, runId, 'failed', null, errorSummary(error).errorType, jobName, logger);
    throw error;
  }
  await settle(store, runId, 'succeeded', processed(value), null, jobName, logger);
  return { value, runId };
}

async function settle(
  store: OutboxStore,
  runId: string | null,
  status: JobRunStatus,
  processedCount: number | null,
  errorType: string | null,
  jobName: string,
  logger: WorkerLogger,
): Promise<void> {
  if (runId === null) return;
  try {
    await store.finishJobRun(runId, status, processedCount, errorType);
  } catch (error) {
    logger.warn({ event: 'job_run_finish_failed', jobName, ...errorSummary(error) }, 'Could not close a job run');
  }
}
