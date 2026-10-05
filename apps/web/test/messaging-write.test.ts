import { describe, expect, it } from 'vitest';
import {
  MESSAGE_BODY_MAX_LENGTH,
  MESSAGING_WRITE_ROUTES,
  closeConversation,
  composerState,
  fileReport,
  leaveConversation,
  markRead,
  prepareBody,
  sendMessage,
  setMuted,
  startDirectConversation,
  startListingConversation,
  writeFailureMessage,
  type WriteFailureLabels,
} from '../src/components/messaging-write';

/**
 * The browser side of the messaging writes (Phase 5-E).
 *
 * The composer and the controls are thin shells over this module, so this is where the rules are pinned:
 *
 *   * a draft is trimmed once, and a whitespace-only draft is not a message;
 *   * nothing is reported as sent unless the server said 201 and the body parsed;
 *   * every request goes to this origin with the session cookie and carries no token;
 *   * a refusal becomes one chosen sentence, and an unrecognised one becomes the generic sentence rather
 *     than the most specific one.
 */

const CONVERSATION = 'e0000000-0000-4000-8000-000000000001';
const LISTING = '11110000-0000-4000-8000-000000000001';

interface Call {
  readonly path: string;
  readonly method: string | undefined;
  readonly credentials: string | undefined;
  readonly body: string | undefined;
  readonly contentType: string | undefined;
}

function recorder(
  responses: Array<{ status: number; body?: unknown; text?: string }> | { status: number; body?: unknown; text?: string },
): { calls: Call[]; fetcher: (input: string, init: RequestInit) => Promise<Response> } {
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const calls: Call[] = [];
  return {
    calls,
    fetcher: async (input, init) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      calls.push({
        path: input,
        method: init.method,
        credentials: init.credentials,
        body: typeof init.body === 'string' ? init.body : undefined,
        contentType: headers['content-type'],
      });
      const next = queue.length > 1 ? queue.shift()! : queue[0]!;
      const text = next.text ?? (next.body === undefined ? '' : JSON.stringify(next.body));
      return new Response(text, { status: next.status });
    },
  };
}

const failing = async (): Promise<Response> => {
  throw new Error('the network is gone');
};

describe('preparing a draft', () => {
  it('trims once and refuses a draft that is only whitespace', () => {
    expect(prepareBody('  hello  ')).toEqual({ body: 'hello' });
    expect(prepareBody('   ')).toEqual({ problem: 'empty' });
    expect(prepareBody('\n\t \r\n')).toEqual({ problem: 'empty' });
    expect(prepareBody('')).toEqual({ problem: 'empty' });
  });

  it('measures the limit after trimming, exactly as the database does', () => {
    const exact = 'x'.repeat(MESSAGE_BODY_MAX_LENGTH);
    expect(prepareBody(`  ${exact}  `)).toEqual({ body: exact });
    expect(prepareBody('x'.repeat(MESSAGE_BODY_MAX_LENGTH + 1))).toEqual({ problem: 'too_long' });
  });

  it('agrees with the contract about what the limit is', () => {
    expect(MESSAGE_BODY_MAX_LENGTH).toBe(5000);
  });
});

describe('the routes', () => {
  it('addresses this origin only, and escapes the conversation id', () => {
    expect(MESSAGING_WRITE_ROUTES.startConversation).toBe('/api/messaging/conversations');
    for (const build of [
      MESSAGING_WRITE_ROUTES.sendMessage,
      MESSAGING_WRITE_ROUTES.markRead,
      MESSAGING_WRITE_ROUTES.setMuted,
      MESSAGING_WRITE_ROUTES.leave,
      MESSAGING_WRITE_ROUTES.close,
    ]) {
      expect(build(CONVERSATION).startsWith('/api/messaging/conversations/')).toBe(true);
      expect(build('../../v1/admin')).not.toContain('../');
    }
  });

  it('has no route for editing, deleting or reopening anything', () => {
    const paths = JSON.stringify(
      Object.values(MESSAGING_WRITE_ROUTES).map((value) =>
        typeof value === 'function' ? value(CONVERSATION) : value,
      ),
    );
    for (const absent of ['edit', 'delete', 'reopen', 'attachment', 'upload']) {
      expect(paths).not.toContain(absent);
    }
  });
});

describe('sending a message', () => {
  it('posts the body to this origin with the session cookie and no token', async () => {
    const { calls, fetcher } = recorder({
      status: 201,
      body: { message: { id: 'a1', seq: '5' } },
    });
    const result = await sendMessage(CONVERSATION, 'Still available?', fetcher);

    expect(result).toEqual({ kind: 'ok', data: { seq: '5' } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe(`/api/messaging/conversations/${CONVERSATION}/messages`);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.credentials).toBe('same-origin');
    expect(calls[0]?.contentType).toBe('application/json');
    expect(calls[0]?.body).toBe(JSON.stringify({ body: 'Still available?' }));
  });

  it('is not a success on a 200, on an unparsable body, or on a body with no sequence', async () => {
    for (const response of [
      { status: 200, body: { message: { seq: '5' } } },
      { status: 201, text: 'not json' },
      { status: 201, body: {} },
      { status: 201, body: { message: {} } },
      { status: 201, body: { message: { seq: 5 } } },
    ]) {
      const { fetcher } = recorder(response);
      const result = await sendMessage(CONVERSATION, 'hello', fetcher);
      expect(result.kind, JSON.stringify(response).slice(0, 50)).not.toBe('ok');
    }
  });

  it('reports a refusal with its status and problem code', async () => {
    const { fetcher } = recorder({
      status: 409,
      body: { status: 409, code: 'MESSAGING_CONVERSATION_CLOSED', detail: 'The conversation is closed.' },
    });
    expect(await sendMessage(CONVERSATION, 'hello', fetcher)).toEqual({
      kind: 'refused',
      status: 409,
      code: 'MESSAGING_CONVERSATION_CLOSED',
    });
  });

  it('reports a refusal with no code when the body carries none', async () => {
    const { fetcher } = recorder({ status: 429, text: '' });
    expect(await sendMessage(CONVERSATION, 'hello', fetcher)).toEqual({
      kind: 'refused',
      status: 429,
      code: null,
    });
  });

  it('reports a request that never left as unavailable, never as sent', async () => {
    expect(await sendMessage(CONVERSATION, 'hello', failing)).toEqual({ kind: 'unavailable' });
  });
});

describe('starting a conversation', () => {
  it('names a listing by id', async () => {
    const { calls, fetcher } = recorder({
      status: 200,
      body: { outcome: 'created', conversationId: CONVERSATION },
    });
    const result = await startListingConversation(LISTING, fetcher);

    expect(result).toEqual({ kind: 'ok', data: { conversationId: CONVERSATION } });
    expect(calls[0]?.body).toBe(JSON.stringify({ subjectType: 'listing', listingId: LISTING }));
  });

  it('names a seller by public slug, and sends no identifier of any kind', async () => {
    const { calls, fetcher } = recorder({
      status: 200,
      body: { outcome: 'reused', conversationId: CONVERSATION },
    });
    const result = await startDirectConversation('good-shop', fetcher);

    expect(result).toEqual({ kind: 'ok', data: { conversationId: CONVERSATION } });
    expect(calls[0]?.body).toBe(JSON.stringify({ subjectType: 'direct', sellerSlug: 'good-shop' }));
    expect(calls[0]?.body).not.toContain('UserId');
    expect(calls[0]?.body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('treats reuse as success, because the conversation to open is the same either way', async () => {
    const { fetcher } = recorder({
      status: 200,
      body: { outcome: 'reused', conversationId: CONVERSATION },
    });
    const result = await startListingConversation(LISTING, fetcher);
    expect(result.kind).toBe('ok');
  });

  it('is not a success when no conversation is named', async () => {
    const { fetcher } = recorder({ status: 200, body: { outcome: 'created' } });
    expect(await startListingConversation(LISTING, fetcher)).toEqual({ kind: 'unavailable' });
  });
});

describe('read state, mute, leave and close', () => {
  it('puts the sequence and reads back where the marker stands', async () => {
    const { calls, fetcher } = recorder({ status: 200, body: { lastReadSeq: '4' } });
    const result = await markRead(CONVERSATION, '9', fetcher);

    expect(result).toEqual({ kind: 'ok', data: { lastReadSeq: '4' } });
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.path).toBe(`/api/messaging/conversations/${CONVERSATION}/read`);
    expect(calls[0]?.body).toBe(JSON.stringify({ seq: '9' }));
  });

  it('accepts a marker that has never moved', async () => {
    const { fetcher } = recorder({ status: 200, body: { lastReadSeq: null } });
    expect(await markRead(CONVERSATION, '1', fetcher)).toEqual({
      kind: 'ok',
      data: { lastReadSeq: null },
    });
  });

  it('sets the mute flag both ways and reports what stands', async () => {
    for (const isMuted of [true, false]) {
      const { calls, fetcher } = recorder({ status: 200, body: { isMuted } });
      expect(await setMuted(CONVERSATION, isMuted, fetcher)).toEqual({ kind: 'ok', data: { isMuted } });
      expect(calls[0]?.body).toBe(JSON.stringify({ isMuted }));
    }
  });

  it('leaves with a DELETE and no body at all', async () => {
    const { calls, fetcher } = recorder({ status: 200, body: { membershipState: 'left' } });
    const result = await leaveConversation(CONVERSATION, fetcher);

    expect(result).toEqual({ kind: 'ok', data: { membershipState: 'left' } });
    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.body).toBeUndefined();
    expect(calls[0]?.contentType).toBeUndefined();
  });

  it('closes with a PUT and no body at all', async () => {
    const { calls, fetcher } = recorder({
      status: 200,
      body: { isClosed: true, closedAt: '2026-09-24T18:30:00.000Z' },
    });
    const result = await closeConversation(CONVERSATION, fetcher);

    expect(result).toEqual({ kind: 'ok', data: { isClosed: true } });
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.path).toBe(`/api/messaging/conversations/${CONVERSATION}/closed`);
    expect(calls[0]?.body).toBeUndefined();
  });

  it('refuses to read a close that does not say it is closed', async () => {
    const { fetcher } = recorder({ status: 200, body: { isClosed: false } });
    expect(await closeConversation(CONVERSATION, fetcher)).toEqual({ kind: 'unavailable' });
  });

  it('refuses to read a leave that does not say it left', async () => {
    const { fetcher } = recorder({ status: 200, body: { membershipState: 'active' } });
    expect(await leaveConversation(CONVERSATION, fetcher)).toEqual({ kind: 'unavailable' });
  });
});

describe('choosing a sentence for a refusal', () => {
  const LABELS: WriteFailureLabels = {
    invalid: 'invalid',
    signedOut: 'signedOut',
    unavailable: 'unavailable',
    closed: 'closed',
    blocked: 'blocked',
    throttled: 'throttled',
    failed: 'failed',
  };

  it('maps each status the API can answer with', () => {
    expect(writeFailureMessage(400, 'VALIDATION_FAILED', LABELS)).toBe('invalid');
    expect(writeFailureMessage(401, 'AUTHENTICATION_REQUIRED', LABELS)).toBe('signedOut');
    expect(writeFailureMessage(404, 'MESSAGING_CONVERSATION_NOT_FOUND', LABELS)).toBe('unavailable');
    expect(writeFailureMessage(429, 'THROTTLED', LABELS)).toBe('throttled');
  });

  it('separates the two things a 409 can mean, by code', () => {
    expect(writeFailureMessage(409, 'MESSAGING_CONVERSATION_CLOSED', LABELS)).toBe('closed');
    expect(writeFailureMessage(409, 'MESSAGING_BLOCKED', LABELS)).toBe('blocked');
    expect(writeFailureMessage(409, 'MESSAGING_SELLER_NOT_CONTACTABLE', LABELS)).toBe('blocked');
  });

  it('falls to the generic sentence rather than guessing', () => {
    expect(writeFailureMessage(409, null, LABELS)).toBe('failed');
    expect(writeFailureMessage(409, 'SOMETHING_NEW', LABELS)).toBe('failed');
    expect(writeFailureMessage(403, 'BAD_REQUEST', LABELS)).toBe('failed');
    expect(writeFailureMessage(500, null, LABELS)).toBe('failed');
    expect(writeFailureMessage(503, 'SERVICE_UNAVAILABLE', LABELS)).toBe('failed');
  });
});

describe('whether the composer may be used', () => {
  it('is open only when the conversation is neither closed nor left', () => {
    expect(composerState({ isClosed: false, hasLeft: false })).toBe('open');
    expect(composerState({ isClosed: true, hasLeft: false })).toBe('closed');
    expect(composerState({ isClosed: false, hasLeft: true })).toBe('left');
  });

  it('reports closed first when both are true, because that is the stronger fact', () => {
    expect(composerState({ isClosed: true, hasLeft: true })).toBe('closed');
  });
});

describe('reporting', () => {
  it('posts the subject and the existing "other" reason, with no details field', async () => {
    const { calls, fetcher } = recorder({
      status: 200,
      body: { outcome: 'filed', reportId: 'c0000000-0000-4000-8000-00000000000a' },
    });
    const result = await fileReport({ kind: 'message', messageId: 'a1' }, fetcher);

    expect(result).toEqual({ kind: 'ok', data: { reportId: 'c0000000-0000-4000-8000-00000000000a' } });
    expect(calls[0]?.path).toBe('/api/messaging/reports');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.credentials).toBe('same-origin');
    expect(calls[0]?.body).toBe(
      JSON.stringify({ subjectType: 'message', subjectId: 'a1', reasonCode: 'other' }),
    );
    // No details field, so the message text cannot travel into report metadata from here.
    expect(calls[0]?.body).not.toContain('details');
  });

  it('reports a conversation by its own id', async () => {
    const { calls, fetcher } = recorder({
      status: 200,
      body: { outcome: 'filed', reportId: 'c0000000-0000-4000-8000-00000000000a' },
    });
    await fileReport({ kind: 'conversation', conversationId: CONVERSATION }, fetcher);

    expect(calls[0]?.body).toBe(
      JSON.stringify({ subjectType: 'conversation', subjectId: CONVERSATION, reasonCode: 'other' }),
    );
  });

  it('invents no reason of its own', async () => {
    const { calls, fetcher } = recorder({
      status: 200,
      body: { outcome: 'filed', reportId: 'c0000000-0000-4000-8000-00000000000a' },
    });
    await fileReport({ kind: 'message', messageId: 'a1' }, fetcher);

    const sent = JSON.parse(calls[0]?.body ?? '{}') as { reasonCode: string };
    // `other` is the existing vocabulary's value for "not specified"; nothing here adds to that list.
    expect(sent.reasonCode).toBe('other');
  });

  it('treats a repeat exactly like a first report: same id, same success', async () => {
    const { fetcher } = recorder({
      status: 200,
      body: { outcome: 'filed', reportId: 'c0000000-0000-4000-8000-00000000000a' },
    });
    const first = await fileReport({ kind: 'message', messageId: 'a1' }, fetcher);
    const second = await fileReport({ kind: 'message', messageId: 'a1' }, fetcher);
    expect(second).toEqual(first);
  });

  it('is not a success on a 201, a missing id, or an unparsable body', async () => {
    for (const response of [
      { status: 201, body: { outcome: 'filed', reportId: 'c0' } },
      { status: 200, body: { outcome: 'filed' } },
      { status: 200, text: 'not json' },
    ]) {
      const { fetcher } = recorder(response);
      const result = await fileReport({ kind: 'message', messageId: 'a1' }, fetcher);
      expect(result.kind, JSON.stringify(response).slice(0, 40)).not.toBe('ok');
    }
  });

  it('reports a refusal with its status and code, and a dead request as unavailable', async () => {
    const { fetcher } = recorder({
      status: 404,
      body: { status: 404, code: 'MESSAGING_REPORT_TARGET_NOT_FOUND' },
    });
    expect(await fileReport({ kind: 'message', messageId: 'a1' }, fetcher)).toEqual({
      kind: 'refused',
      status: 404,
      code: 'MESSAGING_REPORT_TARGET_NOT_FOUND',
    });
    expect(await fileReport({ kind: 'message', messageId: 'a1' }, failing)).toEqual({
      kind: 'unavailable',
    });
  });

  it('addresses the reports route and never a conversation mutation', async () => {
    expect(MESSAGING_WRITE_ROUTES.report).toBe('/api/messaging/reports');
    for (const forbidden of ['/closed', '/muted', '/membership', '/read']) {
      expect(MESSAGING_WRITE_ROUTES.report, forbidden).not.toContain(forbidden);
    }
  });
});
