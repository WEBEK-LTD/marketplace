import { describe, expect, it } from 'vitest';
import {
  handleFaqCreate,
  handleFaqRemove,
  handleFaqState,
  handleFaqUpdate,
  handleFaqsReorder,
  readFaq,
  readFaqTopics,
  readFaqs,
} from '../../src/admin/server/bff/faqs';

/**
 * The help-centre BFF, on the admin origin (0095).
 *
 * What matters at this boundary:
 *
 *   * the caller's token comes from `__Host-mp_admin_access` and never from a body, and the browser's own `Cookie`
 *     header is never forwarded upstream;
 *   * **no publication flag is ever forwarded by an editing handler**, so changing an answer cannot put it on a
 *     public page (owner decision 6);
 *   * **a topic or a cursor from a query string is checked before it is sent**, because both are text somebody may
 *     have typed and the remedy for either is the same first page;
 *   * responses are validated before a byte reaches a browser;
 *   * every write is same-origin, and a cross-origin submission is refused before its body is read.
 *
 * Everything is stubbed at the `fetch` boundary: no API, no database, no network.
 */

const ENV = {
  API_BASE_URL: 'https://api.internal.test',
  INTERNAL_BFF_CREDENTIAL: 'test-faqs-canary-not-realabcdefghijklmnopqr',
} as const;

const SESSION_TOKEN = 'canary-admin-access-token-not-a-real-token';
const COOKIE = `__Host-mp_admin_access=${SESSION_TOKEN}; __Host-mp_admin_refresh=canary-refresh-not-real`;
const ORIGIN = 'https://admin.test';

const FAQ = 'fe000000-0000-4000-8000-0000000000e1';
const SECOND = 'fe000000-0000-4000-8000-0000000000e2';
const ANSWER = 'Open a listing.\n\nThen press buy.';

const SUMMARY = {
  id: FAQ,
  topic: 'faq',
  questionEn: 'How do I buy?',
  questionAr: null,
  answerEn: ANSWER,
  answerAr: null,
  sortOrder: 10,
  isPublished: true,
  isMapped: true,
  pageSlug: 'faq',
  createdAt: '2026-04-01T09:00:00.000Z',
  updatedAt: '2026-05-02T09:00:00.000Z',
};

const DETAIL = { ...SUMMARY, canManage: true };

interface Seen {
  url: string;
  method: string;
  cookie: string | null;
  sessionToken: string | null;
  body: string | null;
}

function apiReturns(status: number, body: unknown, seen: { value?: Seen } = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const sent = new Headers(init?.headers);
    seen.value = {
      url: String(input),
      method: init?.method ?? 'GET',
      cookie: sent.get('cookie'),
      sessionToken: sent.get('x-session-token') ?? sent.get('X-Session-Token'),
      body: typeof init?.body === 'string' ? init.body : null,
    };
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': status < 400 ? 'application/json' : 'application/problem+json' },
    });
  }) as unknown as typeof fetch;
}

function apiUnreachable(): typeof fetch {
  return (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
}

function writeRequest(
  path: string,
  method: string,
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { origin: ORIGIN, 'content-type': 'application/json', cookie: COOKIE, ...headers },
    body: JSON.stringify(body),
  });
}

/* ------------------------------------------------------------------------------------------------ */
/* Reads                                                                                             */
/* ------------------------------------------------------------------------------------------------ */

describe('readFaqs', () => {
  it('presents the session token upstream and never the browser cookie', async () => {
    const seen: { value?: Seen } = {};
    await readFaqs({}, {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReturns(200, { items: [SUMMARY], nextCursor: null, canManage: true }, seen),
    });
    expect(seen.value?.sessionToken).toBe(SESSION_TOKEN);
    expect(seen.value?.cookie).toBeNull();
    expect(seen.value?.url).toContain('/v1/admin/faqs');
  });

  it('is unauthenticated with no session cookie, without calling upstream', async () => {
    const seen: { value?: Seen } = {};
    const result = await readFaqs({}, { env: ENV, cookieHeader: null, fetch: apiReturns(200, {}, seen) });
    expect(result.kind).toBe('unauthenticated');
    expect(seen.value).toBeUndefined();
  });

  it('forwards a topic and a cursor it recognises', async () => {
    const seen: { value?: Seen } = {};
    await readFaqs(
      { topic: 'help', cursor: 'ZnExfGZhcXwxMHxpZA' },
      { env: ENV, cookieHeader: COOKIE, fetch: apiReturns(200, { items: [], nextCursor: null, canManage: false }, seen) },
    );
    expect(seen.value?.url).toContain('topic=help');
    expect(seen.value?.url).toContain('cursor=ZnExfGZhcXwxMHxpZA');
  });

  it('drops a topic or a cursor that could not be one, rather than forwarding it', async () => {
    const seen: { value?: Seen } = {};
    await readFaqs(
      { topic: 'NOT A TOPIC', cursor: 'has spaces and !!' },
      { env: ENV, cookieHeader: COOKIE, fetch: apiReturns(200, { items: [], nextCursor: null, canManage: false }, seen) },
    );
    expect(seen.value?.url).not.toContain('topic=');
    expect(seen.value?.url).not.toContain('cursor=');
  });

  it('carries the capability flag and the mapping', async () => {
    const result = await readFaqs({}, {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReturns(200, {
        items: [{ ...SUMMARY, isMapped: false, pageSlug: null }],
        nextCursor: null,
        canManage: false,
      }),
    });
    expect(result.kind === 'ok' && result.data.canManage).toBe(false);
    expect(result.kind === 'ok' && result.data.items[0]?.isMapped).toBe(false);
  });

  it('keeps an answers blank lines exactly as they arrived', async () => {
    const result = await readFaqs({}, {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReturns(200, { items: [SUMMARY], nextCursor: null, canManage: true }),
    });
    expect(result.kind === 'ok' && result.data.items[0]?.answerEn).toBe(ANSWER);
  });

  it('turns every other answer into its own outcome', async () => {
    const cases: readonly [number, string][] = [
      [401, 'unauthenticated'],
      [404, 'notFound'],
      [400, 'invalid'],
      [503, 'unavailable'],
      [500, 'unavailable'],
    ];
    for (const [status, kind] of cases) {
      const result = await readFaqs({}, {
        env: ENV,
        cookieHeader: COOKIE,
        fetch: apiReturns(status, { status, code: 'X' }),
      });
      expect(result.kind, String(status)).toBe(kind);
    }
    expect((await readFaqs({}, { env: ENV, cookieHeader: COOKIE, fetch: apiUnreachable() })).kind).toBe(
      'unavailable',
    );
  });

  it('refuses a drifted body rather than handing it to a screen', async () => {
    const result = await readFaqs({}, {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReturns(200, {
        items: [{ ...SUMMARY, structuredData: {} }],
        nextCursor: null,
        canManage: true,
      }),
    });
    expect(result.kind).toBe('unavailable');
  });
});

describe('readFaqTopics and readFaq', () => {
  it('read the topics with both counts', async () => {
    const result = await readFaqTopics({
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReturns(200, {
        topics: [
          { topic: 'faq', entryCount: 3, publishedCount: 2, isMapped: true, pageSlug: 'faq' },
          { topic: 'shipping', entryCount: 1, publishedCount: 0, isMapped: false, pageSlug: null },
        ],
      }),
    });
    expect(result.kind === 'ok' && result.data.topics[1]?.isMapped).toBe(false);
  });

  it('read one entry by identifier', async () => {
    const seen: { value?: Seen } = {};
    const result = await readFaq(FAQ, { env: ENV, cookieHeader: COOKIE, fetch: apiReturns(200, { faq: DETAIL }, seen) });
    expect(result.kind === 'ok' && result.data.canManage).toBe(true);
    expect(seen.value?.url).toContain(`/v1/admin/faqs/${FAQ}`);
  });

  it('are notFound for an identifier that could not be one, without calling upstream', async () => {
    const seen: { value?: Seen } = {};
    const result = await readFaq('not-a-uuid', { env: ENV, cookieHeader: COOKIE, fetch: apiReturns(200, {}, seen) });
    expect(result.kind).toBe('notFound');
    expect(seen.value).toBeUndefined();
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* Writes                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

describe('creating an entry', () => {
  it('rebuilds the body from declared fields and presents the token', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleFaqCreate(
      writeRequest('/api/faqs', 'POST', {
        topic: 'faq',
        questionEn: 'How do I buy?',
        questionAr: 'كيف أشتري؟',
        answerEn: ANSWER,
        // Two fields nobody declared, one of which would publish it.
        isPublished: true,
        createdBy: 'somebody',
      }),
      { env: ENV, fetch: apiReturns(201, { id: FAQ }, seen) },
    );
    expect(response.status).toBe(201);
    expect(seen.value?.sessionToken).toBe(SESSION_TOKEN);
    expect(seen.value?.cookie).toBeNull();
    const sent = JSON.parse(seen.value?.body ?? '{}') as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(['answerEn', 'questionAr', 'questionEn', 'topic']);
    expect('isPublished' in sent).toBe(false);
  });

  it('keeps an answers blank lines on the way upstream', async () => {
    const seen: { value?: Seen } = {};
    await handleFaqCreate(
      writeRequest('/api/faqs', 'POST', { topic: 'faq', questionEn: 'Q?', answerEn: ANSWER }),
      { env: ENV, fetch: apiReturns(201, { id: FAQ }, seen) },
    );
    expect((JSON.parse(seen.value?.body ?? '{}') as { answerEn: string }).answerEn).toBe(ANSWER);
  });

  it('refuses a topic that is not 0030s shape, and a create with no English wording', async () => {
    for (const body of [
      { topic: 'FAQ', questionEn: 'Q?', answerEn: 'A.' },
      { topic: 'faq-help', questionEn: 'Q?', answerEn: 'A.' },
      { topic: 'faq', answerEn: 'A.' },
      { topic: 'faq', questionEn: 'Q?' },
      { topic: 'faq', questionEn: '  ', answerEn: 'A.' },
    ]) {
      const response = await handleFaqCreate(writeRequest('/api/faqs', 'POST', body), {
        env: ENV,
        fetch: apiReturns(201, { id: FAQ }),
      });
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('refuses a cross-origin submission before reading its body', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleFaqCreate(
      writeRequest('/api/faqs', 'POST', { topic: 'faq', questionEn: 'Q?', answerEn: 'A.' }, {
        origin: 'https://evil.test',
      }),
      { env: ENV, fetch: apiReturns(201, { id: FAQ }, seen) },
    );
    expect(response.status).toBe(403);
    expect(seen.value).toBeUndefined();
  });

  it('is unauthenticated with no session cookie', async () => {
    const response = await handleFaqCreate(
      new Request(`${ORIGIN}/api/faqs`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ topic: 'faq', questionEn: 'Q?', answerEn: 'A.' }),
      }),
      { env: ENV, fetch: apiReturns(201, { id: FAQ }) },
    );
    expect(response.status).toBe(401);
  });

  it('forwards a refusal with its own code', async () => {
    const response = await handleFaqCreate(
      writeRequest('/api/faqs', 'POST', { topic: 'faq', questionEn: 'Q?', answerEn: 'A.' }),
      { env: ENV, fetch: apiReturns(409, { status: 409, code: 'FAQ_NOT_ALLOWED' }) },
    );
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('FAQ_NOT_ALLOWED');
  });
});

describe('changing an entry', () => {
  it('never forwards a publication flag', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleFaqUpdate(
      writeRequest('/api/faqs', 'PATCH', { faqId: FAQ, questionEn: 'How do I buy?', isPublished: false }),
      { env: ENV, fetch: apiReturns(200, { ok: true }, seen) },
    );
    expect(response.status).toBe(200);
    expect('isPublished' in (JSON.parse(seen.value?.body ?? '{}') as object)).toBe(false);
    expect(seen.value?.method).toBe('PATCH');
  });

  it('keeps a null Arabic wording, which clears it, apart from an absent one', async () => {
    const cleared: { value?: Seen } = {};
    await handleFaqUpdate(writeRequest('/api/faqs', 'PATCH', { faqId: FAQ, answerAr: null }), {
      env: ENV,
      fetch: apiReturns(200, { ok: true }, cleared),
    });
    expect(JSON.parse(cleared.value?.body ?? '{}')).toEqual({ answerAr: null });

    const untouched: { value?: Seen } = {};
    await handleFaqUpdate(writeRequest('/api/faqs', 'PATCH', { faqId: FAQ, answerEn: 'A longer answer.' }), {
      env: ENV,
      fetch: apiReturns(200, { ok: true }, untouched),
    });
    expect(JSON.parse(untouched.value?.body ?? '{}')).toEqual({ answerEn: 'A longer answer.' });
  });

  it('refuses a body with no identifier and one with nothing to change', async () => {
    const noId = await handleFaqUpdate(writeRequest('/api/faqs', 'PATCH', { questionEn: 'Q?' }), {
      env: ENV,
      fetch: apiReturns(200, { ok: true }),
    });
    const nothing = await handleFaqUpdate(writeRequest('/api/faqs', 'PATCH', { faqId: FAQ }), {
      env: ENV,
      fetch: apiReturns(200, { ok: true }),
    });
    expect(noId.status).toBe(400);
    expect(nothing.status).toBe(400);
  });
});

describe('publishing, reordering and removing', () => {
  it('each uses its own upstream route and method', async () => {
    const state: { value?: Seen } = {};
    const published = await handleFaqState(
      writeRequest('/api/faqs/state', 'POST', { faqId: FAQ, isPublished: true }),
      { env: ENV, fetch: apiReturns(200, { ok: true }, state) },
    );
    expect(published.status).toBe(200);
    expect(state.value?.method).toBe('PUT');
    expect(state.value?.url).toContain(`/faqs/${FAQ}/state`);

    const reorder: { value?: Seen } = {};
    await handleFaqsReorder(
      writeRequest('/api/faqs/reorder', 'POST', { topic: 'faq', faqIds: [SECOND, FAQ] }),
      { env: ENV, fetch: apiReturns(200, { ok: true }, reorder) },
    );
    expect(reorder.value?.method).toBe('PUT');
    expect(JSON.parse(reorder.value?.body ?? '{}')).toEqual({ topic: 'faq', faqIds: [SECOND, FAQ] });

    const remove: { value?: Seen } = {};
    await handleFaqRemove(writeRequest('/api/faqs/remove', 'POST', { faqId: FAQ }), {
      env: ENV,
      fetch: apiReturns(200, { ok: true }, remove),
    });
    expect(remove.value?.method).toBe('DELETE');
    expect(remove.value?.body).toBeNull();
  });

  it('refuses a state change with no flag in it', async () => {
    const response = await handleFaqState(writeRequest('/api/faqs/state', 'POST', { faqId: FAQ }), {
      env: ENV,
      fetch: apiReturns(200, { ok: true }),
    });
    expect(response.status).toBe(400);
  });

  it('refuses an empty order, a missing topic and an entry that is not an identifier', async () => {
    for (const body of [
      { topic: 'faq', faqIds: [] },
      { faqIds: [FAQ] },
      { topic: 'faq', faqIds: ['not-a-uuid'] },
    ]) {
      const response = await handleFaqsReorder(writeRequest('/api/faqs/reorder', 'POST', body), {
        env: ENV,
        fetch: apiReturns(200, { ok: true }),
      });
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('refuses an identifier that could not be one, without calling upstream', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleFaqRemove(writeRequest('/api/faqs/remove', 'POST', { faqId: 'nope' }), {
      env: ENV,
      fetch: apiReturns(200, { ok: true }, seen),
    });
    expect(response.status).toBe(400);
    expect(seen.value).toBeUndefined();
  });

  it('becomes an outage when the API cannot be reached, or answers something nobody declared', async () => {
    const unreachable = await handleFaqsReorder(
      writeRequest('/api/faqs/reorder', 'POST', { topic: 'faq', faqIds: [FAQ] }),
      { env: ENV, fetch: apiUnreachable() },
    );
    const drifted = await handleFaqsReorder(
      writeRequest('/api/faqs/reorder', 'POST', { topic: 'faq', faqIds: [FAQ] }),
      { env: ENV, fetch: apiReturns(200, { ok: 'yes' }) },
    );
    expect(unreachable.status).toBe(503);
    expect(drifted.status).toBe(503);
  });
});
