import { readFileSync, readdirSync, statSync } from 'node:fs';
import { Writable } from 'node:stream';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ENV_INVENTORY, variablesFor } from '@repo/server-config';
import { EMAIL_DELIVERY_QUEUE, EMAIL_RELAY_SCHEDULER_ID, EmailDeliveryQueue } from '../src/email/email-delivery.queue.js';
import type { ClaimedEmailRow, EmailOutboxStore, SettleEmailInput } from '../src/email/email-outbox.store.js';
import type { EmailTransport } from '../src/email/email-transport.js';
import { createLogger } from '../src/logging/logger.js';
import { startRedis, type RedisInstance } from './support/redis-server.js';
import { createTestRuntime, inspector, waitUntil, type TestRuntime } from './support/runtime.js';

/**
 * Phase 7-D — where the email relay is allowed to reach, and where it is not.
 *
 * Two kinds of check. The first reads the repository itself: the relay must hold no provider
 * credential, touch no table, appear in no browser bundle and create no second outbox. The second runs
 * the relay through real BullMQ against a local Redis, so "the job is registered" is demonstrated
 * rather than asserted about a constructor.
 *
 * No provider is contacted in either: the transport is always a double.
 */

const ROOT = new URL('../../../', import.meta.url).pathname;

function sourcesUnder(relative: string, extensions = ['.ts', '.tsx']): string[] {
  const base = join(ROOT, relative);
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.next' || entry === '.turbo') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (extensions.some((ext) => entry.endsWith(ext))) found.push(full);
    }
  };
  walk(base);
  return found;
}

const relaySources = sourcesUnder('apps/worker/src/email').concat([join(ROOT, 'apps/worker/src/queue/registry.ts')]);
const relayText = relaySources.map((file) => readFileSync(file, 'utf8')).join('\n');

/** The same sources with documentation removed: a comment may quote v5.2, code may not name a provider. */
const relayCode = relayText.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('7-D credential isolation', () => {
  it('introduces no email provider credential anywhere in the inventory', () => {
    const names = ENV_INVENTORY.map((entry) => entry.name);
    for (const forbidden of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'EMAIL_API_KEY', 'EMAIL_PROVIDER_API_KEY', 'MAIL_API_KEY', 'SENDGRID_API_KEY', 'RESEND_API_KEY', 'POSTMARK_TOKEN', 'SES_ACCESS_KEY_ID']) {
      expect(names).not.toContain(forbidden);
    }
  });

  it('keeps every worker variable off every browser bundle', () => {
    for (const entry of variablesFor('worker')) {
      expect(entry.apps).not.toContain('web');
      expect(entry.apps).not.toContain('admin');
      expect(entry.name.startsWith('NEXT_PUBLIC_')).toBe(false);
    }
  });

  it('reads no environment variable and opens no socket of its own', () => {
    // The worker's single reader of process.env is config/env.ts, and the relay is not it.
    expect(relayText).not.toContain('process.env');
    expect(relayCode).not.toContain('fetch(');
    expect(relayCode).not.toContain('nodemailer');
    expect(relayText).not.toMatch(/from 'node:(net|tls|http|https)'/);
  });

  it('names no provider in code', () => {
    for (const provider of ['sendgrid', 'mailgun', 'postmark', 'resend', 'ses', 'smtp', 'waabek']) {
      expect(relayCode.toLowerCase()).not.toMatch(new RegExp(`\\b${provider}\\b`));
    }
  });
});

describe('7-D application boundaries', () => {
  it('reaches the database only through 0008\'s named functions', () => {
    const store = readFileSync(join(ROOT, 'apps/worker/src/email/email-outbox.store.ts'), 'utf8');
    expect(store).toContain('app_private.claim_outbox_messages');
    expect(store).toContain('app_private.settle_outbox_message');
    // No table access: app_worker holds no table privileges, so this would be refused anyway.
    expect(store).not.toMatch(/\b(selectFrom|insertInto|updateTable|deleteFrom)\b/);
    expect(store).not.toMatch(/\b(from|into|update)\s+public\./);
  });

  it('calls no other database function', () => {
    const calls = [...relayText.matchAll(/app_private\.[a-z_]+/g)].map((match) => match[0]);
    expect([...new Set(calls)].sort()).toEqual(['app_private.claim_outbox_messages', 'app_private.settle_outbox_message']);
  });

  it('never uses withRlsContext', () => {
    for (const file of sourcesUnder('apps/worker/src')) {
      expect(readFileSync(file, 'utf8')).not.toContain('withRlsContext');
    }
  });

  it('creates no second outbox and no notification writer of its own', () => {
    expect(relayText).not.toContain('create table');
    expect(relayText).not.toContain('app_private.queue_email');
    expect(relayText).not.toContain('app_private.create_notification');
    expect(relayText).not.toContain('app_private.attach_notification_email');
    expect(relayText).not.toContain('app_private.mark_notification_published');
  });

  it('adds no migration: 0008 already granted the worker what it needs', () => {
    // Stated as a property of the migration set rather than as "the last one is 0066", so a later
    // increment adding an unrelated migration cannot make this pass or fail for the wrong reason: the
    // email outbox and its two functions must be defined in 0008 and nowhere else.
    const dir = join(ROOT, 'supabase/migrations');
    const owners = readdirSync(dir)
      .filter((name) => name.endsWith('.sql'))
      .filter((name) => {
        const text = readFileSync(join(dir, name), 'utf8');
        return (
          /create\s+table\s+public\.email_outbox/i.test(text) ||
          /create\s+or\s+replace\s+function\s+app_private\.(claim_outbox_messages|settle_outbox_message)/i.test(text)
        );
      });
    expect(owners).toEqual(['0008_settings_and_notification_outboxes.sql']);

    const grants = readFileSync(join(dir, '0008_settings_and_notification_outboxes.sql'), 'utf8');
    expect(grants).toContain('app_private.claim_outbox_messages(text, integer)');
    expect(grants).toContain('app_private.settle_outbox_message(text, uuid, text, text, text, timestamptz)');
    expect(grants).toContain('app_system, app_worker');
  });

  it('is not reachable from any browser application', () => {
    for (const app of ['apps/web/src', 'apps/admin/src']) {
      for (const file of sourcesUnder(app)) {
        const text = readFileSync(file, 'utf8');
        expect(text).not.toContain('@repo/worker');
        expect(text).not.toContain('email-delivery.queue');
        expect(text).not.toContain('email_outbox');
      }
    }
  });
});

/* ---------------------------------------------------------------------------------------------- */

class StubStore implements EmailOutboxStore {
  readonly settled: SettleEmailInput[] = [];
  claims = 0;
  rows: ClaimedEmailRow[] = [];

  async claimEmailBatch(): Promise<readonly ClaimedEmailRow[]> {
    this.claims += 1;
    const batch = this.rows;
    this.rows = [];
    return batch;
  }

  async settleEmailMessage(input: SettleEmailInput): Promise<boolean> {
    this.settled.push(input);
    return true;
  }
}

const silent = () => createLogger('fatal', new Writable({ write: (_c, _e, cb) => cb() }));

const transport: EmailTransport = {
  name: 'boundary-double',
  send: () => Promise.resolve({ status: 'sent', providerMessageId: 'stub-1' }),
};

let server: RedisInstance;
const runtimes: TestRuntime[] = [];

beforeAll(async () => {
  server = await startRedis({ policy: 'noeviction' });
});
afterAll(async () => {
  await server.stop();
});
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((t) => t.runtime.stop()));
});

describe('7-D job registration against real BullMQ', () => {
  it('installs the repeatable schedule and drains the outbox without anything enqueueing a job', async () => {
    const store = new StubStore();
    store.rows = [
      { id: '22222222-2222-4222-8222-222222222222', recipientUserId: null, destination: 'a@example.test', payload: { subject: 'S', body_html: 'H', body_text: 'T', template_key: null, locale_code: null }, attempts: 1 },
    ];
    const definition = new EmailDeliveryQueue(store, transport, silent(), 1_000);
    const harness = await createTestRuntime(server.url, [definition]);
    runtimes.push(harness);
    await harness.runtime.start();

    await waitUntil(() => store.settled.length === 1, 20_000);
    expect(store.settled[0]).toMatchObject({ status: 'sent', providerMessageId: 'stub-1' });

    const redis = inspector(server.url);
    try {
      const keys = await redis.keys(`queue:${EMAIL_DELIVERY_QUEUE}*`);
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.some((key) => key.includes(EMAIL_RELAY_SCHEDULER_ID) || key.includes('repeat'))).toBe(true);
    } finally {
      redis.disconnect();
    }
  });

  it('keeps ticking, so a message queued after start is still drained', async () => {
    const store = new StubStore();
    const definition = new EmailDeliveryQueue(store, transport, silent(), 1_000);
    const harness = await createTestRuntime(server.url, [definition]);
    runtimes.push(harness);
    await harness.runtime.start();

    await waitUntil(() => store.claims >= 1, 20_000);
    store.rows = [
      { id: '33333333-3333-4333-8333-333333333333', recipientUserId: null, destination: 'b@example.test', payload: { subject: 'S', body_html: 'H', body_text: 'T', template_key: null, locale_code: null }, attempts: 1 },
    ];
    await waitUntil(() => store.settled.length === 1, 20_000);
    expect(store.settled[0]?.id).toBe('33333333-3333-4333-8333-333333333333');
  });
});
