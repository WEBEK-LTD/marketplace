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
  SERVICE_REQUESTS_STORE,
  type ServiceQuoteDecisionRow,
  type ServiceQuoteMutationRow,
  type ServiceRequestDetailRow,
  type ServiceRequestMutationRow,
  type ServiceRequestRow,
  type ServiceRequestStatusRow,
} from '../src/services/service-requests.service.js';
import { CURRENT_USER_STORE } from '../src/users/current-user.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * Service requests and quotes at the API boundary (Phase 7-I).
 *
 * What is being held to account:
 *
 *   * **nothing about the caller is in a request** — no account, no role, no side of an exchange, and what the
 *     store is called with is always the account the provider vouched for;
 *   * **nothing about the outcome is in a request either** — no status, no currency, no acceptance time and,
 *     above all, no `paymentDueAt`: the strict contracts refuse all of them and the store is never reached;
 *   * **a quote is addressed through its own request**, and a quote that belongs to a different one is a plain
 *     not-found;
 *   * **every outcome migration 0071 can return becomes exactly one answer**, and a missing payment window
 *     becomes a 503 rather than an acceptance;
 *   * **the two sides are separate operations**, so there is no role parameter anywhere;
 *   * **no Option 2 surface exists** — nothing on this controller routes anything to staff.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const REQUEST = 'd1000000-0000-4000-8000-000000000001';
const QUOTE = 'd1000000-0000-4000-8000-0000000000a1';
const LISTING = 'd1000000-0000-4000-8000-0000000000f1';

const ACCESS_TOKEN = 'service-requests-canary-token-not-a-real-tok';

function requestRow(overrides: Partial<ServiceRequestRow> = {}): ServiceRequestRow {
  return {
    id: REQUEST,
    status: 'open',
    routingMode: 'seller',
    title: 'Build me a shelf',
    // A `bigint` arrives as a string from the driver and stays one.
    budgetMinor: '400000',
    currencyCode: 'EGP',
    currencyMinorUnit: 2,
    neededBy: '2026-06-01',
    listingSlug: 'sr-custom-one',
    listingTitle: 'A quotable service',
    counterpartyName: 'Service Shop One',
    quoteCount: 0,
    liveQuoteCount: 0,
    acceptedPaymentDueAt: null,
    closedAt: null,
    createdAt: new Date('2026-05-01T09:00:00.000Z'),
    ...overrides,
  };
}

function detailRow(overrides: Partial<ServiceRequestDetailRow> = {}): ServiceRequestDetailRow {
  return {
    outcome: 'found',
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
    createdAt: new Date('2026-05-01T09:00:00.000Z'),
    quotes: [
      {
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
      },
    ],
    ...overrides,
  };
}

interface Recorded {
  readonly calls: string[];
  readonly args: Array<{ readonly name: string; readonly input: Record<string, unknown> }>;
}

interface Doubles {
  readonly made?: readonly ServiceRequestRow[];
  readonly received?: readonly ServiceRequestRow[];
  readonly detail?: ServiceRequestDetailRow;
  readonly create?: ServiceRequestMutationRow;
  readonly createAdminOnly?: ServiceRequestMutationRow;
  readonly cancel?: ServiceRequestStatusRow;
  readonly decline?: ServiceRequestStatusRow;
  readonly quote?: ServiceQuoteMutationRow;
  readonly accept?: ServiceQuoteDecisionRow;
  readonly reject?: ServiceQuoteDecisionRow;
  readonly withdraw?: ServiceQuoteDecisionRow;
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

  const decision = (status: string): ServiceQuoteDecisionRow => ({
    outcome: status,
    status,
    requestId: REQUEST,
    acceptedAt: status === 'accepted' ? new Date('2026-05-03T09:00:00.000Z') : null,
    paymentDueAt: status === 'accepted' ? new Date('2026-05-05T09:00:00.000Z') : null,
  });

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
    .overrideProvider(SERVICE_REQUESTS_STORE)
    .useValue({
      serviceRequestsForBuyer: async (input: unknown) =>
        record('made', input, doubles.made ?? [requestRow()]),
      serviceRequestsForSeller: async (input: unknown) =>
        record('received', input, doubles.received ?? [requestRow()]),
      serviceRequestDetail: async (input: unknown) =>
        record('detail', input, doubles.detail ?? detailRow()),
      serviceRequestCreateAdminOnly: async (input: unknown) =>
        record(
          'create-admin-only',
          input,
          doubles.createAdminOnly ?? { outcome: 'created', requestId: REQUEST, status: 'open' },
        ),
      serviceRequestCreate: async (input: unknown) =>
        record(
          'create',
          input,
          doubles.create ?? { outcome: 'created', requestId: REQUEST, status: 'open' },
        ),
      serviceRequestCancel: async (input: unknown) =>
        record('cancel', input, doubles.cancel ?? { outcome: 'cancelled', status: 'cancelled' }),
      serviceRequestDecline: async (input: unknown) =>
        record('decline', input, doubles.decline ?? { outcome: 'declined', status: 'declined' }),
      serviceQuoteCreate: async (input: unknown) =>
        record('quote', input, doubles.quote ?? { outcome: 'created', quoteId: QUOTE, status: 'sent' }),
      serviceQuoteAccept: async (input: unknown) =>
        record('accept', input, doubles.accept ?? decision('accepted')),
      serviceQuoteReject: async (input: unknown) =>
        record('reject', input, doubles.reject ?? decision('rejected')),
      serviceQuoteWithdraw: async (input: unknown) =>
        record('withdraw', input, doubles.withdraw ?? decision('withdrawn')),
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

const MADE = '/v1/service-requests/made';
const RECEIVED = '/v1/service-requests/received';
const DETAIL = `/v1/service-requests/${REQUEST}`;
const CREATE = '/v1/service-requests';
const CANCEL = `${DETAIL}/cancel`;
const DECLINE = `${DETAIL}/decline`;
const QUOTES = `${DETAIL}/quotes`;
const ACCEPT = `${QUOTES}/${QUOTE}/accept`;
const REJECT = `${QUOTES}/${QUOTE}/reject`;
const WITHDRAW = `${QUOTES}/${QUOTE}/withdraw`;

const VALID_REQUEST = {
  listingId: LISTING,
  title: 'Build me a shelf',
  brief: 'A brief that is comfortably longer than ten characters.',
};

const arg = (recorded: Recorded, name: string): Record<string, unknown> | undefined =>
  recorded.args.find((entry) => entry.name === name)?.input;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/* ------------------------------------------------------------------------------------------------ */

describe('the session is the only authority', () => {
  // Four routes, not ten. OD-A4 closed the seller's queue, the seller-routed create, the seller's decline
  // and all three quote transitions, and 0110 revoked the functions behind them — so a route that answered
  // 200 here before now does not exist. What survives is the whole of a buyer's dealings with the office.
  it('serves every route for the caller the provider vouched for', async () => {
    await start();
    expect((await call('GET', MADE)).status).toBe(200);
    expect((await call('GET', DETAIL)).status).toBe(200);
    expect((await call('POST', CREATE, { payload: VALID_REQUEST })).status).toBe(201);
    expect((await call('POST', CANCEL)).status).toBe(200);
  });

  // Each closed address is refused, and **nothing reaches the store** — which is the property that
  // matters, and the one asserted. The status is not the same on all six and should not be asserted as
  // one: `/received` is refused with 400 rather than 404 because `:requestId` matches the word and then
  // rejects it as an identifier, while a quote address matches no route at all and is 404. Either way it
  // is gone, and either way the database is never asked.
  it('refuses every address OD-A4 closed, and asks the database for none of them', async () => {
    const recorded = await start();
    for (const [method, url] of [
      ['GET', RECEIVED],
      ['POST', DECLINE],
      ['POST', QUOTES],
      ['POST', ACCEPT],
      ['POST', REJECT],
      ['POST', WITHDRAW],
    ] as const) {
      const result = await call(method, url);
      expect(result.status, url).toBeGreaterThanOrEqual(400);
      expect([400, 404], url).toContain(result.status);
    }
    // The session is still established before routing refuses, so `get-user` is expected here; what must
    // not appear is any store call. Asserting the store names rather than an empty list keeps this test
    // about the closure instead of about where session validation sits in the pipeline.
    for (const name of ['received', 'decline', 'quote', 'accept', 'reject', 'withdraw']) {
      expect(recorded.calls, name).not.toContain(name);
    }
  });

  it('refuses every route without a session, before asking anything', async () => {
    const recorded = await start();
    for (const [method, url, payload] of [
      ['GET', MADE, undefined],
      ['GET', DETAIL, undefined],
      ['POST', CREATE, VALID_REQUEST],
      ['POST', CANCEL, undefined],
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
    expect((await call('POST', CANCEL)).status).toBe(401);
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
    await call('POST', CANCEL, { headers: { 'x-user-id': 'd1000000-0000-4000-8000-0000000000aa' } });
    expect(arg(recorded, 'cancel')?.['buyerId']).toBe(USER);

    await call('POST', CREATE, {
      payload: VALID_REQUEST,
      headers: { 'x-user-id': 'd1000000-0000-4000-8000-0000000000aa' },
    });
    expect(arg(recorded, 'create')?.['buyerId']).toBe(USER);
  });

  // There is one side now. The assertion that survives is the one that mattered: the list reader is given
  // the account, the paging position and nothing else — no role, and no way to ask for somebody else's list.
  it('gives the list reader the account and the position, and no role anywhere', async () => {
    const recorded = await start();
    await call('GET', MADE);

    expect(recorded.calls.filter((name) => name === 'made')).toHaveLength(1);
    expect(recorded.calls.filter((name) => name === 'received')).toHaveLength(0);
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
    ['a payment deadline', { ...VALID_REQUEST, paymentDueAt: '2026-05-05T09:00:00.000Z' }],
    ['a status', { ...VALID_REQUEST, status: 'accepted' }],
    ['a seller', { ...VALID_REQUEST, sellerUserId: USER }],
    ['a buyer', { ...VALID_REQUEST, buyerUserId: USER }],
    ['a currency', { ...VALID_REQUEST, currencyCode: 'USD' }],
    ['a closing time', { ...VALID_REQUEST, closedAt: '2026-05-05T09:00:00.000Z' }],
    ['a routing decision', { ...VALID_REQUEST, routeToAdmin: true }],
    // D7-08's column, by its real name and by its admin value. Option 2 is 7-J's; nothing here accepts it.
    ['a routing mode', { ...VALID_REQUEST, routingMode: 'admin_only' }],
    ['the admin-only mode alone', { ...VALID_REQUEST, adminOnly: true }],
  ])('refuses a request create carrying %s, and writes nothing', async (_name, payload) => {
    const recorded = await start();
    const result = await call('POST', CREATE, { payload });
    expect(result.status).toBe(400);
    expect(recorded.calls).not.toContain('create');
  });

  // Cancelling is the one transition a buyer still has (OD-A4 closed the rest), and it still takes no
  // body: the account comes from the session and the request from the route, so there is nothing a caller
  // could put in a body that this surface would read.
  it('cancels with no body at all, and sends exactly the two values it was given', async () => {
    const recorded = await start();
    expect((await call('POST', CANCEL)).status).toBe(200);
    expect(Object.keys(arg(recorded, 'cancel') ?? {}).sort()).toHaveLength(2);
  });
});

describe('money and the brief', () => {
  it('crosses as a decimal string of minor units with its decimal places', async () => {
    await start();
    const item = ((await call('GET', MADE)).body['items'] as Array<Record<string, unknown>>)[0]!;
    expect(item['budgetMinor']).toBe('400000');
    expect(item['currencyCode']).toBe('EGP');
    expect(item['currencyMinorUnit']).toBe(2);
  });

  it.each([
    ['a number', 400000],
    ['a decimal string', '4000.00'],
    ['zero', '0'],
    ['a negative amount', '-1'],
  ])('refuses a budget sent as %s', async (_name, budgetMinor) => {
    const recorded = await start();
    expect((await call('POST', CREATE, { payload: { ...VALID_REQUEST, budgetMinor } })).status).toBe(400);
    expect(recorded.calls).not.toContain('create');
  });

  it('accepts a brief with no budget and no date at all', async () => {
    const recorded = await start();
    expect((await call('POST', CREATE, { payload: VALID_REQUEST })).status).toBe(201);
    const create = arg(recorded, 'create');
    expect(create?.['budgetMinor']).toBeNull();
    expect(create?.['neededBy']).toBeNull();
  });

  it('refuses a title or brief outside the schema’s own lengths', async () => {
    const recorded = await start();
    for (const payload of [
      { ...VALID_REQUEST, title: 'ab' },
      { ...VALID_REQUEST, title: 'x'.repeat(141) },
      { ...VALID_REQUEST, brief: 'too short' },
      { ...VALID_REQUEST, brief: 'x'.repeat(10_001) },
    ]) {
      expect((await call('POST', CREATE, { payload })).status).toBe(400);
    }
    expect(recorded.calls).not.toContain('create');
  });

  it('refuses a needed-by date that is not a plain date', async () => {
    const recorded = await start();
    for (const neededBy of ['2026-06-01T00:00:00Z', 'tomorrow', '01-06-2026', '']) {
      expect((await call('POST', CREATE, { payload: { ...VALID_REQUEST, neededBy } })).status).toBe(400);
    }
    expect(recorded.calls).not.toContain('create');
  });
});

describe('the detail', () => {
  it('tells the caller which side they are on, and carries the quotes', async () => {
    await start();
    const result = await call('GET', DETAIL);
    const request = result.body['request'] as Record<string, unknown>;

    expect(request['isBuyer']).toBe(true);
    expect(request['isSeller']).toBe(false);
    expect((request['quotes'] as unknown[]).length).toBe(1);
    expect(result.raw).not.toContain('buyerUserId');
    expect(result.raw).not.toContain('sellerUserId');
  });

  it('projects a quote field by field and drops anything else the database sent', async () => {
    await start({
      detail: detailRow({
        quotes: [
          {
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
            // Two fields a later widening might add. Neither may reach a browser.
            sellerUserId: USER,
            internalNote: 'do not show this',
          },
        ],
      }),
    });
    const result = await call('GET', DETAIL);
    const request = result.body['request'] as Record<string, unknown>;
    const quote = (request['quotes'] as Array<Record<string, unknown>>)[0]!;

    expect(Object.keys(quote).sort()).toEqual([
      'acceptedAt',
      'amountMinor',
      'createdAt',
      'deliveryDays',
      'expiresAt',
      'id',
      'isLapsed',
      'paymentDueAt',
      'respondedAt',
      'revisionsIncluded',
      'scope',
      'status',
    ]);
    expect(result.raw).not.toContain('do not show this');
  });

  it('reports a lapsed quote without inventing a status for it', async () => {
    await start({
      detail: detailRow({
        quotes: [
          {
            id: QUOTE,
            status: 'sent',
            amountMinor: '380000',
            deliveryDays: 10,
            revisionsIncluded: 0,
            scope: 'A scope long enough to satisfy the ten-character rule.',
            isLapsed: true,
            expiresAt: '2026-05-02T09:00:00.000Z',
            respondedAt: null,
            acceptedAt: null,
            paymentDueAt: null,
            createdAt: '2026-05-01T09:00:00.000Z',
          },
        ],
      }),
    });
    const request = (await call('GET', DETAIL)).body['request'] as Record<string, unknown>;
    const quote = (request['quotes'] as Array<Record<string, unknown>>)[0]!;
    expect(quote['isLapsed']).toBe(true);
    expect(quote['status']).toBe('sent');
  });

  it('answers not-found for a request the database does not return', async () => {
    await start({ detail: { ...detailRow(), outcome: 'not_found' } });
    const result = await call('GET', DETAIL);
    expect(result.status).toBe(404);
    expect(result.body['code']).toBe('NOT_FOUND');
  });

  it('refuses an identifier that is not one', async () => {
    const recorded = await start();
    for (const id of ['not-a-uuid', 'xyz', '1']) {
      expect((await call('GET', `/v1/service-requests/${encodeURIComponent(id)}`)).status, id).toBe(400);
    }
    expect(recorded.calls).not.toContain('detail');
  });
});

describe('every outcome becomes one answer', () => {
  it.each([
    ['not_available', 409, 'SERVICE_REQUEST_NOT_AVAILABLE'],
    ['not_custom', 409, 'SERVICE_REQUEST_NOT_CUSTOM'],
    ['own_listing', 409, 'SERVICE_REQUEST_OWN_LISTING'],
    ['blocked', 409, 'SERVICE_REQUEST_BLOCKED'],
    ['not_found', 404, 'NOT_FOUND'],
    ['invalid', 404, 'NOT_FOUND'],
  ])('turns a create outcome of %s into %i', async (outcome, status, code) => {
    await start({ create: { outcome, requestId: null, status: null } });
    const result = await call('POST', CREATE, { payload: VALID_REQUEST });
    expect(result.status).toBe(status);
    expect(result.body['code']).toBe(code);
  });

  // Cancelling alone: the seller's decline went with OD-A4, and the mapping it shared with cancelling is
  // still asserted here on the transition that survives.
  it.each([
    ['conflict', 409, 'SERVICE_REQUEST_NOT_ACTIONABLE'],
    ['not_found', 404, 'NOT_FOUND'],
  ])('turns a cancel outcome of %s into %i', async (outcome, status, code) => {
    await start({ cancel: { outcome, status: 'accepted' } });
    const result = await call('POST', CANCEL);
    expect(result.status).toBe(status);
    expect(result.body['code']).toBe(code);
  });

  it('treats an outcome it does not understand as an outage, never as a success', async () => {
    await start({ create: { outcome: 'something_new', requestId: null, status: null } });
    expect((await call('POST', CREATE, { payload: VALID_REQUEST })).status).toBe(503);
  });

  it('turns an unreachable database into an outage on every route', async () => {
    await start({ throws: true });
    expect((await call('GET', MADE)).status).toBe(503);
    expect((await call('GET', DETAIL)).status).toBe(503);
    expect((await call('POST', CREATE, { payload: VALID_REQUEST })).status).toBe(503);
    expect((await call('POST', CANCEL)).status).toBe(503);
  });

  it('refuses an unusable cursor rather than paging from the beginning', async () => {
    const recorded = await start();
    for (const cursor of ['!!!!', 'not-a-cursor', Buffer.from('zz|x|y').toString('base64url')]) {
      const result = await call('GET', `${MADE}?cursor=${encodeURIComponent(cursor)}`);
      expect(result.status, cursor).toBe(400);
      expect(result.body['code'], cursor).toBe('SERVICE_REQUESTS_CURSOR_INVALID');
    }
    expect(recorded.calls).not.toContain('made');
  });

  it('clamps the limit rather than trusting it', async () => {
    const recorded = await start();
    await call('GET', `${MADE}?limit=5000`);
    expect(Number(arg(recorded, 'made')?.['limit'])).toBeLessThanOrEqual(51);
  });
});

describe('nothing beyond the obligation, and no Option 2', () => {
  it('exposes no checkout, order, delivery or payment operation under this controller', async () => {
    await start();
    for (const url of [
      `${DETAIL}/checkout`,
      `${DETAIL}/order`,
      `${DETAIL}/pay`,
      `${DETAIL}/deliveries`,
    ]) {
      const result = await call('POST', url);
      expect([400, 404], url).toContain(result.status);
    }
  });

  it('exposes no staff routing operation at all', async () => {
    await start();
    for (const url of [
      `${DETAIL}/route`,
      `${DETAIL}/assign`,
      '/v1/service-requests/admin',
      '/v1/service-requests/staff',
      '/v1/service-requests/admin-only',
      '/v1/service-requests/queue',
    ]) {
      const result = await call('POST', url);
      expect([400, 404], url).toContain(result.status);
    }
  });

  /**
   * The D7-08/D7-10 foundation is schema and permissions only (Phase 7-I patch).
   *
   * The routing column and the two permission keys exist in the database so that 7-J needs no second
   * migration against the same base schema. **No API surface reads or writes either.** Asserted by name,
   * because the cheapest way for Option 2 to leak into 7-I would be a field or a route that quietly
   * accepted its vocabulary.
   */
  it('never sends a routing mode to the database, and reads one back only as the database gave it', async () => {
    const recorded = await start();
    await call('POST', CREATE, { payload: VALID_REQUEST });
    for (const key of Object.keys(arg(recorded, 'create') ?? {})) {
      expect(key.toLowerCase()).not.toContain('routing');
      expect(key.toLowerCase()).not.toContain('admin');
      expect(key.toLowerCase()).not.toContain('staff');
    }

    // Read back, because a surface that could not tell the two flows apart would describe one of them
    // wrongly — and passed through exactly, never derived here.
    const list = await call('GET', MADE);
    const detail = await call('GET', DETAIL);
    expect((list.body['items'] as Array<Record<string, unknown>>)[0]?.['routingMode']).toBe('seller');
    expect((detail.body['request'] as Record<string, unknown>)['routingMode']).toBe('seller');
    for (const result of [list, detail]) {
      expect(result.raw).not.toContain('routing_mode');
      expect(result.raw).not.toContain('preferred_payment_method');
      expect(result.raw).not.toContain('preferredPaymentMethod');
      expect(result.raw).not.toContain('payment_notes');
      expect(result.raw).not.toContain('paymentNotes');
    }
  });

  it('passes an admin-only mode through untouched, and still reads no payment field', async () => {
    await start({
      made: [requestRow({ routingMode: 'admin_only', listingSlug: null, counterpartyName: null })],
      detail: detailRow({ routingMode: 'admin_only', sellerSlug: null, sellerName: null, isSeller: false }),
    });
    const list = await call('GET', MADE);
    const detail = await call('GET', DETAIL);
    expect((list.body['items'] as Array<Record<string, unknown>>)[0]?.['routingMode']).toBe('admin_only');
    expect((detail.body['request'] as Record<string, unknown>)['routingMode']).toBe('admin_only');
    for (const result of [list, detail]) {
      expect(result.raw).not.toContain('preferredPaymentMethod');
      expect(result.raw).not.toContain('paymentNotes');
    }
  });

  it('mentions neither D7-10 permission key anywhere a caller can see', async () => {
    await start();
    for (const [method, url, payload] of [
      ['GET', MADE, undefined],
      ['GET', DETAIL, undefined],
      ['POST', CREATE, VALID_REQUEST],
      ['POST', ACCEPT, undefined],
    ] as const) {
      const result = await call(method, url, payload === undefined ? {} : { payload });
      expect(result.raw, url).not.toContain('service_requests.request.read');
      expect(result.raw, url).not.toContain('service_requests.request.manage');
    }
  });

  it('never echoes the caller’s token or the internal credential', async () => {
    await start();
    for (const [method, url, payload] of [
      ['GET', MADE, undefined],
      ['GET', DETAIL, undefined],
      ['POST', CREATE, VALID_REQUEST],
      ['POST', ACCEPT, undefined],
    ] as const) {
      const result = await call(method, url, payload === undefined ? {} : { payload });
      expect(result.raw, url).not.toContain(ACCESS_TOKEN);
      expect(result.raw, url).not.toContain(TEST_INTERNAL_CREDENTIAL);
    }
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* Option 2 — the buyer's Admin Only create (Phase 7-J)                                              */
/* ------------------------------------------------------------------------------------------------ */

const ADMIN_ONLY = '/v1/service-requests/admin-only';
const VALID_ADMIN_ONLY = {
  title: 'Build me a shelf',
  brief: 'A brief that is comfortably longer than ten characters.',
  preferredPaymentMethod: 'Bank transfer, end of month',
};

describe('sending an Admin Only brief', () => {
  it('creates one for the account the provider vouched for', async () => {
    const recorded = await start();
    const result = await call('POST', ADMIN_ONLY, { payload: VALID_ADMIN_ONLY });
    expect(result.status).toBe(201);
    expect(result.body).toEqual({ requestId: REQUEST, status: 'open' });
    expect(arg(recorded, 'create-admin-only')?.['buyerId']).toBe(USER);
  });

  it('refuses it without a session, before asking anything', async () => {
    const recorded = await start();
    const result = await call('POST', ADMIN_ONLY, { accessToken: null, payload: VALID_ADMIN_ONLY });
    expect(result.status).toBe(401);
    expect(recorded.calls).toEqual([]);
  });

  it('acts as the vouched-for account, whatever a header claims', async () => {
    const recorded = await start();
    await call('POST', ADMIN_ONLY, {
      payload: VALID_ADMIN_ONLY,
      headers: { 'x-user-id': 'd1000000-0000-4000-8000-0000000000aa' },
    });
    expect(arg(recorded, 'create-admin-only')?.['buyerId']).toBe(USER);
  });

  it('sends exactly the seven fields the writer takes, and no routing decision among them', async () => {
    const recorded = await start();
    await call('POST', ADMIN_ONLY, {
      payload: { ...VALID_ADMIN_ONLY, paymentNotes: 'Invoice the company address.', budgetMinor: '400000', neededBy: '2026-06-01' },
    });
    const sent = arg(recorded, 'create-admin-only') ?? {};
    expect(Object.keys(sent).sort()).toEqual([
      'brief',
      'budgetMinor',
      'buyerId',
      'neededBy',
      'paymentNotes',
      'preferredPaymentMethod',
      'title',
    ]);
    for (const key of Object.keys(sent)) {
      const lower = key.toLowerCase();
      expect(lower).not.toContain('routing');
      expect(lower).not.toContain('seller');
      expect(lower).not.toContain('currency');
      expect(lower).not.toContain('listing');
      expect(lower).not.toContain('status');
    }
  });

  it.each([
    ['a routing mode', { ...VALID_ADMIN_ONLY, routingMode: 'admin_only' }],
    ['the seller-routed mode', { ...VALID_ADMIN_ONLY, routingMode: 'seller' }],
    ['a seller', { ...VALID_ADMIN_ONLY, sellerUserId: USER }],
    ['a listing', { ...VALID_ADMIN_ONLY, listingId: LISTING }],
    ['a currency', { ...VALID_ADMIN_ONLY, currencyCode: 'USD' }],
    ['a status', { ...VALID_ADMIN_ONLY, status: 'declined' }],
    ['a closing time', { ...VALID_ADMIN_ONLY, closedAt: '2026-05-05T09:00:00.000Z' }],
    ['a payment deadline', { ...VALID_ADMIN_ONLY, paymentDueAt: '2026-05-05T09:00:00.000Z' }],
    ['a staff permission', { ...VALID_ADMIN_ONLY, permission: 'service_requests.request.manage' }],
  ])('refuses a brief carrying %s, and writes nothing', async (_name, payload) => {
    const recorded = await start();
    const result = await call('POST', ADMIN_ONLY, { payload });
    expect(result.status).toBe(400);
    expect(recorded.calls).not.toContain('create-admin-only');
  });

  it('requires the payment method and bounds both fields', async () => {
    const recorded = await start();
    const { preferredPaymentMethod: _omitted, ...without } = VALID_ADMIN_ONLY;
    for (const payload of [
      without,
      { ...VALID_ADMIN_ONLY, preferredPaymentMethod: '' },
      { ...VALID_ADMIN_ONLY, preferredPaymentMethod: '   ' },
      { ...VALID_ADMIN_ONLY, preferredPaymentMethod: 'x'.repeat(121) },
      { ...VALID_ADMIN_ONLY, paymentNotes: 'x'.repeat(2001) },
      { ...VALID_ADMIN_ONLY, title: 'ab' },
      { ...VALID_ADMIN_ONLY, brief: 'too short' },
      {},
    ]) {
      expect((await call('POST', ADMIN_ONLY, { payload })).status).toBe(400);
    }
    expect(recorded.calls).not.toContain('create-admin-only');
  });

  it('treats an omitted note, budget and date as absences', async () => {
    const recorded = await start();
    await call('POST', ADMIN_ONLY, { payload: VALID_ADMIN_ONLY });
    const sent = arg(recorded, 'create-admin-only') ?? {};
    expect(sent['paymentNotes']).toBeNull();
    expect(sent['budgetMinor']).toBeNull();
    expect(sent['neededBy']).toBeNull();
  });

  it('turns a platform with no default currency into an outage, never a guessed brief', async () => {
    await start({ createAdminOnly: { outcome: 'no_currency', requestId: null, status: null } });
    const result = await call('POST', ADMIN_ONLY, { payload: VALID_ADMIN_ONLY });
    expect(result.status).toBe(503);
    expect(result.body['code']).toBe('SERVICE_REQUEST_CURRENCY_UNAVAILABLE');
    // The caller is not told which setting is missing.
    expect(result.raw).not.toContain('currenc');
    expect(result.raw).not.toContain('default');
  });

  it('turns an unusable outcome into an outage rather than a success', async () => {
    await start({ createAdminOnly: { outcome: 'something_new', requestId: null, status: null } });
    expect((await call('POST', ADMIN_ONLY, { payload: VALID_ADMIN_ONLY })).status).toBe(503);
  });

  it('turns an unreachable database into an outage', async () => {
    await start({ throws: true });
    expect((await call('POST', ADMIN_ONLY, { payload: VALID_ADMIN_ONLY })).status).toBe(503);
  });

  it('exposes no staff operation on the buyer controller, and no quote path for Option 2', async () => {
    await start();
    for (const url of [
      `${ADMIN_ONLY}/decline`,
      `${ADMIN_ONLY}/queue`,
      `${ADMIN_ONLY}/payment-information`,
      `${ADMIN_ONLY}/quotes`,
    ]) {
      const result = await call('POST', url);
      expect([400, 404], url).toContain(result.status);
    }
  });

  it('never echoes a payment value or the caller’s token back', async () => {
    await start();
    const result = await call('POST', ADMIN_ONLY, {
      payload: { ...VALID_ADMIN_ONLY, paymentNotes: 'Invoice the company address.' },
    });
    expect(result.raw).not.toContain('Bank transfer');
    expect(result.raw).not.toContain('Invoice the company address');
    expect(result.raw).not.toContain(ACCESS_TOKEN);
  });
});
