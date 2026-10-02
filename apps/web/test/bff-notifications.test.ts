import { describe, expect, it } from 'vitest';
import {
  handleArchiveNotifications,
  handleMarkNotificationsRead,
  readNotifications,
  readNotificationsUnreadCount,
} from '../src/server/bff/notifications';
import { SESSION_COOKIES } from '../src/server/bff/session-cookies';

/**
 * The BFF half of the notification surface (Phase 7-C).
 *
 * What matters at this boundary:
 *
 *   * the caller's token comes from the `__Host-mp_access` cookie and never from a request body, and the
 *     browser's own `Cookie` header is never forwarded upstream;
 *   * **request bodies are rebuilt**, so a `userId` a page added is dropped before the request leaves this
 *     origin — the API's strict schema would refuse it too, and neither wall relies on the other;
 *   * responses are validated against the shared contract rather than forwarded, so a drifted body becomes
 *     a clean failure instead of a half-rendered list;
 *   * a session that ended and a service that could not answer stay distinct outcomes;
 *   * the cursor is passed through verbatim and never parsed here.
 */

const ENV = Object.freeze({
  API_BASE_URL: 'https://api.internal.test',
  PUBLIC_WEB_ORIGIN: 'https://web.test',
  INTERNAL_BFF_CREDENTIAL: 'test-current-credential-value-not-a-real-se',
});

const SESSION_TOKEN = 'session-token-canary-value-not-a-real-token';
const COOKIE = `${SESSION_COOKIES.access.name}=${SESSION_TOKEN}`;
const ID_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const ID_B = 'aaaaaaaa-0000-4000-8000-000000000002';
const OTHER_USER = '99999999-9999-4999-8999-999999999999';

const ITEM = {
  id: ID_A,
  category: 'messages',
  eventType: 'message.created',
  subjectType: 'message',
  subjectId: 'bbbbbbbb-0000-4000-8000-000000000001',
  actionPath: '/dashboard/messages/abc',
  createdAt: '2026-09-01T10:00:00.000Z',
  readAt: null,
  archivedAt: null,
};

interface Seen {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string;
}

function api(status: number, payload: unknown, seen: Seen[] = []): typeof fetch {
  return (async (input: unknown, init: RequestInit) => {
    seen.push({
      url: String(input),
      method: String(init.method ?? 'GET'),
      headers: new Headers(init.headers),
      body: String(init.body ?? ''),
    });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': status === 200 ? 'application/json' : 'application/problem+json' },
    });
  }) as unknown as typeof fetch;
}

function post(path: string, body: unknown, cookie: string = COOKIE): Request {
  return new Request(`https://web.test/api/notifications/${path}`, {
    method: 'POST',
    headers: { origin: 'https://web.test', 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
}

const PROBLEM = { type: 'about:blank', title: 'Bad Request', status: 400, code: 'VALIDATION_FAILED' };

describe('reading the list', () => {
  it('presents the caller’s token and the internal credential, and nothing else', async () => {
    const seen: Seen[] = [];
    await readNotifications({}, { env: ENV, cookieHeader: COOKIE, fetch: api(200, { items: [], nextCursor: null }, seen) });

    expect(seen[0]!.url).toBe('https://api.internal.test/v1/notifications');
    expect(seen[0]!.method).toBe('GET');
    expect(seen[0]!.headers.get('x-session-token')).toBe(SESSION_TOKEN);
    expect(seen[0]!.headers.get('x-internal-credential')).toBe(ENV.INTERNAL_BFF_CREDENTIAL);
    // The browser's cookie header is read here and never forwarded.
    expect(seen[0]!.headers.get('cookie')).toBeNull();
  });

  it('validates the body against the contract', async () => {
    const good = await readNotifications(
      {},
      { env: ENV, cookieHeader: COOKIE, fetch: api(200, { items: [ITEM], nextCursor: null }) },
    );
    expect(good.kind).toBe('ok');
    expect(good.kind === 'ok' && good.data.items[0]!.id).toBe(ID_A);

    // A field the contract does not name means the body has drifted; that is a failure, not a render.
    const drifted = await readNotifications(
      {},
      {
        env: ENV,
        cookieHeader: COOKIE,
        fetch: api(200, { items: [{ ...ITEM, title: 'You have mail' }], nextCursor: null }),
      },
    );
    expect(drifted.kind).toBe('unavailable');
  });

  it('asks for the archived view only when it was asked for', async () => {
    const seen: Seen[] = [];
    const options = { env: ENV, cookieHeader: COOKIE, fetch: api(200, { items: [], nextCursor: null }, seen) };

    await readNotifications({}, options);
    expect(seen[0]!.url).not.toContain('view=');

    await readNotifications({ view: 'archived' }, options);
    expect(seen[1]!.url).toContain('view=archived');

    // An unrecognised view is a mistake in a link; the inbox is the right recovery, and it costs no
    // round trip to be told so.
    await readNotifications({ view: 'deleted' }, options);
    expect(seen[2]!.url).not.toContain('view=');
  });

  it('passes a cursor through verbatim, without understanding it', async () => {
    const seen: Seen[] = [];
    await readNotifications(
      { cursor: 'bnQxfDIwMjYtMDktMDE', limit: '10' },
      { env: ENV, cookieHeader: COOKIE, fetch: api(200, { items: [], nextCursor: null }, seen) },
    );

    expect(seen[0]!.url).toContain('cursor=bnQxfDIwMjYtMDktMDE');
    expect(seen[0]!.url).toContain('limit=10');
  });

  it('keeps a session that ended apart from a service that could not answer', async () => {
    const noCookie = await readNotifications({}, { env: ENV, cookieHeader: null, fetch: api(200, {}) });
    expect(noCookie.kind).toBe('unauthenticated');

    const refused = await readNotifications({}, { env: ENV, cookieHeader: COOKIE, fetch: api(401, PROBLEM) });
    expect(refused.kind).toBe('unauthenticated');

    const cursorRefused = await readNotifications(
      {},
      { env: ENV, cookieHeader: COOKIE, fetch: api(400, PROBLEM) },
    );
    expect(cursorRefused.kind).toBe('invalid');

    const down = await readNotifications(
      {},
      { env: ENV, cookieHeader: COOKIE, fetch: (() => Promise.reject(new Error('down'))) as unknown as typeof fetch },
    );
    expect(down.kind).toBe('unavailable');
  });
});

describe('reading the unread count', () => {
  it('is its own call, so it can fail on its own', async () => {
    const seen: Seen[] = [];
    const result = await readNotificationsUnreadCount({
      env: ENV,
      cookieHeader: COOKIE,
      fetch: api(200, { unreadCount: 4 }, seen),
    });

    expect(seen[0]!.url).toBe('https://api.internal.test/v1/notifications/unread-count');
    expect(result).toEqual({ kind: 'ok', data: 4 });
  });

  it('reports unavailable rather than zero when it cannot be read', async () => {
    const result = await readNotificationsUnreadCount({
      env: ENV,
      cookieHeader: COOKIE,
      fetch: api(503, PROBLEM),
    });
    // A badge showing zero because the API was down would hide real notifications.
    expect(result.kind).toBe('unavailable');
  });

  it('refuses a body that is not the contract’s', async () => {
    const result = await readNotificationsUnreadCount({
      env: ENV,
      cookieHeader: COOKIE,
      fetch: api(200, { unreadCount: -1 }),
    });
    expect(result.kind).toBe('unavailable');
  });
});

describe('POST /api/notifications/read', () => {
  const OK = { changed: 1, unreadCount: 2 };

  it('rebuilds the body from the contract, dropping anything the page added', async () => {
    const seen: Seen[] = [];
    await handleMarkNotificationsRead(post('read', { ids: [ID_A, ID_B], userId: OTHER_USER }), {
      env: ENV,
      fetch: api(200, OK, seen),
    });

    // The strict contract refuses the extra field, so the request never leaves this origin.
    expect(seen).toHaveLength(0);
  });

  it('forwards only the identifiers when they validate', async () => {
    const seen: Seen[] = [];
    const response = await handleMarkNotificationsRead(post('read', { ids: [ID_A, ID_B] }), {
      env: ENV,
      fetch: api(200, OK, seen),
    });

    expect(seen[0]!.url).toBe('https://api.internal.test/v1/notifications/read');
    expect(JSON.parse(seen[0]!.body)).toEqual({ ids: [ID_A, ID_B] });
    expect(seen[0]!.headers.get('x-session-token')).toBe(SESSION_TOKEN);
    expect(await response.json()).toEqual(OK);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('sends no identifiers at all for "mark everything read"', async () => {
    const seen: Seen[] = [];
    await handleMarkNotificationsRead(post('read', {}), { env: ENV, fetch: api(200, OK, seen) });

    // An absent field, not an empty list: the two mean different things and the contract keeps them apart.
    expect(JSON.parse(seen[0]!.body)).toEqual({});
  });

  it('refuses an empty list and a malformed identifier without a round trip', async () => {
    for (const body of [{ ids: [] }, { ids: ['not-a-uuid'] }, { ids: ID_A }]) {
      const seen: Seen[] = [];
      const response = await handleMarkNotificationsRead(post('read', body), {
        env: ENV,
        fetch: api(200, OK, seen),
      });
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(seen).toHaveLength(0);
    }
  });

  it('refuses without a session and refuses a cross-origin post', async () => {
    const seen: Seen[] = [];
    const noSession = await handleMarkNotificationsRead(post('read', { ids: [ID_A] }, ''), {
      env: ENV,
      fetch: api(200, OK, seen),
    });
    expect(noSession.status).toBe(401);

    const crossOrigin = await handleMarkNotificationsRead(
      new Request('https://web.test/api/notifications/read', {
        method: 'POST',
        headers: { origin: 'https://evil.test', 'content-type': 'application/json', cookie: COOKIE },
        body: JSON.stringify({ ids: [ID_A] }),
      }),
      { env: ENV, fetch: api(200, OK, seen) },
    );
    expect(crossOrigin.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it('forwards the API’s own refusal, and turns anything unexpected into a 503', async () => {
    const refused = await handleMarkNotificationsRead(post('read', { ids: [ID_A] }), {
      env: ENV,
      fetch: api(401, PROBLEM),
    });
    expect(refused.status).toBe(401);

    const surprising = await handleMarkNotificationsRead(post('read', { ids: [ID_A] }), {
      env: ENV,
      fetch: api(204, {}),
    });
    expect(surprising.status).toBe(503);
  });

  it('refuses a drifted success body outright rather than trimming it', async () => {
    const response = await handleMarkNotificationsRead(post('read', { ids: [ID_A] }), {
      env: ENV,
      fetch: api(200, { changed: 1, unreadCount: 2, leaked: OTHER_USER }),
    });
    const raw = await response.text();

    // The contract is strict, so a body carrying a field nobody approved is a disagreement between this
    // layer and the API — not something to quietly clean up and render. Either way the value never
    // reaches the browser, and this way the disagreement is visible instead of hidden.
    expect(response.status).toBe(503);
    expect(raw).not.toContain(OTHER_USER);
    expect(raw).not.toContain('leaked');
  });

  it('passes a well-formed success body through exactly', async () => {
    const response = await handleMarkNotificationsRead(post('read', { ids: [ID_A] }), {
      env: ENV,
      fetch: api(200, { changed: 3, unreadCount: 7 }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ changed: 3, unreadCount: 7 });
  });
});

describe('POST /api/notifications/archive', () => {
  const OK = { changed: 1, unreadCount: 0 };

  it('forwards the identifiers and nothing else', async () => {
    const seen: Seen[] = [];
    const response = await handleArchiveNotifications(post('archive', { ids: [ID_A] }), {
      env: ENV,
      fetch: api(200, OK, seen),
    });

    expect(seen[0]!.url).toBe('https://api.internal.test/v1/notifications/archive');
    expect(JSON.parse(seen[0]!.body)).toEqual({ ids: [ID_A] });
    expect(await response.json()).toEqual(OK);
  });

  it('requires identifiers, so no request from here can empty an inbox', async () => {
    for (const body of [{}, { ids: [] }, { ids: null }]) {
      const seen: Seen[] = [];
      const response = await handleArchiveNotifications(post('archive', body), {
        env: ENV,
        fetch: api(200, OK, seen),
      });
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(seen).toHaveLength(0);
    }
  });

  it('drops an account a page tried to name', async () => {
    const seen: Seen[] = [];
    const response = await handleArchiveNotifications(post('archive', { ids: [ID_A], userId: OTHER_USER }), {
      env: ENV,
      fetch: api(200, OK, seen),
    });

    expect(response.status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it('refuses without a session', async () => {
    const seen: Seen[] = [];
    const response = await handleArchiveNotifications(post('archive', { ids: [ID_A] }, ''), {
      env: ENV,
      fetch: api(200, OK, seen),
    });

    expect(response.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('is a 503 when the API cannot be reached', async () => {
    const response = await handleArchiveNotifications(post('archive', { ids: [ID_A] }), {
      env: ENV,
      fetch: (() => Promise.reject(new Error('down'))) as unknown as typeof fetch,
    });
    expect(response.status).toBe(503);
  });
});
