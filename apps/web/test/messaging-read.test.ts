import { describe, expect, it } from 'vitest';
import {
  MESSAGING_READ_ROUTES,
  fetchInboxPage,
  fetchLatestMessages,
  fetchUnreadCount,
  toRenderableConversation,
  toRenderableMessage,
} from '../src/components/messaging-read';

/**
 * The browser's own messaging reads (Phase 5-F).
 *
 * What is asserted here:
 *
 *   * three GETs, to this origin, on the already-shipped routes — and nothing that writes;
 *   * the opaque cursor is sent back exactly as issued and never parsed;
 *   * the thread catch-up asks for the latest page and invents no "since" parameter;
 *   * a drifted response is a clean failure rather than a half-built row;
 *   * an identifier in the response does not survive the crossing into a render type;
 *   * a failed unread count is a failure, never a zero.
 */

const CONVERSATION = 'e0000000-0000-4000-8000-000000000001';
const SENDER = '22222222-2222-4222-8222-222222222222';

const MESSAGE = {
  id: 'a1000000-0000-4000-8000-000000000005',
  seq: '5',
  conversationId: CONVERSATION,
  senderUserId: SENDER,
  isOwnMessage: false,
  messageType: 'text',
  body: 'Still available?',
  referenceType: null,
  referenceId: null,
  createdAt: '2026-09-24T18:30:00.000Z',
  editedAt: null,
  deletedAt: null,
};

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
  lastMessageSenderUserId: SENDER,
  lastMessageDeletedAt: null,
  createdAt: '2026-09-20T10:00:00.000Z',
};

interface Call {
  readonly path: string;
  readonly method: string | undefined;
  readonly credentials: string | undefined;
  readonly body: unknown;
}

function recorder(response: { status: number; body?: unknown; text?: string }): {
  calls: Call[];
  fetcher: (input: string, init: RequestInit) => Promise<Response>;
} {
  const calls: Call[] = [];
  return {
    calls,
    fetcher: async (input, init) => {
      calls.push({
        path: input,
        method: init.method,
        credentials: init.credentials,
        body: init.body,
      });
      const text = response.text ?? (response.body === undefined ? '' : JSON.stringify(response.body));
      return new Response(text, { status: response.status });
    },
  };
}

const CURSOR = 'bWkxfDIwMjYtMDktMjRUMTg6MzA6MDAuMDAwWnxlMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDE';

describe('the routes', () => {
  it('are the three already-shipped read routes on this origin, and nothing else', () => {
    expect(MESSAGING_READ_ROUTES.inbox).toBe('/api/messaging/conversations');
    expect(MESSAGING_READ_ROUTES.unreadCount).toBe('/api/messaging/unread-count');
    expect(MESSAGING_READ_ROUTES.messages(CONVERSATION)).toBe(
      `/api/messaging/conversations/${CONVERSATION}/messages`,
    );
    expect(Object.keys(MESSAGING_READ_ROUTES)).toHaveLength(3);
  });

  it('escape the conversation id rather than pasting it into a path', () => {
    expect(MESSAGING_READ_ROUTES.messages('../../unread-count')).not.toContain('../');
  });
});

describe('the inbox page', () => {
  it('reads this origin with the session cookie and no body', async () => {
    const { calls, fetcher } = recorder({ status: 200, body: { items: [INBOX_ITEM], nextCursor: null } });
    const result = await fetchInboxPage(null, fetcher);

    expect(result.kind).toBe('ok');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe('/api/messaging/conversations');
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.credentials).toBe('same-origin');
    expect(calls[0]?.body).toBeUndefined();
  });

  it('sends the cursor it was given back exactly as issued', async () => {
    const { calls, fetcher } = recorder({ status: 200, body: { items: [], nextCursor: null } });
    await fetchInboxPage(CURSOR, fetcher);

    const asked = new URL(`https://web.test${calls[0]?.path ?? ''}`);
    expect(asked.pathname).toBe('/api/messaging/conversations');
    expect(asked.searchParams.get('cursor')).toBe(CURSOR);
    // Refreshing *this* page rather than jumping to the first is the whole reason the cursor travels.
    expect(asked.searchParams.get('limit')).toBeNull();
    expect(asked.searchParams.get('since')).toBeNull();
  });

  it('carries the next cursor through as text, without reading it', async () => {
    const { fetcher } = recorder({ status: 200, body: { items: [INBOX_ITEM], nextCursor: CURSOR } });
    const result = await fetchInboxPage(null, fetcher);

    expect(result.kind === 'ok' && result.data.nextCursor).toBe(CURSOR);
  });

  it('drops every identifier the response carries', async () => {
    const { fetcher } = recorder({ status: 200, body: { items: [INBOX_ITEM], nextCursor: null } });
    const result = await fetchInboxPage(null, fetcher);
    expect(result.kind).toBe('ok');

    const row = result.kind === 'ok' ? result.data.rows[0] : undefined;
    expect(JSON.stringify(row)).not.toContain(SENDER);
    for (const absent of [
      'lastMessageSenderUserId',
      'lastMessageId',
      'lastMessageSeq',
      'listingId',
      'closedAt',
      'lastMessageDeletedAt',
    ]) {
      expect(Object.keys(row ?? {}), absent).not.toContain(absent);
    }
    // And what a row does show is all there.
    expect(row).toEqual({
      conversationId: CONVERSATION,
      subjectType: 'listing',
      listingTitleSnapshot: 'Walnut dining table',
      membershipState: 'active',
      isMuted: false,
      isClosed: false,
      unreadCount: 3,
      lastMessageAt: '2026-09-24T18:30:00.000Z',
      lastMessageBody: 'Still available?',
    });
  });

  it('fails cleanly on a status other than 200, on an unparsable body, and on a drifted one', async () => {
    for (const response of [
      { status: 401, body: { code: 'AUTHENTICATION_REQUIRED' } },
      { status: 503, body: { code: 'SERVICE_UNAVAILABLE' } },
      { status: 200, text: 'not json' },
      { status: 200, body: {} },
      { status: 200, body: { items: 'nope', nextCursor: null } },
      { status: 200, body: { items: [{ ...INBOX_ITEM, unreadCount: '3' }], nextCursor: null } },
      { status: 200, body: { items: [{ ...INBOX_ITEM, subjectType: 'dispute' }], nextCursor: null } },
      { status: 200, body: { items: [{ ...INBOX_ITEM, membershipState: 'banned' }], nextCursor: null } },
      { status: 200, body: { items: [INBOX_ITEM], nextCursor: 7 } },
    ]) {
      const { fetcher } = recorder(response);
      const result = await fetchInboxPage(null, fetcher);
      expect(result.kind, JSON.stringify(response).slice(0, 60)).toBe('failed');
    }
  });

  it('fails when the request never left', async () => {
    const result = await fetchInboxPage(null, async () => {
      throw new Error('the network is gone');
    });
    expect(result.kind).toBe('failed');
  });

  it('accepts an empty page as an empty page, not as a failure', async () => {
    const { fetcher } = recorder({ status: 200, body: { items: [], nextCursor: null } });
    const result = await fetchInboxPage(null, fetcher);
    expect(result).toEqual({ kind: 'ok', data: { rows: [], nextCursor: null } });
  });
});

describe('the latest messages', () => {
  it('asks for the latest page, with no cursor and no invented parameter', async () => {
    const { calls, fetcher } = recorder({ status: 200, body: { items: [MESSAGE], nextCursor: null } });
    const result = await fetchLatestMessages(CONVERSATION, fetcher);

    expect(result.kind).toBe('ok');
    expect(calls[0]?.path).toBe(`/api/messaging/conversations/${CONVERSATION}/messages`);
    expect(calls[0]?.path).not.toContain('?');
    expect(calls[0]?.method).toBe('GET');
  });

  it('drops the sender and every other identifier', async () => {
    const { fetcher } = recorder({ status: 200, body: { items: [MESSAGE], nextCursor: null } });
    const result = await fetchLatestMessages(CONVERSATION, fetcher);

    const message = result.kind === 'ok' ? result.data[0] : undefined;
    expect(JSON.stringify(message)).not.toContain(SENDER);
    expect(message).toEqual({
      id: MESSAGE.id,
      seq: '5',
      isOwnMessage: false,
      messageType: 'text',
      body: 'Still available?',
      createdAt: '2026-09-24T18:30:00.000Z',
    });
  });

  it('keeps `seq` a digit string, so a large sequence cannot lose precision', async () => {
    const { fetcher } = recorder({
      status: 200,
      body: { items: [{ ...MESSAGE, seq: '9007199254740993' }], nextCursor: null },
    });
    const result = await fetchLatestMessages(CONVERSATION, fetcher);
    expect(result.kind === 'ok' && result.data[0]?.seq).toBe('9007199254740993');
  });

  it('fails cleanly on drift rather than rendering half a message', async () => {
    for (const body of [
      { items: [{ ...MESSAGE, seq: 5 }], nextCursor: null },
      { items: [{ ...MESSAGE, seq: '0' }], nextCursor: null },
      { items: [{ ...MESSAGE, messageType: 'voice' }], nextCursor: null },
      { items: [{ ...MESSAGE, isOwnMessage: 'yes' }], nextCursor: null },
      { items: [{ ...MESSAGE, createdAt: null }], nextCursor: null },
      { items: [{ ...MESSAGE, body: 5 }], nextCursor: null },
      { items: [null], nextCursor: null },
    ]) {
      const { fetcher } = recorder({ status: 200, body });
      const result = await fetchLatestMessages(CONVERSATION, fetcher);
      expect(result.kind, JSON.stringify(body).slice(0, 60)).toBe('failed');
    }
  });

  it('accepts the shapes a real thread contains', async () => {
    const { fetcher } = recorder({
      status: 200,
      body: {
        items: [
          { ...MESSAGE, seq: '1', messageType: 'system', senderUserId: null, body: 'The listing was updated.' },
          { ...MESSAGE, seq: '2', messageType: 'reference', body: null },
          { ...MESSAGE, seq: '3', isOwnMessage: true },
        ],
        nextCursor: null,
      },
    });
    const result = await fetchLatestMessages(CONVERSATION, fetcher);
    expect(result.kind === 'ok' && result.data).toHaveLength(3);
  });
});

describe('the unread count', () => {
  it('reads the count', async () => {
    const { calls, fetcher } = recorder({ status: 200, body: { unreadCount: 4 } });
    expect(await fetchUnreadCount(fetcher)).toEqual({ kind: 'ok', data: 4 });
    expect(calls[0]?.path).toBe('/api/messaging/unread-count');
    expect(calls[0]?.method).toBe('GET');
  });

  it('accepts a real zero', async () => {
    const { fetcher } = recorder({ status: 200, body: { unreadCount: 0 } });
    expect(await fetchUnreadCount(fetcher)).toEqual({ kind: 'ok', data: 0 });
  });

  it('fails rather than fabricating a zero', async () => {
    for (const response of [
      { status: 503, body: { code: 'SERVICE_UNAVAILABLE' } },
      { status: 200, text: '' },
      { status: 200, body: {} },
      { status: 200, body: { unreadCount: null } },
      { status: 200, body: { unreadCount: '4' } },
      { status: 200, body: { unreadCount: -1 } },
      { status: 200, body: { unreadCount: 1.5 } },
    ]) {
      const { fetcher } = recorder(response);
      const result = await fetchUnreadCount(fetcher);
      expect(result, JSON.stringify(response).slice(0, 50)).toEqual({ kind: 'failed' });
    }
  });
});

describe('what this module cannot do', () => {
  it('issues GET and only GET, on every one of its readers', async () => {
    const seen: string[] = [];
    const fetcher = async (input: string, init: RequestInit): Promise<Response> => {
      seen.push(`${init.method ?? 'GET'} ${input}`);
      return new Response('{}', { status: 200 });
    };

    await fetchInboxPage(CURSOR, fetcher);
    await fetchLatestMessages(CONVERSATION, fetcher);
    await fetchUnreadCount(fetcher);

    expect(seen).toHaveLength(3);
    for (const call of seen) expect(call.startsWith('GET ')).toBe(true);
    // Nothing here can mark read, send, mute, leave or close: no such path is ever addressed.
    for (const forbidden of ['/read', '/muted', '/membership', '/closed']) {
      expect(seen.join(' '), forbidden).not.toContain(forbidden);
    }
  });

  it('projects one row and one message without a request at all', () => {
    expect(toRenderableConversation(INBOX_ITEM)?.conversationId).toBe(CONVERSATION);
    expect(toRenderableMessage(MESSAGE)?.id).toBe(MESSAGE.id);
    expect(toRenderableConversation('nope')).toBeNull();
    expect(toRenderableMessage(null)).toBeNull();
  });
});
