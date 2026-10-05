import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { SESSION_TOKEN_HEADER } from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { STAFF_CONSOLE_STORE, type StaffConsoleRow } from '../src/admin/staff-console.service.js';
import {
  ADMIN_SERVICE_REQUESTS_STORE,
  type AdminServiceRequestDecisionRow,
  type AdminServiceRequestDetailRow,
  type AdminServiceRequestRow,
  type ServiceRequestPaymentInformationRow,
} from '../src/admin/service-requests-admin.service.js';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { AuthenticationRequiredError } from '../src/auth/auth-errors.js';
import { SUPABASE_AUTH_CLIENT } from '../src/auth/login.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * The Admin Only service request surface at the API boundary — Option 2 (Phase 7-J).
 *
 * What is being held to account:
 *
 *   * **the authorization matrix**, on every one of the four operations — a guest, a buyer, a seller, staff at
 *     aal1, and staff at aal2 holding the wrong key all receive exactly what somebody asking about a route that
 *     does not exist receives; the authorized caller receives an answer;
 *   * **field-level separation** — the two payment fields never appear in the queue or the detail, whatever the
 *     caller holds, and a caller with `service_requests.request.read` alone is refused the payment operation
 *     while still reading the request itself. The fields are **absent**, not null;
 *   * **the three keys are not interchangeable** — reading does not close, closing does not read payment
 *     information, and payment information does not read the request;
 *   * **nothing about the caller is in a request** — no account, role, permission or assurance level in a
 *     header this controller reads, a query parameter or a body, and what the store is called with is always
 *     the account the provider vouched for;
 *   * **no Phase 8 and no quote** — no route here creates or names either;
 *   * **nothing secret in a response** — no token, no credential, no permission key.
 */

const STAFF = '11111111-1111-4111-8111-111111111111';
const READ = 'service_requests.request.read';
const MANAGE = 'service_requests.request.manage';
const PAYMENT_INFO = 'service_requests.payment_info.read';
const REQUEST = 'd4000000-0000-4000-8000-000000000001';

function token(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.c2lnbmF0dXJl`;
}

const ACCESS_TOKEN = token({ sub: STAFF, aal: 'aal2' });
const AAL1_TOKEN = token({ sub: STAFF, aal: 'aal1' });

/** Every permission an administrator holds except the three this surface uses. */
const WITHOUT_ANY = [
  'audit.read',
  'catalog.listing.read',
  'moderation.report.read',
  'sellers.profile.read',
  'users.profile.read',
];

/** What a moderator holds, as the seed grants it: none of the three. */
const MODERATOR = [
  'catalog.listing.moderate',
  'catalog.listing.read',
  'moderation.action.read',
  'moderation.report.manage',
  'moderation.report.read',
  'reviews.review.moderate',
  'reviews.review.read',
  'sellers.profile.read',
  'users.profile.read',
];

/** What a support agent holds: none of the three either. */
const SUPPORT = [
  'support.ticket.read',
  'support.ticket.manage',
  'security.recovery.review',
  'users.profile.read',
  'orders.order.read',
];

const ALL_THREE = [...WITHOUT_ANY, READ, MANAGE, PAYMENT_INFO];

const PAYMENT_METHOD = 'Bank transfer at the end of the month';
const PAYMENT_NOTE = 'Please invoice the company address.';
const BUYER_NAME = 'Canary Admin-Only Buyer';

function staffRow(overrides: Partial<StaffConsoleRow> = {}): StaffConsoleRow {
  return {
    hasConsoleRole: true,
    requiresStepUp: false,
    roles: ['admin'],
    permissions: ALL_THREE,
    ...overrides,
  };
}

function queueRow(overrides: Partial<AdminServiceRequestRow> = {}): AdminServiceRequestRow {
  return {
    id: REQUEST,
    status: 'open',
    title: 'Build me a shelf',
    // A `bigint` arrives as a string from the driver and stays one.
    budgetMinor: '400000',
    currencyCode: 'EGP',
    currencyMinorUnit: 2,
    neededBy: '2026-06-01',
    buyerName: BUYER_NAME,
    hasPaymentNotes: true,
    closedAt: null,
    createdAt: new Date('2026-05-01T09:00:00.000Z'),
    updatedAt: new Date('2026-05-01T09:00:00.000Z'),
    ...overrides,
  };
}

function detailRow(overrides: Partial<AdminServiceRequestDetailRow> = {}): AdminServiceRequestDetailRow {
  return {
    ...queueRow(),
    outcome: 'found',
    brief: 'A brief that is comfortably longer than ten characters.',
    ...overrides,
  };
}

interface Recorded {
  readonly calls: string[];
  readonly args: Array<{ readonly name: string; readonly input: Record<string, unknown> }>;
}

interface Doubles {
  readonly permissions?: readonly string[];
  readonly queue?: readonly AdminServiceRequestRow[];
  readonly detail?: AdminServiceRequestDetailRow;
  readonly paymentInformation?: ServiceRequestPaymentInformationRow;
  readonly decision?: AdminServiceRequestDecisionRow;
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
        return { id: STAFF, phone: null };
      },
    })
    .overrideProvider(STAFF_CONSOLE_STORE)
    .useValue({
      staffConsoleAccess: async (input: { userId: string; isAal2: boolean }) => {
        recorded.calls.push('console-access');
        recorded.args.push({ name: 'console-access', input });
        // 0068's own behaviour: a role that requires MFA counts for nothing at aal1, so the effective set
        // is empty. Modelled here rather than asserted around, because that is what the database does.
        const granted = doubles.permissions === undefined ? ALL_THREE : [...doubles.permissions];
        return staffRow({ permissions: input.isAal2 ? granted : [] });
      },
      buyerProfile: async (userId: string) => ({ id: userId, displayName: 'Nadia', localeCode: 'en' }),
    })
    .overrideProvider(ADMIN_SERVICE_REQUESTS_STORE)
    .useValue({
      serviceRequestsAdminOnlyQueue: async (input: unknown) =>
        record('queue', input, doubles.queue ?? [queueRow()]),
      serviceRequestAdminOnlyDetail: async (input: unknown) =>
        record('detail', input, doubles.detail ?? detailRow()),
      serviceRequestPaymentInformation: async (input: unknown) =>
        record(
          'payment-information',
          input,
          doubles.paymentInformation ?? {
            outcome: 'found',
            preferredPaymentMethod: PAYMENT_METHOD,
            paymentNotes: PAYMENT_NOTE,
          },
        ),
      serviceRequestAdminDecline: async (input: unknown) =>
        record('decline', input, doubles.decision ?? { outcome: 'declined', status: 'declined' }),
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
  options: { accessToken?: string | null; headers?: Record<string, string> } = {},
): Promise<Result> {
  const headers: Record<string, string> = {
    [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL,
    ...options.headers,
  };
  const accessToken = options.accessToken === undefined ? ACCESS_TOKEN : options.accessToken;
  if (accessToken !== null) headers[SESSION_TOKEN_HEADER] = accessToken;

  const response = await app!.inject({ method, url, headers });
  return {
    status: response.statusCode,
    body: response.body.length > 0 ? (JSON.parse(response.body) as Record<string, unknown>) : {},
    raw: response.body,
  };
}

const QUEUE = '/v1/admin/service-requests';
const DETAIL = `${QUEUE}/${REQUEST}`;
const PAYMENT = `${DETAIL}/payment-information`;
const DECLINE = `${DETAIL}/decline`;

const arg = (recorded: Recorded, name: string): Record<string, unknown> | undefined =>
  recorded.args.find((entry) => entry.name === name)?.input;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/* ------------------------------------------------------------------------------------------------ */

describe('the authorization matrix', () => {
  it('serves all four operations to staff holding all three keys at aal2', async () => {
    await start();
    expect((await call('GET', QUEUE)).status).toBe(200);
    expect((await call('GET', DETAIL)).status).toBe(200);
    expect((await call('GET', PAYMENT)).status).toBe(200);
    expect((await call('POST', DECLINE)).status).toBe(200);
  });

  it('refuses all four without a session, before asking anything', async () => {
    const recorded = await start();
    for (const [method, url] of [
      ['GET', QUEUE],
      ['GET', DETAIL],
      ['GET', PAYMENT],
      ['POST', DECLINE],
    ] as const) {
      expect((await call(method, url, { accessToken: null })).status, url).toBe(401);
    }
    expect(recorded.calls).toEqual([]);
  });

  it('refuses a token the provider does not vouch for, before the database is asked', async () => {
    const recorded = await start({ tokenFails: true });
    expect((await call('GET', QUEUE)).status).toBe(401);
    expect(recorded.calls).toEqual(['get-user']);
  });

  it('refuses without the internal credential, whoever is asking', async () => {
    await start();
    const response = await app!.inject({
      method: 'GET',
      url: QUEUE,
      headers: { [SESSION_TOKEN_HEADER]: ACCESS_TOKEN },
    });
    expect(response.statusCode).toBe(403);
  });

  /**
   * Staff at aal1 hold nothing at all, which is 0003's `requires_mfa` rule applied by the database and not a
   * check in this file. Every operation answers the ordinary not-found — the same answer as for a route that
   * does not exist — which is 7-G's behaviour and is uniform across all four here, so no status code
   * distinguishes "you may not" from "there is none".
   */
  it('gives staff at aal1 nothing, on every operation', async () => {
    await start();
    for (const [method, url] of [
      ['GET', QUEUE],
      ['GET', DETAIL],
      ['GET', PAYMENT],
      ['POST', DECLINE],
    ] as const) {
      const result = await call(method, url, { accessToken: AAL1_TOKEN });
      expect(result.status, url).toBe(404);
      expect(result.body['code'], url).toBe('NOT_FOUND');
    }
  });

  it('never reaches the store for a caller at aal1', async () => {
    const recorded = await start();
    await call('GET', QUEUE, { accessToken: AAL1_TOKEN });
    // Four refusals, none of which asked the database anything.

    await call('GET', DETAIL, { accessToken: AAL1_TOKEN });
    await call('GET', PAYMENT, { accessToken: AAL1_TOKEN });
    await call('POST', DECLINE, { accessToken: AAL1_TOKEN });
    expect(recorded.calls).not.toContain('queue');
    expect(recorded.calls).not.toContain('detail');
    expect(recorded.calls).not.toContain('payment-information');
    expect(recorded.calls).not.toContain('decline');
  });

  it.each([
    ['a buyer or guest with no console role', []],
    ['a moderator', MODERATOR],
    ['a support agent', SUPPORT],
    ['an administrator without any of the three keys', WITHOUT_ANY],
  ])('gives %s nothing, on every operation', async (_who, permissions) => {
    const recorded = await start({ permissions });
    for (const [method, url] of [
      ['GET', QUEUE],
      ['GET', DETAIL],
      ['GET', PAYMENT],
      ['POST', DECLINE],
    ] as const) {
      const result = await call(method, url);
      expect(result.status, url).toBe(404);
      expect(result.body['code'], url).toBe('NOT_FOUND');
    }
    expect(recorded.calls).not.toContain('queue');
    expect(recorded.calls).not.toContain('detail');
    expect(recorded.calls).not.toContain('payment-information');
    expect(recorded.calls).not.toContain('decline');
  });
});

describe('the three keys are not interchangeable', () => {
  it('reading a request does not read its payment information', async () => {
    const recorded = await start({ permissions: [...WITHOUT_ANY, READ] });
    expect((await call('GET', QUEUE)).status).toBe(200);
    expect((await call('GET', DETAIL)).status).toBe(200);

    const payment = await call('GET', PAYMENT);
    expect(payment.status).toBe(404);
    expect(payment.body['code']).toBe('NOT_FOUND');
    expect(recorded.calls).not.toContain('payment-information');
    // And the refusal carries no hint that there was something to withhold.
    expect(payment.raw).not.toContain('payment_info');
    expect(payment.raw).not.toContain('permission');
  });

  it('reading a request does not close it', async () => {
    const recorded = await start({ permissions: [...WITHOUT_ANY, READ] });
    expect((await call('POST', DECLINE)).status).toBe(404);
    expect(recorded.calls).not.toContain('decline');
  });

  it('holding the payment key alone reads neither the queue nor the request', async () => {
    const recorded = await start({ permissions: [...WITHOUT_ANY, PAYMENT_INFO] });
    expect((await call('GET', QUEUE)).status).toBe(404);
    expect((await call('GET', DETAIL)).status).toBe(404);
    expect((await call('GET', PAYMENT)).status).toBe(200);
    expect(recorded.calls).not.toContain('queue');
    expect(recorded.calls).not.toContain('detail');
  });

  it('holding the manage key alone closes but reads nothing', async () => {
    const recorded = await start({ permissions: [...WITHOUT_ANY, MANAGE] });
    expect((await call('POST', DECLINE)).status).toBe(200);
    expect((await call('GET', DETAIL)).status).toBe(404);
    expect((await call('GET', PAYMENT)).status).toBe(404);
    expect(recorded.calls).not.toContain('detail');
    expect(recorded.calls).not.toContain('payment-information');
  });
});

describe('field-level separation', () => {
  it('returns neither payment field on the queue, for a caller holding every key', async () => {
    await start();
    const result = await call('GET', QUEUE);
    expect(result.raw).not.toContain(PAYMENT_METHOD);
    expect(result.raw).not.toContain(PAYMENT_NOTE);
    expect(result.raw).not.toContain('preferredPaymentMethod');
    expect(result.raw).not.toContain('paymentNotes');
  });

  it('returns neither on the detail either, and says only that there is a note', async () => {
    await start();
    const result = await call('GET', DETAIL);
    const request = result.body['request'] as Record<string, unknown>;
    expect(Object.keys(request)).not.toContain('preferredPaymentMethod');
    expect(Object.keys(request)).not.toContain('paymentNotes');
    expect(request['hasPaymentNotes']).toBe(true);
    expect(result.raw).not.toContain(PAYMENT_METHOD);
    expect(result.raw).not.toContain(PAYMENT_NOTE);
  });

  it('drops a payment field a drifted database added to either shape', async () => {
    await start({
      queue: [
        {
          ...queueRow(),
          // Two fields a later widening might add. Neither may reach a browser.
          preferredPaymentMethod: PAYMENT_METHOD,
          paymentNotes: PAYMENT_NOTE,
        } as AdminServiceRequestRow,
      ],
      detail: {
        ...detailRow(),
        preferredPaymentMethod: PAYMENT_METHOD,
        paymentNotes: PAYMENT_NOTE,
      } as AdminServiceRequestDetailRow,
    });
    const queue = await call('GET', QUEUE);
    const detail = await call('GET', DETAIL);
    for (const result of [queue, detail]) {
      expect(result.raw).not.toContain(PAYMENT_METHOD);
      expect(result.raw).not.toContain(PAYMENT_NOTE);
    }
  });

  it('returns them only from their own operation, as their own document', async () => {
    await start();
    const result = await call('GET', PAYMENT);
    expect(result.status).toBe(200);
    expect(Object.keys(result.body)).toEqual(['paymentInformation']);
    expect(result.body['paymentInformation']).toEqual({
      preferredPaymentMethod: PAYMENT_METHOD,
      paymentNotes: PAYMENT_NOTE,
    });
  });

  it('reads a purged request as two nulls, and the request is unaffected', async () => {
    await start({
      paymentInformation: { outcome: 'found', preferredPaymentMethod: null, paymentNotes: null },
      detail: detailRow({ hasPaymentNotes: false, status: 'declined', closedAt: new Date('2026-05-03T09:00:00.000Z') }),
    });
    const payment = await call('GET', PAYMENT);
    expect(payment.body['paymentInformation']).toEqual({
      preferredPaymentMethod: null,
      paymentNotes: null,
    });
    const detail = await call('GET', DETAIL);
    expect((detail.body['request'] as Record<string, unknown>)['title']).toBe('Build me a shelf');
    expect((detail.body['request'] as Record<string, unknown>)['status']).toBe('declined');
  });

  it('returns nothing but the two fields, dropping anything else the database sent', async () => {
    await start({
      paymentInformation: {
        outcome: 'found',
        preferredPaymentMethod: PAYMENT_METHOD,
        paymentNotes: PAYMENT_NOTE,
        buyerUserId: STAFF,
      } as ServiceRequestPaymentInformationRow,
    });
    const result = await call('GET', PAYMENT);
    expect(Object.keys(result.body['paymentInformation'] as Record<string, unknown>).sort()).toEqual([
      'paymentNotes',
      'preferredPaymentMethod',
    ]);
    expect(result.raw).not.toContain(STAFF);
  });
});

describe('nothing about the caller is in a request', () => {
  it('acts as the vouched-for account, whatever a header claims', async () => {
    const recorded = await start();
    await call('GET', DETAIL, { headers: { 'x-user-id': 'd4000000-0000-4000-8000-0000000000aa' } });
    expect(arg(recorded, 'detail')?.['userId']).toBe(STAFF);
    expect(arg(recorded, 'detail')?.['isAal2']).toBe(true);
  });

  it('passes the assurance level from the caller’s own token, not an assumption', async () => {
    const recorded = await start();
    await call('GET', QUEUE);
    expect(arg(recorded, 'queue')?.['isAal2']).toBe(true);
  });

  it('sends the store an account, a level and the row, and nothing else', async () => {
    const recorded = await start();
    await call('GET', DETAIL);
    await call('GET', PAYMENT);
    await call('POST', DECLINE);
    for (const name of ['detail', 'payment-information', 'decline']) {
      expect(Object.keys(arg(recorded, name) ?? {}).sort(), name).toEqual([
        'isAal2',
        'requestId',
        'userId',
      ]);
    }
  });

  it('accepts no permission, role or account from a query parameter', async () => {
    const recorded = await start();
    await call('GET', `${QUEUE}?permission=${PAYMENT_INFO}&role=super_admin&userId=${STAFF}&aal=aal2`);
    const sent = arg(recorded, 'queue') ?? {};
    for (const key of Object.keys(sent)) {
      expect(key.toLowerCase()).not.toContain('permission');
      expect(key.toLowerCase()).not.toContain('role');
    }
    expect(sent['userId']).toBe(STAFF);
  });
});

describe('the queue', () => {
  it('is oldest first and opaque about its position', async () => {
    await start({
      queue: Array.from({ length: 21 }, (_unused, index) =>
        queueRow({
          id: `d4000000-0000-4000-8000-0000000000${String(index).padStart(2, '0')}`,
          createdAt: new Date(Date.UTC(2026, 4, 1, 9, index)),
        }),
      ),
    });
    const result = await call('GET', QUEUE);
    const items = result.body['items'] as Array<Record<string, unknown>>;
    expect(items).toHaveLength(20);
    expect(typeof result.body['nextCursor']).toBe('string');
    // The cursor is base64url and reveals nothing structured.
    expect(result.body['nextCursor']).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('refuses an unusable cursor rather than paging from the beginning', async () => {
    const recorded = await start();
    for (const cursor of ['!!!!', 'not-a-cursor', Buffer.from('sr1|x|y').toString('base64url')]) {
      const result = await call('GET', `${QUEUE}?cursor=${encodeURIComponent(cursor)}`);
      expect(result.status, cursor).toBe(400);
      expect(result.body['code'], cursor).toBe('SERVICE_REQUESTS_CURSOR_INVALID');
    }
    expect(recorded.calls).not.toContain('queue');
  });

  it('refuses a buyer-list cursor, whose order is the opposite of this one', async () => {
    await start();
    const buyerCursor = Buffer.from(
      ['sr1', '2026-05-01T09:00:00.000Z', REQUEST].join('|'),
      'utf8',
    ).toString('base64url');
    const result = await call('GET', `${QUEUE}?cursor=${buyerCursor}`);
    expect(result.status).toBe(400);
  });

  it('accepts only the schema’s own statuses as a filter', async () => {
    const recorded = await start();
    for (const status of ['open', 'declined', 'cancelled']) {
      expect((await call('GET', `${QUEUE}?status=${status}`)).status, status).toBe(200);
    }
    for (const status of ['routed', 'admin_only', 'pending', 'anything']) {
      expect((await call('GET', `${QUEUE}?status=${status}`)).status, status).toBe(400);
    }
    expect(arg(recorded, 'queue')?.['status']).toBe('open');
  });

  it('clamps the limit rather than trusting it', async () => {
    const recorded = await start();
    await call('GET', `${QUEUE}?limit=5000`);
    expect(Number(arg(recorded, 'queue')?.['limit'])).toBeLessThanOrEqual(51);
  });

  it('names the buyer and nothing else about them', async () => {
    await start();
    const items = (await call('GET', QUEUE)).body['items'] as Array<Record<string, unknown>>;
    expect(items[0]?.['buyerName']).toBe(BUYER_NAME);
    expect(Object.keys(items[0] ?? {})).not.toContain('buyerUserId');
  });

  it('carries the budget as a decimal string with its decimal places', async () => {
    await start();
    const items = (await call('GET', QUEUE)).body['items'] as Array<Record<string, unknown>>;
    expect(items[0]?.['budgetMinor']).toBe('400000');
    expect(items[0]?.['currencyMinorUnit']).toBe(2);
  });
});

describe('the staff closure', () => {
  it('answers with the status the database recorded, and nothing else', async () => {
    await start();
    const result = await call('POST', DECLINE);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: 'declined' });
  });

  it('takes no body, and ignores one', async () => {
    const recorded = await start();
    const response = await app!.inject({
      method: 'POST',
      url: DECLINE,
      headers: {
        [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL,
        [SESSION_TOKEN_HEADER]: ACCESS_TOKEN,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ status: 'accepted', paymentDueAt: '2026-05-05T09:00:00.000Z' }),
    });
    expect(response.statusCode).toBe(200);
    expect(Object.keys(arg(recorded, 'decline') ?? {}).sort()).toEqual(['isAal2', 'requestId', 'userId']);
  });

  it.each([
    ['conflict', 409, 'SERVICE_REQUEST_NOT_ACTIONABLE'],
    ['not_found', 404, 'NOT_FOUND'],
  ])('turns an outcome of %s into %i', async (outcome, status, code) => {
    await start({ decision: { outcome, status: 'cancelled' } });
    const result = await call('POST', DECLINE);
    expect(result.status).toBe(status);
    expect(result.body['code']).toBe(code);
  });

  it('repeating it is whatever the database says, never a second write of ours', async () => {
    const recorded = await start({ decision: { outcome: 'conflict', status: 'declined' } });
    await call('POST', DECLINE);
    await call('POST', DECLINE);
    expect(recorded.calls.filter((name) => name === 'decline')).toHaveLength(2);
  });

  it('treats an outcome it does not understand as an outage, never as a closure', async () => {
    await start({ decision: { outcome: 'something_new', status: null } });
    expect((await call('POST', DECLINE)).status).toBe(503);
  });

  it('records no obligation: no acceptance time, no deadline, no quote', async () => {
    await start();
    const result = await call('POST', DECLINE);
    expect(Object.keys(result.body)).toEqual(['status']);
    expect(result.raw).not.toContain('paymentDueAt');
    expect(result.raw).not.toContain('acceptedAt');
    expect(result.raw).not.toContain('quote');
  });
});

describe('outages, and what is never in a response', () => {
  it('turns an unreachable database into an outage on every operation', async () => {
    await start({ throws: true });
    expect((await call('GET', QUEUE)).status).toBe(503);
    expect((await call('GET', DETAIL)).status).toBe(503);
    expect((await call('GET', PAYMENT)).status).toBe(503);
    expect((await call('POST', DECLINE)).status).toBe(503);
  });

  it('answers not-found for a request the database does not return', async () => {
    await start({
      detail: { ...detailRow(), outcome: 'not_found' },
      paymentInformation: { outcome: 'not_found', preferredPaymentMethod: null, paymentNotes: null },
    });
    expect((await call('GET', DETAIL)).status).toBe(404);
    expect((await call('GET', PAYMENT)).status).toBe(404);
  });

  it('refuses an identifier that is not one, without asking', async () => {
    const recorded = await start();
    for (const id of ['not-a-uuid', 'xyz', '1']) {
      expect((await call('GET', `${QUEUE}/${encodeURIComponent(id)}`)).status, id).toBe(400);
    }
    expect(recorded.calls).not.toContain('detail');
  });

  it('never echoes a token, the credential or a permission key', async () => {
    await start();
    for (const [method, url] of [
      ['GET', QUEUE],
      ['GET', DETAIL],
      ['GET', PAYMENT],
      ['POST', DECLINE],
    ] as const) {
      const result = await call(method, url);
      expect(result.raw, url).not.toContain(ACCESS_TOKEN);
      expect(result.raw, url).not.toContain(TEST_INTERNAL_CREDENTIAL);
      expect(result.raw, url).not.toContain(READ);
      expect(result.raw, url).not.toContain(MANAGE);
      expect(result.raw, url).not.toContain(PAYMENT_INFO);
    }
  });

  it('exposes no quote, order, checkout or payment operation on this surface', async () => {
    await start();
    for (const url of [
      `${DETAIL}/quotes`,
      `${DETAIL}/accept`,
      `${DETAIL}/checkout`,
      `${DETAIL}/order`,
      `${DETAIL}/pay`,
      `${DETAIL}/assign`,
      `${DETAIL}/route`,
    ]) {
      const result = await call('POST', url);
      expect([400, 404], url).toContain(result.status);
    }
  });
});
