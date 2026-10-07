import type { ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import arMessages from '../../messages/admin/ar.json';
import enMessages from '../../messages/admin/en.json';
import { startBuiltApp, type RunningApp } from '../support/next-server.js';
import { problem, startStubApi, type StubApi } from '../support/stub-api.js';

/**
 * Where the console is mounted (0108). Every address in this file is console-relative, exactly as it was while the
 * console was an application of its own; this is the one place that turns it into the address the server answers.
 */
const CONSOLE = '/admin';

/**
 * The support agent console's screens, over real HTTP against the built app (Phase 7-L).
 *
 * Run against the built app rather than a unit harness for the reason 7-F's shell test is: what matters is
 * what actually reaches a browser, **including the streamed RSC payload**.
 *
 * The cases this file exists for:
 *
 *   * **a guest, a buyer, a seller, staff at `aal1` and a moderator receive none of a ticket** — no subject,
 *     no message, no note, no requester name — in the markup or in the flight data;
 *   * **a colleague holding `support.ticket.read` and not `manage` sees the work and is offered no control
 *     that writes** — the words for claiming, replying, noting and deciding are not in the document;
 *   * **an internal note never reaches a screen that is not the console**, and the console's notes section is
 *     *absent* rather than empty when the API refuses it;
 *   * **no colleague is ever named** — the account of the agent holding a ticket appears nowhere, whatever
 *     the API sends;
 *   * **no storage path and no signed URL is ever rendered**;
 *   * both languages, the direction that goes with each, and every state: empty, refused, unavailable,
 *     unassigned, held by somebody else, resolved and closed.
 *
 * No browser, no Playwright, no live provider, no live storage, no deployment.
 */

const CANARY_CREDENTIAL = 'test-admin-support-canary-credential-notrea';

const EN = enMessages;
const AR = arMessages;

const ACCESS = '__Host-mp_admin_access=canary-admin-access-token-not-a-real-token';
const REFRESH = '__Host-mp_admin_refresh=canary-admin-refresh-token-not-a-real-tok';
const SESSION = `${ACCESS}; ${REFRESH}`;

const STAFF_ID = '11111111-1111-4111-8111-111111111111';
const TICKET = 'd5000000-0000-4000-8000-000000000001';
const MESSAGE = 'd5000000-0000-4000-8000-0000000000a1';
const NOTE = 'd5000000-0000-4000-8000-0000000000c1';
const ATTACHMENT = 'd5000000-0000-4000-8000-0000000000b1';

const READ = 'support.ticket.read';
const MANAGE = 'support.ticket.manage';

const SUBJECT = 'Canary ticket about a payout';
const REFERENCE = 'SP-26-004242';
const REQUESTER_NAME = 'Canary Requester';
const REQUESTER_BODY = 'Canary description of the payout problem.';
const AGENT_BODY = 'Canary reply from the support team.';
const NOTE_BODY = 'Canary internal note that no requester may read';
const FILE_NAME = 'canary-statement.pdf';

/** Values that must never render: a colleague's account, and a storage path. */
const OTHER_AGENT = '99999999-9999-4999-8999-999999999999';
const OBJECT_PATH = `support-attachments/${TICKET}/${MESSAGE}/f47ac10b-58cc-4372-a567-0e02b2c3d479.pdf`;

/** A moderator: neither support key. */
const MODERATOR_PERMISSIONS = [
  'catalog.listing.read',
  'moderation.report.read',
  'reviews.review.read',
  'sellers.profile.read',
  'users.profile.read',
];
/** A colleague who may follow a ticket and change nothing. */
const READ_ONLY_PERMISSIONS = [...MODERATOR_PERMISSIONS, READ].sort();
/** A support agent, as 0033 grants it. */
const AGENT_PERMISSIONS = [...MODERATOR_PERMISSIONS, READ, MANAGE].sort();

const QUEUE_ITEM = {
  id: TICKET,
  reference: REFERENCE,
  subject: SUBJECT,
  category: 'payouts',
  priority: 'urgent',
  status: 'pending_agent',
  requesterName: REQUESTER_NAME,
  messageCount: 2,
  attachmentCount: 1,
  noteCount: 1,
  lastMessageAt: '2026-05-02T09:00:00.000Z',
  createdAt: '2026-05-01T09:00:00.000Z',
};

const ASSIGNED_ITEM = { ...QUEUE_ITEM, resolvedAt: null, closedAt: null };

const TICKET_ROW = {
  id: TICKET,
  reference: REFERENCE,
  subject: SUBJECT,
  category: 'payouts',
  priority: 'urgent',
  status: 'pending_agent',
  requesterName: REQUESTER_NAME,
  isMine: true,
  isAssigned: true,
  messageCount: 2,
  noteCount: 1,
  firstResponseAt: null,
  lastMessageAt: '2026-05-02T09:00:00.000Z',
  resolvedAt: null,
  closedAt: null,
  createdAt: '2026-05-01T09:00:00.000Z',
};

const MESSAGES = [
  {
    id: MESSAGE,
    authorRole: 'requester',
    isOwnMessage: false,
    body: REQUESTER_BODY,
    createdAt: '2026-05-01T09:00:00.000Z',
    attachments: [
      {
        id: ATTACHMENT,
        originalFilename: FILE_NAME,
        contentType: 'application/pdf',
        byteSize: '20480',
      },
    ],
  },
  {
    id: 'd5000000-0000-4000-8000-0000000000a2',
    authorRole: 'agent',
    isOwnMessage: true,
    body: AGENT_BODY,
    createdAt: '2026-05-02T09:00:00.000Z',
    attachments: [],
  },
];

const NOTES = [
  { id: NOTE, isOwnNote: true, body: NOTE_BODY, createdAt: '2026-05-02T09:30:00.000Z' },
];

type Who =
  | { kind: 'staff'; permissions: readonly string[]; locale?: 'en' | 'ar' }
  | { kind: 'staff-aal1' }
  | { kind: 'buyer' }
  | { kind: 'unauthenticated' };

interface Serve {
  readonly who: Who;
  /** What the ticket, queue and conversation operations answer. */
  readonly data?: 'ok' | 'notFound' | 'unavailable' | 'empty' | 'paged' | 'unassigned' | 'resolved' | 'closed' | 'leaky';
  /** What the notes operation answers. Defaults to following the caller's permissions. */
  readonly notes?: 'ok' | 'notFound' | 'empty';
}

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

function ticketFor(mode: Serve['data']): unknown {
  if (mode === 'unassigned') {
    return { ticket: { ...TICKET_ROW, isMine: false, isAssigned: false } };
  }
  if (mode === 'resolved') {
    return {
      ticket: { ...TICKET_ROW, status: 'resolved', resolvedAt: '2026-05-03T09:00:00.000Z' },
    };
  }
  if (mode === 'closed') {
    return {
      ticket: {
        ...TICKET_ROW,
        status: 'closed',
        resolvedAt: '2026-05-03T09:00:00.000Z',
        closedAt: '2026-05-04T09:00:00.000Z',
      },
    };
  }
  if (mode === 'leaky') {
    // An API that has drifted and sends an assignee. The contract is the wall: it must not render.
    return { ticket: { ...TICKET_ROW, assignedTo: OTHER_AGENT } };
  }
  return { ticket: TICKET_ROW };
}

function apiServes(serve: Serve): void {
  api.seen.length = 0;
  api.reply((request, response) => {
    const [path] = request.url.split('?');
    const who = serve.who;

    if (path === '/v1/admin/session') {
      if (who.kind === 'unauthenticated') return problem(response, 401, 'AUTHENTICATION_REQUIRED');
      const base = {
        id: STAFF_ID,
        displayName: 'Nadia',
        localeCode: who.kind === 'staff' ? (who.locale ?? 'en') : 'en',
      };
      if (who.kind === 'buyer') {
        return json(response, {
          session: { ...base, isStaff: false, requiresStepUp: false, roles: [], permissions: [] },
        });
      }
      if (who.kind === 'staff-aal1') {
        return json(response, {
          session: { ...base, isStaff: true, requiresStepUp: true, roles: [], permissions: [] },
        });
      }
      return json(response, {
        session: {
          ...base,
          isStaff: true,
          requiresStepUp: false,
          roles: ['support_agent'],
          permissions: who.permissions,
        },
      });
    }

    // The notes operation, which the real API refuses without the read key. Modelled the same way here.
    if (path === `/v1/admin/support/tickets/${TICKET}/notes`) {
      const held = who.kind === 'staff' && who.permissions.includes(READ);
      const mode = serve.notes ?? (held ? 'ok' : 'notFound');
      if (mode === 'notFound') return problem(response, 404, 'NOT_FOUND');
      if (mode === 'empty') return json(response, { items: [], nextCursor: null });
      return json(response, { items: NOTES, nextCursor: null });
    }

    if (path?.startsWith('/v1/admin/support')) {
      if (serve.data === 'notFound') return problem(response, 404, 'NOT_FOUND');
      if (serve.data === 'unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');

      if (path === '/v1/admin/support/queue' || path === '/v1/admin/support/assigned') {
        if (serve.data === 'empty') return json(response, { items: [], nextCursor: null });
        const item = path.endsWith('assigned') ? ASSIGNED_ITEM : QUEUE_ITEM;
        if (serve.data === 'paged') {
          return json(response, { items: [item], nextCursor: 'c3ExfGNhbmFyeQ' });
        }
        return json(response, { items: [item], nextCursor: null });
      }
      if (path === `/v1/admin/support/tickets/${TICKET}/messages`) {
        if (serve.data === 'leaky') {
          return json(response, {
            items: [{ ...MESSAGES[0]!, authorUserId: OTHER_AGENT, objectPath: OBJECT_PATH }],
            nextCursor: null,
          });
        }
        return json(response, { items: MESSAGES, nextCursor: null });
      }
      if (path === `/v1/admin/support/tickets/${TICKET}`) return json(response, ticketFor(serve.data));
      return problem(response, 404, 'NOT_FOUND');
    }

    return problem(response, 404, 'NOT_FOUND');
  });
}

async function get(path: string, cookie = SESSION): Promise<{ status: number; html: string }> {
  const response = await fetch(`${app.baseUrl}${CONSOLE}${path}`, {
    redirect: 'manual',
    headers: cookie === '' ? {} : { cookie },
  });
  return { status: response.status, html: await response.text() };
}

const QUEUE_PAGE = '/support';
const TICKET_PAGE = `/support/${TICKET}`;
const BOTH = [QUEUE_PAGE, TICKET_PAGE];

/** Everything a refused response must not contain, in markup or flight data. */
const SECRETS = [SUBJECT, REFERENCE, REQUESTER_NAME, REQUESTER_BODY, AGENT_BODY, NOTE_BODY, FILE_NAME];

/* ------------------------------------------------------------------------------------------------ */

describe('who is refused', () => {
  it('a guest with no cookie receives none of either screen, and no read is performed', async () => {
    apiServes({ who: { kind: 'unauthenticated' } });
    for (const path of BOTH) {
      const { status, html } = await get(path, '');
      expect(status, path).toBe(200);
      expect(html, path).toContain(EN.Console.signedOutTitle);
      for (const secret of SECRETS) expect(html, `${path} :: ${secret}`).not.toContain(secret);
    }
    expect(api.seen.filter((request) => request.url.includes('/support'))).toHaveLength(0);
  });

  it('a buyer, a seller and staff at aal1 receive none of either screen', async () => {
    for (const who of [
      { kind: 'buyer' } as const,
      { kind: 'staff-aal1' } as const,
      { kind: 'staff', permissions: [] } as const,
    ]) {
      apiServes({ who });
      for (const path of BOTH) {
        const { html } = await get(path);
        for (const secret of SECRETS) expect(html, `${path} :: ${secret}`).not.toContain(secret);
        expect(api.seen.filter((request) => request.url.includes('/v1/admin/support'))).toHaveLength(0);
      }
    }
  });

  it('a moderator receives none of either screen, and no support read is performed', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR_PERMISSIONS } });
    for (const path of BOTH) {
      const { html } = await get(path);
      expect(html, path).toContain(EN.Console.forbiddenTitle);
      for (const secret of SECRETS) expect(html, `${path} :: ${secret}`).not.toContain(secret);
    }
    expect(api.seen.filter((request) => request.url.includes('/v1/admin/support'))).toHaveLength(0);
  });

  it('a ticket a colleague holds reads exactly like one that does not exist', async () => {
    apiServes({ who: { kind: 'staff', permissions: AGENT_PERMISSIONS }, data: 'notFound' });
    const { status, html } = await get(TICKET_PAGE);
    expect(status).toBe(200);
    expect(html).toContain(EN.SupportConsole.notFoundTitle);
    for (const secret of SECRETS) expect(html, secret).not.toContain(secret);
  });

  it('a malformed identifier is an address with nothing at it', async () => {
    apiServes({ who: { kind: 'staff', permissions: AGENT_PERMISSIONS } });
    const { status, html } = await get('/support/not-a-uuid');
    expect(status).toBe(200);
    expect(html).toContain(EN.SupportConsole.notFoundTitle);
    expect(html).not.toContain(SUBJECT);
  });
});

describe('what an agent sees', () => {
  it('renders both lists with the ticket’s own facts', async () => {
    apiServes({ who: { kind: 'staff', permissions: AGENT_PERMISSIONS } });
    const { status, html } = await get(QUEUE_PAGE);

    expect(status).toBe(200);
    expect(html).toContain(EN.SupportConsole.queueHeading);
    expect(html).toContain(EN.SupportConsole.assignedHeading);
    expect(html).toContain(SUBJECT);
    expect(html).toContain(REFERENCE);
    expect(html).toContain(REQUESTER_NAME);
    // Priority is shown as a fact. It is not an ordering, and no ranking is claimed anywhere.
    expect(html).toContain(EN.SupportConsole.priority.urgent);
  });

  it('renders the ticket, its conversation, its files and its notes', async () => {
    apiServes({ who: { kind: 'staff', permissions: AGENT_PERMISSIONS } });
    const { status, html } = await get(TICKET_PAGE);

    expect(status).toBe(200);
    expect(html).toContain(SUBJECT);
    expect(html).toContain(REQUESTER_BODY);
    expect(html).toContain(AGENT_BODY);
    expect(html).toContain(FILE_NAME);
    expect(html).toContain(EN.SupportConsole.notesHeading);
    expect(html).toContain(NOTE_BODY);
    expect(html).toContain(EN.SupportConsole.heldByYou);
  });

  it('offers the four controls on a ticket the agent holds', async () => {
    apiServes({ who: { kind: 'staff', permissions: AGENT_PERMISSIONS } });
    const { html } = await get(TICKET_PAGE);
    expect(html).toContain(EN.SupportConsole.releaseAction);
    expect(html).toContain(EN.SupportConsole.replyLabel);
    expect(html).toContain(EN.SupportConsole.noteLabel);
    expect(html).toContain(EN.SupportConsole.decisionHeading);
    expect(html).toContain(EN.SupportConsole.resolveAction);
    expect(html).toContain(EN.SupportConsole.closeQuestion);
    // Not this one: the ticket is already theirs.
    expect(html).not.toContain(EN.SupportConsole.claimAction);
  });

  it('offers only the claim on a ticket nobody holds', async () => {
    apiServes({ who: { kind: 'staff', permissions: AGENT_PERMISSIONS }, data: 'unassigned' });
    const { html } = await get(TICKET_PAGE);
    expect(html).toContain(EN.SupportConsole.unassigned);
    expect(html).toContain(EN.SupportConsole.claimAction);
    // Nothing that writes to the ticket is shipped until it is claimed — the API would refuse it anyway.
    expect(html).not.toContain(EN.SupportConsole.replyLabel);
    expect(html).not.toContain(EN.SupportConsole.noteLabel);
    expect(html).not.toContain(EN.SupportConsole.resolveAction);
    expect(html).not.toContain(EN.SupportConsole.releaseAction);
  });

  it('ships neither the resolve control nor its words on an already resolved ticket', async () => {
    apiServes({ who: { kind: 'staff', permissions: AGENT_PERMISSIONS }, data: 'resolved' });
    const { html } = await get(TICKET_PAGE);
    expect(html).toContain(EN.SupportConsole.status.resolved);
    // Still finishable: a resolved ticket can be closed. But not resolved twice — and the words for the control
    // that is not there are not in the payload either, which is why `resolve` is nullable rather than paired
    // with a boolean.
    expect(html).toContain(EN.SupportConsole.decisionHeading);
    expect(html).toContain(EN.SupportConsole.closeQuestion);
    expect(html).not.toContain(EN.SupportConsole.resolveAction);
    expect(html).not.toContain(EN.SupportConsole.resolveQuestion);
  });

  it('offers nothing at all on a closed ticket, and says why', async () => {
    apiServes({ who: { kind: 'staff', permissions: AGENT_PERMISSIONS }, data: 'closed' });
    const { html } = await get(TICKET_PAGE);
    expect(html).toContain(EN.SupportConsole.closedHint);
    // `closeAction` is the bare word "Close", which the status badge for a closed ticket contains; the decision
    // section's own words are the ones that say whether the control is there.
    for (const word of [
      EN.SupportConsole.claimAction,
      EN.SupportConsole.releaseAction,
      EN.SupportConsole.replyLabel,
      EN.SupportConsole.noteLabel,
      EN.SupportConsole.decisionHeading,
      EN.SupportConsole.resolveAction,
      EN.SupportConsole.closeQuestion,
    ]) {
      expect(html, word).not.toContain(word);
    }
  });

  it('has no route that would reopen a ticket, and says a ticket cannot be reopened', async () => {
    apiServes({ who: { kind: 'staff', permissions: AGENT_PERMISSIONS } });
    const { html } = await get(TICKET_PAGE);
    // The copy says it plainly, so the word itself is expected here; what must not exist is a way to do it.
    expect(html).toContain(EN.SupportConsole.decisionHint);
    expect(html).not.toContain('/api/support/reopen');

    const reopen = await fetch(`${app.baseUrl}${CONSOLE}/api/support/reopen`, {
      method: 'POST',
      headers: { cookie: SESSION, 'content-type': 'application/json', origin: app.baseUrl },
      body: JSON.stringify({ ticketId: TICKET }),
    });
    expect(reopen.ok).toBe(false);
  });
});

describe('what a read-only colleague sees', () => {
  it('reads the work and is offered no control that writes', async () => {
    apiServes({ who: { kind: 'staff', permissions: READ_ONLY_PERMISSIONS } });
    const list = await get(QUEUE_PAGE);
    expect(list.status).toBe(200);
    expect(list.html).toContain(SUBJECT);

    const ticket = await get(TICKET_PAGE);
    expect(ticket.html).toContain(REQUESTER_BODY);
    expect(ticket.html).toContain(NOTE_BODY);
  });

  it('is offered the controls only where the ticket is theirs, which read alone cannot make it', async () => {
    // A read-only colleague can only ever see a ticket as unassigned or as somebody else's; the API refuses
    // the writes either way, and the page ships the words for none of them on an unassigned ticket.
    apiServes({ who: { kind: 'staff', permissions: READ_ONLY_PERMISSIONS }, data: 'unassigned' });
    const { html } = await get(TICKET_PAGE);
    expect(html).not.toContain(EN.SupportConsole.replyLabel);
    expect(html).not.toContain(EN.SupportConsole.noteLabel);
    expect(html).not.toContain(EN.SupportConsole.resolveAction);
  });
});

describe('what no screen ever contains', () => {
  it('never names the colleague holding a ticket, even from a drifted API', async () => {
    apiServes({ who: { kind: 'staff', permissions: AGENT_PERMISSIONS }, data: 'leaky' });
    const { html } = await get(TICKET_PAGE);
    expect(html).not.toContain(OTHER_AGENT);
    expect(html).not.toContain('assignedTo');
    expect(html).not.toContain('authorUserId');
  });

  it('never renders a storage path or a signed URL', async () => {
    apiServes({ who: { kind: 'staff', permissions: AGENT_PERMISSIONS } });
    for (const path of BOTH) {
      const { html } = await get(path);
      expect(html, path).not.toContain('support-attachments/');
      expect(html, path).not.toContain('objectPath');
      expect(html, path).not.toContain(OBJECT_PATH);
    }
  });

  it('never renders a permission key, a role or the API address', async () => {
    apiServes({ who: { kind: 'staff', permissions: AGENT_PERMISSIONS } });
    for (const path of BOTH) {
      const { html } = await get(path);
      expect(html, path).not.toContain('support.ticket.read');
      expect(html, path).not.toContain('support.ticket.manage');
      expect(html, path).not.toContain(api.baseUrl);
      expect(html, path).not.toContain(CANARY_CREDENTIAL);
      expect(html, path).not.toContain('canary-admin-access-token');
    }
  });

  it('renders no notes section at all when the API refuses that read', async () => {
    apiServes({ who: { kind: 'staff', permissions: AGENT_PERMISSIONS }, notes: 'notFound' });
    const { html } = await get(TICKET_PAGE);
    // Absent, not empty: an empty heading would itself say there was something being withheld.
    expect(html).not.toContain(EN.SupportConsole.notesHeading);
    expect(html).not.toContain(NOTE_BODY);
    // The rest of the ticket is still there.
    expect(html).toContain(REQUESTER_BODY);
  });

  it('says so plainly when there are no notes', async () => {
    apiServes({ who: { kind: 'staff', permissions: AGENT_PERMISSIONS }, notes: 'empty' });
    const { html } = await get(TICKET_PAGE);
    expect(html).toContain(EN.SupportConsole.notesHeading);
    expect(html).toContain(EN.SupportConsole.notesEmpty);
  });

  it('sends no write of any kind while rendering either screen', async () => {
    apiServes({ who: { kind: 'staff', permissions: AGENT_PERMISSIONS } });
    for (const path of BOTH) await get(path);
    expect(api.seen.length).toBeGreaterThan(0);
    for (const request of api.seen) {
      expect(request.method, request.url).toBe('GET');
      expect(request.body, request.url).toBe('');
    }
  });
});

describe('the states each screen has', () => {
  it('says so when the queue and the agent’s own list are empty', async () => {
    apiServes({ who: { kind: 'staff', permissions: AGENT_PERMISSIONS }, data: 'empty' });
    const { html } = await get(QUEUE_PAGE);
    expect(html).toContain(EN.SupportConsole.queueEmptyTitle);
    expect(html).toContain(EN.SupportConsole.assignedEmptyTitle);
    expect(html).not.toContain(SUBJECT);
  });

  it('offers the next page when there is one, per list', async () => {
    apiServes({ who: { kind: 'staff', permissions: AGENT_PERMISSIONS }, data: 'paged' });
    const { html } = await get(QUEUE_PAGE);
    expect(html).toContain(EN.SupportConsole.nextPage);
    expect(html).toContain('cursor=c3ExfGNhbmFyeQ');
    expect(html).toContain('mine=c3ExfGNhbmFyeQ');
  });

  it('says so when a read could not be performed', async () => {
    apiServes({ who: { kind: 'staff', permissions: AGENT_PERMISSIONS }, data: 'unavailable' });
    for (const path of BOTH) {
      const { html } = await get(path);
      expect(html, path).toContain(EN.Console.unavailableTitle);
      for (const secret of SECRETS) expect(html, `${path} :: ${secret}`).not.toContain(secret);
    }
  });
});

describe('both languages', () => {
  it('renders the console in Arabic, mirrored', async () => {
    apiServes({ who: { kind: 'staff', permissions: AGENT_PERMISSIONS, locale: 'ar' } });
    const { status, html } = await get(QUEUE_PAGE);

    expect(status).toBe(200);
    expect(html).toContain('<html lang="ar" dir="rtl">');
    expect(html).toContain(AR.SupportConsole.queueHeading);
    expect(html).toContain(AR.SupportConsole.assignedHeading);
  });

  it('renders a ticket in Arabic, with the same content rules', async () => {
    apiServes({ who: { kind: 'staff', permissions: AGENT_PERMISSIONS, locale: 'ar' } });
    const { html } = await get(TICKET_PAGE);

    expect(html).toContain('<html lang="ar" dir="rtl">');
    expect(html).toContain(AR.SupportConsole.notesHeading);
    expect(html).toContain(AR.SupportConsole.replyLabel);
    expect(html).toContain(REQUESTER_BODY);
    expect(html).not.toContain('support-attachments/');
    expect(html).not.toContain(OTHER_AGENT);
  });

  it('keeps every console page out of search engines', async () => {
    apiServes({ who: { kind: 'staff', permissions: AGENT_PERMISSIONS } });
    for (const path of BOTH) {
      const { html } = await get(path);
      expect(html, path).toContain('name="robots"');
      expect(html, path).toContain('noindex');
    }
  });
});
