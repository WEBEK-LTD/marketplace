import { describe, expect, it } from 'vitest';
import {
  handleAcceptServiceQuote,
  handleCreateAdminOnlyServiceRequest,
  handleCancelServiceRequest,
  handleCreateServiceQuote,
  handleCreateServiceRequest,
  handleDeclineServiceRequest,
  handleRejectServiceQuote,
  handleWithdrawServiceQuote,
  readServiceRequestDetail,
  readServiceRequestsMade,
  readServiceRequestsReceived,
} from '../src/server/bff/service-requests';

/**
 * The BFF half of service requests — Option 1 (Phase 7-I).
 *
 * What matters at this boundary:
 *
 *   * the caller's token comes from `__Host-mp_access` and never from a body, and the browser's own `Cookie`
 *     header is never forwarded upstream;
 *   * **bodies are rebuilt, never forwarded** — a page that added a `paymentDueAt`, a `status`, a seller, a
 *     currency, an `expiresAt` or a routing flag has all of them dropped before anything leaves this origin;
 *   * **a request and a quote are named in the route, never in a body**, and a quote is addressed through its
 *     own request, so a decision cannot be redirected at somebody else's negotiation by a field;
 *   * **answers are validated against the contract**, so an object a drifted API sent cannot reach a page;
 *   * a session that ended, a brief that is not there, a refused cursor and a service that could not answer
 *     stay four distinct things;
 *   * every write refuses a cross-site request before it reads anything else;
 *   * nothing here routes anything to staff.
 */

const ENV = Object.freeze({
  API_BASE_URL: 'https://api.internal.test',
  PUBLIC_WEB_ORIGIN: 'https://web.test',
  INTERNAL_BFF_CREDENTIAL: 'test-current-credential-value-not-a-real-se',
});

const SESSION_TOKEN = 'requests-canary-access-token-not-a-real-tok';
const COOKIE = `__Host-mp_access=${SESSION_TOKEN}`;

const REQUEST = 'd1000000-0000-4000-8000-000000000001';
const QUOTE = 'd1000000-0000-4000-8000-0000000000a1';
const LISTING = 'd1000000-0000-4000-8000-0000000000f1';

const SUMMARY_ROW = {
  id: REQUEST,
  status: 'open',
  routingMode: 'seller',
  title: 'Build me a shelf',
  budgetMinor: '400000',
  currencyCode: 'EGP',
  currencyMinorUnit: 2,
  neededBy: '2026-06-01',
  listingSlug: 'sr-custom-one',
  listingTitle: 'A quotable service',
  counterpartyName: 'Service Shop One',
  quoteCount: 1,
  liveQuoteCount: 1,
  acceptedPaymentDueAt: null,
  closedAt: null,
  createdAt: '2026-05-01T09:00:00.000Z',
};

const QUOTE_ROW = {
  id: QUOTE,
  status: 'sent',
  amountMinor: '380000',
  deliveryDays: 10,
  revisionsIncluded: 2,
  scope: 'A scope long enough to satisfy the ten-character rule.',
  isLapsed: false,
  expiresAt: '2026-05-15T09:00:00.000Z',
  respondedAt: null,
  acceptedAt: null,
  paymentDueAt: null,
  createdAt: '2026-05-02T09:00:00.000Z',
};

const DETAIL_ROW = {
  id: REQUEST,
  status: 'quoted',
  routingMode: 'seller',
  isBuyer: true,
  isSeller: false,
  title: 'Build me a shelf',
  brief: 'A brief that is comfortably longer than ten characters.',
  budgetMinor: '400000',
  currencyCode: 'EGP',
  currencyMinorUnit: 2,
  neededBy: '2026-06-01',
  listingSlug: 'sr-custom-one',
  listingTitle: 'A quotable service',
  buyerName: 'Buyer A',
  sellerSlug: 'sr-shop-one',
  sellerName: 'Service Shop One',
  closedAt: null,
  createdAt: '2026-05-01T09:00:00.000Z',
  quotes: [QUOTE_ROW],
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

const VALID_REQUEST = {
  listingId: LISTING,
  title: 'Build me a shelf',
  brief: 'A brief that is comfortably longer than ten characters.',
};
const VALID_QUOTE = {
  amountMinor: '380000',
  deliveryDays: 10,
  revisionsIncluded: 2,
  scope: 'A scope long enough to satisfy the ten-character rule.',
  validForDays: 14,
};

const CREATED = { requestId: REQUEST, status: 'open' };
const QUOTED = { quoteId: QUOTE, status: 'sent' };
const ACCEPTED = {
  status: 'accepted',
  acceptedAt: '2026-05-03T09:00:00.000Z',
  paymentDueAt: '2026-05-05T09:00:00.000Z',
};

/* ------------------------------------------------------------------------------------------------ */

describe('reading the three views', () => {
  it('presents the caller’s token and the internal credential, and never the browser cookie', async () => {
    const seen: Seen[] = [];
    await readServiceRequestsMade(
      {},
      { env: ENV, cookieHeader: COOKIE, fetch: api(200, { items: [SUMMARY_ROW], nextCursor: null }, seen) },
    );

    expect(seen[0]!.url).toBe('https://api.internal.test/v1/service-requests/made');
    expect(seen[0]!.method).toBe('GET');
    expect(seen[0]!.headers.get('x-session-token')).toBe(SESSION_TOKEN);
    expect(seen[0]!.headers.get('x-internal-credential')).toBe(ENV.INTERNAL_BFF_CREDENTIAL);
    expect(seen[0]!.headers.get('cookie')).toBeNull();
  });

  it('reads the two sides from two different operations, neither naming a party', async () => {
    const seen: Seen[] = [];
    const empty = { items: [], nextCursor: null };
    await readServiceRequestsMade({}, { env: ENV, cookieHeader: COOKIE, fetch: api(200, empty, seen) });
    await readServiceRequestsReceived({}, { env: ENV, cookieHeader: COOKIE, fetch: api(200, empty, seen) });

    expect(seen[0]!.url).toBe('https://api.internal.test/v1/service-requests/made');
    expect(seen[1]!.url).toBe('https://api.internal.test/v1/service-requests/received');
    for (const request of seen) {
      expect(request.url).not.toContain('role=');
      expect(request.url).not.toContain('user');
      expect(request.url).not.toContain('side=');
    }
  });

  it('reads one brief by the identifier in the address, lower-cased', async () => {
    const seen: Seen[] = [];
    const result = await readServiceRequestDetail(REQUEST.toUpperCase(), {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: api(200, { request: DETAIL_ROW }, seen),
    });

    expect(result.kind).toBe('ok');
    expect(seen[0]!.url).toBe(`https://api.internal.test/v1/service-requests/${REQUEST}`);
  });

  it('never reaches the API without a session cookie', async () => {
    const seen: Seen[] = [];
    for (const read of [
      () => readServiceRequestsMade({}, { env: ENV, cookieHeader: null, fetch: api(200, {}, seen) }),
      () => readServiceRequestsReceived({}, { env: ENV, cookieHeader: null, fetch: api(200, {}, seen) }),
      () => readServiceRequestDetail(REQUEST, { env: ENV, cookieHeader: null, fetch: api(200, {}, seen) }),
    ]) {
      expect((await read()).kind).toBe('unauthenticated');
    }
    expect(seen).toHaveLength(0);
  });

  it('answers not-found for an identifier that is not one, without asking', async () => {
    const seen: Seen[] = [];
    for (const id of ['not-a-uuid', '', 'sr-custom-one', undefined]) {
      const result = await readServiceRequestDetail(id, {
        env: ENV,
        cookieHeader: COOKIE,
        fetch: api(200, { request: DETAIL_ROW }, seen),
      });
      expect(result.kind, String(id)).toBe('notFound');
    }
    expect(seen).toHaveLength(0);
  });

  it('keeps four outcomes apart', async () => {
    const cases: ReadonlyArray<readonly [number, string]> = [
      [401, 'unauthenticated'],
      [404, 'notFound'],
      [400, 'invalid'],
      [500, 'unavailable'],
      [503, 'unavailable'],
    ];
    for (const [status, kind] of cases) {
      const result = await readServiceRequestDetail(REQUEST, {
        env: ENV,
        cookieHeader: COOKIE,
        fetch: api(status, { code: 'NOPE' }),
      });
      expect(result.kind, String(status)).toBe(kind);
    }
  });

  it('refuses an answer the contract does not describe, rather than passing it on', async () => {
    const drifted = await readServiceRequestsMade(
      {},
      {
        env: ENV,
        cookieHeader: COOKIE,
        // `budgetMinor` as a number is exactly the drift the contract exists to catch.
        fetch: api(200, { items: [{ ...SUMMARY_ROW, budgetMinor: 400000 }], nextCursor: null }),
      },
    );
    expect(drifted.kind).toBe('unavailable');

    const extra = await readServiceRequestDetail(REQUEST, {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: api(200, { request: { ...DETAIL_ROW, buyerUserId: REQUEST } }),
    });
    expect(extra.kind).toBe('unavailable');
  });

  it('passes a cursor through without reading it, and never builds one', async () => {
    const seen: Seen[] = [];
    const cursor = 'c3IxfDIwMjYtMDUtMDFUMDk6MDA6MDAuMDAwWnxpZA';
    await readServiceRequestsMade(
      { cursor, limit: '5' },
      { env: ENV, cookieHeader: COOKIE, fetch: api(200, { items: [], nextCursor: null }, seen) },
    );
    const url = new URL(seen[0]!.url);
    expect(url.searchParams.get('cursor')).toBe(cursor);
    expect(url.searchParams.get('limit')).toBe('5');
  });

  it('sends no query at all when nothing was asked for', async () => {
    const seen: Seen[] = [];
    await readServiceRequestsReceived(
      { cursor: '', limit: null },
      { env: ENV, cookieHeader: COOKIE, fetch: api(200, { items: [], nextCursor: null }, seen) },
    );
    expect(seen[0]!.url).toBe('https://api.internal.test/v1/service-requests/received');
  });
});

describe('sending a brief', () => {
  it('rebuilds the body from the contract and sends nothing else', async () => {
    const seen: Seen[] = [];
    const response = await handleCreateServiceRequest(
      post('/api/service-requests', {
        ...VALID_REQUEST,
        budgetMinor: '400000',
        neededBy: '2026-06-01',
        // Every one of these is dropped here, and would be refused upstream as well.
        paymentDueAt: '2026-05-05T09:00:00.000Z',
        status: 'accepted',
        sellerUserId: REQUEST,
        currencyCode: 'USD',
        closedAt: '2026-05-05T09:00:00.000Z',
        routeToAdmin: true,
        assignTo: 'staff',
        // D7-08's column by its real name, and its admin value. The BFF rebuilds, so neither crosses.
        routingMode: 'admin_only',
        adminOnly: true,
      }),
      { env: ENV, fetch: api(201, CREATED, seen) },
    );

    expect(response.status).toBe(201);
    expect(seen[0]!.url).toBe('https://api.internal.test/v1/service-requests');
    expect(Object.keys(JSON.parse(seen[0]!.body) as Record<string, unknown>).sort()).toEqual([
      'brief',
      'budgetMinor',
      'listingId',
      'neededBy',
      'title',
    ]);
  });

  it('treats an empty budget or date as an absence rather than a value', async () => {
    const seen: Seen[] = [];
    await handleCreateServiceRequest(
      post('/api/service-requests', { ...VALID_REQUEST, budgetMinor: '', neededBy: '' }),
      { env: ENV, fetch: api(201, CREATED, seen) },
    );
    expect(Object.keys(JSON.parse(seen[0]!.body) as Record<string, unknown>).sort()).toEqual([
      'brief',
      'listingId',
      'title',
    ]);
  });

  it('refuses a brief the contract refuses, without reaching the API', async () => {
    const seen: Seen[] = [];
    for (const body of [
      { ...VALID_REQUEST, listingId: 'not-a-uuid' },
      { ...VALID_REQUEST, title: 'ab' },
      { ...VALID_REQUEST, brief: 'too short' },
      { ...VALID_REQUEST, budgetMinor: '0' },
      { ...VALID_REQUEST, neededBy: 'tomorrow' },
      {},
    ]) {
      const response = await handleCreateServiceRequest(post('/api/service-requests', body), {
        env: ENV,
        fetch: api(201, CREATED, seen),
      });
      expect(response.status).toBe(400);
    }
    expect(seen).toHaveLength(0);
  });

  it('forwards the API’s own refusal so a form can act on it', async () => {
    for (const [status, code] of [
      [409, 'SERVICE_REQUEST_NOT_CUSTOM'],
      [409, 'SERVICE_REQUEST_OWN_LISTING'],
      [409, 'SERVICE_REQUEST_NOT_AVAILABLE'],
      [409, 'SERVICE_REQUEST_BLOCKED'],
      [404, 'NOT_FOUND'],
    ] as const) {
      const response = await handleCreateServiceRequest(post('/api/service-requests', VALID_REQUEST), {
        env: ENV,
        fetch: api(status, { status, code }),
      });
      expect(response.status).toBe(status);
      expect(((await response.json()) as Record<string, unknown>)['code']).toBe(code);
    }
  });

  it('turns a status nobody expected into an outage rather than a success', async () => {
    const response = await handleCreateServiceRequest(post('/api/service-requests', VALID_REQUEST), {
      env: ENV,
      fetch: api(418, { code: 'TEAPOT' }),
    });
    expect(response.status).toBe(503);
    expect(((await response.json()) as Record<string, unknown>)['code']).toBe('SERVICE_UNAVAILABLE');
  });

  it('refuses an answer the contract does not describe', async () => {
    const response = await handleCreateServiceRequest(post('/api/service-requests', VALID_REQUEST), {
      env: ENV,
      fetch: api(201, { requestId: REQUEST, status: 'open', paymentDueAt: '2026-05-05T09:00:00.000Z' }),
    });
    expect(response.status).toBe(503);
  });
});

describe('quoting', () => {
  it('takes the brief from the route and rebuilds the five fields', async () => {
    const seen: Seen[] = [];
    const response = await handleCreateServiceQuote(
      post(`/api/service-requests/${REQUEST}/quotes`, {
        ...VALID_QUOTE,
        // Dropped: the request, the currency, the expiry, the status, the deadline and the terms.
        serviceRequestId: 'd1000000-0000-4000-8000-00000000ffff',
        currencyCode: 'USD',
        expiresAt: '2027-01-01T00:00:00.000Z',
        status: 'accepted',
        paymentDueAt: '2026-05-05T09:00:00.000Z',
        acceptedTerms: { amount_minor: '1' },
      }),
      REQUEST,
      { env: ENV, fetch: api(201, QUOTED, seen) },
    );

    expect(response.status).toBe(201);
    expect(seen[0]!.url).toBe(`https://api.internal.test/v1/service-requests/${REQUEST}/quotes`);
    expect(Object.keys(JSON.parse(seen[0]!.body) as Record<string, unknown>).sort()).toEqual([
      'amountMinor',
      'deliveryDays',
      'revisionsIncluded',
      'scope',
      'validForDays',
    ]);
  });

  it('sends the validity window as a window, never as a deadline', async () => {
    const seen: Seen[] = [];
    await handleCreateServiceQuote(post(`/api/service-requests/${REQUEST}/quotes`, VALID_QUOTE), REQUEST, {
      env: ENV,
      fetch: api(201, QUOTED, seen),
    });
    const body = JSON.parse(seen[0]!.body) as Record<string, unknown>;
    expect(body['validForDays']).toBe(14);
    for (const key of Object.keys(body)) {
      expect(key.toLowerCase()).not.toContain('due');
      expect(key.toLowerCase()).not.toContain('expires');
    }
  });

  it('defaults the revisions the contract defaults, and refuses what it refuses', async () => {
    const seen: Seen[] = [];
    await handleCreateServiceQuote(
      post(`/api/service-requests/${REQUEST}/quotes`, {
        amountMinor: VALID_QUOTE.amountMinor,
        deliveryDays: VALID_QUOTE.deliveryDays,
        scope: VALID_QUOTE.scope,
        validForDays: VALID_QUOTE.validForDays,
      }),
      REQUEST,
      { env: ENV, fetch: api(201, QUOTED, seen) },
    );
    expect((JSON.parse(seen[0]!.body) as Record<string, unknown>)['revisionsIncluded']).toBe(0);

    const before = seen.length;
    for (const body of [
      { ...VALID_QUOTE, amountMinor: 380000 },
      { ...VALID_QUOTE, validForDays: 0 },
      { ...VALID_QUOTE, validForDays: 366 },
      { ...VALID_QUOTE, deliveryDays: 0 },
      { ...VALID_QUOTE, scope: 'short' },
      { amountMinor: '1' },
    ]) {
      const response = await handleCreateServiceQuote(
        post(`/api/service-requests/${REQUEST}/quotes`, body),
        REQUEST,
        { env: ENV, fetch: api(201, QUOTED, seen) },
      );
      expect(response.status).toBe(400);
    }
    expect(seen).toHaveLength(before);
  });

  it('refuses a brief identifier that is not one', async () => {
    const seen: Seen[] = [];
    const response = await handleCreateServiceQuote(
      post('/api/service-requests/nope/quotes', VALID_QUOTE),
      'nope',
      { env: ENV, fetch: api(201, QUOTED, seen) },
    );
    expect(response.status).toBe(400);
    expect(seen).toHaveLength(0);
  });
});

describe('the five steps that take no body', () => {
  const steps = [
    ['cancel', (r: Request, o: object) => handleCancelServiceRequest(r, REQUEST, o)],
    ['decline', (r: Request, o: object) => handleDeclineServiceRequest(r, REQUEST, o)],
  ] as const;

  it.each(steps)('closes a brief through /%s, forwarding no body at all', async (step, run) => {
    const seen: Seen[] = [];
    const response = await run(
      post(`/api/service-requests/${REQUEST}/${step}`, { status: 'accepted', paymentDueAt: 'now' }),
      { env: ENV, fetch: api(200, { status: step === 'cancel' ? 'cancelled' : 'declined' }, seen) },
    );

    expect(response.status).toBe(200);
    expect(seen[0]!.url).toBe(`https://api.internal.test/v1/service-requests/${REQUEST}/${step}`);
    expect(seen[0]!.body).toBe('');
    expect(seen[0]!.headers.get('content-type')).toBeNull();
  });

  const decisions = [
    ['accept', handleAcceptServiceQuote],
    ['reject', handleRejectServiceQuote],
    ['withdraw', handleWithdrawServiceQuote],
  ] as const;

  it.each(decisions)('decides a quote through /%s, addressed through its own brief', async (step, run) => {
    const seen: Seen[] = [];
    const settled = { accept: 'accepted', reject: 'rejected', withdraw: 'withdrawn' } as const;
    const payload =
      step === 'accept' ? ACCEPTED : { status: settled[step], acceptedAt: null, paymentDueAt: null };
    const response = await run(
      post(`/api/service-requests/${REQUEST}/quotes/${QUOTE}/${step}`, { paymentDueAt: 'now' }),
      REQUEST,
      QUOTE,
      { env: ENV, fetch: api(200, payload, seen) },
    );

    expect(response.status).toBe(200);
    expect(seen[0]!.url).toBe(
      `https://api.internal.test/v1/service-requests/${REQUEST}/quotes/${QUOTE}/${step}`,
    );
    expect(seen[0]!.body).toBe('');
  });

  it('refuses either identifier being malformed, without reaching the API', async () => {
    const seen: Seen[] = [];
    const bad: ReadonlyArray<readonly [string | undefined, string | undefined]> = [
      ['nope', QUOTE],
      [REQUEST, 'nope'],
      [undefined, QUOTE],
      [REQUEST, undefined],
      ['', ''],
    ];
    for (const [requestId, quoteId] of bad) {
      const response = await handleAcceptServiceQuote(
        post('/api/service-requests/x/quotes/y/accept', {}),
        requestId,
        quoteId,
        { env: ENV, fetch: api(200, ACCEPTED, seen) },
      );
      expect(response.status).toBe(400);
    }
    expect(seen).toHaveLength(0);
  });

  it('answers an acceptance with the obligation the API recorded, and nothing more', async () => {
    const response = await handleAcceptServiceQuote(
      post(`/api/service-requests/${REQUEST}/quotes/${QUOTE}/accept`, {}),
      REQUEST,
      QUOTE,
      { env: ENV, fetch: api(200, ACCEPTED) },
    );
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['acceptedAt', 'paymentDueAt', 'status']);
    expect(body['paymentDueAt']).toBe('2026-05-05T09:00:00.000Z');
  });

  it('refuses an acceptance body the contract does not describe rather than trimming it', async () => {
    // Strict, not lenient: a field nobody approved makes the answer a clean failure here, which is how a
    // later widening upstream gets noticed instead of quietly reaching a browser.
    const response = await handleAcceptServiceQuote(
      post(`/api/service-requests/${REQUEST}/quotes/${QUOTE}/accept`, {}),
      REQUEST,
      QUOTE,
      { env: ENV, fetch: api(200, { ...ACCEPTED, internalNote: 'do not show this' }) },
    );
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('do not show this');
  });

  it('lets the payment-window failure reach the browser as itself', async () => {
    const response = await handleAcceptServiceQuote(
      post(`/api/service-requests/${REQUEST}/quotes/${QUOTE}/accept`, {}),
      REQUEST,
      QUOTE,
      { env: ENV, fetch: api(503, { status: 503, code: 'SERVICE_QUOTE_PAYMENT_POLICY_MISSING' }) },
    );
    expect(response.status).toBe(503);
    expect(((await response.json()) as Record<string, unknown>)['code']).toBe(
      'SERVICE_QUOTE_PAYMENT_POLICY_MISSING',
    );
  });

  it.each([
    [409, 'SERVICE_REQUEST_NOT_ACTIONABLE'],
    [409, 'SERVICE_QUOTE_LAPSED'],
    [404, 'NOT_FOUND'],
  ])('forwards %i %s so a page can say what happened', async (status, code) => {
    const response = await handleRejectServiceQuote(
      post(`/api/service-requests/${REQUEST}/quotes/${QUOTE}/reject`, {}),
      REQUEST,
      QUOTE,
      { env: ENV, fetch: api(status, { status, code }) },
    );
    expect(response.status).toBe(status);
    expect(((await response.json()) as Record<string, unknown>)['code']).toBe(code);
  });
});

describe('every write is same-origin and has a session', () => {
  const writes: ReadonlyArray<readonly [string, (request: Request, options: object) => Promise<Response>]> = [
    ['create', (r, o) => handleCreateServiceRequest(r, o)],
    ['quote', (r, o) => handleCreateServiceQuote(r, REQUEST, o)],
    ['cancel', (r, o) => handleCancelServiceRequest(r, REQUEST, o)],
    ['decline', (r, o) => handleDeclineServiceRequest(r, REQUEST, o)],
    ['accept', (r, o) => handleAcceptServiceQuote(r, REQUEST, QUOTE, o)],
    ['reject', (r, o) => handleRejectServiceQuote(r, REQUEST, QUOTE, o)],
    ['withdraw', (r, o) => handleWithdrawServiceQuote(r, REQUEST, QUOTE, o)],
  ];

  it.each(writes)('refuses a cross-site %s before reading anything', async (_name, run) => {
    const seen: Seen[] = [];
    const response = await run(
      new Request('https://shop.test/api/service-requests', {
        method: 'POST',
        headers: { origin: 'https://evil.test', 'content-type': 'application/json', cookie: COOKIE },
        body: JSON.stringify(VALID_REQUEST),
      }),
      { env: ENV, fetch: api(201, CREATED, seen) },
    );
    expect(response.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it.each(writes)('refuses %s without a session cookie', async (_name, run) => {
    const seen: Seen[] = [];
    const response = await run(
      new Request('https://shop.test/api/service-requests', {
        method: 'POST',
        headers: { origin: 'https://shop.test', 'content-type': 'application/json' },
        body: JSON.stringify(VALID_REQUEST),
      }),
      { env: ENV, fetch: api(201, CREATED, seen) },
    );
    expect(response.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it.each(writes)('presents the internal credential and never the browser cookie on %s', async (_name, run) => {
    const seen: Seen[] = [];
    await run(post('/api/service-requests', VALID_REQUEST), {
      env: ENV,
      fetch: api(200, { status: 'cancelled' }, seen),
    });
    // Some of these refuse before reaching the API; those that do not must be clean.
    for (const request of seen) {
      expect(request.headers.get('x-internal-credential')).toBe(ENV.INTERNAL_BFF_CREDENTIAL);
      expect(request.headers.get('x-session-token')).toBe(SESSION_TOKEN);
      expect(request.headers.get('cookie')).toBeNull();
    }
  });

  it('refuses a body that is not JSON', async () => {
    const seen: Seen[] = [];
    const response = await handleCreateServiceRequest(
      new Request('https://shop.test/api/service-requests', {
        method: 'POST',
        headers: { origin: 'https://shop.test', 'content-type': 'application/json', cookie: COOKIE },
        body: 'not json',
      }),
      { env: ENV, fetch: api(201, CREATED, seen) },
    );
    expect(response.status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it('turns an unreachable API into an outage on every write', async () => {
    const unreachable = (async () => {
      throw new Error('connection refused');
    }) as unknown as typeof fetch;
    for (const [, run] of writes) {
      const response = await run(post('/api/service-requests', VALID_REQUEST), {
        env: ENV,
        fetch: unreachable,
      });
      expect([400, 503]).toContain(response.status);
    }
  });

  it('marks every answer no-store', async () => {
    const response = await handleCancelServiceRequest(
      post(`/api/service-requests/${REQUEST}/cancel`, {}),
      REQUEST,
      { env: ENV, fetch: api(200, { status: 'cancelled' }) },
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('no Option 2 surface exists here', () => {
  it('sends no routing vocabulary upstream on any write', async () => {
    const seen: Seen[] = [];
    await handleCreateServiceRequest(
      post('/api/service-requests', { ...VALID_REQUEST, routingMode: 'admin_only', adminOnly: true }),
      { env: ENV, fetch: api(201, CREATED, seen) },
    );
    await handleCreateServiceQuote(
      post(`/api/service-requests/${REQUEST}/quotes`, { ...VALID_QUOTE, routingMode: 'admin_only' }),
      REQUEST,
      { env: ENV, fetch: api(201, QUOTED, seen) },
    );
    expect(seen).not.toHaveLength(0);
    for (const request of seen) {
      expect(request.body).not.toContain('routingMode');
      expect(request.body).not.toContain('admin_only');
      expect(request.body).not.toContain('adminOnly');
    }
  });

  /**
   * 7-J: this module gained one buyer operation whose name says what kind of row it creates — an Admin Only
   * brief — and nothing that acts on behalf of staff. The distinction is the point: a buyer may send such a
   * brief, and only the admin surface can read or close one.
   */
  it('exports nothing that acts for staff, reads a queue or touches payment information', async () => {
    const surface: Record<string, unknown> = await import('../src/server/bff/service-requests');
    for (const name of Object.keys(surface)) {
      const lower = name.toLowerCase();
      for (const forbidden of [
        'staff',
        'route',
        'assign',
        'queue',
        'paymentinformation',
        'checkout',
        'order',
      ]) {
        expect(lower, `${name} / ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('addresses no admin path, on any operation', async () => {
    const seen: Seen[] = [];
    await readServiceRequestsMade({}, { env: ENV, cookieHeader: COOKIE, fetch: api(200, { items: [], nextCursor: null }, seen) });
    await handleCreateAdminOnlyServiceRequest(
      post('/api/service-requests/admin-only', {
        title: 'Build me a shelf',
        brief: 'A brief that is comfortably longer than ten characters.',
        preferredPaymentMethod: 'Bank transfer',
      }),
      { env: ENV, fetch: api(201, CREATED, seen) },
    );
    expect(seen).not.toHaveLength(0);
    for (const request of seen) {
      expect(request.url).not.toContain('/v1/admin');
    }
  });

  it('addresses only /v1/service-requests, on every operation', async () => {
    const seen: Seen[] = [];
    const options = { env: ENV, cookieHeader: COOKIE, fetch: api(200, { items: [], nextCursor: null }, seen) };
    await readServiceRequestsMade({}, options);
    await readServiceRequestsReceived({}, options);
    await readServiceRequestDetail(REQUEST, {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: api(200, { request: DETAIL_ROW }, seen),
    });
    await handleCreateServiceRequest(post('/api/service-requests', VALID_REQUEST), {
      env: ENV,
      fetch: api(201, CREATED, seen),
    });
    await handleAcceptServiceQuote(post('/x', {}), REQUEST, QUOTE, {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: api(200, ACCEPTED, seen),
    });

    expect(seen).not.toHaveLength(0);
    for (const request of seen) {
      expect(request.url.startsWith('https://api.internal.test/v1/service-requests')).toBe(true);
      expect(request.url).not.toContain('/admin');
    }
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* Option 2 — the buyer's Admin Only create (Phase 7-J)                                              */
/* ------------------------------------------------------------------------------------------------ */

const ADMIN_ONLY_BODY = {
  title: 'Build me a shelf',
  brief: 'A brief that is comfortably longer than ten characters.',
  preferredPaymentMethod: 'Bank transfer, end of month',
};

describe('sending an Admin Only brief', () => {
  it('rebuilds the body from the contract and sends nothing else', async () => {
    const seen: Seen[] = [];
    const response = await handleCreateAdminOnlyServiceRequest(
      post('/api/service-requests/admin-only', {
        ...ADMIN_ONLY_BODY,
        paymentNotes: 'Invoice the company address.',
        budgetMinor: '400000',
        neededBy: '2026-06-01',
        // Every one of these is dropped here, and refused upstream as well.
        routingMode: 'seller',
        sellerUserId: REQUEST,
        listingId: LISTING,
        currencyCode: 'USD',
        status: 'declined',
        closedAt: '2026-05-05T09:00:00.000Z',
        paymentDueAt: '2026-05-05T09:00:00.000Z',
        permission: 'service_requests.payment_info.read',
      }),
      { env: ENV, fetch: api(201, CREATED, seen) },
    );

    expect(response.status).toBe(201);
    expect(seen[0]!.url).toBe('https://api.internal.test/v1/service-requests/admin-only');
    expect(Object.keys(JSON.parse(seen[0]!.body) as Record<string, unknown>).sort()).toEqual([
      'brief',
      'budgetMinor',
      'neededBy',
      'paymentNotes',
      'preferredPaymentMethod',
      'title',
    ]);
  });

  it('sends no routing vocabulary upstream', async () => {
    const seen: Seen[] = [];
    await handleCreateAdminOnlyServiceRequest(
      post('/api/service-requests/admin-only', { ...ADMIN_ONLY_BODY, routingMode: 'admin_only', adminOnly: true }),
      { env: ENV, fetch: api(201, CREATED, seen) },
    );
    expect(seen[0]!.body).not.toContain('routingMode');
    expect(seen[0]!.body).not.toContain('admin_only');
    expect(seen[0]!.body).not.toContain('adminOnly');
  });

  it('treats an empty note, budget or date as an absence', async () => {
    const seen: Seen[] = [];
    await handleCreateAdminOnlyServiceRequest(
      post('/api/service-requests/admin-only', {
        ...ADMIN_ONLY_BODY,
        paymentNotes: '',
        budgetMinor: '',
        neededBy: '',
      }),
      { env: ENV, fetch: api(201, CREATED, seen) },
    );
    expect(Object.keys(JSON.parse(seen[0]!.body) as Record<string, unknown>).sort()).toEqual([
      'brief',
      'preferredPaymentMethod',
      'title',
    ]);
  });

  it('refuses what the contract refuses, without reaching the API', async () => {
    const seen: Seen[] = [];
    for (const body of [
      { ...ADMIN_ONLY_BODY, preferredPaymentMethod: undefined },
      { ...ADMIN_ONLY_BODY, preferredPaymentMethod: '' },
      { ...ADMIN_ONLY_BODY, preferredPaymentMethod: 'x'.repeat(121) },
      { ...ADMIN_ONLY_BODY, paymentNotes: 'x'.repeat(2001) },
      { ...ADMIN_ONLY_BODY, title: 'ab' },
      { ...ADMIN_ONLY_BODY, brief: 'too short' },
      { ...ADMIN_ONLY_BODY, budgetMinor: '0' },
      {},
    ]) {
      const response = await handleCreateAdminOnlyServiceRequest(
        post('/api/service-requests/admin-only', body),
        { env: ENV, fetch: api(201, CREATED, seen) },
      );
      expect(response.status).toBe(400);
    }
    expect(seen).toHaveLength(0);
  });

  it('refuses a cross-site request, and one without a session, before reading anything', async () => {
    const seen: Seen[] = [];
    const crossSite = await handleCreateAdminOnlyServiceRequest(
      new Request('https://shop.test/api/service-requests/admin-only', {
        method: 'POST',
        headers: { origin: 'https://evil.test', 'content-type': 'application/json', cookie: COOKIE },
        body: JSON.stringify(ADMIN_ONLY_BODY),
      }),
      { env: ENV, fetch: api(201, CREATED, seen) },
    );
    expect(crossSite.status).toBe(403);

    const noSession = await handleCreateAdminOnlyServiceRequest(
      new Request('https://shop.test/api/service-requests/admin-only', {
        method: 'POST',
        headers: { origin: 'https://shop.test', 'content-type': 'application/json' },
        body: JSON.stringify(ADMIN_ONLY_BODY),
      }),
      { env: ENV, fetch: api(201, CREATED, seen) },
    );
    expect(noSession.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('forwards the currency failure as itself, so a form can say something true', async () => {
    const response = await handleCreateAdminOnlyServiceRequest(
      post('/api/service-requests/admin-only', ADMIN_ONLY_BODY),
      { env: ENV, fetch: api(503, { status: 503, code: 'SERVICE_REQUEST_CURRENCY_UNAVAILABLE' }) },
    );
    expect(response.status).toBe(503);
    expect(((await response.json()) as Record<string, unknown>)['code']).toBe(
      'SERVICE_REQUEST_CURRENCY_UNAVAILABLE',
    );
  });

  it('refuses an answer the contract does not describe', async () => {
    const response = await handleCreateAdminOnlyServiceRequest(
      post('/api/service-requests/admin-only', ADMIN_ONLY_BODY),
      { env: ENV, fetch: api(201, { requestId: REQUEST, status: 'open', preferredPaymentMethod: 'Cash' }) },
    );
    expect(response.status).toBe(503);
  });

  it('never echoes a payment value back to the browser', async () => {
    const response = await handleCreateAdminOnlyServiceRequest(
      post('/api/service-requests/admin-only', {
        ...ADMIN_ONLY_BODY,
        paymentNotes: 'Invoice the company address.',
      }),
      { env: ENV, fetch: api(201, CREATED) },
    );
    const text = await response.text();
    expect(text).not.toContain('Bank transfer');
    expect(text).not.toContain('Invoice the company address');
  });

  it('presents the internal credential and the session, and never the browser cookie', async () => {
    const seen: Seen[] = [];
    await handleCreateAdminOnlyServiceRequest(
      post('/api/service-requests/admin-only', ADMIN_ONLY_BODY),
      { env: ENV, fetch: api(201, CREATED, seen) },
    );
    expect(seen[0]!.headers.get('x-internal-credential')).toBe(ENV.INTERNAL_BFF_CREDENTIAL);
    expect(seen[0]!.headers.get('x-session-token')).toBe(SESSION_TOKEN);
    expect(seen[0]!.headers.get('cookie')).toBeNull();
  });
});

describe('an Admin Only brief read back', () => {
  it('carries its routing mode and neither payment field', async () => {
    const result = await readServiceRequestsMade(
      {},
      {
        env: ENV,
        cookieHeader: COOKIE,
        fetch: api(200, {
          items: [{ ...SUMMARY_ROW, routingMode: 'admin_only', listingSlug: null, listingTitle: null, counterpartyName: null }],
          nextCursor: null,
        }),
      },
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.data.items[0]?.routingMode).toBe('admin_only');
    expect(Object.keys(result.data.items[0] ?? {})).not.toContain('preferredPaymentMethod');
    expect(Object.keys(result.data.items[0] ?? {})).not.toContain('paymentNotes');
  });

  it('refuses a read that carried a payment field the contract does not name', async () => {
    const result = await readServiceRequestDetail(REQUEST, {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: api(200, {
        request: { ...DETAIL_ROW, routingMode: 'admin_only', preferredPaymentMethod: 'Bank transfer' },
      }),
    });
    expect(result.kind).toBe('unavailable');
  });

  it('refuses a routing mode outside the schema vocabulary', async () => {
    const result = await readServiceRequestsMade(
      {},
      {
        env: ENV,
        cookieHeader: COOKIE,
        fetch: api(200, { items: [{ ...SUMMARY_ROW, routingMode: 'staff_pool' }], nextCursor: null }),
      },
    );
    expect(result.kind).toBe('unavailable');
  });
});
