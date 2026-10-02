import { describe, expect, it } from 'vitest';
import {
  handleAuthorizeSupportAttachment,
  handleCloseSupportTicket,
  handleOpenSupportTicket,
  handlePostSupportMessage,
  handleRecordSupportAttachment,
  handleSupportAttachmentLink,
  readSupportMessages,
  readSupportTicket,
  readSupportTickets,
} from '../src/server/bff/support';

/**
 * The BFF half of support — the requester side (Phase 7-K).
 *
 * What matters at this boundary:
 *
 *   * the caller's token comes from `__Host-mp_access` and never from a body, and the browser's own `Cookie`
 *     header is never forwarded upstream;
 *   * **bodies are rebuilt, never forwarded** — a page that added a `priority`, a `status`, an `assignedTo`,
 *     an `authorRole` or an account has all of them dropped before anything leaves this origin;
 *   * **a ticket, a message and an attachment are named in the route, never in a body**, and each attachment
 *     operation is addressed through its own ticket;
 *   * **the only path that crosses is the one the API issued**, sent back unchanged;
 *   * **answers are validated against the contract**, so an internal note, an agent identifier or a storage
 *     path a drifted API sent could not reach a page;
 *   * a session that ended, a ticket that is not there, a closed ticket, a refused cursor and a service that
 *     could not answer stay five distinct things;
 *   * every write refuses a cross-site request before it reads anything else;
 *   * nothing here is an agent operation.
 */

const ENV = Object.freeze({
  API_BASE_URL: 'https://api.internal.test',
  PUBLIC_WEB_ORIGIN: 'https://web.test',
  INTERNAL_BFF_CREDENTIAL: 'test-current-credential-value-not-a-real-se',
});

const SESSION_TOKEN = 'support-canary-access-token-not-a-real-toke';
const COOKIE = `__Host-mp_access=${SESSION_TOKEN}`;

const TICKET = 'd4000000-0000-4000-8000-000000000001';
const MESSAGE = 'd4000000-0000-4000-8000-0000000000a1';
const ATTACHMENT = 'd4000000-0000-4000-8000-0000000000b1';
const OBJECT_PATH = `support-attachments/${TICKET}/${MESSAGE}/f47ac10b-58cc-4372-a567-0e02b2c3d479.png`;

const SUMMARY_ROW = {
  id: TICKET,
  reference: 'SP-26-000001',
  subject: 'My payout has not arrived',
  category: 'payouts',
  status: 'pending_agent',
  messageCount: 2,
  attachmentCount: 1,
  lastMessageAt: '2026-05-02T09:00:00.000Z',
  resolvedAt: null,
  closedAt: null,
  createdAt: '2026-05-01T09:00:00.000Z',
};

const DETAIL_ROW = {
  id: TICKET,
  reference: 'SP-26-000001',
  subject: 'My payout has not arrived',
  category: 'payouts',
  status: 'pending_agent',
  messageCount: 2,
  lastMessageAt: '2026-05-02T09:00:00.000Z',
  resolvedAt: null,
  closedAt: null,
  createdAt: '2026-05-01T09:00:00.000Z',
};

const MESSAGE_ROW = {
  id: MESSAGE,
  authorRole: 'requester',
  isOwnMessage: true,
  body: 'It has been eight days since the payout was marked sent.',
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
  return new Request(`https://shop.test${path}`, {
    method: 'POST',
    headers: { origin: 'https://shop.test', 'content-type': 'application/json', cookie: COOKIE, ...headers },
    body: JSON.stringify(body),
  });
}

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://shop.test${path}`, {
    method: 'GET',
    headers: { cookie: COOKIE, ...headers },
  });
}

const VALID_TICKET = {
  subject: 'My payout has not arrived',
  category: 'payouts',
  body: 'It has been eight days since the payout was marked sent.',
};
const VALID_RECORD = {
  objectPath: OBJECT_PATH,
  originalFilename: 'statement.pdf',
  contentType: 'application/pdf',
  byteSize: 20_480,
};
const OPENED = {
  ticketId: TICKET,
  messageId: MESSAGE,
  reference: 'SP-26-000001',
  status: 'pending_agent',
};
const UPLOAD = {
  upload: {
    uploadUrl: 'https://storage.test.invalid/upload/one-object',
    objectPath: OBJECT_PATH,
    expiresAt: '2026-05-02T09:02:00.000Z',
    maxByteSize: 20_971_520,
  },
};

/* ------------------------------------------------------------------------------------------------ */

describe('reading the three support views', () => {
  it('presents the caller’s token and the internal credential, and never the browser cookie', async () => {
    const seen: Seen[] = [];
    await readSupportTickets(
      {},
      { env: ENV, cookieHeader: COOKIE, fetch: api(200, { items: [SUMMARY_ROW], nextCursor: null }, seen) },
    );

    expect(seen[0]!.url).toBe('https://api.internal.test/v1/support/tickets');
    expect(seen[0]!.method).toBe('GET');
    expect(seen[0]!.headers.get('x-session-token')).toBe(SESSION_TOKEN);
    expect(seen[0]!.headers.get('x-internal-credential')).toBe(ENV.INTERNAL_BFF_CREDENTIAL);
    expect(seen[0]!.headers.get('cookie')).toBeNull();
  });

  it('never asks for a queue, a role or an account', async () => {
    const seen: Seen[] = [];
    const empty = { items: [], nextCursor: null };
    await readSupportTickets({ limit: '10' }, { env: ENV, cookieHeader: COOKIE, fetch: api(200, empty, seen) });
    await readSupportMessages(TICKET, {}, { env: ENV, cookieHeader: COOKIE, fetch: api(200, empty, seen) });

    for (const request of seen) {
      expect(request.url).not.toContain('role=');
      expect(request.url).not.toContain('user');
      expect(request.url).not.toContain('queue');
      expect(request.url).not.toContain('assigned');
    }
  });

  it('reads one ticket by the identifier in the address, lower-cased', async () => {
    const seen: Seen[] = [];
    const result = await readSupportTicket(TICKET.toUpperCase(), {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: api(200, { ticket: DETAIL_ROW }, seen),
    });

    expect(result.kind).toBe('ok');
    expect(seen[0]!.url).toBe(`https://api.internal.test/v1/support/tickets/${TICKET}`);
  });

  it('passes a cursor through verbatim and never interprets it', async () => {
    const seen: Seen[] = [];
    const cursor = 'c3QxfDIwMjYtMDUtMDFUMDk6MDA6MDAuMDAwWnwx';
    await readSupportMessages(
      TICKET,
      { cursor, limit: '5' },
      { env: ENV, cookieHeader: COOKIE, fetch: api(200, { items: [], nextCursor: null }, seen) },
    );
    expect(seen[0]!.url).toContain(`cursor=${cursor}`);
    expect(seen[0]!.url).toContain('limit=5');
  });

  it('never reaches the API without a session cookie', async () => {
    const seen: Seen[] = [];
    for (const read of [
      () => readSupportTickets({}, { env: ENV, cookieHeader: null, fetch: api(200, {}, seen) }),
      () => readSupportTicket(TICKET, { env: ENV, cookieHeader: null, fetch: api(200, {}, seen) }),
      () => readSupportMessages(TICKET, {}, { env: ENV, cookieHeader: null, fetch: api(200, {}, seen) }),
    ]) {
      expect((await read()).kind).toBe('unauthenticated');
    }
    expect(seen).toHaveLength(0);
  });

  it('answers not-found for an identifier that is not one, without asking', async () => {
    const seen: Seen[] = [];
    expect(
      (await readSupportTicket('nope', { env: ENV, cookieHeader: COOKIE, fetch: api(200, {}, seen) })).kind,
    ).toBe('notFound');
    expect(
      (await readSupportMessages('nope', {}, { env: ENV, cookieHeader: COOKIE, fetch: api(200, {}, seen) }))
        .kind,
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
      const result = await readSupportTickets(
        {},
        { env: ENV, cookieHeader: COOKIE, fetch: api(status, { status, code: 'X' }) },
      );
      expect(result.kind, String(status)).toBe(kind);
    }
  });

  it('refuses a body the contract does not describe, rather than passing it to a page', async () => {
    // An internal note, an assigned agent and an author identifier are not in the contract, so a response
    // carrying them is a drifted API and becomes an outage here rather than a leak downstream.
    const drifted = {
      items: [{ ...SUMMARY_ROW, assignedTo: 'somebody', priority: 'urgent' }],
      nextCursor: null,
    };
    const result = await readSupportTickets({}, { env: ENV, cookieHeader: COOKIE, fetch: api(200, drifted) });
    expect(result.kind).toBe('unavailable');
  });

  it('refuses a message carrying an internal note or an author identifier', async () => {
    for (const row of [
      { ...MESSAGE_ROW, authorUserId: 'somebody' },
      { ...MESSAGE_ROW, internalNote: 'staff only' },
      { ...MESSAGE_ROW, attachments: [{ id: ATTACHMENT, objectPath: OBJECT_PATH }] },
    ]) {
      const result = await readSupportMessages(
        TICKET,
        {},
        { env: ENV, cookieHeader: COOKIE, fetch: api(200, { items: [row], nextCursor: null }) },
      );
      expect(result.kind).toBe('unavailable');
    }
  });

  it('returns the contract’s own object, so nothing extra can travel even by accident', async () => {
    const result = await readSupportMessages(
      TICKET,
      {},
      { env: ENV, cookieHeader: COOKIE, fetch: api(200, { items: [MESSAGE_ROW], nextCursor: null }) },
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(Object.keys(result.data.items[0]!).sort()).toEqual([
      'attachments',
      'authorRole',
      'body',
      'createdAt',
      'id',
      'isOwnMessage',
    ]);
  });
});

describe('opening a ticket', () => {
  it('sends exactly the three fields the contract names', async () => {
    const seen: Seen[] = [];
    const response = await handleOpenSupportTicket(post('/api/support/tickets', VALID_TICKET), {
      env: ENV,
      fetch: api(201, OPENED, seen),
    });

    expect(response.status).toBe(201);
    expect(seen[0]!.url).toBe('https://api.internal.test/v1/support/tickets');
    expect(JSON.parse(seen[0]!.body)).toEqual(VALID_TICKET);
  });

  it('drops a priority, a status, an assignee, an order and an account', async () => {
    const seen: Seen[] = [];
    await handleOpenSupportTicket(
      post('/api/support/tickets', {
        ...VALID_TICKET,
        priority: 'urgent',
        status: 'resolved',
        assignedTo: TICKET,
        orderId: TICKET,
        requesterUserId: TICKET,
        reference: 'SP-26-999999',
      }),
      { env: ENV, fetch: api(201, OPENED, seen) },
    );

    expect(JSON.parse(seen[0]!.body)).toEqual(VALID_TICKET);
    expect(seen[0]!.body).not.toContain('urgent');
    expect(seen[0]!.body).not.toContain('resolved');
    expect(seen[0]!.body).not.toContain('assignedTo');
  });

  it('refuses a ninth category and an over-long subject without asking the API', async () => {
    for (const payload of [
      { ...VALID_TICKET, category: 'billing' },
      { ...VALID_TICKET, subject: 'x'.repeat(201) },
      { ...VALID_TICKET, body: '   ' },
      { category: 'payouts' },
    ]) {
      const seen: Seen[] = [];
      const response = await handleOpenSupportTicket(post('/api/support/tickets', payload), {
        env: ENV,
        fetch: api(201, OPENED, seen),
      });
      expect(response.status).toBe(400);
      expect(seen).toHaveLength(0);
    }
  });

  it('refuses a cross-site request before reading a body or a cookie', async () => {
    const seen: Seen[] = [];
    const response = await handleOpenSupportTicket(
      post('/api/support/tickets', VALID_TICKET, { origin: 'https://evil.test' }),
      { env: ENV, fetch: api(201, OPENED, seen) },
    );
    expect(response.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it('refuses without a session, and forwards a refusal the API made', async () => {
    const withoutCookie = new Request('https://shop.test/api/support/tickets', {
      method: 'POST',
      headers: { origin: 'https://shop.test', 'content-type': 'application/json' },
      body: JSON.stringify(VALID_TICKET),
    });
    expect((await handleOpenSupportTicket(withoutCookie, { env: ENV })).status).toBe(401);

    const refused = await handleOpenSupportTicket(post('/api/support/tickets', VALID_TICKET), {
      env: ENV,
      fetch: api(400, { status: 400, code: 'VALIDATION_FAILED' }),
    });
    expect(refused.status).toBe(400);
    expect((await refused.json())['code']).toBe('VALIDATION_FAILED');
  });

  it('turns an unexpected upstream status into a plain 503', async () => {
    const response = await handleOpenSupportTicket(post('/api/support/tickets', VALID_TICKET), {
      env: ENV,
      fetch: api(418, { teapot: true }),
    });
    expect(response.status).toBe(503);
  });
});

describe('replying and closing', () => {
  it('sends the body alone, with the ticket in the route', async () => {
    const seen: Seen[] = [];
    const response = await handlePostSupportMessage(
      post(`/api/support/tickets/${TICKET}/messages`, {
        body: 'Yes, that is the address.',
        authorRole: 'agent',
        ticketId: 'somebody-elses',
      }),
      TICKET,
      { env: ENV, fetch: api(201, { messageId: MESSAGE, status: 'pending_agent' }, seen) },
    );

    expect(response.status).toBe(201);
    expect(seen[0]!.url).toBe(`https://api.internal.test/v1/support/tickets/${TICKET}/messages`);
    expect(JSON.parse(seen[0]!.body)).toEqual({ body: 'Yes, that is the address.' });
    expect(seen[0]!.body).not.toContain('authorRole');
  });

  it('closes with no body at all, whatever the page sent', async () => {
    const seen: Seen[] = [];
    const response = await handleCloseSupportTicket(
      post(`/api/support/tickets/${TICKET}/close`, { status: 'resolved' }),
      TICKET,
      { env: ENV, fetch: api(200, { status: 'closed' }, seen) },
    );

    expect(response.status).toBe(200);
    expect(seen[0]!.url).toBe(`https://api.internal.test/v1/support/tickets/${TICKET}/close`);
    expect(seen[0]!.body).toBe('');
    expect(seen[0]!.headers.get('content-type')).toBeNull();
  });

  it('forwards a closed ticket’s own refusal so a form can say so', async () => {
    for (const handler of [
      () =>
        handlePostSupportMessage(
          post(`/api/support/tickets/${TICKET}/messages`, { body: 'One more thing' }),
          TICKET,
          { env: ENV, fetch: api(409, { status: 409, code: 'SUPPORT_TICKET_NOT_ACTIONABLE' }) },
        ),
      () =>
        handleCloseSupportTicket(post(`/api/support/tickets/${TICKET}/close`, {}), TICKET, {
          env: ENV,
          fetch: api(409, { status: 409, code: 'SUPPORT_TICKET_NOT_ACTIONABLE' }),
        }),
    ]) {
      const response = await handler();
      expect(response.status).toBe(409);
      expect((await response.json())['code']).toBe('SUPPORT_TICKET_NOT_ACTIONABLE');
    }
  });

  it('forwards a throttled refusal with the API’s own problem body', async () => {
    for (const [handler, expected] of [
      [
        () =>
          handleOpenSupportTicket(post('/api/support/tickets', VALID_TICKET), {
            env: ENV,
            fetch: api(429, { status: 429, code: 'THROTTLED' }),
          }),
        429,
      ],
      [
        () =>
          handlePostSupportMessage(
            post(`/api/support/tickets/${TICKET}/messages`, { body: 'Hi' }),
            TICKET,
            { env: ENV, fetch: api(429, { status: 429, code: 'THROTTLED' }) },
          ),
        429,
      ],
      [
        () =>
          handleAuthorizeSupportAttachment(
            post('/api/x', { contentType: 'image/png', byteSize: 4096 }),
            TICKET,
            MESSAGE,
            { env: ENV, fetch: api(429, { status: 429, code: 'THROTTLED' }) },
          ),
        429,
      ],
    ] as const) {
      const response = await handler();
      expect(response.status).toBe(expected);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body['code']).toBe('THROTTLED');
      // A refusal never names which window was hit.
      expect(JSON.stringify(body)).not.toContain('support_message');
      expect(JSON.stringify(body)).not.toContain('seller_media');
    }
  });

  it('refuses a malformed ticket identifier without asking', async () => {
    const seen: Seen[] = [];
    for (const response of [
      await handlePostSupportMessage(post('/api/support/tickets/nope/messages', { body: 'Hi' }), 'nope', {
        env: ENV,
        fetch: api(201, {}, seen),
      }),
      await handleCloseSupportTicket(post('/api/support/tickets/nope/close', {}), 'nope', {
        env: ENV,
        fetch: api(200, {}, seen),
      }),
    ]) {
      expect(response.status).toBe(400);
    }
    expect(seen).toHaveLength(0);
  });

  it('refuses both writes cross-site', async () => {
    const seen: Seen[] = [];
    for (const response of [
      await handlePostSupportMessage(
        post(`/api/support/tickets/${TICKET}/messages`, { body: 'Hi' }, { origin: 'https://evil.test' }),
        TICKET,
        { env: ENV, fetch: api(201, {}, seen) },
      ),
      await handleCloseSupportTicket(
        post(`/api/support/tickets/${TICKET}/close`, {}, { origin: 'https://evil.test' }),
        TICKET,
        { env: ENV, fetch: api(200, {}, seen) },
      ),
    ]) {
      expect(response.status).toBe(403);
    }
    expect(seen).toHaveLength(0);
  });
});

describe('attachments', () => {
  it('asks for a destination with the two fields the bucket decides on, and no path', async () => {
    const seen: Seen[] = [];
    const response = await handleAuthorizeSupportAttachment(
      post(`/api/support/tickets/${TICKET}/messages/${MESSAGE}/attachments/uploads`, {
        contentType: 'image/png',
        byteSize: 4096,
        objectPath: '../../elsewhere/x.png',
        bucket: 'public',
      }),
      TICKET,
      MESSAGE,
      { env: ENV, fetch: api(201, UPLOAD, seen) },
    );

    expect(response.status).toBe(201);
    expect(seen[0]!.url).toBe(
      `https://api.internal.test/v1/support/tickets/${TICKET}/messages/${MESSAGE}/attachments/uploads`,
    );
    expect(JSON.parse(seen[0]!.body)).toEqual({ contentType: 'image/png', byteSize: 4096 });
    expect(seen[0]!.body).not.toContain('elsewhere');
    expect(seen[0]!.body).not.toContain('bucket');
  });

  it('refuses a type the bucket does not allow and a size beyond its ceiling', async () => {
    for (const payload of [
      { contentType: 'image/gif', byteSize: 4096 },
      { contentType: 'image/png', byteSize: 20_971_521 },
      { contentType: 'image/png' },
    ]) {
      const seen: Seen[] = [];
      const response = await handleAuthorizeSupportAttachment(
        post(`/api/support/tickets/${TICKET}/messages/${MESSAGE}/attachments/uploads`, payload),
        TICKET,
        MESSAGE,
        { env: ENV, fetch: api(201, UPLOAD, seen) },
      );
      expect(response.status).toBe(400);
      expect(seen).toHaveLength(0);
    }
  });

  it('confirms with the path the API issued, sent back unchanged', async () => {
    const seen: Seen[] = [];
    const response = await handleRecordSupportAttachment(
      post(`/api/support/tickets/${TICKET}/messages/${MESSAGE}/attachments`, VALID_RECORD),
      TICKET,
      MESSAGE,
      { env: ENV, fetch: api(201, { attachmentId: ATTACHMENT, attachmentCount: 1 }, seen) },
    );

    expect(response.status).toBe(201);
    expect(JSON.parse(seen[0]!.body)).toEqual(VALID_RECORD);
  });

  it('forwards the API’s own answer for a file the provider does not have', async () => {
    const response = await handleRecordSupportAttachment(
      post(`/api/support/tickets/${TICKET}/messages/${MESSAGE}/attachments`, VALID_RECORD),
      TICKET,
      MESSAGE,
      { env: ENV, fetch: api(404, { status: 404, code: 'SUPPORT_ATTACHMENT_OBJECT_MISSING' }) },
    );
    expect(response.status).toBe(404);
    expect((await response.json())['code']).toBe('SUPPORT_ATTACHMENT_OBJECT_MISSING');
  });

  it('refuses a malformed ticket or message identifier on both halves', async () => {
    const seen: Seen[] = [];
    for (const response of [
      await handleAuthorizeSupportAttachment(
        post('/api/x', { contentType: 'image/png', byteSize: 1 }),
        'nope',
        MESSAGE,
        { env: ENV, fetch: api(201, UPLOAD, seen) },
      ),
      await handleAuthorizeSupportAttachment(
        post('/api/x', { contentType: 'image/png', byteSize: 1 }),
        TICKET,
        'nope',
        { env: ENV, fetch: api(201, UPLOAD, seen) },
      ),
      await handleRecordSupportAttachment(post('/api/x', VALID_RECORD), TICKET, 'nope', {
        env: ENV,
        fetch: api(201, {}, seen),
      }),
    ]) {
      expect(response.status).toBe(400);
    }
    expect(seen).toHaveLength(0);
  });

  it('signs one read behind the ticket in the route, and never caches it', async () => {
    const seen: Seen[] = [];
    const response = await handleSupportAttachmentLink(
      get(`/api/support/tickets/${TICKET}/attachments/${ATTACHMENT}/link`),
      TICKET,
      ATTACHMENT,
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
      `https://api.internal.test/v1/support/tickets/${TICKET}/attachments/${ATTACHMENT}/link`,
    );
    expect(seen[0]!.method).toBe('GET');
    expect(seen[0]!.headers.get('cookie')).toBeNull();
  });

  it('forwards a link refusal, and refuses without a session', async () => {
    const refused = await handleSupportAttachmentLink(
      get(`/api/support/tickets/${TICKET}/attachments/${ATTACHMENT}/link`),
      TICKET,
      ATTACHMENT,
      { env: ENV, fetch: api(404, { status: 404, code: 'NOT_FOUND' }) },
    );
    expect(refused.status).toBe(404);

    const seen: Seen[] = [];
    const anonymous = await handleSupportAttachmentLink(
      new Request('https://shop.test/x', { method: 'GET' }),
      TICKET,
      ATTACHMENT,
      { env: ENV, fetch: api(200, {}, seen) },
    );
    expect(anonymous.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('refuses a link body the contract does not describe', async () => {
    const response = await handleSupportAttachmentLink(
      get(`/api/support/tickets/${TICKET}/attachments/${ATTACHMENT}/link`),
      TICKET,
      ATTACHMENT,
      { env: ENV, fetch: api(200, { attachmentId: ATTACHMENT, objectPath: OBJECT_PATH }) },
    );
    expect(response.status).toBe(503);
  });
});

describe('the shape of the module itself', () => {
  it('exports only requester operations: no assignment, no note, no queue and no permission', async () => {
    const surface = await import('../src/server/bff/support');
    const names = Object.keys(surface).sort();
    expect(names).toEqual([
      'handleAuthorizeSupportAttachment',
      'handleCloseSupportTicket',
      'handleOpenSupportTicket',
      'handlePostSupportMessage',
      'handleRecordSupportAttachment',
      'handleSupportAttachmentLink',
      'readSupportMessages',
      'readSupportTicket',
      'readSupportTickets',
    ]);
    for (const name of names) {
      expect(name.toLowerCase()).not.toMatch(/assign|note|queue|permission|resolve|priority|staff|agent/);
    }
  });

  it('addresses no /v1/admin path and no agent path', async () => {
    const seen: Seen[] = [];
    await readSupportTickets({}, { env: ENV, cookieHeader: COOKIE, fetch: api(200, { items: [], nextCursor: null }, seen) });
    await readSupportTicket(TICKET, { env: ENV, cookieHeader: COOKIE, fetch: api(200, { ticket: DETAIL_ROW }, seen) });
    await readSupportMessages(TICKET, {}, { env: ENV, cookieHeader: COOKIE, fetch: api(200, { items: [], nextCursor: null }, seen) });
    await handleOpenSupportTicket(post('/api/support/tickets', VALID_TICKET), { env: ENV, fetch: api(201, OPENED, seen) });
    await handleCloseSupportTicket(post(`/api/support/tickets/${TICKET}/close`, {}), TICKET, {
      env: ENV,
      fetch: api(200, { status: 'closed' }, seen),
    });

    for (const request of seen) {
      expect(request.url).not.toContain('/v1/admin');
      expect(request.url).not.toContain('/notes');
      expect(request.url).not.toContain('/assign');
    }
  });
});
