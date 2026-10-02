import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { SESSION_TOKEN_HEADER } from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { AuthenticationRequiredError } from '../src/auth/auth-errors.js';
import { SUPABASE_AUTH_CLIENT } from '../src/auth/login.service.js';
import {
  OFFERS_STORE,
  type OfferDecisionRow,
  type OfferMutationRow,
  type OfferRow,
  type SellerOfferRow,
} from '../src/offers/offers.service.js';
import { CURRENT_USER_STORE } from '../src/users/current-user.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * Offers at the API boundary (Phase 7-H).
 *
 * What is being held to account:
 *
 *   * **nothing about the caller is in a request** — no account, no role, no side of a negotiation, and
 *     what the store is called with is always the account the provider vouched for;
 *   * **nothing about the outcome is in a request either** — no status, no acceptance time and, above all,
 *     no `paymentDueAt`: the strict contracts refuse all three, and the store is never called when one is
 *     sent;
 *   * **a counter names only the offer in its own route** — there is no `parentOfferId` field, and a
 *     listing, seller or currency sent in a body is refused rather than forwarded;
 *   * **every outcome migration 0070 can return becomes exactly one answer**, and a missing payment window
 *     becomes a 503 rather than an acceptance;
 *   * **the wrong side of a negotiation is a plain not-found**, indistinguishable from an offer that is not
 *     there;
 *   * **money crosses as a decimal string of minor units** with its authoritative decimal places, never as
 *     a JSON number.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const OFFER = 'c0000000-0000-4000-8000-000000000001';
const LISTING = 'c0000000-0000-4000-8000-0000000000f1';

const ACCESS_TOKEN = 'offers-canary-access-token-not-a-real-token';

function offerRow(overrides: Partial<OfferRow> = {}): OfferRow {
  return {
    id: OFFER,
    listingId: LISTING,
    listingSlug: 'off-live-one',
    listingTitle: 'An offerable listing',
    sellerSlug: 'off-shop-one',
    sellerDisplayName: 'Offer Shop One',
    // A `bigint` arrives as a string from the driver, and stays one all the way out.
    amountMinor: '430000',
    currencyCode: 'EGP',
    currencyMinorUnit: 2,
    quantity: 3,
    message: 'Meet me here',
    status: 'pending',
    isLapsed: false,
    expiresAt: new Date('2026-05-03T09:00:00.000Z'),
    respondedAt: null,
    acceptedAt: null,
    paymentDueAt: null,
    parentOfferId: null,
    createdAt: new Date('2026-05-01T09:00:00.000Z'),
    ...overrides,
  };
}

function sellerOfferRow(overrides: Partial<SellerOfferRow> = {}): SellerOfferRow {
  const { sellerSlug: _slug, sellerDisplayName: _name, ...core } = offerRow();
  return { ...core, buyerDisplayName: 'Buyer A', ...overrides };
}

interface Recorded {
  readonly calls: string[];
  /** Keyed by operation name, because `calls` also records the provider hop and would misalign. */
  readonly args: Array<{ readonly name: string; readonly input: Record<string, unknown> }>;
}

interface Doubles {
  readonly made?: readonly OfferRow[];
  readonly received?: readonly SellerOfferRow[];
  readonly create?: OfferMutationRow;
  readonly counter?: OfferMutationRow;
  readonly accept?: OfferDecisionRow;
  readonly reject?: OfferDecisionRow;
  readonly withdraw?: OfferDecisionRow;
  readonly tokenFails?: boolean;
  readonly throws?: boolean;
}

let app: NestFastifyApplication | undefined;

async function start(doubles: Doubles = {}): Promise<Recorded> {
  const recorded: Recorded = { calls: [], args: [] };
  const record = <T>(name: string, input: unknown, value: T): T => {
    recorded.calls.push(name);
    recorded.args.push({
      name,
      input: (typeof input === 'object' && input !== null ? input : { input }) as Record<string, unknown>,
    });
    if (doubles.throws === true) throw new Error('database unavailable');
    return value;
  };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(TEST_ENV)] })
    .overrideProvider(SUPABASE_AUTH_CLIENT)
    .useValue({
      getUser: async () => {
        recorded.calls.push('get-user');
        if (doubles.tokenFails === true) throw new AuthenticationRequiredError();
        return { id: USER, phone: null };
      },
    })
    .overrideProvider(CURRENT_USER_STORE)
    .useValue({ userIdentity: async (userId: string) => ({ id: userId, displayName: 'Amina' }) })
    .overrideProvider(OFFERS_STORE)
    .useValue({
      offersForBuyer: async (input: unknown) => record('made', input, doubles.made ?? [offerRow()]),
      offersForSeller: async (input: unknown) =>
        record('received', input, doubles.received ?? [sellerOfferRow()]),
      offerCreate: async (input: unknown) =>
        record('create', input, doubles.create ?? { outcome: 'created', offerId: OFFER, status: 'pending' }),
      offerCounter: async (input: unknown) =>
        record('counter', input, doubles.counter ?? { outcome: 'countered', offerId: OFFER, status: 'pending' }),
      offerAccept: async (input: unknown) =>
        record(
          'accept',
          input,
          doubles.accept ?? {
            outcome: 'accepted',
            status: 'accepted',
            acceptedAt: new Date('2026-05-02T09:00:00.000Z'),
            paymentDueAt: new Date('2026-05-04T09:00:00.000Z'),
          },
        ),
      offerReject: async (input: unknown) =>
        record(
          'reject',
          input,
          doubles.reject ?? { outcome: 'rejected', status: 'rejected', acceptedAt: null, paymentDueAt: null },
        ),
      offerWithdraw: async (input: unknown) =>
        record(
          'withdraw',
          input,
          doubles.withdraw ?? { outcome: 'withdrawn', status: 'withdrawn', acceptedAt: null, paymentDueAt: null },
        ),
    })
    .compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(
    createFastifyAdapter(TEST_ENV, { logStream: { write: () => undefined } }),
    NEST_APP_OPTIONS,
  );
  await configureApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return recorded;
}

interface Result {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly raw: string;
}

async function call(
  method: 'GET' | 'POST',
  url: string,
  options: { accessToken?: string | null; payload?: unknown; headers?: Record<string, string> } = {},
): Promise<Result> {
  const headers: Record<string, string> = {
    [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL,
    ...options.headers,
  };
  const accessToken = options.accessToken === undefined ? ACCESS_TOKEN : options.accessToken;
  if (accessToken !== null) headers[SESSION_TOKEN_HEADER] = accessToken;
  if (options.payload !== undefined) headers['content-type'] = 'application/json';

  const response = await app!.inject({
    method,
    url,
    headers,
    ...(options.payload === undefined ? {} : { payload: JSON.stringify(options.payload) }),
  });
  return {
    status: response.statusCode,
    body: response.body.length > 0 ? (JSON.parse(response.body) as Record<string, unknown>) : {},
    raw: response.body,
  };
}

const MADE = '/v1/offers/made';
const RECEIVED = '/v1/offers/received';
const CREATE = '/v1/offers';
const COUNTER = `/v1/offers/${OFFER}/counter`;
const ACCEPT = `/v1/offers/${OFFER}/accept`;
const REJECT = `/v1/offers/${OFFER}/reject`;
const WITHDRAW = `/v1/offers/${OFFER}/withdraw`;

const VALID_CREATE = { listingId: LISTING, amountMinor: '430000', quantity: 2 };
const VALID_COUNTER = { amountMinor: '440000', quantity: 1 };

const arg = (recorded: Recorded, name: string): Record<string, unknown> | undefined =>
  recorded.args.find((entry) => entry.name === name)?.input;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/* ------------------------------------------------------------------------------------------------ */

describe('the session is the only authority', () => {
  it('serves every route for the caller the provider vouched for', async () => {
    await start();
    expect((await call('GET', MADE)).status).toBe(200);
    expect((await call('GET', RECEIVED)).status).toBe(200);
    expect((await call('POST', CREATE, { payload: VALID_CREATE })).status).toBe(201);
    expect((await call('POST', COUNTER, { payload: VALID_COUNTER })).status).toBe(201);
    expect((await call('POST', ACCEPT)).status).toBe(200);
    expect((await call('POST', REJECT)).status).toBe(200);
    expect((await call('POST', WITHDRAW)).status).toBe(200);
  });

  it('refuses every route without a session, before asking anything', async () => {
    const recorded = await start();
    for (const [method, url, payload] of [
      ['GET', MADE, undefined],
      ['GET', RECEIVED, undefined],
      ['POST', CREATE, VALID_CREATE],
      ['POST', COUNTER, VALID_COUNTER],
      ['POST', ACCEPT, undefined],
      ['POST', REJECT, undefined],
      ['POST', WITHDRAW, undefined],
    ] as const) {
      const result = await call(method, url, {
        accessToken: null,
        ...(payload === undefined ? {} : { payload }),
      });
      expect(result.status, url).toBe(401);
    }
    expect(recorded.calls).toEqual([]);
  });

  it('refuses a token the provider does not vouch for, before the database is asked', async () => {
    const recorded = await start({ tokenFails: true });
    expect((await call('POST', ACCEPT)).status).toBe(401);
    expect(recorded.calls).toEqual(['get-user']);
  });

  it('refuses without the internal credential, whoever is asking', async () => {
    await start();
    const response = await app!.inject({
      method: 'GET',
      url: MADE,
      headers: { [SESSION_TOKEN_HEADER]: ACCESS_TOKEN },
    });
    expect(response.statusCode).toBe(403);
  });

  it('acts as the vouched-for account, whatever a header or body claims', async () => {
    const recorded = await start();
    await call('POST', ACCEPT, {
      headers: { 'x-user-id': 'c0000000-0000-4000-8000-0000000000aa' },
    });
    expect(arg(recorded, 'accept')?.['sellerId']).toBe(USER);

    await call('GET', MADE, { headers: { 'x-user-id': 'c0000000-0000-4000-8000-0000000000aa' } });
    expect(arg(recorded, 'made')?.['userId']).toBe(USER);
  });

  it('keeps the two sides of a negotiation on separate operations, with no role anywhere', async () => {
    const recorded = await start();
    await call('GET', MADE);
    await call('GET', RECEIVED);

    // Each list called its own reader; there is no parameter either of them shares that names a side.
    expect(recorded.calls.filter((name) => name === 'made')).toHaveLength(1);
    expect(recorded.calls.filter((name) => name === 'received')).toHaveLength(1);
    expect(Object.keys(arg(recorded, 'made') ?? {}).sort()).toEqual([
      'cursorCreatedAt',
      'cursorId',
      'limit',
      'userId',
    ]);
  });
});

describe('nothing about the outcome comes from a request', () => {
  it.each([
    ['a payment deadline', { ...VALID_CREATE, paymentDueAt: '2026-05-04T09:00:00.000Z' }],
    ['an acceptance time', { ...VALID_CREATE, acceptedAt: '2026-05-02T09:00:00.000Z' }],
    ['a status', { ...VALID_CREATE, status: 'accepted' }],
    ['a seller', { ...VALID_CREATE, sellerUserId: USER }],
    ['a currency', { ...VALID_CREATE, currencyCode: 'USD' }],
    ['an expiry', { ...VALID_CREATE, expiresAt: '2027-01-01T00:00:00.000Z' }],
    ['a buyer', { ...VALID_CREATE, buyerUserId: USER }],
    ['accepted terms', { ...VALID_CREATE, acceptedTerms: { amount_minor: '1' } }],
  ])('refuses a create carrying %s, and writes nothing', async (_name, payload) => {
    const recorded = await start();
    const result = await call('POST', CREATE, { payload });
    expect(result.status).toBe(400);
    expect(recorded.calls).not.toContain('create');
  });

  it.each([
    ['a parent offer', { ...VALID_COUNTER, parentOfferId: OFFER }],
    ['a listing', { ...VALID_COUNTER, listingId: LISTING }],
    ['a seller', { ...VALID_COUNTER, sellerUserId: USER }],
    ['a currency', { ...VALID_COUNTER, currencyCode: 'USD' }],
    ['a payment deadline', { ...VALID_COUNTER, paymentDueAt: '2026-05-04T09:00:00.000Z' }],
  ])('refuses a counter carrying %s, and writes nothing', async (_name, payload) => {
    const recorded = await start();
    const result = await call('POST', COUNTER, { payload });
    expect(result.status).toBe(400);
    expect(recorded.calls).not.toContain('counter');
  });

  it('accepts and rejects and withdraws with no body at all', async () => {
    const recorded = await start();
    for (const url of [ACCEPT, REJECT, WITHDRAW]) {
      expect((await call('POST', url)).status, url).toBe(200);
    }
    // Each of the three was called with an offer and an account, and nothing else.
    for (const name of ['accept', 'reject', 'withdraw']) {
      const keys = Object.keys(arg(recorded, name) ?? {}).sort();
      expect(keys, name).toHaveLength(2);
      expect(keys.some((key) => key === 'offerId'), name).toBe(true);
    }
  });

  it('passes the counter the offer from its own route and nothing else', async () => {
    const recorded = await start();
    await call('POST', COUNTER, { payload: VALID_COUNTER });
    const counter = arg(recorded, 'counter');
    expect(counter?.['parentOfferId']).toBe(OFFER);
    expect(Object.keys(counter ?? {}).sort()).toEqual([
      'amountMinor',
      'buyerId',
      'message',
      'parentOfferId',
      'quantity',
    ]);
  });
});

describe('money', () => {
  it('crosses as a decimal string of minor units, with its decimal places', async () => {
    await start();
    const result = await call('GET', MADE);
    const item = (result.body['items'] as Array<Record<string, unknown>>)[0]!;

    expect(item['amountMinor']).toBe('430000');
    expect(typeof item['amountMinor']).toBe('string');
    expect(item['currencyCode']).toBe('EGP');
    expect(item['currencyMinorUnit']).toBe(2);
  });

  it.each([
    ['a number', 430000],
    ['a decimal string with a point', '4300.00'],
    ['a negative amount', '-430000'],
    ['zero', '0'],
    ['a leading zero', '0430000'],
    ['an empty string', ''],
    ['something that is not a number', 'lots'],
  ])('refuses an amount sent as %s', async (_name, amountMinor) => {
    const recorded = await start();
    const result = await call('POST', CREATE, { payload: { ...VALID_CREATE, amountMinor } });
    expect(result.status).toBe(400);
    expect(recorded.calls).not.toContain('create');
  });

  it('refuses a quantity that is not a positive integer', async () => {
    const recorded = await start();
    for (const quantity of [0, -1, 1.5, '2']) {
      const result = await call('POST', CREATE, { payload: { ...VALID_CREATE, quantity } });
      expect(result.status, String(quantity)).toBe(400);
    }
    expect(recorded.calls).not.toContain('create');
  });

  it('defaults the quantity to one rather than guessing', async () => {
    const recorded = await start();
    await call('POST', CREATE, { payload: { listingId: LISTING, amountMinor: '430000' } });
    expect(arg(recorded, 'create')?.['quantity']).toBe(1);
  });
});

describe('the lists', () => {
  it('reports a cursor when there is another page, and none at the end', async () => {
    await start({ made: [offerRow(), offerRow({ id: 'c0000000-0000-4000-8000-000000000002' })] });
    const first = await call('GET', `${MADE}?limit=1`);
    expect((first.body['items'] as unknown[]).length).toBe(1);
    expect(typeof first.body['nextCursor']).toBe('string');

    const cursor = String(first.body['nextCursor']);
    expect((await call('GET', `${MADE}?limit=1&cursor=${cursor}`)).status).toBe(200);
  });

  it('reports no cursor when the page is the end of the list', async () => {
    await start({ made: [offerRow()] });
    expect((await call('GET', `${MADE}?limit=20`)).body['nextCursor']).toBeNull();
  });

  it('refuses an unusable cursor rather than paging from the beginning', async () => {
    const recorded = await start();
    for (const cursor of ['!!!!', 'not-a-cursor', Buffer.from('zz|x|y').toString('base64url')]) {
      const result = await call('GET', `${MADE}?cursor=${encodeURIComponent(cursor)}`);
      expect(result.status, cursor).toBe(400);
      expect(result.body['code'], cursor).toBe('OFFERS_CURSOR_INVALID');
    }
    expect(recorded.calls).not.toContain('made');
  });

  it('clamps the limit rather than trusting it', async () => {
    const recorded = await start();
    await call('GET', `${MADE}?limit=5000`);
    // One more than the page size is asked for, to learn whether there is a next page.
    expect(Number(arg(recorded, 'made')?.['limit'])).toBeLessThanOrEqual(51);
  });

  it('carries no account identifier on either side', async () => {
    await start();
    const made = (await call('GET', MADE)).body['items'] as Array<Record<string, unknown>>;
    expect(Object.keys(made[0]!).sort()).toEqual([
      'acceptedAt',
      'amountMinor',
      'createdAt',
      'currencyCode',
      'currencyMinorUnit',
      'expiresAt',
      'id',
      'isLapsed',
      'listingId',
      'listingSlug',
      'listingTitle',
      'message',
      'parentOfferId',
      'paymentDueAt',
      'quantity',
      'respondedAt',
      'sellerDisplayName',
      'sellerSlug',
      'status',
    ]);

    const received = (await call('GET', RECEIVED)).body['items'] as Array<Record<string, unknown>>;
    expect(Object.keys(received[0]!)).toContain('buyerDisplayName');
    for (const field of ['buyerUserId', 'sellerUserId', 'buyerEmail', 'buyerPhone']) {
      expect(Object.keys(received[0]!), field).not.toContain(field);
    }
  });

  it('reports a lapsed window without inventing a status for it', async () => {
    await start({ made: [offerRow({ isLapsed: true, status: 'pending' })] });
    const item = ((await call('GET', MADE)).body['items'] as Array<Record<string, unknown>>)[0]!;
    expect(item['isLapsed']).toBe(true);
    expect(item['status']).toBe('pending');
  });
});

describe('acceptance', () => {
  it('answers with the obligation the database recorded', async () => {
    await start();
    const result = await call('POST', ACCEPT);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      status: 'accepted',
      acceptedAt: '2026-05-02T09:00:00.000Z',
      paymentDueAt: '2026-05-04T09:00:00.000Z',
    });
  });

  it('records no obligation on a rejection or a withdrawal', async () => {
    await start();
    for (const url of [REJECT, WITHDRAW]) {
      const result = await call('POST', url);
      expect(result.body['acceptedAt'], url).toBeNull();
      expect(result.body['paymentDueAt'], url).toBeNull();
    }
  });

  it('turns a missing payment window into an integrity failure, never an acceptance', async () => {
    await start({
      accept: { outcome: 'payment_policy_missing', status: 'pending', acceptedAt: null, paymentDueAt: null },
    });
    const result = await call('POST', ACCEPT);

    expect(result.status).toBe(503);
    expect(result.body['code']).toBe('OFFER_PAYMENT_POLICY_MISSING');
    expect(result.body['status']).toBe(503);
    // The caller is not told that an admin setting is missing.
    expect(result.raw).not.toContain('payment_due_hours');
    expect(result.raw).not.toContain('site_setting');
  });

  it('never computes a deadline of its own', async () => {
    const recorded = await start();
    await call('POST', ACCEPT);
    // Nothing resembling a duration or a deadline was sent to the database.
    const keys = Object.keys(arg(recorded, 'accept') ?? {});
    for (const key of keys) {
      expect(key.toLowerCase()).not.toContain('due');
      expect(key.toLowerCase()).not.toContain('hour');
      expect(key.toLowerCase()).not.toContain('accepted');
    }
  });
});

describe('every outcome becomes one answer', () => {
  it.each([
    ['exists', 409, 'OFFER_ALREADY_OPEN'],
    ['not_available', 409, 'OFFER_NOT_AVAILABLE'],
    ['own_listing', 409, 'OFFER_OWN_LISTING'],
    ['blocked', 409, 'OFFER_BLOCKED'],
    ['not_found', 404, 'NOT_FOUND'],
    ['invalid', 404, 'NOT_FOUND'],
  ])('turns a create outcome of %s into %i', async (outcome, status, code) => {
    await start({ create: { outcome, offerId: null, status: null } });
    const result = await call('POST', CREATE, { payload: VALID_CREATE });
    expect(result.status).toBe(status);
    expect(result.body['code']).toBe(code);
  });

  it.each([
    ['conflict', 409, 'OFFER_NOT_ACTIONABLE'],
    ['expired', 409, 'OFFER_LAPSED'],
    ['not_found', 404, 'NOT_FOUND'],
    ['not_available', 409, 'OFFER_NOT_AVAILABLE'],
    ['blocked', 409, 'OFFER_BLOCKED'],
  ])('turns a counter outcome of %s into %i', async (outcome, status, code) => {
    await start({ counter: { outcome, offerId: null, status: 'pending' } });
    const result = await call('POST', COUNTER, { payload: VALID_COUNTER });
    expect(result.status).toBe(status);
    expect(result.body['code']).toBe(code);
  });

  it.each([
    ['conflict', 409, 'OFFER_NOT_ACTIONABLE'],
    ['expired', 409, 'OFFER_LAPSED'],
    ['not_found', 404, 'NOT_FOUND'],
  ])('turns a decision outcome of %s into %i, on all three transitions', async (outcome, status, code) => {
    await start({
      accept: { outcome, status: 'accepted', acceptedAt: null, paymentDueAt: null },
      reject: { outcome, status: 'accepted', acceptedAt: null, paymentDueAt: null },
      withdraw: { outcome, status: 'accepted', acceptedAt: null, paymentDueAt: null },
    });
    for (const url of [ACCEPT, REJECT, WITHDRAW]) {
      const result = await call('POST', url);
      expect(result.status, url).toBe(status);
      expect(result.body['code'], url).toBe(code);
    }
  });

  it('treats an outcome it does not understand as an outage, never as a success', async () => {
    await start({ accept: { outcome: 'something_new', status: null, acceptedAt: null, paymentDueAt: null } });
    expect((await call('POST', ACCEPT)).status).toBe(503);
  });

  it('turns an unreachable database into an outage on every route', async () => {
    await start({ throws: true });
    expect((await call('GET', MADE)).status).toBe(503);
    expect((await call('GET', RECEIVED)).status).toBe(503);
    expect((await call('POST', CREATE, { payload: VALID_CREATE })).status).toBe(503);
    expect((await call('POST', ACCEPT)).status).toBe(503);
  });

  it('refuses an offer identifier that is not one, before the database is asked', async () => {
    const recorded = await start();
    for (const id of ['not-a-uuid', 'xyz', '1']) {
      const result = await call('POST', `/v1/offers/${encodeURIComponent(id)}/accept`);
      expect(result.status, id).toBe(400);
    }
    expect(recorded.calls).not.toContain('accept');
  });
});

describe('nothing beyond the obligation happens here', () => {
  it('exposes no checkout, order, payment or shipping operation under this controller', async () => {
    await start();
    for (const url of [
      '/v1/offers/checkout',
      `/v1/offers/${OFFER}/checkout`,
      `/v1/offers/${OFFER}/pay`,
      `/v1/offers/${OFFER}/order`,
    ]) {
      const result = await call('POST', url);
      // Either no such route, or an identifier that is not one. Never a payment.
      expect([400, 404], url).toContain(result.status);
    }
  });

  it('never echoes the caller’s token or the internal credential', async () => {
    await start();
    for (const [method, url, payload] of [
      ['GET', MADE, undefined],
      ['POST', CREATE, VALID_CREATE],
      ['POST', ACCEPT, undefined],
    ] as const) {
      const result = await call(method, url, payload === undefined ? {} : { payload });
      expect(result.raw, url).not.toContain(ACCESS_TOKEN);
      expect(result.raw, url).not.toContain(TEST_INTERNAL_CREDENTIAL);
    }
  });
});
