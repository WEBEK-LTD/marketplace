import type { ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import arMessages from '../messages/ar.json';
import enMessages from '../messages/en.json';
import { problem, startStubApi, type StubApi } from './support/stub-api.js';
import { startBuiltApp, type RunningApp } from './support/next-server.js';

/**
 * The notification surface, over real HTTP against the built app (Phase 7-C).
 *
 * Run against the built app rather than a unit harness because what matters is what actually reaches a
 * browser, including the streamed RSC payload. The assertions fall into four groups:
 *
 *   * **the states** — empty, error, unread, archived — each rendered as itself, and an unavailable
 *     service never rendered as an empty inbox;
 *   * **the two reads are independent** — a failing badge leaves the list intact, and a failing list
 *     leaves the page standing;
 *   * **nothing leaks** — no internal credential, no session token, no `/v1/...` address, and no field
 *     the contract does not name;
 *   * **a signed-out visitor receives none of it**, flight data included.
 *
 * No browser, no Playwright, no live provider, no deployment.
 */

// Exactly 43 base64url characters: the web app's env validation refuses any other length at startup.
const CANARY_CREDENTIAL = 'test-web-notifications-canary-credential-12';
const ACCESS = '__Host-mp_access=canary-access-token-value-not-a-real-token';
const REFRESH = '__Host-mp_refresh=canary-refresh-token-value-not-a-real-toke';
const SESSION = `${ACCESS}; ${REFRESH}`;
const IDENTITY = { user: { id: '11111111-1111-4111-8111-111111111111', displayName: 'Nadia' } };

const EN = enMessages.Notifications;
const AR = arMessages.Notifications;

const UNREAD = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  category: 'messages',
  eventType: 'message.created',
  subjectType: 'message',
  subjectId: 'bbbbbbbb-0000-4000-8000-000000000001',
  actionPath: '/dashboard/messages/abc',
  createdAt: '2026-09-01T10:00:00.000Z',
  readAt: null,
  archivedAt: null,
};

const READ = {
  ...UNREAD,
  id: 'aaaaaaaa-0000-4000-8000-000000000002',
  category: 'orders',
  eventType: 'order.shipped',
  subjectType: 'order',
  actionPath: null,
  readAt: '2026-09-01T11:00:00.000Z',
};

const ARCHIVED = {
  ...READ,
  id: 'aaaaaaaa-0000-4000-8000-000000000003',
  category: 'security',
  eventType: 'security.alert',
  subjectType: null,
  subjectId: null,
  archivedAt: '2026-09-01T12:00:00.000Z',
};

type ListMode = 'ok' | 'empty' | 'fails' | 'paged';
type CountMode = 'ok' | 'fails';

let api: StubApi;
let app: RunningApp;

beforeAll(async () => {
  api = await startStubApi();
  app = await startBuiltApp({ API_BASE_URL: api.baseUrl, INTERNAL_BFF_CREDENTIAL: CANARY_CREDENTIAL });
}, 180_000);

afterAll(async () => {
  await app.stop();
  await api.stop();
});

function json(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function apiServes(modes: { list?: ListMode; count?: CountMode; identity?: 'ok' | 'unauthenticated' } = {}): void {
  const { list = 'ok', count = 'ok', identity = 'ok' } = modes;
  api.reply((request, response) => {
    const [path, search] = request.url.split('?');

    if (path === '/v1/users/me') {
      if (identity === 'unauthenticated') return problem(response, 401, 'AUTHENTICATION_REQUIRED');
      return json(response, IDENTITY);
    }

    if (path === '/v1/notifications/unread-count') {
      if (count === 'fails') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      return json(response, { unreadCount: 2 });
    }

    if (path === '/v1/notifications') {
      if (list === 'fails') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      if (list === 'empty') return json(response, { items: [], nextCursor: null });
      const archived = (search ?? '').includes('view=archived');
      if (archived) return json(response, { items: [ARCHIVED], nextCursor: null });
      if (list === 'paged') return json(response, { items: [UNREAD], nextCursor: 'bnQxfG5leHQ' });
      return json(response, { items: [UNREAD, READ], nextCursor: null });
    }

    return problem(response, 404, 'NOT_FOUND');
  });
}

async function get(path: string, cookie = SESSION): Promise<{ status: number; html: string }> {
  const response = await fetch(`${app.baseUrl}${path}`, { redirect: 'manual', headers: { cookie } });
  return { status: response.status, html: await response.text() };
}

describe('the inbox', () => {
  it('renders the caller’s notifications with their category, subject and link', async () => {
    apiServes();
    const { status, html } = await get('/dashboard/notifications');

    expect(status).toBe(200);
    expect(html).toContain(EN.title);
    expect(html).toContain(EN.intro);
    // The category is named in the reader's language; the event type stays the token it is.
    expect(html).toContain(EN.category.messages);
    expect(html).toContain(EN.subject.message);
    expect(html).toContain('message.created');
    expect(html).toContain(EN.category.orders);
    expect(html).toContain('/dashboard/messages/abc');
  });

  it('marks an unread notification visibly, and not by colour alone', async () => {
    apiServes();
    const { html } = await get('/dashboard/notifications');

    // A visible word, so somebody who cannot distinguish a border colour can still tell.
    expect(html).toContain(EN.unread);
  });

  it('shows the unread badge, and offers mark-read and archive', async () => {
    apiServes();
    const { html } = await get('/dashboard/notifications');

    expect(html).toContain(EN.unreadBadge);
    expect(html).toContain(`>${EN.markRead}</button>`);
    expect(html).toContain(`>${EN.archive}</button>`);
    expect(html).toContain(`>${EN.markAllRead}</button>`);
  });

  it('renders the empty state, which says what is actually true', async () => {
    apiServes({ list: 'empty' });
    const { html } = await get('/dashboard/notifications');

    expect(html).toContain(EN.empty);
    expect(html).toContain(EN.emptyHint);
    expect(html).not.toContain(EN.error);
  });

  it('offers the next page only when there is one', async () => {
    apiServes({ list: 'paged' });
    const paged = await get('/dashboard/notifications');
    expect(paged.html).toContain(EN.older);
    expect(paged.html).toContain('cursor=bnQxfG5leHQ');

    apiServes();
    const last = await get('/dashboard/notifications');
    expect(last.html).not.toContain(EN.older);
  });
});

describe('the archived view', () => {
  it('is a separate list, reached from the inbox', async () => {
    apiServes();
    const inbox = await get('/dashboard/notifications');
    expect(inbox.html).toContain(EN.tabArchived);
    expect(inbox.html).toContain('view=archived');

    const archived = await get('/dashboard/notifications?view=archived');
    expect(archived.status).toBe(200);
    expect(archived.html).toContain(EN.category.security);
    // An archived notification offers neither action: there is nothing left to do to it here. Asserted
    // on the rendered buttons rather than on the label strings — labels are client-component props and
    // travel in the flight data either way, which is fine: they are copy, not capability.
    expect(archived.html).not.toContain(`>${EN.archive}</button>`);
    expect(archived.html).not.toContain(`>${EN.markRead}</button>`);
    expect(archived.html).not.toContain(`>${EN.markAllRead}</button>`);
  });

  it('has its own empty state', async () => {
    apiServes({ list: 'empty' });
    const { html } = await get('/dashboard/notifications?view=archived');

    expect(html).toContain(EN.emptyArchived);
    expect(html).toContain(EN.emptyArchivedHint);
    expect(html).not.toContain(EN.empty);
  });

  it('falls back to the inbox for a view that does not exist', async () => {
    apiServes();
    const { status, html } = await get('/dashboard/notifications?view=deleted');

    // A mistake in a link should show the list somebody meant to see, not an error page.
    expect(status).toBe(200);
    expect(html).toContain(EN.category.messages);
  });
});

describe('failure states', () => {
  it('says the list could not be loaded, and never that the inbox is empty', async () => {
    apiServes({ list: 'fails' });
    const { status, html } = await get('/dashboard/notifications');

    expect(status).toBe(200);
    expect(html).toContain(EN.error);
    expect(html).toContain(EN.retry);
    // The distinction that matters: an outage is not "you have no notifications".
    expect(html).not.toContain(EN.empty);
  });

  it('loses only the badge when only the badge fails', async () => {
    apiServes({ count: 'fails' });
    const { html } = await get('/dashboard/notifications');

    // The two reads are independent, so the list survives.
    expect(html).toContain(EN.category.messages);
    // And no number is invented: a badge that could not be read renders nothing, not a zero.
    expect(html).not.toContain(EN.unreadBadge);
  });

  it('keeps the page standing when only the list fails', async () => {
    apiServes({ list: 'fails' });
    const { html } = await get('/dashboard/notifications');

    expect(html).toContain(EN.title);
    expect(html).toContain(EN.tabArchived);
  });
});

describe('what reaches the browser', () => {
  it('leaks no credential, no session token and no API address', async () => {
    apiServes();
    const { html } = await get('/dashboard/notifications');

    expect(html).not.toContain(CANARY_CREDENTIAL);
    expect(html).not.toContain('canary-access-token-value-not-a-real-token');
    expect(html).not.toContain(api.baseUrl);
    expect(html).not.toContain('/v1/');
  });

  it('carries no account identifier anywhere, flight data included', async () => {
    apiServes();
    const { html } = await get('/dashboard/notifications');

    expect(html).not.toContain(IDENTITY.user.id);
  });

  it('is noindex, like every other signed-in surface', async () => {
    apiServes();
    const { html } = await get('/dashboard/notifications');
    expect(html).toMatch(/name="robots"[^>]*content="noindex/);
  });

  it('ships none of it to a visitor whose session is not accepted', async () => {
    apiServes({ identity: 'unauthenticated' });
    const { html } = await get('/dashboard/notifications');

    // The gate is a server component inside the page, so the protected subtree is never rendered,
    // never serialized and never sent.
    expect(html).not.toContain(`>${EN.markAllRead}</button>`);
    expect(html).not.toContain(EN.category.messages);
    expect(html).not.toContain('message.created');
    expect(html).not.toContain(EN.intro);
  });

  it('redirects a visitor with no session cookie at all', async () => {
    apiServes();
    const response = await fetch(`${app.baseUrl}/dashboard/notifications`, { redirect: 'manual' });

    expect([302, 307, 308]).toContain(response.status);
    expect(response.headers.get('location')).toContain('/login');
  });
});

describe('Arabic', () => {
  it('renders right to left, with the event type still left to right', async () => {
    apiServes();
    const { status, html } = await get('/ar/dashboard/notifications');

    expect(status).toBe(200);
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('lang="ar"');
    expect(html).toContain(AR.title);
    expect(html).toContain(AR.category.messages);
    expect(html).toContain(AR.markAllRead);
    // An event type is a dotted identifier, read left to right in every locale.
    expect(html).toContain('dir="ltr"');
    expect(html).toContain('message.created');
    // Asserted on distinctive prose rather than on the one-word title: "Notifications" is also the tail
    // of a client component's exported name, which React names in the flight data, and matching that
    // would be matching an identifier rather than a leaked English string.
    expect(html).not.toContain(EN.intro);
    expect(html).not.toContain(EN.markAllRead);
    expect(html).not.toContain(EN.category.messages);
  });

  it('links onward inside the Arabic routes', async () => {
    apiServes();
    const { html } = await get('/ar/dashboard/notifications');

    expect(html).toContain('/ar/dashboard/notifications?view=archived');
    expect(html).toContain('/ar/dashboard/messages/abc');
  });

  it('has the same keys as English, including every category and subject', async () => {
    expect(Object.keys(AR).sort()).toEqual(Object.keys(EN).sort());
    expect(Object.keys(AR.category).sort()).toEqual(Object.keys(EN.category).sort());
    expect(Object.keys(AR.subject).sort()).toEqual(Object.keys(EN.subject).sort());
    // The vocabularies are the schema's: twelve categories and seventeen subject types.
    expect(Object.keys(EN.category)).toHaveLength(12);
    expect(Object.keys(EN.subject)).toHaveLength(17);
  });
});
