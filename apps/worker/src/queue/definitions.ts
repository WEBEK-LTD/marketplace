import type { IdPayload } from './payload.js';

/**
 * A repeatable schedule owned by a queue definition.
 *
 * v5.2 lists "repeatable jobs" among the worker's approved responsibilities; this is how a definition
 * declares one. The template payload obeys the same IDs-only rule as every other job, and the scheduler
 * id is stable so restarting the worker updates the schedule in place rather than accumulating copies.
 */
export interface QueueSchedule {
  readonly jobName: string;
  readonly schedulerId: string;
  readonly everyMs: number;
  readonly data: IdPayload;
}

/**
 * How a definition puts work on another queue (Phase 8-A).
 *
 * Only the runtime owns Redis, so a definition that publishes — the outbox relay is the first — receives
 * this port when the runtime attaches it, rather than building a queue client of its own. Payloads go
 * through the same IDs-only assertion as any enqueued job.
 */
export interface QueuePublisher {
  publish(queue: string, jobName: string, data: IdPayload): Promise<string>;
}

/** One job as a definition sees it. */
export interface QueueJob {
  readonly id: string;
  readonly name: string;
  readonly data: IdPayload;
  /**
   * The scheduler occurrence this job belongs to, for a job produced by a repeatable schedule, and
   * `null` for anything else. Stable across retries of the same occurrence.
   */
  readonly scheduledFor: Date | null;
}

/** A queue processed by this worker. Business queues are added in later phases. */
export interface QueueDefinition {
  readonly name: string;
  /** Present when the queue is driven by a timer rather than by something enqueueing work. */
  readonly schedule?: QueueSchedule;
  /** Called once, before the workers start, for a definition that publishes to other queues. */
  attach?(publisher: QueuePublisher): void;
  process(job: QueueJob): Promise<void>;
  /**
   * Called when a job has exhausted its attempts, alongside the ordinary dead-letter entry.
   *
   * The outbox uses it to stop re-publishing a poison event; a definition with nothing to settle
   * outside the queue leaves it undefined. A throw here is logged and never replaces the dead-letter
   * entry, which is stored either way.
   */
  onFinalFailure?(job: QueueJob, errorType: string): Promise<void>;
}

export const QUEUE_DEFINITIONS = Symbol('QUEUE_DEFINITIONS');
