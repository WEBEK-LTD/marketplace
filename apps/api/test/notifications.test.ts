import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { SESSION_TOKEN_HEADER } from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { AuthenticationRequiredError } from '../src/auth/auth-errors.js';
import { SUPABASE_AUTH_CLIENT } from '../src/auth/login.service.js';
import { NOTIFICATIONS_STORE, type NotificationRow } from '../src/notifications/notifications.service.js';
import { encodeNotificationsCursor } from '../src/notifications/notifications-cursor.js';
import { CURRENT_USER_STORE } from '../src/users/current-user.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * The notification read surface at the API boundary (Phase 7-C).
 *
 * The assertions that matter are about authority and about what leaks:
 *
 *   * the account is always the caller's own — no route accepts a user identifier anywhere, and the
 *     account the store is asked about is always the one resolved from the token;
 *   * the item carries metadata only: no title, no body, no variables, no template key, no account;
 *   * pagination is deterministic, and the cursor is opaque, versioned and refused when altered;
 *   * marking read and archiving are idempotent, and report what actually moved;
 *   * the badge comes back from the database after every mutation, never from arithmetic.
 */

const SESSION_TOKEN = 'caller-access-token-value-not-a-real-token';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '99999999-9999-4999-8999-999999999999';
const ID_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const ID_B = 'aaaaaaaa-0000-4000-8000-000000000002';
const ID_C = 'aaaaaaaa-0000-4000-8000-000000000003';
const SUBJECT = 'bbbbbbbb-0000-4000-8000-000000000001';
const CREATED = new Date('2026-09-01T10:00:00.000Z');

function row(id: string, overrides: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id,
    category: 'messages',
    eventType: 'message.created',
    subjectType: 'message',
    subjectId: SUBJECT,
    actionPath: '/dashboard/messages/abc',
    createdAt: CREATED,
    readAt: null,
    archivedAt: null,
    ...overrides,
  };
}

interface Recorded {
  readonly calls: string[];
  readonly listed: Array<Record<string, unknown>>;
  readonly marked: Array<Record<string, unknown>>;
  readonly archived: Array<Record<string, unknown>>;
  readonly counted: string[];
}

interface Doubles {
  readonly rows?: NotificationRow[];
  readonly unread?: string;
  readonly changed?: number;
  readonly listThrows?: boolean;
  readonly countThrows?: boolean;
  readonly markThrows?: boolean;
  readonly archiveThrows?: boolean;
  readonly tokenFails?: boolean;
}

let app: NestFastifyApplication | undefined;

async function start(doubles: Doubles = {}): Promise<Recorded> {
  const recorded: Recorded = { calls: [], listed: [], marked: [], archived: [], counted: [] };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(TEST_ENV)] })
    .overrideProvider(SUPABASE_AUTH_CLIENT)
    .useValue({
      getUser: async () => {
        recorded.calls.push('get-user');
        if (doubles.tokenFails === true) throw new AuthenticationRequiredError();
        return { id: USER, phone: null };
      },
    })
    .overrideProvider(CURRENT_USER_STORE)
    .useValue({
      userIdentity: async (userId: string) => {
        recorded.calls.push('user-identity');
        return { id: userId, displayName: 'Nadia' };
      },
    })
    .overrideProvider(NOTIFICATIONS_STORE)
    .useValue({
      notificationsInbox: async (input: Record<string, unknown>) => {
        recorded.calls.push('list');
        recorded.listed.push(input);
        if (doubles.listThrows === true) throw new Error('database unavailable');
        return doubles.rows ?? [];
      },
      notificationsUnreadCount: async (userId: string) => {
        recorded.calls.push('unread-count');
        recorded.counted.push(userId);
        if (doubles.countThrows === true) throw new Error('database unavailable');
        return doubles.unread ?? '0';
      },
      markNotificationsRead: async (input: Record<string, unknown>) => {
        recorded.calls.push('mark-read');
        recorded.marked.push(input);
        if (doubles.markThrows === true) throw new Error('database unavailable');
        return doubles.changed ?? 1;
      },
      archiveNotifications: async (input: Record<string, unknown>) => {
        recorded.calls.push('archive');
        recorded.archived.push(input);
        if (doubles.archiveThrows === true) throw new Error('database unavailable');
        return doubles.changed ?? 1;
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

async function call(
  method: 'GET' | 'POST',
  path: string,
  payload?: unknown,
  headers: Record<string, string | null> = {},
): Promise<Result> {
  const base: Record<string, string> = {
    'content-type': 'application/json',
    [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL,
    [SESSION_TOKEN_HEADER]: SESSION_TOKEN,
  };
  for (const [name, value] of Object.entries(headers)) {
    if (value === null) delete base[name];
    else base[name] = value;
  }
  const response = await app!.inject({
    method,
    url: `/v1/notifications${path}`,
    headers: base,
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
  return {
    status: response.statusCode,
    body: response.body.length > 0 ? (JSON.parse(response.body) as Record<string, unknown>) : {},
    raw: response.body,
  };
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /v1/notifications', () => {
  it('returns the caller’s own notifications as metadata', async () => {
    const recorded = await start({ rows: [row(ID_A)] });
    const result = await call('GET', '');

    expect(result.status).toBe(200);
    expect(Object.keys(result.body).sort()).toEqual(['items', 'nextCursor']);
    const [item] = result.body['items'] as Record<string, unknown>[];
    expect(Object.keys(item!).sort()).toEqual([
      'actionPath',
      'archivedAt',
      'category',
      'createdAt',
      'eventType',
      'id',
      'readAt',
      'subjectId',
      'subjectType',
    ]);
    expect(item!['category']).toBe('messages');
    expect(item!['eventType']).toBe('message.created');
    expect(item!['subjectType']).toBe('message');
    expect(item!['actionPath']).toBe('/dashboard/messages/abc');
    // The account the store was asked about is the one resolved from the token, never from the request.
    expect(recorded.listed[0]!['userId']).toBe(USER);
  });

  it('carries no prose, no payload and no account', async () => {
    await start({ rows: [row(ID_A)] });
    const result = await call('GET', '');

    for (const field of ['title', 'body', 'variables', 'templateKey', 'userId', 'actorUserId']) {
      expect(result.raw, field).not.toContain(`"${field}"`);
    }
    expect(result.raw).not.toContain(USER);
  });

  it('reads the inbox by default and the archived list on request', async () => {
    const recorded = await start({ rows: [] });
    await call('GET', '');
    expect(recorded.listed[0]!['archived']).toBe(false);

    await call('GET', '?view=inbox');
    expect(recorded.listed[1]!['archived']).toBe(false);

    await call('GET', '?view=archived');
    expect(recorded.listed[2]!['archived']).toBe(true);
  });

  it('refuses a view it does not have rather than quietly showing another', async () => {
    const recorded = await start({ rows: [] });
    const result = await call('GET', '?view=deleted');

    expect(result.status).toBe(400);
    expect(result.body['code']).toBe('VALIDATION_FAILED');
    expect(recorded.calls).not.toContain('list');
  });

  it('returns an empty page as an empty list, never as an error', async () => {
    await start({ rows: [] });
    const result = await call('GET', '');

    expect(result.status).toBe(200);
    expect(result.body['items']).toEqual([]);
    expect(result.body['nextCursor']).toBeNull();
  });

  it('pages deterministically, and stops exactly at the last page', async () => {
    // Asked for two; the store is asked for three so the extra row says whether more exist.
    const recorded = await start({ rows: [row(ID_A), row(ID_B), row(ID_C)] });
    const full = await call('GET', '?limit=2');

    expect(recorded.listed[0]!['limit']).toBe(3);
    expect((full.body['items'] as unknown[]).length).toBe(2);
    expect(full.body['nextCursor']).not.toBeNull();
    // The cursor names the last row the caller actually received, so the next page starts after it.
    expect(full.body['nextCursor']).toBe(
      encodeNotificationsCursor({ createdAt: CREATED, notificationId: ID_B }),
    );
    await app?.close();
    app = undefined;

    const short = await start({ rows: [row(ID_A)] });
    const last = await call('GET', '?limit=2');
    expect(last.body['nextCursor']).toBeNull();
    expect(short.listed[0]!['limit']).toBe(3);
  });

  it('is the same cursor for the same position, every time', async () => {
    await start({ rows: [row(ID_A), row(ID_B)] });
    const first = await call('GET', '?limit=1');
    const second = await call('GET', '?limit=1');

    expect(first.body['nextCursor']).toBe(second.body['nextCursor']);
  });

  it('passes a decoded cursor to the store as typed values', async () => {
    const recorded = await start({ rows: [] });
    const cursor = encodeNotificationsCursor({ createdAt: CREATED, notificationId: ID_A });
    await call('GET', `?cursor=${encodeURIComponent(cursor)}`);

    expect(recorded.listed[0]!['cursorId']).toBe(ID_A);
    expect((recorded.listed[0]!['cursorCreatedAt'] as Date).toISOString()).toBe(CREATED.toISOString());
  });

  it('refuses a cursor that was altered, malformed or issued for another list', async () => {
    const valid = encodeNotificationsCursor({ createdAt: CREATED, notificationId: ID_A });
    for (const cursor of [
      'not-a-cursor',
      '!!!!',
      `${valid}x`,
      Buffer.from(`mi1|${CREATED.toISOString()}|${ID_A}`, 'utf8').toString('base64url'),
      Buffer.from(`nt1|${CREATED.toISOString()}`, 'utf8').toString('base64url'),
      Buffer.from(`nt1|2026-02-31T10:00:00.000Z|${ID_A}`, 'utf8').toString('base64url'),
    ]) {
      const recorded = await start({ rows: [] });
      const result = await call('GET', `?cursor=${encodeURIComponent(cursor)}`);
      expect(result.status, cursor).toBe(400);
      expect(result.body['code']).toBe('NOTIFICATIONS_CURSOR_INVALID');
      // A refused cursor costs no query: the decode happens before the store is reached.
      expect(recorded.calls).not.toContain('list');
      await app?.close();
      app = undefined;
    }
    await start();
  });

  it('clamps the limit and refuses one that is not a number', async () => {
    const recorded = await start({ rows: [] });
    await call('GET', '?limit=999');
    expect(recorded.listed[0]!['limit']).toBe(51);

    const bad = await call('GET', '?limit=abc');
    expect(bad.status).toBe(400);
    expect(bad.body['code']).toBe('VALIDATION_FAILED');
  });

  it('does no work without a session, and still requires the BFF credential', async () => {
    const recorded = await start({ rows: [] });
    const noSession = await call('GET', '', undefined, { [SESSION_TOKEN_HEADER]: null });
    const noCredential = await call('GET', '', undefined, { [INTERNAL_CREDENTIAL_HEADER]: null });

    expect(noSession.status).toBe(401);
    expect(noSession.body['code']).toBe('AUTHENTICATION_REQUIRED');
    expect(noCredential.status).toBe(403);
    expect(recorded.calls).not.toContain('list');
  });

  it('is a 503 when the reader cannot be reached, never an empty inbox', async () => {
    await start({ listThrows: true });
    const result = await call('GET', '');

    // An outage rendered as "you have no notifications" would be a lie a person could act on.
    expect(result.status).toBe(503);
    expect(result.body['code']).toBe('SERVICE_UNAVAILABLE');
  });
});

describe('GET /v1/notifications/unread-count', () => {
  it('answers for the caller and nobody else', async () => {
    const recorded = await start({ unread: '7' });
    const result = await call('GET', '/unread-count');

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ unreadCount: 7 });
    expect(recorded.counted).toEqual([USER]);
  });

  it('is a 503 rather than a zero when the count cannot be read', async () => {
    await start({ countThrows: true });
    const result = await call('GET', '/unread-count');

    // A badge showing zero because the database was unreachable would hide real notifications.
    expect(result.status).toBe(503);
  });

  it('refuses a count a double could not hold exactly', async () => {
    await start({ unread: '99999999999999999999' });
    const result = await call('GET', '/unread-count');

    expect(result.status).toBe(503);
  });

  it('requires a session', async () => {
    const recorded = await start({ unread: '1' });
    const result = await call('GET', '/unread-count', undefined, { [SESSION_TOKEN_HEADER]: null });

    expect(result.status).toBe(401);
    expect(recorded.calls).toEqual([]);
  });
});

describe('POST /v1/notifications/read', () => {
  it('marks the named notifications and reports the badge afterwards', async () => {
    const recorded = await start({ changed: 2, unread: '3' });
    const result = await call('POST', '/read', { ids: [ID_A, ID_B] });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ changed: 2, unreadCount: 3 });
    expect(recorded.marked[0]).toEqual({ userId: USER, ids: [ID_A, ID_B] });
    // The badge is re-read from the database rather than computed from `changed`.
    expect(recorded.counted).toEqual([USER]);
  });

  it('marks everything when no identifiers are named', async () => {
    const recorded = await start({ changed: 5, unread: '0' });
    const result = await call('POST', '/read', {});

    expect(result.status).toBe(200);
    // Null is 0029's own "all of them" form, and it is kept distinct from an empty list.
    expect(recorded.marked[0]).toEqual({ userId: USER, ids: null });
    expect(result.body['unreadCount']).toBe(0);
  });

  it('is idempotent: a repeat changes nothing and still succeeds', async () => {
    await start({ changed: 0, unread: '0' });
    const result = await call('POST', '/read', { ids: [ID_A] });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ changed: 0, unreadCount: 0 });
  });

  it('never lets a request name the account it acts on', async () => {
    const recorded = await start();
    const result = await call('POST', '/read', { ids: [ID_A], userId: OTHER_USER });

    expect(result.status).toBe(400);
    expect(result.body['code']).toBe('VALIDATION_FAILED');
    expect(recorded.calls).not.toContain('mark-read');
  });

  it('forwards another account’s identifier unchanged, because the writer will not match it', async () => {
    const recorded = await start({ changed: 0, unread: '4' });
    const result = await call('POST', '/read', { ids: [ID_A] });

    // The account is always the caller's; the identifiers are whatever was asked for. An id belonging to
    // somebody else simply matches no row, so nothing about it is reported and nothing is refused.
    expect(recorded.marked[0]!['userId']).toBe(USER);
    expect(result.body['changed']).toBe(0);
  });

  it('refuses a malformed body before any write', async () => {
    for (const payload of [{ ids: [] }, { ids: ['not-a-uuid'] }, { ids: ID_A }, { all: true }]) {
      const recorded = await start();
      const result = await call('POST', '/read', payload);
      expect(result.status, JSON.stringify(payload)).toBe(400);
      expect(recorded.calls).not.toContain('mark-read');
      await app?.close();
      app = undefined;
    }
    await start();
  });

  it('bounds how many can be named at once', async () => {
    const recorded = await start();
    const result = await call('POST', '/read', { ids: Array.from({ length: 51 }, () => ID_A) });

    expect(result.status).toBe(400);
    expect(recorded.calls).not.toContain('mark-read');
  });

  it('requires a session and the BFF credential, and does no work without either', async () => {
    const recorded = await start();
    const noSession = await call('POST', '/read', { ids: [ID_A] }, { [SESSION_TOKEN_HEADER]: null });
    const noCredential = await call('POST', '/read', { ids: [ID_A] }, { [INTERNAL_CREDENTIAL_HEADER]: null });

    expect(noSession.status).toBe(401);
    expect(noCredential.status).toBe(403);
    expect(recorded.calls).not.toContain('mark-read');
  });

  it('is a 503 when the writer cannot be reached', async () => {
    await start({ markThrows: true });
    const result = await call('POST', '/read', { ids: [ID_A] });

    expect(result.status).toBe(503);
  });
});

describe('POST /v1/notifications/archive', () => {
  it('archives the named notifications and reports the badge afterwards', async () => {
    const recorded = await start({ changed: 1, unread: '2' });
    const result = await call('POST', '/archive', { ids: [ID_A] });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ changed: 1, unreadCount: 2 });
    expect(recorded.archived[0]).toEqual({ userId: USER, ids: [ID_A] });
  });

  it('is idempotent: a repeat changes nothing and still succeeds', async () => {
    await start({ changed: 0, unread: '2' });
    const result = await call('POST', '/archive', { ids: [ID_A] });

    expect(result.status).toBe(200);
    expect(result.body['changed']).toBe(0);
  });

  it('requires identifiers, so no request can empty an inbox', async () => {
    for (const payload of [{}, { ids: [] }, { ids: null }]) {
      const recorded = await start();
      const result = await call('POST', '/archive', payload);
      expect(result.status, JSON.stringify(payload)).toBe(400);
      expect(recorded.calls).not.toContain('archive');
      await app?.close();
      app = undefined;
    }
    await start();
  });

  it('never lets a request name the account it acts on', async () => {
    const recorded = await start();
    const result = await call('POST', '/archive', { ids: [ID_A], userId: OTHER_USER });

    expect(result.status).toBe(400);
    expect(recorded.calls).not.toContain('archive');
  });

  it('requires a session', async () => {
    const recorded = await start();
    const result = await call('POST', '/archive', { ids: [ID_A] }, { [SESSION_TOKEN_HEADER]: null });

    expect(result.status).toBe(401);
    expect(recorded.calls).not.toContain('archive');
  });

  it('is a 503 when the writer cannot be reached', async () => {
    await start({ archiveThrows: true });
    const result = await call('POST', '/archive', { ids: [ID_A] });

    expect(result.status).toBe(503);
  });
});

describe('the surface as a whole', () => {
  it('offers no way to create or delete a notification', async () => {
    await start();

    for (const [method, path] of [
      ['POST', ''],
      ['DELETE', ''],
      ['DELETE', '/read'],
      ['PUT', '/read'],
      ['POST', '/preferences'],
      ['POST', '/saved-search'],
    ] as const) {
      const response = await app!.inject({
        method,
        url: `/v1/notifications${path}`,
        headers: {
          'content-type': 'application/json',
          [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL,
          [SESSION_TOKEN_HEADER]: SESSION_TOKEN,
        },
        payload: '{}',
      });
      expect([404, 405], `${method} ${path}`).toContain(response.statusCode);
    }
  });

  it('refuses everything when the caller’s token is not accepted', async () => {
    const recorded = await start({ tokenFails: true });
    const list = await call('GET', '');
    const count = await call('GET', '/unread-count');
    const read = await call('POST', '/read', { ids: [ID_A] });
    const archive = await call('POST', '/archive', { ids: [ID_A] });

    for (const result of [list, count, read, archive]) {
      expect(result.status).toBe(401);
    }
    expect(recorded.calls).not.toContain('list');
    expect(recorded.calls).not.toContain('mark-read');
    expect(recorded.calls).not.toContain('archive');
  });
});
