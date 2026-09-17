import type { IdPayload } from './payload.js';

/** A queue processed by this worker. Business queues are added in later phases. */
export interface QueueDefinition {
  readonly name: string;
  process(job: { readonly id: string; readonly name: string; readonly data: IdPayload }): Promise<void>;
}

export const QUEUE_DEFINITIONS = Symbol('QUEUE_DEFINITIONS');
