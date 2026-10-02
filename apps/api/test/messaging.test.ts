import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  ConversationMessagesResponseSchema,
  MessagingInboxResponseSchema,
  SESSION_TOKEN_HEADER,
  UnreadCountResponseSchema,
} from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { AuthenticationRequiredError } from '../src/auth/auth-errors.js';
import { SUPABASE_AUTH_CLIENT } from '../src/auth/login.service.js';
import {
  encodeInboxCursor,
  encodeMessagesCursor,
} from '../src/messaging/messaging-cursor.js';
import { MESSAGING_STORE, type InboxRow, type MessageRow } from '../src/messaging/messaging.service.js';
import { CURRENT_USER_STORE } from '../src/users/current-user.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * The messaging read routes at the API boundary (Phase 5-C).
 *
 * The assertions that carry the most weight are about authority and about silence.
 *
 * **Authority.** The caller is resolved from their own token and from nowhere else. The tests below try
 * to name a different account — in a query parameter, in a header, in the cursor — and assert that the
 * id handed to the reader is unchanged every time. That is the property the whole surface rests on,
 * because migration 0053 trusts the id it is given to have already been established.
 *
 * **Silence.** A conversation the caller may not read and a conversation that does not exist produce the
 * same status, the same code and the same body. Not similar — identical, compared byte for byte with
 * only the echoed request path removed.
 *
 * Everything is stubbed at the store boundary: no database, no provider, no network.
 */

const ACCESS_TOKEN = 'caller-access-token-value-not-a-real-token';
const CALLER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = 'e0000000-0000-4000-8000-000000000001';
const OTHER_CONVERSATION = 'e0000000-0000-4000-8000-000000000002';

const AT = new Date('2026-09-24T18:30:00.000Z');

interface Recorded {
  readonly inboxCalls: Array<{ userId: string; limit: number; cursorLastMessageAt: Date | null; cursorId: string | null }>;
  readonly messageCalls: Array<{ userId: string; conversationId: string; limit: number; cursorSeq: string | null }>;
  readonly unreadCalls: string[];
  readonly tokensSeen: string[];
}

interface Doubles {
  readonly inboxRows?: readonly InboxRow[];
  readonly messageRows?: readonly MessageRow[];
  readonly unread?: string;
  readonly storeThrows?: boolean;
  readonly unauthenticated?: boolean;
}

function inboxRow(overrides: Partial<InboxRow> = {}): InboxRow {
  return {
    conversationId: CONVERSATION,
    subjectType: 'listing',
    listingId: '11110000-0000-4000-8000-000000000001',
    listingTitleSnapshot: 'Walnut dining table',
    membershipState: 'active',
    isMuted: false,
    isClosed: false,
    closedAt: null,
    unreadCount: '3',
    lastMessageId: 'a1000000-0000-4000-8000-000000000005',
    lastMessageSeq: '5',
    lastMessageAt: AT,
    lastMessageType: 'system',
    lastMessageBody: 'The listing was updated.',
    lastMessageSenderUserId: null,
    lastMessageDeletedAt: null,
    createdAt: new Date('2026-09-20T10:00:00.000Z'),
    ...overrides,
  };
}

function messageRow(seq: number, overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: `a1000000-0000-4000-8000-00000000000${seq}`,
    seq: String(seq),
    conversationId: CONVERSATION,
    senderUserId: OTHER_USER,
    isOwnMessage: false,
    messageType: 'text',
    body: `Message ${seq}`,
    referenceType: null,
    referenceId: null,
    createdAt: new Date(`2026-09-24T18:0${seq}:00.000Z`),
    editedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

let app: NestFastifyApplication | undefined;

async function start(doubles: Doubles = {}): Promise<Recorded> {
  const recorded: Recorded = { inboxCalls: [], messageCalls: [], unreadCalls: [], tokensSeen: [] };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(TEST_ENV)] })
    .overrideProvider(SUPABASE_AUTH_CLIENT)
    .useValue({
      getUser: async (token: string) => {
        recorded.tokensSeen.push(token);
        if (doubles.unauthenticated === true) throw new AuthenticationRequiredError();
        return { id: CALLER, phone: null };
      },
      signInWithPassword: async () => {
        throw new Error('a messaging read must never sign anyone in');
      },
      revokeAllSessions: async () => {
        throw new Error('a messaging read must never revoke a session');
      },
    })
    .overrideProvider(CURRENT_USER_STORE)
    .useValue({ userIdentity: async (userId: string) => ({ id: userId, displayName: 'Nadia' }) })
    .overrideProvider(MESSAGING_STORE)
    .useValue({
      messagingInbox: async (input: {
        userId: string;
        limit: number;
        cursorLastMessageAt: Date | null;
        cursorId: string | null;
      }) => {
        recorded.inboxCalls.push(input);
        if (doubles.storeThrows === true) throw new Error('database unavailable');
        return doubles.inboxRows ?? [inboxRow()];
      },
      messagingConversationMessages: async (input: {
        userId: string;
        conversationId: string;
        limit: number;
        cursorSeq: string | null;
      }) => {
        recorded.messageCalls.push(input);
        if (doubles.storeThrows === true) throw new Error('database unavailable');
        return doubles.messageRows ?? [messageRow(1), messageRow(2)];
      },
      messagingUnreadCount: async (userId: string) => {
        recorded.unreadCalls.push(userId);
        if (doubles.storeThrows === true) throw new Error('database unavailable');
        return doubles.unread ?? '4';
      },
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

async function get(path: string, headers: Record<string, string> = {}): Promise<Result> {
  const response = await app!.inject({
    method: 'GET',
    url: path,
    headers: {
      [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL,
      [SESSION_TOKEN_HEADER]: ACCESS_TOKEN,
      ...headers,
    },
  });
  return {
    status: response.statusCode,
    body: response.body.length > 0 ? (JSON.parse(response.body) as Record<string, unknown>) : {},
    raw: response.body,
  };
}

/** A problem body with the echoed request path removed, so two refusals can be compared directly. */
function comparable(body: Record<string, unknown>): string {
  const { instance: _instance, ...rest } = body;
  return JSON.stringify(rest);
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('authentication', () => {
  it('refuses an inbox read with no session, without asking the store', async () => {
    const recorded = await start();
    const response = await app!.inject({
      method: 'GET',
      url: '/v1/messaging/conversations',
      headers: { [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL },
    });

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body).code).toBe('AUTHENTICATION_REQUIRED');
    expect(recorded.inboxCalls).toHaveLength(0);
  });

  it('refuses a conversation read with no session', async () => {
    const recorded = await start();
    const response = await app!.inject({
      method: 'GET',
      url: `/v1/messaging/conversations/${CONVERSATION}/messages`,
      headers: { [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL },
    });

    expect(response.statusCode).toBe(401);
    expect(recorded.messageCalls).toHaveLength(0);
  });

  it('refuses an unread count with no session', async () => {
    const recorded = await start();
    const response = await app!.inject({
      method: 'GET',
      url: '/v1/messaging/unread-count',
      headers: { [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL },
    });

    expect(response.statusCode).toBe(401);
    expect(recorded.unreadCalls).toHaveLength(0);
  });

  it('refuses a token the provider does not accept', async () => {
    const recorded = await start({ unauthenticated: true });
    const result = await get('/v1/messaging/conversations');

    expect(result.status).toBe(401);
    expect(recorded.inboxCalls).toHaveLength(0);
  });

  it('requires the internal BFF credential on all three routes', async () => {
    await start();
    for (const url of [
      '/v1/messaging/conversations',
      `/v1/messaging/conversations/${CONVERSATION}/messages`,
      '/v1/messaging/unread-count',
    ]) {
      const response = await app!.inject({
        method: 'GET',
        url,
        headers: { [SESSION_TOKEN_HEADER]: ACCESS_TOKEN },
      });
      expect(response.statusCode, url).toBe(403);
    }
  });
});

describe('GET /v1/messaging/conversations', () => {
  it('returns a page that validates against the shared contract', async () => {
    await start();
    const result = await get('/v1/messaging/conversations');

    expect(result.status).toBe(200);
    const parsed = MessagingInboxResponseSchema.safeParse(result.body);
    expect(parsed.success).toBe(true);
  });

  it('projects exactly the approved fields', async () => {
    await start();
    const result = await get('/v1/messaging/conversations');
    const item = (result.body['items'] as Array<Record<string, unknown>>)[0]!;

    expect(Object.keys(result.body).sort()).toEqual(['items', 'nextCursor']);
    expect(Object.keys(item).sort()).toEqual([
      'closedAt',
      'conversationId',
      'createdAt',
      'isClosed',
      'isMuted',
      'lastMessageAt',
      'lastMessageBody',
      'lastMessageDeletedAt',
      'lastMessageId',
      'lastMessageSenderUserId',
      'lastMessageSeq',
      'lastMessageType',
      'listingId',
      'listingTitleSnapshot',
      'membershipState',
      'subjectType',
      'unreadCount',
    ]);
  });

  it('asks for the default page of 20, read one row longer to detect a next page', async () => {
    const recorded = await start();
    await get('/v1/messaging/conversations');
    expect(recorded.inboxCalls[0]?.limit).toBe(21);
  });

  it('honours a smaller limit', async () => {
    const recorded = await start();
    await get('/v1/messaging/conversations?limit=5');
    expect(recorded.inboxCalls[0]?.limit).toBe(6);
  });

  it('accepts the maximum of 50', async () => {
    const recorded = await start();
    await get('/v1/messaging/conversations?limit=50');
    expect(recorded.inboxCalls[0]?.limit).toBe(51);
  });

  it('clamps an oversized limit to 50 rather than refusing it', async () => {
    const recorded = await start();
    const result = await get('/v1/messaging/conversations?limit=500');

    expect(result.status).toBe(200);
    expect(recorded.inboxCalls[0]?.limit).toBe(51);
  });

  it('refuses a limit that is not a whole positive number', async () => {
    const recorded = await start();
    for (const limit of ['0', '-1', 'ten', '1.5', ' 5']) {
      const result = await get(`/v1/messaging/conversations?limit=${encodeURIComponent(limit)}`);
      expect(result.status, limit).toBe(400);
      expect(result.body['code'], limit).toBe('VALIDATION_FAILED');
    }
    expect(recorded.inboxCalls).toHaveLength(0);
  });

  it('returns a next cursor only when there is another page', async () => {
    await start({ inboxRows: [inboxRow()] });
    const single = await get('/v1/messaging/conversations?limit=1');
    expect(single.body['nextCursor']).toBeNull();

    await app?.close();
    await start({
      inboxRows: [inboxRow(), inboxRow({ conversationId: OTHER_CONVERSATION, lastMessageAt: null })],
    });
    const more = await get('/v1/messaging/conversations?limit=1');
    expect(more.body['nextCursor']).toEqual(expect.any(String));
    expect((more.body['items'] as unknown[]).length).toBe(1);
  });

  it('hands back an opaque cursor: base64url, with no field a client could read', async () => {
    await start({
      inboxRows: [inboxRow(), inboxRow({ conversationId: OTHER_CONVERSATION })],
    });
    const result = await get('/v1/messaging/conversations?limit=1');
    const cursor = result.body['nextCursor'] as string;

    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cursor).not.toContain(CONVERSATION);
    expect(cursor).not.toContain('2026-09-24');
  });

  it('accepts a cursor it issued and passes its two values to the reader', async () => {
    const recorded = await start();
    const cursor = encodeInboxCursor({ lastMessageAt: AT, conversationId: CONVERSATION });
    const result = await get(`/v1/messaging/conversations?cursor=${encodeURIComponent(cursor)}`);

    expect(result.status).toBe(200);
    expect(recorded.inboxCalls[0]?.cursorLastMessageAt?.toISOString()).toBe(AT.toISOString());
    expect(recorded.inboxCalls[0]?.cursorId).toBe(CONVERSATION);
  });

  it('accepts a cursor that names the undated tail', async () => {
    const recorded = await start();
    const cursor = encodeInboxCursor({ lastMessageAt: null, conversationId: CONVERSATION });
    const result = await get(`/v1/messaging/conversations?cursor=${encodeURIComponent(cursor)}`);

    expect(result.status).toBe(200);
    expect(recorded.inboxCalls[0]?.cursorLastMessageAt).toBeNull();
    expect(recorded.inboxCalls[0]?.cursorId).toBe(CONVERSATION);
  });

  it('refuses a malformed cursor without reading anything', async () => {
    const recorded = await start();
    const result = await get('/v1/messaging/conversations?cursor=!!!!');

    expect(result.status).toBe(400);
    expect(result.body['code']).toBe('MESSAGING_CURSOR_INVALID');
    expect(recorded.inboxCalls).toHaveLength(0);
  });

  it('refuses a cursor from an unsupported version', async () => {
    const recorded = await start();
    const cursor = Buffer.from(`mi2|${AT.toISOString()}|${CONVERSATION}`, 'utf8').toString('base64url');
    const result = await get(`/v1/messaging/conversations?cursor=${encodeURIComponent(cursor)}`);

    expect(result.status).toBe(400);
    expect(result.body['code']).toBe('MESSAGING_CURSOR_INVALID');
    expect(recorded.inboxCalls).toHaveLength(0);
  });

  it('refuses a message cursor used on the inbox', async () => {
    await start();
    const cursor = encodeMessagesCursor({ seq: '5' });
    const result = await get(`/v1/messaging/conversations?cursor=${encodeURIComponent(cursor)}`);
    expect(result.status).toBe(400);
  });

  it('reports an unreadable store as 503, never as an empty inbox', async () => {
    await start({ storeThrows: true });
    const result = await get('/v1/messaging/conversations');

    expect(result.status).toBe(503);
    expect(result.body['code']).toBe('SERVICE_UNAVAILABLE');
  });

  it('renders an empty inbox as an empty page rather than an error', async () => {
    await start({ inboxRows: [] });
    const result = await get('/v1/messaging/conversations');

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ items: [], nextCursor: null });
  });
});

describe('GET /v1/messaging/conversations/:id/messages', () => {
  it('returns a page that validates against the shared contract', async () => {
    await start();
    const result = await get(`/v1/messaging/conversations/${CONVERSATION}/messages`);

    expect(result.status).toBe(200);
    expect(ConversationMessagesResponseSchema.safeParse(result.body).success).toBe(true);
  });

  it('projects exactly the approved fields, and no attachment among them', async () => {
    await start();
    const result = await get(`/v1/messaging/conversations/${CONVERSATION}/messages`);
    const item = (result.body['items'] as Array<Record<string, unknown>>)[0]!;

    expect(Object.keys(item).sort()).toEqual([
      'body',
      'conversationId',
      'createdAt',
      'deletedAt',
      'editedAt',
      'id',
      'isOwnMessage',
      'messageType',
      'referenceId',
      'referenceType',
      'senderUserId',
      'seq',
    ]);
    expect(result.raw.toLowerCase()).not.toContain('attachment');
  });

  it('returns the page in chronological order', async () => {
    await start({ messageRows: [messageRow(1), messageRow(2), messageRow(3)] });
    const result = await get(`/v1/messaging/conversations/${CONVERSATION}/messages`);
    const items = result.body['items'] as Array<Record<string, unknown>>;

    expect(items.map((item) => item['seq'])).toEqual(['1', '2', '3']);
  });

  it('carries a sequence as digits, so a bigint survives the journey', async () => {
    await start({ messageRows: [messageRow(1, { seq: '9223372036854775807' })] });
    const result = await get(`/v1/messaging/conversations/${CONVERSATION}/messages`);
    const items = result.body['items'] as Array<Record<string, unknown>>;

    expect(items[0]?.['seq']).toBe('9223372036854775807');
  });

  it('asks for the default page of 50', async () => {
    const recorded = await start();
    await get(`/v1/messaging/conversations/${CONVERSATION}/messages`);
    expect(recorded.messageCalls[0]?.limit).toBe(51);
  });

  it('accepts the maximum of 100 and clamps anything larger', async () => {
    const recorded = await start();
    await get(`/v1/messaging/conversations/${CONVERSATION}/messages?limit=100`);
    expect(recorded.messageCalls[0]?.limit).toBe(101);

    const result = await get(`/v1/messaging/conversations/${CONVERSATION}/messages?limit=5000`);
    expect(result.status).toBe(200);
    expect(recorded.messageCalls[1]?.limit).toBe(101);
  });

  it('pages backwards: the next cursor names the oldest message the caller kept', async () => {
    await start({ messageRows: [messageRow(1), messageRow(2), messageRow(3)] });
    const result = await get(`/v1/messaging/conversations/${CONVERSATION}/messages?limit=2`);
    const items = result.body['items'] as Array<Record<string, unknown>>;

    // The extra row is the oldest, so the page keeps the two newest and the cursor points before them.
    expect(items.map((item) => item['seq'])).toEqual(['2', '3']);
    expect(result.body['nextCursor']).toBe(encodeMessagesCursor({ seq: '2' }));
  });

  it('passes a cursor’s sequence to the reader unchanged', async () => {
    const recorded = await start();
    const cursor = encodeMessagesCursor({ seq: '42' });
    await get(`/v1/messaging/conversations/${CONVERSATION}/messages?cursor=${encodeURIComponent(cursor)}`);

    expect(recorded.messageCalls[0]?.cursorSeq).toBe('42');
  });

  it('refuses a malformed cursor and one from an unsupported version', async () => {
    const recorded = await start();
    const bad = await get(`/v1/messaging/conversations/${CONVERSATION}/messages?cursor=!!!!`);
    const wrongVersion = Buffer.from('mm2|42', 'utf8').toString('base64url');
    const stale = await get(
      `/v1/messaging/conversations/${CONVERSATION}/messages?cursor=${encodeURIComponent(wrongVersion)}`,
    );

    expect(bad.status).toBe(400);
    expect(bad.body['code']).toBe('MESSAGING_CURSOR_INVALID');
    expect(stale.status).toBe(400);
    expect(stale.body['code']).toBe('MESSAGING_CURSOR_INVALID');
    expect(recorded.messageCalls).toHaveLength(0);
  });

  it('refuses a conversation id that is not a uuid, without reading anything', async () => {
    const recorded = await start();
    const result = await get('/v1/messaging/conversations/not-a-uuid/messages');

    expect(result.status).toBe(400);
    expect(result.body['code']).toBe('VALIDATION_FAILED');
    expect(recorded.messageCalls).toHaveLength(0);
  });

  it('gives a stranger and a missing conversation the same refusal, byte for byte', async () => {
    await start({ messageRows: [] });
    const refused = await get(`/v1/messaging/conversations/${CONVERSATION}/messages`);
    const missing = await get(`/v1/messaging/conversations/${OTHER_CONVERSATION}/messages`);

    expect(refused.status).toBe(404);
    expect(refused.body['code']).toBe('MESSAGING_CONVERSATION_NOT_FOUND');
    expect(comparable(refused.body)).toBe(comparable(missing.body));
  });

  it('behind a cursor, every empty page looks the same whoever asked', async () => {
    // With a cursor there is no refusal at all: a participant who has paged past the beginning, a
    // stranger, and a conversation that does not exist all receive the same empty page. The uniformity
    // is the point — the 404 above exists only where a first page can be answered meaningfully.
    await start({ messageRows: [] });
    const cursor = encodeMessagesCursor({ seq: '10' });
    const mine = await get(
      `/v1/messaging/conversations/${CONVERSATION}/messages?cursor=${encodeURIComponent(cursor)}`,
    );
    const theirs = await get(
      `/v1/messaging/conversations/${OTHER_CONVERSATION}/messages?cursor=${encodeURIComponent(cursor)}`,
    );

    expect(mine.status).toBe(200);
    expect(mine.body).toEqual({ items: [], nextCursor: null });
    expect(theirs.body).toEqual(mine.body);
  });

  it('a conversation with no messages yet reads as not found, which is a known consequence', async () => {
    // Migration 0053 exposes no "may this caller read this conversation" question of its own, so an
    // empty first page is the only signal available and it cannot distinguish "not yours" from "nothing
    // said yet". The refusal is chosen deliberately: a stranger must learn nothing, and a participant
    // of a genuinely empty conversation is the rarer case. Pinned here so it is a decision on record
    // rather than a surprise, and so the increment that adds an access reader can change it knowingly.
    await start({ messageRows: [] });
    const result = await get(`/v1/messaging/conversations/${CONVERSATION}/messages`);

    expect(result.status).toBe(404);
    expect(result.body['code']).toBe('MESSAGING_CONVERSATION_NOT_FOUND');
  });

  it('never says "forbidden", which would confirm the conversation is real', async () => {
    await start({ messageRows: [] });
    const result = await get(`/v1/messaging/conversations/${CONVERSATION}/messages`);

    expect(result.status).not.toBe(403);
    expect(result.raw.toLowerCase()).not.toContain('forbidden');
  });

  it('reports an unreadable store as 503', async () => {
    await start({ storeThrows: true });
    const result = await get(`/v1/messaging/conversations/${CONVERSATION}/messages`);
    expect(result.status).toBe(503);
  });
});

describe('GET /v1/messaging/unread-count', () => {
  it('returns the caller’s total, validating against the contract', async () => {
    await start({ unread: '4' });
    const result = await get('/v1/messaging/unread-count');

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ unreadCount: 4 });
    expect(UnreadCountResponseSchema.safeParse(result.body).success).toBe(true);
  });

  it('carries no other field', async () => {
    await start();
    const result = await get('/v1/messaging/unread-count');
    expect(Object.keys(result.body)).toEqual(['unreadCount']);
  });

  it('reads it for the caller and nobody else', async () => {
    const recorded = await start();
    await get('/v1/messaging/unread-count');
    expect(recorded.unreadCalls).toEqual([CALLER]);
  });

  it('refuses a count a double could not hold, rather than rounding it', async () => {
    await start({ unread: '9007199254740993' });
    const result = await get('/v1/messaging/unread-count');

    expect(result.status).toBe(503);
    expect(result.body['code']).toBe('SERVICE_UNAVAILABLE');
  });

  it('reports an unreadable store as 503, never as zero unread', async () => {
    await start({ storeThrows: true });
    const result = await get('/v1/messaging/unread-count');

    expect(result.status).toBe(503);
    expect(result.raw).not.toContain('unreadCount');
  });
});

describe('the caller cannot be named by a request', () => {
  it('ignores a user id in the query string', async () => {
    const recorded = await start();
    await get(`/v1/messaging/conversations?userId=${OTHER_USER}&user_id=${OTHER_USER}`);
    expect(recorded.inboxCalls[0]?.userId).toBe(CALLER);
  });

  it('ignores a user id in a header', async () => {
    const recorded = await start();
    await get('/v1/messaging/unread-count', { 'x-user-id': OTHER_USER, 'x-caller': OTHER_USER });
    expect(recorded.unreadCalls).toEqual([CALLER]);
  });

  it('ignores a user id smuggled into a cursor', async () => {
    const recorded = await start();
    const cursor = Buffer.from(`mi1|${AT.toISOString()}|${CONVERSATION}|${OTHER_USER}`, 'utf8').toString('base64url');
    const result = await get(`/v1/messaging/conversations?cursor=${encodeURIComponent(cursor)}`);

    expect(result.status).toBe(400);
    expect(recorded.inboxCalls).toHaveLength(0);
  });

  it('reads every route as the account the token names', async () => {
    const recorded = await start();
    await get('/v1/messaging/conversations');
    await get(`/v1/messaging/conversations/${CONVERSATION}/messages`);
    await get('/v1/messaging/unread-count');

    expect(recorded.inboxCalls.map((call) => call.userId)).toEqual([CALLER]);
    expect(recorded.messageCalls.map((call) => call.userId)).toEqual([CALLER]);
    expect(recorded.unreadCalls).toEqual([CALLER]);
  });

  it('exposes no route that names an account', async () => {
    await start();
    const fastify = app!.getHttpAdapter().getInstance();
    for (const url of [
      '/v1/messaging/conversations/:conversationId',
      '/v1/messaging/users/:userId/conversations',
      '/v1/messaging',
    ]) {
      expect(fastify.hasRoute({ method: 'GET', url }), url).toBe(false);
    }
  });
});

describe('nothing secret reaches a response', () => {
  it('never echoes the caller’s token or the internal credential', async () => {
    await start();
    for (const path of [
      '/v1/messaging/conversations',
      `/v1/messaging/conversations/${CONVERSATION}/messages`,
      '/v1/messaging/unread-count',
    ]) {
      const result = await get(path);
      expect(result.raw, path).not.toContain(ACCESS_TOKEN);
      expect(result.raw, path).not.toContain(TEST_INTERNAL_CREDENTIAL);
      expect(result.raw, path).not.toContain('x-session-token');
      expect(result.raw, path).not.toContain('refresh');
    }
  });

  it('never leaks a database error into a problem body', async () => {
    await start({ storeThrows: true });
    const result = await get('/v1/messaging/conversations');

    expect(result.raw).not.toContain('database unavailable');
    expect(result.raw).not.toContain('app_private');
    expect(result.raw).not.toContain('select');
    expect(result.raw).not.toContain('stack');
  });

  it('answers every failure in the one problem-details envelope', async () => {
    await start({ messageRows: [] });
    const refusals = [
      await get('/v1/messaging/conversations?cursor=!!!!'),
      await get('/v1/messaging/conversations/not-a-uuid/messages'),
      await get(`/v1/messaging/conversations/${CONVERSATION}/messages`),
    ];

    for (const refusal of refusals) {
      expect(Object.keys(refusal.body).sort()).toEqual(
        expect.arrayContaining(['code', 'detail', 'instance', 'status', 'title', 'type']),
      );
      expect(refusal.body['type']).toBe('about:blank');
    }
  });
});

describe('a drifting response is a failure, not a silent pass', () => {
  it('a row carrying a vocabulary the contract does not know fails validation', async () => {
    await start({ inboxRows: [inboxRow({ subjectType: 'dispute' })] });
    const result = await get('/v1/messaging/conversations');

    // The API forwards what the reader said; the contract is what refuses it, which is the point of
    // validating the response rather than trusting it.
    expect(MessagingInboxResponseSchema.safeParse(result.body).success).toBe(false);
  });

  it('a private field added downstream would be refused by the strict schema', async () => {
    const drifted = {
      items: [{ ...{ conversationId: CONVERSATION }, sellerEmail: 'x@test.invalid' }],
      nextCursor: null,
    };
    expect(MessagingInboxResponseSchema.safeParse(drifted).success).toBe(false);
  });

  it('and so would an attachment field on a message', async () => {
    const drifted = {
      items: [
        {
          id: 'a1000000-0000-4000-8000-000000000001',
          seq: '1',
          conversationId: CONVERSATION,
          senderUserId: OTHER_USER,
          isOwnMessage: false,
          messageType: 'text',
          body: 'Hello',
          referenceType: null,
          referenceId: null,
          createdAt: AT.toISOString(),
          editedAt: null,
          deletedAt: null,
          attachments: [],
        },
      ],
      nextCursor: null,
    };
    expect(ConversationMessagesResponseSchema.safeParse(drifted).success).toBe(false);
  });
});
