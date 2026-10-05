import type { ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startBuiltApp, type RunningApp } from './support/next-server.js';
import { problem, startStubApi, type StubApi } from './support/stub-api.js';

/**
 * The read-only messaging surfaces, over real HTTP against the built app (Phase 5-D).
 *
 * Run against the built app rather than a unit harness for the same reason the protection tests are:
 * what matters is what actually reaches a browser, including the streamed RSC payload. A signed-out
 * visitor must receive none of a thread, and "none" has to mean none of the document — not merely none
 * of the visible part.
 *
 * The heaviest assertions are about absence:
 *
 *   * no session token, refresh token or internal credential anywhere in a response;
 *   * no `/v1/...` address in anything a browser receives — the browser knows only this origin;
 *   * an unavailable listing reference renders the approved words and carries no link, no price and no
 *     seller detail;
 *   * a conversation the caller may not read reads exactly like one that does not exist;
 *   * a failing unread count costs the page its badge and nothing else.
 *
 * No browser, no Playwright, no live provider, no deployment.
 */

// Exactly 43 base64url characters: the web app's env validation refuses any other length at
// startup, which surfaces as a 500 on every page rather than as a configuration error.
const CANARY_CREDENTIAL = 'test-web-messaging-canary-credential-notrea';
const ACCESS = '__Host-mp_access=canary-access-token-value-not-a-real-token';
const REFRESH = '__Host-mp_refresh=canary-refresh-token-value-not-a-real-toke';
const SESSION = `${ACCESS}; ${REFRESH}`;
const IDENTITY = { user: { id: '11111111-1111-4111-8111-111111111111', displayName: 'Nadia' } };

const CONVERSATION = 'e0000000-0000-4000-8000-000000000001';
const DIRECT_CONVERSATION = 'e0000000-0000-4000-8000-000000000002';
const SENDER = '22222222-2222-4222-8222-222222222222';
const NEXT_CURSOR = 'bWkxfDIwMjYtMDktMjRUMTg6MDA6MDAuMDAwWnxlMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDI';

const LISTING_CONVERSATION = {
  conversationId: CONVERSATION,
  subjectType: 'listing',
  listingId: '11110000-0000-4000-8000-000000000001',
  listingTitleSnapshot: 'Walnut dining table',
  membershipState: 'active',
  isMuted: false,
  isClosed: false,
  closedAt: null,
  unreadCount: 3,
  lastMessageId: 'a1000000-0000-4000-8000-000000000003',
  lastMessageSeq: '3',
  lastMessageAt: '2026-09-24T18:30:00.000Z',
  lastMessageType: 'text',
  lastMessageBody: 'I can deliver on Tuesday.',
  lastMessageSenderUserId: SENDER,
  lastMessageDeletedAt: null,
  createdAt: '2026-09-20T10:00:00.000Z',
};

const CLOSED_MUTED_CONVERSATION = {
  ...LISTING_CONVERSATION,
  conversationId: DIRECT_CONVERSATION,
  subjectType: 'direct',
  listingId: null,
  listingTitleSnapshot: null,
  isMuted: true,
  isClosed: true,
  closedAt: '2026-09-24T19:00:00.000Z',
  unreadCount: 0,
  membershipState: 'left',
  lastMessageBody: 'Closing this one.',
};

const MESSAGES = [
  {
    id: 'a1000000-0000-4000-8000-000000000001',
    seq: '1',
    conversationId: CONVERSATION,
    senderUserId: SENDER,
    isOwnMessage: false,
    messageType: 'text',
    body: 'Hello, it is still here.',
    referenceType: null,
    referenceId: null,
    createdAt: '2026-09-24T18:10:00.000Z',
    editedAt: null,
    deletedAt: null,
    attachments: [],
  },
  {
    id: 'a1000000-0000-4000-8000-000000000002',
    seq: '2',
    conversationId: CONVERSATION,
    senderUserId: IDENTITY.user.id,
    isOwnMessage: true,
    messageType: 'text',
    body: 'Good, I will take it.',
    referenceType: null,
    referenceId: null,
    createdAt: '2026-09-24T18:20:00.000Z',
    editedAt: null,
    deletedAt: null,
    // 0104. On the caller's own message, because that is the only kind that can carry one.
    attachments: [
      { id: 'b2000000-0000-4000-8000-000000000001', contentType: 'image/png', byteSize: '204800' },
      { id: 'b2000000-0000-4000-8000-000000000002', contentType: 'application/pdf', byteSize: '2097152' },
    ],
  },
  {
    id: 'a1000000-0000-4000-8000-000000000003',
    seq: '3',
    conversationId: CONVERSATION,
    senderUserId: SENDER,
    isOwnMessage: false,
    messageType: 'reference',
    body: null,
    referenceType: 'listing',
    referenceId: '11110000-0000-4000-8000-000000000001',
    createdAt: '2026-09-24T18:25:00.000Z',
    editedAt: null,
    deletedAt: null,
    attachments: [],
  },
  {
    id: 'a1000000-0000-4000-8000-000000000004',
    seq: '4',
    conversationId: CONVERSATION,
    senderUserId: null,
    isOwnMessage: false,
    messageType: 'system',
    body: 'The listing was updated.',
    referenceType: null,
    referenceId: null,
    createdAt: '2026-09-24T18:30:00.000Z',
    editedAt: null,
    deletedAt: null,
    attachments: [],
  },
];

type InboxMode = 'ok' | 'empty' | 'fails' | 'paged' | 'closed';
type ThreadMode = 'ok' | 'empty' | 'fails' | 'not_found' | 'paged';
type UnreadMode = 'ok' | 'fails';

let api: StubApi;
let app: RunningApp;

beforeAll(async () => {
  api = await startStubApi();
  app = await startBuiltApp({ API_BASE_URL: api.baseUrl, INTERNAL_BFF_CREDENTIAL: CANARY_CREDENTIAL });
}, 120_000);

afterAll(async () => {
  await app.stop();
  await api.stop();
});

function json(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

/** The API as it behaves for each case, plus the catalogue routes the regression block needs. */
function apiServes(
  modes: { inbox?: InboxMode; thread?: ThreadMode; unread?: UnreadMode } = {},
): void {
  const { inbox = 'ok', thread = 'ok', unread = 'ok' } = modes;
  api.reply((request, response) => {
    const path = request.url.split('?')[0] ?? '';

    if (path === '/v1/users/me') return json(response, IDENTITY);

    if (path === '/v1/messaging/unread-count') {
      if (unread === 'fails') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      return json(response, { unreadCount: 4 });
    }

    if (path === '/v1/messaging/conversations') {
      if (inbox === 'fails') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      if (inbox === 'empty') return json(response, { items: [], nextCursor: null });
      if (inbox === 'paged') {
        return json(response, { items: [LISTING_CONVERSATION], nextCursor: NEXT_CURSOR });
      }
      if (inbox === 'closed') return json(response, { items: [CLOSED_MUTED_CONVERSATION], nextCursor: null });
      return json(response, {
        items: [LISTING_CONVERSATION, CLOSED_MUTED_CONVERSATION],
        nextCursor: null,
      });
    }

    if (path.startsWith('/v1/messaging/conversations/') && path.endsWith('/messages')) {
      if (thread === 'fails') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      if (thread === 'not_found') return problem(response, 404, 'MESSAGING_CONVERSATION_NOT_FOUND');
      if (thread === 'empty') return json(response, { items: [], nextCursor: null });
      if (thread === 'paged') return json(response, { items: MESSAGES, nextCursor: NEXT_CURSOR });
      return json(response, { items: MESSAGES, nextCursor: null });
    }

    if (path === '/v1/listings') return json(response, { listings: [], nextCursor: null });
    if (path === '/v1/services') return json(response, { services: [], nextCursor: null });
    if (path === '/v1/categories') return json(response, { categories: [] });
    if (path === '/v1/search') return json(response, { results: [], nextCursor: null });
    return problem(response, 404, 'NOT_FOUND');
  });
}

beforeEach(() => {
  api.seen.length = 0;
  apiServes();
});

interface Page {
  readonly status: number;
  readonly location: string | null;
  readonly robotsHeader: string | null;
  readonly html: string;
}

/** `cookie: null` means a signed-out visitor; omitting it means the signed-in session. */
async function load(path: string, cookie: string | null = SESSION): Promise<Page> {
  const response = await fetch(`${app.baseUrl}${path}`, {
    redirect: 'manual',
    headers: cookie === null ? {} : { cookie },
  });
  const html = await response.text();
  return {
    status: response.status,
    location: response.headers.get('location'),
    robotsHeader: response.headers.get('x-robots-tag'),
    html,
  };
}

function countOf(html: string, pattern: RegExp): number {
  return html.match(pattern)?.length ?? 0;
}

describe('the inbox', () => {
  it('renders in English with exactly one h1', async () => {
    const page = await load('/dashboard/messages');

    expect(page.status).toBe(200);
    expect(page.html).toContain('>Messages</h1>');
    expect(countOf(page.html, /<h1[^>]*>/g)).toBe(1);
  });

  it('renders in Arabic, right to left', async () => {
    const page = await load('/ar/dashboard/messages');

    expect(page.status).toBe(200);
    expect(page.html).toContain('<html lang="ar" dir="rtl">');
    expect(page.html).toContain('الرسائل');
    expect(page.html).toContain('رسائلك');
  });

  it('lays out with logical properties rather than left and right', async () => {
    const page = await load('/dashboard/messages');
    // A mirrored stylesheet is what logical properties exist to avoid; `ms-`/`me-`/`ps-`/`pe-` are the
    // project's convention and physical `ml-`/`mr-`/`pl-`/`pr-` would break under /ar.
    expect(page.html).not.toMatch(/class="[^"]*\b(ml|mr|pl|pr)-\d/);
  });

  it('shows a conversation with its subject, summary, timestamp and unread count', async () => {
    const page = await load('/dashboard/messages');

    expect(page.html).toContain('Walnut dining table');
    expect(page.html).toContain('>Listing</p>');
    expect(page.html).toContain('I can deliver on Tuesday.');
    expect(page.html).toContain('2026-09-24T18:30:00.000Z');
    expect(page.html).toContain('3 Unread');
  });

  it('shows the closed, muted and left states', async () => {
    const page = await load('/dashboard/messages');

    expect(page.html).toContain('Conversation closed');
    expect(page.html).toContain('Muted');
    expect(page.html).toContain('>Left</span>');
  });

  it('links each conversation to its thread', async () => {
    const page = await load('/dashboard/messages');
    expect(page.html).toContain(`/dashboard/messages/${CONVERSATION}`);
    expect(page.html).toContain(`/dashboard/messages/${DIRECT_CONVERSATION}`);
  });

  it('links to the Arabic thread under /ar', async () => {
    const page = await load('/ar/dashboard/messages');
    expect(page.html).toContain(`/ar/dashboard/messages/${CONVERSATION}`);
  });

  it('shows the approved empty state when there is nothing', async () => {
    apiServes({ inbox: 'empty' });
    const page = await load('/dashboard/messages');

    expect(page.status).toBe(200);
    expect(page.html).toContain('No conversations yet');
    expect(page.html).toContain('Start a conversation from a listing or seller profile.');
  });

  it('shows the approved error state when the API cannot answer', async () => {
    apiServes({ inbox: 'fails' });
    const page = await load('/dashboard/messages');

    expect(page.status).toBe(200);
    expect(page.html).toContain('Unable to load messages');
    expect(page.html).toContain('Try again');
  });

  it('offers the next page with the cursor the API issued, unmodified', async () => {
    apiServes({ inbox: 'paged' });
    const page = await load('/dashboard/messages');

    expect(page.html).toContain('Load more');
    expect(page.html).toContain(`cursor=${encodeURIComponent(NEXT_CURSOR)}`);
  });

  it('sends a cursor back to the API exactly as given', async () => {
    apiServes({ inbox: 'paged' });
    await load(`/dashboard/messages?cursor=${encodeURIComponent(NEXT_CURSOR)}`);

    const asked = api.seen.filter((request) => request.url.startsWith('/v1/messaging/conversations?'));
    expect(asked.length).toBeGreaterThan(0);
    expect(new URL(`http://x${asked[0]!.url}`).searchParams.get('cursor')).toBe(NEXT_CURSOR);
  });

  it('is not indexable', async () => {
    const page = await load('/dashboard/messages');
    expect(page.robotsHeader).toBe('noindex');
    expect(page.html).toContain('content="noindex, nofollow"');
  });

  it('names no API address and no token anywhere in the document', async () => {
    const page = await load('/dashboard/messages');

    expect(page.html).not.toContain('/v1/');
    expect(page.html).not.toContain(api.baseUrl);
    expect(page.html).not.toContain('canary-access-token');
    expect(page.html).not.toContain('canary-refresh-token');
    expect(page.html).not.toContain(CANARY_CREDENTIAL);
  });

  it('reads nothing but the messaging endpoints it needs', async () => {
    await load('/dashboard/messages');
    const paths = [...new Set(api.seen.map((request) => request.url.split('?')[0]))].sort();

    expect(paths).toEqual([
      '/v1/messaging/conversations',
      '/v1/messaging/unread-count',
      '/v1/users/me',
    ]);
  });
});

describe('the unread badge', () => {
  it('shows the count when it is available', async () => {
    const page = await load('/dashboard/messages');
    expect(page.html).toContain('4 Unread');
  });

  it('fails on its own: the inbox still renders and no number is invented', async () => {
    apiServes({ unread: 'fails' });
    const page = await load('/dashboard/messages');

    expect(page.status).toBe(200);
    expect(page.html).toContain('Walnut dining table');
    expect(page.html).not.toContain('4 unread');
    expect(page.html).not.toContain('0 unread');
    expect(page.html).not.toContain('Unable to load messages');
  });

  it('and the inbox failing does not fabricate an unread total either', async () => {
    apiServes({ inbox: 'fails' });
    const page = await load('/dashboard/messages');

    expect(page.html).toContain('Unable to load messages');
    expect(page.html).not.toContain('Walnut dining table');
  });
});

describe('the thread', () => {
  it('renders in English with exactly one h1 naming the conversation', async () => {
    const page = await load(`/dashboard/messages/${CONVERSATION}`);

    expect(page.status).toBe(200);
    expect(page.html).toContain('>Walnut dining table</h1>');
    expect(countOf(page.html, /<h1[^>]*>/g)).toBe(1);
  });

  it('renders in Arabic, right to left', async () => {
    const page = await load(`/ar/dashboard/messages/${CONVERSATION}`);

    expect(page.status).toBe(200);
    expect(page.html).toContain('<html lang="ar" dir="rtl">');
    expect(page.html).toContain('الرسائل');
  });

  it('renders the messages in the order the API returned them', async () => {
    const page = await load(`/dashboard/messages/${CONVERSATION}`);
    const first = page.html.indexOf('Hello, it is still here.');
    const second = page.html.indexOf('Good, I will take it.');

    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
  });

  it('attributes the caller’s own message and the other side, never by identifier', async () => {
    const page = await load(`/dashboard/messages/${CONVERSATION}`);

    expect(page.html).toContain('You');
    expect(page.html).toContain('Other participant');
    expect(page.html).not.toContain(SENDER);
    expect(page.html).not.toContain(IDENTITY.user.id);
  });

  it('renders a system message', async () => {
    const page = await load(`/dashboard/messages/${CONVERSATION}`);
    expect(page.html).toContain('The listing was updated.');
    expect(page.html).toContain('System');
  });

  it('renders a reference message as the approved words, with no public listing link', async () => {
    const page = await load(`/dashboard/messages/${CONVERSATION}`);

    expect(page.html).toContain('No longer available');
    expect(page.html).not.toContain('/listing/');
    expect(page.html).not.toContain('/service/');
  });

  it('renders no price, currency or seller detail for a reference', async () => {
    const page = await load(`/dashboard/messages/${CONVERSATION}`);

    expect(page.html).not.toContain('EGP');
    expect(page.html).not.toContain('priceMinor');
    expect(page.html).not.toContain('sellerUserId');
    expect(page.html).not.toContain('currencyMinorUnit');
  });

  it('shows the closed copy when the conversation is closed', async () => {
    apiServes({ inbox: 'closed' });
    const page = await load(`/dashboard/messages/${DIRECT_CONVERSATION}`);

    expect(page.html).toContain('Conversation closed');
    expect(page.html).toContain("You can't send messages in this conversation.");
  });

  it('shows the empty-thread copy when there are no messages', async () => {
    apiServes({ thread: 'empty' });
    const page = await load(`/dashboard/messages/${CONVERSATION}`);

    expect(page.status).toBe(200);
    expect(page.html).toContain('No messages yet');
  });

  it('offers older messages with the cursor the API issued', async () => {
    apiServes({ thread: 'paged' });
    const page = await load(`/dashboard/messages/${CONVERSATION}`);

    expect(page.html).toContain('Load older messages');
    expect(page.html).toContain(`cursor=${encodeURIComponent(NEXT_CURSOR)}`);
  });

  it('passes a cursor to the API unchanged, without parsing it', async () => {
    apiServes({ thread: 'paged' });
    await load(`/dashboard/messages/${CONVERSATION}?cursor=${encodeURIComponent(NEXT_CURSOR)}`);

    const asked = api.seen.filter((request) => request.url.includes('/messages?'));
    expect(asked.length).toBeGreaterThan(0);
    expect(new URL(`http://x${asked[0]!.url}`).searchParams.get('cursor')).toBe(NEXT_CURSOR);
  });

  it('shows the same wording for a conversation that is not theirs and one that does not exist', async () => {
    apiServes({ thread: 'not_found' });
    const refused = await load(`/dashboard/messages/${CONVERSATION}`);
    const missing = await load('/dashboard/messages/e0000000-0000-4000-8000-000000000999');

    expect(refused.status).toBe(200);
    expect(refused.html).toContain('This conversation is no longer available.');
    expect(missing.html).toContain('This conversation is no longer available.');
    expect(refused.html).not.toContain('Hello, it is still here.');
  });

  it('shows the error state when the API cannot answer', async () => {
    apiServes({ thread: 'fails' });
    const page = await load(`/dashboard/messages/${CONVERSATION}`);

    expect(page.html).toContain('Unable to load messages');
    expect(page.html).toContain('Try again');
  });

  it('carries no control for an operation that does not exist', async () => {
    // 5-E added the composer and the four controls this page was built without. What it did not add —
    // because none of it exists anywhere in the stack — is an edit, a delete, a reopen, an attachment or
    // a report action. Absence is asserted against the rendered markup rather than against the whole
    // document: every label a client component receives as a prop also travels in the flight payload, so
    // a bare string search would find words the page never shows.
    const page = await load(`/dashboard/messages/${CONVERSATION}`);
    const buttons = page.html.match(/>[^<>]+<\/button>/g) ?? [];

    expect(buttons.length).toBeGreaterThan(0);
    // 5-H added reporting, which is a request for a look rather than an operation on the message, so
    // `Report` is no longer in this list. 0104 added attaching, so `Attach` left it too — it operates on a
    // message the caller owns rather than on the conversation, and the attachment section below asserts its
    // shape. Editing, deleting and reopening still do not exist anywhere in the stack.
    for (const forbidden of ['Edit', 'Delete', 'Reopen']) {
      expect(buttons.join(' '), forbidden).not.toContain(forbidden);
    }
  });

  it('is not indexable, and names no API address or token', async () => {
    const page = await load(`/dashboard/messages/${CONVERSATION}`);

    expect(page.robotsHeader).toBe('noindex');
    expect(page.html).not.toContain('/v1/');
    expect(page.html).not.toContain('canary-access-token');
    expect(page.html).not.toContain(CANARY_CREDENTIAL);
  });
});

describe('a signed-out visitor', () => {
  it('is redirected away from the inbox before anything renders', async () => {
    const page = await load('/dashboard/messages', null);

    expect(page.status).toBe(307);
    expect(page.location).toContain('/login');
  });

  it('is redirected away from a thread too', async () => {
    const page = await load(`/dashboard/messages/${CONVERSATION}`, null);

    expect(page.status).toBe(307);
    expect(page.location).toContain('/login');
  });

  it('receives no message content at all, payload included', async () => {
    const page = await load(`/dashboard/messages/${CONVERSATION}`, null);

    expect(page.html).not.toContain('Hello, it is still here.');
    expect(page.html).not.toContain('Walnut dining table');
  });

  it('with a cookie the API rejects, sees the signed-out view and no messages', async () => {
    api.reply((request, response) => {
      const path = request.url.split('?')[0] ?? '';
      if (path === '/v1/users/me') return problem(response, 401, 'AUTHENTICATION_REQUIRED');
      return json(response, { items: MESSAGES, nextCursor: null });
    });
    const page = await load(`/dashboard/messages/${CONVERSATION}`);

    expect(page.status).toBe(200);
    expect(page.html).toContain('You are signed out');
    expect(page.html).not.toContain('Hello, it is still here.');
  });
});

describe('the dashboard navigation', () => {
  it('reaches the inbox from a signed-in page', async () => {
    // 7-E moved the phone change to the security page; the navigation is the same navigation.
    const page = await load('/dashboard/security', SESSION);

    expect(page.status).toBe(200);
    expect(page.html).toContain('/dashboard/messages');
    expect(page.html).toContain('Phone number');
  });

  it('is not shown to a signed-out visitor', async () => {
    api.reply((request, response) => {
      const path = request.url.split('?')[0] ?? '';
      if (path === '/v1/users/me') return problem(response, 401, 'AUTHENTICATION_REQUIRED');
      return json(response, { items: [], nextCursor: null });
    });
    const page = await load('/dashboard/settings', SESSION);

    expect(page.html).toContain('You are signed out');
    expect(page.html).not.toContain('/dashboard/messages');
  });
});

describe('the public surfaces are untouched', () => {
  it('still answer 200 with no session', async () => {
    for (const path of ['/listings', '/services', '/categories', '/marketplace', '/search?q=chair']) {
      const page = await load(path, null);
      expect(page.status, path).toBe(200);
    }
  });

  it('still answer 200 under /ar', async () => {
    for (const path of ['/ar/listings', '/ar/services', '/ar/marketplace']) {
      const page = await load(path, null);
      expect(page.status, path).toBe(200);
    }
  });

  it('keep their robots policy, and messaging stays out of it', async () => {
    expect((await load('/listings', null)).robotsHeader).toBeNull();
    expect((await load('/marketplace', null)).robotsHeader).toBeNull();
    expect((await load('/search?q=chair', null)).robotsHeader).toBe('noindex');
    expect((await load('/dashboard/messages')).robotsHeader).toBe('noindex');
  });

  it('are never redirected to a sign-in page', async () => {
    for (const path of ['/listings', '/marketplace', '/categories']) {
      const page = await load(path, null);
      expect(page.location, path).toBeNull();
    }
  });
});

describe('the messaging BFF routes are reachable through the middleware', () => {
  it('the inbox route is not rewritten into a locale path', async () => {
    const response = await fetch(`${app.baseUrl}/api/messaging/conversations`, { redirect: 'manual' });
    // 401 rather than 404: the route ran and found no session cookie.
    expect(response.status).toBe(401);
  });

  it('the messages route is not rewritten either', async () => {
    const response = await fetch(
      `${app.baseUrl}/api/messaging/conversations/${CONVERSATION}/messages`,
      { redirect: 'manual' },
    );
    expect(response.status).toBe(401);
  });

  it('the unread-count route is not rewritten either', async () => {
    const response = await fetch(`${app.baseUrl}/api/messaging/unread-count`, { redirect: 'manual' });
    expect(response.status).toBe(401);
  });

  it('answer with a session, and never echo a token', async () => {
    const response = await fetch(`${app.baseUrl}/api/messaging/conversations`, {
      redirect: 'manual',
      headers: { cookie: SESSION },
    });
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).not.toContain('canary-access-token');
    expect(text).not.toContain(CANARY_CREDENTIAL);
    expect(text).toContain('Walnut dining table');
  });
});

/**
 * The write surface (Phase 5-E).
 *
 * The handlers are tested directly in `bff-messaging-write.test.ts`; what is proved here is that they are
 * reachable where the browser posts, that the middleware leaves them alone, that a state-changing request
 * from another origin is refused, and that the thread page actually renders a composer and controls whose
 * state matches the conversation.
 */

/** The API as it answers the six writes. */
function apiServesWrites(): void {
  api.reply((request, response) => {
    const path = request.url.split('?')[0] ?? '';
    if (path === '/v1/users/me') return json(response, IDENTITY);

    if (request.method === 'POST' && path === '/v1/messaging/conversations') {
      return json(response, { outcome: 'created', conversationId: CONVERSATION });
    }
    if (request.method === 'POST' && path.endsWith('/messages')) {
      response.writeHead(201, { 'content-type': 'application/json' });
      return void response.end(JSON.stringify({ message: MESSAGES[0] }));
    }
    if (request.method === 'PUT' && path.endsWith('/read')) return json(response, { lastReadSeq: '3' });
    if (request.method === 'PUT' && path.endsWith('/muted')) return json(response, { isMuted: true });
    if (request.method === 'DELETE' && path.endsWith('/membership')) {
      return json(response, { membershipState: 'left' });
    }
    if (request.method === 'PUT' && path.endsWith('/closed')) {
      return json(response, { isClosed: true, closedAt: '2026-09-24T18:30:00.000Z' });
    }
    return problem(response, 404, 'NOT_FOUND');
  });
}

interface Wrote {
  readonly status: number;
  readonly text: string;
}

async function write(
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Wrote> {
  const response = await fetch(`${app.baseUrl}${path}`, {
    method,
    redirect: 'manual',
    headers: {
      origin: app.baseUrl,
      cookie: SESSION,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, text: await response.text() };
}

const WRITES = [
  ['POST', '/api/messaging/conversations', { subjectType: 'listing', listingId: '11110000-0000-4000-8000-000000000001' }],
  ['POST', `/api/messaging/conversations/${CONVERSATION}/messages`, { body: 'Still available?' }],
  ['PUT', `/api/messaging/conversations/${CONVERSATION}/read`, { seq: '3' }],
  ['PUT', `/api/messaging/conversations/${CONVERSATION}/muted`, { isMuted: true }],
  ['DELETE', `/api/messaging/conversations/${CONVERSATION}/membership`, undefined],
  ['PUT', `/api/messaging/conversations/${CONVERSATION}/closed`, undefined],
] as const;

describe('the messaging write routes', () => {
  it('all six exist where the browser posts, and answer with a session', async () => {
    apiServesWrites();
    for (const [method, path, body] of WRITES) {
      const result = await write(method, path, body);
      expect([200, 201], `${method} ${path} → ${result.status}`).toContain(result.status);
    }
  });

  it('are not rewritten into a locale path', async () => {
    apiServesWrites();
    for (const [method, path, body] of WRITES) {
      const result = await write(method, path, body);
      expect(result.status, `${method} ${path}`).not.toBe(404);
    }
  });

  it('refuse a request from another origin', async () => {
    apiServesWrites();
    for (const [method, path, body] of WRITES) {
      const result = await write(method, path, body, { origin: 'https://evil.test' });
      expect(result.status, `${method} ${path}`).toBe(403);
    }
  });

  it('refuse a request with no session', async () => {
    apiServesWrites();
    for (const [method, path, body] of WRITES) {
      const response = await fetch(`${app.baseUrl}${path}`, {
        method,
        redirect: 'manual',
        headers: {
          origin: app.baseUrl,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(response.status, `${method} ${path}`).toBe(401);
    }
  });

  it('never echo a token, a credential or an upstream address', async () => {
    apiServesWrites();
    for (const [method, path, body] of WRITES) {
      const result = await write(method, path, body);
      for (const secret of ['canary-access-token', 'canary-refresh-token', CANARY_CREDENTIAL, '/v1/']) {
        expect(result.text, `${method} ${path} ${secret}`).not.toContain(secret);
      }
    }
  });

  it('offer no route for editing a message, deleting one, or reopening a conversation', async () => {
    apiServesWrites();
    for (const [method, path] of [
      ['PATCH', `/api/messaging/conversations/${CONVERSATION}/messages/a1000000-0000-4000-8000-000000000001`],
      ['DELETE', `/api/messaging/conversations/${CONVERSATION}/messages/a1000000-0000-4000-8000-000000000001`],
      ['POST', `/api/messaging/conversations/${CONVERSATION}/reopen`],
      ['POST', `/api/messaging/conversations/${CONVERSATION}/attachments`],
    ] as const) {
      const response = await fetch(`${app.baseUrl}${path}`, {
        method,
        redirect: 'manual',
        headers: { origin: app.baseUrl, cookie: SESSION },
      });
      expect(response.status, `${method} ${path}`).toBe(404);
    }
  });
});

describe('the composer and the controls on the thread page', () => {
  it('renders the composer and the four controls on an open conversation', async () => {
    const page = await load(`/dashboard/messages/${CONVERSATION}`);

    // Asserted against rendered markup: a label passed to a client component as a prop also appears in
    // the flight payload, so `toContain('Send')` alone would pass even for a control that never rendered.
    expect(page.html).toContain('placeholder="Write a message..."');
    expect(page.html).toContain('<textarea');
    expect(page.html).toContain('>Send</button>');
    expect(page.html).toContain('>Mark as read</button>');
    expect(page.html).toContain('>Mute conversation</button>');
    expect(page.html).toContain('>Leave conversation</button>');
    expect(page.html).toContain('>Close conversation</button>');
  });

  it('offers no edit, delete or reopen control among the rendered buttons', async () => {
    const page = await load(`/dashboard/messages/${CONVERSATION}`);
    const buttons = (page.html.match(/>[^<>]+<\/button>/g) ?? []).join(' ');
    // Narrowed by 0104: attaching exists now. Nothing that would alter a message that has been sent does.
    for (const absent of ['Edit', 'Delete', 'Reopen']) {
      expect(buttons, absent).not.toContain(absent);
    }
  });

  it('disables the composer on a closed conversation and says why', async () => {
    apiServes({ inbox: 'closed' });
    const page = await load(`/dashboard/messages/${DIRECT_CONVERSATION}`);

    // The field stays and is disabled: an input that disappears reads as a broken page, a disabled one
    // reads as a rule.
    expect(page.html).toContain('<textarea');
    expect(page.html).toContain('disabled=""');
    expect(page.html).toContain('name="body"');
    // Closing and leaving are done, so neither button renders — and there is no reopen.
    expect(page.html).not.toContain('>Close conversation</button>');
    expect(page.html).not.toContain('>Leave conversation</button>');
    // Reading state and unmuting still work: neither writes a message.
    expect(page.html).toContain('>Unmute conversation</button>');
    expect(page.html).toContain('>Mark as read</button>');
  });

  it('renders the composer in Arabic', async () => {
    const page = await load(`/ar/dashboard/messages/${CONVERSATION}`);

    expect(page.html).toContain('placeholder="اكتب رسالتك..."');
    expect(page.html).toContain('>إرسال</button>');
    expect(page.html).toContain('>تعيين كمقروءة</button>');
  });

  it('gives a signed-out visitor none of the composer, not even in the flight payload', async () => {
    const page = await load(`/dashboard/messages/${CONVERSATION}`, null);

    expect(page.status).toBe(307);
    for (const absent of ['Write a message', 'name="body"', 'Mark as read', 'Leave conversation', '<textarea']) {
      expect(page.html, absent).not.toContain(absent);
    }
  });

  it('lays the write controls out with logical properties only', async () => {
    const page = await load(`/dashboard/messages/${CONVERSATION}`);
    expect(page.html).not.toMatch(/class="[^"]*\b(ml|mr|pl|pr)-\d/);
  });
});

describe('the catch-up layer (Phase 5-F)', () => {
  it('brings no Realtime, no socket and no provider client to either surface', async () => {
    for (const path of ['/dashboard/messages', `/dashboard/messages/${CONVERSATION}`]) {
      const page = await load(path);
      for (const absent of ['ws://', 'wss://', 'EventSource', 'createClient', 'supabase', 'realtime']) {
        expect(page.html.toLowerCase(), `${path} ${absent}`).not.toContain(absent.toLowerCase());
      }
    }
  });

  it('still ships no identifier to either surface, now that a client component renders them', async () => {
    // The rows and the messages cross into a client component, so they travel in the RSC payload. They
    // are narrowed on the way, and this is the assertion that says so about the real document.
    for (const path of ['/dashboard/messages', `/dashboard/messages/${CONVERSATION}`]) {
      const page = await load(path);
      expect(page.html, path).not.toContain(SENDER);
      expect(page.html, path).not.toContain(IDENTITY.user.id);
      for (const absent of ['lastMessageSenderUserId', 'senderUserId', 'lastMessageId']) {
        expect(page.html, `${path} ${absent}`).not.toContain(absent);
      }
    }
  });

  it('keeps the opaque cursors exactly where 5-D put them', async () => {
    apiServes({ inbox: 'paged', thread: 'paged' });

    const inbox = await load('/dashboard/messages');
    expect(inbox.html).toContain('Load more');
    expect(inbox.html).toContain(`cursor=${encodeURIComponent(NEXT_CURSOR)}`);

    const thread = await load(`/dashboard/messages/${CONVERSATION}`);
    expect(thread.html).toContain('Load older messages');
    expect(thread.html).toContain(`cursor=${encodeURIComponent(NEXT_CURSOR)}`);
  });

  it('polls the page it is showing, not the first one: the cursor goes back to the API unchanged', async () => {
    api.seen.length = 0;
    await load(`/dashboard/messages?cursor=${encodeURIComponent(NEXT_CURSOR)}`);

    const asked = api.seen.filter((call) => call.url.startsWith('/v1/messaging/conversations?'));
    expect(asked).toHaveLength(1);
    expect(new URL(`http://x${asked[0]!.url}`).searchParams.get('cursor')).toBe(NEXT_CURSOR);
  });

  it('renders the error view only when a read actually failed', async () => {
    // The error copy lives on the server and is built on demand, so a page that loaded carries none of
    // it — not in the markup and not in the payload a client component's props travel in.
    const healthy = await load('/dashboard/messages');
    expect(healthy.html).not.toContain('Unable to load messages');

    apiServes({ inbox: 'fails' });
    const broken = await load('/dashboard/messages');
    expect(broken.html).toContain('Unable to load messages');
    expect(broken.html).toContain('Try again');
  });
});

/**
 * Reporting on the thread (Phase 5-H).
 *
 * The route, the two actions, the confirmation copy in both languages, and the absence of everything
 * reporting must not bring: no moderation surface, no identifier on screen, no message body in a link, and
 * no control that closes, mutes or blocks anything.
 */
describe('the report actions', () => {
  function apiServesReports(outcome: { status: number; body: unknown }): void {
    api.reply((request, response) => {
      const path = request.url.split('?')[0] ?? '';
      if (path === '/v1/users/me') return json(response, IDENTITY);
      if (path === '/v1/messaging/reports') {
        response.writeHead(outcome.status, {
          'content-type': outcome.status >= 400 ? 'application/problem+json' : 'application/json',
        });
        return void response.end(JSON.stringify(outcome.body));
      }
      if (path === '/v1/messaging/unread-count') return json(response, { unreadCount: 0 });
      if (path === '/v1/messaging/conversations') {
        return json(response, { items: [LISTING_CONVERSATION], nextCursor: null });
      }
      if (path.endsWith('/messages')) return json(response, { items: MESSAGES, nextCursor: null });
      return problem(response, 404, 'NOT_FOUND');
    });
  }

  it('offers "Report message" on the thread', async () => {
    const page = await load(`/dashboard/messages/${CONVERSATION}`);
    expect(page.html).toContain('>Report message</button>');
  });

  it('offers "Report conversation" beside the controls', async () => {
    const page = await load(`/dashboard/messages/${CONVERSATION}`);
    expect(page.html).toContain('>Report conversation</button>');
  });

  it('offers a report on each reportable message rather than one for the thread', async () => {
    const page = await load(`/dashboard/messages/${CONVERSATION}`);
    const buttons = page.html.match(/>Report message<\/button>/g) ?? [];
    // Three of the four fixture messages are reportable; the system message is nobody's to report.
    expect(buttons.length).toBeGreaterThan(1);
  });

  it('carries the confirmation copy, including that it stays and that a repeat files nothing new', async () => {
    const page = await load(`/dashboard/messages/${CONVERSATION}`);

    expect(page.html).toContain('It stays in the conversation');
    expect(page.html).toContain('It stays open and readable');
    expect(page.html).toContain('does not create a second report');
    expect(page.html).toContain('Send report');
  });

  it('renders the actions and the confirmation in Arabic', async () => {
    const page = await load(`/ar/dashboard/messages/${CONVERSATION}`);

    expect(page.html).toContain('<html lang="ar" dir="rtl">');
    expect(page.html).toContain('>الإبلاغ عن الرسالة</button>');
    expect(page.html).toContain('>الإبلاغ عن المحادثة</button>');
    expect(page.html).toContain('إرسال الإبلاغ');
  });

  it('lays the report controls out with logical properties only', async () => {
    const page = await load(`/dashboard/messages/${CONVERSATION}`);
    expect(page.html).not.toMatch(/class="[^"]*\b(ml|mr|pl|pr)-\d/);
  });

  it('shows no identifier and no message body outside the thread itself', async () => {
    const page = await load(`/dashboard/messages/${CONVERSATION}`);
    const buttons = (page.html.match(/>[^<>]+<\/button>/g) ?? []).join(' ');

    expect(buttons).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/);
    expect(buttons).not.toContain('Hello, it is still here.');
    // No link or form action carries the message anywhere either.
    expect(page.html).not.toMatch(/(href|action)="[^"]*Hello/);
  });

  /**
   * Narrowed by 0103, which added the one self-service safety control this thread may carry.
   *
   * `Block` left this list because it now exists and is the caller's own action over their own
   * `user_blocks` row — not a moderation power. Everything a *moderator* would need is still absent, and
   * the next test asserts the control that replaced it is the self-service one rather than a sanction.
   */
  it('brings no moderation surface and no Realtime', async () => {
    const page = await load(`/dashboard/messages/${CONVERSATION}`);
    const buttons = (page.html.match(/>[^<>]+<\/button>/g) ?? []).join(' ');

    // Narrowed twice: `Block` by 0103 and `Attach` by 0104, both of which are the caller's own actions rather
    // than moderation powers. Everything a *moderator* would need is still absent.
    for (const absent of ['Hide', 'Remove', 'Ban', 'Suspend', 'Moderat', 'Dismiss']) {
      expect(buttons, absent).not.toContain(absent);
    }
    for (const absent of ['ws://', 'wss://', 'EventSource']) {
      expect(page.html, absent).not.toContain(absent);
    }
  });

  /* ---------------------------------------------------------------------------------------------- */
  /* Attachments (0104)                                                                              */
  /* ---------------------------------------------------------------------------------------------- */

  it('renders each file on its message, by kind and size, with a way to open it', async () => {
    apiServes();
    const page = await load(`/dashboard/messages/${CONVERSATION}`);

    expect(page.html).toContain('Files');
    expect(page.html).toContain('Image');
    expect(page.html).toContain('PDF');
    expect(page.html).toContain('200 KB');
    expect(page.html).toContain('2.0 MB');
    // One open control per file.
    expect((page.html.match(/>Open<\/button>/g) ?? []).length).toBe(2);
  });

  /**
   * Nothing about the stored object reaches the browser, flight data included.
   *
   * The download is reached by attachment id through its own operation, so a path in the payload would be a
   * path nothing needs — and the one place a path is ever disclosed is the upload authorization, which is a
   * response to a request this page does not make.
   */
  it('puts no object path, bucket or storage URL in the page or its flight data', async () => {
    apiServes();
    const page = await load(`/dashboard/messages/${CONVERSATION}`);

    for (const absent of ['message-attachments/', 'objectPath', 'storage/v1', 'supabase']) {
      expect(page.html.toLowerCase(), absent).not.toContain(absent.toLowerCase());
    }
    // The ids are there, because the open control needs them.
    expect(page.html).toContain('b2000000-0000-4000-8000-000000000001');
  });

  it('offers the attach control on the caller’s own message only', async () => {
    apiServes();
    const page = await load(`/dashboard/messages/${CONVERSATION}`);

    // One own message in the fixture, so exactly one attach control and one file input.
    expect((page.html.match(/>Attach a file<\/button>/g) ?? []).length).toBe(1);
    expect((page.html.match(/type="file"/g) ?? []).length).toBe(1);
  });

  /** SVG is not offered by the picker, for the same reason the server refuses it. */
  it('offers only the four permitted types to the file picker, never SVG', async () => {
    apiServes();
    const page = await load(`/dashboard/messages/${CONVERSATION}`);

    expect(page.html).toContain('accept="image/jpeg,image/png,image/webp,application/pdf"');
    expect(page.html).not.toContain('svg');
  });

  it('offers no attach control on a closed conversation, which takes nothing new', async () => {
    apiServes({ inbox: 'closed' });
    const page = await load(`/dashboard/messages/${DIRECT_CONVERSATION}`);

    expect(page.html).toContain('Conversation closed');
    expect(page.html).not.toContain('>Attach a file</button>');
    // The files already there stay openable, because a closed thread is still readable.
    expect(page.html).toContain('>Open</button>');
  });

  it('renders the attachment copy in Arabic', async () => {
    apiServes();
    const page = await load(`/ar/dashboard/messages/${CONVERSATION}`);

    expect(page.html).toContain('الملفات');
    expect(page.html).toContain('إرفاق ملف');
    expect(page.html).toContain('فتح');
  });

  /**
   * Blocking from the thread (0103).
   *
   * It sits beside reporting rather than among the four controls, for the same reason reporting does: the
   * four change the caller's own relationship to the conversation, and these two do something else. A
   * report asks staff to look; a block stops contact and tells nobody.
   */
  it('offers the self-service block, and nothing that sanctions anybody', async () => {
    const page = await load(`/dashboard/messages/${CONVERSATION}`);

    expect(page.html).toContain('>Block</button>');
    // The handle is the conversation. Nothing in the payload names an account.
    expect(page.html).toContain(CONVERSATION);
    expect(page.html).not.toContain('blockedUserId');
    expect(page.html).not.toContain('sellerUserId');
    // And it is not dressed as a moderation decision.
    for (const absent of ['Report user', 'Ban user', 'Suspend account', 'Warn']) {
      expect(page.html, absent).not.toContain(absent);
    }
  });

  it('asks before blocking, rather than acting on one press', async () => {
    const page = await load(`/dashboard/messages/${CONVERSATION}`);
    // The confirmation words are not in the markup until the first press, which is what makes it two steps.
    expect(page.html).not.toContain('>Yes, block</button>');
  });

  it('keeps the message and the conversation exactly as they were: reporting is not a control', async () => {
    const page = await load(`/dashboard/messages/${CONVERSATION}`);

    // The four controls are still the four controls; reporting joined none of them.
    expect(page.html).toContain('>Mark as read</button>');
    expect(page.html).toContain('>Mute conversation</button>');
    expect(page.html).toContain('>Leave conversation</button>');
    expect(page.html).toContain('>Close conversation</button>');
    // And the messages are all still rendered.
    expect(page.html).toContain('Hello, it is still here.');
    expect(page.html).toContain('The listing was updated.');
  });

  it('files a report through this origin and answers with the open report', async () => {
    apiServesReports({
      status: 200,
      body: { outcome: 'filed', reportId: 'c0000000-0000-4000-8000-00000000000a' },
    });
    const response = await fetch(`${app.baseUrl}/api/messaging/reports`, {
      method: 'POST',
      redirect: 'manual',
      headers: { origin: app.baseUrl, cookie: SESSION, 'content-type': 'application/json' },
      body: JSON.stringify({ subjectType: 'message', subjectId: MESSAGES[0]!.id, reasonCode: 'other' }),
    });
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toEqual({
      outcome: 'filed',
      reportId: 'c0000000-0000-4000-8000-00000000000a',
    });
    expect(text).not.toContain('canary-access-token');
    expect(text).not.toContain(CANARY_CREDENTIAL);
    expect(text).not.toContain('/v1/');
  });

  it('answers the same report twice: a repeat creates nothing new', async () => {
    apiServesReports({
      status: 200,
      body: { outcome: 'filed', reportId: 'c0000000-0000-4000-8000-00000000000a' },
    });
    const send = async () =>
      (
        await fetch(`${app.baseUrl}/api/messaging/reports`, {
          method: 'POST',
          redirect: 'manual',
          headers: { origin: app.baseUrl, cookie: SESSION, 'content-type': 'application/json' },
          body: JSON.stringify({
            subjectType: 'conversation',
            subjectId: CONVERSATION,
            reasonCode: 'other',
          }),
        })
      ).text();

    expect(await send()).toBe(await send());
  });

  it('passes a refusal through, and needs no proxy change to be reachable', async () => {
    apiServesReports({
      status: 404,
      body: { status: 404, code: 'MESSAGING_REPORT_TARGET_NOT_FOUND', detail: 'x' },
    });
    const response = await fetch(`${app.baseUrl}/api/messaging/reports`, {
      method: 'POST',
      redirect: 'manual',
      headers: { origin: app.baseUrl, cookie: SESSION, 'content-type': 'application/json' },
      body: JSON.stringify({ subjectType: 'message', subjectId: MESSAGES[0]!.id, reasonCode: 'other' }),
    });

    // 404 from the API rather than a 404 from the router: the middleware already treats the whole
    // `/api/messaging/` family as a BFF route, so 5-H added nothing to it.
    expect(response.status).toBe(404);
    expect(((await response.json()) as { code: string }).code).toBe('MESSAGING_REPORT_TARGET_NOT_FOUND');
  });

  it('refuses a report from another origin and one with no session', async () => {
    apiServesReports({ status: 200, body: { outcome: 'filed', reportId: 'c0' } });
    const body = JSON.stringify({ subjectType: 'message', subjectId: MESSAGES[0]!.id, reasonCode: 'other' });

    const crossOrigin = await fetch(`${app.baseUrl}/api/messaging/reports`, {
      method: 'POST',
      redirect: 'manual',
      headers: { origin: 'https://evil.test', cookie: SESSION, 'content-type': 'application/json' },
      body,
    });
    const signedOut = await fetch(`${app.baseUrl}/api/messaging/reports`, {
      method: 'POST',
      redirect: 'manual',
      headers: { origin: app.baseUrl, 'content-type': 'application/json' },
      body,
    });

    expect(crossOrigin.status).toBe(403);
    expect(signedOut.status).toBe(401);
  });

  it('gives a signed-out visitor none of the report surface, payload included', async () => {
    const page = await load(`/dashboard/messages/${CONVERSATION}`, null);

    expect(page.status).toBe(307);
    for (const absent of ['Report message', 'Report conversation', 'Send report']) {
      expect(page.html, absent).not.toContain(absent);
    }
  });
});
