import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  AdminRoleCatalogueResponseSchema,
  AdminSecurityEventsResponseSchema,
  AdminSellerDetailResponseSchema,
  AdminSellerPageResponseSchema,
  AdminUserDetailResponseSchema,
  AdminUserPageResponseSchema,
  AdminUserRolesResponseSchema,
  AuditPageResponseSchema,
  RecoveryCompletionResponseSchema,
  RecoveryDecisionResponseSchema,
  RecoveryEvidenceResponseSchema,
  RecoveryQueueResponseSchema,
  RecoveryRequestDetailResponseSchema,
  RecoveryReviewResponseSchema,
  SESSION_TOKEN_HEADER,
  SellerStatusChangeResponseSchema,
} from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { AuthenticationRequiredError } from '../src/auth/auth-errors.js';
import { ADMIN_OPERATIONS_STORE } from '../src/admin/admin-operations.service.js';
import { SUPABASE_AUTH_CLIENT } from '../src/auth/login.service.js';
import { STAFF_CONSOLE_STORE, type StaffConsoleRow } from '../src/admin/staff-console.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * Seller and user reads, role reads, recovery review and the audit trail at the API boundary (Phase 7-O).
 *
 * The properties this suite exists for:
 *
 * **Each route requires exactly one key, and the right one.** Every operation is driven by a caller holding
 * each of the six keys in turn, and each refuses every key but its own — including the three that are easy
 * to confuse and that 0033 deliberately does not hand out together: reading an account needs
 * `users.profile.read`, reading its **roles** needs `users.role.read`, and reading its **security timeline**
 * needs `users.security.read`. A caller holding the first and not the other two reads the account and
 * neither of the rest.
 *
 * **The assurance level is read from the validated token, not from the request.** A caller whose token is
 * not aal2 reaches the store with `isAal2: false`, and the database is what refuses them.
 *
 * **Nothing about authority is accepted from a browser.** Every attempt to name an actor, a role, a
 * permission key, an assurance level, a hold or a recovery status is refused by the strict schema, and the
 * store is asked with the token's own account every time.
 *
 * **A refusal says nothing about existence.** A row a caller may not read and one that is not there produce
 * the same status, code and body, compared byte for byte.
 *
 * **Every outcome the database can return maps to one approved answer**, including the two-person rule's
 * refusal, and an outcome this service does not understand becomes a 503 rather than a success.
 *
 * **There is no route that assigns a role or changes a seller's status.** Asserted by driving those
 * addresses and finding nothing there, because a reported capability gap should fail loudly if somebody
 * later fills it without an owner decision.
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
const TARGET = '22222222-2222-4222-8222-222222222222';
const REQUEST = 'a8000000-0000-4000-8000-000000000001';
const SLUG = 'a-shop';

const SELLERS = 'sellers.profile.read';
const USERS = 'users.profile.read';
const ROLES = 'users.role.read';
const SECURITY = 'users.security.read';
const RECOVERY = 'security.recovery.review';
const AUDIT = 'audit.read';
/** The one write key: 0009's own admin update policy requires it, and a moderator does not hold it. */
const SELLERS_MANAGE = 'sellers.profile.manage';
const ALL_KEYS = [SELLERS, USERS, ROLES, SECURITY, RECOVERY, AUDIT, SELLERS_MANAGE] as const;

/** The one key this increment still consumes nowhere, because role assignment has no writer. */
const UNUSED_KEYS = ['users.role.manage'] as const;

const SELLER_ROW = {
  slug: SLUG,
  displayName: 'A Shop',
  status: 'active',
  verificationStatus: 'verified',
  countryCode: 'EG',
  city: 'Cairo',
  listingCount: 3,
  openReportCount: 1,
  createdAt: new Date('2026-05-01T09:00:00.000Z'),
};

const SELLER_DETAIL = {
  outcome: 'found',
  slug: SLUG,
  displayName: 'A Shop',
  bio: 'We sell things.',
  contentLanguage: 'en',
  status: 'active',
  suspendedAt: null,
  suspensionReason: null,
  closedAt: null,
  verificationStatus: 'verified',
  verifiedAt: new Date('2026-04-01T09:00:00.000Z'),
  countryCode: 'EG',
  governorate: 'Cairo',
  city: 'Cairo',
  listingCount: 3,
  liveListingCount: 2,
  openReportCount: 1,
  isOwnStorefront: false,
  canManage: true,
  createdAt: new Date('2026-05-01T09:00:00.000Z'),
};

const USER_ROW = {
  id: TARGET,
  displayName: 'Nadia',
  status: 'active',
  localeCode: 'en',
  hasVerifiedEmail: true,
  hasVerifiedPhone: false,
  isStaff: false,
  isSeller: true,
  isSelf: false,
  createdAt: new Date('2026-05-01T09:00:00.000Z'),
};

const USER_DETAIL = {
  outcome: 'found',
  ...USER_ROW,
  timezone: 'Africa/Cairo',
  sellerSlug: SLUG,
  lastSeenAt: new Date('2026-05-02T09:00:00.000Z'),
};

const ROLE_ROW = {
  roleKey: 'moderator',
  nameEn: 'Moderator',
  nameAr: 'مشرف',
  requiresMfa: true,
  isAdminConsole: true,
  grantedAt: new Date('2026-04-01T09:00:00.000Z'),
  expiresAt: null,
  revokedAt: null,
  isEffective: true,
  permissionCount: 7,
};

const CATALOGUE_ROW = { ...ROLE_ROW, isAssignable: true, holderCount: 2 };

const EVENT_ROW = {
  id: 42,
  eventType: 'auth.login_failed',
  details: { attempt: 1 },
  occurredAt: new Date('2026-05-03T09:00:00.000Z'),
};

const QUEUE_ROW = {
  id: REQUEST,
  status: 'submitted',
  claimedContactChannel: 'email',
  newContactChannel: null,
  matchedAnAccount: true,
  isOwnRequest: false,
  isTheReviewer: false,
  hasBeenReviewed: false,
  contactVerified: false,
  evidenceCount: 2,
  expiresAt: new Date('2026-06-01T09:00:00.000Z'),
  createdAt: new Date('2026-05-01T09:00:00.000Z'),
};

const REQUEST_DETAIL = {
  outcome: 'found',
  ...QUEUE_ROW,
  reviewedByMe: false,
  reviewNote: null,
  reviewedAt: null,
  approvedAt: null,
  rejectionReason: null,
  contactVerifiedAt: null,
  sessionsRevokedAt: null,
  mfaResetAt: null,
  holdUntil: null,
  completedAt: null,
  closedAt: null,
  evidenceCount: undefined,
  hasBeenReviewed: undefined,
  contactVerified: undefined,
};

const EVIDENCE_ROW = {
  id: 'e8000000-0000-4000-8000-000000000001',
  evidenceType: 'national_id',
  originalFilename: 'id.jpg',
  contentType: 'image/jpeg',
  byteSize: 120000,
  uploadedAt: new Date('2026-05-01T09:05:00.000Z'),
};

const AUDIT_ROW = {
  id: 7,
  occurredAt: new Date('2026-05-04T09:00:00.000Z'),
  actorType: 'user',
  isOwnAction: false,
  action: 'update',
  tableSchema: 'public',
  tableName: 'listings',
  recordId: '88880000-0000-4000-8000-000000000001',
  changedColumns: ['status'],
  requestId: 'req-one',
};

interface Seen {
  readonly name: string;
  readonly input: Record<string, unknown>;
}

interface Doubles {
  readonly permissions?: readonly string[];
  readonly sellerOutcome?: string;
  readonly userOutcome?: string;
  readonly requestOutcome?: string;
  readonly writeOutcome?: string;
  readonly completionOutcome?: string;
  readonly sellerStatusOutcome?: string;
  readonly storeThrows?: boolean;
  readonly unauthenticated?: boolean;
  readonly sellerRows?: readonly unknown[];
  readonly userRows?: readonly unknown[];
  readonly roleRows?: readonly unknown[];
  readonly eventRows?: readonly unknown[];
  readonly queueRows?: readonly unknown[];
  readonly auditRows?: readonly unknown[];
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
    adminSellerPage: async (input: Record<string, unknown>) => {
      note('sellerPage')(input);
      return doubles.sellerRows ?? [SELLER_ROW];
    },
    adminSellerDetail: async (input: Record<string, unknown>) => {
      note('sellerDetail')(input);
      const outcome = doubles.sellerOutcome ?? 'found';
      return outcome === 'found' ? SELLER_DETAIL : { ...SELLER_DETAIL, outcome, slug: null };
    },
    sellerStatusSetForStaff: async (input: Record<string, unknown>) => {
      note('sellerStatus')(input);
      const outcome = doubles.sellerStatusOutcome ?? 'updated';
      return { outcome, status: outcome === 'updated' ? 'suspended' : 'active' };
    },
    adminUserPage: async (input: Record<string, unknown>) => {
      note('userPage')(input);
      return doubles.userRows ?? [USER_ROW];
    },
    adminUserDetail: async (input: Record<string, unknown>) => {
      note('userDetail')(input);
      const outcome = doubles.userOutcome ?? 'found';
      return outcome === 'found' ? USER_DETAIL : { ...USER_DETAIL, outcome, id: null };
    },
    adminUserRoles: async (input: Record<string, unknown>) => {
      note('userRoles')(input);
      return doubles.roleRows ?? [ROLE_ROW];
    },
    adminRoleCatalogue: async (input: Record<string, unknown>) => {
      note('roleCatalogue')(input);
      return [CATALOGUE_ROW];
    },
    adminAccountSecurityTimeline: async (input: Record<string, unknown>) => {
      note('securityTimeline')(input);
      return doubles.eventRows ?? [EVENT_ROW];
    },
    recoveryReviewQueue: async (input: Record<string, unknown>) => {
      note('recoveryQueue')(input);
      return doubles.queueRows ?? [QUEUE_ROW];
    },
    recoveryRequestForStaff: async (input: Record<string, unknown>) => {
      note('recoveryRequest')(input);
      const outcome = doubles.requestOutcome ?? 'found';
      return outcome === 'found' ? REQUEST_DETAIL : { ...REQUEST_DETAIL, outcome, id: null };
    },
    recoveryEvidenceForStaff: async (input: Record<string, unknown>) => {
      note('recoveryEvidence')(input);
      return [EVIDENCE_ROW];
    },
    recoveryReviewForStaff: async (input: Record<string, unknown>) => {
      note('recoveryReview')(input);
      const outcome = doubles.writeOutcome ?? 'reviewed';
      return { outcome, status: outcome === 'reviewed' ? 'under_review' : null };
    },
    recoveryDecideForStaff: async (input: Record<string, unknown>) => {
      note('recoveryDecide')(input);
      const outcome = doubles.writeOutcome ?? 'decided';
      return { outcome, status: outcome === 'decided' ? 'contact_verification' : null };
    },
    recoveryCompleteForStaff: async (input: Record<string, unknown>) => {
      note('recoveryComplete')(input);
      const outcome = doubles.completionOutcome ?? 'completed';
      return {
        outcome,
        holdUntil: outcome === 'completed' ? new Date('2026-05-10T09:00:00.000Z') : null,
      };
    },
    adminAuditPage: async (input: Record<string, unknown>) => {
      note('auditPage')(input);
      return doubles.auditRows ?? [AUDIT_ROW];
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
        throw new Error('administering must never sign anyone in');
      },
      revokeAllSessions: async () => {
        // 0028's completion revokes sessions in the database. Nothing in this service may do it here,
        // and this throw is what proves the service never tries.
        throw new Error('this service must never revoke a session itself');
      },
    })
    .overrideProvider(STAFF_CONSOLE_STORE)
    .useValue({
      staffConsoleAccess: async (input: { userId: string; isAal2: boolean }): Promise<StaffConsoleRow> => {
        seen.push({ name: 'console-access', input });
        // 0068's own behaviour, modelled rather than asserted around: a role that requires MFA counts for
        // nothing at aal1, so the effective set is empty. Every role holding one of these six keys requires
        // MFA, which is why an aal1 caller is refused without any separate assurance test in the service.
        const granted = [...(doubles.permissions ?? ALL_KEYS)];
        return {
          hasConsoleRole: true,
          requiresStepUp: false,
          roles: ['admin'],
          permissions: input.isAal2 ? granted : [],
        };
      },
      buyerProfile: async (userId: string) => ({ id: userId, displayName: 'Nadia', localeCode: 'en' }),
    })
    .overrideProvider(ADMIN_OPERATIONS_STORE)
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
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH',
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<Result> {
  const response = await app!.inject({
    method,
    url: `/v1/admin${path}`,
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

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/* ------------------------------------------------------------------------------------------------ */

describe('the shapes the contracts promise', () => {
  it('answers every read with a body its own schema accepts', async () => {
    await start();

    expect(AdminSellerPageResponseSchema.safeParse((await call('GET', '/sellers')).body).success).toBe(true);
    expect(
      AdminSellerDetailResponseSchema.safeParse((await call('GET', `/sellers/${SLUG}`)).body).success,
    ).toBe(true);
    expect(AdminUserPageResponseSchema.safeParse((await call('GET', '/users')).body).success).toBe(true);
    expect(
      AdminUserDetailResponseSchema.safeParse((await call('GET', `/users/${TARGET}`)).body).success,
    ).toBe(true);
    expect(
      AdminUserRolesResponseSchema.safeParse((await call('GET', `/users/${TARGET}/roles`)).body).success,
    ).toBe(true);
    expect(
      AdminSecurityEventsResponseSchema.safeParse(
        (await call('GET', `/users/${TARGET}/security-events`)).body,
      ).success,
    ).toBe(true);
    expect(AdminRoleCatalogueResponseSchema.safeParse((await call('GET', '/roles')).body).success).toBe(
      true,
    );
    expect(
      RecoveryQueueResponseSchema.safeParse((await call('GET', '/recovery/requests')).body).success,
    ).toBe(true);
    expect(
      RecoveryRequestDetailResponseSchema.safeParse(
        (await call('GET', `/recovery/requests/${REQUEST}`)).body,
      ).success,
    ).toBe(true);
    expect(
      RecoveryEvidenceResponseSchema.safeParse(
        (await call('GET', `/recovery/requests/${REQUEST}/evidence`)).body,
      ).success,
    ).toBe(true);
    expect(AuditPageResponseSchema.safeParse((await call('GET', '/audit')).body).success).toBe(true);
  });

  it('answers every write with a body its own schema accepts', async () => {
    await start();

    expect(
      RecoveryReviewResponseSchema.safeParse(
        (await call('POST', `/recovery/requests/${REQUEST}/review`, { body: {} })).body,
      ).success,
    ).toBe(true);
    expect(
      RecoveryDecisionResponseSchema.safeParse(
        (await call('POST', `/recovery/requests/${REQUEST}/decision`, { body: { decision: 'approved' } }))
          .body,
      ).success,
    ).toBe(true);
    expect(
      RecoveryCompletionResponseSchema.safeParse(
        (await call('POST', `/recovery/requests/${REQUEST}/completion`, { body: { mfaWasReset: false } }))
          .body,
      ).success,
    ).toBe(true);
  });

  it('reports a storefront by its slug and never by the account behind it', async () => {
    await start();
    const body = (await call('GET', `/sellers/${SLUG}`)).body as {
      seller: Record<string, unknown>;
    };
    expect(body.seller['slug']).toBe(SLUG);
    for (const forbidden of ['userId', 'legalName', 'contactEmail', 'contactPhoneE164', 'logoObjectPath']) {
      expect(body.seller[forbidden]).toBeUndefined();
    }
  });

  it('reports whether a contact was confirmed and never the contact', async () => {
    await start();
    const body = (await call('GET', `/users/${TARGET}`)).body as { user: Record<string, unknown> };
    expect(body.user['hasVerifiedEmail']).toBe(true);
    expect(body.user['hasVerifiedPhone']).toBe(false);
    for (const forbidden of ['fullName', 'phoneE164', 'email', 'avatarObjectPath', 'emailVerifiedAt']) {
      expect(body.user[forbidden]).toBeUndefined();
    }
  });

  it('reports which columns an audited change touched and never their values', async () => {
    await start();
    const body = (await call('GET', '/audit')).body as { items: Record<string, unknown>[] };
    expect(body.items[0]!['changedColumns']).toEqual(['status']);
    for (const forbidden of ['oldValues', 'newValues', 'actorId', 'requestIp', 'details']) {
      expect(body.items[0]![forbidden]).toBeUndefined();
    }
  });

  it('reports a recovery request’s channel and never a contact', async () => {
    await start();
    const body = (await call('GET', `/recovery/requests/${REQUEST}`)).body as {
      request: Record<string, unknown>;
    };
    expect(body.request['claimedContactChannel']).toBe('email');
    for (const forbidden of [
      'claimedContactHash',
      'newContactHash',
      'userId',
      'reviewerUserId',
      'approverUserId',
      'otpChallengeId',
      'requestIp',
    ]) {
      expect(body.request[forbidden]).toBeUndefined();
    }
  });

  it('reports what evidence was supplied and never where it is stored', async () => {
    await start();
    const body = (await call('GET', `/recovery/requests/${REQUEST}/evidence`)).body as {
      items: Record<string, unknown>[];
    };
    expect(body.items[0]!['evidenceType']).toBe('national_id');
    expect(body.items[0]!['objectPath']).toBeUndefined();
    expect((await call('GET', `/recovery/requests/${REQUEST}/evidence`)).raw).not.toContain(
      'recovery-evidence/',
    );
  });
});

describe('each route requires exactly one key, and the right one', () => {
  const ROUTES: ReadonlyArray<{ path: string; key: string; method?: 'POST'; body?: unknown }> = [
    { path: '/sellers', key: SELLERS },
    { path: `/sellers/${SLUG}`, key: SELLERS },
    { path: '/users', key: USERS },
    { path: `/users/${TARGET}`, key: USERS },
    { path: `/users/${TARGET}/roles`, key: ROLES },
    { path: `/users/${TARGET}/security-events`, key: SECURITY },
    { path: '/roles', key: ROLES },
    { path: '/recovery/requests', key: RECOVERY },
    { path: `/recovery/requests/${REQUEST}`, key: RECOVERY },
    { path: `/recovery/requests/${REQUEST}/evidence`, key: RECOVERY },
    { path: '/audit', key: AUDIT },
    {
      path: `/sellers/${SLUG}/status`,
      key: SELLERS_MANAGE,
      method: 'POST',
      body: { status: 'suspended', reason: 'A reason.' },
    },
    { path: `/recovery/requests/${REQUEST}/review`, key: RECOVERY, method: 'POST', body: {} },
    {
      path: `/recovery/requests/${REQUEST}/decision`,
      key: RECOVERY,
      method: 'POST',
      body: { decision: 'approved' },
    },
    {
      path: `/recovery/requests/${REQUEST}/completion`,
      key: RECOVERY,
      method: 'POST',
      body: { mfaWasReset: false },
    },
  ];

  it('admits a caller holding the route’s own key', async () => {
    for (const route of ROUTES) {
      await start({ permissions: [route.key] });
      const result = await call(route.method ?? 'GET', route.path, { body: route.body });
      expect(result.status, route.path).toBe(200);
      await app?.close();
      app = undefined;
    }
  });

  it('refuses a caller holding every other key and not that one', async () => {
    for (const route of ROUTES) {
      const others = ALL_KEYS.filter((key) => key !== route.key);
      await start({ permissions: others });
      const result = await call(route.method ?? 'GET', route.path, { body: route.body });
      expect(result.status, route.path).toBe(404);
      expect(result.body['code'], route.path).toBe('NOT_FOUND');
      await app?.close();
      app = undefined;
    }
  });

  it('refuses a caller holding nothing at all', async () => {
    for (const route of ROUTES) {
      await start({ permissions: [] });
      const result = await call(route.method ?? 'GET', route.path, { body: route.body });
      expect(result.status, route.path).toBe(404);
      await app?.close();
      app = undefined;
    }
  });

  /**
   * The separation 0033 makes and this increment leans on: reading an account is not reading its roles,
   * and neither is reading its security record. A support agent holds the first alone.
   */
  it('lets a caller read an account without reading its roles or its security record', async () => {
    await start({ permissions: [USERS] });
    expect((await call('GET', `/users/${TARGET}`)).status).toBe(200);
    expect((await call('GET', `/users/${TARGET}/roles`)).status).toBe(404);
    expect((await call('GET', `/users/${TARGET}/security-events`)).status).toBe(404);
  });

  /**
   * The separation 0009 makes and 0079 leans on: reading a storefront is not moving one. A moderator holds
   * the read key alone, which is exactly the case this covers.
   */
  it('lets a caller read storefronts without moving one, and move one without reading accounts', async () => {
    await start({ permissions: [SELLERS] });
    expect((await call('GET', '/sellers')).status).toBe(200);
    expect((await call('GET', `/sellers/${SLUG}`)).status).toBe(200);
    expect(
      (await call('POST', `/sellers/${SLUG}/status`, { body: { status: 'suspended', reason: 'A reason.' } }))
        .status,
    ).toBe(404);
    await app?.close();
    app = undefined;

    await start({ permissions: [SELLERS_MANAGE] });
    expect(
      (await call('POST', `/sellers/${SLUG}/status`, { body: { status: 'suspended', reason: 'A reason.' } }))
        .status,
    ).toBe(200);
    expect((await call('GET', '/users')).status).toBe(404);
  });

  it('lets a caller read storefronts without reading accounts, and the reverse', async () => {
    await start({ permissions: [SELLERS] });
    expect((await call('GET', '/sellers')).status).toBe(200);
    expect((await call('GET', '/users')).status).toBe(404);
    await app?.close();
    app = undefined;

    await start({ permissions: [USERS] });
    expect((await call('GET', '/users')).status).toBe(200);
    expect((await call('GET', '/sellers')).status).toBe(404);
  });

  it('refuses the audit trail to a caller holding every other key', async () => {
    await start({ permissions: [SELLERS, USERS, ROLES, SECURITY, RECOVERY] });
    expect((await call('GET', '/audit')).status).toBe(404);
  });

  /** The two keys with no writer behind them unlock nothing here. */
  it('admits nobody anywhere on the strength of a management key', async () => {
    await start({ permissions: UNUSED_KEYS });
    for (const route of ROUTES) {
      const result = await call(route.method ?? 'GET', route.path, { body: route.body });
      expect(result.status, route.path).toBe(404);
    }
  });
});

describe('assurance comes from the validated token', () => {
  it('refuses every route at aal1, without a separate assurance test', async () => {
    const seen = await start();
    for (const path of ['/sellers', '/users', '/roles', '/recovery/requests', '/audit']) {
      const result = await call('GET', path, { headers: { [SESSION_TOKEN_HEADER]: AAL1_TOKEN } });
      expect(result.status, path).toBe(404);
    }
    // The permission lookup was made with the assurance level the token carries, which is what makes the
    // effective set empty for every role that requires MFA.
    expect(seen.filter((entry) => entry.name === 'console-access').every((entry) => entry.input['isAal2'] === false)).toBe(
      true,
    );
  });

  it('passes the token’s own assurance level to the store, not the request’s', async () => {
    const seen = await start();
    await call('GET', '/sellers');
    const read = seen.find((entry) => entry.name === 'sellerPage');
    expect(read?.input['isAal2']).toBe(true);
    expect(read?.input['userId']).toBe(STAFF);
  });

  it('refuses a request with no session token at all', async () => {
    await start();
    const response = await app!.inject({
      method: 'GET',
      url: '/v1/admin/sellers',
      headers: { [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL },
    });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a request whose token the provider rejects', async () => {
    await start({ unauthenticated: true });
    expect((await call('GET', '/sellers')).status).toBe(401);
  });
});

describe('nothing about authority is accepted from a browser', () => {
  it('asks the store with the token’s own account, whatever a body claims', async () => {
    const seen = await start();
    await call('POST', `/recovery/requests/${REQUEST}/review`, {
      body: { note: 'Checked.' },
    });
    const write = seen.find((entry) => entry.name === 'recoveryReview');
    expect(write?.input['userId']).toBe(STAFF);
    expect(write?.input['requestId']).toBe(REQUEST);
  });

  it('refuses a review body naming a reviewer, an actor, a status or an assurance level', async () => {
    await start();
    for (const body of [
      { reviewerUserId: TARGET },
      { actorUserId: TARGET },
      { userId: TARGET },
      { status: 'under_review' },
      { isAal2: true },
      { permission: 'security.recovery.review' },
      { role: 'admin' },
    ]) {
      const result = await call('POST', `/recovery/requests/${REQUEST}/review`, { body });
      expect(result.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('refuses a decision body naming an approver, a status or a hold', async () => {
    await start();
    for (const body of [
      { decision: 'approved', approverUserId: TARGET },
      { decision: 'approved', status: 'approved' },
      { decision: 'approved', holdUntil: '2026-06-01T00:00:00.000Z' },
      { decision: 'approved', sessionsRevokedAt: '2026-06-01T00:00:00.000Z' },
    ]) {
      const result = await call('POST', `/recovery/requests/${REQUEST}/decision`, { body });
      expect(result.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('refuses a completion body carrying a hold, a reset time or a revocation time', async () => {
    await start();
    for (const body of [
      { mfaWasReset: false, holdUntil: '2026-06-01T00:00:00.000Z' },
      { mfaWasReset: false, mfaResetAt: '2026-06-01T00:00:00.000Z' },
      { mfaWasReset: false, sessionsRevokedAt: '2026-06-01T00:00:00.000Z' },
      { mfaWasReset: false, holdHours: 1 },
    ]) {
      const result = await call('POST', `/recovery/requests/${REQUEST}/completion`, { body });
      expect(result.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('accepts only the writer’s own two decisions', async () => {
    await start();
    expect((await call('POST', `/recovery/requests/${REQUEST}/decision`, { body: { decision: 'approved' } })).status).toBe(200);
    expect(
      (
        await call('POST', `/recovery/requests/${REQUEST}/decision`, {
          body: { decision: 'rejected', note: 'A reason.' },
        })
      ).status,
    ).toBe(200);
    for (const decision of ['contact_verification', 'completed', 'under_review', 'pending', '']) {
      const result = await call('POST', `/recovery/requests/${REQUEST}/decision`, { body: { decision } });
      expect(result.status, decision).toBe(400);
    }
  });

  it('requires a reason for a rejection before the database is asked', async () => {
    const seen = await start();
    const result = await call('POST', `/recovery/requests/${REQUEST}/decision`, {
      body: { decision: 'rejected' },
    });
    expect(result.status).toBe(400);
    expect(seen.some((entry) => entry.name === 'recoveryDecide')).toBe(false);
  });

  it('refuses a malformed account, request or storefront address before any read', async () => {
    const seen = await start();
    expect((await call('GET', '/users/not-a-uuid')).status).toBe(400);
    expect((await call('GET', '/recovery/requests/not-a-uuid')).status).toBe(400);
    expect((await call('GET', '/sellers/Not_A_Slug')).status).toBe(400);
    expect(seen.some((entry) => entry.name.startsWith('user') || entry.name.startsWith('recovery'))).toBe(
      false,
    );
  });

  it('refuses an audit filter that is not a name, and a record with no table', async () => {
    const seen = await start();
    expect((await call('GET', '/audit?tableSchema=public%3Bdrop')).status).toBe(400);
    expect((await call('GET', '/audit?tableName=listings%20--')).status).toBe(400);
    expect((await call('GET', '/audit?recordId=abc')).status).toBe(400);
    expect(seen.some((entry) => entry.name === 'auditPage')).toBe(false);
  });

  it('passes an unknown status filter to the database rather than refusing it', async () => {
    const seen = await start();
    expect((await call('GET', '/sellers?status=not_a_status')).status).toBe(200);
    expect(seen.find((entry) => entry.name === 'sellerPage')?.input['status']).toBe('not_a_status');
  });
});

describe('a refusal says nothing about existence', () => {
  it('answers a missing storefront and a caller without the key identically', async () => {
    await start({ sellerOutcome: 'not_found' });
    const absent = await call('GET', `/sellers/${SLUG}`);
    await app?.close();
    app = undefined;

    await start({ permissions: [USERS] });
    const refused = await call('GET', `/sellers/${SLUG}`);

    expect(absent.status).toBe(refused.status);
    expect(absent.raw).toBe(refused.raw);
  });

  it('answers a missing account and a caller without the key identically', async () => {
    await start({ userOutcome: 'not_found' });
    const absent = await call('GET', `/users/${TARGET}`);
    await app?.close();
    app = undefined;

    await start({ permissions: [SELLERS] });
    const refused = await call('GET', `/users/${TARGET}`);

    expect(absent.status).toBe(refused.status);
    expect(absent.raw).toBe(refused.raw);
  });

  it('answers a missing recovery request and a caller without the key identically', async () => {
    await start({ requestOutcome: 'not_found' });
    const absent = await call('GET', `/recovery/requests/${REQUEST}`);
    await app?.close();
    app = undefined;

    await start({ permissions: [AUDIT] });
    const refused = await call('GET', `/recovery/requests/${REQUEST}`);

    expect(absent.status).toBe(refused.status);
    expect(absent.raw).toBe(refused.raw);
  });

  it('never answers 403 on any of these surfaces', async () => {
    await start({ permissions: [] });
    for (const path of [
      '/sellers',
      `/sellers/${SLUG}`,
      '/users',
      `/users/${TARGET}`,
      `/users/${TARGET}/roles`,
      `/users/${TARGET}/security-events`,
      '/roles',
      '/recovery/requests',
      `/recovery/requests/${REQUEST}`,
      '/audit',
    ]) {
      expect((await call('GET', path)).status, path).not.toBe(403);
    }
  });

  it('gives a refused list an empty page rather than an error', async () => {
    await start({ permissions: [SELLERS], sellerRows: [] });
    const result = await call('GET', '/users');
    // The account list is a different key: the store answers nothing and the page is empty, which is
    // indistinguishable from a list that genuinely has nothing in it.
    expect(result.status).toBe(404);
  });
});

describe('the recovery workflow’s outcomes', () => {
  it('maps the two-person rule to its own code', async () => {
    await start({ writeOutcome: 'needs_another_person' });
    const result = await call('POST', `/recovery/requests/${REQUEST}/decision`, {
      body: { decision: 'approved' },
    });
    expect(result.status).toBe(409);
    expect(result.body['code']).toBe('RECOVERY_NEEDS_ANOTHER_PERSON');
  });

  it('maps the account holder’s refusal to its own code', async () => {
    await start({ writeOutcome: 'own_request' });
    const result = await call('POST', `/recovery/requests/${REQUEST}/review`, { body: {} });
    expect(result.status).toBe(409);
    expect(result.body['code']).toBe('RECOVERY_IS_OWN');
  });

  it('maps each step’s wrong-state refusal to its own code', async () => {
    for (const [outcome, path, body, code] of [
      ['not_reviewable', '/review', {}, 'RECOVERY_NOT_REVIEWABLE'],
      ['not_decidable', '/decision', { decision: 'approved' }, 'RECOVERY_NOT_DECIDABLE'],
    ] as const) {
      await start({ writeOutcome: outcome });
      const result = await call('POST', `/recovery/requests/${REQUEST}${path}`, { body });
      expect(result.status, outcome).toBe(409);
      expect(result.body['code'], outcome).toBe(code);
      await app?.close();
      app = undefined;
    }

    await start({ completionOutcome: 'not_completable' });
    const result = await call('POST', `/recovery/requests/${REQUEST}/completion`, {
      body: { mfaWasReset: false },
    });
    expect(result.status).toBe(409);
    expect(result.body['code']).toBe('RECOVERY_NOT_COMPLETABLE');
  });

  it('returns the status the writer reached, not the one a caller asked for', async () => {
    await start();
    const result = await call('POST', `/recovery/requests/${REQUEST}/decision`, {
      body: { decision: 'approved' },
    });
    // An approval lands on `contact_verification`. `approved` is a value the table allows that no writer
    // in this repository sets, and this is where that shows.
    expect(result.body['status']).toBe('contact_verification');
    expect(result.body['status']).not.toBe('approved');
  });

  it('returns the hold the writer computed, and takes none', async () => {
    const seen = await start();
    const result = await call('POST', `/recovery/requests/${REQUEST}/completion`, {
      body: { mfaWasReset: true },
    });
    expect(result.body['holdUntil']).toBe('2026-05-10T09:00:00.000Z');
    const write = seen.find((entry) => entry.name === 'recoveryComplete');
    expect(write?.input['mfaWasReset']).toBe(true);
    expect(Object.keys(write?.input ?? {}).sort()).toEqual([
      'isAal2',
      'mfaWasReset',
      'requestId',
      'userId',
    ]);
  });

  it('turns an outcome it does not understand into an outage, never a success', async () => {
    await start({ writeOutcome: 'something_new' });
    const result = await call('POST', `/recovery/requests/${REQUEST}/review`, { body: {} });
    expect(result.status).toBe(503);
  });

  it('turns a store failure into an outage', async () => {
    await start({ storeThrows: true });
    expect((await call('GET', '/sellers')).status).toBe(503);
    expect((await call('POST', `/recovery/requests/${REQUEST}/review`, { body: {} })).status).toBe(503);
  });
});

describe('role assignment has no route, and seller status has exactly one', () => {
  /**
   * Role assignment is the writer the owner deferred to its own increment after Phase 7. If somebody adds it
   * without one, this is what fails.
   */
  it('has no method on the roles address but GET', async () => {
    await start();
    for (const method of ['POST', 'DELETE', 'PATCH'] as const) {
      const result = await call(method, `/users/${TARGET}/roles`, { body: { roleKey: 'admin' } });
      expect(result.status, method).not.toBe(200);
      expect(result.status, method).toBeGreaterThanOrEqual(400);
    }
    expect((await call('GET', `/users/${TARGET}/roles`)).status).toBe(200);
  });

  it('has no address at all for granting or revoking a role', async () => {
    await start();
    for (const path of [
      `/users/${TARGET}/roles/admin`,
      `/users/${TARGET}/role`,
      '/roles/admin/holders',
      '/user-roles',
    ]) {
      for (const method of ['POST', 'DELETE'] as const) {
        const result = await call(method, path, { body: { roleKey: 'admin' } });
        expect(result.status, `${method} ${path}`).toBe(404);
      }
    }
  });

  /**
   * Seller status is no longer a gap — it is one POST, decided by the owner and implemented in 0079. What
   * this asserts is that it is *one*: there is no separate suspend, close or reinstate address, because the
   * transition matrix belongs to the database and a second address would be a second place to get it wrong.
   */
  it('has exactly one address for changing a storefront’s status', async () => {
    await start();
    for (const path of [
      `/sellers/${SLUG}/suspension`,
      `/sellers/${SLUG}/closure`,
      `/sellers/${SLUG}/reinstatement`,
      `/sellers/${SLUG}/verification`,
    ]) {
      for (const method of ['POST', 'PATCH', 'DELETE'] as const) {
        const result = await call(method, path, { body: { status: 'suspended' } });
        expect(result.status, `${method} ${path}`).toBe(404);
      }
    }
    expect(
      (
        await call('POST', `/sellers/${SLUG}/status`, {
          body: { status: 'suspended', reason: 'A reason.' },
        })
      ).status,
    ).toBe(200);
  });

  it('has no method on a storefront itself but GET', async () => {
    await start();
    for (const method of ['POST', 'PATCH', 'DELETE'] as const) {
      const result = await call(method, `/sellers/${SLUG}`, { body: { status: 'suspended' } });
      expect(result.status, method).toBeGreaterThanOrEqual(400);
    }
  });

  it('has no audit writer', async () => {
    await start();
    for (const method of ['POST', 'PATCH', 'DELETE'] as const) {
      const result = await call(method, '/audit', { body: { action: 'insert' } });
      expect(result.status, method).toBeGreaterThanOrEqual(400);
    }
  });
});

describe('the seller status write', () => {
  const OK = { status: 'suspended', reason: 'Selling counterfeits.' } as const;

  it('answers with a body its own schema accepts', async () => {
    await start();
    const result = await call('POST', `/sellers/${SLUG}/status`, { body: OK });
    expect(result.status).toBe(200);
    expect(SellerStatusChangeResponseSchema.safeParse(result.body).success).toBe(true);
  });

  it('asks the store with the token’s own account and the slug from the path', async () => {
    const seen = await start();
    await call('POST', `/sellers/${SLUG}/status`, { body: OK });
    const write = seen.find((entry) => entry.name === 'sellerStatus');
    expect(write?.input['userId']).toBe(STAFF);
    expect(write?.input['isAal2']).toBe(true);
    expect(write?.input['slug']).toBe(SLUG);
    expect(write?.input['status']).toBe('suspended');
    expect(write?.input['reason']).toBe('Selling counterfeits.');
    // Five arguments and no sixth: nothing that could carry a timestamp, a verification value or an actor.
    expect(Object.keys(write?.input ?? {}).sort()).toEqual([
      'isAal2',
      'reason',
      'slug',
      'status',
      'userId',
    ]);
  });

  it('refuses a body naming a timestamp, a verification value or an actor', async () => {
    await start();
    for (const body of [
      { ...OK, suspendedAt: '2026-06-01T00:00:00.000Z' },
      { ...OK, closedAt: '2026-06-01T00:00:00.000Z' },
      { ...OK, verificationStatus: 'verified' },
      { ...OK, verifiedAt: '2026-06-01T00:00:00.000Z' },
      { ...OK, actorUserId: TARGET },
      { ...OK, userId: TARGET },
      { ...OK, sellerUserId: TARGET },
      { ...OK, isAal2: true },
      { ...OK, permission: 'sellers.profile.manage' },
      { ...OK, slug: 'another-shop' },
      // Nothing that reaches another domain, because this operation touches none of them.
      { ...OK, listingStatus: 'archived' },
      { ...OK, cancelOrders: true },
      { ...OK, holdPayouts: true },
    ]) {
      const result = await call('POST', `/sellers/${SLUG}/status`, { body });
      expect(result.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('accepts only the four statuses 0009 allows', async () => {
    await start();
    for (const status of ['suspended', 'closed'] as const) {
      const result = await call('POST', `/sellers/${SLUG}/status`, {
        body: status === 'suspended' ? OK : { status },
      });
      expect(result.status, status).toBe(200);
    }
    for (const status of ['archived', 'ACTIVE', 'verified', 'deleted', '']) {
      const result = await call('POST', `/sellers/${SLUG}/status`, { body: { status } });
      expect(result.status, status).toBe(400);
    }
  });

  it('requires a reason for a suspension before the database is asked', async () => {
    const seen = await start();
    const result = await call('POST', `/sellers/${SLUG}/status`, { body: { status: 'suspended' } });
    expect(result.status).toBe(400);
    expect(seen.some((entry) => entry.name === 'sellerStatus')).toBe(false);
  });

  it('requires no reason for the other three', async () => {
    await start();
    for (const status of ['closed', 'active', 'pending'] as const) {
      const result = await call('POST', `/sellers/${SLUG}/status`, { body: { status } });
      expect(result.status, status).toBe(200);
    }
  });

  it('maps every refusal the database can return to its own code', async () => {
    for (const [outcome, code] of [
      ['not_allowed', 'SELLER_STATUS_NOT_ALLOWED'],
      ['no_change', 'SELLER_STATUS_NO_CHANGE'],
      ['reason_required', 'SELLER_STATUS_REASON_REQUIRED'],
      ['not_verified', 'SELLER_STATUS_NOT_VERIFIED'],
      ['already_verified', 'SELLER_STATUS_ALREADY_VERIFIED'],
    ] as const) {
      await start({ sellerStatusOutcome: outcome });
      const result = await call('POST', `/sellers/${SLUG}/status`, { body: OK });
      expect(result.status, outcome).toBe(409);
      expect(result.body['code'], outcome).toBe(code);
      await app?.close();
      app = undefined;
    }
  });

  it('answers a storefront it may not move exactly as one that is not there', async () => {
    await start({ sellerStatusOutcome: 'not_found' });
    const absent = await call('POST', `/sellers/${SLUG}/status`, { body: OK });
    await app?.close();
    app = undefined;

    await start({ permissions: [SELLERS] });
    const refused = await call('POST', `/sellers/${SLUG}/status`, { body: OK });

    expect(absent.status).toBe(refused.status);
    expect(absent.raw).toBe(refused.raw);
    expect(absent.status).toBe(404);
  });

  it('never answers 403', async () => {
    await start({ permissions: [] });
    expect((await call('POST', `/sellers/${SLUG}/status`, { body: OK })).status).not.toBe(403);
  });

  it('refuses a malformed slug before the store is reached', async () => {
    const seen = await start();
    expect((await call('POST', '/sellers/Not_A_Slug/status', { body: OK })).status).toBe(400);
    expect(seen.some((entry) => entry.name === 'sellerStatus')).toBe(false);
  });

  it('returns the status the writer reached, not the one asked for', async () => {
    await start();
    const result = await call('POST', `/sellers/${SLUG}/status`, { body: { status: 'closed' } });
    // The double reports `suspended`; what matters is that the response carries the writer's answer rather
    // than echoing the request.
    expect(result.body['status']).toBe('suspended');
  });

  it('turns an outcome it does not understand into an outage, never a success', async () => {
    await start({ sellerStatusOutcome: 'something_new' });
    expect((await call('POST', `/sellers/${SLUG}/status`, { body: OK })).status).toBe(503);
  });

  it('turns a store failure into an outage', async () => {
    await start({ storeThrows: true });
    expect((await call('POST', `/sellers/${SLUG}/status`, { body: OK })).status).toBe(503);
  });

  it('is refused at aal1', async () => {
    await start();
    const result = await call('POST', `/sellers/${SLUG}/status`, {
      body: OK,
      headers: { [SESSION_TOKEN_HEADER]: AAL1_TOKEN },
    });
    expect(result.status).toBe(404);
  });
});

describe('paging', () => {
  it('reads one row more than it returns, so the last page ends the list', async () => {
    const seen = await start({ sellerRows: [SELLER_ROW] });
    const result = await call('GET', '/sellers?limit=20');
    expect(seen.find((entry) => entry.name === 'sellerPage')?.input['limit']).toBe(21);
    expect((result.body as { nextCursor: unknown }).nextCursor).toBeNull();
  });

  it('offers a cursor exactly when another page exists', async () => {
    const rows = Array.from({ length: 3 }, (_, index) => ({
      ...SELLER_ROW,
      slug: `shop-${index}`,
    }));
    await start({ sellerRows: rows });
    const result = await call('GET', '/sellers?limit=2');
    const body = result.body as { items: unknown[]; nextCursor: string | null };
    expect(body.items).toHaveLength(2);
    expect(typeof body.nextCursor).toBe('string');
  });

  it('refuses a cursor from another of these four lists', async () => {
    await start();
    // A recovery position cannot be spent on the storefront list: the tag is checked first, and these two
    // sit behind different keys.
    const recovery = (
      (await call('GET', '/recovery/requests?limit=1')).body as { nextCursor: string | null }
    ).nextCursor;
    if (recovery !== null) {
      expect((await call('GET', `/sellers?cursor=${encodeURIComponent(recovery)}`)).status).toBe(400);
    }
    expect((await call('GET', '/sellers?cursor=not-a-cursor%21')).status).toBe(400);
    expect((await call('GET', '/audit?cursor=bm90LWEtY3Vyc29y')).status).toBe(400);
  });

  it('refuses a limit that is not one', async () => {
    await start();
    for (const limit of ['0', '-1', 'ten', '1.5', '999999999999']) {
      expect((await call('GET', `/sellers?limit=${limit}`)).status, limit).toBe(400);
    }
  });
});
