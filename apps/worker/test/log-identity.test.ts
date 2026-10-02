import { PseudonymousUserId } from '@repo/server-config';
import { currentLogIdentity } from '@repo/telemetry';
import { afterEach, describe, expect, it } from 'vitest';
import { createProducer } from '../src/queue/producer.js';
import { startRedis } from './support/redis-server.js';
import { createTestRuntime, ID_A, ID_B, inspector, waitUntil } from './support/runtime.js';

/**
 * The pseudonymous user ID in worker job logs (C-13, O8-12).
 *
 * The worker's half of the decision is that one person reads the same in both services, so the test
 * that matters compares a worker-derived value against an independently derived one using the same key.
 * The other half is restraint: a job that carries no user identity gets no identity field, because a
 * placeholder in an identity column is worse than a gap.
 */

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

describe('the pseudonymous user ID in worker logs', () => {
  it('derives the job’s user identically to the API, from the job payload', async () => {
    const server = await startRedis();
    cleanup.push(() => server.stop());

    const seen: Array<string | undefined> = [];
    const t = await createTestRuntime(server.url, [
      {
        name: 'identity-present',
        process: async () => {
          // What the job's own log lines would carry.
          seen.push(currentLogIdentity());
        },
      },
    ]);
    cleanup.push(() => t.runtime.stop().then(() => undefined));
    await t.runtime.start();

    const producer = createProducer('identity-present', inspector(server.url));
    await producer.enqueue('probe', { userId: ID_A, orderId: ID_B });
    await waitUntil(() => seen.length > 0);
    await producer.close();

    // The same key the runtime was configured with, applied independently. This is the cross-service
    // guarantee: the API derives the same string for the same person.
    const expected = new PseudonymousUserId(t.env.pseudonymousUserIdKey).derive(ID_A);
    expect(seen[0]).toBe(expected);
    expect(expected.startsWith('usr_')).toBe(true);
  });

  it('writes the identity onto the job’s log lines, and never the raw UUID', async () => {
    const server = await startRedis();
    cleanup.push(() => server.stop());

    const t = await createTestRuntime(server.url, [
      {
        name: 'identity-logged',
        process: async () => {
          t.logger.info({ event: 'probe_line' }, 'inside the job');
        },
      },
    ]);
    cleanup.push(() => t.runtime.stop().then(() => undefined));
    await t.runtime.start();

    const producer = createProducer('identity-logged', inspector(server.url));
    await producer.enqueue('probe', { userId: ID_A });
    await waitUntil(() => t.logs().some((line) => line['event'] === 'probe_line'));
    await producer.close();

    const expected = new PseudonymousUserId(t.env.pseudonymousUserIdKey).derive(ID_A);
    const probe = t.logs().find((line) => line['event'] === 'probe_line');
    expect(probe?.['user_pseudo_id']).toBe(expected);
    expect(probe?.['module']).toBe('runtime');
    for (const line of t.lines) {
      expect(line).not.toContain(ID_A);
      expect(line).not.toContain(t.env.pseudonymousUserIdKey);
    }
  });

  it('omits the field entirely for a job that carries no user', async () => {
    const server = await startRedis();
    cleanup.push(() => server.stop());

    const seen: Array<string | undefined> = [];
    const t = await createTestRuntime(server.url, [
      { name: 'identity-absent', process: async () => void seen.push(currentLogIdentity()) },
    ]);
    cleanup.push(() => t.runtime.stop().then(() => undefined));
    await t.runtime.start();

    const producer = createProducer('identity-absent', inspector(server.url));
    await producer.enqueue('probe', { orderId: ID_B });
    await waitUntil(() => seen.length > 0);
    await producer.close();

    expect(seen[0]).toBeUndefined();
    for (const line of t.logs()) expect(line['user_pseudo_id']).toBeUndefined();
  });

  it('does not leak one job’s identity into the next', async () => {
    const server = await startRedis();
    cleanup.push(() => server.stop());

    const seen: Array<string | undefined> = [];
    const t = await createTestRuntime(server.url, [
      { name: 'identity-sequence', process: async () => void seen.push(currentLogIdentity()) },
    ]);
    cleanup.push(() => t.runtime.stop().then(() => undefined));
    await t.runtime.start();

    const producer = createProducer('identity-sequence', inspector(server.url));
    await producer.enqueue('with-user', { userId: ID_A });
    await waitUntil(() => seen.length === 1);
    await producer.enqueue('without-user', { orderId: ID_B });
    await waitUntil(() => seen.length === 2);
    await producer.close();

    const expected = new PseudonymousUserId(t.env.pseudonymousUserIdKey).derive(ID_A);
    expect(seen).toEqual([expected, undefined]);
  });

  it('gives a different value under a different key, so environments do not correlate', async () => {
    const other = new PseudonymousUserId('another-environment-key-not-a-real-secret');
    const mine = new PseudonymousUserId('test-pseudonymous-user-id-key-not-a-real-secret');
    expect(other.derive(ID_A)).not.toBe(mine.derive(ID_A));
  });
});
