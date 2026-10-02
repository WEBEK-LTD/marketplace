import { describe, expect, it } from 'vitest';
import {
  handleCloseConversation,
  handleFileReport,
  handleLeaveConversation,
  handleMarkRead,
  handleSendMessage,
  handleSetMuted,
  handleStartConversation,
} from '../src/server/bff/messaging';
import { SESSION_COOKIES } from '../src/server/bff/session-cookies';

/**
 * The BFF half of the messaging writes (Phase 5-E).
 *
 * The properties this boundary owes the browser:
 *
 *   * a state-changing request is refused unless its `Origin` is this origin;
 *   * the session comes from the `__Host-mp_access` cookie and leaves as one header on one internal
 *     hop — the browser's `Cookie` header is never forwarded, and no token reaches a response;
 *   * the internal credential and the upstream address never appear in a body;
 *   * a response is rebuilt from the validated contract, so a drifted upstream body becomes a clean
 *     failure rather than something a page renders;
 *   * an upstream refusal keeps its own status and code, and an unexpected status becomes 503 rather
 *     than a success.
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
const LISTING = '11110000-0000-4000-8000-000000000001';

const MESSAGE = {
  id: 'a1000000-0000-4000-8000-000000000005',
  seq: '5',
  conversationId: CONVERSATION,
  senderUserId: '22222222-2222-4222-8222-222222222222',
  isOwnMessage: true,
  messageType: 'text',
  body: 'Still available?',
  referenceType: null,
  referenceId: null,
  createdAt: '2026-09-24T18:30:00.000Z',
  editedAt: null,
  deletedAt: null,
};

interface Seen {
  readonly url: string;
  readonly method: string | undefined;
  readonly headers: Headers;
  readonly body: string | undefined;
}

function upstream(
  status: number,
  body: unknown,
  seen: Seen[],
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    seen.push({
      url: String(input),
      method: init?.method,
      headers: new Headers(init?.headers as HeadersInit),
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(text, {
      status,
      headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
    });
  };
}

function request(
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(`https://web.test/api/messaging/${path}`, {
    method,
    headers: {
      origin: 'https://web.test',
      cookie: COOKIE,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const problem = (status: number, code: string) => ({
  type: 'about:blank',
  title: 'Refused',
  status,
  detail: 'A sentence the API owns.',
  instance: '/v1/messaging/conversations',
  code,
});

describe('the Origin check', () => {
  it('refuses every write from another origin, without calling the API', async () => {
    const seen: Seen[] = [];
    const options = { env: ENV, fetch: upstream(200, {}, seen) };

    const refusals = [
      await handleStartConversation(
        request('POST', 'conversations', { subjectType: 'listing', listingId: LISTING }, {
          origin: 'https://evil.test',
        }),
        options,
      ),
      await handleSendMessage(
        request('POST', `conversations/${CONVERSATION}/messages`, { body: 'hi' }, {
          origin: 'https://evil.test',
        }),
        CONVERSATION,
        options,
      ),
      await handleMarkRead(
        request('PUT', `conversations/${CONVERSATION}/read`, { seq: '5' }, { origin: 'https://evil.test' }),
        CONVERSATION,
        options,
      ),
      await handleSetMuted(
        request('PUT', `conversations/${CONVERSATION}/muted`, { isMuted: true }, {
          origin: 'https://evil.test',
        }),
        CONVERSATION,
        options,
      ),
      await handleLeaveConversation(
        request('DELETE', `conversations/${CONVERSATION}/membership`, undefined, {
          origin: 'https://evil.test',
        }),
        CONVERSATION,
        options,
      ),
      await handleCloseConversation(
        request('PUT', `conversations/${CONVERSATION}/closed`, undefined, {
          origin: 'https://evil.test',
        }),
        CONVERSATION,
        options,
      ),
    ];

    for (const response of refusals) expect(response.status).toBe(403);
    expect(seen).toHaveLength(0);
  });
});

describe('the session', () => {
  it('refuses every write with no access cookie, without calling the API', async () => {
    const seen: Seen[] = [];
    const options = { env: ENV, fetch: upstream(200, {}, seen), cookieHeader: '' };

    const responses = [
      await handleStartConversation(
        request('POST', 'conversations', { subjectType: 'listing', listingId: LISTING }),
        options,
      ),
      await handleSendMessage(
        request('POST', `conversations/${CONVERSATION}/messages`, { body: 'hi' }),
        CONVERSATION,
        options,
      ),
      await handleLeaveConversation(
        request('DELETE', `conversations/${CONVERSATION}/membership`),
        CONVERSATION,
        options,
      ),
    ];

    for (const response of responses) expect(response.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('sends the token as one header and never forwards the browser’s cookie', async () => {
    const seen: Seen[] = [];
    await handleSendMessage(
      request('POST', `conversations/${CONVERSATION}/messages`, { body: 'Still available?' }),
      CONVERSATION,
      { env: ENV, fetch: upstream(201, { message: MESSAGE }, seen) },
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers.get('x-session-token')).toBe(ACCESS_TOKEN);
    expect(seen[0]?.headers.get('cookie')).toBeNull();
    expect(seen[0]?.body).toBe(JSON.stringify({ body: 'Still available?' }));
  });

  it('never lets a token, a credential or the upstream address into a response', async () => {
    const seen: Seen[] = [];
    const response = await handleSendMessage(
      request('POST', `conversations/${CONVERSATION}/messages`, { body: 'hi' }),
      CONVERSATION,
      { env: ENV, fetch: upstream(201, { message: MESSAGE }, seen) },
    );
    const text = await response.text();

    for (const secret of [ACCESS_TOKEN, REFRESH_TOKEN, ENV.INTERNAL_BFF_CREDENTIAL, ENV.API_BASE_URL]) {
      expect(text).not.toContain(secret);
    }
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('the six operations', () => {
  it('starts a conversation and passes the answer through', async () => {
    const seen: Seen[] = [];
    const response = await handleStartConversation(
      request('POST', 'conversations', { subjectType: 'direct', sellerSlug: 'good-shop' }),
      { env: ENV, fetch: upstream(200, { outcome: 'created', conversationId: CONVERSATION }, seen) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: 'created', conversationId: CONVERSATION });
    expect(seen[0]?.url).toBe('https://api.internal.test/v1/messaging/conversations');
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.body).toBe(JSON.stringify({ subjectType: 'direct', sellerSlug: 'good-shop' }));
  });

  it('sends a message and keeps the 201', async () => {
    const seen: Seen[] = [];
    const response = await handleSendMessage(
      request('POST', `conversations/${CONVERSATION}/messages`, { body: 'hi' }),
      CONVERSATION,
      { env: ENV, fetch: upstream(201, { message: MESSAGE }, seen) },
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ message: MESSAGE });
  });

  it('moves the read marker, sets the mute flag, leaves and closes', async () => {
    const cases: Array<[Promise<Response>, unknown, string, string]> = [];
    const seen: Seen[] = [];

    cases.push([
      handleMarkRead(request('PUT', `conversations/${CONVERSATION}/read`, { seq: '5' }), CONVERSATION, {
        env: ENV,
        fetch: upstream(200, { lastReadSeq: '5' }, seen),
      }),
      { lastReadSeq: '5' },
      'PUT',
      `https://api.internal.test/v1/messaging/conversations/${CONVERSATION}/read`,
    ]);
    cases.push([
      handleSetMuted(
        request('PUT', `conversations/${CONVERSATION}/muted`, { isMuted: true }),
        CONVERSATION,
        { env: ENV, fetch: upstream(200, { isMuted: true }, seen) },
      ),
      { isMuted: true },
      'PUT',
      `https://api.internal.test/v1/messaging/conversations/${CONVERSATION}/muted`,
    ]);
    cases.push([
      handleLeaveConversation(
        request('DELETE', `conversations/${CONVERSATION}/membership`),
        CONVERSATION,
        { env: ENV, fetch: upstream(200, { membershipState: 'left' }, seen) },
      ),
      { membershipState: 'left' },
      'DELETE',
      `https://api.internal.test/v1/messaging/conversations/${CONVERSATION}/membership`,
    ]);
    cases.push([
      handleCloseConversation(request('PUT', `conversations/${CONVERSATION}/closed`), CONVERSATION, {
        env: ENV,
        fetch: upstream(200, { isClosed: true, closedAt: '2026-09-24T18:30:00.000Z' }, seen),
      }),
      { isClosed: true, closedAt: '2026-09-24T18:30:00.000Z' },
      'PUT',
      `https://api.internal.test/v1/messaging/conversations/${CONVERSATION}/closed`,
    ]);

    for (const [pending, expected, method, url] of cases) {
      const response = await pending;
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(expected);
      expect(seen.some((call) => call.method === method && call.url === url)).toBe(true);
    }

    // Neither leaving nor closing sends a body: there is nothing either could carry.
    const withoutBody = seen.filter((call) => call.method === 'DELETE' || call.url.endsWith('/closed'));
    for (const call of withoutBody) expect(call.body).toBeUndefined();
  });

  it('escapes the conversation id rather than pasting it into a path', async () => {
    const seen: Seen[] = [];
    await handleMarkRead(request('PUT', 'conversations/x/read', { seq: '5' }), '../../v1/admin', {
      env: ENV,
      fetch: upstream(200, { lastReadSeq: '5' }, seen),
    });
    expect(seen[0]?.url).not.toContain('../');
    expect(seen[0]?.url).toContain('%2F');
  });
});

describe('refusals and drift', () => {
  it('passes a recognised refusal through with its own status and code', async () => {
    const seen: Seen[] = [];
    for (const [status, code] of [
      [400, 'VALIDATION_FAILED'],
      [401, 'AUTHENTICATION_REQUIRED'],
      [403, 'BAD_REQUEST'],
      [404, 'MESSAGING_CONVERSATION_NOT_FOUND'],
      [409, 'MESSAGING_CONVERSATION_CLOSED'],
      [429, 'THROTTLED'],
    ] as const) {
      const response = await handleSendMessage(
        request('POST', `conversations/${CONVERSATION}/messages`, { body: 'hi' }),
        CONVERSATION,
        { env: ENV, fetch: upstream(status, problem(status, code), seen) },
      );
      expect(response.status, code).toBe(status);
      expect(response.headers.get('content-type')).toBe('application/problem+json');
      expect(((await response.json()) as { code: string }).code).toBe(code);
    }
  });

  it('turns an unexpected upstream status into 503 rather than a success', async () => {
    const seen: Seen[] = [];
    for (const status of [200, 204, 301, 418, 500, 503]) {
      const response = await handleSendMessage(
        request('POST', `conversations/${CONVERSATION}/messages`, { body: 'hi' }),
        CONVERSATION,
        { env: ENV, fetch: upstream(status, { message: MESSAGE }, seen) },
      );
      expect(response.status, String(status)).toBe(503);
    }
  });

  it('turns a drifted success body into 503', async () => {
    const seen: Seen[] = [];
    for (const body of [
      'not json',
      {},
      { message: {} },
      { message: { ...MESSAGE, seq: 5 } },
      { message: MESSAGE, extra: true },
    ]) {
      const response = await handleSendMessage(
        request('POST', `conversations/${CONVERSATION}/messages`, { body: 'hi' }),
        CONVERSATION,
        { env: ENV, fetch: upstream(201, body, seen) },
      );
      expect(response.status, JSON.stringify(body).slice(0, 40)).toBe(503);
    }
  });

  it('turns an upstream that cannot be reached into 503', async () => {
    const response = await handleCloseConversation(
      request('PUT', `conversations/${CONVERSATION}/closed`),
      CONVERSATION,
      {
        env: ENV,
        fetch: async () => {
          throw new Error('connection refused');
        },
      },
    );
    expect(response.status).toBe(503);
  });

  it('refuses an unparsable request body before calling the API', async () => {
    const seen: Seen[] = [];
    const broken = new Request(`https://web.test/api/messaging/conversations`, {
      method: 'POST',
      headers: { origin: 'https://web.test', cookie: COOKIE, 'content-type': 'application/json' },
      body: '{ not json',
    });
    const response = await handleStartConversation(broken, { env: ENV, fetch: upstream(200, {}, seen) });

    expect(response.status).toBe(400);
    expect(seen).toHaveLength(0);
  });
});

describe('reporting (Phase 5-H)', () => {
  const REPORT = 'c0000000-0000-4000-8000-00000000000a';
  const body = { subjectType: 'message', subjectId: 'a1000000-0000-4000-8000-000000000005', reasonCode: 'other' };

  it('posts to the API and rebuilds the answer from the contract', async () => {
    const seen: Seen[] = [];
    const response = await handleFileReport(request('POST', 'reports', body), {
      env: ENV,
      fetch: upstream(200, { outcome: 'filed', reportId: REPORT }, seen),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: 'filed', reportId: REPORT });
    expect(seen[0]?.url).toBe('https://api.internal.test/v1/messaging/reports');
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.body).toBe(JSON.stringify(body));
  });

  it('addresses the API and nothing else: the upstream URL is not something a request can choose', async () => {
    const seen: Seen[] = [];
    const forged = new Request('https://web.test/api/messaging/reports?upstream=https://evil.test', {
      method: 'POST',
      headers: { origin: 'https://web.test', cookie: COOKIE, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    await handleFileReport(forged, {
      env: ENV,
      fetch: upstream(200, { outcome: 'filed', reportId: REPORT }, seen),
    });

    expect(seen[0]?.url).toBe('https://api.internal.test/v1/messaging/reports');
    expect(seen[0]?.url).not.toContain('evil.test');
  });

  it('refuses a report from another origin, without calling the API', async () => {
    const seen: Seen[] = [];
    const response = await handleFileReport(
      request('POST', 'reports', body, { origin: 'https://evil.test' }),
      { env: ENV, fetch: upstream(200, {}, seen) },
    );

    expect(response.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it('refuses a report with no access cookie, without calling the API', async () => {
    const seen: Seen[] = [];
    const response = await handleFileReport(request('POST', 'reports', body), {
      env: ENV,
      fetch: upstream(200, {}, seen),
      cookieHeader: '',
    });

    expect(response.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('sends the session as one header and never forwards the browser’s cookie', async () => {
    const seen: Seen[] = [];
    await handleFileReport(request('POST', 'reports', body), {
      env: ENV,
      fetch: upstream(200, { outcome: 'filed', reportId: REPORT }, seen),
    });

    expect(seen[0]?.headers.get('x-session-token')).toBe(ACCESS_TOKEN);
    expect(seen[0]?.headers.get('cookie')).toBeNull();
  });

  it('passes a refusal through with its own status and code', async () => {
    const seen: Seen[] = [];
    for (const [status, code] of [
      [400, 'VALIDATION_FAILED'],
      [401, 'AUTHENTICATION_REQUIRED'],
      [404, 'MESSAGING_REPORT_TARGET_NOT_FOUND'],
      [429, 'THROTTLED'],
    ] as const) {
      const response = await handleFileReport(request('POST', 'reports', body), {
        env: ENV,
        fetch: upstream(status, problem(status, code), seen),
      });
      expect(response.status, code).toBe(status);
      expect(response.headers.get('content-type')).toBe('application/problem+json');
      expect(((await response.json()) as { code: string }).code).toBe(code);
    }
  });

  it('turns an unexpected status or a drifted body into 503 rather than a success', async () => {
    const seen: Seen[] = [];
    for (const [status, payload] of [
      [201, { outcome: 'filed', reportId: REPORT }],
      [200, { outcome: 'created', reportId: REPORT }],
      [200, { outcome: 'filed' }],
      [200, { outcome: 'filed', reportId: 'not-a-uuid' }],
      [200, { outcome: 'filed', reportId: REPORT, extra: true }],
      [500, { outcome: 'filed', reportId: REPORT }],
    ] as const) {
      const response = await handleFileReport(request('POST', 'reports', body), {
        env: ENV,
        fetch: upstream(status, payload, seen),
      });
      expect(response.status, `${status} ${JSON.stringify(payload)}`).toBe(503);
    }
  });

  it('leaks no token, credential or upstream address into its answer', async () => {
    const seen: Seen[] = [];
    const response = await handleFileReport(request('POST', 'reports', body), {
      env: ENV,
      fetch: upstream(200, { outcome: 'filed', reportId: REPORT }, seen),
    });
    const text = await response.text();

    for (const secret of [ACCESS_TOKEN, REFRESH_TOKEN, ENV.INTERNAL_BFF_CREDENTIAL, ENV.API_BASE_URL]) {
      expect(text, secret).not.toContain(secret);
    }
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
