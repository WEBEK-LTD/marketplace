import { describe, expect, it } from 'vitest';
import {
  handleAcceptOffer,
  handleCounterOffer,
  handleCreateOffer,
  handleRejectOffer,
  handleWithdrawOffer,
  readOffersMade,
  readOffersReceived,
} from '../src/server/bff/offers';

/**
 * The BFF half of offers (Phase 7-H).
 *
 * What matters at this boundary:
 *
 *   * the caller's token comes from `__Host-mp_access` and never from a body, and the browser's own
 *     `Cookie` header is never forwarded upstream;
 *   * **bodies are rebuilt, never forwarded** — a page that added a `paymentDueAt`, a `status`, a seller, a
 *     currency, an expiry or a `parentOfferId` has all of them dropped before anything leaves this origin;
 *   * **an offer is named in the route, never in a body**, so a decision cannot be redirected at somebody
 *     else's negotiation by a field;
 *   * **answers are validated against the contract**, so an object a drifted API sent cannot reach a page;
 *   * a session that ended, a refused cursor and a service that could not answer stay three distinct
 *     things;
 *   * every write refuses a cross-site request before it reads anything else.
 */

const ENV = Object.freeze({
  API_BASE_URL: 'https://api.internal.test',
  PUBLIC_WEB_ORIGIN: 'https://web.test',
  INTERNAL_BFF_CREDENTIAL: 'test-current-credential-value-not-a-real-se',
});

const SESSION_TOKEN = 'offers-canary-access-token-not-a-real-token';
const COOKIE = `__Host-mp_access=${SESSION_TOKEN}`;

const OFFER = 'c0000000-0000-4000-8000-000000000001';
const LISTING = 'c0000000-0000-4000-8000-0000000000f1';

const OFFER_ROW = {
  id: OFFER,
  listingId: LISTING,
  listingSlug: 'off-live-one',
  listingTitle: 'An offerable listing',
  amountMinor: '430000',
  currencyCode: 'EGP',
  currencyMinorUnit: 2,
  quantity: 3,
  message: 'Meet me here',
  status: 'pending',
  isLapsed: false,
  expiresAt: '2026-05-03T09:00:00.000Z',
  respondedAt: null,
  acceptedAt: null,
  paymentDueAt: null,
  parentOfferId: null,
  createdAt: '2026-05-01T09:00:00.000Z',
  sellerSlug: 'off-shop-one',
  sellerDisplayName: 'Offer Shop One',
};

const SELLER_ROW = (() => {
  const { sellerSlug: _slug, sellerDisplayName: _name, ...core } = OFFER_ROW;
  return { ...core, buyerDisplayName: 'Buyer A' };
})();

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

const VALID_CREATE = { listingId: LISTING, amountMinor: '430000', quantity: 2 };

/* ------------------------------------------------------------------------------------------------ */

describe('reading the two lists', () => {
  it('presents the caller’s token and the internal credential, and never the browser cookie', async () => {
    const seen: Seen[] = [];
    await readOffersMade({}, { env: ENV, cookieHeader: COOKIE, fetch: api(200, { items: [OFFER_ROW], nextCursor: null }, seen) });

    expect(seen[0]!.url).toBe('https://api.internal.test/v1/offers/made');
    expect(seen[0]!.method).toBe('GET');
    expect(seen[0]!.headers.get('x-session-token')).toBe(SESSION_TOKEN);
    expect(seen[0]!.headers.get('x-internal-credential')).toBe(ENV.INTERNAL_BFF_CREDENTIAL);
    expect(seen[0]!.headers.get('cookie')).toBeNull();
  });

  it('reads the two sides from two different operations', async () => {
    const seen: Seen[] = [];
    await readOffersMade({}, { env: ENV, cookieHeader: COOKIE, fetch: api(200, { items: [], nextCursor: null }, seen) });
    await readOffersReceived({}, { env: ENV, cookieHeader: COOKIE, fetch: api(200, { items: [], nextCursor: null }, seen) });

    expect(seen[0]!.url).toBe('https://api.internal.test/v1/offers/made');
    expect(seen[1]!.url).toBe('https://api.internal.test/v1/offers/received');
    // Neither address carries a role, a side or an account.
    for (const request of seen) {
      expect(request.url).not.toContain('role=');
      expect(request.url).not.toContain('user');
    }
  });

  it('never reaches the API without a session cookie', async () => {
    const seen: Seen[] = [];
    const result = await readOffersMade({}, { env: ENV, cookieHeader: null, fetch: api(200, {}, seen) });
    expect(result.kind).toBe('unauthenticated');
    expect(seen).toEqual([]);
  });

  it('passes a cursor through verbatim, without understanding it', async () => {
    const seen: Seen[] = [];
    await readOffersMade(
      { cursor: 'b2YxfHRva2Vu', limit: '5' },
      { env: ENV, cookieHeader: COOKIE, fetch: api(200, { items: [], nextCursor: null }, seen) },
    );
    const url = new URL(seen[0]!.url);
    expect(url.searchParams.get('cursor')).toBe('b2YxfHRva2Vu');
    expect(url.searchParams.get('limit')).toBe('5');
  });

  it.each([
    ['an offer with a field the contract does not name', { items: [{ ...OFFER_ROW, buyerUserId: OFFER }], nextCursor: null }],
    ['a status the contract does not name', { items: [{ ...OFFER_ROW, status: 'paid' }], nextCursor: null }],
    ['an amount as a JSON number', { items: [{ ...OFFER_ROW, amountMinor: 430000 }], nextCursor: null }],
    ['items that are not an array', { items: 'all', nextCursor: null }],
    ['no items at all', { nextCursor: null }],
  ])('refuses an answer carrying %s', async (_name, payload) => {
    const result = await readOffersMade({}, { env: ENV, cookieHeader: COOKIE, fetch: api(200, payload) });
    expect(result.kind).toBe('unavailable');
  });

  it('refuses a seller answer that carries the buyer’s account', async () => {
    const result = await readOffersReceived(
      {},
      { env: ENV, cookieHeader: COOKIE, fetch: api(200, { items: [{ ...SELLER_ROW, buyerUserId: OFFER }], nextCursor: null }) },
    );
    expect(result.kind).toBe('unavailable');
  });

  it('keeps an ended session, a refused cursor and an outage apart', async () => {
    const ended = await readOffersMade({}, { env: ENV, cookieHeader: COOKIE, fetch: api(401, {}) });
    expect(ended.kind).toBe('unauthenticated');

    const cursor = await readOffersMade({}, { env: ENV, cookieHeader: COOKIE, fetch: api(400, {}) });
    expect(cursor.kind).toBe('invalid');

    for (const status of [403, 404, 500, 503]) {
      const down = await readOffersMade({}, { env: ENV, cookieHeader: COOKIE, fetch: api(status, {}) });
      expect(down.kind, String(status)).toBe('unavailable');
    }
  });

  it('treats an unreachable API as an outage rather than a refusal', async () => {
    const failing = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;
    expect((await readOffersMade({}, { env: ENV, cookieHeader: COOKIE, fetch: failing })).kind).toBe(
      'unavailable',
    );
  });
});

describe('opening an offer', () => {
  it('sends exactly the four contract fields and drops everything else a page added', async () => {
    const seen: Seen[] = [];
    const response = await handleCreateOffer(
      post('/api/offers', {
        ...VALID_CREATE,
        message: '  Please consider  ',
        sellerUserId: OFFER,
        currencyCode: 'USD',
        expiresAt: '2027-01-01T00:00:00.000Z',
        status: 'accepted',
        acceptedAt: '2026-05-02T09:00:00.000Z',
        paymentDueAt: '2026-05-04T09:00:00.000Z',
        acceptedTerms: { amount_minor: '1' },
      }),
      { env: ENV, fetch: api(201, { offerId: OFFER, status: 'pending' }, seen) },
    );

    expect(response.status).toBe(201);
    expect(JSON.parse(seen[0]!.body)).toEqual({
      listingId: LISTING,
      amountMinor: '430000',
      quantity: 2,
      message: 'Please consider',
    });
    expect(seen[0]!.url).toBe('https://api.internal.test/v1/offers');
    expect(seen[0]!.headers.get('cookie')).toBeNull();
  });

  it('omits the note entirely when it is blank', async () => {
    const seen: Seen[] = [];
    await handleCreateOffer(post('/api/offers', { ...VALID_CREATE, message: '   ' }), {
      env: ENV,
      fetch: api(201, { offerId: OFFER, status: 'pending' }, seen),
    });
    expect(JSON.parse(seen[0]!.body)).toEqual({ listingId: LISTING, amountMinor: '430000', quantity: 2 });
  });

  it('defaults the quantity rather than sending nothing', async () => {
    const seen: Seen[] = [];
    await handleCreateOffer(post('/api/offers', { listingId: LISTING, amountMinor: '430000' }), {
      env: ENV,
      fetch: api(201, { offerId: OFFER, status: 'pending' }, seen),
    });
    expect(JSON.parse(seen[0]!.body)['quantity']).toBe(1);
  });

  it('refuses a cross-site request before anything else', async () => {
    const seen: Seen[] = [];
    const response = await handleCreateOffer(
      post('/api/offers', VALID_CREATE, { origin: 'https://evil.test' }),
      { env: ENV, fetch: api(201, {}, seen) },
    );
    expect(response.status).toBe(403);
    expect(seen).toEqual([]);
  });

  it('refuses a request with no session, before reaching the API', async () => {
    const seen: Seen[] = [];
    const request = new Request('https://shop.test/api/offers', {
      method: 'POST',
      headers: { origin: 'https://shop.test', 'content-type': 'application/json' },
      body: JSON.stringify(VALID_CREATE),
    });
    const response = await handleCreateOffer(request, { env: ENV, fetch: api(201, {}, seen) });
    expect(response.status).toBe(401);
    expect(seen).toEqual([]);
  });

  it.each([
    ['no listing', { amountMinor: '430000' }],
    ['a listing that is not an identifier', { listingId: '../x', amountMinor: '430000' }],
    ['no amount', { listingId: LISTING }],
    ['an amount as a number', { listingId: LISTING, amountMinor: 430000 }],
    ['a decimal amount', { listingId: LISTING, amountMinor: '4300.00' }],
    ['a zero amount', { listingId: LISTING, amountMinor: '0' }],
    ['a negative amount', { listingId: LISTING, amountMinor: '-1' }],
    ['a zero quantity', { listingId: LISTING, amountMinor: '430000', quantity: 0 }],
    ['a note longer than the column', { listingId: LISTING, amountMinor: '430000', message: 'x'.repeat(2001) }],
  ])('refuses a create with %s, without a round trip', async (_name, body) => {
    const seen: Seen[] = [];
    const response = await handleCreateOffer(post('/api/offers', body), { env: ENV, fetch: api(201, {}, seen) });
    expect(response.status).toBe(400);
    expect(seen).toEqual([]);
  });

  it('forwards the API’s own refusal so a form can act on it', async () => {
    for (const code of ['OFFER_ALREADY_OPEN', 'OFFER_OWN_LISTING', 'OFFER_NOT_AVAILABLE', 'OFFER_BLOCKED']) {
      const response = await handleCreateOffer(post('/api/offers', VALID_CREATE), {
        env: ENV,
        fetch: api(409, { code }),
      });
      expect(response.status, code).toBe(409);
      expect(JSON.parse(await response.text())['code'], code).toBe(code);
    }
  });

  it('refuses a success body that carries anything the contract does not name', async () => {
    const response = await handleCreateOffer(post('/api/offers', VALID_CREATE), {
      env: ENV,
      fetch: api(201, { offerId: OFFER, status: 'pending', secret: 'leaked' }),
    });
    const text = await response.text();
    expect(response.status).toBe(503);
    expect(text).not.toContain('leaked');
  });
});

describe('countering', () => {
  it('names the offer in the route and sends no parent in the body', async () => {
    const seen: Seen[] = [];
    const response = await handleCounterOffer(
      post(`/api/offers/${OFFER}/counter`, {
        amountMinor: '440000',
        quantity: 2,
        parentOfferId: 'c0000000-0000-4000-8000-0000000000aa',
        listingId: 'c0000000-0000-4000-8000-0000000000bb',
        sellerUserId: OFFER,
      }),
      OFFER,
      { env: ENV, fetch: api(201, { offerId: OFFER, status: 'pending' }, seen) },
    );

    expect(response.status).toBe(201);
    expect(seen[0]!.url).toBe(`https://api.internal.test/v1/offers/${OFFER}/counter`);
    expect(JSON.parse(seen[0]!.body)).toEqual({ amountMinor: '440000', quantity: 2 });
    // The parent a page tried to name is nowhere in what crossed.
    expect(seen[0]!.body).not.toContain('0000000000aa');
    expect(seen[0]!.body).not.toContain('0000000000bb');
  });

  it('refuses an offer identifier that is not one, without a round trip', async () => {
    const seen: Seen[] = [];
    for (const id of ['../x', 'nope', undefined]) {
      const response = await handleCounterOffer(
        post('/api/offers/x/counter', { amountMinor: '440000' }),
        id,
        { env: ENV, fetch: api(201, {}, seen) },
      );
      expect(response.status).toBe(400);
    }
    expect(seen).toEqual([]);
  });
});

describe('the three decisions', () => {
  it.each([
    ['accept', handleAcceptOffer],
    ['reject', handleRejectOffer],
    ['withdraw', handleWithdrawOffer],
  ] as const)('sends %s with no body at all', async (name, handler) => {
    const seen: Seen[] = [];
    const response = await handler(
      post(`/api/offers/${OFFER}/${name}`, { status: 'accepted', paymentDueAt: '2026-01-01T00:00:00.000Z' }),
      OFFER,
      {
        env: ENV,
        fetch: api(200, { status: 'accepted', acceptedAt: null, paymentDueAt: null }, seen),
      },
    );

    expect(response.status).toBe(200);
    expect(seen[0]!.url).toBe(`https://api.internal.test/v1/offers/${OFFER}/${name}`);
    // Whatever the page put in the body is dropped: nothing is forwarded.
    expect(seen[0]!.body).toBe('');
    expect(seen[0]!.headers.get('cookie')).toBeNull();
  });

  it('answers an acceptance with the obligation and nothing else', async () => {
    const response = await handleAcceptOffer(post(`/api/offers/${OFFER}/accept`, {}), OFFER, {
      env: ENV,
      fetch: api(200, {
        status: 'accepted',
        acceptedAt: '2026-05-02T09:00:00.000Z',
        paymentDueAt: '2026-05-04T09:00:00.000Z',
      }),
    });
    expect(JSON.parse(await response.text())).toEqual({
      status: 'accepted',
      acceptedAt: '2026-05-02T09:00:00.000Z',
      paymentDueAt: '2026-05-04T09:00:00.000Z',
    });
  });

  it('forwards the two conflicts so a page can tell them apart', async () => {
    for (const code of ['OFFER_NOT_ACTIONABLE', 'OFFER_LAPSED']) {
      const response = await handleAcceptOffer(post(`/api/offers/${OFFER}/accept`, {}), OFFER, {
        env: ENV,
        fetch: api(409, { code }),
      });
      expect(response.status, code).toBe(409);
      expect(JSON.parse(await response.text())['code'], code).toBe(code);
    }
  });

  it('forwards the payment-policy failure, so a browser is never told an acceptance happened', async () => {
    const response = await handleAcceptOffer(post(`/api/offers/${OFFER}/accept`, {}), OFFER, {
      env: ENV,
      fetch: api(503, { code: 'OFFER_PAYMENT_POLICY_MISSING' }),
    });
    expect(response.status).toBe(503);
    expect(JSON.parse(await response.text())['code']).toBe('OFFER_PAYMENT_POLICY_MISSING');
  });

  it('turns an offer that is not the caller’s into a plain not-found', async () => {
    const response = await handleWithdrawOffer(post(`/api/offers/${OFFER}/withdraw`, {}), OFFER, {
      env: ENV,
      fetch: api(404, { code: 'NOT_FOUND' }),
    });
    expect(response.status).toBe(404);
  });

  it('turns an unexpected upstream status into an outage, never a success', async () => {
    for (const status of [204, 302, 418, 500]) {
      const response = await handleAcceptOffer(post(`/api/offers/${OFFER}/accept`, {}), OFFER, {
        env: ENV,
        fetch: api(status, {}),
      });
      expect(response.status, String(status)).toBe(503);
    }
  });

  it('refuses a cross-site decision, and one with no session', async () => {
    const seen: Seen[] = [];
    const crossSite = await handleAcceptOffer(
      post(`/api/offers/${OFFER}/accept`, {}, { origin: 'https://evil.test' }),
      OFFER,
      { env: ENV, fetch: api(200, {}, seen) },
    );
    expect(crossSite.status).toBe(403);

    const noSession = await handleAcceptOffer(
      new Request(`https://shop.test/api/offers/${OFFER}/accept`, {
        method: 'POST',
        headers: { origin: 'https://shop.test' },
      }),
      OFFER,
      { env: ENV, fetch: api(200, {}, seen) },
    );
    expect(noSession.status).toBe(401);
    expect(seen).toEqual([]);
  });

  it('never returns a cacheable answer', async () => {
    const response = await handleAcceptOffer(post(`/api/offers/${OFFER}/accept`, {}), OFFER, {
      env: ENV,
      fetch: api(200, { status: 'accepted', acceptedAt: null, paymentDueAt: null }),
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('nothing about the caller or the outcome is ever read from a request', () => {
  it('has no field in this module a browser could assert authority or a deadline with', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../src/server/bff/offers.ts', import.meta.url), 'utf8'),
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const field of [
      'buyerUserId',
      'sellerUserId',
      'paymentDueAt',
      'acceptedAt',
      'acceptedTerms',
      'status',
      'expiresAt',
      'parentOfferId',
      'currencyCode',
    ]) {
      expect(code, field).not.toContain(`fields['${field}']`);
      expect(code, field).not.toContain(`body.${field}`);
    }
  });
});
