import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import {
  EMAIL_DELIVERY_QUEUE,
  EMAIL_RELAY_BATCH_SIZE,
  EMAIL_RELAY_ID,
  EMAIL_RELAY_JOB,
  EMAIL_RELAY_PAYLOAD,
  EMAIL_RELAY_SCHEDULER_ID,
  EmailDeliveryQueue,
  MALFORMED_PAYLOAD_ERROR_TYPE,
  UNCLASSIFIED_ERROR_TYPE,
} from '../src/email/email-delivery.queue.js';
import type { ClaimedEmailRow, EmailOutboxStore, SettleEmailInput } from '../src/email/email-outbox.store.js';
import { isErrorType, type EmailDeliveryOutcome, type EmailMessage, type EmailTransport } from '../src/email/email-transport.js';
import { createLogger } from '../src/logging/logger.js';
import { assertQueueName, backoffDelay, MAX_ATTEMPTS } from '../src/queue/policy.js';
import { assertIdPayload } from '../src/queue/payload.js';
import { buildQueueDefinitions } from '../src/queue/registry.js';

/**
 * Phase 7-D — the email outbox relay, exercised entirely in process.
 *
 * No provider is contacted, no SMTP socket is opened and no credential exists: the transport is a
 * double, which is the whole point of the port. The store is a double too, but a faithful one — it
 * reproduces exactly the two rules migration 0008 enforces, that a claim moves a row out of `queued`
 * and increments `attempts`, and that a settle only lands on a row currently in `sending`.
 */

interface FakeRow {
  id: string;
  status: 'queued' | 'sending' | 'sent' | 'failed' | 'cancelled';
  attempts: number;
  availableAt: number;
  destination: string;
  payload: unknown;
  recipientUserId: string | null;
  providerMessageId: string | null;
  lastErrorType: string | null;
  sentAt: number | null;
  failedAt: number | null;
}

function row(id: string, overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    id,
    status: 'queued',
    attempts: 0,
    availableAt: 0,
    destination: `person-${id}@example.test`,
    payload: { subject: 'S', body_html: '<p>B</p>', body_text: 'B', template_key: 'order.placed', locale_code: 'en' },
    recipientUserId: null,
    providerMessageId: null,
    lastErrorType: null,
    sentAt: null,
    failedAt: null,
    ...overrides,
  };
}

/** A faithful stand-in for `claim_outbox_messages` and `settle_outbox_message` on the email channel. */
class FakeStore implements EmailOutboxStore {
  readonly settles: SettleEmailInput[] = [];
  claims = 0;
  now = 1_000_000;

  constructor(readonly rows: FakeRow[]) {}

  async claimEmailBatch(limit: number): Promise<readonly ClaimedEmailRow[]> {
    this.claims += 1;
    if (limit < 1 || limit > 500) throw new Error('p_limit must be between 1 and 500');
    const claimed = this.rows
      .filter((r) => r.status === 'queued' && r.availableAt <= this.now)
      .sort((a, b) => a.availableAt - b.availableAt || a.id.localeCompare(b.id))
      .slice(0, limit);
    for (const r of claimed) {
      r.status = 'sending';
      r.attempts += 1;
    }
    return claimed.map((r) => ({
      id: r.id,
      recipientUserId: r.recipientUserId,
      destination: r.destination,
      payload: r.payload,
      attempts: r.attempts,
    }));
  }

  async settleEmailMessage(input: SettleEmailInput): Promise<boolean> {
    this.settles.push(input);
    const target = this.rows.find((r) => r.id === input.id);
    // 0008: `where id = p_id and status = 'sending'`.
    if (target === undefined || target.status !== 'sending') return false;
    target.status = input.status;
    target.providerMessageId = input.providerMessageId ?? target.providerMessageId;
    target.lastErrorType = input.errorType;
    target.sentAt = input.status === 'sent' ? this.now : null;
    target.failedAt = input.status === 'failed' ? this.now : null;
    if (input.status === 'queued') target.availableAt = input.retryAt?.getTime() ?? this.now;
    return true;
  }
}

class RecordingTransport implements EmailTransport {
  readonly name = 'test-double';
  readonly seen: EmailMessage[] = [];

  constructor(private readonly reply: (message: EmailMessage, index: number) => EmailDeliveryOutcome | Promise<EmailDeliveryOutcome>) {}

  async send(message: EmailMessage): Promise<EmailDeliveryOutcome> {
    const index = this.seen.length;
    this.seen.push(message);
    return await this.reply(message, index);
  }
}

const sink = () => new Writable({ write: (_c, _e, cb) => cb() });
const silent = () => createLogger('fatal', sink());

function lines(): { logger: ReturnType<typeof createLogger>; entries: Array<Record<string, unknown>> } {
  const entries: Array<Record<string, unknown>> = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      for (const line of String(chunk).trim().split('\n')) {
        if (line !== '') entries.push(JSON.parse(line) as Record<string, unknown>);
      }
      callback();
    },
  });
  return { logger: createLogger('debug', stream), entries };
}

function relay(store: EmailOutboxStore, transport: EmailTransport, logger = silent(), random = () => 0.5): EmailDeliveryQueue {
  return new EmailDeliveryQueue(store, transport, logger, 15_000, () => new Date(1_000_000), random);
}

const env = loadEnv({
  NODE_ENV: 'test',
  PSEUDONYMOUS_USER_ID_KEY: 'test-pseudonymous-user-id-key-not-a-real-secret',
  APP_WORKER_DATABASE_URL: 'postgres://app_worker@127.0.0.1:5432/marketplace_test',
  REDIS_URL: 'redis://127.0.0.1:6379',
  WORKER_HEALTH_HOST: '127.0.0.1',
  WORKER_HEALTH_PORT: '8081',
});

describe('7-D job registration', () => {
  it('registers the email relay only when a transport is configured', () => {
    expect(buildQueueDefinitions(env, silent())).toEqual([]);

    const definitions = buildQueueDefinitions(env, silent(), new RecordingTransport(() => ({ status: 'sent', providerMessageId: null })));
    expect(definitions).toHaveLength(1);
    expect(definitions[0]?.name).toBe(EMAIL_DELIVERY_QUEUE);
  });

  it('says so, without naming a provider, when no transport is configured', () => {
    const { logger, entries } = lines();
    buildQueueDefinitions(env, logger);
    expect(entries.map((e) => e['event'])).toContain('email_relay_not_registered');
  });

  it('uses a queue name the worker policy accepts', () => {
    expect(() => assertQueueName(EMAIL_DELIVERY_QUEUE)).not.toThrow();
  });

  it('declares a repeatable schedule whose payload obeys the IDs-only rule', () => {
    const definition = relay(new FakeStore([]), new RecordingTransport(() => ({ status: 'sent', providerMessageId: null })));
    expect(definition.schedule).toEqual({
      jobName: EMAIL_RELAY_JOB,
      schedulerId: EMAIL_RELAY_SCHEDULER_ID,
      everyMs: 15_000,
      data: EMAIL_RELAY_PAYLOAD,
    });
    expect(() => assertIdPayload(definition.schedule.data)).not.toThrow();
    // Never `userId`: a batch belongs to no one person, and the runtime scopes log identity from that key.
    expect(Object.keys(EMAIL_RELAY_PAYLOAD)).toEqual(['relayId']);
    expect(EMAIL_RELAY_PAYLOAD['relayId']).toBe(EMAIL_RELAY_ID);
  });

  it('claims 0008\'s own default batch size', () => {
    expect(EMAIL_RELAY_BATCH_SIZE).toBe(50);
    expect(EMAIL_RELAY_BATCH_SIZE).toBeGreaterThanOrEqual(1);
    expect(EMAIL_RELAY_BATCH_SIZE).toBeLessThanOrEqual(500);
  });
});

describe('7-D claim behaviour', () => {
  it('claims only queued rows whose availability has passed, and counts the attempt', async () => {
    const store = new FakeStore([
      row('a'),
      row('b', { status: 'sent' }),
      row('c', { availableAt: 9_000_000 }),
      row('d', { status: 'sending' }),
    ]);
    const transport = new RecordingTransport(() => ({ status: 'sent', providerMessageId: 'pm-1' }));
    const result = await relay(store, transport).drain();

    expect(result).toMatchObject({ claimed: 1, sent: 1, requeued: 0, failed: 0 });
    expect(store.rows.find((r) => r.id === 'a')).toMatchObject({ status: 'sent', attempts: 1, providerMessageId: 'pm-1' });
    expect(store.rows.find((r) => r.id === 'c')?.status).toBe('queued');
  });

  it('passes the stored message through unchanged and composes nothing', async () => {
    const store = new FakeStore([row('a')]);
    const transport = new RecordingTransport(() => ({ status: 'sent', providerMessageId: null }));
    await relay(store, transport).drain();

    expect(transport.seen).toEqual([
      { to: 'person-a@example.test', subject: 'S', bodyHtml: '<p>B</p>', bodyText: 'B', templateKey: 'order.placed', localeCode: 'en' },
    ]);
  });

  it('delivers a whole batch and settles each message once', async () => {
    const store = new FakeStore([row('a'), row('b'), row('c')]);
    const transport = new RecordingTransport(() => ({ status: 'sent', providerMessageId: null }));
    const result = await relay(store, transport).drain();

    expect(result.claimed).toBe(3);
    expect(store.settles).toHaveLength(3);
    expect(store.settles.every((s) => s.status === 'sent')).toBe(true);
  });

  it('does nothing at all when there is nothing to claim', async () => {
    const store = new FakeStore([]);
    const transport = new RecordingTransport(() => ({ status: 'sent', providerMessageId: null }));
    expect(await relay(store, transport).drain()).toEqual({ claimed: 0, sent: 0, requeued: 0, failed: 0, unsettled: 0 });
    expect(transport.seen).toEqual([]);
    expect(store.settles).toEqual([]);
  });
});

describe('7-D idempotency and duplicate processing', () => {
  it('cannot claim the same row twice: a second tick sees nothing', async () => {
    const store = new FakeStore([row('a')]);
    let sends = 0;
    const transport = new RecordingTransport(() => {
      sends += 1;
      return { status: 'sent', providerMessageId: null };
    });
    const definition = relay(store, transport);
    await definition.drain();
    await definition.drain();

    expect(store.claims).toBe(2);
    expect(sends).toBe(1);
    expect(store.rows[0]?.attempts).toBe(1);
  });

  it('treats a settle that lands on nothing as information, not an error', async () => {
    const store = new FakeStore([row('a')]);
    // Somebody else finishes the row while the send is in flight, exactly as 0008's guard describes.
    const transport = new RecordingTransport(() => {
      const target = store.rows[0];
      if (target !== undefined) target.status = 'sent';
      return { status: 'sent', providerMessageId: null };
    });
    const result = await relay(store, transport).drain();

    expect(result).toMatchObject({ claimed: 1, unsettled: 1, sent: 0 });
  });

  it('settles each message exactly once per attempt', async () => {
    const store = new FakeStore([row('a'), row('b')]);
    const transport = new RecordingTransport((_m, index) =>
      index === 0 ? { status: 'sent', providerMessageId: null } : { status: 'failed', errorType: 'provider_status_500', retryable: true },
    );
    await relay(store, transport).drain();

    expect(store.settles.map((s) => s.id)).toEqual(['a', 'b']);
    expect(store.settles.map((s) => s.status)).toEqual(['sent', 'queued']);
  });
});

describe('7-D success handling', () => {
  it('records the provider message id and the sent status', async () => {
    const store = new FakeStore([row('a')]);
    await relay(store, new RecordingTransport(() => ({ status: 'sent', providerMessageId: 'provider-42' }))).drain();

    expect(store.settles[0]).toEqual({ id: 'a', status: 'sent', providerMessageId: 'provider-42', errorType: null, retryAt: null });
    expect(store.rows[0]).toMatchObject({ status: 'sent', sentAt: store.now, failedAt: null, lastErrorType: null });
  });

  it('accepts a success with no provider message id', async () => {
    const store = new FakeStore([row('a')]);
    await relay(store, new RecordingTransport(() => ({ status: 'sent', providerMessageId: null }))).drain();
    expect(store.rows[0]).toMatchObject({ status: 'sent', providerMessageId: null });
  });
});

describe('7-D failure and retry semantics', () => {
  it('requeues a transient failure with the worker policy backoff', async () => {
    const store = new FakeStore([row('a')]);
    const transport = new RecordingTransport(() => ({ status: 'failed', errorType: 'provider_timeout', retryable: true }));
    const result = await relay(store, transport, silent(), () => 0.5).drain();

    expect(result).toMatchObject({ requeued: 1, failed: 0, sent: 0 });
    const settle = store.settles[0];
    expect(settle).toMatchObject({ status: 'queued', providerMessageId: null, errorType: 'provider_timeout' });
    // attempts arrives from the claim already counting this attempt, which is backoffDelay's argument.
    expect(settle?.retryAt?.getTime()).toBe(1_000_000 + backoffDelay(1, () => 0.5));
    expect(store.rows[0]).toMatchObject({ status: 'queued', lastErrorType: 'provider_timeout', sentAt: null, failedAt: null });
  });

  it('gives up at the worker policy cap rather than requeueing forever', async () => {
    const store = new FakeStore([row('a', { attempts: MAX_ATTEMPTS - 1 })]);
    const transport = new RecordingTransport(() => ({ status: 'failed', errorType: 'provider_status_500', retryable: true }));
    const result = await relay(store, transport).drain();

    expect(store.rows[0]?.attempts).toBe(MAX_ATTEMPTS);
    expect(result).toMatchObject({ failed: 1, requeued: 0 });
    expect(store.settles[0]).toMatchObject({ status: 'failed', retryAt: null, errorType: 'provider_status_500' });
    expect(store.rows[0]).toMatchObject({ status: 'failed', failedAt: store.now });
  });

  it('never requeues a permanent rejection, however early the attempt', async () => {
    const store = new FakeStore([row('a')]);
    const transport = new RecordingTransport(() => ({ status: 'failed', errorType: 'provider_rejected_recipient', retryable: false }));
    await relay(store, transport).drain();

    expect(store.rows[0]).toMatchObject({ status: 'failed', attempts: 1, lastErrorType: 'provider_rejected_recipient' });
  });

  it('retries across ticks until the cap, then stops', async () => {
    const store = new FakeStore([row('a')]);
    const transport = new RecordingTransport(() => ({ status: 'failed', errorType: 'provider_timeout', retryable: true }));
    const definition = relay(store, transport);

    for (let tick = 0; tick < MAX_ATTEMPTS + 3; tick += 1) {
      store.now += 3_600_000; // past any backoff this policy can produce
      await definition.drain();
    }

    expect(store.rows[0]).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS });
    expect(transport.seen).toHaveLength(MAX_ATTEMPTS);
  });

  it('treats an adapter that throws as transient, and records a class name only', async () => {
    const store = new FakeStore([row('a')]);
    const transport: EmailTransport = {
      name: 'throwing-double',
      send: () => Promise.reject(new TypeError('connect ECONNREFUSED 10.0.0.1:587 for bob@example.test')),
    };
    await relay(store, transport).drain();

    const settle = store.settles[0];
    expect(settle).toMatchObject({ status: 'queued', errorType: 'TypeError' });
    expect(JSON.stringify(settle)).not.toContain('ECONNREFUSED');
    expect(JSON.stringify(settle)).not.toContain('bob@example.test');
  });

  it('replaces an error type the database constraint would refuse', async () => {
    const store = new FakeStore([row('a')]);
    const transport = new RecordingTransport(() => ({
      status: 'failed',
      errorType: '550 5.1.1 <bob@example.test>: Recipient address rejected',
      retryable: false,
    }));
    await relay(store, transport).drain();

    expect(store.settles[0]?.errorType).toBe(UNCLASSIFIED_ERROR_TYPE);
    expect(isErrorType(UNCLASSIFIED_ERROR_TYPE)).toBe(true);
  });

  it('only ever writes an error type the schema accepts', async () => {
    const store = new FakeStore([row('a'), row('b'), row('c')]);
    const transport = new RecordingTransport((_m, index) =>
      [
        { status: 'failed' as const, errorType: 'provider_timeout', retryable: true },
        { status: 'failed' as const, errorType: 'bad type!', retryable: false },
        { status: 'failed' as const, errorType: '1_leading_digit', retryable: false },
      ][index] ?? { status: 'sent' as const, providerMessageId: null },
    );
    await relay(store, transport).drain();

    for (const settle of store.settles) {
      expect(settle.errorType === null || isErrorType(settle.errorType)).toBe(true);
    }
  });

  it('lets a store failure become the job\'s failure, so BullMQ owns the tick', async () => {
    const broken: EmailOutboxStore = {
      claimEmailBatch: () => Promise.reject(new Error('connection terminated')),
      settleEmailMessage: () => Promise.resolve(true),
    };
    const definition = relay(broken, new RecordingTransport(() => ({ status: 'sent', providerMessageId: null })));
    await expect(definition.process()).rejects.toThrow('connection terminated');
  });

  it('never settles the same message under both retry mechanisms', async () => {
    // The message's attempts are counted by the claim alone; a failing tick settles the message itself
    // and then rethrows nothing, so BullMQ's own attempts apply to the tick and not to the message.
    const store = new FakeStore([row('a')]);
    const transport = new RecordingTransport(() => ({ status: 'failed', errorType: 'provider_timeout', retryable: true }));
    const definition = relay(store, transport);
    await definition.process();
    await definition.process();

    expect(store.rows[0]?.attempts).toBe(1);
    expect(store.settles).toHaveLength(1);
  });
});

describe('7-D malformed outbox data', () => {
  it.each([
    ['missing subject', { body_html: '<p>B</p>', body_text: 'B' }],
    ['empty subject', { subject: '', body_html: '<p>B</p>', body_text: 'B' }],
    ['missing bodies', { subject: 'S' }],
    ['not an object', 'subject: S'],
    ['null', null],
    ['wrong types', { subject: 1, body_html: true, body_text: [] }],
  ])('fails %s terminally rather than retrying it forever', async (_name, payload) => {
    const store = new FakeStore([row('a', { payload })]);
    const transport = new RecordingTransport(() => ({ status: 'sent', providerMessageId: null }));
    const result = await relay(store, transport).drain();

    expect(transport.seen).toEqual([]);
    expect(result).toMatchObject({ failed: 1, requeued: 0 });
    expect(store.settles[0]).toMatchObject({ status: 'failed', errorType: MALFORMED_PAYLOAD_ERROR_TYPE, retryAt: null });
    expect(isErrorType(MALFORMED_PAYLOAD_ERROR_TYPE)).toBe(true);
  });

  it('tolerates the two nullable fields 0008 allows', async () => {
    const store = new FakeStore([row('a', { payload: { subject: 'S', body_html: '', body_text: '', template_key: null, locale_code: null } })]);
    const transport = new RecordingTransport(() => ({ status: 'sent', providerMessageId: null }));
    await relay(store, transport).drain();

    expect(transport.seen[0]).toMatchObject({ templateKey: null, localeCode: null, bodyHtml: '', bodyText: '' });
  });

  it('does not let one unusable row stop the rest of the batch', async () => {
    const store = new FakeStore([row('a', { payload: {} }), row('b')]);
    const transport = new RecordingTransport(() => ({ status: 'sent', providerMessageId: null }));
    const result = await relay(store, transport).drain();

    expect(result).toMatchObject({ claimed: 2, sent: 1, failed: 1 });
  });
});

describe('7-D template resolution', () => {
  it('resolves no template and invents no copy', async () => {
    const store = new FakeStore([row('a', { payload: { subject: 'Stored subject', body_html: '<p>Stored</p>', body_text: 'Stored', template_key: 'order.placed', locale_code: 'ar' } })]);
    const transport = new RecordingTransport(() => ({ status: 'sent', providerMessageId: null }));
    await relay(store, transport).drain();

    // Whatever the worker sends is exactly what queue_email stored; email_templates is not consulted,
    // and it holds no rows to consult.
    expect(transport.seen[0]).toMatchObject({ subject: 'Stored subject', bodyHtml: '<p>Stored</p>', bodyText: 'Stored' });
  });

  it('carries the template key and locale as provenance only', async () => {
    const store = new FakeStore([row('a', { payload: { subject: 'S', body_html: 'H', body_text: 'T', template_key: 'k', locale_code: 'ar' } })]);
    const transport = new RecordingTransport(() => ({ status: 'sent', providerMessageId: null }));
    await relay(store, transport).drain();

    expect(transport.seen[0]).toMatchObject({ templateKey: 'k', localeCode: 'ar', subject: 'S' });
  });
});

describe('7-D disclosure', () => {
  it('logs counts and never a person, an address, a subject or a body', async () => {
    const { logger, entries } = lines();
    const store = new FakeStore([
      row('a', { recipientUserId: '11111111-1111-4111-8111-111111111111', destination: 'someone@example.test', payload: { subject: 'Your order shipped', body_html: '<p>secret body</p>', body_text: 'secret body' } }),
      row('b', { payload: {} }),
    ]);
    const transport = new RecordingTransport(() => ({ status: 'failed', errorType: 'provider_timeout', retryable: true }));
    await relay(store, transport, logger).drain();

    const text = entries.map((entry) => JSON.stringify(entry)).join('\n');
    for (const forbidden of ['someone@example.test', 'Your order shipped', 'secret body', '11111111-1111-4111-8111-111111111111']) {
      expect(text).not.toContain(forbidden);
    }
    expect(entries.some((entry) => entry['event'] === 'email_relay_tick')).toBe(true);
    expect(entries.find((entry) => entry['event'] === 'email_relay_tick')).toMatchObject({
      transport: 'test-double',
      claimed: 2,
      requeued: 1,
      failed: 1,
    });
  });

  it('says nothing at all on an empty tick', async () => {
    const { logger, entries } = lines();
    await relay(new FakeStore([]), new RecordingTransport(() => ({ status: 'sent', providerMessageId: null })), logger).drain();
    expect(entries.filter((entry) => entry['event'] === 'email_relay_tick')).toEqual([]);
  });

  it('keeps one person\'s message away from another\'s', async () => {
    const store = new FakeStore([
      row('a', { destination: 'first@example.test', payload: { subject: 'First', body_html: 'A', body_text: 'A' } }),
      row('b', { destination: 'second@example.test', payload: { subject: 'Second', body_html: 'B', body_text: 'B' } }),
    ]);
    const transport = new RecordingTransport(() => ({ status: 'sent', providerMessageId: null }));
    await relay(store, transport).drain();

    expect(transport.seen).toEqual([
      { to: 'first@example.test', subject: 'First', bodyHtml: 'A', bodyText: 'A', templateKey: null, localeCode: null },
      { to: 'second@example.test', subject: 'Second', bodyHtml: 'B', bodyText: 'B', templateKey: null, localeCode: null },
    ]);
  });
});

describe('7-D error-type guard', () => {
  it.each(['provider_timeout', 'TypeError', 'A', 'a_1'])('accepts %j', (value) => {
    expect(isErrorType(value)).toBe(true);
  });

  it.each(['', '1abc', 'has space', 'has-hyphen', 'has.dot', '<bob@example.test>', 'a'.repeat(201)])('refuses %j', (value) => {
    expect(isErrorType(value)).toBe(false);
  });
});
