import { Queue, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { errorSummary, type WorkerLogger } from '../logging/logger.js';
import { assertIdPayload, type IdPayload } from './payload.js';
import { DEAD_LETTER_RETENTION_MS, deadLetterQueueName, QUEUE_PREFIX } from './policy.js';

/** What a dead-letter entry contains: IDs and metadata only, never error text or stacks. */
export interface DeadLetterEntry {
  readonly sourceQueue: string;
  readonly jobId: string;
  readonly jobName: string;
  readonly attempts: number;
  readonly data: IdPayload | Record<string, never>;
  readonly errorType: string;
}

export class DeadLetterQueue {
  readonly queue: Queue;
  private readonly logger: WorkerLogger;

  constructor(
    private readonly sourceQueue: string,
    connection: Redis,
    parentLogger: WorkerLogger,
    private readonly retentionMs: number = DEAD_LETTER_RETENTION_MS,
  ) {
    this.logger = parentLogger.child({ module: 'queue' });
    this.queue = new Queue(deadLetterQueueName(sourceQueue), { connection, prefix: QUEUE_PREFIX });
    this.queue.on('error', (error: unknown) => {
      this.logger.warn({ event: 'dead_letter_queue_error', queue: sourceQueue, ...errorSummary(error) }, 'Dead-letter queue error');
    });
  }

  /** Stores the entry (idempotent per source job), raises the alert, then removes the failed job. */
  async moveToDeadLetter(job: Job, error: unknown): Promise<void> {
    let data: DeadLetterEntry['data'] = {};
    try {
      assertIdPayload(job.data);
      data = job.data;
    } catch {
      data = {};
    }
    const entry: DeadLetterEntry = {
      sourceQueue: this.sourceQueue,
      jobId: String(job.id),
      jobName: job.name,
      attempts: job.attemptsMade,
      data,
      errorType: errorSummary(error).errorType,
    };
    await this.queue.add('dead-letter', entry, {
      jobId: `dead-letter-${entry.jobId}`,
      removeOnComplete: false,
      removeOnFail: false,
    });
    this.logger.error(
      { event: 'dead_letter', sourceQueue: entry.sourceQueue, jobId: entry.jobId, jobName: entry.jobName, attempts: entry.attempts, errorType: entry.errorType },
      'Job moved to dead-letter queue',
    );
    await job.remove();
  }

  /** Deletes dead-letter entries older than the retention period (14 days). */
  async purgeExpired(): Promise<number> {
    const removed = await this.queue.clean(this.retentionMs, 10_000, 'wait');
    return removed.length;
  }

  close(): Promise<void> {
    return this.queue.close();
  }
}
