import type { WorkerLogger } from '../logging/logger.js';
import type { QueueDefinition, QueueJob, QueueSchedule } from '../queue/definitions.js';
import type { IdPayload } from '../queue/payload.js';
import type { OutboxStore } from './outbox.store.js';
import { recordScheduledRun } from './scheduled-run.js';

/**
 * The outbox sweeper (Phase 8-A).
 *
 * Step 7 of the approved O-10 flow: "the sweeper re-publishes events with no recorded completion after
 * a threshold". It calls 0007's `sweep_outbox_events` and decides nothing: the function returns
 * published-but-uncompleted events to the pending state by clearing `published_at` and setting
 * `available_at = now()`, and the relay picks them up on its next tick like any other pending event.
 *
 * **An unhandled event can never reach this job.** `sweep_outbox_events` requires `published_at is not
 * null`, and only the relay sets that column — on events whose type a handler is registered for. So an
 * event with no handler stays pending and is structurally outside the sweep, which is what makes "no
 * handler = no repeated claim/sweep/dead-letter" a property of the schema rather than a promise made in
 * application code.
 */

export const OUTBOX_SWEEPER_QUEUE = 'outbox-sweeper';
export const OUTBOX_SWEEPER_JOB = 'sweep';
export const OUTBOX_SWEEPER_SCHEDULER_ID = 'outbox-sweeper';

/** `job_runs.job_name`, per 0007's `^[a-z][a-z0-9_.]*$`. */
export const OUTBOX_SWEEPER_JOB_NAME = 'outbox.sweeper';

export const OUTBOX_SWEEPER_ID = '8a000000-0000-4000-8000-000000000002';
export const OUTBOX_SWEEPER_PAYLOAD: IdPayload = Object.freeze({ sweeperId: OUTBOX_SWEEPER_ID });

/**
 * How long an event may sit published without a completion, and how many are returned per sweep.
 *
 * Both are `sweep_outbox_events`'s own defaults, exactly as the batch size is the claim's own. Nothing
 * here chooses a duration.
 */
export const OUTBOX_SWEEP_STALE_AFTER = '5 minutes';
export const OUTBOX_SWEEP_BATCH_SIZE = 100;

export class OutboxSweeperQueue implements QueueDefinition {
  readonly name = OUTBOX_SWEEPER_QUEUE;
  readonly schedule: QueueSchedule;

  constructor(
    private readonly store: OutboxStore,
    private readonly logger: WorkerLogger,
    intervalMs: number,
    private readonly staleAfter: string = OUTBOX_SWEEP_STALE_AFTER,
    private readonly batchSize: number = OUTBOX_SWEEP_BATCH_SIZE,
  ) {
    this.schedule = {
      jobName: OUTBOX_SWEEPER_JOB,
      schedulerId: OUTBOX_SWEEPER_SCHEDULER_ID,
      everyMs: intervalMs,
      data: OUTBOX_SWEEPER_PAYLOAD,
    };
  }

  async process(job: QueueJob): Promise<void> {
    await recordScheduledRun(
      this.store,
      OUTBOX_SWEEPER_JOB_NAME,
      job.scheduledFor,
      this.logger,
      (swept: number) => swept,
      () => this.sweep(),
    );
  }

  async sweep(): Promise<number> {
    const swept = await this.store.sweep(this.staleAfter, this.batchSize);
    if (swept > 0) {
      this.logger.info({ event: 'outbox_sweep_tick', swept }, 'Outbox sweeper returned stale events to pending');
    }
    return swept;
  }
}
