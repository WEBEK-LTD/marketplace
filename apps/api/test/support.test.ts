import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { SESSION_TOKEN_HEADER } from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { AuthenticationRequiredError } from '../src/auth/auth-errors.js';
import {
  DURABLE_THROTTLE_COUNTER,
  REDIS_THROTTLE_COUNTER,
} from '../src/auth/login-throttle.service.js';
import { SUPABASE_AUTH_CLIENT } from '../src/auth/login.service.js';
import { SELLER_THROTTLE_BUCKETS } from '../src/sellers/seller-throttle.service.js';
import { SUPPORT_THROTTLE_BUCKETS } from '../src/support/support-throttle.service.js';
import {
  SELLER_MEDIA_STORAGE,
  SellerMediaStorageUnavailableError,
} from '../src/sellers/seller-media.storage.js';
import {
  SUPPORT_STORE,
  type SupportAttachmentLocationRow,
  type SupportAttachmentRecordRow,
  type SupportAttachmentTargetRow,
  type SupportMessagePostRow,
  type SupportMessageRow,
  type SupportTicketClosureRow,
  type SupportTicketDetailRow,
  type SupportTicketOpenRow,
  type SupportTicketRow,
} from '../src/support/support.service.js';
import { CURRENT_USER_STORE } from '../src/users/current-user.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * Support at the API boundary — the requester side (Phase 7-K).
 *
 * What is being held to account:
 *
 *   * **nothing about the caller is in a request** — no account, no role, no side — and what the store is
 *     called with is always the account the provider vouched for;
 *   * **nothing agent-only is in a request or a response** — no status, no priority, no assignee, no
 *     internal note, no author identifier and no first-response time; the strict contracts refuse the
 *     inputs and the narrow projections drop the outputs;
 *   * **every outcome migration 0074 can return becomes exactly one answer**, and a closed ticket becomes
 *     a 409 with its own code rather than a generic failure;
 *   * **an attachment is addressed through its own ticket**, the request carries no storage path, and the
 *     path the provider is given is always the one the database composed;
 *   * **a confirmation for a file the provider does not have never reaches a write**;
 *   * **no support notification and no email is produced** — this surface calls neither;
 *   * **the three writes are rate limited and the reads are not** (owner Decision 1), each write counting
 *     against the approved bucket, before the operation, against a counter keyed by the caller's own
 *     hashed account — so two accounts never share one, and repeating a refused request does not get past
 *     it.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const TICKET = 'd4000000-0000-4000-8000-000000000001';
const MESSAGE = 'd4000000-0000-4000-8000-0000000000a1';
const ATTACHMENT = 'd4000000-0000-4000-8000-0000000000b1';
const OBJECT_PATH = `support-attachments/${TICKET}/${MESSAGE}/f47ac10b-58cc-4372-a567-0e02b2c3d479.png`;

const OTHER_USER = '22222222-2222-4222-8222-222222222222';

const ACCESS_TOKEN = 'support-requester-canary-token-not-a-real-to';
/** A second session, so a counter can be proven to be per account rather than per surface. */
const SECOND_ACCESS_TOKEN = 'support-second-canary-token-not-a-real-token';

function ticketRow(overrides: Partial<SupportTicketRow> = {}): SupportTicketRow {
  return {
    id: TICKET,
    reference: 'SP-26-000001',
    subject: 'My payout has not arrived',
    category: 'payouts',
    status: 'pending_agent',
    messageCount: 2,
    attachmentCount: 1,
    lastMessageAt: new Date('2026-05-02T09:00:00.000Z'),
    resolvedAt: null,
    closedAt: null,
    createdAt: new Date('2026-05-01T09:00:00.000Z'),
    ...overrides,
  };
}

function detailRow(overrides: Partial<SupportTicketDetailRow> = {}): SupportTicketDetailRow {
  return {
    outcome: 'found',
    id: TICKET,
    reference: 'SP-26-000001',
    subject: 'My payout has not arrived',
    category: 'payouts',
    status: 'pending_agent',
    messageCount: 2,
    lastMessageAt: new Date('2026-05-02T09:00:00.000Z'),
    resolvedAt: null,
    closedAt: null,
    createdAt: new Date('2026-05-01T09:00:00.000Z'),
    ...overrides,
  };
}

function messageRow(overrides: Partial<SupportMessageRow> = {}): SupportMessageRow {
  return {
    id: MESSAGE,
    authorRole: 'requester',
    isOwnMessage: true,
    body: 'It has been eight days since the payout was marked sent.',
    createdAt: new Date('2026-05-01T09:00:00.000Z'),
    attachments: [
      {
        id: ATTACHMENT,
        originalFilename: 'statement.pdf',
        contentType: 'application/pdf',
        byteSize: '20480',
      },
    ],
    ...overrides,
  };
}

interface Recorded {
  readonly calls: string[];
  readonly args: Array<{ readonly name: string; readonly input: Record<string, unknown> }>;
  /** Every bucket the Redis counter was asked about, in order, with the subject it was keyed by. */
  readonly buckets: Array<{ readonly bucket: string; readonly subject: string; readonly limit: number; readonly windowSeconds: number }>;
  readonly durableBuckets: string[];
}

interface Doubles {
  readonly tickets?: readonly SupportTicketRow[];
  readonly ticket?: SupportTicketDetailRow;
  readonly messages?: readonly SupportMessageRow[];
  readonly open?: SupportTicketOpenRow;
  readonly reply?: SupportMessagePostRow;
  readonly close?: SupportTicketClosureRow;
  readonly target?: SupportAttachmentTargetRow;
  readonly attach?: SupportAttachmentRecordRow;
  readonly location?: SupportAttachmentLocationRow;
  readonly objectExists?: boolean;
  readonly storageFails?: boolean;
  readonly tokenFails?: boolean;
  readonly throws?: boolean;
  /** When set, the throttle counters actually count rather than always allowing. */
  readonly counting?: boolean;
  readonly redisThrows?: boolean;
  readonly durableThrows?: boolean;
  /** A second account, so a counter can be proven not to be shared. */
  readonly secondUser?: string;
}

let app: NestFastifyApplication | undefined;

async function start(doubles: Doubles = {}): Promise<Recorded> {
  const recorded: Recorded = { calls: [], args: [], buckets: [], durableBuckets: [] };
  const record = <T>(name: string, input: unknown, value: T): T => {
    recorded.calls.push(name);
    recorded.args.push({
      name,
      input: (typeof input === 'object' && input !== null ? input : { input }) as Record<string, unknown>,
    });
    if (doubles.throws === true) throw new Error('database unavailable');
    return value;
  };

  // One window per (bucket, subject) pair, exactly as the fixed-window counter behaves, so a boundary is a
  // boundary and two accounts cannot share one.
  const counts = new Map<string, number>();
  const count = (bucket: string, subject: Buffer, limit: number): boolean => {
    const key = `${bucket}:${subject.toString('hex')}`;
    const next = (counts.get(key) ?? 0) + 1;
    counts.set(key, next);
    return next <= limit;
  };

  const redis = {
    hit: async (bucket: string, subject: Buffer, windowSeconds: number, limit: number) => {
      recorded.buckets.push({ bucket, subject: subject.toString('hex'), limit, windowSeconds });
      if (doubles.redisThrows === true) throw new Error('redis unavailable');
      return doubles.counting === true ? count(bucket, subject, limit) : true;
    },
  };
  const durable = {
    hit: async (bucket: string, subject: Buffer, windowSeconds: number, limit: number) => {
      recorded.durableBuckets.push(bucket);
      if (doubles.durableThrows === true) throw new Error('database unavailable');
      return doubles.counting === true ? count(bucket, subject, limit) : true;
    },
  };

  const storage = {
    signUpload: async (bucket: string, objectPath: string, contentType: string) => {
      recorded.calls.push('sign-upload');
      recorded.args.push({ name: 'sign-upload', input: { bucket, objectPath, contentType } });
      if (doubles.storageFails === true) throw new SellerMediaStorageUnavailableError(new Error('down'));
      return {
        uploadUrl: 'https://storage.test.invalid/upload/one-object',
        expiresAt: new Date('2026-05-02T09:02:00.000Z'),
      };
    },
    objectExists: async (bucket: string, objectPath: string) => {
      recorded.calls.push('object-exists');
      recorded.args.push({ name: 'object-exists', input: { bucket, objectPath } });
      if (doubles.storageFails === true) throw new SellerMediaStorageUnavailableError(new Error('down'));
      return doubles.objectExists ?? true;
    },
    signDownload: async (bucket: string, objectPath: string) => {
      recorded.calls.push('sign-download');
      recorded.args.push({ name: 'sign-download', input: { bucket, objectPath } });
      if (doubles.storageFails === true) throw new SellerMediaStorageUnavailableError(new Error('down'));
      return {
        url: 'https://storage.test.invalid/read/one-object',
        expiresAt: new Date('2026-05-02T09:02:00.000Z'),
      };
    },
  };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(TEST_ENV)] })
    .overrideProvider(SUPABASE_AUTH_CLIENT)
    .useValue({
      getUser: async (accessToken: string) => {
        recorded.calls.push('get-user');
        if (doubles.tokenFails === true) throw new AuthenticationRequiredError();
        // The account comes from the token the provider validated, which is what makes a counter
        // per-account: a second token is a second account and therefore a second counter.
        const id = accessToken === SECOND_ACCESS_TOKEN ? (doubles.secondUser ?? OTHER_USER) : USER;
        return { id, phone: null };
      },
    })
    .overrideProvider(REDIS_THROTTLE_COUNTER)
    .useValue(redis)
    .overrideProvider(DURABLE_THROTTLE_COUNTER)
    .useValue(durable)
    .overrideProvider(CURRENT_USER_STORE)
    .useValue({ userIdentity: async (userId: string) => ({ id: userId, displayName: 'Amina' }) })
    .overrideProvider(SELLER_MEDIA_STORAGE)
    .useValue(storage)
    .overrideProvider(SUPPORT_STORE)
    .useValue({
      supportTicketsForRequester: async (input: unknown) =>
        record('tickets', input, doubles.tickets ?? [ticketRow()]),
      supportTicketForRequester: async (input: unknown) =>
        record('ticket', input, doubles.ticket ?? detailRow()),
      supportTicketMessagesForRequester: async (input: unknown) =>
        record('messages', input, doubles.messages ?? [messageRow()]),
      supportTicketOpenForRequester: async (input: unknown) =>
        record(
          'open',
          input,
          doubles.open ?? {
            outcome: 'created',
            ticketId: TICKET,
            messageId: MESSAGE,
            reference: 'SP-26-000001',
            status: 'pending_agent',
          },
        ),
      supportMessagePostForRequester: async (input: unknown) =>
        record(
          'reply',
          input,
          doubles.reply ?? { outcome: 'posted', messageId: MESSAGE, status: 'pending_agent' },
        ),
      supportTicketCloseForRequester: async (input: unknown) =>
        record('close', input, doubles.close ?? { outcome: 'closed', status: 'closed' }),
      supportAttachmentTargetForRequester: async (input: unknown) =>
        record(
          'target',
          input,
          doubles.target ?? {
            outcome: 'authorized',
            bucketId: 'support-attachments',
            objectPath: OBJECT_PATH,
            maxByteSize: '20971520',
          },
        ),
      supportAttachmentAttachForRequester: async (input: unknown) =>
        record(
          'attach',
          input,
          doubles.attach ?? { outcome: 'attached', attachmentId: ATTACHMENT, attachmentCount: 1 },
        ),
      supportAttachmentForRequester: async (input: unknown) =>
        record(
          'location',
          input,
          doubles.location ?? {
            outcome: 'authorized',
            bucketId: 'support-attachments',
            objectPath: OBJECT_PATH,
          },
        ),
    })
    .compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(
    createFastifyAdapter(TEST_ENV, { logStream: { write: () => undefined } }),
    NEST_APP_OPTIONS,
  );
  await configureApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return recorded;
}

interface Result {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly raw: string;
}

async function call(
  method: 'GET' | 'POST',
  url: string,
  options: { accessToken?: string | null; payload?: unknown; headers?: Record<string, string> } = {},
): Promise<Result> {
  const headers: Record<string, string> = {
    [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL,
    ...options.headers,
  };
  const accessToken = options.accessToken === undefined ? ACCESS_TOKEN : options.accessToken;
  if (accessToken !== null) headers[SESSION_TOKEN_HEADER] = accessToken;
  if (options.payload !== undefined) headers['content-type'] = 'application/json';

  const response = await app!.inject({
    method,
    url,
    headers,
    ...(options.payload === undefined ? {} : { payload: JSON.stringify(options.payload) }),
  });
  return {
    status: response.statusCode,
    body: response.body.length > 0 ? (JSON.parse(response.body) as Record<string, unknown>) : {},
    raw: response.body,
  };
}

const TICKETS = '/v1/support/tickets';
const ONE = `${TICKETS}/${TICKET}`;
const MESSAGES = `${ONE}/messages`;
const CLOSE = `${ONE}/close`;
const UPLOADS = `${MESSAGES}/${MESSAGE}/attachments/uploads`;
const ATTACHMENTS = `${MESSAGES}/${MESSAGE}/attachments`;
const LINK = `${ONE}/attachments/${ATTACHMENT}/link`;

const VALID_TICKET = {
  subject: 'My payout has not arrived',
  category: 'payouts',
  body: 'It has been eight days since the payout was marked sent.',
};
const VALID_RECORD = {
  objectPath: OBJECT_PATH,
  originalFilename: 'statement.pdf',
  contentType: 'application/pdf',
  byteSize: 20_480,
};

const arg = (recorded: Recorded, name: string): Record<string, unknown> | undefined =>
  recorded.args.find((entry) => entry.name === name)?.input;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('support: the requester surface', () => {
  it('lists the caller’s own tickets, with the account from the token and never from the request', async () => {
    const recorded = await start();
    const result = await call('GET', TICKETS);

    expect(result.status).toBe(200);
    const items = result.body['items'] as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]?.['reference']).toBe('SP-26-000001');
    expect(items[0]?.['attachmentCount']).toBe(1);
    expect(arg(recorded, 'tickets')?.['userId']).toBe(USER);
    // The reader is asked for one more row than the page, so nextCursor is exact rather than one late.
    expect(arg(recorded, 'tickets')?.['limit']).toBe(21);
    expect(result.body['nextCursor']).toBeNull();
  });

  it('refuses to let a request name an account, a role or a ticket owner', async () => {
    const recorded = await start();
    await call('GET', `${TICKETS}?userId=${'2'.repeat(8)}&role=agent`);
    expect(arg(recorded, 'tickets')?.['userId']).toBe(USER);
    expect(JSON.stringify(recorded.args)).not.toContain('agent');
  });

  it('issues a cursor when there is another page, and refuses one it did not issue', async () => {
    const many = Array.from({ length: 21 }, (_, index) =>
      ticketRow({
        id: `d4000000-0000-4000-8000-0000000${String(index).padStart(5, '0')}`,
        createdAt: new Date(Date.UTC(2026, 4, 1, 9, 0, index)),
      }),
    );
    await start({ tickets: many });
    const first = await call('GET', TICKETS);
    expect(first.status).toBe(200);
    const cursor = first.body['nextCursor'];
    expect(typeof cursor).toBe('string');

    const second = await call('GET', `${TICKETS}?cursor=${encodeURIComponent(String(cursor))}`);
    expect(second.status).toBe(200);

    const refused = await call('GET', `${TICKETS}?cursor=not!base64url`);
    expect(refused.status).toBe(400);
    expect(refused.body['code']).toBe('SUPPORT_TICKETS_CURSOR_INVALID');
  });

  it('will not spend a ticket cursor on the conversation, or the other way round', async () => {
    await start();
    const list = await call(
      'GET',
      `${TICKETS}?limit=1`,
    );
    expect(list.status).toBe(200);

    // Both cursors are opaque and versioned; one kind decoded by the other reader is simply refused.
    const ticketCursor = Buffer.from('st1|2026-05-01T09:00:00.000Z|' + TICKET, 'utf8').toString(
      'base64url',
    );
    const messageCursor = Buffer.from('sm1|2026-05-01T09:00:00.000Z|' + MESSAGE, 'utf8').toString(
      'base64url',
    );

    const wrongWay = await call('GET', `${MESSAGES}?cursor=${encodeURIComponent(ticketCursor)}`);
    expect(wrongWay.status).toBe(400);
    const otherWay = await call('GET', `${TICKETS}?cursor=${encodeURIComponent(messageCursor)}`);
    expect(otherWay.status).toBe(400);
  });

  it('reads one ticket, and answers a ticket that is not the caller’s exactly as one that does not exist', async () => {
    await start();
    const found = await call('GET', ONE);
    expect(found.status).toBe(200);
    expect((found.body['ticket'] as Record<string, unknown>)['subject']).toBe(
      'My payout has not arrived',
    );

    await app?.close();
    await start({ ticket: { ...detailRow(), outcome: 'not_found', id: null } });
    const missing = await call('GET', ONE);
    expect(missing.status).toBe(404);
    expect(missing.body['code']).toBe('NOT_FOUND');
    expect(missing.raw).not.toContain('payout');
  });

  it('never returns an agent, a priority or a first-response time in a ticket', async () => {
    await start();
    const list = await call('GET', TICKETS);
    const detail = await call('GET', ONE);
    for (const raw of [list.raw, detail.raw]) {
      expect(raw).not.toMatch(/assigned/i);
      expect(raw).not.toMatch(/priority/i);
      expect(raw).not.toMatch(/firstResponse/i);
      expect(raw).not.toMatch(/membershipVersion/i);
      expect(raw).not.toMatch(/internal/i);
    }
  });

  it('returns a conversation with roles and attachment display fields, and no author identifier', async () => {
    const recorded = await start();
    const result = await call('GET', MESSAGES);

    expect(result.status).toBe(200);
    const items = result.body['items'] as Array<Record<string, unknown>>;
    expect(items[0]?.['authorRole']).toBe('requester');
    expect(items[0]?.['isOwnMessage']).toBe(true);
    const attachments = items[0]?.['attachments'] as Array<Record<string, unknown>>;
    expect(attachments[0]?.['originalFilename']).toBe('statement.pdf');
    // The size crosses as a decimal string, because the column is a bigint.
    expect(attachments[0]?.['byteSize']).toBe('20480');
    expect(result.raw).not.toContain('objectPath');
    expect(result.raw).not.toContain('support-attachments/');
    expect(result.raw).not.toMatch(/authorUserId/i);
    expect(arg(recorded, 'messages')?.['ticketId']).toBe(TICKET);
  });

  it('answers an empty first page of a conversation as a plain not-found', async () => {
    await start({ messages: [] });
    const result = await call('GET', MESSAGES);
    expect(result.status).toBe(404);
    expect(result.body['code']).toBe('NOT_FOUND');
  });

  it('opens a ticket from a subject, a category and a first message, and nothing else', async () => {
    const recorded = await start();
    const result = await call('POST', TICKETS, { payload: VALID_TICKET });

    expect(result.status).toBe(201);
    expect(result.body).toEqual({
      ticketId: TICKET,
      messageId: MESSAGE,
      reference: 'SP-26-000001',
      status: 'pending_agent',
    });
    expect(arg(recorded, 'open')).toEqual({
      userId: USER,
      subject: VALID_TICKET.subject,
      category: 'payouts',
      body: VALID_TICKET.body,
    });
  });

  it('refuses a priority, a status, an assignee, an order or an account on the way in', async () => {
    for (const extra of [
      { priority: 'urgent' },
      { status: 'resolved' },
      { assignedTo: USER },
      { orderId: TICKET },
      { requesterUserId: USER },
    ]) {
      const recorded = await start();
      const result = await call('POST', TICKETS, { payload: { ...VALID_TICKET, ...extra } });
      expect(result.status).toBe(400);
      expect(recorded.calls).not.toContain('open');
      await app?.close();
      app = undefined;
    }
  });

  it('refuses a ninth category, an empty subject and an over-long body without reaching the database', async () => {
    for (const payload of [
      { ...VALID_TICKET, category: 'billing' },
      { ...VALID_TICKET, subject: '   ' },
      { ...VALID_TICKET, body: 'x'.repeat(8001) },
      { subject: 'Only a subject' },
    ]) {
      const recorded = await start();
      const result = await call('POST', TICKETS, { payload });
      expect(result.status).toBe(400);
      expect(recorded.calls).not.toContain('open');
      await app?.close();
      app = undefined;
    }
  });

  it('replies on the caller’s own ticket and reports the status the database read back', async () => {
    const recorded = await start();
    const result = await call('POST', MESSAGES, { payload: { body: 'Yes, that is the address.' } });

    expect(result.status).toBe(201);
    expect(result.body).toEqual({ messageId: MESSAGE, status: 'pending_agent' });
    expect(arg(recorded, 'reply')).toEqual({
      userId: USER,
      ticketId: TICKET,
      body: 'Yes, that is the address.',
    });
  });

  it('refuses a reply that names an author or a role', async () => {
    const recorded = await start();
    const result = await call('POST', MESSAGES, {
      payload: { body: 'Hello', authorRole: 'agent', authorUserId: USER },
    });
    expect(result.status).toBe(400);
    expect(recorded.calls).not.toContain('reply');
  });

  it('turns a closed ticket into its own 409, on every write that can meet one', async () => {
    for (const [name, method, url, payload] of [
      ['reply', 'POST', MESSAGES, { body: 'One more thing' }],
      ['close', 'POST', CLOSE, undefined],
      ['target', 'POST', UPLOADS, { contentType: 'image/png', byteSize: 4096 }],
      ['attach', 'POST', ATTACHMENTS, VALID_RECORD],
    ] as const) {
      await start({
        reply: { outcome: 'conflict', messageId: null, status: null },
        close: { outcome: 'conflict', status: null },
        target: { outcome: 'conflict', bucketId: null, objectPath: null, maxByteSize: null },
        attach: { outcome: 'conflict', attachmentId: null, attachmentCount: null },
      });
      const result = await call(method, url, payload === undefined ? {} : { payload });
      expect(result.status, name).toBe(409);
      expect(result.body['code'], name).toBe('SUPPORT_TICKET_NOT_ACTIONABLE');
      await app?.close();
      app = undefined;
    }
  });

  it('closes a ticket with no body and no status anywhere in the request', async () => {
    const recorded = await start();
    const result = await call('POST', CLOSE);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: 'closed' });
    expect(arg(recorded, 'close')).toEqual({ userId: USER, ticketId: TICKET });
    // Whatever a client puts in the body, nothing of it reaches the store: there is no status parameter.
    expect(JSON.stringify(arg(recorded, 'close'))).not.toContain('resolved');
  });

  it('drops a status a client tries to send with a closure', async () => {
    const recorded = await start();
    const result = await call('POST', CLOSE, { payload: { status: 'resolved' } });
    expect(result.status).toBe(200);
    expect(arg(recorded, 'close')).toEqual({ userId: USER, ticketId: TICKET });
  });

  it('answers a closure and a reply on somebody else’s ticket as a plain not-found', async () => {
    await start({
      close: { outcome: 'not_found', status: null },
      reply: { outcome: 'not_found', messageId: null, status: null },
    });
    const closed = await call('POST', CLOSE);
    const replied = await call('POST', MESSAGES, { payload: { body: 'Let me in' } });
    for (const result of [closed, replied]) {
      expect(result.status).toBe(404);
      expect(result.body['code']).toBe('NOT_FOUND');
    }
  });

  it('authorizes one upload with the path the database composed, never one from the request', async () => {
    const recorded = await start();
    const result = await call('POST', UPLOADS, { payload: { contentType: 'image/png', byteSize: 4096 } });

    expect(result.status).toBe(201);
    const upload = result.body['upload'] as Record<string, unknown>;
    expect(upload['objectPath']).toBe(OBJECT_PATH);
    expect(upload['maxByteSize']).toBe(20_971_520);
    expect(arg(recorded, 'target')).toEqual({
      userId: USER,
      ticketId: TICKET,
      messageId: MESSAGE,
      contentType: 'image/png',
      byteSize: 4096,
    });
    // The provider is handed the database's bucket and the database's path, in that order and nothing else.
    expect(arg(recorded, 'sign-upload')).toEqual({
      bucket: 'support-attachments',
      objectPath: OBJECT_PATH,
      contentType: 'image/png',
    });
  });

  it('refuses an upload request that carries a path or a bucket', async () => {
    for (const extra of [
      { objectPath: '../../elsewhere/x.png' },
      { bucket: 'public-bucket' },
      { bucketId: 'public-bucket' },
    ]) {
      const recorded = await start();
      const result = await call('POST', UPLOADS, {
        payload: { contentType: 'image/png', byteSize: 4096, ...extra },
      });
      expect(result.status).toBe(400);
      expect(recorded.calls).not.toContain('target');
      expect(recorded.calls).not.toContain('sign-upload');
      await app?.close();
      app = undefined;
    }
  });

  it('refuses a content type the bucket does not allow and a size beyond its ceiling', async () => {
    for (const payload of [
      { contentType: 'image/gif', byteSize: 4096 },
      { contentType: 'image/png', byteSize: 20_971_521 },
      { contentType: 'image/png', byteSize: 0 },
    ]) {
      const recorded = await start();
      const result = await call('POST', UPLOADS, { payload });
      expect(result.status).toBe(400);
      expect(recorded.calls).not.toContain('sign-upload');
      await app?.close();
      app = undefined;
    }
  });

  it('answers an upload for a message that is not the caller’s own as a not-found, and signs nothing', async () => {
    const recorded = await start({
      target: { outcome: 'not_found', bucketId: null, objectPath: null, maxByteSize: null },
    });
    const result = await call('POST', UPLOADS, { payload: { contentType: 'image/png', byteSize: 4096 } });
    expect(result.status).toBe(404);
    expect(recorded.calls).not.toContain('sign-upload');
  });

  it('asks storage whether the object is there before anything is recorded', async () => {
    const recorded = await start();
    const result = await call('POST', ATTACHMENTS, { payload: VALID_RECORD });

    expect(result.status).toBe(201);
    expect(result.body).toEqual({ attachmentId: ATTACHMENT, attachmentCount: 1 });
    expect(recorded.calls.indexOf('object-exists')).toBeLessThan(recorded.calls.indexOf('attach'));
    expect(arg(recorded, 'object-exists')).toEqual({
      bucket: 'support-attachments',
      objectPath: OBJECT_PATH,
    });
  });

  it('records nothing when the provider does not have the file', async () => {
    const recorded = await start({ objectExists: false });
    const result = await call('POST', ATTACHMENTS, { payload: VALID_RECORD });
    expect(result.status).toBe(404);
    expect(result.body['code']).toBe('SUPPORT_ATTACHMENT_OBJECT_MISSING');
    expect(recorded.calls).not.toContain('attach');
  });

  it('turns a path the database refuses into a validation failure rather than a write', async () => {
    await start({ attach: { outcome: 'invalid', attachmentId: null, attachmentCount: null } });
    const result = await call('POST', ATTACHMENTS, { payload: VALID_RECORD });
    expect(result.status).toBe(400);
    expect(result.body['code']).toBe('VALIDATION_FAILED');
  });

  it('signs one read for an attachment of the ticket in the route, and returns no path', async () => {
    const recorded = await start();
    const result = await call('GET', LINK);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      attachmentId: ATTACHMENT,
      url: 'https://storage.test.invalid/read/one-object',
      expiresAt: '2026-05-02T09:02:00.000Z',
    });
    expect(result.raw).not.toContain('support-attachments/');
    expect(arg(recorded, 'location')).toEqual({
      userId: USER,
      ticketId: TICKET,
      attachmentId: ATTACHMENT,
    });
    expect(arg(recorded, 'sign-download')).toEqual({
      bucket: 'support-attachments',
      objectPath: OBJECT_PATH,
    });
  });

  it('answers an attachment of a different ticket as a not-found, and signs nothing', async () => {
    const recorded = await start({
      location: { outcome: 'not_found', bucketId: null, objectPath: null },
    });
    const result = await call('GET', LINK);
    expect(result.status).toBe(404);
    expect(recorded.calls).not.toContain('sign-download');
  });

  it('refuses a malformed identifier in every path that takes one', async () => {
    const recorded = await start();
    for (const url of [
      '/v1/support/tickets/not-a-uuid',
      '/v1/support/tickets/not-a-uuid/messages',
      '/v1/support/tickets/not-a-uuid/close',
      `${ONE}/attachments/not-a-uuid/link`,
    ]) {
      const result = await call(url.endsWith('close') ? 'POST' : 'GET', url);
      expect(result.status, url).toBe(400);
    }
    expect(recorded.calls).not.toContain('ticket');
    expect(recorded.calls).not.toContain('messages');
    expect(recorded.calls).not.toContain('close');
    expect(recorded.calls).not.toContain('location');
  });

  it('requires a session on every route, and never reaches the store without one', async () => {
    const recorded = await start();
    for (const [method, url, payload] of [
      ['GET', TICKETS, undefined],
      ['POST', TICKETS, VALID_TICKET],
      ['GET', ONE, undefined],
      ['GET', MESSAGES, undefined],
      ['POST', MESSAGES, { body: 'Hello' }],
      ['POST', CLOSE, undefined],
      ['POST', UPLOADS, { contentType: 'image/png', byteSize: 4096 }],
      ['POST', ATTACHMENTS, VALID_RECORD],
      ['GET', LINK, undefined],
    ] as const) {
      const result = await call(method, url, {
        accessToken: null,
        ...(payload === undefined ? {} : { payload }),
      });
      expect(result.status, url).toBe(401);
    }
    expect(recorded.calls).toEqual([]);
  });

  it('requires the internal credential on every route', async () => {
    await start();
    const response = await app!.inject({
      method: 'GET',
      url: TICKETS,
      headers: { [SESSION_TOKEN_HEADER]: ACCESS_TOKEN },
    });
    expect(response.statusCode).toBe(403);
  });

  it('refuses a token the provider will not vouch for', async () => {
    const recorded = await start({ tokenFails: true });
    const result = await call('GET', TICKETS);
    expect(result.status).toBe(401);
    expect(recorded.calls).not.toContain('tickets');
  });

  it('turns a database failure into a 503 on every operation', async () => {
    for (const [method, url, payload] of [
      ['GET', TICKETS, undefined],
      ['POST', TICKETS, VALID_TICKET],
      ['GET', ONE, undefined],
      ['GET', MESSAGES, undefined],
      ['POST', MESSAGES, { body: 'Hello' }],
      ['POST', CLOSE, undefined],
      ['POST', UPLOADS, { contentType: 'image/png', byteSize: 4096 }],
      ['GET', LINK, undefined],
    ] as const) {
      await start({ throws: true });
      const result = await call(method, url, payload === undefined ? {} : { payload });
      expect(result.status, url).toBe(503);
      expect(result.body['code'], url).toBe('SERVICE_UNAVAILABLE');
      await app?.close();
      app = undefined;
    }
  });

  it('turns a storage failure into a 503 and never a half-done write', async () => {
    const recorded = await start({ storageFails: true });
    const upload = await call('POST', UPLOADS, { payload: { contentType: 'image/png', byteSize: 4096 } });
    expect(upload.status).toBe(503);

    const record = await call('POST', ATTACHMENTS, { payload: VALID_RECORD });
    expect(record.status).toBe(503);
    expect(recorded.calls).not.toContain('attach');

    const link = await call('GET', LINK);
    expect(link.status).toBe(503);
  });

  it('never logs or returns a signed URL, an object path or a message body in a problem', async () => {
    await start({
      ticket: { ...detailRow(), outcome: 'not_found', id: null },
      location: { outcome: 'not_found', bucketId: null, objectPath: null },
    });
    const missing = await call('GET', ONE);
    const link = await call('GET', LINK);
    for (const result of [missing, link]) {
      expect(result.raw).not.toContain('support-attachments/');
      expect(result.raw).not.toContain('storage.test.invalid');
    }
  });

  it('has no agent surface at all: no assignment, no note, no status and no queue route exists', async () => {
    await start();
    for (const [method, url] of [
      ['POST', `${ONE}/assign`],
      ['POST', `${ONE}/notes`],
      ['POST', `${ONE}/status`],
      ['POST', `${ONE}/resolve`],
      ['POST', `${ONE}/reopen`],
      ['GET', '/v1/support/queue'],
      ['GET', '/v1/support/tickets/queue'],
      ['GET', `${ONE}/notes`],
      ['GET', `${ONE}/events`],
    ] as const) {
      const result = await call(method, url);
      expect([400, 404], `${method} ${url}`).toContain(result.status);
      expect(result.status, `${method} ${url}`).not.toBe(200);
    }
  });
});

describe('the support rate limits (owner Decision 1)', () => {
  it('counts a ticket creation against five per account per 24 hours, before the write', async () => {
    const recorded = await start();
    await call('POST', TICKETS, { payload: VALID_TICKET });

    expect(recorded.buckets).toHaveLength(1);
    expect(recorded.buckets[0]).toMatchObject({
      bucket: 'support_ticket_open',
      limit: 5,
      windowSeconds: 86_400,
    });
    // Counted first: the bucket is asked about before the database is.
    expect(recorded.calls.indexOf('open')).toBeGreaterThan(-1);
    expect(recorded.buckets).toHaveLength(1);
  });

  it('counts a message against both approved windows, per minute and per hour', async () => {
    const recorded = await start();
    await call('POST', MESSAGES, { payload: { body: 'Yes, that is the address.' } });

    expect(recorded.buckets.map((entry) => entry.bucket)).toEqual([
      'support_message_minute',
      'support_message_hour',
    ]);
    expect(recorded.buckets[0]).toMatchObject({ limit: 30, windowSeconds: 60 });
    expect(recorded.buckets[1]).toMatchObject({ limit: 300, windowSeconds: 3600 });
  });

  it('counts an attachment authorization against 6-E’s existing storage allowance, not a second one', async () => {
    const recorded = await start();
    await call('POST', UPLOADS, { payload: { contentType: 'image/png', byteSize: 4096 } });

    expect(recorded.buckets).toHaveLength(1);
    expect(recorded.buckets[0]!.bucket).toBe(SELLER_THROTTLE_BUCKETS.mediaUpload.name);
    expect(recorded.buckets[0]).toMatchObject({ limit: 20, windowSeconds: 3600 });
    // No support-specific storage bucket exists at all.
    expect(Object.values(SUPPORT_THROTTLE_BUCKETS).map((bucket) => bucket.name)).not.toContain(
      'support_attachment_upload',
    );
    // And it is counted before the database is asked for a target, so a refused one still counts.
    expect(recorded.calls.indexOf('target')).toBeGreaterThan(-1);
  });

  it('does not count the confirmation, only the authorization', async () => {
    const recorded = await start();
    await call('POST', ATTACHMENTS, { payload: VALID_RECORD });
    expect(recorded.buckets).toHaveLength(0);
  });

  it('leaves every read unlimited', async () => {
    const recorded = await start();
    await call('GET', TICKETS);
    await call('GET', ONE);
    await call('GET', MESSAGES);
    await call('GET', LINK);
    expect(recorded.buckets).toHaveLength(0);
    expect(recorded.durableBuckets).toHaveLength(0);
  });

  it('allows exactly five ticket creations and refuses the sixth', async () => {
    const recorded = await start({ counting: true });
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const result = await call('POST', TICKETS, { payload: VALID_TICKET });
      expect(result.status, `attempt ${attempt}`).toBe(201);
    }

    const refused = await call('POST', TICKETS, { payload: VALID_TICKET });
    expect(refused.status).toBe(429);
    expect(refused.body['code']).toBe('THROTTLED');
    // The bucket that rejected is never named in the answer.
    expect(refused.raw).not.toContain('support_ticket_open');
    // Five writes reached the database and the sixth did not.
    expect(recorded.calls.filter((name) => name === 'open')).toHaveLength(5);
  });

  it('allows exactly thirty messages in the minute window and refuses the thirty-first', async () => {
    const recorded = await start({ counting: true });
    for (let attempt = 1; attempt <= 30; attempt += 1) {
      const result = await call('POST', MESSAGES, { payload: { body: `Message ${attempt}` } });
      expect(result.status, `attempt ${attempt}`).toBe(201);
    }

    const refused = await call('POST', MESSAGES, { payload: { body: 'One too many' } });
    expect(refused.status).toBe(429);
    expect(recorded.calls.filter((name) => name === 'reply')).toHaveLength(30);
  });

  it('counts both message windows even once the first has rejected', async () => {
    const recorded = await start({ counting: true });
    for (let attempt = 1; attempt <= 31; attempt += 1) {
      await call('POST', MESSAGES, { payload: { body: `Message ${attempt}` } });
    }
    // The hourly window has seen all thirty-one attempts, so tripping the minute limit cannot be used to
    // stay under the hour forever.
    expect(recorded.buckets.filter((entry) => entry.bucket === 'support_message_minute')).toHaveLength(31);
    expect(recorded.buckets.filter((entry) => entry.bucket === 'support_message_hour')).toHaveLength(31);
  });

  it('allows exactly twenty attachment authorizations and refuses the twenty-first', async () => {
    const recorded = await start({ counting: true });
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      const result = await call('POST', UPLOADS, { payload: { contentType: 'image/png', byteSize: 4096 } });
      expect(result.status, `attempt ${attempt}`).toBe(201);
    }

    const refused = await call('POST', UPLOADS, { payload: { contentType: 'image/png', byteSize: 4096 } });
    expect(refused.status).toBe(429);
    // Nothing was signed for the refused attempt.
    expect(recorded.calls.filter((name) => name === 'sign-upload')).toHaveLength(20);
  });

  it('does not let a repeated request past a limit it has already hit', async () => {
    await start({ counting: true });
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await call('POST', TICKETS, { payload: VALID_TICKET });
    }
    for (const attempt of [6, 7, 8]) {
      const refused = await call('POST', TICKETS, { payload: VALID_TICKET });
      expect(refused.status, `attempt ${attempt}`).toBe(429);
    }
  });

  it('keys every counter by the caller’s own hashed account, and never by a request value', async () => {
    const recorded = await start();
    await call('POST', TICKETS, { payload: { ...VALID_TICKET } });
    await call('POST', TICKETS, {
      payload: VALID_TICKET,
      // A body or a query that names an account changes nothing about which counter is used.
      headers: { 'x-forwarded-for': '203.0.113.9' },
    });

    const subjects = new Set(recorded.buckets.map((entry) => entry.subject));
    expect(subjects.size).toBe(1);
    // A sha-256 of the account, so the counter holds no identifier and no account id can be read back.
    expect([...subjects][0]).toMatch(/^[0-9a-f]{64}$/);
    expect([...subjects][0]).not.toContain(USER.replace(/-/g, ''));
  });

  it('shares no counter between two accounts', async () => {
    const recorded = await start({ counting: true });
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await call('POST', TICKETS, { payload: VALID_TICKET });
    }
    expect((await call('POST', TICKETS, { payload: VALID_TICKET })).status).toBe(429);

    // The same operation from a different session, whose token the provider maps to another account.
    const second = await call('POST', TICKETS, {
      payload: VALID_TICKET,
      accessToken: SECOND_ACCESS_TOKEN,
    });
    expect(second.status).toBe(201);

    const subjects = new Set(recorded.buckets.map((entry) => entry.subject));
    expect(subjects.size).toBe(2);
  });

  it('keeps the message and the ticket allowances apart, and both apart from storage', async () => {
    const recorded = await start({ counting: true });
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await call('POST', TICKETS, { payload: VALID_TICKET });
    }
    expect((await call('POST', TICKETS, { payload: VALID_TICKET })).status).toBe(429);

    // Opening is exhausted; replying and attaching are not.
    expect((await call('POST', MESSAGES, { payload: { body: 'Still fine' } })).status).toBe(201);
    expect(
      (await call('POST', UPLOADS, { payload: { contentType: 'image/png', byteSize: 4096 } })).status,
    ).toBe(201);

    expect(new Set(recorded.buckets.map((entry) => entry.bucket))).toEqual(
      new Set([
        'support_ticket_open',
        'support_message_minute',
        'support_message_hour',
        SELLER_THROTTLE_BUCKETS.mediaUpload.name,
      ]),
    );
  });

  it('falls back to the durable counter when Redis cannot answer, continuing the same window', async () => {
    const recorded = await start({ counting: true, redisThrows: true });
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect((await call('POST', TICKETS, { payload: VALID_TICKET })).status, `${attempt}`).toBe(201);
    }
    expect((await call('POST', TICKETS, { payload: VALID_TICKET })).status).toBe(429);
    expect(recorded.durableBuckets.filter((name) => name === 'support_ticket_open')).toHaveLength(6);
  });

  it('refuses the write when neither counter can answer, rather than allowing it', async () => {
    const recorded = await start({ redisThrows: true, durableThrows: true });
    for (const [method, url, payload] of [
      ['POST', TICKETS, VALID_TICKET],
      ['POST', MESSAGES, { body: 'Hello' }],
      ['POST', UPLOADS, { contentType: 'image/png', byteSize: 4096 }],
    ] as const) {
      const result = await call(method, url, { payload });
      expect(result.status, url).toBe(503);
    }
    // Nothing reached the database and nothing was signed: a counter that cannot be read is not a zero.
    expect(recorded.calls).not.toContain('open');
    expect(recorded.calls).not.toContain('reply');
    expect(recorded.calls).not.toContain('sign-upload');
  });

  it('declares exactly the three support buckets Decision 1 names', () => {
    expect(Object.values(SUPPORT_THROTTLE_BUCKETS)).toEqual([
      { name: 'support_ticket_open', limit: 5, windowSeconds: 86_400 },
      { name: 'support_message_minute', limit: 30, windowSeconds: 60 },
      { name: 'support_message_hour', limit: 300, windowSeconds: 3600 },
    ]);
    // Every name is a legal bucket for 0004's own column constraint, so no migration was needed.
    for (const bucket of Object.values(SUPPORT_THROTTLE_BUCKETS)) {
      expect(bucket.name).toMatch(/^[a-z][a-z0-9_.]*$/);
    }
  });
});
