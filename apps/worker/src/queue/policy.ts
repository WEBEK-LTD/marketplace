import type { JobsOptions } from 'bullmq';

/** Every queue key starts with this prefix; other Redis concerns get their own prefixes later. */
export const QUEUE_PREFIX = 'queue';

export const MAX_ATTEMPTS = 5;
export const BACKOFF_BASE_MS = 1_000;
/** Jitter shortens each delay by up to 20 %: attempt 1 waits 0.8–1 s, attempt 4 waits 6.4–8 s. */
export const BACKOFF_JITTER = 0.2;
export const BACKOFF_TYPE = 'jittered-exponential';

export const COMPLETED_RETENTION_SECONDS = 24 * 60 * 60;
export const COMPLETED_RETENTION_COUNT = 1_000;
export const DEAD_LETTER_RETENTION_MS = 14 * 24 * 60 * 60 * 1_000;
export const DEAD_LETTER_SUFFIX = '-dead-letter';

/** Nominal 1 s, 2 s, 4 s, 8 s for attempts 1–4, reduced by up to BACKOFF_JITTER. */
export function backoffDelay(attemptsMade: number, random: () => number = Math.random): number {
  const nominal = BACKOFF_BASE_MS * 2 ** Math.max(0, attemptsMade - 1);
  const r = Math.min(Math.max(random(), 0), 1);
  return Math.round(nominal * (1 - BACKOFF_JITTER * r));
}

export const DEFAULT_JOB_OPTIONS: JobsOptions = Object.freeze({
  attempts: MAX_ATTEMPTS,
  backoff: { type: BACKOFF_TYPE },
  removeOnComplete: { age: COMPLETED_RETENTION_SECONDS, count: COMPLETED_RETENTION_COUNT },
  // Failed jobs are removed by the worker once their dead-letter entry is stored.
  removeOnFail: false,
});

export function assertQueueName(name: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name) || name.endsWith(DEAD_LETTER_SUFFIX)) {
    throw new TypeError(`Invalid queue name: ${name}`);
  }
}

export function deadLetterQueueName(name: string): string {
  assertQueueName(name);
  return `${name}${DEAD_LETTER_SUFFIX}`;
}
