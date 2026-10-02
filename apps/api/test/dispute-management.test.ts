import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  DISPUTE_RESOLUTIONS,
  DISPUTE_THREAD_LIMIT,
  DisputeDetailResponseSchema,
  DisputeMessagesResponseSchema,
  DisputeQueueResponseSchema,
  PostDisputeMessageResponseSchema,
  ResolveDisputeResponseSchema,
  SESSION_TOKEN_HEADER,
} from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { AuthenticationRequiredError } from '../src/auth/auth-errors.js';
import { DISPUTE_MANAGEMENT_STORE } from '../src/admin/dispute-management.service.js';
import { encodeDisputeQueueCursor } from '../src/admin/dispute-management.cursor.js';
import { SUPABASE_AUTH_CLIENT } from '../src/auth/login.service.js';
import { STAFF_CONSOLE_STORE, type StaffConsoleRow } from '../src/admin/staff-console.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * Dispute management at the API boundary (Phase 7-R).
 *
 * The properties this suite exists for:
 *
 * **Each route requires exactly one key, and the right one.** The three reads need `disputes.dispute.read`, the
 * two writes need `disputes.dispute.manage`, and each is driven with the other key alone and refused.
 *
 * **No other admin key opens this section.** A caller holding every other key in the console — seller, user,
 * role, security, recovery, audit, review, moderation, support, platform — is refused all five routes. That is
 * the property that keeps a Moderator out, since a Moderator is deliberately granted neither dispute key.
 *
 * **THE PHASE 8 BOUNDARY.** A refund resolution is recorded for real, and the response is searched for every
 * financial word it must not contain: no refund identifier, no payment reference, no ledger, no balance, no
 * payout. The store double records every call, and the set of methods reached is asserted to be exactly the
 * five — so nothing financial was called even by a name this suite did not anticipate.
 *
 * **Money never becomes a number.** The store hands back a minor amount too large for an IEEE double to hold
 * exactly, and the response is asserted to carry the digits **unchanged** — which is the assertion that fails
 * if anybody puts a `Number()` in the path.
 *
 * **Only the two reachable statuses are accepted as a filter**, and the other four are refused rather than
 * answered with an empty page.
 *
 * **Nothing about authority is accepted from a browser**, and neither body has a field through which a
 * resolver, a timestamp, an order status or a refund could be claimed.
 *
 * **A refusal says nothing about existence.** A dispute a caller may not read and one that is not there produce
 * the same status, code and body, compared byte for byte.
 *
 * Everything is stubbed at the store boundary: no database, no Redis, no network.
 */

const STAFF = '11111111-1111-4111-8111-111111111111';

/** An unsigned token whose claims can be read, which is all `isAal2` does with one it has been handed. */
function token(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.c2lnbmF0dXJl`;
}

const ACCESS_TOKEN = token({ sub: STAFF, aal: 'aal2' });
const AAL1_TOKEN = token({ sub: STAFF, aal: 'aal1' });
const DISPUTE = 'fe000000-0000-4000-8000-000000000001';
const MESSAGE = 'ff000000-0000-4000-8000-000000000001';

const READ = 'disputes.dispute.read';
const MANAGE = 'disputes.dispute.manage';

/** Every other key an admin console surface uses. Not one of them opens this section. */
const OTHER_KEYS = [
  'sellers.profile.read',
  'sellers.profile.manage',
  'users.profile.read',
  'users.role.read',
  'users.security.read',
  'security.recovery.review',
  'audit.read',
  'reviews.review.read',
  'reviews.review.moderate',
  'moderation.action.read',
  'moderation.report.read',
  'support.ticket.read',
  'platform.job.read',
  // The Phase 8 keys, which this surface must never need.
  'payments.refund.read',
  'payments.refund.manage',
  'payments.dispute.read',
  'payments.dispute.manage',
] as const;

/**
 * An amount larger than `Number.MAX_SAFE_INTEGER`.
 *
 * 9007199254740993 is the first odd integer a double cannot represent: `Number(...)` of it yields
 * ...992. If any layer converts, the digits change and the assertion catches it.
 */
const BIG_AMOUNT = '9007199254740993';

const QUEUE_ROW = {
  id: DISPUTE,
  status: 'open',
  reasonCode: 'damaged',
  currencyCode: 'EGP',
  claimAmountMinor: BIG_AMOUNT,
  orderNumber: 'MP-26-000123',
  orderStatus: 'delivered',
  orderType: 'product',
  sellerSlug: 'a-shop',
  sellerDisplayName: 'A Shop',
  isParty: false,
  resolvedByMe: false,
  resolution: null,
  messageCount: '3',
  hasDetails: true,
  dueAt: new Date('2026-06-01T09:00:00.000Z'),
  createdAt: new Date('2026-05-01T09:00:00.000Z'),
};

const DETAIL_ROW = {
  outcome: 'found',
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
  orderPlacedAt: new Date('2026-04-01T09:00:00.000Z'),
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
  createdAt: new Date('2026-05-01T09:00:00.000Z'),
  updatedAt: new Date('2026-05-01T09:00:00.000Z'),
};

const MESSAGE_ROW = {
  id: MESSAGE,
  authorRole: 'buyer',
  body: 'The box was crushed.',
  isInternal: false,
  isOwnMessage: false,
  createdAt: new Date('2026-05-01T09:05:00.000Z'),
};

interface Seen {
  readonly name: string;
  readonly input: Record<string, unknown>;
}

interface Doubles {
  readonly permissions?: readonly string[];
  readonly detailOutcome?: string;
  readonly postOutcome?: string;
  readonly resolveOutcome?: string;
  readonly storeThrows?: boolean;
  readonly unauthenticated?: boolean;
  readonly queueRows?: readonly unknown[];
  readonly messageRows?: readonly unknown[];
}

let app: NestFastifyApplication | undefined;

async function start(doubles: Doubles = {}): Promise<Seen[]> {
  const seen: Seen[] = [];
  const note = (name: string) => (input: Record<string, unknown>) => {
    seen.push({ name, input });
    if (doubles.storeThrows === true) throw new Error('database unavailable');
    return undefined;
  };

  const store = {
    disputeQueueForStaff: async (input: Record<string, unknown>) => {
      note('queue')(input);
      return doubles.queueRows ?? [QUEUE_ROW];
    },
    disputeForStaff: async (input: Record<string, unknown>) => {
      note('detail')(input);
      const outcome = doubles.detailOutcome ?? 'found';
      return outcome === 'found' ? DETAIL_ROW : { ...DETAIL_ROW, outcome, id: null };
    },
    disputeMessagesForStaff: async (input: Record<string, unknown>) => {
      note('messages')(input);
      return doubles.messageRows ?? [MESSAGE_ROW];
    },
    disputeMessagePostForStaff: async (input: Record<string, unknown>) => {
      note('post')(input);
      const outcome = doubles.postOutcome ?? 'posted';
      return { outcome, messageId: outcome === 'posted' ? MESSAGE : null };
    },
    disputeResolveForStaff: async (input: Record<string, unknown>) => {
      note('resolve')(input);
      const outcome = doubles.resolveOutcome ?? 'resolved';
      return {
        outcome,
        status: outcome === 'resolved' ? 'resolved' : null,
        resolution: outcome === 'resolved' ? (input['resolution'] as string) : null,
      };
    },
  };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(TEST_ENV)] })
    .overrideProvider(SUPABASE_AUTH_CLIENT)
    .useValue({
      getUser: async () => {
        if (doubles.unauthenticated === true) throw new AuthenticationRequiredError();
        return { id: STAFF, phone: null };
      },
      signInWithPassword: async () => {
        throw new Error('ruling on a dispute must never sign anyone in');
      },
      revokeAllSessions: async () => {
        throw new Error('ruling on a dispute must never revoke a session');
      },
    })
    .overrideProvider(STAFF_CONSOLE_STORE)
    .useValue({
      staffConsoleAccess: async (input: { userId: string; isAal2: boolean }): Promise<StaffConsoleRow> => {
        seen.push({ name: 'console-access', input });
        // The platform's own behaviour, modelled rather than asserted around: a role that requires MFA counts
        // for nothing at aal1, so the effective set is empty. Both roles holding a dispute key require MFA.
        const granted = [...(doubles.permissions ?? [READ, MANAGE])];
        return {
          hasConsoleRole: true,
          requiresStepUp: false,
          roles: ['admin'],
          permissions: input.isAal2 ? granted : [],
        };
      },
      buyerProfile: async (userId: string) => ({ id: userId, displayName: 'Nadia', localeCode: 'en' }),
    })
    .overrideProvider(DISPUTE_MANAGEMENT_STORE)
    .useValue(store)
    .compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(
    createFastifyAdapter(TEST_ENV, { logStream: { write: () => undefined } }),
    NEST_APP_OPTIONS,
  );
  await configureApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return seen;
}

interface Result {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly raw: string;
}

async function call(
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH' | 'PUT',
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<Result> {
  const response = await app!.inject({
    method,
    url: `/v1/admin/disputes${path}`,
    headers: {
      [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL,
      [SESSION_TOKEN_HEADER]: ACCESS_TOKEN,
      ...options.headers,
    },
    ...(options.body === undefined ? {} : { payload: options.body as never }),
  });
  return {
    status: response.statusCode,
    body: response.body.length > 0 ? (JSON.parse(response.body) as Record<string, unknown>) : {},
    raw: response.body,
  };
}

const MESSAGE_BODY = { body: 'We have asked the courier.', isInternal: false } as const;
const DECISION = {
  resolution: 'refund_buyer',
  resolutionNote: 'The item arrived cracked.',
  resolutionAmountMinor: BIG_AMOUNT,
} as const;

const READS = ['', `/${DISPUTE}`, `/${DISPUTE}/messages`] as const;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/* ------------------------------------------------------------------------------------------------ */

describe('the shapes the contracts promise', () => {
  it('answers every operation with a body its own schema accepts', async () => {
    await start();

    expect(DisputeQueueResponseSchema.safeParse((await call('GET', '')).body).success).toBe(true);
    expect(
      DisputeDetailResponseSchema.safeParse((await call('GET', `/${DISPUTE}`)).body).success,
    ).toBe(true);
    expect(
      DisputeMessagesResponseSchema.safeParse((await call('GET', `/${DISPUTE}/messages`)).body).success,
    ).toBe(true);
    expect(
      PostDisputeMessageResponseSchema.safeParse(
        (await call('POST', `/${DISPUTE}/messages`, { body: MESSAGE_BODY })).body,
      ).success,
    ).toBe(true);
    expect(
      ResolveDisputeResponseSchema.safeParse(
        (await call('POST', `/${DISPUTE}/resolution`, { body: DECISION })).body,
      ).success,
    ).toBe(true);
  });

  it('names nobody: no buyer, no seller, no opener, no resolver and no author', async () => {
    await start();
    const raws = [
      (await call('GET', '')).raw,
      (await call('GET', `/${DISPUTE}`)).raw,
      (await call('GET', `/${DISPUTE}/messages`)).raw,
    ];

    for (const raw of raws) {
      for (const forbidden of [
        'buyerUserId',
        'sellerUserId',
        'openedBy',
        'resolvedBy',
        'authorUserId',
        'assignedTo',
        'orderId',
        'buyer_user_id',
        'seller_user_id',
        'opened_by',
        'resolved_by',
      ]) {
        expect(raw, forbidden).not.toContain(`"${forbidden}":`);
      }
    }
    // What replaces them: sides, roles, and the reader's own relationship.
    const detail = (await call('GET', `/${DISPUTE}`)).raw;
    expect(detail).toContain('openedByRole');
    expect(detail).toContain('isParty');
    expect(detail).toContain('resolvedByMe');
    expect(detail).toContain('canManage');
    expect((await call('GET', `/${DISPUTE}/messages`)).raw).toContain('authorRole');
  });

  it('reports the capability rather than the permission', async () => {
    await start();
    const raw = (await call('GET', `/${DISPUTE}`)).raw;

    expect(raw).toContain('canManage');
    for (const key of [READ, MANAGE]) expect(raw, key).not.toContain(key);
    expect(raw).not.toContain('permission');
  });
});

describe('money never becomes a number', () => {
  it('carries a minor amount too large for a double through unchanged', async () => {
    await start();

    // `Number('9007199254740993')` is 9007199254740992. If any layer converts, these fail.
    const queue = (await call('GET', '')).body as { items: readonly Record<string, unknown>[] };
    expect(queue.items[0]?.['claimAmountMinor']).toBe(BIG_AMOUNT);
    expect(typeof queue.items[0]?.['claimAmountMinor']).toBe('string');

    const detail = (await call('GET', `/${DISPUTE}`)).body as { dispute: Record<string, unknown> };
    expect(detail.dispute['claimAmountMinor']).toBe(BIG_AMOUNT);
    expect(detail.dispute['orderGrandTotalMinor']).toBe(BIG_AMOUNT);
    expect(typeof detail.dispute['orderGrandTotalMinor']).toBe('string');
  });

  it('never carries an amount without its currency', async () => {
    await start();
    const detail = (await call('GET', `/${DISPUTE}`)).body as { dispute: Record<string, unknown> };
    expect(detail.dispute['currencyCode']).toBe('EGP');

    const queue = (await call('GET', '')).body as { items: readonly Record<string, unknown>[] };
    expect(queue.items[0]?.['currencyCode']).toBe('EGP');
  });

  it('passes a decided amount to the writer as the string it arrived as', async () => {
    const seen = await start();
    await call('POST', `/${DISPUTE}/resolution`, { body: DECISION });

    const write = seen.find((entry) => entry.name === 'resolve');
    expect(write?.input['resolutionAmountMinor']).toBe(BIG_AMOUNT);
    expect(typeof write?.input['resolutionAmountMinor']).toBe('string');
  });

  it('refuses an amount that is not digits, and one that is zero', async () => {
    await start();
    for (const resolutionAmountMinor of ['0', '-1', '1.5', '1e6', ' 100', '100 ', 'many', '01']) {
      const result = await call('POST', `/${DISPUTE}/resolution`, {
        body: { ...DECISION, resolutionAmountMinor },
      });
      expect(result.status, resolutionAmountMinor).toBe(400);
    }
  });

  it('refuses an amount sent as a JSON number, however large', async () => {
    await start();
    for (const resolutionAmountMinor of [100, 0, 9007199254740993]) {
      const result = await call('POST', `/${DISPUTE}/resolution`, {
        body: { ...DECISION, resolutionAmountMinor },
      });
      expect(result.status, String(resolutionAmountMinor)).toBe(400);
    }
  });
});

describe('THE PHASE 8 BOUNDARY', () => {
  it('records a refund resolution and returns nothing financial', async () => {
    await start();
    const result = await call('POST', `/${DISPUTE}/resolution`, { body: DECISION });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      outcome: 'resolved',
      status: 'resolved',
      resolution: 'refund_buyer',
    });
    // No refund identifier, no payment reference, no ledger, no balance, no payout — because none was created.
    for (const forbidden of [
      'refundId',
      'refund_id',
      'paymentId',
      'payment_id',
      'ledger',
      'journal',
      'balance',
      'payout',
      'withdrawal',
      'provider',
      'settlement',
      'reversal',
    ]) {
      expect(result.raw, forbidden).not.toContain(forbidden);
    }
  });

  it('reaches exactly the five dispute store methods and no other', async () => {
    const seen = await start();
    for (const path of READS) await call('GET', path);
    await call('POST', `/${DISPUTE}/messages`, { body: MESSAGE_BODY });
    await call('POST', `/${DISPUTE}/resolution`, { body: DECISION });

    const names = [...new Set(seen.filter((e) => e.name !== 'console-access').map((e) => e.name))].sort();
    // The whole surface, and nothing financial even under a name this suite did not anticipate.
    expect(names).toEqual(['detail', 'messages', 'post', 'queue', 'resolve']);
  });

  it('records all four resolutions, and none of them returns anything financial', async () => {
    await start();
    for (const resolution of DISPUTE_RESOLUTIONS) {
      const isRefund = resolution === 'refund_buyer' || resolution === 'partial_refund';
      const result = await call('POST', `/${DISPUTE}/resolution`, {
        body: {
          resolution,
          resolutionNote: 'Because of the evidence.',
          ...(isRefund ? { resolutionAmountMinor: '5000' } : {}),
        },
      });
      expect(result.status, resolution).toBe(200);
      expect(result.body['resolution'], resolution).toBe(resolution);
      expect(result.raw, resolution).not.toContain('refund_id');
      expect(result.raw, resolution).not.toContain('paymentId');
    }
  });

  it('serves no refund, reversal or payout route on this controller', async () => {
    await start();
    // A boundary should fail loudly if somebody later adds a control that crosses it.
    for (const path of [
      `/${DISPUTE}/refund`,
      `/${DISPUTE}/refunds`,
      `/${DISPUTE}/reversal`,
      `/${DISPUTE}/payout`,
      `/${DISPUTE}/resolution/pay`,
      `/${DISPUTE}/resolution/execute`,
      `/${DISPUTE}/ledger`,
    ]) {
      const result = await call('POST', path, { body: {} });
      expect(result.status, path).toBe(404);
    }
  });

  it('refuses a body reaching for a refund, a payment or the order’s lifecycle', async () => {
    await start();
    for (const extra of [
      { refundId: DISPUTE },
      { paymentId: DISPUTE },
      { executeRefund: true },
      { payNow: true },
      { orderStatus: 'refunded' },
      { status: 'resolved' },
      { resolvedBy: STAFF },
      { resolvedAt: '2026-05-05T09:00:00.000Z' },
      { ledgerJournalId: DISPUTE },
    ]) {
      const result = await call('POST', `/${DISPUTE}/resolution`, {
        body: { ...DECISION, ...extra },
      });
      expect(result.status, JSON.stringify(extra)).toBe(400);
    }
  });
});

describe('each route requires exactly one key, and it is the right one', () => {
  it('reads all three on the read key alone, and writes nothing with it', async () => {
    await start({ permissions: [READ] });

    for (const path of READS) expect((await call('GET', path)).status, path).toBe(200);
    expect(
      (await call('POST', `/${DISPUTE}/messages`, { body: MESSAGE_BODY })).status,
    ).toBe(404);
    expect((await call('POST', `/${DISPUTE}/resolution`, { body: DECISION })).status).toBe(404);
  });

  it('writes on the manage key alone, and reads nothing with it', async () => {
    await start({ permissions: [MANAGE] });

    expect(
      (await call('POST', `/${DISPUTE}/messages`, { body: MESSAGE_BODY })).status,
    ).toBe(200);
    expect((await call('POST', `/${DISPUTE}/resolution`, { body: DECISION })).status).toBe(200);
    for (const path of READS) expect((await call('GET', path)).status, path).toBe(404);
  });

  it('refuses everything to a caller holding every other admin key instead', async () => {
    await start({ permissions: [...OTHER_KEYS] });

    for (const path of READS) expect((await call('GET', path)).status, path).toBe(404);
    expect(
      (await call('POST', `/${DISPUTE}/messages`, { body: MESSAGE_BODY })).status,
    ).toBe(404);
    expect((await call('POST', `/${DISPUTE}/resolution`, { body: DECISION })).status).toBe(404);
  });

  it('refuses everything to a caller holding each other key on its own', async () => {
    for (const key of OTHER_KEYS) {
      await start({ permissions: [key] });
      for (const path of READS) expect((await call('GET', path)).status, `${key} :: ${path}`).toBe(404);
      expect(
        (await call('POST', `/${DISPUTE}/resolution`, { body: DECISION })).status,
        key,
      ).toBe(404);
      await app?.close();
      app = undefined;
    }
  });

  it('never consults the store for a caller who does not hold the key', async () => {
    const seen = await start({ permissions: [] });
    for (const path of READS) await call('GET', path);
    await call('POST', `/${DISPUTE}/messages`, { body: MESSAGE_BODY });
    await call('POST', `/${DISPUTE}/resolution`, { body: DECISION });

    expect(seen.filter((entry) => entry.name !== 'console-access')).toHaveLength(0);
  });
});

describe('the assurance level comes from the validated token', () => {
  it('refuses a caller at aal1 on every route', async () => {
    await start();
    const headers = { [SESSION_TOKEN_HEADER]: AAL1_TOKEN };

    for (const path of READS) expect((await call('GET', path, { headers })).status, path).toBe(404);
    expect(
      (await call('POST', `/${DISPUTE}/messages`, { body: MESSAGE_BODY, headers })).status,
    ).toBe(404);
    expect(
      (await call('POST', `/${DISPUTE}/resolution`, { body: DECISION, headers })).status,
    ).toBe(404);
  });

  it('asks the database with the assurance level it read, never one a request claimed', async () => {
    const seen = await start();
    await call('GET', '');
    await call('GET', '', { headers: { [SESSION_TOKEN_HEADER]: AAL1_TOKEN } });

    const access = seen.filter((entry) => entry.name === 'console-access');
    expect(access[0]?.input).toEqual({ userId: STAFF, isAal2: true });
    expect(access[1]?.input).toEqual({ userId: STAFF, isAal2: false });
  });

  it('passes the caller’s own account and assurance level to every operation', async () => {
    const seen = await start();
    for (const path of READS) await call('GET', path);
    await call('POST', `/${DISPUTE}/messages`, { body: MESSAGE_BODY });
    await call('POST', `/${DISPUTE}/resolution`, { body: DECISION });

    for (const entry of seen.filter((item) => item.name !== 'console-access')) {
      expect(entry.input['userId'], entry.name).toBe(STAFF);
      expect(entry.input['isAal2'], entry.name).toBe(true);
    }
  });

  it('refuses a request with no session at all', async () => {
    await start();
    const response = await app!.inject({
      method: 'GET',
      url: '/v1/admin/disputes',
      headers: { [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL },
    });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a session the provider will not vouch for', async () => {
    await start({ unauthenticated: true });
    expect((await call('GET', '')).status).toBe(401);
  });
});

describe('nothing about authority is accepted from a browser', () => {
  it('refuses a message body naming an author, a role or a time', async () => {
    await start();
    for (const extra of [
      { authorUserId: STAFF },
      { authorRole: 'staff' },
      { createdAt: '2026-05-05T09:00:00.000Z' },
      { disputeId: DISPUTE },
      { permission: MANAGE },
      { isAal2: true },
    ]) {
      const result = await call('POST', `/${DISPUTE}/messages`, {
        body: { ...MESSAGE_BODY, ...extra },
      });
      expect(result.status, JSON.stringify(extra)).toBe(400);
    }
  });

  it('requires a message body and a reason', async () => {
    await start();
    for (const body of [{}, { body: '' }, { body: '   ' }, { body: null }, { isInternal: true }]) {
      expect((await call('POST', `/${DISPUTE}/messages`, { body })).status).toBe(400);
    }
    for (const body of [
      { resolution: 'no_action' },
      { resolution: 'no_action', resolutionNote: '' },
      { resolution: 'no_action', resolutionNote: '   ' },
    ]) {
      expect((await call('POST', `/${DISPUTE}/resolution`, { body })).status).toBe(400);
    }
  });

  it('accepts only the four resolutions', async () => {
    await start();
    for (const resolution of ['approved', 'refunded', 'REFUND_BUYER', '', 'refund_buyer ']) {
      const result = await call('POST', `/${DISPUTE}/resolution`, {
        body: { resolution, resolutionNote: 'Because.' },
      });
      expect(result.status, resolution).toBe(400);
    }
  });

  it('refuses an amount against a resolution that is not a refund, before the request leaves', async () => {
    const seen = await start();
    for (const resolution of ['release_seller', 'no_action']) {
      const result = await call('POST', `/${DISPUTE}/resolution`, {
        body: { resolution, resolutionNote: 'Because.', resolutionAmountMinor: '5000' },
      });
      expect(result.status, resolution).toBe(400);
    }
    // The contract refused it, so the writer was never asked.
    expect(seen.filter((entry) => entry.name === 'resolve')).toHaveLength(0);
  });

  it('sends the writer the trimmed text and nothing else', async () => {
    const seen = await start();
    await call('POST', `/${DISPUTE}/messages`, {
      body: { body: '  We have asked the courier.  ', isInternal: true },
    });
    expect(seen.find((entry) => entry.name === 'post')?.input).toEqual({
      userId: STAFF,
      isAal2: true,
      disputeId: DISPUTE,
      body: 'We have asked the courier.',
      isInternal: true,
    });

    await call('POST', `/${DISPUTE}/resolution`, {
      body: { resolution: 'no_action', resolutionNote: '  Neither side substantiated anything.  ' },
    });
    expect(seen.find((entry) => entry.name === 'resolve')?.input).toEqual({
      userId: STAFF,
      isAal2: true,
      disputeId: DISPUTE,
      resolution: 'no_action',
      resolutionNote: 'Neither side substantiated anything.',
      resolutionAmountMinor: null,
    });
  });

  it('defaults an unsent internal flag to false', async () => {
    const seen = await start();
    await call('POST', `/${DISPUTE}/messages`, { body: { body: 'Visible to both.' } });
    // The safe default for a note on a record two other people can read is that they can read it too.
    expect(seen.find((entry) => entry.name === 'post')?.input['isInternal']).toBe(false);
  });

  it('refuses a dispute identifier that is not one', async () => {
    await start();
    for (const value of ['not-a-uuid', '1', `${DISPUTE}x`, 'null']) {
      expect((await call('GET', `/${value}`)).status, value).toBe(400);
      expect((await call('GET', `/${value}/messages`)).status, value).toBe(400);
      expect(
        (await call('POST', `/${value}/resolution`, { body: DECISION })).status,
        value,
      ).toBe(400);
    }
  });
});

describe('only the reachable statuses are accepted as a filter', () => {
  it('accepts open and resolved', async () => {
    const seen = await start();
    for (const status of ['open', 'resolved']) {
      expect((await call('GET', `?status=${status}`)).status, status).toBe(200);
    }
    expect(seen.filter((e) => e.name === 'queue').map((e) => e.input['status'])).toEqual([
      'open',
      'resolved',
    ]);
  });

  /**
   * Refused, not answered with an empty page. A filter naming `under_review` asks for a state this platform
   * cannot put a dispute into, and an empty page would suggest the workflow exists with nothing in it.
   */
  it('refuses the four states no writer can produce', async () => {
    const seen = await start();
    for (const status of ['awaiting_seller', 'awaiting_buyer', 'under_review', 'cancelled']) {
      const result = await call('GET', `?status=${status}`);
      expect(result.status, status).toBe(400);
      expect(result.body['code'], status).toBe('VALIDATION_FAILED');
    }
    expect(seen.filter((entry) => entry.name === 'queue')).toHaveLength(0);
  });

  it('refuses a status the schema does not have at all', async () => {
    await start();
    for (const status of ['approved', 'OPEN', 'settled', "open' or true"]) {
      expect((await call('GET', `?status=${encodeURIComponent(status)}`)).status, status).toBe(400);
    }
  });
});

describe('every outcome the database can return maps to one approved answer', () => {
  it('refuses a resolver who is a party, and says why', async () => {
    await start({ resolveOutcome: 'is_party' });
    const result = await call('POST', `/${DISPUTE}/resolution`, { body: DECISION });

    expect(result.status).toBe(409);
    expect(result.body['code']).toBe('DISPUTE_IS_PARTY');
    expect(result.body['detail']).toBe('Nobody rules on a dispute they are a party to.');
  });

  it('refuses an internal note from a party with the same code', async () => {
    await start({ postOutcome: 'is_party' });
    const result = await call('POST', `/${DISPUTE}/messages`, {
      body: { body: 'A private note', isInternal: true },
    });

    expect(result.status).toBe(409);
    expect(result.body['code']).toBe('DISPUTE_IS_PARTY');
  });

  it('maps a closed thread, an already-resolved dispute, a missing reason and a stray amount', async () => {
    for (const [outcome, code] of [
      ['closed', 'DISPUTE_THREAD_CLOSED'],
      ['is_party', 'DISPUTE_IS_PARTY'],
    ] as const) {
      await start({ postOutcome: outcome });
      const result = await call('POST', `/${DISPUTE}/messages`, { body: MESSAGE_BODY });
      expect(result.status, outcome).toBe(409);
      expect(result.body['code'], outcome).toBe(code);
      await app?.close();
      app = undefined;
    }

    for (const [outcome, code] of [
      ['already_resolved', 'DISPUTE_ALREADY_RESOLVED'],
      ['reason_required', 'DISPUTE_REASON_REQUIRED'],
      ['amount_not_allowed', 'DISPUTE_AMOUNT_NOT_ALLOWED'],
    ] as const) {
      await start({ resolveOutcome: outcome });
      const result = await call('POST', `/${DISPUTE}/resolution`, { body: DECISION });
      expect(result.status, outcome).toBe(409);
      expect(result.body['code'], outcome).toBe(code);
      await app?.close();
      app = undefined;
    }
  });

  it('maps an unusable request to a validation failure', async () => {
    await start({ resolveOutcome: 'invalid' });
    const result = await call('POST', `/${DISPUTE}/resolution`, { body: DECISION });
    expect(result.status).toBe(400);
    expect(result.body['code']).toBe('VALIDATION_FAILED');
  });

  it('maps a dispute the writer could not find to the neutral answer', async () => {
    await start({ resolveOutcome: 'not_found' });
    const result = await call('POST', `/${DISPUTE}/resolution`, { body: DECISION });
    expect(result.status).toBe(404);
    expect(result.body['code']).toBe('NOT_FOUND');
  });

  it('turns an outcome it does not understand into an outage, never a success', async () => {
    await start({ resolveOutcome: 'refunded' });
    const result = await call('POST', `/${DISPUTE}/resolution`, { body: DECISION });
    expect(result.status).toBe(503);
    expect(result.body['code']).toBe('SERVICE_UNAVAILABLE');
  });

  it('turns a store that throws into an outage on every route', async () => {
    await start({ storeThrows: true });
    for (const path of READS) expect((await call('GET', path)).status, path).toBe(503);
    expect(
      (await call('POST', `/${DISPUTE}/messages`, { body: MESSAGE_BODY })).status,
    ).toBe(503);
    expect((await call('POST', `/${DISPUTE}/resolution`, { body: DECISION })).status).toBe(503);
  });
});

describe('a refusal says nothing about existence', () => {
  it('answers a missing dispute and a missing permission identically, byte for byte', async () => {
    await start({ detailOutcome: 'not_found' });
    const absent = await call('GET', `/${DISPUTE}`);
    await app?.close();
    app = undefined;

    await start({ permissions: [] });
    const unauthorized = await call('GET', `/${DISPUTE}`);

    expect(absent.status).toBe(404);
    expect(unauthorized.status).toBe(404);
    expect(absent.raw).toBe(unauthorized.raw);
  });

  it('never answers 403 on any of the five', async () => {
    await start({ permissions: [] });
    for (const path of READS) expect((await call('GET', path)).status, path).not.toBe(403);
    expect(
      (await call('POST', `/${DISPUTE}/resolution`, { body: DECISION })).status,
    ).not.toBe(403);
  });

  it('answers an empty thread exactly as a dispute nobody has written on', async () => {
    await start({ messageRows: [] });
    const empty = await call('GET', `/${DISPUTE}/messages`);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ items: [] });
  });
});

describe('the queue pages deterministically', () => {
  it('asks for one row more than it will return', async () => {
    const seen = await start();
    await call('GET', '?limit=5');
    expect(seen.find((entry) => entry.name === 'queue')?.input['limit']).toBe(6);
  });

  it('emits a cursor only when there is another page', async () => {
    const rows = Array.from({ length: 3 }, (_, index) => ({
      ...QUEUE_ROW,
      id: `fe000000-0000-4000-8000-00000000000${index + 1}`,
    }));

    await start({ queueRows: rows });
    const full = await call('GET', '?limit=2');
    expect((full.body['items'] as unknown[]).length).toBe(2);
    expect(full.body['nextCursor']).toBeTypeOf('string');

    await app?.close();
    app = undefined;
    await start({ queueRows: rows.slice(0, 2) });
    expect((await call('GET', '?limit=2')).body['nextCursor']).toBeNull();
  });

  it('decodes its own cursor into the position the reader is asked for', async () => {
    const seen = await start();
    const cursor = encodeDisputeQueueCursor({
      createdAt: new Date('2026-05-01T09:00:00.000Z'),
      id: DISPUTE,
    });
    await call('GET', `?cursor=${encodeURIComponent(cursor)}`);

    const read = seen.find((entry) => entry.name === 'queue');
    expect((read?.input['cursorCreatedAt'] as Date).toISOString()).toBe('2026-05-01T09:00:00.000Z');
    expect(read?.input['cursorId']).toBe(DISPUTE);
  });

  it('refuses a cursor that is not one, and a position from another list', async () => {
    await start();
    const recovery = Buffer.from(`rq1|2026-05-01T09:00:00.000Z|${DISPUTE}`, 'utf8').toString('base64url');
    const review = Buffer.from(`rv1|2026-05-01T09:00:00.000Z|${DISPUTE}`, 'utf8').toString('base64url');
    const job = Buffer.from(`jr1|2026-05-01T09:00:00.000Z|${DISPUTE}`, 'utf8').toString('base64url');
    for (const cursor of ['!!!!', 'abc', recovery, review, job, Buffer.from('dq1|x|y').toString('base64url')]) {
      const result = await call('GET', `?cursor=${encodeURIComponent(cursor)}`);
      expect(result.status, cursor).toBe(400);
      expect(result.body['code']).toBe('VALIDATION_FAILED');
    }
  });

  it('refuses a limit that is not one and clamps one that is too large', async () => {
    const seen = await start();
    for (const limit of ['0', '-1', 'ten', '1.5', '10000']) {
      expect((await call('GET', `?limit=${limit}`)).status, limit).toBe(400);
    }
    await call('GET', '');
    expect(seen.find((entry) => entry.name === 'queue')?.input['limit']).toBe(21);
  });

  it('asks the thread for its fixed page', async () => {
    const seen = await start();
    await call('GET', `/${DISPUTE}/messages`);
    expect(seen.find((entry) => entry.name === 'messages')?.input['limit']).toBe(
      DISPUTE_THREAD_LIMIT,
    );
  });
});

describe('the thread carries the internal notes for staff', () => {
  it('returns a staff-only note, marked', async () => {
    await start({
      messageRows: [
        MESSAGE_ROW,
        {
          ...MESSAGE_ROW,
          id: 'ff000000-0000-4000-8000-000000000002',
          authorRole: 'staff',
          body: 'The courier has form for this.',
          isInternal: true,
          isOwnMessage: true,
        },
      ],
    });
    const thread = (await call('GET', `/${DISPUTE}/messages`)).body as {
      items: readonly Record<string, unknown>[];
    };

    expect(thread.items).toHaveLength(2);
    expect(thread.items[1]?.['isInternal']).toBe(true);
    expect(thread.items[1]?.['authorRole']).toBe('staff');
    expect(thread.items[1]?.['isOwnMessage']).toBe(true);
    // And still no author.
    expect((await call('GET', `/${DISPUTE}/messages`)).raw).not.toContain('"authorUserId":');
  });
});
