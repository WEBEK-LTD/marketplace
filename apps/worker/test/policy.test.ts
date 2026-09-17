import { describe, expect, it } from 'vitest';
import {
  BACKOFF_BASE_MS,
  BACKOFF_JITTER,
  backoffDelay,
  COMPLETED_RETENTION_COUNT,
  COMPLETED_RETENTION_SECONDS,
  DEAD_LETTER_RETENTION_MS,
  deadLetterQueueName,
  DEFAULT_JOB_OPTIONS,
  MAX_ATTEMPTS,
  QUEUE_PREFIX,
} from '../src/queue/policy.js';
import { reconnectDelay } from '../src/redis/connection.js';

describe('retry policy', () => {
  it('uses 5 attempts with exponential backoff from 1 s', () => {
    expect(MAX_ATTEMPTS).toBe(5);
    expect(BACKOFF_BASE_MS).toBe(1_000);
    expect([1, 2, 3, 4].map((attempt) => backoffDelay(attempt, () => 0))).toEqual([1_000, 2_000, 4_000, 8_000]);
  });

  it('applies jitter deterministically within the documented bounds', () => {
    expect(BACKOFF_JITTER).toBe(0.2);
    expect([1, 2, 3, 4].map((attempt) => backoffDelay(attempt, () => 1))).toEqual([800, 1_600, 3_200, 6_400]);
    expect(backoffDelay(2, () => 0.5)).toBe(1_800);
    for (let i = 0; i < 1_000; i += 1) {
      const attempt = 1 + (i % 4);
      const delay = backoffDelay(attempt);
      const nominal = 1_000 * 2 ** (attempt - 1);
      expect(delay).toBeGreaterThanOrEqual(nominal * 0.8);
      expect(delay).toBeLessThanOrEqual(nominal);
    }
  });

  it('clamps out-of-range random values', () => {
    expect(backoffDelay(1, () => -5)).toBe(1_000);
    expect(backoffDelay(1, () => 7)).toBe(800);
  });

  it('sets the approved default job options', () => {
    expect(DEFAULT_JOB_OPTIONS).toEqual({
      attempts: 5,
      backoff: { type: 'jittered-exponential' },
      removeOnComplete: { age: 86_400, count: 1_000 },
      removeOnFail: false,
    });
    expect(COMPLETED_RETENTION_SECONDS).toBe(24 * 3600);
    expect(COMPLETED_RETENTION_COUNT).toBe(1_000);
    expect(DEAD_LETTER_RETENTION_MS).toBe(14 * 24 * 3600 * 1000);
  });
});

describe('queue naming', () => {
  it('uses the queue prefix and <queue>-dead-letter names', () => {
    expect(QUEUE_PREFIX).toBe('queue');
    expect(deadLetterQueueName('emails')).toBe('emails-dead-letter');
  });

  it.each(['', 'Has-Upper', 'with:colon', '-leading', 'x-dead-letter', 'space name'])('rejects queue name %j', (name) => {
    expect(() => deadLetterQueueName(name)).toThrow(TypeError);
  });
});

describe('Redis reconnect backoff', () => {
  it('is capped at 5 seconds and never gives up', () => {
    expect([1, 2, 10, 25, 26, 1000].map(reconnectDelay)).toEqual([200, 400, 2_000, 5_000, 5_000, 5_000]);
  });
});
