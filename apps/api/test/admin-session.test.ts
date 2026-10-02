import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { SESSION_TOKEN_HEADER } from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { STAFF_CONSOLE_STORE, type StaffConsoleRow } from '../src/admin/staff-console.service.js';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { AuthenticationRequiredError } from '../src/auth/auth-errors.js';
import { SUPABASE_AUTH_CLIENT } from '../src/auth/login.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * The staff console session at the API boundary (Phase 7-F).
 *
 * The assertions that matter are about authority:
 *
 *   * **the order of the hops** — the provider validates the token before a single claim is read, and
 *     before the database is asked anything;
 *   * **the assurance level comes from the token, not from the request** — a header, a query string or
 *     a body claiming `aal2` changes nothing, and is not even accepted;
 *   * **the permission set is already filtered** — staff at aal1 receive an empty array, and the route
 *     never returns an unfiltered set beside a flag;
 *   * **nothing is granted** — no write of any kind is reachable from this controller;
 *   * **a person who is not staff is answered neutrally**, with the same shape and empty sets.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '99999999-9999-4999-8999-999999999999';

function token(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.c2lnbmF0dXJl`;
}

const AAL2_TOKEN = token({ sub: USER, aal: 'aal2' });
const AAL1_TOKEN = token({ sub: USER, aal: 'aal1' });
const NO_CLAIM_TOKEN = token({ sub: USER });

const ADMIN_PERMISSIONS = [
  'audit.read',
  'catalog.listing.read',
  'moderation.report.read',
  'platform.job.read',
  'security.recovery.review',
  'sellers.profile.read',
  'support.ticket.read',
  'users.role.manage',
];

interface Recorded {
  readonly calls: string[];
  readonly access: Array<{ userId: string; isAal2: boolean }>;
}

interface Doubles {
  readonly row?: StaffConsoleRow;
  readonly profile?: { id: string; displayName: string | null; localeCode: string | null } | null;
  readonly tokenFails?: boolean;
  readonly storeThrows?: boolean;
}

function staffRow(overrides: Partial<StaffConsoleRow> = {}): StaffConsoleRow {
  return {
    hasConsoleRole: true,
    requiresStepUp: false,
    roles: ['admin'],
    permissions: ADMIN_PERMISSIONS,
    ...overrides,
  };
}

let app: NestFastifyApplication | undefined;

async function start(doubles: Doubles = {}): Promise<Recorded> {
  const recorded: Recorded = { calls: [], access: [] };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(TEST_ENV)] })
    .overrideProvider(SUPABASE_AUTH_CLIENT)
    .useValue({
      getUser: async () => {
        recorded.calls.push('get-user');
        if (doubles.tokenFails === true) throw new AuthenticationRequiredError();
        return { id: USER, phone: null };
      },
    })
    .overrideProvider(STAFF_CONSOLE_STORE)
    .useValue({
      staffConsoleAccess: async (input: { userId: string; isAal2: boolean }) => {
        recorded.calls.push('console-access');
        recorded.access.push(input);
        if (doubles.storeThrows === true) throw new Error('database unavailable');
        return doubles.row ?? staffRow();
      },
      buyerProfile: async (userId: string) => {
        recorded.calls.push('profile');
        if (doubles.storeThrows === true) throw new Error('database unavailable');
        return doubles.profile === undefined
          ? { id: userId, displayName: 'Nadia', localeCode: 'en' }
          : doubles.profile;
      },
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
  accessToken: string | null = AAL2_TOKEN,
  extraHeaders: Record<string, string> = {},
  url = '/v1/admin/session',
): Promise<Result> {
  const headers: Record<string, string> = {
    [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL,
    ...extraHeaders,
  };
  if (accessToken !== null) headers[SESSION_TOKEN_HEADER] = accessToken;
  const response = await app!.inject({ method: 'GET', url, headers });
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

const session = (result: Result) => result.body['session'] as Record<string, unknown>;

/* ------------------------------------------------------------------------------------------------ */

describe('GET /v1/admin/session', () => {
  it('answers the three questions the shell asks, and nothing more', async () => {
    await start();
    const result = await call();

    expect(result.status).toBe(200);
    expect(Object.keys(result.body)).toEqual(['session']);
    expect(Object.keys(session(result)).sort()).toEqual([
      'displayName',
      'id',
      'isStaff',
      'localeCode',
      'permissions',
      'requiresStepUp',
      'roles',
    ]);
  });

  it('validates the token before reading a claim or asking the database', async () => {
    const recorded = await start({ tokenFails: true });
    const result = await call();

    expect(result.status).toBe(401);
    // The provider refused, so nothing downstream happened at all.
    expect(recorded.calls).toEqual(['get-user']);
    expect(recorded.access).toEqual([]);
  });

  it('asks the database in that order once the provider has vouched for the token', async () => {
    const recorded = await start();
    await call();
    expect(recorded.calls[0]).toBe('get-user');
    expect(recorded.calls.slice(1).sort()).toEqual(['console-access', 'profile']);
  });

  it('refuses a request with no session at all, before any call', async () => {
    const recorded = await start();
    const result = await call(null);

    expect(result.status).toBe(401);
    expect(result.body['code']).toBe('AUTHENTICATION_REQUIRED');
    expect(recorded.calls).toEqual([]);
  });

  it('refuses a request with no internal credential', async () => {
    const recorded = await start();
    const response = await app!.inject({
      method: 'GET',
      url: '/v1/admin/session',
      headers: { [SESSION_TOKEN_HEADER]: AAL2_TOKEN },
    });
    expect(response.statusCode).toBe(403);
    expect(recorded.calls).toEqual([]);
  });
});

describe('the assurance level', () => {
  it('comes from the token the provider validated', async () => {
    const recorded = await start();
    await call(AAL2_TOKEN);
    expect(recorded.access[0]).toEqual({ userId: USER, isAal2: true });
  });

  it('is false for an aal1 token', async () => {
    const recorded = await start({ row: staffRow({ requiresStepUp: true, roles: [], permissions: [] }) });
    await call(AAL1_TOKEN);
    expect(recorded.access[0]).toEqual({ userId: USER, isAal2: false });
  });

  it('is false for a token that claims nothing', async () => {
    const recorded = await start({ row: staffRow({ requiresStepUp: true, roles: [], permissions: [] }) });
    await call(NO_CLAIM_TOKEN);
    expect(recorded.access[0]?.isAal2).toBe(false);
  });

  it.each([
    ['x-aal', 'aal2'],
    ['x-assurance-level', 'aal2'],
    ['x-mfa', 'true'],
    ['authorization', 'Bearer aal2'],
  ])('cannot be asserted by the %s header', async (name, value) => {
    const recorded = await start({ row: staffRow({ requiresStepUp: true, roles: [], permissions: [] }) });
    const result = await call(AAL1_TOKEN, { [name]: value });

    expect(result.status).toBe(200);
    expect(recorded.access[0]?.isAal2).toBe(false);
    expect(session(result)['permissions']).toEqual([]);
  });

  it('cannot be asserted by a query string', async () => {
    const recorded = await start({ row: staffRow({ requiresStepUp: true, roles: [], permissions: [] }) });
    const result = await call(AAL1_TOKEN, {}, '/v1/admin/session?aal=aal2&isAal2=true&permissions=users.role.manage');

    expect(result.status).toBe(200);
    expect(recorded.access[0]?.isAal2).toBe(false);
    expect(session(result)['permissions']).toEqual([]);
  });

  it('cannot be asserted by editing the token body, because the provider validates it first', async () => {
    // A token the provider refuses never reaches the claim reader, however it is written.
    const recorded = await start({ tokenFails: true });
    const forged = token({ sub: OTHER_USER, aal: 'aal2', role: 'super_admin' });
    const result = await call(forged);

    expect(result.status).toBe(401);
    expect(recorded.access).toEqual([]);
  });

  it('names the account the provider named, never the one the token body names', async () => {
    const recorded = await start();
    await call(token({ sub: OTHER_USER, aal: 'aal2' }));
    expect(recorded.access[0]?.userId).toBe(USER);
  });
});

describe('what a staff member receives', () => {
  it('gets their effective permissions at aal2', async () => {
    await start();
    const result = await call(AAL2_TOKEN);

    expect(session(result)['isStaff']).toBe(true);
    expect(session(result)['requiresStepUp']).toBe(false);
    expect(session(result)['roles']).toEqual(['admin']);
    expect(session(result)['permissions']).toEqual(ADMIN_PERMISSIONS);
  });

  it('gets nothing at aal1, and is told a step-up is what is missing', async () => {
    await start({ row: staffRow({ requiresStepUp: true, roles: [], permissions: [] }) });
    const result = await call(AAL1_TOKEN);

    expect(result.status).toBe(200);
    expect(session(result)['isStaff']).toBe(true);
    expect(session(result)['requiresStepUp']).toBe(true);
    expect(session(result)['permissions']).toEqual([]);
    expect(session(result)['roles']).toEqual([]);
  });

  it('never receives an unfiltered set beside a flag', async () => {
    // The only permissions field is the effective one; there is nowhere for a raw set to travel.
    await start({ row: staffRow({ requiresStepUp: true, roles: [], permissions: [] }) });
    const result = await call(AAL1_TOKEN);
    expect(result.raw).not.toContain('users.role.manage');
    expect(result.raw).not.toContain('allPermissions');
  });

  it('reports only roles the contract names', async () => {
    await start({ row: staffRow({ roles: ['admin', 'buyer', 'something_new'] }) });
    const result = await call();
    expect(session(result)['roles']).toEqual(['admin']);
  });
});

describe('what everybody else receives', () => {
  it('answers a buyer neutrally, with the same shape and empty sets', async () => {
    await start({ row: { hasConsoleRole: false, requiresStepUp: false, roles: ['buyer'], permissions: [] } });
    const result = await call(AAL2_TOKEN);

    expect(result.status).toBe(200);
    expect(session(result)['isStaff']).toBe(false);
    expect(session(result)['requiresStepUp']).toBe(false);
    expect(session(result)['permissions']).toEqual([]);
    expect(session(result)['roles']).toEqual([]);
  });

  it('never tells somebody who is not staff to step up', async () => {
    await start({ row: { hasConsoleRole: false, requiresStepUp: false, roles: [], permissions: [] } });
    const result = await call(AAL1_TOKEN);
    expect(session(result)['requiresStepUp']).toBe(false);
  });

  it('treats a deleted profile as no usable session', async () => {
    await start({ profile: null });
    const result = await call();
    expect(result.status).toBe(401);
  });

  it('answers 503 rather than an empty permission set when the database cannot be reached', async () => {
    await start({ storeThrows: true });
    const result = await call();

    expect(result.status).toBe(503);
    expect(result.body['code']).toBe('SERVICE_UNAVAILABLE');
    expect(result.raw).not.toContain('database unavailable');
  });
});

describe('what the route cannot do', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)('does not answer %s', async (method) => {
    await start();
    const response = await app!.inject({
      method,
      url: '/v1/admin/session',
      headers: {
        'content-type': 'application/json',
        [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL,
        [SESSION_TOKEN_HEADER]: AAL2_TOKEN,
      },
      payload: JSON.stringify({ roles: ['super_admin'], permissions: ['users.role.manage'] }),
    });
    expect(response.statusCode).toBe(404);
  });

  it('exposes no other admin route', async () => {
    await start();
    for (const url of ['/v1/admin', '/v1/admin/permissions', '/v1/admin/roles', '/v1/admin/users']) {
      const result = await call(AAL2_TOKEN, {}, url);
      expect(result.status, url).toBe(404);
    }
  });

  it('leaks no token and no credential into its answer', async () => {
    await start();
    const result = await call();
    expect(result.raw).not.toContain(AAL2_TOKEN);
    expect(result.raw).not.toContain(TEST_INTERNAL_CREDENTIAL);
    expect(result.raw).not.toContain('aal');
  });
});
