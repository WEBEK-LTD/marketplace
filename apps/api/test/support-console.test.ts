import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { SESSION_TOKEN_HEADER } from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { STAFF_CONSOLE_STORE, type StaffConsoleRow } from '../src/admin/staff-console.service.js';
import {
  SUPPORT_CONSOLE_STORE,
  type SupportAssignedRow,
  type SupportAssignmentRow,
  type SupportConsoleAttachmentRow,
  type SupportConsoleDecisionRow,
  type SupportConsoleMessagePostRow,
  type SupportConsoleMessageRow,
  type SupportConsoleTicketRow,
  type SupportInternalNoteRow,
  type SupportNoteAddRow,
  type SupportQueueRow,
} from '../src/admin/support-console.service.js';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { AuthenticationRequiredError } from '../src/auth/auth-errors.js';
import { SUPABASE_AUTH_CLIENT } from '../src/auth/login.service.js';
import {
  SELLER_MEDIA_STORAGE,
  SellerMediaStorageUnavailableError,
} from '../src/sellers/seller-media.storage.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * The support agent console at the API boundary (Phase 7-L).
 *
 * What is being held to account:
 *
 *   * **the authorization matrix**, on every one of the eleven operations — a guest, a buyer, a seller, a
 *     moderator, staff at `aal1` and staff holding only the read key on a write all receive exactly what
 *     somebody asking about a route that does not exist receives;
 *   * **read does not write** — a colleague holding `support.ticket.read` alone reads the queue, the ticket,
 *     the conversation, the notes and a link, and is refused all four mutations;
 *   * **nothing about the caller is in a request** — no account, role, permission, assurance level or
 *     assignee in a body, a query or a path, and what the store is called with is always the account the
 *     provider vouched for and the level read from that same validated token;
 *   * **no colleague's identity leaves the API** — no response carries an assignee, an author identifier or
 *     a membership version, whatever the database sends;
 *   * **claiming assigns the caller and nobody else** — there is no field for an agent anywhere;
 *   * **the decision is a closed pair** — `resolved` and `closed` only, with every other status refused
 *     before the database is reached, and no reopen route existing at all;
 *   * **the attachment path is the database's** — the request carries none, and the provider is handed the
 *     bucket and path the row named;
 *   * **no support notification and no email** — this surface calls neither.
 */

const STAFF = '11111111-1111-4111-8111-111111111111';
const READ = 'support.ticket.read';
const MANAGE = 'support.ticket.manage';
const TICKET = 'd5000000-0000-4000-8000-000000000001';
const MESSAGE = 'd5000000-0000-4000-8000-0000000000a1';
const NOTE = 'd5000000-0000-4000-8000-0000000000c1';
const ATTACHMENT = 'd5000000-0000-4000-8000-0000000000b1';
const OBJECT_PATH = `support-attachments/${TICKET}/${MESSAGE}/f47ac10b-58cc-4372-a567-0e02b2c3d479.png`;
/** The account of a colleague who holds the ticket. It must never reach a response. */
const OTHER_AGENT = '99999999-9999-4999-8999-999999999999';

function token(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.c2lnbmF0dXJl`;
}

const ACCESS_TOKEN = token({ sub: STAFF, aal: 'aal2' });
const AAL1_TOKEN = token({ sub: STAFF, aal: 'aal1' });

/** Everything an administrator holds except the two support keys. */
const WITHOUT_SUPPORT = [
  'audit.read',
  'catalog.listing.read',
  'moderation.report.read',
  'sellers.profile.read',
  'users.profile.read',
];

/** What a moderator holds, as 0033 grants it: neither support key. */
const MODERATOR = [
  'catalog.listing.moderate',
  'catalog.listing.read',
  'moderation.action.read',
  'moderation.report.manage',
  'moderation.report.read',
  'reviews.review.moderate',
  'reviews.review.read',
  'sellers.profile.read',
  'users.profile.read',
];

/** What a support agent holds, as 0033 grants it. */
const AGENT = [READ, MANAGE, 'security.recovery.review', 'users.profile.read', 'orders.order.read'];
/** A colleague who may follow a ticket and change nothing. */
const READ_ONLY = [READ, 'users.profile.read'];

const SUBJECT = 'Canary ticket about a payout';
const REQUESTER_NAME = 'Canary Requester';
const NOTE_BODY = 'Canary internal note, staff only.';

function staffRow(overrides: Partial<StaffConsoleRow> = {}): StaffConsoleRow {
  return {
    hasConsoleRole: true,
    requiresStepUp: false,
    roles: ['support_agent'],
    permissions: AGENT,
    ...overrides,
  };
}

function queueRow(overrides: Partial<SupportQueueRow> = {}): SupportQueueRow {
  return {
    id: TICKET,
    reference: 'SP-26-000001',
    subject: SUBJECT,
    category: 'payouts',
    priority: 'normal',
    status: 'pending_agent',
    requesterName: REQUESTER_NAME,
    messageCount: 2,
    attachmentCount: 1,
    noteCount: 1,
    lastMessageAt: new Date('2026-05-02T09:00:00.000Z'),
    createdAt: new Date('2026-05-01T09:00:00.000Z'),
    ...overrides,
  };
}

function assignedRow(overrides: Partial<SupportAssignedRow> = {}): SupportAssignedRow {
  return { ...queueRow(), resolvedAt: null, closedAt: null, ...overrides };
}

function ticketRow(overrides: Partial<SupportConsoleTicketRow> = {}): SupportConsoleTicketRow {
  return {
    outcome: 'found',
    id: TICKET,
    reference: 'SP-26-000001',
    subject: SUBJECT,
    category: 'payouts',
    priority: 'normal',
    status: 'pending_agent',
    requesterName: REQUESTER_NAME,
    isMine: true,
    isAssigned: true,
    messageCount: 2,
    noteCount: 1,
    firstResponseAt: null,
    lastMessageAt: new Date('2026-05-02T09:00:00.000Z'),
    resolvedAt: null,
    closedAt: null,
    createdAt: new Date('2026-05-01T09:00:00.000Z'),
    ...overrides,
  };
}

function messageRow(overrides: Partial<SupportConsoleMessageRow> = {}): SupportConsoleMessageRow {
  return {
    id: MESSAGE,
    authorRole: 'requester',
    isOwnMessage: false,
    body: 'The payout has not arrived.',
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

function noteRow(overrides: Partial<SupportInternalNoteRow> = {}): SupportInternalNoteRow {
  return {
    id: NOTE,
    isOwnNote: true,
    body: NOTE_BODY,
    createdAt: new Date('2026-05-02T09:00:00.000Z'),
    ...overrides,
  };
}

interface Recorded {
  readonly calls: string[];
  readonly args: Array<{ readonly name: string; readonly input: Record<string, unknown> }>;
}

interface Doubles {
  readonly permissions?: readonly string[];
  readonly queue?: readonly SupportQueueRow[];
  readonly assigned?: readonly SupportAssignedRow[];
  readonly ticket?: SupportConsoleTicketRow;
  readonly messages?: readonly SupportConsoleMessageRow[];
  readonly notes?: readonly SupportInternalNoteRow[];
  readonly claim?: SupportAssignmentRow;
  readonly release?: SupportAssignmentRow;
  readonly reply?: SupportConsoleMessagePostRow;
  readonly note?: SupportNoteAddRow;
  readonly decision?: SupportConsoleDecisionRow;
  readonly attachment?: SupportConsoleAttachmentRow;
  readonly storageFails?: boolean;
  readonly tokenFails?: boolean;
  readonly throws?: boolean;
}

let app: NestFastifyApplication | undefined;

async function start(doubles: Doubles = {}): Promise<Recorded> {
  const recorded: Recorded = { calls: [], args: [] };
  const record = <T>(name: string, input: unknown, value: T): T => {
    recorded.calls.push(name);
    recorded.args.push({
      name,
      input: (typeof input === 'object' && input !== null ? input : { input }) as Record<string, unknown>,
    });
    if (doubles.throws === true) throw new Error('database unavailable');
    return value;
  };

  const storage = {
    signUpload: async () => {
      throw new Error('the console never signs an upload');
    },
    objectExists: async () => {
      throw new Error('the console never asks whether an object exists');
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
      getUser: async () => {
        recorded.calls.push('get-user');
        if (doubles.tokenFails === true) throw new AuthenticationRequiredError();
        return { id: STAFF, phone: null };
      },
    })
    .overrideProvider(STAFF_CONSOLE_STORE)
    .useValue({
      staffConsoleAccess: async (input: { userId: string; isAal2: boolean }) => {
        recorded.calls.push('console-access');
        recorded.args.push({ name: 'console-access', input });
        // 0068's own behaviour: a role that requires MFA counts for nothing at aal1, so the effective set is
        // empty. Modelled here rather than asserted around, because that is what the database does.
        const granted = doubles.permissions === undefined ? AGENT : [...doubles.permissions];
        return staffRow({ permissions: input.isAal2 ? granted : [] });
      },
      buyerProfile: async (userId: string) => ({ id: userId, displayName: 'Nadia', localeCode: 'en' }),
    })
    .overrideProvider(SELLER_MEDIA_STORAGE)
    .useValue(storage)
    .overrideProvider(SUPPORT_CONSOLE_STORE)
    .useValue({
      supportQueueForAgent: async (input: unknown) =>
        record('queue', input, doubles.queue ?? [queueRow()]),
      supportTicketsAssignedToAgent: async (input: unknown) =>
        record('assigned', input, doubles.assigned ?? [assignedRow()]),
      supportTicketForAgent: async (input: unknown) =>
        record('ticket', input, doubles.ticket ?? ticketRow()),
      supportTicketMessagesForAgent: async (input: unknown) =>
        record('messages', input, doubles.messages ?? [messageRow()]),
      supportTicketNotesForAgent: async (input: unknown) =>
        record('notes', input, doubles.notes ?? [noteRow()]),
      supportAttachmentForAgent: async (input: unknown) =>
        record(
          'attachment',
          input,
          doubles.attachment ?? {
            outcome: 'authorized',
            bucketId: 'support-attachments',
            objectPath: OBJECT_PATH,
          },
        ),
      supportTicketClaimForAgent: async (input: unknown) =>
        record(
          'claim',
          input,
          doubles.claim ?? { outcome: 'assigned', status: 'pending_agent', isMine: true },
        ),
      supportTicketReleaseForAgent: async (input: unknown) =>
        record(
          'release',
          input,
          doubles.release ?? { outcome: 'released', status: 'pending_agent', isMine: false },
        ),
      supportMessagePostForAgent: async (input: unknown) =>
        record(
          'reply',
          input,
          doubles.reply ?? { outcome: 'posted', messageId: MESSAGE, status: 'pending_requester' },
        ),
      supportNoteAddForAgent: async (input: unknown) =>
        record('note', input, doubles.note ?? { outcome: 'added', noteId: NOTE, noteCount: 2 }),
      supportTicketCloseForAgent: async (input: unknown) =>
        record('decision', input, doubles.decision ?? { outcome: 'closed', status: 'resolved' }),
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
  options: {
    accessToken?: string | null;
    payload?: unknown;
    credential?: string | null;
  } = {},
): Promise<Result> {
  const headers: Record<string, string> = {};
  const credential = options.credential === undefined ? TEST_INTERNAL_CREDENTIAL : options.credential;
  if (credential !== null) headers[INTERNAL_CREDENTIAL_HEADER] = credential;
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

const QUEUE = '/v1/admin/support/queue';
const ASSIGNED = '/v1/admin/support/assigned';
const ONE = `/v1/admin/support/tickets/${TICKET}`;
const MESSAGES = `${ONE}/messages`;
const NOTES = `${ONE}/notes`;
const CLAIM = `${ONE}/claim`;
const RELEASE = `${ONE}/release`;
const DECISION = `${ONE}/decision`;
const LINK = `${ONE}/attachments/${ATTACHMENT}/link`;

/** Every read, and every write, as a method/url/payload triple. */
const READS = [
  ['GET', QUEUE, undefined],
  ['GET', ASSIGNED, undefined],
  ['GET', ONE, undefined],
  ['GET', MESSAGES, undefined],
  ['GET', NOTES, undefined],
  ['GET', LINK, undefined],
] as const;

const WRITES = [
  ['POST', MESSAGES, { body: 'A reply from support.' }],
  ['POST', NOTES, { body: 'A note for colleagues.' }],
  ['POST', CLAIM, undefined],
  ['POST', RELEASE, undefined],
  ['POST', DECISION, { status: 'resolved' }],
] as const;

const arg = (recorded: Recorded, name: string): Record<string, unknown> | undefined =>
  recorded.args.find((entry) => entry.name === name)?.input;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('the authorization matrix', () => {
  it('answers every operation for an agent at aal2 holding both keys', async () => {
    for (const [method, url, payload] of [...READS, ...WRITES]) {
      await start();
      const result = await call(method, url, payload === undefined ? {} : { payload });
      expect([200, 201], `${method} ${url}`).toContain(result.status);
      await app?.close();
      app = undefined;
    }
  });

  it('refuses every operation at aal1, as a plain not-found, without reaching the store', async () => {
    for (const [method, url, payload] of [...READS, ...WRITES]) {
      const recorded = await start();
      const result = await call(method, url, {
        accessToken: AAL1_TOKEN,
        ...(payload === undefined ? {} : { payload }),
      });
      expect(result.status, `${method} ${url}`).toBe(404);
      expect(result.body['code'], `${method} ${url}`).toBe('NOT_FOUND');
      // The effective set is empty at aal1, so nothing downstream is even asked.
      expect(recorded.calls.filter((name) => name !== 'get-user' && name !== 'console-access')).toEqual([]);
      await app?.close();
      app = undefined;
    }
  });

  it('refuses every operation for a moderator', async () => {
    for (const [method, url, payload] of [...READS, ...WRITES]) {
      const recorded = await start({ permissions: MODERATOR });
      const result = await call(method, url, payload === undefined ? {} : { payload });
      expect(result.status, `${method} ${url}`).toBe(404);
      expect(recorded.calls.filter((name) => name !== 'get-user' && name !== 'console-access')).toEqual([]);
      await app?.close();
      app = undefined;
    }
  });

  it('refuses every operation for staff holding neither support key', async () => {
    for (const [method, url, payload] of [...READS, ...WRITES]) {
      await start({ permissions: WITHOUT_SUPPORT });
      const result = await call(method, url, payload === undefined ? {} : { payload });
      expect(result.status, `${method} ${url}`).toBe(404);
      await app?.close();
      app = undefined;
    }
  });

  it('refuses every operation for a caller with no permissions at all', async () => {
    for (const [method, url, payload] of [...READS, ...WRITES]) {
      await start({ permissions: [] });
      const result = await call(method, url, payload === undefined ? {} : { payload });
      expect(result.status, `${method} ${url}`).toBe(404);
      await app?.close();
      app = undefined;
    }
  });

  it('lets a colleague with read alone read everything and change nothing', async () => {
    for (const [method, url] of READS) {
      await start({ permissions: READ_ONLY });
      const result = await call(method, url);
      expect(result.status, `${method} ${url}`).toBe(200);
      await app?.close();
      app = undefined;
    }

    for (const [method, url, payload] of WRITES) {
      const recorded = await start({ permissions: READ_ONLY });
      const result = await call(method, url, payload === undefined ? {} : { payload });
      expect(result.status, `${method} ${url}`).toBe(404);
      // Read is not manage: the write never reaches the database.
      expect(recorded.calls).not.toContain('claim');
      expect(recorded.calls).not.toContain('release');
      expect(recorded.calls).not.toContain('reply');
      expect(recorded.calls).not.toContain('note');
      expect(recorded.calls).not.toContain('decision');
      await app?.close();
      app = undefined;
    }
  });

  it('requires a session and the internal credential on every operation', async () => {
    for (const [method, url, payload] of [...READS, ...WRITES]) {
      const recorded = await start();
      const anonymous = await call(method, url, {
        accessToken: null,
        ...(payload === undefined ? {} : { payload }),
      });
      expect(anonymous.status, `${method} ${url}`).toBe(401);

      const uncredentialed = await call(method, url, {
        credential: null,
        ...(payload === undefined ? {} : { payload }),
      });
      expect(uncredentialed.status, `${method} ${url}`).toBe(403);
      expect(recorded.calls).not.toContain('console-access');
      await app?.close();
      app = undefined;
    }
  });

  it('refuses a token the provider will not vouch for', async () => {
    const recorded = await start({ tokenFails: true });
    const result = await call('GET', QUEUE);
    expect(result.status).toBe(401);
    expect(recorded.calls).not.toContain('queue');
  });

  it('passes the account and the level from the validated token, never from a request', async () => {
    const recorded = await start();
    await call('GET', `${QUEUE}?userId=${OTHER_AGENT}&isAal2=true&permission=${MANAGE}`);
    expect(arg(recorded, 'queue')).toMatchObject({ userId: STAFF, isAal2: true });
    expect(JSON.stringify(recorded.args)).not.toContain(OTHER_AGENT);
    expect(JSON.stringify(recorded.args)).not.toContain('permission');
  });
});

describe('the queue and the agent’s own list', () => {
  it('reads the queue with the caller’s account and one row of overshoot', async () => {
    const recorded = await start();
    const result = await call('GET', QUEUE);

    expect(result.status).toBe(200);
    const items = result.body['items'] as Array<Record<string, unknown>>;
    expect(items[0]?.['requesterName']).toBe(REQUESTER_NAME);
    expect(items[0]?.['priority']).toBe('normal');
    expect(arg(recorded, 'queue')).toMatchObject({ userId: STAFF, isAal2: true, limit: 21 });
    expect(result.body['nextCursor']).toBeNull();
  });

  it('reads the two lists through two operations, neither naming a party', async () => {
    const recorded = await start();
    await call('GET', QUEUE);
    await call('GET', ASSIGNED);
    expect(recorded.calls).toContain('queue');
    expect(recorded.calls).toContain('assigned');
    // No role, side or agent parameter exists on either.
    expect(JSON.stringify(recorded.args)).not.toContain('assignedTo');
  });

  it('issues a cursor per list, and refuses one from the other', async () => {
    const many = Array.from({ length: 21 }, (_, index) =>
      queueRow({
        id: `d5000000-0000-4000-8000-0000000${String(index).padStart(5, '0')}`,
        createdAt: new Date(Date.UTC(2026, 4, 1, 9, 0, index)),
      }),
    );
    await start({ queue: many, assigned: many.map((row) => ({ ...row, resolvedAt: null, closedAt: null })) });

    const queue = await call('GET', QUEUE);
    const assigned = await call('GET', ASSIGNED);
    const queueCursor = String(queue.body['nextCursor']);
    const assignedCursor = String(assigned.body['nextCursor']);
    expect(queueCursor).not.toBe('null');
    expect(assignedCursor).not.toBe('null');
    expect(queueCursor).not.toBe(assignedCursor);

    // Each reader takes its own kind and refuses the other's.
    expect((await call('GET', `${QUEUE}?cursor=${encodeURIComponent(queueCursor)}`)).status).toBe(200);
    expect((await call('GET', `${QUEUE}?cursor=${encodeURIComponent(assignedCursor)}`)).status).toBe(400);
    expect((await call('GET', `${ASSIGNED}?cursor=${encodeURIComponent(queueCursor)}`)).status).toBe(400);
    const refused = await call('GET', `${QUEUE}?cursor=not!base64url`);
    expect(refused.status).toBe(400);
    expect(refused.body['code']).toBe('SUPPORT_TICKETS_CURSOR_INVALID');
  });

  it('refuses a limit that is not one, and clamps what it passes', async () => {
    const recorded = await start();
    expect((await call('GET', `${QUEUE}?limit=abc`)).status).toBe(400);
    expect((await call('GET', `${QUEUE}?limit=0`)).status).toBe(400);
    await call('GET', `${QUEUE}?limit=50`);
    expect(arg(recorded, 'queue')).toMatchObject({ limit: 51 });
  });

  it('returns an empty queue as an empty page, not as a refusal', async () => {
    await start({ queue: [] });
    const result = await call('GET', QUEUE);
    expect(result.status).toBe(200);
    expect(result.body['items']).toEqual([]);
  });
});

describe('what the console never discloses', () => {
  it('returns no assignee, author identifier or membership version, whatever the database sends', async () => {
    await start({
      // A database that has drifted and sends more than the contract allows.
      queue: [{ ...queueRow(), assignedTo: OTHER_AGENT } as SupportQueueRow],
      ticket: { ...ticketRow(), assignedTo: OTHER_AGENT } as SupportConsoleTicketRow,
      messages: [{ ...messageRow(), authorUserId: OTHER_AGENT } as SupportConsoleMessageRow],
      notes: [{ ...noteRow(), authorUserId: OTHER_AGENT } as SupportInternalNoteRow],
    });

    for (const [method, url] of READS.filter(([, url]) => url !== LINK)) {
      const result = await call(method, url);
      expect(result.status, url).toBe(200);
      expect(result.raw, url).not.toContain(OTHER_AGENT);
      expect(result.raw, url).not.toMatch(/assignedTo/i);
      expect(result.raw, url).not.toMatch(/authorUserId/i);
      expect(result.raw, url).not.toMatch(/membershipVersion/i);
    }
  });

  it('returns no storage path anywhere, including on the message that has an attachment', async () => {
    await start();
    for (const [method, url] of READS) {
      const result = await call(method, url);
      expect(result.raw, url).not.toContain('support-attachments/');
      expect(result.raw, url).not.toContain('objectPath');
    }
  });

  it('names no permission key and no role in any response', async () => {
    await start();
    for (const [method, url] of READS) {
      const result = await call(method, url);
      expect(result.raw, url).not.toContain('support.ticket');
      expect(result.raw, url).not.toContain('support_agent');
      expect(result.raw, url).not.toContain('aal2');
    }
  });

  it('says only whether a ticket is the caller’s, and whether anybody holds it', async () => {
    await start({ ticket: ticketRow({ isMine: false, isAssigned: false }) });
    const result = await call('GET', ONE);
    const ticket = result.body['ticket'] as Record<string, unknown>;
    expect(ticket['isMine']).toBe(false);
    expect(ticket['isAssigned']).toBe(false);
    expect(Object.keys(ticket)).not.toContain('assignedTo');
  });
});

describe('internal notes', () => {
  it('reads them on the console, with the read key', async () => {
    const recorded = await start({ permissions: READ_ONLY });
    const result = await call('GET', NOTES);

    expect(result.status).toBe(200);
    const items = result.body['items'] as Array<Record<string, unknown>>;
    expect(items[0]?.['body']).toBe(NOTE_BODY);
    expect(items[0]?.['isOwnNote']).toBe(true);
    expect(Object.keys(items[0] ?? {}).sort()).toEqual(['body', 'createdAt', 'id', 'isOwnNote']);
    expect(arg(recorded, 'notes')).toMatchObject({ userId: STAFF, isAal2: true });
  });

  it('returns an empty note list as an empty page rather than a not-found', async () => {
    await start({ notes: [] });
    const result = await call('GET', NOTES);
    expect(result.status).toBe(200);
    expect(result.body['items']).toEqual([]);
  });

  it('writes one with the manage key, and sends the body alone', async () => {
    const recorded = await start();
    const result = await call('POST', NOTES, {
      payload: { body: 'A note for colleagues.', authorUserId: OTHER_AGENT, ticketId: 'elsewhere' },
    });

    expect(result.status).toBe(400);
    expect(recorded.calls).not.toContain('note');

    const ok = await call('POST', NOTES, { payload: { body: 'A note for colleagues.' } });
    expect(ok.status).toBe(201);
    expect(ok.body).toEqual({ noteId: NOTE, noteCount: 2 });
    expect(arg(recorded, 'note')).toEqual({
      userId: STAFF,
      isAal2: true,
      ticketId: TICKET,
      body: 'A note for colleagues.',
    });
  });

  it('refuses an empty note and one beyond the column’s length', async () => {
    for (const body of ['   ', 'x'.repeat(8001)]) {
      const recorded = await start();
      const result = await call('POST', NOTES, { payload: { body } });
      expect(result.status).toBe(400);
      expect(recorded.calls).not.toContain('note');
      await app?.close();
      app = undefined;
    }
  });

  it('has no requester route that could reach a note', async () => {
    await start();
    for (const url of [
      `/v1/support/tickets/${TICKET}/notes`,
      `/v1/support/tickets/${TICKET}/internal-notes`,
    ]) {
      const result = await call('GET', url);
      expect([400, 404], url).toContain(result.status);
    }
  });
});

describe('assignment', () => {
  it('claims a ticket for the caller, with no agent field anywhere', async () => {
    const recorded = await start();
    const result = await call('POST', CLAIM, { payload: { agentUserId: OTHER_AGENT } });

    // A body on a claim is simply not read: the route takes none.
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: 'pending_agent', isMine: true });
    expect(arg(recorded, 'claim')).toEqual({ userId: STAFF, isAal2: true, ticketId: TICKET });
    expect(JSON.stringify(arg(recorded, 'claim'))).not.toContain(OTHER_AGENT);
  });

  it('releases a ticket and reports that the status did not change', async () => {
    const recorded = await start();
    const result = await call('POST', RELEASE);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: 'pending_agent', isMine: false });
    expect(arg(recorded, 'release')).toEqual({ userId: STAFF, isAal2: true, ticketId: TICKET });
  });

  it('turns a ticket held by a colleague into a plain not-found on both steps', async () => {
    await start({
      claim: { outcome: 'not_found', status: null, isMine: null },
      release: { outcome: 'not_found', status: null, isMine: null },
    });
    for (const url of [CLAIM, RELEASE]) {
      const result = await call('POST', url);
      expect(result.status, url).toBe(404);
      expect(result.body['code'], url).toBe('NOT_FOUND');
      expect(result.raw, url).not.toContain(OTHER_AGENT);
    }
  });

  it('turns a closed ticket into its own conflict', async () => {
    await start({
      claim: { outcome: 'conflict', status: null, isMine: null },
      release: { outcome: 'conflict', status: null, isMine: null },
    });
    for (const url of [CLAIM, RELEASE]) {
      const result = await call('POST', url);
      expect(result.status, url).toBe(409);
      expect(result.body['code'], url).toBe('SUPPORT_TICKET_NOT_WORKABLE');
    }
  });

  it('has no route that assigns anybody else, and none that lists agents', async () => {
    await start();
    for (const [method, url] of [
      ['POST', `${ONE}/assign`],
      ['POST', `${ONE}/reassign`],
      ['POST', `${ONE}/transfer`],
      ['GET', '/v1/admin/support/agents'],
      ['GET', '/v1/admin/support/tickets'],
    ] as const) {
      const result = await call(method, url);
      expect([400, 404], `${method} ${url}`).toContain(result.status);
    }
  });
});

describe('replying and deciding', () => {
  it('replies with the body alone, and reports the status the database read back', async () => {
    const recorded = await start();
    const result = await call('POST', MESSAGES, {
      payload: { body: 'We are looking into it.', authorRole: 'requester', isOwnMessage: false },
    });
    expect(result.status).toBe(400);
    expect(recorded.calls).not.toContain('reply');

    const ok = await call('POST', MESSAGES, { payload: { body: 'We are looking into it.' } });
    expect(ok.status).toBe(201);
    expect(ok.body).toEqual({ messageId: MESSAGE, status: 'pending_requester' });
    expect(arg(recorded, 'reply')).toEqual({
      userId: STAFF,
      isAal2: true,
      ticketId: TICKET,
      body: 'We are looking into it.',
    });
  });

  it('answers a reply on a ticket nobody holds as a plain not-found', async () => {
    await start({ reply: { outcome: 'not_found', messageId: null, status: null } });
    const result = await call('POST', MESSAGES, { payload: { body: 'Replying to the queue' } });
    expect(result.status).toBe(404);
  });

  it('records the two agent outcomes and nothing else', async () => {
    for (const status of ['resolved', 'closed'] as const) {
      const recorded = await start({ decision: { outcome: 'closed', status } });
      const result = await call('POST', DECISION, { payload: { status } });
      expect(result.status, status).toBe(200);
      expect(result.body, status).toEqual({ status });
      expect(arg(recorded, 'decision')).toMatchObject({ ticketId: TICKET, status });
      await app?.close();
      app = undefined;
    }
  });

  it('refuses every other status before the database is reached', async () => {
    for (const status of ['open', 'pending_agent', 'pending_requester', 'reopened', '', null]) {
      const recorded = await start();
      const result = await call('POST', DECISION, { payload: { status } });
      expect(result.status, String(status)).toBe(400);
      expect(recorded.calls, String(status)).not.toContain('decision');
      await app?.close();
      app = undefined;
    }
  });

  it('refuses a decision with no status, and one with an extra field', async () => {
    for (const payload of [{}, { status: 'resolved', reason: 'because' }, { status: 'resolved', ticketId: TICKET }]) {
      const recorded = await start();
      const result = await call('POST', DECISION, { payload });
      expect(result.status).toBe(400);
      expect(recorded.calls).not.toContain('decision');
      await app?.close();
      app = undefined;
    }
  });

  it('turns an already-resolved ticket and a closed one into the console’s own conflict', async () => {
    await start({ decision: { outcome: 'conflict', status: null } });
    const result = await call('POST', DECISION, { payload: { status: 'resolved' } });
    expect(result.status).toBe(409);
    expect(result.body['code']).toBe('SUPPORT_TICKET_NOT_WORKABLE');
  });

  it('has no reopen route at all', async () => {
    await start();
    for (const url of [`${ONE}/reopen`, `${ONE}/status`, `${ONE}/priority`]) {
      const result = await call('POST', url, { payload: { status: 'open' } });
      expect([400, 404], url).toContain(result.status);
    }
  });
});

describe('the attachment link', () => {
  it('signs one read with the bucket and path the database named', async () => {
    const recorded = await start();
    const result = await call('GET', LINK);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      attachmentId: ATTACHMENT,
      url: 'https://storage.test.invalid/read/one-object',
      expiresAt: '2026-05-02T09:02:00.000Z',
    });
    expect(arg(recorded, 'attachment')).toEqual({
      userId: STAFF,
      isAal2: true,
      ticketId: TICKET,
      attachmentId: ATTACHMENT,
    });
    expect(arg(recorded, 'sign-download')).toEqual({
      bucket: 'support-attachments',
      objectPath: OBJECT_PATH,
    });
  });

  it('never signs anything for an attachment the database refuses', async () => {
    const recorded = await start({
      attachment: { outcome: 'not_found', bucketId: null, objectPath: null },
    });
    const result = await call('GET', LINK);
    expect(result.status).toBe(404);
    expect(recorded.calls).not.toContain('sign-download');
  });

  it('refuses a bucket the database named but this surface does not serve', async () => {
    const recorded = await start({
      attachment: { outcome: 'authorized', bucketId: 'public-bucket', objectPath: OBJECT_PATH },
    });
    const result = await call('GET', LINK);
    expect(result.status).toBe(503);
    expect(recorded.calls).not.toContain('sign-download');
  });

  it('turns a storage failure into a 503 that carries no URL', async () => {
    await start({ storageFails: true });
    const result = await call('GET', LINK);
    expect(result.status).toBe(503);
    expect(result.raw).not.toContain('storage.test.invalid');
  });

  it('refuses a malformed identifier in every path that takes one', async () => {
    const recorded = await start();
    for (const [method, url] of [
      ['GET', '/v1/admin/support/tickets/not-a-uuid'],
      ['GET', '/v1/admin/support/tickets/not-a-uuid/messages'],
      ['GET', '/v1/admin/support/tickets/not-a-uuid/notes'],
      ['POST', '/v1/admin/support/tickets/not-a-uuid/claim'],
      ['GET', `${ONE}/attachments/not-a-uuid/link`],
    ] as const) {
      const result = await call(method, url, { payload: undefined });
      expect(result.status, url).toBe(400);
    }
    expect(recorded.calls).not.toContain('ticket');
    expect(recorded.calls).not.toContain('attachment');
  });
});

describe('failures and the shape of the surface', () => {
  it('turns a database failure into a 503 on every operation', async () => {
    for (const [method, url, payload] of [...READS, ...WRITES]) {
      await start({ throws: true });
      const result = await call(method, url, payload === undefined ? {} : { payload });
      expect(result.status, `${method} ${url}`).toBe(503);
      expect(result.body['code'], `${method} ${url}`).toBe('SERVICE_UNAVAILABLE');
      await app?.close();
      app = undefined;
    }
  });

  it('turns an outcome it does not understand into a 503 rather than a success', async () => {
    await start({ claim: { outcome: 'escalated', status: 'open', isMine: true } });
    const result = await call('POST', CLAIM);
    expect(result.status).toBe(503);
  });

  it('never signs an upload or asks storage for an object: the console reads only', async () => {
    const recorded = await start();
    for (const [method, url, payload] of [...READS, ...WRITES]) {
      await call(method, url, payload === undefined ? {} : { payload });
    }
    expect(recorded.calls).not.toContain('sign-upload');
    expect(recorded.calls).not.toContain('object-exists');
  });
});
