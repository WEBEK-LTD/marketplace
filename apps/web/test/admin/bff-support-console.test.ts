import { describe, expect, it } from 'vitest';
import {
  handleSupportAttachmentLink,
  handleSupportClaim,
  handleSupportDecision,
  handleSupportNote,
  handleSupportReply,
  handleSupportRelease,
  readSupportAssigned,
  readSupportConsoleMessages,
  readSupportConsoleTicket,
  readSupportInternalNotes,
  readSupportQueue,
} from '../../src/admin/server/bff/support-console';

/**
 * The support agent console's BFF, on the admin origin (Phase 7-L).
 *
 * What matters at this boundary:
 *
 *   * the caller's token comes from `__Host-mp_admin_access` and never from a body, and the browser's own
 *     `Cookie` header is never forwarded upstream;
 *   * **bodies are rebuilt, never forwarded** — an `agentUserId`, an `authorRole`, a `priority`, a `reason` or
 *     an `assignedTo` sent by a screen is dropped before anything leaves this origin;
 *   * **claiming and releasing send no body at all**, so one colleague cannot be assigned by another;
 *   * **the decision carries one status out of two**, and every other value is refused here;
 *   * **answers are validated against the contract**, so an assignee, an author identifier or a storage path a
 *     drifted API sent could not reach a screen;
 *   * every write refuses a cross-site request before it reads anything else;
 *   * a refused read and an unavailable one stay distinct, and a refusal is never rendered as data.
 */

const ENV = Object.freeze({
  API_BASE_URL: 'https://api.internal.test',
  INTERNAL_BFF_CREDENTIAL: 'test-current-credential-value-not-a-real-se',
});

const SESSION_TOKEN = 'console-canary-admin-token-not-a-real-token';
const COOKIE = `__Host-mp_admin_access=${SESSION_TOKEN}`;

const TICKET = 'd5000000-0000-4000-8000-000000000001';
const MESSAGE = 'd5000000-0000-4000-8000-0000000000a1';
const NOTE = 'd5000000-0000-4000-8000-0000000000c1';
const ATTACHMENT = 'd5000000-0000-4000-8000-0000000000b1';
const OBJECT_PATH = `support-attachments/${TICKET}/${MESSAGE}/f47ac10b-58cc-4372-a567-0e02b2c3d479.png`;
const OTHER_AGENT = '99999999-9999-4999-8999-999999999999';

const QUEUE_ITEM = {
  id: TICKET,
  reference: 'SP-26-000001',
  subject: 'A payout has not arrived',
  category: 'payouts',
  priority: 'normal',
  status: 'pending_agent',
  requesterName: 'Canary Requester',
  messageCount: 2,
  attachmentCount: 1,
  noteCount: 1,
  lastMessageAt: '2026-05-02T09:00:00.000Z',
  createdAt: '2026-05-01T09:00:00.000Z',
};

const ASSIGNED_ITEM = { ...QUEUE_ITEM, resolvedAt: null, closedAt: null };

/**
 * One ticket, as the API answers it.
 *
 * Deliberately **not** spread from the queue row: the ticket contract has no `attachmentCount`, and a
 * fixture that carried one would be a drifted answer — which this module is supposed to refuse.
 */
const TICKET_ROW = {
  id: TICKET,
  reference: 'SP-26-000001',
  subject: 'A payout has not arrived',
  category: 'payouts',
  priority: 'normal',
  status: 'pending_agent',
  requesterName: 'Canary Requester',
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

const MESSAGE_ROW = {
  id: MESSAGE,
  authorRole: 'requester',
  isOwnMessage: false,
  body: 'The payout has not arrived.',
  createdAt: '2026-05-01T09:00:00.000Z',
  attachments: [
    {
      id: ATTACHMENT,
      originalFilename: 'statement.pdf',
      contentType: 'application/pdf',
      byteSize: '20480',
    },
  ],
};

const NOTE_ROW = {
  id: NOTE,
  isOwnNote: true,
  body: 'Two failed payout attempts on file.',
  createdAt: '2026-05-02T09:00:00.000Z',
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
      headers: { 'content-type': status < 400 ? 'application/json' : 'application/problem+json' },
    });
  }) as unknown as typeof fetch;
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://admin.test${path}`, {
    method: 'POST',
    headers: {
      origin: 'https://admin.test',
      'content-type': 'application/json',
      cookie: COOKIE,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://admin.test${path}`, {
    method: 'GET',
    headers: { cookie: COOKIE, ...headers },
  });
}

/* ------------------------------------------------------------------------------------------------ */

describe('the five reads', () => {
  it('presents the caller’s token and the internal credential, and never the browser cookie', async () => {
    const seen: Seen[] = [];
    await readSupportQueue(
      {},
      { env: ENV, cookieHeader: COOKIE, fetch: api(200, { items: [QUEUE_ITEM], nextCursor: null }, seen) },
    );

    expect(seen[0]!.url).toBe('https://api.internal.test/v1/admin/support/queue');
    expect(seen[0]!.method).toBe('GET');
    expect(seen[0]!.headers.get('x-session-token')).toBe(SESSION_TOKEN);
    expect(seen[0]!.headers.get('x-internal-credential')).toBe(ENV.INTERNAL_BFF_CREDENTIAL);
    expect(seen[0]!.headers.get('cookie')).toBeNull();
  });

  it('reads the queue and the caller’s own list through two operations', async () => {
    const seen: Seen[] = [];
    const empty = { items: [], nextCursor: null };
    await readSupportQueue({}, { env: ENV, cookieHeader: COOKIE, fetch: api(200, empty, seen) });
    await readSupportAssigned({}, { env: ENV, cookieHeader: COOKIE, fetch: api(200, empty, seen) });

    expect(seen[0]!.url).toBe('https://api.internal.test/v1/admin/support/queue');
    expect(seen[1]!.url).toBe('https://api.internal.test/v1/admin/support/assigned');
    for (const request of seen) {
      expect(request.url).not.toContain('assignedTo');
      expect(request.url).not.toContain('userId');
      expect(request.url).not.toContain('permission');
    }
  });

  it('accepts the outcome timestamps on the caller’s own list, and refuses them on the queue', async () => {
    // The two lists are two contracts on purpose: a ticket in the shared queue has not been resolved or closed,
    // so there is no place in that schema for the two timestamps that say it was. The caller's own list holds
    // tickets at any status, and carries them.
    const own = await readSupportAssigned(
      {},
      {
        env: ENV,
        cookieHeader: COOKIE,
        fetch: api(200, { items: [{ ...ASSIGNED_ITEM, resolvedAt: '2026-05-03T09:00:00.000Z' }], nextCursor: null }),
      },
    );
    expect(own.kind).toBe('ok');
    expect(own.kind === 'ok' ? own.data.items[0]!.resolvedAt : null).toBe('2026-05-03T09:00:00.000Z');

    const queue = await readSupportQueue(
      {},
      {
        env: ENV,
        cookieHeader: COOKIE,
        fetch: api(200, { items: [ASSIGNED_ITEM], nextCursor: null }),
      },
    );
    expect(queue.kind).toBe('unavailable');
  });

  it('reads a ticket, its conversation and its notes by identifier, lower-cased', async () => {
    const seen: Seen[] = [];
    await readSupportConsoleTicket(TICKET.toUpperCase(), {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: api(200, { ticket: TICKET_ROW }, seen),
    });
    await readSupportConsoleMessages(
      TICKET.toUpperCase(),
      {},
      { env: ENV, cookieHeader: COOKIE, fetch: api(200, { items: [MESSAGE_ROW], nextCursor: null }, seen) },
    );
    await readSupportInternalNotes(
      TICKET.toUpperCase(),
      {},
      { env: ENV, cookieHeader: COOKIE, fetch: api(200, { items: [NOTE_ROW], nextCursor: null }, seen) },
    );

    expect(seen[0]!.url).toBe(`https://api.internal.test/v1/admin/support/tickets/${TICKET}`);
    expect(seen[1]!.url).toBe(`https://api.internal.test/v1/admin/support/tickets/${TICKET}/messages`);
    expect(seen[2]!.url).toBe(`https://api.internal.test/v1/admin/support/tickets/${TICKET}/notes`);
  });

  it('passes a cursor through verbatim and refuses one that is not a cursor', async () => {
    const seen: Seen[] = [];
    await readSupportQueue(
      { cursor: 'c3ExfGNhbmFyeQ', limit: '25' },
      { env: ENV, cookieHeader: COOKIE, fetch: api(200, { items: [], nextCursor: null }, seen) },
    );
    expect(seen[0]!.url).toContain('cursor=c3ExfGNhbmFyeQ');
    expect(seen[0]!.url).toContain('limit=25');

    await readSupportQueue(
      { cursor: "'; drop table public.support_tickets; --", limit: 'abc' },
      { env: ENV, cookieHeader: COOKIE, fetch: api(200, { items: [], nextCursor: null }, seen) },
    );
    expect(seen[1]!.url).toBe('https://api.internal.test/v1/admin/support/queue');
  });

  it('never reaches the API without a session cookie', async () => {
    const seen: Seen[] = [];
    for (const read of [
      () => readSupportQueue({}, { env: ENV, cookieHeader: null, fetch: api(200, {}, seen) }),
      () => readSupportAssigned({}, { env: ENV, cookieHeader: null, fetch: api(200, {}, seen) }),
      () => readSupportConsoleTicket(TICKET, { env: ENV, cookieHeader: null, fetch: api(200, {}, seen) }),
      () =>
        readSupportConsoleMessages(TICKET, {}, { env: ENV, cookieHeader: null, fetch: api(200, {}, seen) }),
      () => readSupportInternalNotes(TICKET, {}, { env: ENV, cookieHeader: null, fetch: api(200, {}, seen) }),
    ]) {
      expect((await read()).kind).toBe('unauthenticated');
    }
    expect(seen).toHaveLength(0);
  });

  it('answers not-found for an identifier that is not one, without asking', async () => {
    const seen: Seen[] = [];
    expect(
      (await readSupportConsoleTicket('nope', { env: ENV, cookieHeader: COOKIE, fetch: api(200, {}, seen) }))
        .kind,
    ).toBe('notFound');
    expect(
      (
        await readSupportConsoleMessages(
          'nope',
          {},
          { env: ENV, cookieHeader: COOKIE, fetch: api(200, {}, seen) },
        )
      ).kind,
    ).toBe('notFound');
    expect(
      (
        await readSupportInternalNotes(
          'nope',
          {},
          { env: ENV, cookieHeader: COOKIE, fetch: api(200, {}, seen) },
        )
      ).kind,
    ).toBe('notFound');
    expect(seen).toHaveLength(0);
  });

  it('keeps the four refusals apart', async () => {
    for (const [status, kind] of [
      [401, 'unauthenticated'],
      [404, 'notFound'],
      [400, 'invalid'],
      [503, 'unavailable'],
    ] as const) {
      const result = await readSupportQueue(
        {},
        { env: ENV, cookieHeader: COOKIE, fetch: api(status, { status, code: 'X' }) },
      );
      expect(result.kind, String(status)).toBe(kind);
    }
  });

  it('refuses an answer that carries an assignee, an author or a path', async () => {
    const drifted: Array<[() => Promise<{ kind: string }>, string]> = [
      [
        () =>
          readSupportQueue(
            {},
            {
              env: ENV,
              cookieHeader: COOKIE,
              fetch: api(200, { items: [{ ...QUEUE_ITEM, assignedTo: OTHER_AGENT }], nextCursor: null }),
            },
          ),
        'queue with an assignee',
      ],
      [
        () =>
          readSupportConsoleTicket(TICKET, {
            env: ENV,
            cookieHeader: COOKIE,
            fetch: api(200, { ticket: { ...TICKET_ROW, assignedTo: OTHER_AGENT } }),
          }),
        'ticket with an assignee',
      ],
      [
        () =>
          readSupportConsoleMessages(
            TICKET,
            {},
            {
              env: ENV,
              cookieHeader: COOKIE,
              fetch: api(200, {
                items: [{ ...MESSAGE_ROW, authorUserId: OTHER_AGENT }],
                nextCursor: null,
              }),
            },
          ),
        'message with an author',
      ],
      [
        () =>
          readSupportConsoleMessages(
            TICKET,
            {},
            {
              env: ENV,
              cookieHeader: COOKIE,
              fetch: api(200, {
                items: [{ ...MESSAGE_ROW, attachments: [{ id: ATTACHMENT, objectPath: OBJECT_PATH }] }],
                nextCursor: null,
              }),
            },
          ),
        'attachment with a path',
      ],
      [
        () =>
          readSupportInternalNotes(
            TICKET,
            {},
            {
              env: ENV,
              cookieHeader: COOKIE,
              fetch: api(200, { items: [{ ...NOTE_ROW, authorUserId: OTHER_AGENT }], nextCursor: null }),
            },
          ),
        'note with an author',
      ],
    ];

    for (const [read, name] of drifted) {
      expect((await read()).kind, name).toBe('unavailable');
    }
  });

  it('returns the contract’s own objects, so nothing extra can travel even by accident', async () => {
    const ticket = await readSupportConsoleTicket(TICKET, {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: api(200, { ticket: TICKET_ROW }),
    });
    expect(ticket.kind).toBe('ok');
    if (ticket.kind !== 'ok') return;
    expect(Object.keys(ticket.data)).not.toContain('assignedTo');
    expect(Object.keys(ticket.data)).toContain('isMine');

    const notes = await readSupportInternalNotes(
      TICKET,
      {},
      { env: ENV, cookieHeader: COOKIE, fetch: api(200, { items: [NOTE_ROW], nextCursor: null }) },
    );
    expect(notes.kind).toBe('ok');
    if (notes.kind !== 'ok') return;
    expect(Object.keys(notes.data.items[0]!).sort()).toEqual(['body', 'createdAt', 'id', 'isOwnNote']);
  });
});

describe('claiming and releasing', () => {
  it('sends no body at all, and drops an agent a screen tried to name', async () => {
    for (const [handler, step] of [
      [handleSupportClaim, 'claim'],
      [handleSupportRelease, 'release'],
    ] as const) {
      const seen: Seen[] = [];
      const response = await handler(
        post(`/api/support/${step}`, { ticketId: TICKET, agentUserId: OTHER_AGENT, assignedTo: OTHER_AGENT }),
        { env: ENV, fetch: api(200, { status: 'pending_agent', isMine: step === 'claim' }, seen) },
      );

      expect(response.status, step).toBe(200);
      expect(seen[0]!.url).toBe(
        `https://api.internal.test/v1/admin/support/tickets/${TICKET}/${step}`,
      );
      expect(seen[0]!.body, step).toBe('');
      expect(seen[0]!.headers.get('content-type')).toBeNull();
    }
  });

  it('refuses a malformed or missing ticket identifier without asking', async () => {
    const seen: Seen[] = [];
    for (const body of [{ ticketId: 'nope' }, {}, { ticketId: 42 }]) {
      const response = await handleSupportClaim(post('/api/support/claim', body), {
        env: ENV,
        fetch: api(200, {}, seen),
      });
      expect(response.status).toBe(400);
    }
    expect(seen).toHaveLength(0);
  });

  it('forwards the API’s own refusals so a screen can say what happened', async () => {
    for (const [status, code] of [
      [404, 'NOT_FOUND'],
      [409, 'SUPPORT_TICKET_NOT_WORKABLE'],
    ] as const) {
      const response = await handleSupportClaim(post('/api/support/claim', { ticketId: TICKET }), {
        env: ENV,
        fetch: api(status, { status, code }),
      });
      expect(response.status).toBe(status);
      expect((await response.json())['code']).toBe(code);
    }
  });

  it('refuses both cross-site, before reading a body or a cookie', async () => {
    const seen: Seen[] = [];
    for (const handler of [handleSupportClaim, handleSupportRelease]) {
      const response = await handler(
        post('/api/support/x', { ticketId: TICKET }, { origin: 'https://evil.test' }),
        { env: ENV, fetch: api(200, {}, seen) },
      );
      expect(response.status).toBe(403);
    }
    expect(seen).toHaveLength(0);
  });

  it('turns an unexpected upstream status into a plain 503', async () => {
    const response = await handleSupportClaim(post('/api/support/claim', { ticketId: TICKET }), {
      env: ENV,
      fetch: api(418, { teapot: true }),
    });
    expect(response.status).toBe(503);
  });
});

describe('replying and noting', () => {
  it('sends exactly one field on each, dropping the rest', async () => {
    for (const [handler, path, expected, extra] of [
      [handleSupportReply, 'messages', 201, { authorRole: 'agent', isOwnMessage: true }],
      [handleSupportNote, 'notes', 201, { authorUserId: OTHER_AGENT, priority: 'urgent' }],
    ] as const) {
      const seen: Seen[] = [];
      const response = await handler(
        post('/api/support/x', { ticketId: TICKET, body: 'Some words for the record.', ...extra }),
        {
          env: ENV,
          fetch: api(
            expected,
            path === 'messages'
              ? { messageId: MESSAGE, status: 'pending_requester' }
              : { noteId: NOTE, noteCount: 2 },
            seen,
          ),
        },
      );

      expect(response.status, path).toBe(expected);
      expect(seen[0]!.url).toBe(
        `https://api.internal.test/v1/admin/support/tickets/${TICKET}/${path}`,
      );
      expect(JSON.parse(seen[0]!.body)).toEqual({ body: 'Some words for the record.' });
      expect(seen[0]!.body).not.toContain('authorRole');
      expect(seen[0]!.body).not.toContain('priority');
      expect(seen[0]!.body).not.toContain(OTHER_AGENT);
    }
  });

  it('refuses an empty body and one beyond the column’s length, without asking', async () => {
    const seen: Seen[] = [];
    for (const handler of [handleSupportReply, handleSupportNote]) {
      for (const body of ['   ', 'x'.repeat(8001), undefined, 42]) {
        const response = await handler(post('/api/support/x', { ticketId: TICKET, body }), {
          env: ENV,
          fetch: api(201, {}, seen),
        });
        expect(response.status).toBe(400);
      }
    }
    expect(seen).toHaveLength(0);
  });

  it('forwards a conflict on the note route as well as the reply route', async () => {
    for (const handler of [handleSupportReply, handleSupportNote]) {
      const response = await handler(post('/api/support/x', { ticketId: TICKET, body: 'Words' }), {
        env: ENV,
        fetch: api(409, { status: 409, code: 'SUPPORT_TICKET_NOT_WORKABLE' }),
      });
      expect(response.status).toBe(409);
    }
  });

  it('refuses an answer the contract does not describe', async () => {
    const response = await handleSupportNote(
      post('/api/support/note', { ticketId: TICKET, body: 'Words' }),
      { env: ENV, fetch: api(201, { noteId: NOTE, noteCount: 2, body: 'echoed back' }) },
    );
    expect(response.status).toBe(503);
  });
});

describe('the decision', () => {
  it('sends one status out of the two', async () => {
    for (const status of ['resolved', 'closed'] as const) {
      const seen: Seen[] = [];
      const response = await handleSupportDecision(
        post('/api/support/decision', { ticketId: TICKET, status }),
        { env: ENV, fetch: api(200, { status }, seen) },
      );
      expect(response.status, status).toBe(200);
      expect(seen[0]!.url).toBe(
        `https://api.internal.test/v1/admin/support/tickets/${TICKET}/decision`,
      );
      expect(JSON.parse(seen[0]!.body)).toEqual({ status });
    }
  });

  it('refuses every other status, and a reason, before anything leaves this origin', async () => {
    const seen: Seen[] = [];
    for (const body of [
      { ticketId: TICKET, status: 'open' },
      { ticketId: TICKET, status: 'pending_agent' },
      { ticketId: TICKET, status: 'reopened' },
      { ticketId: TICKET, status: '' },
      { ticketId: TICKET },
    ]) {
      const response = await handleSupportDecision(post('/api/support/decision', body), {
        env: ENV,
        fetch: api(200, { status: 'resolved' }, seen),
      });
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(seen).toHaveLength(0);
  });

  it('drops a reason rather than forwarding it: nothing stores one', async () => {
    const seen: Seen[] = [];
    const response = await handleSupportDecision(
      post('/api/support/decision', { ticketId: TICKET, status: 'resolved', reason: 'because' }),
      { env: ENV, fetch: api(200, { status: 'resolved' }, seen) },
    );
    expect(response.status).toBe(200);
    // The body is rebuilt from the contract, so the reason never leaves this origin — and the API's own
    // strict schema would refuse it if it did.
    expect(JSON.parse(seen[0]!.body)).toEqual({ status: 'resolved' });
    expect(seen[0]!.body).not.toContain('because');
  });

  it('refuses cross-site, and forwards the conflict', async () => {
    const seen: Seen[] = [];
    const cross = await handleSupportDecision(
      post('/api/support/decision', { ticketId: TICKET, status: 'closed' }, { origin: 'https://evil.test' }),
      { env: ENV, fetch: api(200, {}, seen) },
    );
    expect(cross.status).toBe(403);
    expect(seen).toHaveLength(0);

    const conflict = await handleSupportDecision(
      post('/api/support/decision', { ticketId: TICKET, status: 'resolved' }),
      { env: ENV, fetch: api(409, { status: 409, code: 'SUPPORT_TICKET_NOT_WORKABLE' }) },
    );
    expect(conflict.status).toBe(409);
  });
});

describe('the attachment link', () => {
  it('asks by two identifiers and never by a path', async () => {
    const seen: Seen[] = [];
    const response = await handleSupportAttachmentLink(
      get(`/api/support/attachment?ticketId=${TICKET}&attachmentId=${ATTACHMENT}&objectPath=${OBJECT_PATH}`),
      {
        env: ENV,
        fetch: api(
          200,
          {
            attachmentId: ATTACHMENT,
            url: 'https://storage.test.invalid/read/one-object',
            expiresAt: '2026-05-02T09:02:00.000Z',
          },
          seen,
        ),
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(seen[0]!.url).toBe(
      `https://api.internal.test/v1/admin/support/tickets/${TICKET}/attachments/${ATTACHMENT}/link`,
    );
    expect(seen[0]!.url).not.toContain('objectPath');
    expect(seen[0]!.method).toBe('GET');
    expect(seen[0]!.headers.get('cookie')).toBeNull();
  });

  it('refuses a malformed identifier and no session, without asking', async () => {
    const seen: Seen[] = [];
    const malformed = await handleSupportAttachmentLink(
      get('/api/support/attachment?ticketId=nope&attachmentId=nope'),
      { env: ENV, fetch: api(200, {}, seen) },
    );
    expect(malformed.status).toBe(400);

    const anonymous = await handleSupportAttachmentLink(
      new Request(`https://admin.test/api/support/attachment?ticketId=${TICKET}&attachmentId=${ATTACHMENT}`),
      { env: ENV, fetch: api(200, {}, seen) },
    );
    expect(anonymous.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('forwards a refusal, and refuses a body the contract does not describe', async () => {
    const refused = await handleSupportAttachmentLink(
      get(`/api/support/attachment?ticketId=${TICKET}&attachmentId=${ATTACHMENT}`),
      { env: ENV, fetch: api(404, { status: 404, code: 'NOT_FOUND' }) },
    );
    expect(refused.status).toBe(404);

    const drifted = await handleSupportAttachmentLink(
      get(`/api/support/attachment?ticketId=${TICKET}&attachmentId=${ATTACHMENT}`),
      { env: ENV, fetch: api(200, { attachmentId: ATTACHMENT, objectPath: OBJECT_PATH }) },
    );
    expect(drifted.status).toBe(503);
  });
});

describe('the shape of the module itself', () => {
  it('exports only the console’s own operations, and nothing that names an agent', async () => {
    const surface = await import('../../src/admin/server/bff/support-console');
    const names = Object.keys(surface).sort();
    expect(names).toEqual([
      'handleSupportAttachmentLink',
      'handleSupportClaim',
      'handleSupportDecision',
      'handleSupportNote',
      'handleSupportRelease',
      'handleSupportReply',
      'readSupportAssigned',
      'readSupportConsoleMessages',
      'readSupportConsoleTicket',
      'readSupportInternalNotes',
      'readSupportQueue',
    ]);
    for (const name of names) {
      expect(name.toLowerCase()).not.toMatch(/assignto|agents|list|priority|escalat|reopen/);
    }
  });

  it('addresses only /v1/admin/support paths', async () => {
    const seen: Seen[] = [];
    const empty = { items: [], nextCursor: null };
    await readSupportQueue({}, { env: ENV, cookieHeader: COOKIE, fetch: api(200, empty, seen) });
    await readSupportAssigned({}, { env: ENV, cookieHeader: COOKIE, fetch: api(200, empty, seen) });
    await readSupportConsoleTicket(TICKET, {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: api(200, { ticket: TICKET_ROW }, seen),
    });
    await handleSupportClaim(post('/api/support/claim', { ticketId: TICKET }), {
      env: ENV,
      fetch: api(200, { status: 'pending_agent', isMine: true }, seen),
    });

    for (const request of seen) {
      expect(request.url.startsWith('https://api.internal.test/v1/admin/support/')).toBe(true);
      expect(request.url).not.toContain('/v1/support/');
    }
  });
});
