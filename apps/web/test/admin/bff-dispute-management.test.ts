import { describe, expect, it } from 'vitest';
import {
  handleDisputeMessage,
  handleDisputeResolution,
  readDispute,
  readDisputeMessages,
  readDisputes,
} from '../../src/admin/server/bff/dispute-management';

/**
 * The dispute management BFF, on the admin origin (Phase 7-R).
 *
 * What matters at this boundary:
 *
 *   * the caller's token comes from `__Host-mp_admin_access` and never from a body, and the browser's own
 *     `Cookie` header is never forwarded upstream;
 *   * **bodies are rebuilt, never forwarded** — a `resolvedBy`, a `resolvedAt`, a `status`, an `orderStatus`,
 *     a `refundId` or a `paymentId` never crosses;
 *   * **money is a string on both sides and is never parsed** — proven with an amount larger than a double can
 *     hold exactly, which would change if any layer converted it;
 *   * **neither write moves money, and there is no third write** — asserted on the module's own export list;
 *   * a dispute is named by its id in the **route**, from a value checked for shape here;
 *   * responses are validated against the contract, so a drifted API that sent the buyer's account or the
 *     colleague who ruled produces a clean failure rather than a leak;
 *   * the refusals a screen must act on are forwarded with the API's own problem body.
 *
 * Everything is stubbed at the `fetch` boundary: no API, no database, no network.
 */

const ENV = {
  API_BASE_URL: 'https://api.internal.test',
  INTERNAL_BFF_CREDENTIAL: 'test-dispute-management-canary-credentials1',
} as const;

const SESSION_TOKEN = 'canary-admin-access-token-not-a-real-token';
const COOKIE = `__Host-mp_admin_access=${SESSION_TOKEN}; __Host-mp_admin_refresh=canary-refresh-not-real`;
const ORIGIN = 'https://admin.test';

const DISPUTE = 'fe000000-0000-4000-8000-000000000001';
const MESSAGE = 'ff000000-0000-4000-8000-000000000001';

/** Larger than `Number.MAX_SAFE_INTEGER`: `Number(...)` of it yields ...992, so any conversion shows. */
const BIG_AMOUNT = '9007199254740993';

const QUEUE_ROW = {
  id: DISPUTE,
  status: 'open',
  reasonCode: 'damaged',
  currencyCode: 'EGP',
  claimAmountMinor: BIG_AMOUNT,
  orderNumber: 'MP-26-000123',
  orderStatus: 'disputed',
  orderType: 'product',
  sellerSlug: 'a-shop',
  sellerDisplayName: 'A Shop',
  isParty: false,
  resolvedByMe: false,
  resolution: null,
  messageCount: 3,
  hasDetails: true,
  dueAt: null,
  createdAt: '2026-05-01T09:00:00.000Z',
};

const DETAIL = {
  id: DISPUTE,
  status: 'open',
  reasonCode: 'damaged',
  details: 'It arrived cracked.',
  currencyCode: 'EGP',
  claimAmountMinor: BIG_AMOUNT,
  orderNumber: 'MP-26-000123',
  orderStatus: 'disputed',
  orderType: 'product',
  orderGrandTotalMinor: BIG_AMOUNT,
  orderStatusBefore: 'delivered',
  orderPlacedAt: '2026-04-01T09:00:00.000Z',
  sellerSlug: 'a-shop',
  sellerDisplayName: 'A Shop',
  openedByRole: 'buyer',
  resolution: null,
  resolutionAmountMinor: null,
  resolutionNote: null,
  resolvedAt: null,
  resolvedByMe: false,
  isParty: false,
  canManage: true,
  dueAt: null,
  createdAt: '2026-05-01T09:00:00.000Z',
  updatedAt: '2026-05-01T09:00:00.000Z',
};

const MESSAGE_ROW = {
  id: MESSAGE,
  authorRole: 'buyer',
  body: 'The box was crushed.',
  isInternal: false,
  isOwnMessage: false,
  createdAt: '2026-05-01T09:05:00.000Z',
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

function postRequest(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/disputes/${path}`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json', cookie: COOKIE, ...headers },
    body: JSON.stringify(body),
  });
}

const OPTIONS = { env: ENV, cookieHeader: COOKIE } as const;
const MESSAGE_BODY = { disputeId: DISPUTE, body: 'We have asked the courier.', isInternal: false };
const DECISION = {
  disputeId: DISPUTE,
  resolution: 'refund_buyer',
  resolutionNote: 'The item arrived cracked.',
  resolutionAmountMinor: BIG_AMOUNT,
};
const POSTED = { outcome: 'posted', messageId: MESSAGE } as const;
const RESOLVED = { outcome: 'resolved', status: 'resolved', resolution: 'refund_buyer' } as const;

/* ------------------------------------------------------------------------------------------------ */

describe('the three reads', () => {
  it('present the caller’s token and the internal credential, and never the browser cookie', async () => {
    const seen: Seen[] = [];
    await readDisputes({}, { ...OPTIONS, fetch: api(200, { items: [QUEUE_ROW], nextCursor: null }, seen) });

    expect(seen[0]!.url).toBe('https://api.internal.test/v1/admin/disputes');
    expect(seen[0]!.method).toBe('GET');
    expect(seen[0]!.headers.get('x-session-token')).toBe(SESSION_TOKEN);
    expect(seen[0]!.headers.get('x-internal-credential')).toBe(ENV.INTERNAL_BFF_CREDENTIAL);
    expect(seen[0]!.headers.get('cookie')).toBeNull();
  });

  it('address every read at the path the contract names, with the identifier lower-cased', async () => {
    const seen: Seen[] = [];
    await readDisputes({}, { ...OPTIONS, fetch: api(200, { items: [], nextCursor: null }, seen) });
    await readDispute(DISPUTE.toUpperCase(), { ...OPTIONS, fetch: api(200, { dispute: DETAIL }, seen) });
    await readDisputeMessages(DISPUTE, { ...OPTIONS, fetch: api(200, { items: [] }, seen) });

    expect(seen.map((entry) => entry.url.replace('https://api.internal.test', ''))).toEqual([
      '/v1/admin/disputes',
      `/v1/admin/disputes/${DISPUTE}`,
      `/v1/admin/disputes/${DISPUTE}/messages`,
    ]);
    expect(seen.every((entry) => entry.method === 'GET' && entry.body === '')).toBe(true);
  });

  it('answer notFound to a malformed address without calling the API at all', async () => {
    const seen: Seen[] = [];
    const fetcher = api(200, {}, seen);
    expect((await readDispute('not-a-uuid', { ...OPTIONS, fetch: fetcher })).kind).toBe('notFound');
    expect((await readDispute(undefined, { ...OPTIONS, fetch: fetcher })).kind).toBe('notFound');
    expect((await readDisputeMessages('', { ...OPTIONS, fetch: fetcher })).kind).toBe('notFound');
    expect(seen).toHaveLength(0);
  });

  it('answer unauthenticated without a session cookie, and never call the API', async () => {
    const seen: Seen[] = [];
    const options = { env: ENV, cookieHeader: null, fetch: api(200, {}, seen) };
    expect((await readDisputes({}, options)).kind).toBe('unauthenticated');
    expect((await readDispute(DISPUTE, options)).kind).toBe('unauthenticated');
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
      const result = await readDisputes({}, { ...OPTIONS, fetch: api(status, {}) });
      expect(result.kind, String(status)).toBe(kind);
    }
  });

  it('turn a fetch that throws into one outage', async () => {
    const thrower = (async () => {
      throw new Error('network');
    }) as unknown as typeof fetch;
    expect((await readDisputes({}, { ...OPTIONS, fetch: thrower })).kind).toBe('unavailable');
    expect((await readDispute(DISPUTE, { ...OPTIONS, fetch: thrower })).kind).toBe('unavailable');
  });

  it('unwrap what the contract wraps', async () => {
    const detail = await readDispute(DISPUTE, { ...OPTIONS, fetch: api(200, { dispute: DETAIL }) });
    expect(detail.kind === 'ok' && detail.data.id).toBe(DISPUTE);

    const thread = await readDisputeMessages(DISPUTE, {
      ...OPTIONS,
      fetch: api(200, { items: [MESSAGE_ROW] }),
    });
    expect(thread.kind === 'ok' && thread.data.items).toHaveLength(1);
  });
});

describe('money is a string and is never parsed', () => {
  it('carries an amount larger than a double through unchanged', async () => {
    const detail = await readDispute(DISPUTE, { ...OPTIONS, fetch: api(200, { dispute: DETAIL }) });
    expect(detail.kind === 'ok' && detail.data.claimAmountMinor).toBe(BIG_AMOUNT);
    expect(detail.kind === 'ok' && detail.data.orderGrandTotalMinor).toBe(BIG_AMOUNT);
    expect(detail.kind === 'ok' && typeof detail.data.claimAmountMinor).toBe('string');
  });

  it('sends a decided amount upstream as the string it arrived as', async () => {
    const seen: Seen[] = [];
    await handleDisputeResolution(postRequest('resolution', DECISION), {
      ...OPTIONS,
      fetch: api(200, RESOLVED, seen),
    });

    const sent = JSON.parse(seen[0]!.body) as Record<string, unknown>;
    expect(sent['resolutionAmountMinor']).toBe(BIG_AMOUNT);
    expect(typeof sent['resolutionAmountMinor']).toBe('string');
    // And the wire bytes carry the digits, not a rounded number.
    expect(seen[0]!.body).toContain(`"${BIG_AMOUNT}"`);
    expect(seen[0]!.body).not.toContain('9007199254740992');
  });

  /**
   * A present-but-unusable amount is refused rather than dropped.
   *
   * Every other unrecognised field is dropped, which is right for a stray `refundId`. An amount is not: a
   * dropped one would record the decision without the money a colleague typed, and nobody would see it go.
   * `null` and `undefined` mean no amount, which is a different thing and is accepted.
   */
  it('refuses an amount that is not a digit string, rather than dropping it', async () => {
    for (const resolutionAmountMinor of ['0', '-1', '1.5', 'many', 100, 0, true, {}, []]) {
      const response = await handleDisputeResolution(
        postRequest('resolution', { ...DECISION, resolutionAmountMinor }),
        { ...OPTIONS, fetch: api(200, RESOLVED) },
      );
      expect(response.status, String(resolutionAmountMinor)).toBe(400);
    }
  });

  it('treats an empty or absent amount as no amount rather than as a zero', async () => {
    const seen: Seen[] = [];
    // A form's untouched field submits "". It must not become an amount of any kind — and `null` and an
    // absent field mean the same thing.
    for (const resolutionAmountMinor of ['   ', '', null, undefined]) {
      await handleDisputeResolution(
        postRequest('resolution', { ...DECISION, resolutionAmountMinor }),
        { ...OPTIONS, fetch: api(200, RESOLVED, seen) },
      );
    }
    for (const entry of seen) {
      expect((JSON.parse(entry.body) as Record<string, unknown>)['resolutionAmountMinor']).toBeUndefined();
    }
    expect(seen).toHaveLength(4);
  });

  it('refuses an amount against a resolution that is not a refund', async () => {
    const seen: Seen[] = [];
    for (const resolution of ['release_seller', 'no_action']) {
      const response = await handleDisputeResolution(
        postRequest('resolution', {
          disputeId: DISPUTE,
          resolution,
          resolutionNote: 'Because.',
          resolutionAmountMinor: '5000',
        }),
        { ...OPTIONS, fetch: api(200, RESOLVED, seen) },
      );
      expect(response.status, resolution).toBe(400);
    }
    expect(seen).toHaveLength(0);
  });
});

describe('the contract is the third wall', () => {
  it('refuses a body carrying an account rather than passing it along', async () => {
    for (const drifted of [
      { dispute: { ...DETAIL, buyerUserId: 'CANARY' } },
      { dispute: { ...DETAIL, resolvedBy: 'CANARY' } },
      { dispute: { ...DETAIL, orderId: 'CANARY' } },
    ]) {
      const result = await readDispute(DISPUTE, { ...OPTIONS, fetch: api(200, drifted) });
      expect(result.kind, JSON.stringify(drifted).slice(0, 50)).toBe('unavailable');
    }
  });

  it('refuses a thread carrying an author', async () => {
    const drifted = { items: [{ ...MESSAGE_ROW, authorUserId: 'CANARY' }] };
    expect((await readDisputeMessages(DISPUTE, { ...OPTIONS, fetch: api(200, drifted) })).kind).toBe(
      'unavailable',
    );
  });

  it('refuses an amount the contract’s own shape would not allow', async () => {
    // A JSON number where a digit string belongs is exactly the drift this convention exists to catch.
    const drifted = { dispute: { ...DETAIL, claimAmountMinor: 9007199254740993 } };
    expect((await readDispute(DISPUTE, { ...OPTIONS, fetch: api(200, drifted) })).kind).toBe(
      'unavailable',
    );
  });

  it('refuses a resolution the schema does not have', async () => {
    const drifted = { items: [{ ...QUEUE_ROW, resolution: 'refunded' }], nextCursor: null };
    expect((await readDisputes({}, { ...OPTIONS, fetch: api(200, drifted) })).kind).toBe('unavailable');
  });
});

describe('the queue’s query string', () => {
  it('forwards a cursor as opaque text and never parses it', async () => {
    const seen: Seen[] = [];
    const cursor = 'ZHExfDIwMjYtMDUtMDFUMDk6MDA6MDAuMDAwWnxmZQ';
    await readDisputes({ cursor }, { ...OPTIONS, fetch: api(200, { items: [], nextCursor: null }, seen) });
    expect(seen[0]!.url).toBe(`https://api.internal.test/v1/admin/disputes?cursor=${cursor}`);
  });

  it('drops a cursor that could not be one', async () => {
    const seen: Seen[] = [];
    for (const cursor of ['!!!', 'a b', 'x'.repeat(513), '']) {
      await readDisputes({ cursor }, { ...OPTIONS, fetch: api(200, { items: [], nextCursor: null }, seen) });
    }
    expect(seen.every((entry) => !entry.url.includes('cursor='))).toBe(true);
  });

  it('forwards the two reachable statuses and drops every other', async () => {
    const seen: Seen[] = [];
    for (const status of ['open', 'resolved']) {
      await readDisputes({ status }, { ...OPTIONS, fetch: api(200, { items: [], nextCursor: null }, seen) });
    }
    expect(seen.map((entry) => new URL(entry.url).searchParams.get('status'))).toEqual([
      'open',
      'resolved',
    ]);

    const dropped: Seen[] = [];
    // The four no writer can produce, plus nonsense. Dropped here so a stale bookmark shows the whole queue.
    for (const status of [
      'awaiting_seller',
      'awaiting_buyer',
      'under_review',
      'cancelled',
      'approved',
      'OPEN',
    ]) {
      await readDisputes(
        { status },
        { ...OPTIONS, fetch: api(200, { items: [], nextCursor: null }, dropped) },
      );
    }
    expect(dropped.every((entry) => !entry.url.includes('status='))).toBe(true);
  });

  it('forwards a numeric limit and drops anything else', async () => {
    const seen: Seen[] = [];
    for (const limit of ['25', 'ten', '-1', '1.5', '']) {
      await readDisputes({ limit }, { ...OPTIONS, fetch: api(200, { items: [], nextCursor: null }, seen) });
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

describe('the message write', () => {
  it('sends the two contract fields and nothing else, at the route the id names', async () => {
    const seen: Seen[] = [];
    const response = await handleDisputeMessage(postRequest('messages', MESSAGE_BODY), {
      ...OPTIONS,
      fetch: api(200, POSTED, seen),
    });

    expect(response.status).toBe(200);
    expect(seen[0]!.url).toBe(`https://api.internal.test/v1/admin/disputes/${DISPUTE}/messages`);
    expect(JSON.parse(seen[0]!.body)).toEqual({
      body: 'We have asked the courier.',
      isInternal: false,
    });
    expect(seen[0]!.headers.get('cookie')).toBeNull();
  });

  it('drops every field the contract does not name', async () => {
    const seen: Seen[] = [];
    await handleDisputeMessage(
      postRequest('messages', {
        ...MESSAGE_BODY,
        authorUserId: 'CANARY',
        authorRole: 'staff',
        createdAt: '2026-05-05T09:00:00.000Z',
      }),
      { ...OPTIONS, fetch: api(200, POSTED, seen) },
    );

    expect(JSON.parse(seen[0]!.body)).toEqual({
      body: 'We have asked the courier.',
      isInternal: false,
    });
    for (const forbidden of ['authorUserId', 'authorRole', 'createdAt', 'CANARY']) {
      expect(seen[0]!.body, forbidden).not.toContain(forbidden);
    }
  });

  it('trims the body and requires one', async () => {
    const seen: Seen[] = [];
    await handleDisputeMessage(postRequest('messages', { ...MESSAGE_BODY, body: '  Hello.  ' }), {
      ...OPTIONS,
      fetch: api(200, POSTED, seen),
    });
    expect(JSON.parse(seen[0]!.body)['body']).toBe('Hello.');

    for (const body of ['', '   ', null, 42]) {
      const refused = await handleDisputeMessage(postRequest('messages', { ...MESSAGE_BODY, body }), {
        ...OPTIONS,
        fetch: api(200, POSTED),
      });
      expect(refused.status, String(body)).toBe(400);
    }
  });

  it('sends the internal flag only as a true boolean', async () => {
    const seen: Seen[] = [];
    for (const isInternal of [true, false, 'true', 1, null, undefined]) {
      await handleDisputeMessage(postRequest('messages', { ...MESSAGE_BODY, isInternal }), {
        ...OPTIONS,
        fetch: api(200, POSTED, seen),
      });
    }
    // Only the literal `true` makes a note internal; everything else is a visible message.
    expect(seen.map((entry) => JSON.parse(entry.body)['isInternal'])).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it('forwards the closed-thread and party refusals with the API’s own body', async () => {
    for (const code of ['DISPUTE_THREAD_CLOSED', 'DISPUTE_IS_PARTY']) {
      const problem = { status: 409, code, detail: 'Refused.' };
      const response = await handleDisputeMessage(postRequest('messages', MESSAGE_BODY), {
        ...OPTIONS,
        fetch: api(409, problem),
      });
      expect(response.status, code).toBe(409);
      expect(await response.json(), code).toEqual(problem);
    }
  });
});

describe('the resolution write', () => {
  it('sends the three contract fields and nothing else', async () => {
    const seen: Seen[] = [];
    const response = await handleDisputeResolution(postRequest('resolution', DECISION), {
      ...OPTIONS,
      fetch: api(200, RESOLVED, seen),
    });

    expect(response.status).toBe(200);
    expect(seen[0]!.url).toBe(`https://api.internal.test/v1/admin/disputes/${DISPUTE}/resolution`);
    expect(JSON.parse(seen[0]!.body)).toEqual({
      resolution: 'refund_buyer',
      resolutionNote: 'The item arrived cracked.',
      resolutionAmountMinor: BIG_AMOUNT,
    });
  });

  /** The Phase 8 boundary, at this layer: nothing financial can be asked for through it. */
  it('drops every field reaching for a refund, a payment or the order’s lifecycle', async () => {
    const seen: Seen[] = [];
    await handleDisputeResolution(
      postRequest('resolution', {
        ...DECISION,
        resolvedBy: 'CANARY',
        resolvedAt: '2026-05-05T09:00:00.000Z',
        status: 'resolved',
        orderStatus: 'refunded',
        refundId: 'CANARY',
        paymentId: 'CANARY',
        executeRefund: true,
        ledgerJournalId: 'CANARY',
      }),
      { ...OPTIONS, fetch: api(200, RESOLVED, seen) },
    );

    expect(JSON.parse(seen[0]!.body)).toEqual({
      resolution: 'refund_buyer',
      resolutionNote: 'The item arrived cracked.',
      resolutionAmountMinor: BIG_AMOUNT,
    });
    for (const forbidden of [
      'resolvedBy',
      'resolvedAt',
      'orderStatus',
      'refundId',
      'paymentId',
      'executeRefund',
      'ledgerJournalId',
      'CANARY',
    ]) {
      expect(seen[0]!.body, forbidden).not.toContain(forbidden);
    }
  });

  it('accepts all four resolutions and refuses anything else', async () => {
    const seen: Seen[] = [];
    for (const resolution of ['refund_buyer', 'partial_refund', 'release_seller', 'no_action']) {
      const isRefund = resolution === 'refund_buyer' || resolution === 'partial_refund';
      const response = await handleDisputeResolution(
        postRequest('resolution', {
          disputeId: DISPUTE,
          resolution,
          resolutionNote: 'Because.',
          ...(isRefund ? { resolutionAmountMinor: '5000' } : {}),
        }),
        { ...OPTIONS, fetch: api(200, { ...RESOLVED, resolution }, seen) },
      );
      expect(response.status, resolution).toBe(200);
    }

    for (const resolution of ['approved', 'refunded', '', 'REFUND_BUYER']) {
      const response = await handleDisputeResolution(
        postRequest('resolution', { ...DECISION, resolution }),
        { ...OPTIONS, fetch: api(200, RESOLVED) },
      );
      expect(response.status, resolution).toBe(400);
    }
  });

  it('trims the reason and requires one', async () => {
    const seen: Seen[] = [];
    await handleDisputeResolution(
      postRequest('resolution', { ...DECISION, resolutionNote: '  Because.  ' }),
      { ...OPTIONS, fetch: api(200, RESOLVED, seen) },
    );
    expect(JSON.parse(seen[0]!.body)['resolutionNote']).toBe('Because.');

    for (const resolutionNote of ['', '   ', null, 42]) {
      const refused = await handleDisputeResolution(
        postRequest('resolution', { ...DECISION, resolutionNote }),
        { ...OPTIONS, fetch: api(200, RESOLVED) },
      );
      expect(refused.status, String(resolutionNote)).toBe(400);
    }
  });

  it('returns nothing financial on success', async () => {
    const response = await handleDisputeResolution(postRequest('resolution', DECISION), {
      ...OPTIONS,
      fetch: api(200, RESOLVED),
    });
    const body = await response.text();

    expect(JSON.parse(body)).toEqual(RESOLVED);
    for (const forbidden of ['refundId', 'paymentId', 'ledger', 'balance', 'payout', 'provider']) {
      expect(body, forbidden).not.toContain(forbidden);
    }
  });

  it('turns an upstream success the contract does not describe into an outage', async () => {
    for (const payload of [
      { outcome: 'resolved' },
      { outcome: 'refunded', status: 'resolved', resolution: 'refund_buyer' },
      // A drifted API that had actually paid something and said so.
      { ...RESOLVED, refundId: 'CANARY' },
      {},
    ]) {
      const response = await handleDisputeResolution(postRequest('resolution', DECISION), {
        ...OPTIONS,
        fetch: api(200, payload),
      });
      expect(response.status, JSON.stringify(payload)).toBe(503);
    }
  });

  it('forwards the refusals a screen acts on and swallows everything else into one 503', async () => {
    for (const status of [400, 401, 403, 404, 409, 429, 503]) {
      const response = await handleDisputeResolution(postRequest('resolution', DECISION), {
        ...OPTIONS,
        fetch: api(status, { code: 'SOMETHING', status }),
      });
      expect(response.status, String(status)).toBe(status);
    }
    for (const status of [418, 500, 502]) {
      const response = await handleDisputeResolution(postRequest('resolution', DECISION), {
        ...OPTIONS,
        fetch: api(status, { code: 'SOMETHING' }),
      });
      expect(response.status, String(status)).toBe(503);
    }
  });
});

describe('both writes are protected the same way', () => {
  it('refuse a cross-origin post before reading the body', async () => {
    const seen: Seen[] = [];
    for (const [path, body] of [
      ['messages', MESSAGE_BODY],
      ['resolution', DECISION],
    ] as const) {
      const response = await (path === 'messages' ? handleDisputeMessage : handleDisputeResolution)(
        postRequest(path, body, { origin: 'https://evil.test' }),
        { ...OPTIONS, fetch: api(200, POSTED, seen) },
      );
      expect(response.status, path).toBe(403);
    }
    expect(seen).toHaveLength(0);
  });

  it('refuse a post with no session cookie', async () => {
    const seen: Seen[] = [];
    const request = new Request(`${ORIGIN}/api/disputes/resolution`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify(DECISION),
    });
    const response = await handleDisputeResolution(request, {
      env: ENV,
      cookieHeader: null,
      fetch: api(200, RESOLVED, seen),
    });
    expect(response.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('refuse a dispute identifier that is not one, without calling the API', async () => {
    const seen: Seen[] = [];
    for (const disputeId of ['not-a-uuid', '', undefined, 1, `${DISPUTE}/../../users`]) {
      const one = await handleDisputeMessage(postRequest('messages', { ...MESSAGE_BODY, disputeId }), {
        ...OPTIONS,
        fetch: api(200, POSTED, seen),
      });
      const two = await handleDisputeResolution(postRequest('resolution', { ...DECISION, disputeId }), {
        ...OPTIONS,
        fetch: api(200, RESOLVED, seen),
      });
      expect(one.status, String(disputeId)).toBe(400);
      expect(two.status, String(disputeId)).toBe(400);
    }
    expect(seen).toHaveLength(0);
  });

  it('refuse a body that is not an object', async () => {
    for (const body of ['not json', '[]', '"text"', '7']) {
      const request = new Request(`${ORIGIN}/api/disputes/resolution`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json', cookie: COOKIE },
        body,
      });
      const response = await handleDisputeResolution(request, { ...OPTIONS, fetch: api(200, RESOLVED) });
      expect(response.status, body).toBe(400);
    }
  });

  it('never cache a write or a refusal', async () => {
    const ok = await handleDisputeResolution(postRequest('resolution', DECISION), {
      ...OPTIONS,
      fetch: api(200, RESOLVED),
    });
    const refused = await handleDisputeResolution(postRequest('resolution', DECISION), {
      ...OPTIONS,
      fetch: api(409, { code: 'DISPUTE_IS_PARTY' }),
    });
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(refused.headers.get('cache-control')).toBe('no-store');
  });
});

describe('there is no financial write in this module', () => {
  it('exports three reads and two non-financial writes, and nothing else', async () => {
    const surface: Record<string, unknown> = await import('../../src/admin/server/bff/dispute-management');
    const names = Object.keys(surface).sort();

    expect(names).toEqual([
      'handleDisputeMessage',
      'handleDisputeResolution',
      'readDispute',
      'readDisputeMessages',
      'readDisputes',
    ]);
    // A handler that paid a refund would have to be named, and there is nowhere for it to go.
    for (const name of names) {
      for (const verb of ['refund', 'payout', 'ledger', 'payment', 'reverse', 'settle', 'withdraw']) {
        expect(name.toLowerCase(), `${name}/${verb}`).not.toContain(verb);
      }
    }
  });

  it('never issues a request to anything but the dispute routes', async () => {
    const seen: Seen[] = [];
    await readDisputes({}, { ...OPTIONS, fetch: api(200, { items: [], nextCursor: null }, seen) });
    await readDispute(DISPUTE, { ...OPTIONS, fetch: api(200, { dispute: DETAIL }, seen) });
    await readDisputeMessages(DISPUTE, { ...OPTIONS, fetch: api(200, { items: [] }, seen) });
    await handleDisputeMessage(postRequest('messages', MESSAGE_BODY), {
      ...OPTIONS,
      fetch: api(200, POSTED, seen),
    });
    await handleDisputeResolution(postRequest('resolution', DECISION), {
      ...OPTIONS,
      fetch: api(200, RESOLVED, seen),
    });

    expect(seen.every((entry) => entry.url.includes('/v1/admin/disputes'))).toBe(true);
    for (const entry of seen) {
      for (const forbidden of ['/refunds', '/payments', '/payouts', '/ledger', '/withdrawals']) {
        expect(entry.url, forbidden).not.toContain(forbidden);
      }
    }
  });
});
