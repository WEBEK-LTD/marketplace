import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { SESSION_TOKEN_HEADER } from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MESSAGE_ATTACHMENT_LINK_SECONDS,
  MESSAGE_ATTACHMENT_STORE,
  type MessageAttachmentAttachRow,
  type MessageAttachmentObjectRow,
  type MessageAttachmentTargetRow,
} from '../src/messaging/message-attachments.service.js';
import { MESSAGING_STORE, type MessageAttachmentRow, type MessageRow } from '../src/messaging/messaging.service.js';
import {
  SELLER_MEDIA_STORAGE,
  SellerMediaStorageUnavailableError,
} from '../src/sellers/seller-media.storage.js';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { SUPABASE_AUTH_CLIENT } from '../src/auth/login.service.js';
import { CURRENT_USER_STORE } from '../src/users/current-user.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * Conversation attachments at the API boundary (0104).
 *
 * The three-step flow is what this file is about, and the order of the third step is the part worth proving:
 *
 *   * **a row is recorded only after storage confirms the object** — asserted by refusing when it says no, and
 *     by asserting the store was never asked;
 *   * **storage is asked before the database**, so the worst failure is an orphaned object rather than a row
 *     pointing at nothing;
 *   * **the client's path is forwarded, not validated here** — the database re-derives it, and a second,
 *     weaker copy of that check in this layer is exactly what is absent;
 *   * **the signed read lasts ten minutes**, passed per call so four closed surfaces keep their own lifetime;
 *   * **no request names an account**, and no response carries a path;
 *   * **every refusal maps to one approved problem**, and a blocked pair reuses `MESSAGING_BLOCKED`.
 */

const SESSION_TOKEN = 'caller-access-token-value-not-a-real-token';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '99999999-9999-4999-8999-999999999999';
const CONVERSATION = '22222222-2222-4222-8222-222222222222';
const MESSAGE = '33333333-3333-4333-8333-333333333333';
const ATTACHMENT = '44444444-4444-4444-8444-444444444444';
const OBJECT_PATH = `message-attachments/${CONVERSATION}/${MESSAGE}/55555555-5555-4555-8555-555555555555.png`;

interface Recorded {
  readonly calls: string[];
  readonly args: Array<Record<string, unknown>>;
  readonly storage: Array<{ call: string; bucket: string; path: string; expires?: number | undefined }>;
}

interface Doubles {
  readonly target?: MessageAttachmentTargetRow;
  readonly attach?: MessageAttachmentAttachRow;
  readonly object?: MessageAttachmentObjectRow;
  readonly exists?: boolean;
  readonly storageThrows?: 'signUpload' | 'objectExists' | 'signDownload';
  readonly storeThrows?: boolean;
}

const AUTHORIZED: MessageAttachmentTargetRow = {
  outcome: 'authorized',
  bucketId: 'message-attachments',
  objectPath: OBJECT_PATH,
  maxByteSize: 10_485_760,
};

const ATTACHED: MessageAttachmentAttachRow = {
  outcome: 'attached',
  attachmentId: ATTACHMENT,
  attachmentCount: 1,
};

const RESOLVED: MessageAttachmentObjectRow = {
  outcome: 'authorized',
  bucketId: 'message-attachments',
  objectPath: OBJECT_PATH,
  contentType: 'image/png',
};

let app: NestFastifyApplication | undefined;

async function start(doubles: Doubles = {}): Promise<Recorded> {
  const recorded: Recorded = { calls: [], args: [], storage: [] };
  const record = <T>(name: string, input: unknown, value: T): T => {
    recorded.calls.push(name);
    recorded.args.push(
      (typeof input === 'object' && input !== null ? input : { input }) as Record<string, unknown>,
    );
    if (doubles.storeThrows === true) throw new Error('database unavailable');
    return value;
  };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(TEST_ENV)] })
    .overrideProvider(SUPABASE_AUTH_CLIENT)
    .useValue({ getUser: async () => ({ id: USER, phone: null }) })
    .overrideProvider(CURRENT_USER_STORE)
    .useValue({ userIdentity: async (userId: string) => ({ id: userId, displayName: 'Amina' }) })
    .overrideProvider(MESSAGE_ATTACHMENT_STORE)
    .useValue({
      messageAttachmentTarget: async (input: unknown) =>
        record('target', input, doubles.target ?? AUTHORIZED),
      messageAttachmentAttach: async (input: unknown) => record('attach', input, doubles.attach ?? ATTACHED),
      messageAttachmentForParticipant: async (input: unknown) =>
        record('resolve', input, doubles.object ?? RESOLVED),
    })
    .overrideProvider(SELLER_MEDIA_STORAGE)
    .useValue({
      signUpload: async (bucket: string, path: string) => {
        recorded.storage.push({ call: 'signUpload', bucket, path });
        if (doubles.storageThrows === 'signUpload') {
          throw new SellerMediaStorageUnavailableError(new Error('provider down'));
        }
        return {
          uploadUrl: 'https://storage.test/upload/opaque-token',
          expiresAt: new Date('2026-10-04T12:02:00.000Z'),
        };
      },
      objectExists: async (bucket: string, path: string) => {
        recorded.storage.push({ call: 'objectExists', bucket, path });
        if (doubles.storageThrows === 'objectExists') {
          throw new SellerMediaStorageUnavailableError(new Error('provider down'));
        }
        return doubles.exists ?? true;
      },
      signDownload: async (bucket: string, path: string, expiresInSeconds?: number) => {
        recorded.storage.push({ call: 'signDownload', bucket, path, expires: expiresInSeconds });
        if (doubles.storageThrows === 'signDownload') {
          throw new SellerMediaStorageUnavailableError(new Error('provider down'));
        }
        return {
          url: 'https://storage.test/read/opaque-token',
          expiresAt: new Date('2026-10-04T12:10:00.000Z'),
        };
      },
    })
    .overrideProvider(MESSAGING_STORE)
    .useValue({
      messagingInbox: async () => [],
      messagingConversationMessages: async (): Promise<readonly MessageRow[]> => [],
      messagingMessageAttachments: async (): Promise<readonly MessageAttachmentRow[]> => [],
      messagingUnreadCount: async () => '0',
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
  path: string,
  payload?: unknown,
  headers: Record<string, string | null> = {},
): Promise<Result> {
  const base: Record<string, string> = {
    [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL,
    [SESSION_TOKEN_HEADER]: SESSION_TOKEN,
  };
  if (payload !== undefined) base['content-type'] = 'application/json';
  for (const [name, value] of Object.entries(headers)) {
    if (value === null) delete base[name];
    else base[name] = value;
  }
  const response = await app!.inject({
    method,
    url: `/v1${path}`,
    headers: base,
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
  return {
    status: response.statusCode,
    body: response.body.length > 0 ? (JSON.parse(response.body) as Record<string, unknown>) : {},
    raw: response.body,
  };
}

const UPLOADS = `/messaging/conversations/${CONVERSATION}/messages/${MESSAGE}/attachments/uploads`;
const ATTACHMENTS = `/messaging/conversations/${CONVERSATION}/messages/${MESSAGE}/attachments`;
const LINK = `/messaging/conversations/${CONVERSATION}/attachments/${ATTACHMENT}/link`;

const UPLOAD_BODY = { contentType: 'image/png', byteSize: 1000 } as const;
const RECORD_BODY = { objectPath: OBJECT_PATH, contentType: 'image/png', byteSize: 1000 } as const;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/* ------------------------------------------------------------------------------------------------ */

describe('authority on all three routes', () => {
  const routes: Array<[('GET' | 'POST'), string, unknown]> = [
    ['POST', UPLOADS, UPLOAD_BODY],
    ['POST', ATTACHMENTS, RECORD_BODY],
    ['GET', LINK, undefined],
  ];

  it('refuses every route without a session, before any store or storage call', async () => {
    for (const [method, path, payload] of routes) {
      const recorded = await start();
      const result = await call(method, path, payload, { [SESSION_TOKEN_HEADER]: null });
      expect(result.status, `${method} ${path}`).toBe(401);
      expect(recorded.calls, `${method} ${path}`).toEqual([]);
      expect(recorded.storage, `${method} ${path}`).toEqual([]);
      await app?.close();
      app = undefined;
    }
  });

  it('refuses every route without the internal credential', async () => {
    for (const [method, path, payload] of routes) {
      const recorded = await start();
      const result = await call(method, path, payload, { [INTERNAL_CREDENTIAL_HEADER]: null });
      expect(result.status, `${method} ${path}`).toBe(403);
      expect(recorded.calls).toEqual([]);
      expect(recorded.storage).toEqual([]);
      await app?.close();
      app = undefined;
    }
  });

  it('always asks the store about the account it resolved from the token', async () => {
    const recorded = await start();
    await call('POST', UPLOADS, { ...UPLOAD_BODY, userId: OTHER_USER });
    await call('POST', ATTACHMENTS, RECORD_BODY);
    await call('GET', LINK);

    for (const args of recorded.args) {
      expect(args['userId']).toBe(USER);
      expect(JSON.stringify(args)).not.toContain(OTHER_USER);
    }
  });

  it('refuses a body that names an account rather than ignoring the field', async () => {
    const recorded = await start();
    const refused = await call('POST', UPLOADS, { ...UPLOAD_BODY, userId: OTHER_USER });
    expect(refused.status).toBe(400);
    expect(recorded.calls).not.toContain('target');
  });

  it('refuses a malformed identifier in any position', async () => {
    const recorded = await start();
    const bad = [
      `/messaging/conversations/not-a-uuid/messages/${MESSAGE}/attachments/uploads`,
      `/messaging/conversations/${CONVERSATION}/messages/not-a-uuid/attachments/uploads`,
      `/messaging/conversations/${CONVERSATION}/messages/not-a-uuid/attachments`,
    ];
    for (const path of bad) {
      const result = await call('POST', path, UPLOAD_BODY);
      expect(result.status, path).toBe(400);
    }
    const link = await call('GET', `/messaging/conversations/${CONVERSATION}/attachments/not-a-uuid/link`);
    expect(link.status).toBe(400);
    expect(recorded.calls).toEqual([]);
  });
});

describe('step one: authorizing an upload', () => {
  it('returns the path the database composed and a signed URL bound to it', async () => {
    const recorded = await start();
    const result = await call('POST', UPLOADS, UPLOAD_BODY);

    expect(result.status).toBe(200);
    expect(result.body['upload']).toEqual({
      uploadUrl: 'https://storage.test/upload/opaque-token',
      objectPath: OBJECT_PATH,
      expiresAt: '2026-10-04T12:02:00.000Z',
      maxByteSize: 10_485_760,
    });
    expect(recorded.storage).toEqual([
      { call: 'signUpload', bucket: 'message-attachments', path: OBJECT_PATH },
    ]);
  });

  /** The authorization is the only thing that happens; a row would be a row pointing at nothing. */
  it('records nothing', async () => {
    const recorded = await start();
    await call('POST', UPLOADS, UPLOAD_BODY);
    expect(recorded.calls).toEqual(['target']);
    expect(recorded.calls).not.toContain('attach');
  });

  it('accepts no path, bucket or filename from the request', async () => {
    const recorded = await start();
    await call('POST', UPLOADS, {
      ...UPLOAD_BODY,
      objectPath: '../../etc/passwd',
      bucket: 'listing-variants',
      originalFilename: 'x.png',
    });
    // The body is strict, so this is refused outright rather than having the extra fields dropped.
    expect(recorded.calls).not.toContain('target');

    await call('POST', UPLOADS, UPLOAD_BODY);
    expect(recorded.storage.at(-1)?.path).toBe(OBJECT_PATH);
  });

  it('refuses a content type outside the allowlist, and SVG in particular', async () => {
    const recorded = await start();
    for (const contentType of [
      'image/svg+xml',
      'text/html',
      'application/octet-stream',
      'image/avif',
      'IMAGE/PNG',
    ]) {
      const result = await call('POST', UPLOADS, { contentType, byteSize: 1000 });
      expect(result.status, contentType).toBe(400);
    }
    expect(recorded.calls).toEqual([]);
  });

  it('refuses a size over ten mebibytes before the hop', async () => {
    const recorded = await start();
    expect((await call('POST', UPLOADS, { contentType: 'image/png', byteSize: 10_485_761 })).status).toBe(400);
    expect((await call('POST', UPLOADS, { contentType: 'image/png', byteSize: 0 })).status).toBe(400);
    expect((await call('POST', UPLOADS, { contentType: 'image/png', byteSize: -1 })).status).toBe(400);
    expect(recorded.calls).toEqual([]);
  });

  it('accepts exactly ten mebibytes', async () => {
    await start();
    expect((await call('POST', UPLOADS, { contentType: 'image/png', byteSize: 10_485_760 })).status).toBe(200);
  });

  it('reports the tighter of the database ceiling and the contract bound', async () => {
    await start({ target: { ...AUTHORIZED, maxByteSize: 20_971_520 } });
    const result = await call('POST', UPLOADS, UPLOAD_BODY);
    const upload = result.body['upload'] as { maxByteSize: number };
    expect(upload.maxByteSize).toBe(10_485_760);
  });

  it('maps every refusal the database can give to one approved problem', async () => {
    const cases: Array<[MessageAttachmentTargetRow['outcome'], number, string]> = [
      ['not_found', 404, 'NOT_FOUND'],
      ['blocked', 409, 'MESSAGING_BLOCKED'],
      ['conflict', 409, 'MESSAGE_ATTACHMENT_LIMIT_REACHED'],
      ['invalid', 400, 'VALIDATION_FAILED'],
    ];
    for (const [outcome, status, code] of cases) {
      const recorded = await start({
        target: { outcome, bucketId: null, objectPath: null, maxByteSize: null },
      });
      const result = await call('POST', UPLOADS, UPLOAD_BODY);
      expect(result.status, outcome).toBe(status);
      expect(result.body['code'], outcome).toBe(code);
      // No signature is issued for a refused authorization.
      expect(recorded.storage, outcome).toEqual([]);
      await app?.close();
      app = undefined;
    }
  });

  it('answers 503 when the provider cannot sign, and leaks nothing about it', async () => {
    const result = await (async () => {
      await start({ storageThrows: 'signUpload' });
      return await call('POST', UPLOADS, UPLOAD_BODY);
    })();
    expect(result.status).toBe(503);
    expect(result.raw).not.toContain('provider down');
    expect(result.raw).not.toContain(OBJECT_PATH);
  });

  it('answers 503 when the database cannot be reached', async () => {
    await start({ storeThrows: true });
    const result = await call('POST', UPLOADS, UPLOAD_BODY);
    expect(result.status).toBe(503);
    expect(result.raw).not.toContain('database unavailable');
  });

  it('treats an authorized outcome with a missing target as a failure, not a success', async () => {
    await start({ target: { outcome: 'authorized', bucketId: null, objectPath: null, maxByteSize: null } });
    const result = await call('POST', UPLOADS, UPLOAD_BODY);
    expect(result.status).toBe(503);
  });
});

describe('step three: recording a confirmed object', () => {
  /** The property the whole three-step design exists for. */
  it('asks storage whether the object is there before it records anything', async () => {
    const recorded = await start();
    const result = await call('POST', ATTACHMENTS, RECORD_BODY);

    expect(result.status).toBe(201);
    expect(result.body).toEqual({ attachmentId: ATTACHMENT, attachmentCount: 1 });
    // Storage first, database second. The order is the guarantee.
    expect(recorded.storage[0]).toEqual({
      call: 'objectExists',
      bucket: 'message-attachments',
      path: OBJECT_PATH,
    });
    expect(recorded.calls).toEqual(['attach']);
  });

  it('records nothing when the object is not there', async () => {
    const recorded = await start({ exists: false });
    const result = await call('POST', ATTACHMENTS, RECORD_BODY);

    expect(result.status).toBe(409);
    expect(result.body['code']).toBe('MESSAGE_ATTACHMENT_OBJECT_MISSING');
    expect(recorded.calls).toEqual([]);
  });

  it('records nothing when storage cannot be asked', async () => {
    const recorded = await start({ storageThrows: 'objectExists' });
    const result = await call('POST', ATTACHMENTS, RECORD_BODY);

    expect(result.status).toBe(503);
    expect(recorded.calls).toEqual([]);
    expect(result.raw).not.toContain('provider down');
  });

  /**
   * The path is the database's to check, not this layer's.
   *
   * A path for another message is forwarded verbatim and refused by the database, which re-derives the prefix.
   * A second, weaker check here would be a second thing to keep in step — and the one that is weaker is the one
   * somebody would eventually trust.
   */
  it('forwards the path it was given without judging it', async () => {
    const recorded = await start({
      attach: { outcome: 'invalid', attachmentId: null, attachmentCount: null },
    });
    const foreign = `message-attachments/${CONVERSATION}/66666666-6666-4666-8666-666666666666/x.png`;
    const result = await call('POST', ATTACHMENTS, { ...RECORD_BODY, objectPath: foreign });

    expect(recorded.args.at(-1)?.['objectPath']).toBe(foreign);
    expect(result.status).toBe(400);
    expect(result.body['code']).toBe('VALIDATION_FAILED');
  });

  it('refuses a content type outside the allowlist before anything is asked', async () => {
    const recorded = await start();
    for (const contentType of ['image/svg+xml', 'text/html', 'image/avif']) {
      const result = await call('POST', ATTACHMENTS, { ...RECORD_BODY, contentType });
      expect(result.status, contentType).toBe(400);
    }
    expect(recorded.storage).toEqual([]);
    expect(recorded.calls).toEqual([]);
  });

  it('refuses a body with no path, or one absurdly long', async () => {
    const recorded = await start();
    expect((await call('POST', ATTACHMENTS, { contentType: 'image/png', byteSize: 1000 })).status).toBe(400);
    expect(
      (await call('POST', ATTACHMENTS, { ...RECORD_BODY, objectPath: 'x'.repeat(513) })).status,
    ).toBe(400);
    expect(recorded.calls).toEqual([]);
  });

  it('maps every refusal the database can give to one approved problem', async () => {
    const cases: Array<[MessageAttachmentAttachRow['outcome'], number, string]> = [
      ['not_found', 404, 'NOT_FOUND'],
      ['blocked', 409, 'MESSAGING_BLOCKED'],
      ['conflict', 409, 'MESSAGE_ATTACHMENT_LIMIT_REACHED'],
      ['invalid', 400, 'VALIDATION_FAILED'],
    ];
    for (const [outcome, status, code] of cases) {
      await start({ attach: { outcome, attachmentId: null, attachmentCount: null } });
      const result = await call('POST', ATTACHMENTS, RECORD_BODY);
      expect(result.status, outcome).toBe(status);
      expect(result.body['code'], outcome).toBe(code);
      await app?.close();
      app = undefined;
    }
  });

  it('never returns the object path to the caller', async () => {
    await start();
    const result = await call('POST', ATTACHMENTS, RECORD_BODY);
    expect(result.raw).not.toContain(OBJECT_PATH);
    expect(result.raw).not.toContain('message-attachments');
  });
});

describe('the signed read', () => {
  it('signs the object the row names, for ten minutes', async () => {
    const recorded = await start();
    const result = await call('GET', LINK);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      url: 'https://storage.test/read/opaque-token',
      expiresAt: '2026-10-04T12:10:00.000Z',
    });
    expect(recorded.storage).toEqual([
      {
        call: 'signDownload',
        bucket: 'message-attachments',
        path: OBJECT_PATH,
        expires: MESSAGE_ATTACHMENT_LINK_SECONDS,
      },
    ]);
    expect(MESSAGE_ATTACHMENT_LINK_SECONDS).toBe(600);
  });

  /** The caller names an attachment; the path is the database's. A request cannot aim the signature. */
  it('takes no path from the request', async () => {
    const recorded = await start();
    await call('GET', `${LINK}?objectPath=${encodeURIComponent('other/object.png')}`);
    expect(recorded.storage.at(-1)?.path).toBe(OBJECT_PATH);
    expect(recorded.args.at(-1)).toEqual({
      userId: USER,
      conversationId: CONVERSATION,
      attachmentId: ATTACHMENT,
    });
  });

  it('answers 404 for an attachment this caller may not see', async () => {
    const recorded = await start({
      object: { outcome: 'not_found', bucketId: null, objectPath: null, contentType: null },
    });
    const result = await call('GET', LINK);

    expect(result.status).toBe(404);
    expect(result.body['code']).toBe('NOT_FOUND');
    // Nothing is signed for a refusal.
    expect(recorded.storage).toEqual([]);
  });

  it('answers 503 when the provider cannot sign', async () => {
    const result = await (async () => {
      await start({ storageThrows: 'signDownload' });
      return await call('GET', LINK);
    })();
    expect(result.status).toBe(503);
    expect(result.raw).not.toContain(OBJECT_PATH);
    expect(result.raw).not.toContain('provider down');
  });

  it('answers 503 when the database cannot be reached', async () => {
    await start({ storeThrows: true });
    expect((await call('GET', LINK)).status).toBe(503);
  });
});

describe('the thread read carries attachments', () => {
  const MESSAGE_ROW: MessageRow = {
    id: MESSAGE,
    seq: '1',
    conversationId: CONVERSATION,
    senderUserId: USER,
    isOwnMessage: true,
    messageType: 'text',
    body: 'Here it is.',
    referenceType: null,
    referenceId: null,
    createdAt: new Date('2026-10-04T10:00:00.000Z'),
    editedAt: null,
    deletedAt: null,
  };

  async function startThread(doubles: {
    messages?: readonly MessageRow[];
    attachments?: readonly MessageAttachmentRow[];
    attachmentsThrow?: boolean;
  }): Promise<{ seen: Array<Record<string, unknown>> }> {
    const seen: Array<Record<string, unknown>> = [];
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(TEST_ENV)] })
      .overrideProvider(SUPABASE_AUTH_CLIENT)
      .useValue({ getUser: async () => ({ id: USER, phone: null }) })
      .overrideProvider(CURRENT_USER_STORE)
      .useValue({ userIdentity: async (userId: string) => ({ id: userId, displayName: 'Amina' }) })
      .overrideProvider(MESSAGING_STORE)
      .useValue({
        messagingInbox: async () => [],
        messagingConversationMessages: async () => doubles.messages ?? [MESSAGE_ROW],
        messagingMessageAttachments: async (input: Record<string, unknown>) => {
          seen.push(input);
          if (doubles.attachmentsThrow === true) throw new Error('attachments unavailable');
          return doubles.attachments ?? [];
        },
        messagingUnreadCount: async () => '0',
      })
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      createFastifyAdapter(TEST_ENV, { logStream: { write: () => undefined } }),
      NEST_APP_OPTIONS,
    );
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    return { seen };
  }

  it('asks for the attachments of exactly the page it is returning', async () => {
    const { seen } = await startThread({});
    await call('GET', `/messaging/conversations/${CONVERSATION}/messages`);

    expect(seen).toEqual([{ userId: USER, conversationId: CONVERSATION, messageIds: [MESSAGE] }]);
  });

  it('renders them on the message, with no path and no filename', async () => {
    await startThread({
      attachments: [
        {
          id: ATTACHMENT,
          messageId: MESSAGE,
          contentType: 'image/png',
          byteSize: '1000',
          createdAt: new Date('2026-10-04T10:01:00.000Z'),
        },
      ],
    });
    const result = await call('GET', `/messaging/conversations/${CONVERSATION}/messages`);

    expect(result.status).toBe(200);
    const items = result.body['items'] as Array<Record<string, unknown>>;
    expect(items[0]?.['attachments']).toEqual([
      { id: ATTACHMENT, contentType: 'image/png', byteSize: '1000' },
    ]);
    expect(result.raw).not.toContain('message-attachments/');
    expect(result.raw).not.toContain('objectPath');
  });

  it('reports an empty list rather than omitting the field', async () => {
    await startThread({ attachments: [] });
    const result = await call('GET', `/messaging/conversations/${CONVERSATION}/messages`);
    const items = result.body['items'] as Array<Record<string, unknown>>;
    expect(items[0]?.['attachments']).toEqual([]);
  });

  /** A round trip that could only answer "none" is a round trip worth not making. */
  it('asks nothing when the page is empty', async () => {
    const { seen } = await startThread({ messages: [] });
    await call('GET', `/messaging/conversations/${CONVERSATION}/messages?cursor=bXMxfDk5`);
    expect(seen).toEqual([]);
  });

  /**
   * A thread whose attachments could not be read is not a thread with no attachments.
   *
   * Rendering it as empty would silently lose a file somebody sent, and no reader could tell afterwards.
   */
  it('fails the whole read when the attachments cannot be read', async () => {
    await startThread({ attachmentsThrow: true });
    const result = await call('GET', `/messaging/conversations/${CONVERSATION}/messages`);
    expect(result.status).toBe(503);
    expect(result.raw).not.toContain('attachments unavailable');
  });

  it('drops a content type the contract does not name rather than failing the thread', async () => {
    await startThread({
      attachments: [
        {
          id: ATTACHMENT,
          messageId: MESSAGE,
          contentType: 'image/svg+xml',
          byteSize: '1000',
          createdAt: new Date('2026-10-04T10:01:00.000Z'),
        },
      ],
    });
    const result = await call('GET', `/messaging/conversations/${CONVERSATION}/messages`);

    expect(result.status).toBe(200);
    const items = result.body['items'] as Array<Record<string, unknown>>;
    expect(items[0]?.['attachments']).toEqual([]);
    expect(result.raw).not.toContain('svg');
  });
});

describe('the service and controller sources', () => {
  const service = readFileSync(
    join(import.meta.dirname, '..', 'src', 'messaging', 'message-attachments.service.ts'),
    'utf8',
  );
  const code = service.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  /** The one storage client, reused. A second would be a second credential and a second failure mode. */
  it('uses the existing storage port and introduces no second client', () => {
    expect(code).toContain('SELLER_MEDIA_STORAGE');
    expect(code).not.toContain('createClient');
    expect(code).not.toContain('new SupabaseStorageClient');
    expect(code).not.toContain('SUPABASE_SERVICE');
  });

  it('composes no object path and derives no namespace', () => {
    expect(code).not.toMatch(/message-attachments\/\$\{/);
    expect(code).not.toContain('gen_random_uuid');
    expect(code).not.toContain('randomUUID');
  });

  it('decides no authority of its own', () => {
    for (const name of ['isAal2', 'requiresMfa', 'permission', 'is_blocked_between', 'sender_user_id']) {
      expect(code, name).not.toContain(name);
    }
  });

  it('adds no staff or moderation operation', () => {
    for (const name of ['forStaff', 'forAgent', 'moderat', 'scan', 'virus', 'thumbnail', 'resize']) {
      expect(code.toLowerCase(), name).not.toContain(name.toLowerCase());
    }
  });

  it('logs no path, URL or provider message', () => {
    const logged = [...code.matchAll(/logger\.\w+\(([^)]*)\)/g)].map((match) => match[1] ?? '');
    for (const line of logged) {
      expect(line).not.toContain('objectPath');
      expect(line).not.toContain('url');
      expect(line).not.toContain('error');
      expect(line).not.toContain('${');
    }
  });
});
