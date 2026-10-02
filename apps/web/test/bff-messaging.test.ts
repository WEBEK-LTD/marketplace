import { describe, expect, it } from 'vitest';
import {
  handleConversationMessages,
  handleInbox,
  handleUnreadCount,
  readInbox,
  readUnreadCount,
} from '../src/server/bff/messaging';
import { SESSION_COOKIES } from '../src/server/bff/session-cookies';

/**
 * The BFF half of the messaging reads (Phase 5-D).
 *
 * What matters at this boundary:
 *
 *   * the session comes from the `__Host-mp_access` cookie and nowhere else, and it leaves as one
 *     header on one internal hop — the browser's `Cookie` header is never forwarded;
 *   * no token, credential or upstream address reaches a browser-visible body;
 *   * the API's single indistinguishable refusal stays indistinguishable here;
 *   * the opaque cursor is passed through as text and never parsed;
 *   * a drifted upstream body becomes a clean failure rather than a half-rendered page.
 */

const ENV = Object.freeze({
  API_BASE_URL: 'https://api.internal.test',
  PUBLIC_WEB_ORIGIN: 'https://web.test',
  INTERNAL_BFF_CREDENTIAL: 'test-current-credential-value-not-a-real-se',
});

const ACCESS_TOKEN = 'browser-access-token-value-not-a-real-token';
const REFRESH_TOKEN = 'browser-refresh-token-value-not-a-real-toke';
const COOKIE = `${SESSION_COOKIES.access.name}=${ACCESS_TOKEN}; ${SESSION_COOKIES.refresh.name}=${REFRESH_TOKEN}`;
const CONVERSATION = 'e0000000-0000-4000-8000-000000000001';
const CURSOR = 'bWkxfDIwMjYtMDktMjRUMTg6MzA6MDAuMDAwWnxlMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDE';

const INBOX_ITEM = {
  conversationId: CONVERSATION,
  subjectType: 'listing',
  listingId: '11110000-0000-4000-8000-000000000001',
  listingTitleSnapshot: 'Walnut dining table',
  membershipState: 'active',
  isMuted: false,
  isClosed: false,
  closedAt: null,
  unreadCount: 3,
  lastMessageId: 'a1000000-0000-4000-8000-000000000005',
  lastMessageSeq: '5',
  lastMessageAt: '2026-09-24T18:30:00.000Z',
  lastMessageType: 'text',
  lastMessageBody: 'Still available?',
  lastMessageSenderUserId: '22222222-2222-4222-8222-222222222222',
  lastMessageDeletedAt: null,
  createdAt: '2026-09-20T10:00:00.000Z',
};

const MESSAGE_ITEM = {
  id: 'a1000000-0000-4000-8000-000000000001',
  seq: '1',
  conversationId: CONVERSATION,
  senderUserId: '22222222-2222-4222-8222-222222222222',
  isOwnMessage: false,
  messageType: 'text',
  body: 'Hello there.',
  referenceType: null,
  referenceId: null,
  createdAt: '2026-09-24T18:00:00.000Z',
  editedAt: null,
  deletedAt: null,
};

interface Seen {
  readonly url: string;
  readonly headers: Headers;
  readonly method: string;
}

function api(status: number, payload: unknown, seen: Seen[] = []): typeof fetch {
  return (async (input: unknown, init: RequestInit) => {
    seen.push({
      url: String(input),
      headers: new Headers(init.headers),
      method: String(init.method ?? 'GET'),
    });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': status === 200 ? 'application/json' : 'application/problem+json' },
    });
  }) as unknown as typeof fetch;
}

function unreachable(seen: Seen[] = []): typeof fetch {
  return (async (input: unknown, init: RequestInit) => {
    seen.push({ url: String(input), headers: new Headers(init.headers), method: 'GET' });
    throw new TypeError('network');
  }) as unknown as typeof fetch;
}

function request(path: string, cookie: string | null = COOKIE): Request {
  return new Request(`https://web.test${path}`, {
    method: 'GET',
    headers: cookie === null ? {} : { cookie },
  });
}

const REFUSAL = {
  type: 'about:blank',
  title: 'Not Found',
  status: 404,
  detail: 'The conversation could not be found.',
  instance: '/v1/messaging/conversations/x/messages',
  code: 'MESSAGING_CONVERSATION_NOT_FOUND',
};

describe('GET /api/messaging/conversations', () => {
  it('forwards to the 5-C API with the caller’s token and the internal credential', async () => {
    const seen: Seen[] = [];
    const response = await handleInbox(request('/api/messaging/conversations'), {
      env: ENV,
      fetch: api(200, { items: [INBOX_ITEM], nextCursor: null }, seen),
    });

    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('https://api.internal.test/v1/messaging/conversations');
    expect(seen[0]?.headers.get('x-session-token')).toBe(ACCESS_TOKEN);
    expect(seen[0]?.headers.get('x-internal-credential')).toBe(ENV.INTERNAL_BFF_CREDENTIAL);
  });

  it('never forwards the browser’s cookie header upstream', async () => {
    const seen: Seen[] = [];
    await handleInbox(request('/api/messaging/conversations'), {
      env: ENV,
      fetch: api(200, { items: [], nextCursor: null }, seen),
    });
    expect(seen[0]?.headers.get('cookie')).toBeNull();
  });

  it('never puts a token or the credential in the browser’s body', async () => {
    const response = await handleInbox(request('/api/messaging/conversations'), {
      env: ENV,
      fetch: api(200, { items: [INBOX_ITEM], nextCursor: null }),
    });
    const text = await response.text();

    expect(text).not.toContain(ACCESS_TOKEN);
    expect(text).not.toContain(REFRESH_TOKEN);
    expect(text).not.toContain(ENV.INTERNAL_BFF_CREDENTIAL);
    expect(text).not.toContain('api.internal.test');
    expect(text).not.toContain('x-session-token');
  });

  it('passes the limit and the opaque cursor through unchanged', async () => {
    const seen: Seen[] = [];
    await handleInbox(request(`/api/messaging/conversations?limit=5&cursor=${encodeURIComponent(CURSOR)}`), {
      env: ENV,
      fetch: api(200, { items: [], nextCursor: null }, seen),
    });

    const url = new URL(seen[0]!.url);
    expect(url.searchParams.get('limit')).toBe('5');
    expect(url.searchParams.get('cursor')).toBe(CURSOR);
  });

  it('refuses without a session cookie, without calling the API', async () => {
    const seen: Seen[] = [];
    const response = await handleInbox(request('/api/messaging/conversations', null), {
      env: ENV,
      fetch: api(200, { items: [], nextCursor: null }, seen),
    });

    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe('AUTHENTICATION_REQUIRED');
    expect(seen).toHaveLength(0);
  });

  it('passes a 401 from the API through as a 401', async () => {
    const response = await handleInbox(request('/api/messaging/conversations'), {
      env: ENV,
      fetch: api(401, { code: 'AUTHENTICATION_REQUIRED' }),
    });
    expect(response.status).toBe(401);
  });

  it('reports an unreachable API as 503 in the problem envelope', async () => {
    const response = await handleInbox(request('/api/messaging/conversations'), {
      env: ENV,
      fetch: unreachable(),
    });

    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    expect((await response.json()).code).toBe('SERVICE_UNAVAILABLE');
  });

  it('refuses a drifted upstream body rather than forwarding it', async () => {
    const drifted = { items: [{ ...INBOX_ITEM, sellerEmail: 'x@test.invalid' }], nextCursor: null };
    const response = await handleInbox(request('/api/messaging/conversations'), {
      env: ENV,
      fetch: api(200, drifted),
    });

    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('sellerEmail');
  });

  it('answers with no-store, because an inbox is never cacheable', async () => {
    const response = await handleInbox(request('/api/messaging/conversations'), {
      env: ENV,
      fetch: api(200, { items: [], nextCursor: null }),
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('GET /api/messaging/conversations/:id/messages', () => {
  it('forwards the conversation id in the path, with the caller’s token', async () => {
    const seen: Seen[] = [];
    const response = await handleConversationMessages(
      request(`/api/messaging/conversations/${CONVERSATION}/messages`),
      CONVERSATION,
      { env: ENV, fetch: api(200, { items: [MESSAGE_ITEM], nextCursor: null }, seen) },
    );

    expect(response.status).toBe(200);
    expect(seen[0]?.url).toBe(
      `https://api.internal.test/v1/messaging/conversations/${CONVERSATION}/messages`,
    );
    expect(seen[0]?.headers.get('x-session-token')).toBe(ACCESS_TOKEN);
  });

  it('escapes a conversation identifier rather than splicing it into the path', async () => {
    const seen: Seen[] = [];
    await handleConversationMessages(
      request('/api/messaging/conversations/x/messages'),
      '../../unread-count',
      { env: ENV, fetch: api(404, REFUSAL, seen) },
    );

    expect(seen[0]?.url).toContain('%2F');
    expect(seen[0]?.url).not.toContain('/v1/messaging/unread-count');
  });

  it('passes the opaque cursor through without parsing it', async () => {
    const seen: Seen[] = [];
    await handleConversationMessages(
      request(`/api/messaging/conversations/${CONVERSATION}/messages?cursor=${encodeURIComponent(CURSOR)}`),
      CONVERSATION,
      { env: ENV, fetch: api(200, { items: [], nextCursor: null }, seen) },
    );
    expect(new URL(seen[0]!.url).searchParams.get('cursor')).toBe(CURSOR);
  });

  it('keeps the API’s indistinguishable refusal indistinguishable', async () => {
    const refused = await handleConversationMessages(
      request(`/api/messaging/conversations/${CONVERSATION}/messages`),
      CONVERSATION,
      { env: ENV, fetch: api(404, REFUSAL) },
    );
    const missing = await handleConversationMessages(
      request('/api/messaging/conversations/e0000000-0000-4000-8000-000000000999/messages'),
      'e0000000-0000-4000-8000-000000000999',
      { env: ENV, fetch: api(404, REFUSAL) },
    );

    expect(refused.status).toBe(404);
    expect(await refused.text()).toBe(await missing.text());
  });

  it('never answers 403, which would confirm the conversation is real', async () => {
    const response = await handleConversationMessages(
      request(`/api/messaging/conversations/${CONVERSATION}/messages`),
      CONVERSATION,
      { env: ENV, fetch: api(404, REFUSAL) },
    );
    expect(response.status).not.toBe(403);
    expect((await response.text()).toLowerCase()).not.toContain('forbidden');
  });

  it('turns an invalid identifier refusal into a 400 without inventing a reason', async () => {
    const response = await handleConversationMessages(
      request('/api/messaging/conversations/not-a-uuid/messages'),
      'not-a-uuid',
      { env: ENV, fetch: api(400, { code: 'VALIDATION_FAILED' }) },
    );

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('VALIDATION_FAILED');
  });

  it('refuses without a session cookie', async () => {
    const seen: Seen[] = [];
    const response = await handleConversationMessages(
      request(`/api/messaging/conversations/${CONVERSATION}/messages`, null),
      CONVERSATION,
      { env: ENV, fetch: api(200, { items: [], nextCursor: null }, seen) },
    );

    expect(response.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('reports an unreachable API as 503', async () => {
    const response = await handleConversationMessages(
      request(`/api/messaging/conversations/${CONVERSATION}/messages`),
      CONVERSATION,
      { env: ENV, fetch: unreachable() },
    );
    expect(response.status).toBe(503);
  });

  it('never leaks a message body into a refusal', async () => {
    const response = await handleConversationMessages(
      request(`/api/messaging/conversations/${CONVERSATION}/messages`),
      CONVERSATION,
      { env: ENV, fetch: api(404, REFUSAL) },
    );
    expect(await response.text()).not.toContain('Hello there.');
  });
});

describe('GET /api/messaging/unread-count', () => {
  it('returns the count from the API', async () => {
    const seen: Seen[] = [];
    const response = await handleUnreadCount(request('/api/messaging/unread-count'), {
      env: ENV,
      fetch: api(200, { unreadCount: 4 }, seen),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ unreadCount: 4 });
    expect(seen[0]?.url).toBe('https://api.internal.test/v1/messaging/unread-count');
  });

  it('refuses without a session cookie', async () => {
    const response = await handleUnreadCount(request('/api/messaging/unread-count', null), {
      env: ENV,
      fetch: api(200, { unreadCount: 4 }),
    });
    expect(response.status).toBe(401);
  });

  it('reports a failure rather than a fabricated zero', async () => {
    const response = await handleUnreadCount(request('/api/messaging/unread-count'), {
      env: ENV,
      fetch: unreachable(),
    });

    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('unreadCount');
  });

  it('refuses a drifted body', async () => {
    const response = await handleUnreadCount(request('/api/messaging/unread-count'), {
      env: ENV,
      fetch: api(200, { unreadCount: '4' }),
    });
    expect(response.status).toBe(503);
  });
});

describe('the server-side read helpers', () => {
  it('report an ended session and an outage as different outcomes', async () => {
    const ended = await readInbox({}, { env: ENV, fetch: api(401, {}), cookieHeader: COOKIE });
    const down = await readInbox({}, { env: ENV, fetch: unreachable(), cookieHeader: COOKIE });

    expect(ended.kind).toBe('unauthenticated');
    expect(down.kind).toBe('unavailable');
  });

  it('ask nothing when there is no session cookie', async () => {
    const seen: Seen[] = [];
    const inbox = await readInbox({}, { env: ENV, fetch: api(200, {}, seen), cookieHeader: null });
    const unread = await readUnreadCount({ env: ENV, fetch: api(200, {}, seen), cookieHeader: null });

    expect(inbox.kind).toBe('unauthenticated');
    expect(unread.kind).toBe('unauthenticated');
    expect(seen).toHaveLength(0);
  });

  it('return the validated contract on success', async () => {
    const result = await readInbox(
      {},
      { env: ENV, fetch: api(200, { items: [INBOX_ITEM], nextCursor: null }), cookieHeader: COOKIE },
    );

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.data.items).toHaveLength(1);
      expect(result.data.items[0]?.conversationId).toBe(CONVERSATION);
    }
  });
});
