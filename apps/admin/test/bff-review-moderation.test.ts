import { describe, expect, it } from 'vitest';
import {
  handleReviewModeration,
  readReview,
  readReviewModerationActions,
  readReviewQueue,
} from '../src/server/bff/review-moderation';

/**
 * The review moderation BFF, on the admin origin (Phase 7-P).
 *
 * What matters at this boundary:
 *
 *   * the caller's token comes from `__Host-mp_admin_access` and never from a body, and the browser's own
 *     `Cookie` header is never forwarded upstream;
 *   * **the body is rebuilt, never forwarded** — a `moderatorUserId`, a `moderatedAt`, an `autoHiddenReason`,
 *     a `publishedAt`, a `rating` or anything naming the reply never crosses;
 *   * a review is named by its id in the **route**, from a value checked for shape here;
 *   * responses are validated against the contract before a byte reaches a browser, so a drifted API that
 *     sent the buyer's account, the seller's account or the order behind the review would produce a clean
 *     failure rather than a leak;
 *   * the refusal a screen must act on — the moderator who is a party — is forwarded with the API's own
 *     problem body, and anything else becomes one 503;
 *   * **there is no handler here that moderates a reply**, which is asserted rather than assumed, because
 *     that is a reported capability gap.
 *
 * Everything is stubbed at the `fetch` boundary: no API, no database, no network.
 */

const ENV = {
  API_BASE_URL: 'https://api.internal.test',
  INTERNAL_BFF_CREDENTIAL: 'test-review-moderation-canary-credential-ab',
} as const;

const SESSION_TOKEN = 'canary-admin-access-token-not-a-real-token';
const COOKIE = `__Host-mp_admin_access=${SESSION_TOKEN}; __Host-mp_admin_refresh=canary-refresh-not-real`;
const ORIGIN = 'https://admin.test';

const REVIEW = 'a9000000-0000-4000-8000-000000000001';

const QUEUE_ROW = {
  id: REVIEW,
  rating: 2,
  title: 'Late and damaged',
  status: 'published',
  hasBody: true,
  autoHiddenReason: null,
  isModerated: false,
  moderatedByMe: false,
  isParty: false,
  sellerSlug: 'a-shop',
  sellerDisplayName: 'A Shop',
  hasReply: true,
  replyStatus: 'published',
  createdAt: '2026-05-01T09:00:00.000Z',
};

const DETAIL = {
  id: REVIEW,
  rating: 2,
  title: 'Late and damaged',
  body: 'It arrived a week late.',
  status: 'published',
  autoHiddenReason: null,
  moderationReason: null,
  moderatedAt: null,
  moderatedByMe: false,
  isParty: false,
  canModerate: true,
  publicationBlock: 'order_refunded',
  sellerSlug: 'a-shop',
  sellerDisplayName: 'A Shop',
  sellerStatus: 'active',
  replyBody: 'We are sorry.',
  replyStatus: 'published',
  replyModerationReason: null,
  replyCreatedAt: '2026-05-02T09:00:00.000Z',
  createdAt: '2026-05-01T09:00:00.000Z',
  updatedAt: '2026-05-01T09:00:00.000Z',
};

const ACTION_ROW = {
  id: 'b9000000-0000-4000-8000-000000000001',
  action: 'hide',
  reason: 'Names another buyer.',
  notes: null,
  reportId: null,
  isOwnAction: false,
  createdAt: '2026-05-03T09:00:00.000Z',
};

interface Seen {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string;
}

function api(status: number, payload: unknown, seen: Seen[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers as HeadersInit),
      body: typeof init?.body === 'string' ? init.body : '',
    });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
    });
  }) as unknown as typeof fetch;
}

function postRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/reviews/moderation`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json', cookie: COOKIE, ...headers },
    body: JSON.stringify(body),
  });
}

const OPTIONS = { env: ENV, cookieHeader: COOKIE } as const;
const DECISION = { reviewId: REVIEW, status: 'hidden', reason: 'Names another buyer.' } as const;
const MODERATED = { outcome: 'moderated', status: 'hidden' } as const;

/* ------------------------------------------------------------------------------------------------ */

describe('the three reads', () => {
  it('present the caller’s token and the internal credential, and never the browser cookie', async () => {
    const seen: Seen[] = [];
    await readReviewQueue({}, { ...OPTIONS, fetch: api(200, { items: [QUEUE_ROW], nextCursor: null }, seen) });

    expect(seen[0]!.url).toBe('https://api.internal.test/v1/admin/reviews');
    expect(seen[0]!.method).toBe('GET');
    expect(seen[0]!.headers.get('x-session-token')).toBe(SESSION_TOKEN);
    expect(seen[0]!.headers.get('x-internal-credential')).toBe(ENV.INTERNAL_BFF_CREDENTIAL);
    expect(seen[0]!.headers.get('cookie')).toBeNull();
  });

  it('address every read at the path the contract names, with the identifier lower-cased', async () => {
    const seen: Seen[] = [];
    await readReviewQueue({}, { ...OPTIONS, fetch: api(200, { items: [], nextCursor: null }, seen) });
    await readReview(REVIEW.toUpperCase(), { ...OPTIONS, fetch: api(200, { review: DETAIL }, seen) });
    await readReviewModerationActions(REVIEW, { ...OPTIONS, fetch: api(200, { items: [] }, seen) });

    expect(seen.map((entry) => entry.url.replace('https://api.internal.test', ''))).toEqual([
      '/v1/admin/reviews',
      `/v1/admin/reviews/${REVIEW}`,
      `/v1/admin/reviews/${REVIEW}/actions`,
    ]);
    expect(seen.every((entry) => entry.method === 'GET' && entry.body === '')).toBe(true);
  });

  it('answer notFound to a malformed address without calling the API at all', async () => {
    const seen: Seen[] = [];
    const fetcher = api(200, {}, seen);
    expect((await readReview('not-a-uuid', { ...OPTIONS, fetch: fetcher })).kind).toBe('notFound');
    expect((await readReview(undefined, { ...OPTIONS, fetch: fetcher })).kind).toBe('notFound');
    expect((await readReviewModerationActions('', { ...OPTIONS, fetch: fetcher })).kind).toBe('notFound');
    expect(seen).toHaveLength(0);
  });

  it('answer unauthenticated without a session cookie, and never call the API', async () => {
    const seen: Seen[] = [];
    const result = await readReviewQueue({}, { env: ENV, cookieHeader: null, fetch: api(200, {}, seen) });
    expect(result.kind).toBe('unauthenticated');
    expect(seen).toHaveLength(0);
  });

  it('turn each upstream status into the one state a screen renders', async () => {
    for (const [status, kind] of [
      [401, 'unauthenticated'],
      [404, 'notFound'],
      [400, 'invalid'],
      [403, 'unavailable'],
      [500, 'unavailable'],
      [503, 'unavailable'],
    ] as const) {
      const result = await readReviewQueue({}, { ...OPTIONS, fetch: api(status, {}) });
      expect(result.kind, String(status)).toBe(kind);
    }
  });

  it('turn a fetch that throws into one outage', async () => {
    const thrower = (async () => {
      throw new Error('network');
    }) as unknown as typeof fetch;
    expect((await readReviewQueue({}, { ...OPTIONS, fetch: thrower })).kind).toBe('unavailable');
    expect((await readReview(REVIEW, { ...OPTIONS, fetch: thrower })).kind).toBe('unavailable');
  });

  it('refuse a body the contract does not describe rather than forwarding it', async () => {
    // The third wall: even a drifted API cannot put the buyer's account on a screen through this layer.
    const drifted = {
      review: { ...DETAIL, buyerUserId: '33333333-3333-4333-8333-333333333333' },
    };
    expect((await readReview(REVIEW, { ...OPTIONS, fetch: api(200, drifted) })).kind).toBe('unavailable');

    const missing = { items: [{ ...QUEUE_ROW, sellerSlug: undefined }], nextCursor: null };
    expect((await readReviewQueue({}, { ...OPTIONS, fetch: api(200, missing) })).kind).toBe('unavailable');
  });

  it('unwrap what the contract wraps', async () => {
    const detail = await readReview(REVIEW, { ...OPTIONS, fetch: api(200, { review: DETAIL }) });
    expect(detail.kind === 'ok' && detail.data.id).toBe(REVIEW);

    const actions = await readReviewModerationActions(REVIEW, {
      ...OPTIONS,
      fetch: api(200, { items: [ACTION_ROW] }),
    });
    expect(actions.kind === 'ok' && actions.data.items).toHaveLength(1);
  });
});

describe('the queue’s query string', () => {
  it('forwards a cursor as opaque text and never parses it', async () => {
    const seen: Seen[] = [];
    const cursor = 'cnYxfDIwMjYtMDUtMDFUMDk6MDA6MDAuMDAwWnxhOQ';
    await readReviewQueue(
      { cursor },
      { ...OPTIONS, fetch: api(200, { items: [], nextCursor: null }, seen) },
    );
    expect(seen[0]!.url).toBe(`https://api.internal.test/v1/admin/reviews?cursor=${cursor}`);
  });

  it('drops a cursor that could not be one', async () => {
    const seen: Seen[] = [];
    for (const cursor of ['!!!', 'a b', 'x'.repeat(513), '']) {
      await readReviewQueue(
        { cursor },
        { ...OPTIONS, fetch: api(200, { items: [], nextCursor: null }, seen) },
      );
    }
    expect(seen.every((entry) => !entry.url.includes('cursor='))).toBe(true);
  });

  it('forwards one of 0026’s four statuses and drops anything else', async () => {
    const seen: Seen[] = [];
    for (const status of ['published', 'pending_moderation', 'hidden', 'removed']) {
      await readReviewQueue(
        { status },
        { ...OPTIONS, fetch: api(200, { items: [], nextCursor: null }, seen) },
      );
    }
    expect(seen.map((entry) => new URL(entry.url).searchParams.get('status'))).toEqual([
      'published',
      'pending_moderation',
      'hidden',
      'removed',
    ]);

    const dropped: Seen[] = [];
    for (const status of ['approved', 'PUBLISHED', 'deleted', "published' or true"]) {
      await readReviewQueue(
        { status },
        { ...OPTIONS, fetch: api(200, { items: [], nextCursor: null }, dropped) },
      );
    }
    // A mistyped bookmark shows the whole queue rather than an empty one or an error.
    expect(dropped.every((entry) => !entry.url.includes('status='))).toBe(true);
  });

  it('forwards a numeric limit and drops anything else', async () => {
    const seen: Seen[] = [];
    for (const limit of ['25', 'ten', '-1', '1.5', '']) {
      await readReviewQueue(
        { limit },
        { ...OPTIONS, fetch: api(200, { items: [], nextCursor: null }, seen) },
      );
    }
    expect(seen.map((entry) => new URL(entry.url).searchParams.get('limit'))).toEqual([
      '25',
      null,
      null,
      null,
      null,
    ]);
  });
});

describe('the one write', () => {
  it('sends the two contract fields and nothing else, at the route the id names', async () => {
    const seen: Seen[] = [];
    const response = await handleReviewModeration(postRequest(DECISION), {
      ...OPTIONS,
      fetch: api(200, MODERATED, seen),
    });

    expect(response.status).toBe(200);
    expect(seen[0]!.url).toBe(`https://api.internal.test/v1/admin/reviews/${REVIEW}/moderation`);
    expect(seen[0]!.method).toBe('POST');
    expect(JSON.parse(seen[0]!.body)).toEqual({ status: 'hidden', reason: 'Names another buyer.' });
    expect(seen[0]!.headers.get('x-session-token')).toBe(SESSION_TOKEN);
    expect(seen[0]!.headers.get('cookie')).toBeNull();
  });

  it('drops every field the contract does not name', async () => {
    const seen: Seen[] = [];
    await handleReviewModeration(
      postRequest({
        ...DECISION,
        moderatorUserId: '33333333-3333-4333-8333-333333333333',
        moderatedAt: '2026-05-05T09:00:00.000Z',
        publishedAt: '2026-05-05T09:00:00.000Z',
        autoHiddenReason: 'order_refunded',
        rating: 5,
        body: 'Rewritten.',
        replyStatus: 'hidden',
        replyBody: 'Rewritten.',
        orderId: REVIEW,
        canModerate: true,
        isParty: false,
      }),
      { ...OPTIONS, fetch: api(200, MODERATED, seen) },
    );

    expect(JSON.parse(seen[0]!.body)).toEqual({ status: 'hidden', reason: 'Names another buyer.' });
    for (const forbidden of [
      'moderatorUserId',
      'moderatedAt',
      'publishedAt',
      'autoHiddenReason',
      'rating',
      'replyStatus',
      'replyBody',
      'orderId',
      'canModerate',
      'isParty',
    ]) {
      expect(seen[0]!.body, forbidden).not.toContain(forbidden);
    }
  });

  it('trims the reason and requires one', async () => {
    const seen: Seen[] = [];
    await handleReviewModeration(postRequest({ ...DECISION, reason: '  Because.  ' }), {
      ...OPTIONS,
      fetch: api(200, MODERATED, seen),
    });
    expect(JSON.parse(seen[0]!.body)['reason']).toBe('Because.');

    for (const reason of ['', '   ', null, undefined, 42]) {
      const refused = await handleReviewModeration(postRequest({ ...DECISION, reason }), {
        ...OPTIONS,
        fetch: api(200, MODERATED),
      });
      expect(refused.status, String(reason)).toBe(400);
    }
  });

  it('refuses a status that is not one of the four, without calling the API', async () => {
    const seen: Seen[] = [];
    for (const status of ['approved', 'deleted', '', 'PUBLISHED', 7]) {
      const response = await handleReviewModeration(postRequest({ ...DECISION, status }), {
        ...OPTIONS,
        fetch: api(200, MODERATED, seen),
      });
      expect(response.status, String(status)).toBe(400);
    }
    expect(seen).toHaveLength(0);
  });

  it('refuses a review identifier that is not one, without calling the API', async () => {
    const seen: Seen[] = [];
    for (const reviewId of ['not-a-uuid', '', undefined, 1, `${REVIEW}/../../users`]) {
      const response = await handleReviewModeration(postRequest({ ...DECISION, reviewId }), {
        ...OPTIONS,
        fetch: api(200, MODERATED, seen),
      });
      expect(response.status, String(reviewId)).toBe(400);
    }
    expect(seen).toHaveLength(0);
  });

  it('refuses a cross-origin post before reading the body', async () => {
    const seen: Seen[] = [];
    const response = await handleReviewModeration(
      postRequest(DECISION, { origin: 'https://evil.test' }),
      { ...OPTIONS, fetch: api(200, MODERATED, seen) },
    );
    expect(response.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it('refuses a post with no session cookie', async () => {
    const seen: Seen[] = [];
    const request = new Request(`${ORIGIN}/api/reviews/moderation`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify(DECISION),
    });
    const response = await handleReviewModeration(request, {
      env: ENV,
      cookieHeader: null,
      fetch: api(200, MODERATED, seen),
    });
    expect(response.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('refuses a body that is not an object', async () => {
    for (const body of ['not json', '[]', '"text"', '7']) {
      const request = new Request(`${ORIGIN}/api/reviews/moderation`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json', cookie: COOKIE },
        body,
      });
      const response = await handleReviewModeration(request, { ...OPTIONS, fetch: api(200, MODERATED) });
      expect(response.status, body).toBe(400);
    }
  });

  it('forwards the party refusal with the API’s own problem body', async () => {
    const problem = {
      type: 'about:blank',
      status: 409,
      title: 'Conflict',
      detail: 'Nobody moderates a review they are a party to.',
      instance: '/v1/admin/reviews',
      code: 'REVIEW_IS_PARTY',
    };
    const response = await handleReviewModeration(postRequest(DECISION), {
      ...OPTIONS,
      fetch: api(409, problem),
    });

    expect(response.status).toBe(409);
    expect(response.headers.get('content-type')).toContain('problem+json');
    // The screen needs the code to say a colleague has to take this one, rather than a generic failure.
    expect(await response.json()).toEqual(problem);
  });

  it('forwards the refusals a screen acts on and swallows everything else into one 503', async () => {
    for (const status of [400, 401, 403, 404, 409, 429, 503]) {
      const response = await handleReviewModeration(postRequest(DECISION), {
        ...OPTIONS,
        fetch: api(status, { code: 'SOMETHING', status }),
      });
      expect(response.status, String(status)).toBe(status);
    }
    for (const status of [418, 500, 502]) {
      const response = await handleReviewModeration(postRequest(DECISION), {
        ...OPTIONS,
        fetch: api(status, { code: 'SOMETHING' }),
      });
      expect(response.status, String(status)).toBe(503);
    }
  });

  it('turns an upstream success the contract does not describe into an outage', async () => {
    for (const payload of [{ outcome: 'hidden' }, { outcome: 'moderated' }, { status: 'hidden' }, {}]) {
      const response = await handleReviewModeration(postRequest(DECISION), {
        ...OPTIONS,
        fetch: api(200, payload),
      });
      expect(response.status, JSON.stringify(payload)).toBe(503);
    }
  });

  it('never caches a write or a refusal', async () => {
    const ok = await handleReviewModeration(postRequest(DECISION), {
      ...OPTIONS,
      fetch: api(200, MODERATED),
    });
    const refused = await handleReviewModeration(postRequest(DECISION), {
      ...OPTIONS,
      fetch: api(409, { code: 'REVIEW_IS_PARTY' }),
    });
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(refused.headers.get('cache-control')).toBe('no-store');
  });
});

describe('the reply has no handler', () => {
  it('exports nothing that could write a reply', async () => {
    const surface: Record<string, unknown> = await import('../src/server/bff/review-moderation');
    const names = Object.keys(surface).sort();

    expect(names).toEqual([
      'handleReviewModeration',
      'readReview',
      'readReviewModerationActions',
      'readReviewQueue',
    ]);
    for (const name of names) {
      expect(name.toLowerCase(), name).not.toContain('reply');
    }
  });

  it('reads a reply and sends nothing that could change one', async () => {
    const detail = await readReview(REVIEW, { ...OPTIONS, fetch: api(200, { review: DETAIL }) });
    expect(detail.kind === 'ok' && detail.data.replyBody).toBe('We are sorry.');

    const seen: Seen[] = [];
    await handleReviewModeration(postRequest(DECISION), { ...OPTIONS, fetch: api(200, MODERATED, seen) });
    expect(seen[0]!.body.toLowerCase()).not.toContain('reply');
    expect(seen[0]!.url).not.toContain('repl');
  });
});
