import { describe, expect, it } from 'vitest';
import { hashIdentifier } from '../src/auth/subject-hash.js';
import { SELLER_THROTTLE_BUCKETS } from '../src/sellers/seller-throttle.service.js';
import {
  SUPPORT_THROTTLE_BUCKETS,
  SupportThrottleService,
} from '../src/support/support-throttle.service.js';
import { SupportThrottledError } from '../src/support/support.errors.js';

/**
 * The support rate limits, at the service itself (Phase 7-K, owner Decision 1).
 *
 * The HTTP tests prove the limits where they are enforced; these prove the mechanism in isolation, without
 * Nest and without a request, so a boundary is unambiguous:
 *
 *   * the three approved numbers, exactly, and no fourth bucket;
 *   * a limit of *n* allows *n* and refuses *n + 1*;
 *   * both message windows are counted even once the first has rejected;
 *   * two accounts have two counters, and the key is a hash rather than an account;
 *   * Redis first, the durable counter as the fallback, and a refusal when neither can answer.
 */

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

interface Call {
  readonly bucket: string;
  readonly subject: string;
  readonly windowSeconds: number;
  readonly limit: number;
}

/** A fixed-window counter, per (bucket, subject) pair — which is what the database's own one is. */
function counter(calls: Call[], options: { throws?: boolean; counting?: boolean } = {}) {
  const counts = new Map<string, number>();
  return {
    hit: async (bucket: string, subject: Buffer, windowSeconds: number, limit: number) => {
      calls.push({ bucket, subject: subject.toString('hex'), windowSeconds, limit });
      if (options.throws === true) throw new Error('counter unavailable');
      if (options.counting !== true) return true;
      const key = `${bucket}:${subject.toString('hex')}`;
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next <= limit;
    },
  };
}

function service(
  redis: ReturnType<typeof counter> | null,
  durable: ReturnType<typeof counter>,
): SupportThrottleService {
  return new SupportThrottleService(redis, durable);
}

describe('the approved numbers', () => {
  it('is exactly the three buckets Decision 1 names, and no storage bucket', () => {
    expect(SUPPORT_THROTTLE_BUCKETS).toEqual({
      openTicket: { name: 'support_ticket_open', limit: 5, windowSeconds: 86_400 },
      messageMinute: { name: 'support_message_minute', limit: 30, windowSeconds: 60 },
      messageHour: { name: 'support_message_hour', limit: 300, windowSeconds: 3600 },
    });
    expect(Object.keys(SUPPORT_THROTTLE_BUCKETS)).toHaveLength(3);
    expect(JSON.stringify(SUPPORT_THROTTLE_BUCKETS)).not.toContain('attachment');
    expect(JSON.stringify(SUPPORT_THROTTLE_BUCKETS)).not.toContain('upload');
  });

  it('leaves the attachment allowance to 6-E’s own bucket, unchanged', () => {
    expect(SELLER_THROTTLE_BUCKETS.mediaUpload).toEqual({
      name: 'seller_media_upload',
      limit: 20,
      windowSeconds: 3600,
    });
  });

  it('names buckets 0004’s own column constraint accepts, so no migration is needed', () => {
    for (const bucket of Object.values(SUPPORT_THROTTLE_BUCKETS)) {
      expect(bucket.name, bucket.name).toMatch(/^[a-z][a-z0-9_.]*$/);
    }
  });
});

describe('enforcement and boundaries', () => {
  it('allows five ticket openings and refuses the sixth', async () => {
    const calls: Call[] = [];
    const throttle = service(counter(calls, { counting: true }), counter([], { counting: true }));
    const subject = hashIdentifier(ACCOUNT);

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await expect(throttle.assertCanOpenTicket(subject)).resolves.toBeUndefined();
    }
    await expect(throttle.assertCanOpenTicket(subject)).rejects.toBeInstanceOf(SupportThrottledError);
    expect(calls).toHaveLength(6);
    expect(calls.every((call) => call.bucket === 'support_ticket_open')).toBe(true);
  });

  it('allows thirty messages in the minute window and refuses the thirty-first', async () => {
    const calls: Call[] = [];
    const throttle = service(counter(calls, { counting: true }), counter([], { counting: true }));
    const subject = hashIdentifier(ACCOUNT);

    for (let attempt = 1; attempt <= 30; attempt += 1) {
      await expect(throttle.assertCanPostMessage(subject)).resolves.toBeUndefined();
    }
    await expect(throttle.assertCanPostMessage(subject)).rejects.toBeInstanceOf(SupportThrottledError);
  });

  it('names the bucket that rejected on the error, for the log and never for a response', async () => {
    const throttle = service(counter([], { counting: true }), counter([], { counting: true }));
    const subject = hashIdentifier(ACCOUNT);
    for (let attempt = 1; attempt <= 5; attempt += 1) await throttle.assertCanOpenTicket(subject);

    await throttle.assertCanOpenTicket(subject).then(
      () => expect.fail('the sixth attempt should have been refused'),
      (error: unknown) => {
        expect(error).toBeInstanceOf(SupportThrottledError);
        expect((error as SupportThrottledError).bucket).toBe('support_ticket_open');
        expect((error as SupportThrottledError).problem).toEqual({ status: 429, code: 'THROTTLED' });
        // The sentence a client sees says nothing about which window it was.
        expect((error as SupportThrottledError).message).toBe('Too many requests.');
      },
    );
  });

  it('counts both message windows on every attempt, refused ones included', async () => {
    const calls: Call[] = [];
    const throttle = service(counter(calls, { counting: true }), counter([], { counting: true }));
    const subject = hashIdentifier(ACCOUNT);

    for (let attempt = 1; attempt <= 31; attempt += 1) {
      await throttle.assertCanPostMessage(subject).catch(() => undefined);
    }
    expect(calls.filter((call) => call.bucket === 'support_message_minute')).toHaveLength(31);
    expect(calls.filter((call) => call.bucket === 'support_message_hour')).toHaveLength(31);
  });

  it('refuses the three-hundred-and-first message in an hour even across fresh minutes', async () => {
    // One counter object per minute window would reset the minute bucket; the hourly one must not reset.
    const calls: Call[] = [];
    const counts = new Map<string, number>();
    const hourlyOnly = {
      hit: async (bucket: string, subject: Buffer, windowSeconds: number, limit: number) => {
        calls.push({ bucket, subject: subject.toString('hex'), windowSeconds, limit });
        if (bucket === 'support_message_minute') return true; // a fresh minute every time
        const key = `${bucket}:${subject.toString('hex')}`;
        const next = (counts.get(key) ?? 0) + 1;
        counts.set(key, next);
        return next <= limit;
      },
    };
    const throttle = service(hourlyOnly, counter([]));
    const subject = hashIdentifier(ACCOUNT);

    for (let attempt = 1; attempt <= 300; attempt += 1) {
      await expect(throttle.assertCanPostMessage(subject), `attempt ${attempt}`).resolves.toBeUndefined();
    }
    await expect(throttle.assertCanPostMessage(subject)).rejects.toBeInstanceOf(SupportThrottledError);
  });

  it('does not let a repeated attempt past a limit already reached', async () => {
    const throttle = service(counter([], { counting: true }), counter([], { counting: true }));
    const subject = hashIdentifier(ACCOUNT);
    for (let attempt = 1; attempt <= 5; attempt += 1) await throttle.assertCanOpenTicket(subject);
    for (const attempt of [6, 7, 8, 9]) {
      await expect(throttle.assertCanOpenTicket(subject), `attempt ${attempt}`).rejects.toBeInstanceOf(
        SupportThrottledError,
      );
    }
  });
});

describe('per-account isolation', () => {
  it('gives two accounts two counters', async () => {
    const calls: Call[] = [];
    const throttle = service(counter(calls, { counting: true }), counter([], { counting: true }));

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await throttle.assertCanOpenTicket(hashIdentifier(ACCOUNT));
    }
    await expect(throttle.assertCanOpenTicket(hashIdentifier(ACCOUNT))).rejects.toBeInstanceOf(
      SupportThrottledError,
    );
    // The other account is untouched by the first one's exhaustion.
    await expect(throttle.assertCanOpenTicket(hashIdentifier(OTHER))).resolves.toBeUndefined();

    expect(new Set(calls.map((call) => call.subject)).size).toBe(2);
  });

  it('keys a counter by a hash, so the counter store holds no account identifier', async () => {
    const calls: Call[] = [];
    const throttle = service(counter(calls), counter([]));
    await throttle.assertCanOpenTicket(hashIdentifier(ACCOUNT));

    expect(calls[0]!.subject).toMatch(/^[0-9a-f]{64}$/);
    expect(calls[0]!.subject).not.toContain(ACCOUNT.replace(/-/g, ''));
    expect(hashIdentifier(ACCOUNT).toString('hex')).toBe(calls[0]!.subject);
    expect(hashIdentifier(OTHER).toString('hex')).not.toBe(calls[0]!.subject);
  });

  it('keeps the two message windows and the ticket window apart', async () => {
    const calls: Call[] = [];
    const throttle = service(counter(calls, { counting: true }), counter([], { counting: true }));
    const subject = hashIdentifier(ACCOUNT);

    for (let attempt = 1; attempt <= 5; attempt += 1) await throttle.assertCanOpenTicket(subject);
    await expect(throttle.assertCanOpenTicket(subject)).rejects.toBeInstanceOf(SupportThrottledError);
    // Opening is exhausted; messaging is not.
    await expect(throttle.assertCanPostMessage(subject)).resolves.toBeUndefined();
  });
});

describe('failing closed', () => {
  it('uses the durable counter when Redis cannot answer, continuing the same window', async () => {
    const redisCalls: Call[] = [];
    const durableCalls: Call[] = [];
    const throttle = service(
      counter(redisCalls, { throws: true }),
      counter(durableCalls, { counting: true }),
    );
    const subject = hashIdentifier(ACCOUNT);

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await expect(throttle.assertCanOpenTicket(subject), `attempt ${attempt}`).resolves.toBeUndefined();
    }
    await expect(throttle.assertCanOpenTicket(subject)).rejects.toBeInstanceOf(SupportThrottledError);
    expect(redisCalls).toHaveLength(6);
    expect(durableCalls).toHaveLength(6);
  });

  it('works with no Redis counter configured at all', async () => {
    const durableCalls: Call[] = [];
    const throttle = service(null, counter(durableCalls, { counting: true }));
    await expect(throttle.assertCanOpenTicket(hashIdentifier(ACCOUNT))).resolves.toBeUndefined();
    expect(durableCalls).toHaveLength(1);
  });

  it('refuses rather than allows when neither counter can answer', async () => {
    const throttle = service(counter([], { throws: true }), counter([], { throws: true }));
    // Not a SupportThrottledError: an unreadable counter is an enforcement outage, which the API answers
    // as 503 rather than as a limit the caller could wait out.
    await expect(throttle.assertCanOpenTicket(hashIdentifier(ACCOUNT))).rejects.not.toBeInstanceOf(
      SupportThrottledError,
    );
    await expect(throttle.assertCanPostMessage(hashIdentifier(ACCOUNT))).rejects.toThrow();
  });
});
