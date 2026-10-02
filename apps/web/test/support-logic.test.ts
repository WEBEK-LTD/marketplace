import { describe, expect, it } from 'vitest';
import {
  SUPPORT_ATTACHMENT_ACCEPT,
  SUPPORT_BODY_MAX_LENGTH,
  SUPPORT_CATEGORIES,
  SUPPORT_SUBJECT_MAX_LENGTH,
  authorizeSupportAttachment,
  checkChosenFile,
  closeSupportTicket,
  isSupportCategory,
  openSupportTicket,
  postSupportMessage,
  prepareText,
  putBytes,
  recordSupportAttachment,
  runSupportAttachmentUpload,
  supportAttachmentLink,
  supportFailureMessage,
} from '../src/components/support';

/**
 * The requester support surface's logic (Phase 7-K).
 *
 * Every rule the pages follow is a function here, so each is proven exactly rather than through a rendered
 * page. What is being held to account:
 *
 *   * **nothing sends a status, a priority, an assignee or an author** — the three writes send a subject, a
 *     category and a body; a body; and nothing at all;
 *   * **the browser chooses no destination** — the upload request carries a type and a size, the path comes
 *     back, and the confirmation sends that path unchanged;
 *   * **a signed URL is used and not kept** — it is confined to the one call that received it;
 *   * **nothing is reported as attached until the server said so** — a failed PUT never reaches the
 *     confirmation;
 *   * **each refusal keeps its own sentence**, including the two that share a status.
 */

const TICKET = 'd4000000-0000-4000-8000-000000000001';
const MESSAGE = 'd4000000-0000-4000-8000-0000000000a1';
const ATTACHMENT = 'd4000000-0000-4000-8000-0000000000b1';
const OBJECT_PATH = `support-attachments/${TICKET}/${MESSAGE}/f47ac10b-58cc-4372-a567-0e02b2c3d479.png`;

const LABELS = {
  invalid: 'invalid-sentence',
  notFound: 'not-found-sentence',
  closed: 'closed-sentence',
  missing: 'missing-sentence',
  throttled: 'throttled-sentence',
  signedOut: 'signed-out-sentence',
  unavailable: 'unavailable-sentence',
};

interface Seen {
  readonly url: string;
  readonly method: string;
  readonly body: string;
  readonly credentials: string | undefined;
  readonly contentType: string | null;
}

function responder(status: number, payload: unknown, seen: Seen[] = []): typeof fetch {
  return (async (input: unknown, init: RequestInit) => {
    seen.push({
      url: String(input),
      method: String(init.method ?? 'GET'),
      body: typeof init.body === 'string' ? init.body : init.body === undefined ? '' : '[bytes]',
      credentials: init.credentials,
      contentType: new Headers(init.headers).get('content-type'),
    });
    return new Response(status === 204 ? null : JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

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

describe('the closed vocabularies and the bounds', () => {
  it('offers exactly the eight categories the schema defines, in its order', () => {
    expect(SUPPORT_CATEGORIES).toEqual([
      'account',
      'orders',
      'payments',
      'payouts',
      'listings',
      'verification',
      'technical',
      'other',
    ]);
    expect(isSupportCategory('payouts')).toBe(true);
    expect(isSupportCategory('billing')).toBe(false);
    expect(isSupportCategory('')).toBe(false);
  });

  it('offers exactly the four types the bucket allows', () => {
    expect(SUPPORT_ATTACHMENT_ACCEPT).toBe('image/jpeg,image/png,image/webp,application/pdf');
  });

  it('bounds text by the columns that will hold it', () => {
    expect(SUPPORT_SUBJECT_MAX_LENGTH).toBe(200);
    expect(SUPPORT_BODY_MAX_LENGTH).toBe(8000);

    expect(prepareText('  a summary  ', SUPPORT_SUBJECT_MAX_LENGTH)).toEqual({
      ok: true,
      value: 'a summary',
    });
    expect(prepareText('   ', SUPPORT_SUBJECT_MAX_LENGTH)).toEqual({ ok: false, problem: 'empty' });
    expect(prepareText('x'.repeat(201), SUPPORT_SUBJECT_MAX_LENGTH)).toEqual({
      ok: false,
      problem: 'too_long',
    });
    // Trimming happens before the length check, so trailing spaces cannot push a valid subject over.
    expect(prepareText(`${'x'.repeat(200)}   `, SUPPORT_SUBJECT_MAX_LENGTH).ok).toBe(true);
  });

  it('checks a chosen file against the bucket’s type list and its ceiling', () => {
    expect(checkChosenFile({ type: 'image/png', size: 4096 })).toEqual({
      ok: true,
      contentType: 'image/png',
    });
    expect(checkChosenFile({ type: 'image/gif', size: 4096 })).toEqual({ ok: false, problem: 'type' });
    expect(checkChosenFile({ type: 'application/pdf', size: 0 })).toEqual({ ok: false, problem: 'size' });
    expect(checkChosenFile({ type: 'application/pdf', size: 20_971_521 })).toEqual({
      ok: false,
      problem: 'size',
    });
  });

  it('gives every refusal its own sentence', () => {
    expect(supportFailureMessage('invalid', LABELS)).toBe('invalid-sentence');
    expect(supportFailureMessage('notFound', LABELS)).toBe('not-found-sentence');
    expect(supportFailureMessage('closed', LABELS)).toBe('closed-sentence');
    expect(supportFailureMessage('missing', LABELS)).toBe('missing-sentence');
    expect(supportFailureMessage('throttled', LABELS)).toBe('throttled-sentence');
    expect(supportFailureMessage('signedOut', LABELS)).toBe('signed-out-sentence');
    expect(supportFailureMessage('unavailable', LABELS)).toBe('unavailable-sentence');
  });
});

describe('the three writes', () => {
  it('opens a ticket with three fields, and returns the ticket and its first message', async () => {
    const seen: Seen[] = [];
    const result = await openSupportTicket(
      { subject: 'A summary', category: 'payouts', body: 'What happened, at length.' },
      responder(201, OPENED, seen),
    );

    expect(result).toEqual({ kind: 'ok', ticketId: TICKET, messageId: MESSAGE });
    expect(seen[0]!.url).toBe('/api/support/tickets');
    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.credentials).toBe('same-origin');
    expect(JSON.parse(seen[0]!.body)).toEqual({
      subject: 'A summary',
      category: 'payouts',
      body: 'What happened, at length.',
    });
  });

  it('replies with the body alone', async () => {
    const seen: Seen[] = [];
    const result = await postSupportMessage(TICKET, 'One more thing.', responder(201, {
      messageId: MESSAGE,
      status: 'pending_agent',
    }, seen));

    expect(result).toEqual({ kind: 'ok', messageId: MESSAGE });
    expect(seen[0]!.url).toBe(`/api/support/tickets/${TICKET}/messages`);
    expect(JSON.parse(seen[0]!.body)).toEqual({ body: 'One more thing.' });
  });

  it('closes with no body and no status', async () => {
    const seen: Seen[] = [];
    const result = await closeSupportTicket(TICKET, responder(200, { status: 'closed' }, seen));

    expect(result).toEqual({ kind: 'ok', status: 'closed' });
    expect(seen[0]!.url).toBe(`/api/support/tickets/${TICKET}/close`);
    expect(seen[0]!.body).toBe('');
    expect(seen[0]!.contentType).toBeNull();
  });

  it('never mentions resolved anywhere in what it sends', async () => {
    const seen: Seen[] = [];
    await openSupportTicket({ subject: 'A', category: 'other', body: 'Bb' }, responder(201, OPENED, seen));
    await postSupportMessage(TICKET, 'Hi', responder(201, { messageId: MESSAGE, status: 'open' }, seen));
    await closeSupportTicket(TICKET, responder(200, { status: 'closed' }, seen));
    for (const call of seen) {
      expect(call.body).not.toContain('resolved');
      expect(call.body).not.toContain('status');
      expect(call.body).not.toContain('priority');
    }
  });

  it('turns each status into the outcome that has its own remedy', async () => {
    for (const [status, payload, kind] of [
      [401, {}, 'signedOut'],
      [409, { code: 'SUPPORT_TICKET_NOT_ACTIONABLE' }, 'closed'],
      [404, { code: 'NOT_FOUND' }, 'notFound'],
      [404, { code: 'SUPPORT_ATTACHMENT_OBJECT_MISSING' }, 'missing'],
      [429, { code: 'THROTTLED' }, 'throttled'],
      [400, { code: 'VALIDATION_FAILED' }, 'invalid'],
      [503, {}, 'unavailable'],
      [418, {}, 'unavailable'],
    ] as const) {
      const result = await postSupportMessage(TICKET, 'Hi', responder(status, payload));
      expect(result.kind, `${status}`).toBe(kind);
    }
  });

  it('treats a body it cannot validate as an outage rather than a success', async () => {
    expect((await openSupportTicket({ subject: 'A', category: 'other', body: 'Bb' }, responder(201, { ticketId: 'nope' }))).kind).toBe('unavailable');
    expect((await closeSupportTicket(TICKET, responder(200, { status: 'made-up' }))).kind).toBe('unavailable');
  });

  it('treats a network failure as an outage', async () => {
    const broken = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect((await closeSupportTicket(TICKET, broken)).kind).toBe('unavailable');
  });
});

describe('the three attachment steps', () => {
  it('asks for a destination with a type and a size, and never a path', async () => {
    const seen: Seen[] = [];
    const result = await authorizeSupportAttachment(
      TICKET,
      MESSAGE,
      { type: 'image/png', size: 4096 },
      responder(201, UPLOAD, seen),
    );

    expect(result).toEqual({
      kind: 'ok',
      uploadUrl: 'https://storage.test.invalid/upload/one-object',
      objectPath: OBJECT_PATH,
    });
    expect(seen[0]!.url).toBe(
      `/api/support/tickets/${TICKET}/messages/${MESSAGE}/attachments/uploads`,
    );
    expect(JSON.parse(seen[0]!.body)).toEqual({ contentType: 'image/png', byteSize: 4096 });
    expect(seen[0]!.body).not.toContain('support-attachments');
  });

  it('refuses a file the bucket would refuse, without asking the server', async () => {
    const seen: Seen[] = [];
    const result = await authorizeSupportAttachment(
      TICKET,
      MESSAGE,
      { type: 'application/zip', size: 10 },
      responder(201, UPLOAD, seen),
    );
    expect(result.kind).toBe('invalid');
    expect(seen).toHaveLength(0);
  });

  it('sends the bytes to the signed URL with no cookie of this site attached', async () => {
    const seen: Seen[] = [];
    const ok = await putBytes(
      'https://storage.test.invalid/upload/one-object',
      new Blob(['x']),
      'image/png',
      responder(200, {}, seen),
    );
    expect(ok).toBe(true);
    expect(seen[0]!.url).toBe('https://storage.test.invalid/upload/one-object');
    expect(seen[0]!.method).toBe('PUT');
    expect(seen[0]!.credentials).toBe('omit');
    expect(seen[0]!.contentType).toBe('image/png');
  });

  it('confirms with the path the server issued', async () => {
    const seen: Seen[] = [];
    const result = await recordSupportAttachment(
      TICKET,
      MESSAGE,
      {
        objectPath: OBJECT_PATH,
        originalFilename: 'statement.pdf',
        contentType: 'application/pdf',
        byteSize: 20_480,
      },
      responder(201, { attachmentId: ATTACHMENT, attachmentCount: 1 }, seen),
    );

    expect(result).toEqual({ kind: 'ok', attachmentCount: 1 });
    expect(seen[0]!.url).toBe(`/api/support/tickets/${TICKET}/messages/${MESSAGE}/attachments`);
    expect(JSON.parse(seen[0]!.body)['objectPath']).toBe(OBJECT_PATH);
  });

  it('runs the three steps in order, and keeps the signed URL inside the run', async () => {
    const origin: Seen[] = [];
    const storage: Seen[] = [];
    const result = await runSupportAttachmentUpload(
      TICKET,
      MESSAGE,
      { type: 'image/png', size: 4096, name: 'shot.png', body: new Blob(['x']) },
      {
        origin: ((input: unknown, init: RequestInit) => {
          const path = String(input);
          const responseFor = path.endsWith('/uploads')
            ? UPLOAD
            : { attachmentId: ATTACHMENT, attachmentCount: 1 };
          return responder(201, responseFor, origin)(input as never, init as never);
        }) as unknown as typeof fetch,
        storage: responder(200, {}, storage),
      },
    );

    expect(result).toEqual({ kind: 'ok', attachmentCount: 1 });
    expect(origin.map((call) => call.url)).toEqual([
      `/api/support/tickets/${TICKET}/messages/${MESSAGE}/attachments/uploads`,
      `/api/support/tickets/${TICKET}/messages/${MESSAGE}/attachments`,
    ]);
    // The upload URL is used once, by the storage fetcher, and appears in nothing sent to this origin.
    expect(storage).toHaveLength(1);
    for (const call of origin) expect(call.body).not.toContain('storage.test.invalid');
  });

  it('never confirms a file whose bytes did not land', async () => {
    const origin: Seen[] = [];
    const result = await runSupportAttachmentUpload(
      TICKET,
      MESSAGE,
      { type: 'image/png', size: 4096, name: 'shot.png', body: new Blob(['x']) },
      {
        origin: responder(201, UPLOAD, origin),
        storage: responder(500, {}),
      },
    );

    expect(result.kind).toBe('unavailable');
    expect(origin).toHaveLength(1);
    expect(origin[0]!.url).toContain('/uploads');
  });

  it('reports a throttled authorization as its own outcome, and uploads nothing', async () => {
    const storage: Seen[] = [];
    const result = await runSupportAttachmentUpload(
      TICKET,
      MESSAGE,
      { type: 'image/png', size: 4096, name: 'shot.png', body: new Blob(['x']) },
      { origin: responder(429, { code: 'THROTTLED' }), storage: responder(200, {}, storage) },
    );
    expect(result.kind).toBe('throttled');
    expect(storage).toHaveLength(0);
  });

  it('stops at the first step when the server refuses it, and reports that refusal', async () => {
    const result = await runSupportAttachmentUpload(
      TICKET,
      MESSAGE,
      { type: 'image/png', size: 4096, name: 'shot.png', body: new Blob(['x']) },
      { origin: responder(409, { code: 'SUPPORT_TICKET_NOT_ACTIONABLE' }), storage: responder(200, {}) },
    );
    expect(result.kind).toBe('closed');
  });

  it('asks for a link by identifier and gets a URL back, with no path in either direction', async () => {
    const seen: Seen[] = [];
    const result = await supportAttachmentLink(
      TICKET,
      ATTACHMENT,
      responder(
        200,
        {
          attachmentId: ATTACHMENT,
          url: 'https://storage.test.invalid/read/one-object',
          expiresAt: '2026-05-02T09:02:00.000Z',
        },
        seen,
      ),
    );

    expect(result).toEqual({ kind: 'ok', url: 'https://storage.test.invalid/read/one-object' });
    expect(seen[0]!.url).toBe(`/api/support/tickets/${TICKET}/attachments/${ATTACHMENT}/link`);
    expect(seen[0]!.method).toBe('GET');
    expect(seen[0]!.body).toBe('');
  });

  it('reports a link it may not have as a plain not-found', async () => {
    const result = await supportAttachmentLink(
      TICKET,
      ATTACHMENT,
      responder(404, { code: 'NOT_FOUND' }),
    );
    expect(result.kind).toBe('notFound');
  });
});
