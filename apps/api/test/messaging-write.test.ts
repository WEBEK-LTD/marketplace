import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  CloseConversationResponseSchema,
  LeaveConversationResponseSchema,
  MESSAGE_BODY_MAX_LENGTH,
  MarkReadResponseSchema,
  SESSION_TOKEN_HEADER,
  SendMessageResponseSchema,
  SetMutedResponseSchema,
  StartConversationResponseSchema,
} from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { AuthenticationRequiredError } from '../src/auth/auth-errors.js';
import { DURABLE_THROTTLE_COUNTER, REDIS_THROTTLE_COUNTER } from '../src/auth/login-throttle.service.js';
import { SUPABASE_AUTH_CLIENT } from '../src/auth/login.service.js';
import { MESSAGING_THROTTLE_BUCKETS } from '../src/messaging/messaging-throttle.service.js';
import { MESSAGING_WRITE_STORE } from '../src/messaging/messaging-write.service.js';
import { MESSAGING_STORE, type MessageRow } from '../src/messaging/messaging.service.js';
import { CURRENT_USER_STORE } from '../src/users/current-user.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * The messaging write routes at the API boundary (Phase 5-E).
 *
 * Four properties carry this suite.
 *
 * **Nobody can act as anybody else.** Every route resolves the caller from their own token. The tests
 * below try to name another account in a body field and assert the store still receives the token's own
 * id — and that the extra field is refused outright, because every write schema is strict.
 *
 * **A refusal says as little as the read routes do.** A conversation that is not the caller's and one
 * that does not exist produce the same status, code and body, compared byte for byte.
 *
 * **Nothing is invented.** The send route answers with the message as the reader returns it, so the id,
 * the sequence and the timestamp in the response are the stored ones. A write that commits but cannot be
 * read back is reported as a failure rather than as an imagined success.
 *
 * **The operations that do not exist, do not exist.** There is no edit, no delete of a message, no
 * reopen, and no attachment field anywhere. Those are asserted as absent rather than assumed.
 *
 * Everything is stubbed at the store and counter boundaries: no database, no Redis, no network.
 */

const ACCESS_TOKEN = 'caller-access-token-value-not-a-real-token';
const CALLER = '11111111-1111-4111-8111-111111111111';
const IMPOSTOR = '99999999-9999-4999-8999-999999999999';
const CONVERSATION = 'e0000000-0000-4000-8000-000000000001';
const LISTING = '11110000-0000-4000-8000-000000000001';
const MESSAGE = 'a1000000-0000-4000-8000-000000000005';
const AT = new Date('2026-09-24T18:30:00.000Z');

interface StartCall {
  userId: string;
  subjectType: string;
  listingId: string | null;
  sellerSlug: string | null;
}
interface SendCall {
  userId: string;
  conversationId: string;
  body: string;
}

interface Recorded {
  readonly starts: StartCall[];
  readonly sends: SendCall[];
  readonly reads: Array<{ userId: string; conversationId: string; seq: string }>;
  readonly mutes: Array<{ userId: string; conversationId: string; isMuted: boolean }>;
  readonly leaves: Array<{ userId: string; conversationId: string }>;
  readonly closes: Array<{ userId: string; conversationId: string }>;
  readonly buckets: string[];
  readonly readBacks: Array<{ userId: string; conversationId: string; limit: number }>;
}

interface Doubles {
  readonly startOutcome?: string;
  readonly startConversationId?: string | null;
  readonly sendOutcome?: string;
  readonly readOutcome?: string;
  readonly lastReadSeq?: string | null;
  readonly muteOutcome?: string;
  readonly leaveOutcome?: string;
  readonly closeOutcome?: string;
  readonly closedAt?: Date | null;
  readonly storeThrows?: boolean;
  readonly readBackEmpty?: boolean;
  readonly unauthenticated?: boolean;
  /** Bucket names the counter refuses. */
  readonly overLimit?: readonly string[];
}

function messageRow(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: MESSAGE,
    seq: '5',
    conversationId: CONVERSATION,
    senderUserId: CALLER,
    isOwnMessage: true,
    messageType: 'text',
    body: 'Still available?',
    referenceType: null,
    referenceId: null,
    createdAt: AT,
    editedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

let app: NestFastifyApplication | undefined;

async function start(doubles: Doubles = {}): Promise<Recorded> {
  const recorded: Recorded = {
    starts: [],
    sends: [],
    reads: [],
    mutes: [],
    leaves: [],
    closes: [],
    buckets: [],
    readBacks: [],
  };

  const counter = {
    hit: async (bucket: string) => {
      recorded.buckets.push(bucket);
      return !(doubles.overLimit ?? []).includes(bucket);
    },
  };

  const writeStore = {
    messagingStartConversation: async (input: StartCall) => {
      recorded.starts.push(input);
      if (doubles.storeThrows === true) throw new Error('database unavailable');
      return {
        outcome: doubles.startOutcome ?? 'created',
        conversationId:
          doubles.startConversationId === undefined ? CONVERSATION : doubles.startConversationId,
      };
    },
    messagingSendMessage: async (input: SendCall) => {
      recorded.sends.push(input);
      if (doubles.storeThrows === true) throw new Error('database unavailable');
      const outcome = doubles.sendOutcome ?? 'sent';
      return {
        outcome,
        messageId: outcome === 'sent' ? MESSAGE : null,
        seq: outcome === 'sent' ? '5' : null,
      };
    },
    messagingMarkRead: async (input: { userId: string; conversationId: string; seq: string }) => {
      recorded.reads.push(input);
      if (doubles.storeThrows === true) throw new Error('database unavailable');
      return {
        outcome: doubles.readOutcome ?? 'ok',
        lastReadSeq: doubles.lastReadSeq === undefined ? '5' : doubles.lastReadSeq,
      };
    },
    messagingSetMuted: async (input: { userId: string; conversationId: string; isMuted: boolean }) => {
      recorded.mutes.push(input);
      if (doubles.storeThrows === true) throw new Error('database unavailable');
      return { outcome: doubles.muteOutcome ?? 'ok', isMuted: input.isMuted };
    },
    messagingLeaveConversation: async (input: { userId: string; conversationId: string }) => {
      recorded.leaves.push(input);
      if (doubles.storeThrows === true) throw new Error('database unavailable');
      return { outcome: doubles.leaveOutcome ?? 'left' };
    },
    messagingCloseConversation: async (input: { userId: string; conversationId: string }) => {
      recorded.closes.push(input);
      if (doubles.storeThrows === true) throw new Error('database unavailable');
      return {
        outcome: doubles.closeOutcome ?? 'closed',
        closedAt: doubles.closedAt === undefined ? AT : doubles.closedAt,
      };
    },
    messagingConversationMessages: async (input: {
      userId: string;
      conversationId: string;
      limit: number;
      cursorSeq: string | null;
    }) => {
      recorded.readBacks.push(input);
      return doubles.readBackEmpty === true ? [] : [messageRow()];
    },
  };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(TEST_ENV)] })
    .overrideProvider(SUPABASE_AUTH_CLIENT)
    .useValue({
      getUser: async () => {
        if (doubles.unauthenticated === true) throw new AuthenticationRequiredError();
        return { id: CALLER, phone: null };
      },
      signInWithPassword: async () => {
        throw new Error('a messaging write must never sign anyone in');
      },
      revokeAllSessions: async () => {
        throw new Error('a messaging write must never revoke a session');
      },
    })
    .overrideProvider(CURRENT_USER_STORE)
    .useValue({ userIdentity: async (userId: string) => ({ id: userId, displayName: 'Nadia' }) })
    .overrideProvider(REDIS_THROTTLE_COUNTER)
    .useValue(counter)
    .overrideProvider(DURABLE_THROTTLE_COUNTER)
    .useValue(counter)
    .overrideProvider(MESSAGING_STORE)
    .useValue(writeStore)
    .overrideProvider(MESSAGING_WRITE_STORE)
    .useValue(writeStore)
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
}

async function send(
  method: 'POST' | 'PUT' | 'DELETE' | 'PATCH',
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Result> {
  const response = await app!.inject({
    method,
    url: path,
    headers: {
      [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL,
      [SESSION_TOKEN_HEADER]: ACCESS_TOKEN,
      ...headers,
    },
    ...(body === undefined ? {} : { payload: body as never }),
  });
  return {
    status: response.statusCode,
    body: response.body.length > 0 ? (JSON.parse(response.body) as Record<string, unknown>) : {},
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
  it('refuses every write with no session, without touching the store', async () => {
    const recorded = await start();
    for (const [method, path, payload] of [
      ['POST', '/v1/messaging/conversations', { subjectType: 'listing', listingId: LISTING }],
      ['POST', `/v1/messaging/conversations/${CONVERSATION}/messages`, { body: 'hello' }],
      ['PUT', `/v1/messaging/conversations/${CONVERSATION}/read`, { seq: '5' }],
      ['PUT', `/v1/messaging/conversations/${CONVERSATION}/muted`, { isMuted: true }],
      ['DELETE', `/v1/messaging/conversations/${CONVERSATION}/membership`, undefined],
      ['PUT', `/v1/messaging/conversations/${CONVERSATION}/closed`, undefined],
    ] as const) {
      const response = await app!.inject({
        method,
        url: path,
        headers: { [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL },
        ...(payload === undefined ? {} : { payload: payload as never }),
      });
      expect(response.statusCode, path).toBe(401);
    }

    expect(recorded.starts).toHaveLength(0);
    expect(recorded.sends).toHaveLength(0);
    expect(recorded.reads).toHaveLength(0);
    expect(recorded.mutes).toHaveLength(0);
    expect(recorded.leaves).toHaveLength(0);
    expect(recorded.closes).toHaveLength(0);
  });

  it('refuses a write whose token the provider will not accept', async () => {
    await start({ unauthenticated: true });
    const response = await send('PUT', `/v1/messaging/conversations/${CONVERSATION}/muted`, {
      isMuted: true,
    });
    expect(response.status).toBe(401);
  });
});

describe('starting a conversation', () => {
  it('creates one from a listing and reports where it is', async () => {
    const recorded = await start();
    const response = await send('POST', '/v1/messaging/conversations', {
      subjectType: 'listing',
      listingId: LISTING,
    });

    expect(response.status).toBe(200);
    expect(StartConversationResponseSchema.safeParse(response.body).success).toBe(true);
    expect(response.body).toEqual({ outcome: 'created', conversationId: CONVERSATION });
    expect(recorded.starts).toEqual([
      { userId: CALLER, subjectType: 'listing', listingId: LISTING, sellerSlug: null },
    ]);
  });

  it('names a seller by public slug, never by identifier', async () => {
    const recorded = await start({ startOutcome: 'reused' });
    const response = await send('POST', '/v1/messaging/conversations', {
      subjectType: 'direct',
      sellerSlug: 'good-shop',
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ outcome: 'reused', conversationId: CONVERSATION });
    expect(recorded.starts).toEqual([
      { userId: CALLER, subjectType: 'direct', listingId: null, sellerSlug: 'good-shop' },
    ]);
  });

  it('refuses a direct request that tries to name a user id instead of a slug', async () => {
    const recorded = await start();
    const response = await send('POST', '/v1/messaging/conversations', {
      subjectType: 'direct',
      sellerUserId: IMPOSTOR,
    });

    expect(response.status).toBe(400);
    expect(response.body['code']).toBe('VALIDATION_FAILED');
    expect(recorded.starts).toHaveLength(0);
  });

  it('refuses a request that carries both entry points, and one that carries neither', async () => {
    const recorded = await start();
    for (const payload of [
      { subjectType: 'listing', listingId: LISTING, sellerSlug: 'good-shop' },
      { subjectType: 'direct', listingId: LISTING, sellerSlug: 'good-shop' },
      { subjectType: 'listing' },
      { subjectType: 'direct' },
      { subjectType: 'order', listingId: LISTING },
      {},
    ]) {
      const response = await send('POST', '/v1/messaging/conversations', payload);
      expect(response.status, JSON.stringify(payload)).toBe(400);
    }
    expect(recorded.starts).toHaveLength(0);
  });

  it('cannot be told whose conversation to start', async () => {
    const recorded = await start();
    const response = await send('POST', '/v1/messaging/conversations', {
      subjectType: 'listing',
      listingId: LISTING,
      userId: IMPOSTOR,
    });

    // The schema is strict, so the attempt does not even reach the store.
    expect(response.status).toBe(400);
    expect(recorded.starts).toHaveLength(0);
  });

  it('turns a seller who cannot be contacted into a 409 that names no reason', async () => {
    await start({ startOutcome: 'not_contactable', startConversationId: null });
    const response = await send('POST', '/v1/messaging/conversations', {
      subjectType: 'direct',
      sellerSlug: 'gone-shop',
    });

    expect(response.status).toBe(409);
    expect(response.body['code']).toBe('MESSAGING_SELLER_NOT_CONTACTABLE');
    expect(JSON.stringify(response.body)).not.toContain('gone-shop');
  });

  it('turns a blocked pair into a 409 that says nothing about who blocked whom', async () => {
    await start({ startOutcome: 'blocked', startConversationId: null });
    const response = await send('POST', '/v1/messaging/conversations', {
      subjectType: 'listing',
      listingId: LISTING,
    });

    expect(response.status).toBe(409);
    expect(response.body['code']).toBe('MESSAGING_BLOCKED');
    expect(response.body['detail']).toBe('The conversation is not available.');
  });

  it('turns an invalid subject into the same not-found every stranger gets', async () => {
    await start({ startOutcome: 'invalid', startConversationId: null });
    const refusedStart = await send('POST', '/v1/messaging/conversations', {
      subjectType: 'listing',
      listingId: LISTING,
    });

    await app?.close();
    await start({ sendOutcome: 'not_found' });
    const refusedSend = await send('POST', `/v1/messaging/conversations/${CONVERSATION}/messages`, {
      body: 'hello',
    });

    expect(refusedStart.status).toBe(404);
    expect(refusedSend.status).toBe(404);
    expect(comparable(refusedStart.body)).toBe(comparable(refusedSend.body));
  });

  it('counts one attempt in the approved hourly bucket', async () => {
    const recorded = await start();
    await send('POST', '/v1/messaging/conversations', { subjectType: 'listing', listingId: LISTING });
    expect(recorded.buckets).toEqual([MESSAGING_THROTTLE_BUCKETS.startConversation.name]);
    expect(MESSAGING_THROTTLE_BUCKETS.startConversation.limit).toBe(10);
    expect(MESSAGING_THROTTLE_BUCKETS.startConversation.windowSeconds).toBe(3600);
  });

  it('refuses with 429 once that bucket is full, without asking the store', async () => {
    const recorded = await start({
      overLimit: [MESSAGING_THROTTLE_BUCKETS.startConversation.name],
    });
    const response = await send('POST', '/v1/messaging/conversations', {
      subjectType: 'listing',
      listingId: LISTING,
    });

    expect(response.status).toBe(429);
    expect(response.body['code']).toBe('THROTTLED');
    expect(recorded.starts).toHaveLength(0);
  });
});

describe('sending a message', () => {
  it('answers 201 with the message as the reader returns it', async () => {
    const recorded = await start();
    const response = await send('POST', `/v1/messaging/conversations/${CONVERSATION}/messages`, {
      body: '  Still available?  ',
    });

    expect(response.status).toBe(201);
    expect(SendMessageResponseSchema.safeParse(response.body).success).toBe(true);
    expect(response.body).toEqual({
      message: {
        id: MESSAGE,
        seq: '5',
        conversationId: CONVERSATION,
        senderUserId: CALLER,
        isOwnMessage: true,
        messageType: 'text',
        body: 'Still available?',
        referenceType: null,
        referenceId: null,
        createdAt: AT.toISOString(),
        editedAt: null,
        deletedAt: null,
        // 0104. Always empty on a read-back, and correct rather than a gap: a message cannot be created with
        // an attachment — owner decision 5 keeps `messages_text_has_body` and adds nothing to the send path —
        // so one that has just committed has none. The first file arrives in its own later request.
        attachments: [],
      },
    });
    // The body reaches the store exactly as the **contract** parsed it: this layer adds nothing and removes
    // nothing of its own, which is the invariant this assertion has always been for.
    //
    // 0105 narrowed what that means. The padded body used to arrive at the store padded, because the only
    // trimming was the database's and `btrim(x)` there trimmed spaces only — so a body of one tab passed
    // `messages_text_has_body`, whose whole purpose was to refuse an empty one. `SendMessageRequestSchema` now
    // carries `.trim()`, so the ends are gone before this layer sees the value, and the database refuses a
    // whitespace-only body independently. What is still asserted here is that nothing between the schema and
    // the store touches the body.
    expect(recorded.sends).toEqual([
      { userId: CALLER, conversationId: CONVERSATION, body: 'Still available?' },
    ]);
    expect(recorded.readBacks).toEqual([
      { userId: CALLER, conversationId: CONVERSATION, limit: 1, cursorSeq: null },
    ]);
  });

  // 0105's other half. Refusing a blank body must not become reformatting a real one, so the interior of the
  // text is asserted to survive untouched — and a body that is nothing but whitespace is refused here, which
  // before 0105 reached the store and committed.
  it('keeps the interior of a body and refuses one made only of whitespace', async () => {
    const recorded = await start();
    const response = await send('POST', `/v1/messaging/conversations/${CONVERSATION}/messages`, {
      body: '\tIs  this\nstill available? \r\n',
    });

    expect(response.status).toBe(201);
    expect(recorded.sends).toEqual([
      { userId: CALLER, conversationId: CONVERSATION, body: 'Is  this\nstill available?' },
    ]);

    for (const body of ['   ', '\t', '\t\t', '\n', '\r', ' \t\r\n \t']) {
      const refused = await send('POST', `/v1/messaging/conversations/${CONVERSATION}/messages`, { body });
      expect(refused.status).toBe(400);
    }
    // One send, six refusals: not one of the blanks reached the store.
    expect(recorded.sends).toHaveLength(1);
  });

  it('refuses an empty body, a body over the limit, and a body that is not a string', async () => {
    const recorded = await start();
    for (const body of [
      { body: '' },
      { body: 'x'.repeat(MESSAGE_BODY_MAX_LENGTH + 1) },
      { body: 5 },
      { body: null },
      {},
    ]) {
      const response = await send('POST', `/v1/messaging/conversations/${CONVERSATION}/messages`, body);
      expect(response.status, JSON.stringify(body).slice(0, 40)).toBe(400);
    }
    expect(recorded.sends).toHaveLength(0);
  });

  it('accepts a body of exactly the maximum length', async () => {
    const recorded = await start();
    const response = await send('POST', `/v1/messaging/conversations/${CONVERSATION}/messages`, {
      body: 'x'.repeat(MESSAGE_BODY_MAX_LENGTH),
    });
    expect(response.status).toBe(201);
    expect(recorded.sends[0]?.body).toHaveLength(MESSAGE_BODY_MAX_LENGTH);
  });

  it('refuses a body carrying a sender, a type, a reference or an attachment', async () => {
    const recorded = await start();
    for (const extra of [
      { senderUserId: IMPOSTOR },
      { messageType: 'system' },
      { referenceType: 'listing' },
      { referenceId: LISTING },
      { attachments: [] },
      { seq: '99' },
    ]) {
      const response = await send('POST', `/v1/messaging/conversations/${CONVERSATION}/messages`, {
        body: 'hello',
        ...extra,
      });
      expect(response.status, JSON.stringify(extra)).toBe(400);
    }
    expect(recorded.sends).toHaveLength(0);
  });

  it('turns a whitespace-only body the database refuses into a 400', async () => {
    await start({ sendOutcome: 'invalid_body' });
    const response = await send('POST', `/v1/messaging/conversations/${CONVERSATION}/messages`, {
      body: '   ',
    });
    expect(response.status).toBe(400);
    expect(response.body['code']).toBe('VALIDATION_FAILED');
  });

  it('turns a closed conversation into 409 and a blocked pair into 409', async () => {
    await start({ sendOutcome: 'closed' });
    const closed = await send('POST', `/v1/messaging/conversations/${CONVERSATION}/messages`, {
      body: 'hello',
    });
    expect(closed.status).toBe(409);
    expect(closed.body['code']).toBe('MESSAGING_CONVERSATION_CLOSED');

    await app?.close();
    await start({ sendOutcome: 'blocked' });
    const blocked = await send('POST', `/v1/messaging/conversations/${CONVERSATION}/messages`, {
      body: 'hello',
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body['code']).toBe('MESSAGING_BLOCKED');
  });

  it('reports a failure rather than a success when the message cannot be read back', async () => {
    await start({ readBackEmpty: true });
    const response = await send('POST', `/v1/messaging/conversations/${CONVERSATION}/messages`, {
      body: 'hello',
    });
    expect(response.status).toBe(503);
    expect(response.body['code']).toBe('SERVICE_UNAVAILABLE');
  });

  it('counts both approved send windows, and the numbers are the approved ones', async () => {
    const recorded = await start();
    await send('POST', `/v1/messaging/conversations/${CONVERSATION}/messages`, { body: 'hello' });

    expect(recorded.buckets).toEqual([
      MESSAGING_THROTTLE_BUCKETS.sendMinute.name,
      MESSAGING_THROTTLE_BUCKETS.sendHour.name,
    ]);
    expect(MESSAGING_THROTTLE_BUCKETS.sendMinute).toMatchObject({ limit: 30, windowSeconds: 60 });
    expect(MESSAGING_THROTTLE_BUCKETS.sendHour).toMatchObject({ limit: 300, windowSeconds: 3600 });
  });

  it('still counts the hourly window when the per-minute one has already rejected', async () => {
    const recorded = await start({ overLimit: [MESSAGING_THROTTLE_BUCKETS.sendMinute.name] });
    const response = await send('POST', `/v1/messaging/conversations/${CONVERSATION}/messages`, {
      body: 'hello',
    });

    expect(response.status).toBe(429);
    expect(recorded.buckets).toEqual([
      MESSAGING_THROTTLE_BUCKETS.sendMinute.name,
      MESSAGING_THROTTLE_BUCKETS.sendHour.name,
    ]);
    expect(recorded.sends).toHaveLength(0);
  });
});

describe('read state, mute, leave and close', () => {
  it('moves the caller’s own marker and reports where it stands', async () => {
    const recorded = await start({ lastReadSeq: '4' });
    const response = await send('PUT', `/v1/messaging/conversations/${CONVERSATION}/read`, {
      seq: '9',
    });

    expect(response.status).toBe(200);
    expect(MarkReadResponseSchema.safeParse(response.body).success).toBe(true);
    // Asked for 9, clamped to 4 by the database: the answer is what stands, not what was requested.
    expect(response.body).toEqual({ lastReadSeq: '4' });
    expect(recorded.reads).toEqual([{ userId: CALLER, conversationId: CONVERSATION, seq: '9' }]);
  });

  it('accepts a thread that has never been read', async () => {
    await start({ lastReadSeq: null });
    const response = await send('PUT', `/v1/messaging/conversations/${CONVERSATION}/read`, {
      seq: '1',
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ lastReadSeq: null });
  });

  it('refuses a sequence that is not a positive whole number, and a marker for someone else', async () => {
    const recorded = await start();
    for (const payload of [
      { seq: '0' },
      { seq: '-1' },
      { seq: '1.5' },
      { seq: 5 },
      { seq: '5', userId: IMPOSTOR },
      {},
    ]) {
      const response = await send('PUT', `/v1/messaging/conversations/${CONVERSATION}/read`, payload);
      expect(response.status, JSON.stringify(payload)).toBe(400);
    }
    expect(recorded.reads).toHaveLength(0);
  });

  it('sets and clears the caller’s own mute flag', async () => {
    const recorded = await start();
    for (const isMuted of [true, false]) {
      const response = await send('PUT', `/v1/messaging/conversations/${CONVERSATION}/muted`, {
        isMuted,
      });
      expect(response.status).toBe(200);
      expect(SetMutedResponseSchema.safeParse(response.body).success).toBe(true);
      expect(response.body).toEqual({ isMuted });
    }
    expect(recorded.mutes).toEqual([
      { userId: CALLER, conversationId: CONVERSATION, isMuted: true },
      { userId: CALLER, conversationId: CONVERSATION, isMuted: false },
    ]);
  });

  it('leaves without a body and reports the membership state', async () => {
    const recorded = await start();
    const response = await send('DELETE', `/v1/messaging/conversations/${CONVERSATION}/membership`);

    expect(response.status).toBe(200);
    expect(LeaveConversationResponseSchema.safeParse(response.body).success).toBe(true);
    expect(response.body).toEqual({ membershipState: 'left' });
    expect(recorded.leaves).toEqual([{ userId: CALLER, conversationId: CONVERSATION }]);
  });

  it('closes without a body and reports when it closed', async () => {
    const recorded = await start();
    const response = await send('PUT', `/v1/messaging/conversations/${CONVERSATION}/closed`);

    expect(response.status).toBe(200);
    expect(CloseConversationResponseSchema.safeParse(response.body).success).toBe(true);
    expect(response.body).toEqual({ isClosed: true, closedAt: AT.toISOString() });
    expect(recorded.closes).toEqual([{ userId: CALLER, conversationId: CONVERSATION }]);
  });

  it('gives a stranger the same not-found on every one of the four', async () => {
    const bodies: string[] = [];
    for (const [method, path, payload, doubles] of [
      ['PUT', 'read', { seq: '5' }, { readOutcome: 'not_found' }],
      ['PUT', 'muted', { isMuted: true }, { muteOutcome: 'not_found' }],
      ['DELETE', 'membership', undefined, { leaveOutcome: 'not_found' }],
      ['PUT', 'closed', undefined, { closeOutcome: 'not_found' }],
    ] as const) {
      await app?.close();
      await start(doubles);
      const response = await send(
        method,
        `/v1/messaging/conversations/${CONVERSATION}/${path}`,
        payload,
      );
      expect(response.status, path).toBe(404);
      bodies.push(comparable(response.body));
    }
    expect(new Set(bodies).size).toBe(1);
  });

  it('refuses a conversation id that is not a uuid before asking anything', async () => {
    const recorded = await start();
    for (const [method, path, payload] of [
      ['POST', 'messages', { body: 'hello' }],
      ['PUT', 'read', { seq: '5' }],
      ['PUT', 'muted', { isMuted: true }],
      ['DELETE', 'membership', undefined],
      ['PUT', 'closed', undefined],
    ] as const) {
      const response = await send(method, `/v1/messaging/conversations/not-a-uuid/${path}`, payload);
      expect(response.status, path).toBe(400);
    }
    expect(recorded.sends).toHaveLength(0);
    expect(recorded.reads).toHaveLength(0);
    expect(recorded.mutes).toHaveLength(0);
    expect(recorded.leaves).toHaveLength(0);
    expect(recorded.closes).toHaveLength(0);
  });

  it('turns a store failure into 503 and never into a success', async () => {
    await start({ storeThrows: true });
    const response = await send('PUT', `/v1/messaging/conversations/${CONVERSATION}/muted`, {
      isMuted: true,
    });
    expect(response.status).toBe(503);
    expect(response.body['code']).toBe('SERVICE_UNAVAILABLE');
  });
});

describe('the operations that do not exist', () => {
  it('has no way to edit or delete a message, and no way to reopen a conversation', async () => {
    await start();
    for (const [method, path] of [
      ['PATCH', `/v1/messaging/conversations/${CONVERSATION}/messages/${MESSAGE}`],
      ['DELETE', `/v1/messaging/conversations/${CONVERSATION}/messages/${MESSAGE}`],
      ['PUT', `/v1/messaging/conversations/${CONVERSATION}/messages/${MESSAGE}`],
      ['POST', `/v1/messaging/conversations/${CONVERSATION}/reopen`],
      ['DELETE', `/v1/messaging/conversations/${CONVERSATION}`],
      ['POST', `/v1/messaging/conversations/${CONVERSATION}/attachments`],
    ] as const) {
      const response = await send(method, path, {});
      expect(response.status, `${method} ${path}`).toBe(404);
    }
  });

  it('does not mute or close on somebody else’s behalf through a query parameter', async () => {
    const recorded = await start();
    const response = await send(
      'PUT',
      `/v1/messaging/conversations/${CONVERSATION}/muted?userId=${IMPOSTOR}`,
      { isMuted: true },
    );

    expect(response.status).toBe(200);
    expect(recorded.mutes).toEqual([
      { userId: CALLER, conversationId: CONVERSATION, isMuted: true },
    ]);
  });
});
