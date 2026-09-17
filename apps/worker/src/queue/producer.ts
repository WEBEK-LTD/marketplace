import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { assertIdPayload, type IdPayload } from './payload.js';
import { assertQueueName, DEFAULT_JOB_OPTIONS, QUEUE_PREFIX } from './policy.js';

/** Creates a queue that applies the default retry/retention policy and the IDs-only rule. */
export function createProducer(name: string, connection: Redis) {
  assertQueueName(name);
  const queue = new Queue(name, { connection, prefix: QUEUE_PREFIX, defaultJobOptions: DEFAULT_JOB_OPTIONS });
  // Connection errors surface to the caller through failed enqueue calls; do not print them.
  queue.on('error', () => undefined);
  return {
    queue,
    async enqueue(jobName: string, data: IdPayload, jobId?: string): Promise<string> {
      assertIdPayload(data);
      const job = await queue.add(jobName, data, jobId === undefined ? {} : { jobId });
      return String(job.id);
    },
    close: () => queue.close(),
  };
}
