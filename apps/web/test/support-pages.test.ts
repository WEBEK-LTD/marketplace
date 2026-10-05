import type { ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startBuiltApp, type RunningApp } from './support/next-server.js';
import { problem, startStubApi, type StubApi } from './support/stub-api.js';

/**
 * The two requester support surfaces, over real HTTP against the built app (Phase 7-K).
 *
 * Run against the built app rather than a unit harness for the same reason the other protection tests are:
 * what matters is what actually reaches a browser, **including the streamed RSC payload**. A signed-out
 * visitor must receive none of a ticket, and "none" has to mean none of the document.
 *
 * The assertions fall into six groups:
 *
 *   * **who is refused** — a signed-out visitor gets none of either page, in markup or flight data;
 *   * **what is never shipped** — no internal note, no agent identifier, no assignment, no priority, no
 *     first-response time and no storage path, whatever the API sends;
 *   * **a ticket that is not the caller's reads exactly like one that does not exist**;
 *   * **no agent control anywhere** — no assign, no note, no status and no priority control is on either
 *     page, and a closed ticket offers no reply and no second closure;
 *   * **both languages and the direction that goes with each**;
 *   * **every state**: empty, error, closed, resolved, paged and not-found.
 *
 * No browser, no Playwright, no live provider, no live storage, no deployment.
 */

const CANARY_CREDENTIAL = 'test-web-support-canary-credential-notreal1';
const ACCESS = '__Host-mp_access=canary-access-token-value-not-a-real-token';
const REFRESH = '__Host-mp_refresh=canary-refresh-token-value-not-a-real-toke';
const SESSION = `${ACCESS}; ${REFRESH}`;
const IDENTITY = { user: { id: '11111111-1111-4111-8111-111111111111', displayName: 'Nadia' } };

const TICKET = 'd4000000-0000-4000-8000-000000000001';
const MESSAGE = 'd4000000-0000-4000-8000-0000000000a1';
const AGENT_MESSAGE = 'd4000000-0000-4000-8000-0000000000a2';
const ATTACHMENT = 'd4000000-0000-4000-8000-0000000000b1';
const NEXT_CURSOR = 'c20xfDIwMjYtMDUtMDFUMDk6MDA6MDAuMDAwWnxkNDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDE';

const SUBJECT = 'Canary ticket about a payout';
const REFERENCE = 'SP-26-004242';
const OWN_BODY = 'Canary description of what went wrong with the payout.';
const AGENT_BODY = 'Canary reply from the support team about the payout.';
const FILE_NAME = 'canary-statement.pdf';

/** The things an internal-only field would be, if one ever reached a page. */
const INTERNAL_NOTE = 'Canary internal note that no requester may read';
const AGENT_ACCOUNT = '99999999-9999-4999-8999-999999999999';
const OBJECT_PATH = `support-attachments/${TICKET}/${MESSAGE}/f47ac10b-58cc-4372-a567-0e02b2c3d479.pdf`;

const SUMMARY = {
  id: TICKET,
  reference: REFERENCE,
  subject: SUBJECT,
  category: 'payouts',
  status: 'pending_agent',
  messageCount: 2,
  attachmentCount: 1,
  lastMessageAt: '2026-05-02T09:00:00.000Z',
  resolvedAt: null,
  closedAt: null,
  createdAt: '2026-05-01T09:00:00.000Z',
};

const DETAIL = {
  id: TICKET,
  reference: REFERENCE,
  subject: SUBJECT,
  category: 'payouts',
  status: 'pending_agent',
  messageCount: 2,
  lastMessageAt: '2026-05-02T09:00:00.000Z',
  resolvedAt: null,
  closedAt: null,
  createdAt: '2026-05-01T09:00:00.000Z',
};

const OWN_MESSAGE = {
  id: MESSAGE,
  authorRole: 'requester',
  isOwnMessage: true,
  body: OWN_BODY,
  createdAt: '2026-05-01T09:00:00.000Z',
  attachments: [
    { id: ATTACHMENT, originalFilename: FILE_NAME, contentType: 'application/pdf', byteSize: '20480' },
  ],
};

const AGENT_MESSAGE_ROW = {
  id: AGENT_MESSAGE,
  authorRole: 'agent',
  isOwnMessage: false,
  body: AGENT_BODY,
  createdAt: '2026-05-02T09:00:00.000Z',
  attachments: [],
};

type ListMode = 'ok' | 'empty' | 'fails' | 'paged' | 'closed';
type TicketMode = 'ok' | 'closed' | 'resolved' | 'missing' | 'fails';
type ThreadMode = 'ok' | 'paged' | 'fails' | 'leaky';

let api: StubApi;
let app: RunningApp;

beforeAll(async () => {
  api = await startStubApi();
  app = await startBuiltApp({ API_BASE_URL: api.baseUrl, INTERNAL_BFF_CREDENTIAL: CANARY_CREDENTIAL });
}, 240_000);

afterAll(async () => {
  await app.stop();
  await api.stop();
});

function json(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function listFor(mode: ListMode): unknown {
  if (mode === 'empty') return { items: [], nextCursor: null };
  if (mode === 'paged') return { items: [SUMMARY], nextCursor: NEXT_CURSOR };
  if (mode === 'closed') {
    return {
      items: [{ ...SUMMARY, status: 'closed', closedAt: '2026-05-03T09:00:00.000Z' }],
      nextCursor: null,
    };
  }
  return { items: [SUMMARY], nextCursor: null };
}

function ticketFor(mode: TicketMode): unknown {
  if (mode === 'closed') {
    return { ticket: { ...DETAIL, status: 'closed', closedAt: '2026-05-03T09:00:00.000Z' } };
  }
  if (mode === 'resolved') {
    return { ticket: { ...DETAIL, status: 'resolved', resolvedAt: '2026-05-03T09:00:00.000Z' } };
  }
  return { ticket: DETAIL };
}

function threadFor(mode: ThreadMode): unknown {
  if (mode === 'paged') {
    return { items: [OWN_MESSAGE, AGENT_MESSAGE_ROW], nextCursor: NEXT_CURSOR };
  }
  if (mode === 'leaky') {
    // An API that has drifted and sends internal fields. The contract is the wall: none of this may render.
    return {
      items: [
        {
          ...OWN_MESSAGE,
          authorUserId: AGENT_ACCOUNT,
          internalNote: INTERNAL_NOTE,
          attachments: [{ ...OWN_MESSAGE.attachments[0], objectPath: OBJECT_PATH }],
        },
      ],
      nextCursor: null,
    };
  }
  return { items: [OWN_MESSAGE, AGENT_MESSAGE_ROW], nextCursor: null };
}

function apiServes(
  modes: { list?: ListMode; ticket?: TicketMode; thread?: ThreadMode } = {},
): void {
  const { list = 'ok', ticket = 'ok', thread = 'ok' } = modes;
  api.seen.length = 0;
  api.reply((request, response) => {
    const path = request.url.split('?')[0] ?? '';

    if (path === '/v1/users/me') return json(response, IDENTITY);
    if (path === '/v1/messaging/unread-count') return json(response, { unreadCount: 0 });
    if (path === '/v1/notifications/unread-count') return json(response, { unreadCount: 0 });

    if (path === '/v1/support/tickets') {
      if (list === 'fails') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      return json(response, listFor(list));
    }
    if (path === `/v1/support/tickets/${TICKET}/messages`) {
      if (thread === 'fails') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      return json(response, threadFor(thread));
    }
    if (path === `/v1/support/tickets/${TICKET}`) {
      if (ticket === 'missing') return problem(response, 404, 'NOT_FOUND');
      if (ticket === 'fails') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      return json(response, ticketFor(ticket));
    }

    if (path === '/v1/listings') return json(response, { listings: [], nextCursor: null });
    if (path === '/v1/services') return json(response, { services: [], nextCursor: null });
    if (path === '/v1/categories') return json(response, { categories: [] });
    if (path === '/v1/search') return json(response, { results: [], nextCursor: null });
    return problem(response, 404, 'NOT_FOUND');
  });
}

beforeEach(() => {
  apiServes();
});

interface Page {
  readonly status: number;
  readonly html: string;
}

/** `cookie: null` means a signed-out visitor; omitting it means the signed-in session. */
async function load(path: string, cookie: string | null = SESSION): Promise<Page> {
  const response = await fetch(`${app.baseUrl}${path}`, {
    redirect: 'manual',
    headers: cookie === null ? {} : { cookie },
  });
  return { status: response.status, html: await response.text() };
}

const LIST = '/dashboard/support';
const DETAIL_PATH = `${LIST}/${TICKET}`;
const ALL = [LIST, DETAIL_PATH];

/** Everything a signed-out response must not contain, in markup or flight data. */
const SECRETS = [SUBJECT, REFERENCE, OWN_BODY, AGENT_BODY, FILE_NAME];

/* ------------------------------------------------------------------------------------------------ */

describe('who may see a support ticket', () => {
  it('ships none of either page to a signed-out visitor, in markup or flight data', async () => {
    for (const path of ALL) {
      const page = await load(path, null);
      for (const secret of SECRETS) expect(page.html, `${path} :: ${secret}`).not.toContain(secret);
      expect(page.html, path).not.toContain(TICKET);
    }
  });

  it('performs no read for a signed-out visitor', async () => {
    api.seen.length = 0;
    for (const path of ALL) await load(path, null);
    expect(api.seen.filter((request) => request.url.includes('/v1/support/'))).toHaveLength(0);
  });

  it('renders both pages for the account that raised the ticket', async () => {
    const list = await load(LIST);
    expect(list.status).toBe(200);
    expect(list.html).toContain(SUBJECT);
    expect(list.html).toContain(REFERENCE);

    const detail = await load(DETAIL_PATH);
    expect(detail.status).toBe(200);
    expect(detail.html).toContain(OWN_BODY);
    expect(detail.html).toContain(AGENT_BODY);
    expect(detail.html).toContain(FILE_NAME);
  });

  it('reads only the requester operations, never a queue or an admin path', async () => {
    api.seen.length = 0;
    await load(LIST);
    await load(DETAIL_PATH);
    const support = api.seen.filter((request) => request.url.includes('/support'));
    expect(support.length).toBeGreaterThan(0);
    for (const request of support) {
      expect(request.url).not.toContain('/v1/admin');
      expect(request.url).not.toContain('queue');
      expect(request.url).not.toContain('notes');
      expect(request.url).not.toContain('assign');
      expect(request.url).not.toContain('role=');
      expect(request.url).not.toContain('userId');
    }
  });

  it('answers a ticket that is not the caller’s exactly as one that does not exist', async () => {
    apiServes({ ticket: 'missing' });
    const missing = await load(DETAIL_PATH);
    expect(missing.status).toBe(200);
    expect(missing.html).not.toContain(SUBJECT);
    expect(missing.html).not.toContain(OWN_BODY);
    // The same sentence as a made-up address gets.
    expect(missing.html).toContain('could not be found');

    const madeUp = await load(`${LIST}/11111111-1111-4111-8111-111111111111`);
    expect(madeUp.html).toContain('could not be found');
  });

  it('treats an identifier that is not one as an address with nothing at it', async () => {
    const page = await load(`${LIST}/not-a-uuid`);
    expect(page.status).toBe(200);
    expect(page.html).toContain('could not be found');
    expect(page.html).not.toContain(SUBJECT);
  });
});

describe('what a ticket page never contains', () => {
  it('ships no internal note, no agent identifier and no storage path, even from a drifted API', async () => {
    apiServes({ thread: 'leaky' });
    const page = await load(DETAIL_PATH);
    expect(page.html).not.toContain(INTERNAL_NOTE);
    expect(page.html).not.toContain(AGENT_ACCOUNT);
    expect(page.html).not.toContain(OBJECT_PATH);
    expect(page.html).not.toContain('support-attachments/');
  });

  it('ships no assignment, priority or first-response field on either page', async () => {
    for (const path of ALL) {
      const page = await load(path);
      for (const word of ['assignedTo', 'assigned_at', 'firstResponse', 'membershipVersion', 'internalNote']) {
        expect(page.html, `${path} :: ${word}`).not.toContain(word);
      }
    }
  });

  it('offers no agent control: no assign, no note, no status and no priority', async () => {
    const page = await load(DETAIL_PATH);
    for (const word of ['/assign', '/notes', '/status', '/resolve', '/reopen']) {
      expect(page.html, word).not.toContain(word);
    }
    // What the forms are given is the ticket's own identifier, which is all any of them needs.
    expect(page.html).toContain(TICKET);
  });

  it('never ships a permission name or a staff role word', async () => {
    for (const path of ALL) {
      const page = await load(path);
      for (const word of ['support.ticket.read', 'support.ticket.manage', 'support_agent', 'aal2']) {
        expect(page.html, `${path} :: ${word}`).not.toContain(word);
      }
    }
  });
});

describe('the states each page has', () => {
  it('says so when there is nothing yet, and still offers the form', async () => {
    apiServes({ list: 'empty' });
    const page = await load(LIST);
    expect(page.html).toContain('No support tickets yet');
    expect(page.html).toContain('Ask for help');
    expect(page.html).not.toContain(SUBJECT);
  });

  it('offers a way back when the list could not be read', async () => {
    apiServes({ list: 'fails' });
    const page = await load(LIST);
    expect(page.html).toContain('could not be loaded');
    expect(page.html).toContain(LIST);
  });

  it('offers the next page when there is one', async () => {
    apiServes({ list: 'paged' });
    const page = await load(LIST);
    expect(page.html).toContain('Older tickets');
    expect(page.html).toContain(NEXT_CURSOR);
  });

  it('offers earlier messages when the conversation has them', async () => {
    apiServes({ thread: 'paged' });
    const page = await load(DETAIL_PATH);
    expect(page.html).toContain('Earlier messages');
    expect(page.html).toContain(NEXT_CURSOR);
  });

  it('shows the ticket even when its conversation could not be read', async () => {
    apiServes({ thread: 'fails' });
    const page = await load(DETAIL_PATH);
    expect(page.html).toContain(SUBJECT);
    expect(page.html).toContain('could not be loaded');
  });

  it('a closed ticket offers no reply and no second closure', async () => {
    apiServes({ ticket: 'closed' });
    const page = await load(DETAIL_PATH);
    expect(page.html).toContain('This ticket is closed');
    // The words of the closure control are not shipped at all for a closed ticket.
    expect(page.html).not.toContain('Close this ticket');
    expect(page.html).not.toContain('Yes, close it');
  });

  it('a live ticket offers the reply box and one closure control', async () => {
    const page = await load(DETAIL_PATH);
    expect(page.html).toContain('Add a message');
    expect(page.html).toContain('Close this ticket');
    // One control, one meaning: nothing here can record the agent's outcome.
    expect(page.html).not.toContain('Mark as resolved');
  });

  it('reads back the agent’s own outcome honestly when support resolved it', async () => {
    apiServes({ ticket: 'resolved' });
    const page = await load(DETAIL_PATH);
    expect(page.html).toContain('Resolved by support');
  });

  it('shows what a requester wrote and what support answered, each labelled by side', async () => {
    const page = await load(DETAIL_PATH);
    expect(page.html).toContain('You');
    expect(page.html).toContain('Support');
    expect(page.html).toContain('Conversation');
  });
});

describe('both languages', () => {
  it('renders the Arabic list right-to-left and in Arabic', async () => {
    const page = await load(`/ar${LIST}`);
    expect(page.status).toBe(200);
    expect(page.html).toContain('dir="rtl"');
    expect(page.html).toContain('lang="ar"');
    expect(page.html).toContain('الدعم');
  });

  it('renders the Arabic ticket right-to-left, with the same content rules', async () => {
    const page = await load(`/ar${DETAIL_PATH}`);
    expect(page.status).toBe(200);
    expect(page.html).toContain('dir="rtl"');
    expect(page.html).toContain(OWN_BODY);
    expect(page.html).not.toContain('support-attachments/');
  });

  it('keeps the Arabic pages out of search engines, like every signed-in surface', async () => {
    for (const path of [`/ar${LIST}`, `/ar${DETAIL_PATH}`, LIST, DETAIL_PATH]) {
      const response = await fetch(`${app.baseUrl}${path}`, { headers: { cookie: SESSION } });
      expect(response.headers.get('x-robots-tag'), path).toBe('noindex');
    }
  });

  it('offers support in the dashboard navigation of both languages', async () => {
    const english = await load(LIST);
    expect(english.html).toContain('/dashboard/support');
    const arabic = await load(`/ar${LIST}`);
    expect(arabic.html).toContain('/ar/dashboard/support');
  });
});

describe('the form a requester opens a ticket with', () => {
  it('ships the eight categories and no priority, status or assignee control', async () => {
    const page = await load(LIST);
    for (const label of [
      'My account',
      'An order',
      'A payment',
      'A payout',
      'A listing',
      'Verification',
      'Something is broken',
      'Something else',
    ]) {
      expect(page.html, label).toContain(label);
    }
    // `fetchPriority` is a Next.js preload attribute, so the check is for a field rather than the word.
    for (const word of ['name="priority"', 'urgent', 'assignedto', 'escalat', 'name="status"']) {
      expect(page.html.toLowerCase(), word).not.toContain(word.toLowerCase());
    }
  });

  it('warns against sending credentials, and asks for no field that could hold one', async () => {
    const page = await load(LIST);
    expect(page.html).toContain('Support will never ask you for them');
    // The form's own fields, by name. There is no card, code or password field anywhere in it.
    for (const field of ['name="card', 'name="cvv', 'name="otp', 'name="password']) {
      expect(page.html, field).not.toContain(field);
    }
  });
});
