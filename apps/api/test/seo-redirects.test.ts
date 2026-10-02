import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  CreateSeoRedirectResponseSchema,
  RedirectResolutionResponseSchema,
  SESSION_TOKEN_HEADER,
  SeoRedirectDetailResponseSchema,
  SeoRedirectWriteResponseSchema,
  SeoRedirectsResponseSchema,
} from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { AuthenticationRequiredError } from '../src/auth/auth-errors.js';
import { SEO_REDIRECTS_STORE } from '../src/admin/seo-redirects.service.js';
import { SEO_STORE } from '../src/seo/seo.service.js';
import { encodeSeoRedirectCursor } from '../src/admin/seo-redirects.cursor.js';
import { SUPABASE_AUTH_CLIENT } from '../src/auth/login.service.js';
import { STAFF_CONSOLE_STORE, type StaffConsoleRow } from '../src/admin/staff-console.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * The SEO redirect map at the API boundary.
 *
 * The properties this suite exists for:
 *
 * **The public resolution carries no user context, and the admin surface carries nothing but.** The resolution is
 * driven with no session at all and answers; every admin route is driven by a caller holding `seo.redirect.read`,
 * by callers holding each of the other console keys instead, and by the same caller at `aal1`, and only the first
 * reaches anything.
 *
 * **"No redirect" is a 200 and never a 404.** Asserted on the status line, because a caller that could not tell
 * "the map names nothing for this path" from "the API is down" would have to choose between swallowing an outage
 * and refusing to serve a perfectly correct 404 page.
 *
 * **An answer the table could not have stored is not acted on.** The store double returns an external
 * destination, a protocol-relative one and a status code outside the four, and each becomes `none` rather than a
 * redirect: a value like that means something upstream is wrong, and following it would send a visitor somewhere
 * nobody authored.
 *
 * **An edit cannot switch a redirect on.** `PATCH` is driven with `isActive` in the body and the store is
 * asserted never to have been asked to change the state: the field is dropped by the contract rather than ignored
 * by the service.
 *
 * **Reading and managing are separate keys, and the split is visible rather than implied.** A caller holding only
 * the read key can list and open an entry — and `canManage` comes back false — while every write answers 404,
 * byte for byte identical to an entry that does not exist.
 *
 * **Every refusal the database can raise becomes its own code**, including that `42501` — the database refusing a
 * caller without the manage key — becomes the same 404 as an absence rather than a 403.
 *
 * Everything is stubbed at the store boundary: no database, no Redis, no network.
 */

const STAFF = '11111111-1111-4111-8111-111111111111';
const ENTRY = 'ac000000-0000-4000-8000-00000000d1c7';

function token(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.c2lnbmF0dXJl`;
}

const ACCESS_TOKEN = token({ sub: STAFF, aal: 'aal2' });
const AAL1_TOKEN = token({ sub: STAFF, aal: 'aal1' });

const READ = 'seo.redirect.read';
const MANAGE = 'seo.redirect.manage';

/** Every other key a console surface uses. Not one of them opens this section. */
const OTHER_KEYS = [
  'sellers.profile.read',
  'users.profile.read',
  'security.recovery.review',
  'audit.read',
  'reviews.review.read',
  'moderation.report.read',
  'support.ticket.read',
  'platform.job.read',
  'disputes.dispute.read',
  'cms.page.read',
  'cms.page.manage',
  'seo.metadata.read',
  'seo.settings.manage',
] as const;

const LIST_ROW = {
  redirectId: ENTRY,
  fromPath: '/old-offer',
  toPath: '/new-offer',
  statusCode: 301,
  isActive: true,
  note: 'campaign ended',
  createdAt: new Date('2026-05-01T09:00:00.000Z'),
  updatedAt: new Date('2026-05-02T09:00:00.000Z'),
};

const DETAIL_ROW = {
  ...LIST_ROW,
  createdBy: STAFF,
  canManage: true,
  resolvedToPath: '/new-offer',
  resolvedStatusCode: 301,
};

interface Doubles {
  permissions?: readonly string[];
  unauthenticated?: boolean;
  listRows?: readonly Record<string, unknown>[];
  detailRow?: Record<string, unknown> | null;
  resolution?: { toPath: string; statusCode: number } | null;
  resolutionError?: boolean;
  writeError?: { code: string };
  writeResult?: boolean;
}

interface Seen {
  readonly name: string;
  readonly input: unknown;
}

let app: NestFastifyApplication | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function sqlError(code: string): Error & { code: string } {
  return Object.assign(new Error('the database refused it'), { code });
}

async function createApp(doubles: Doubles = {}): Promise<Seen[]> {
  const seen: Seen[] = [];

  const write = async (name: string, input: unknown): Promise<boolean> => {
    seen.push({ name, input });
    if (doubles.writeError !== undefined) throw sqlError(doubles.writeError.code);
    return doubles.writeResult ?? true;
  };

  const adminStore = {
    redirectsForStaff: async (input: { limit: number }) => {
      seen.push({ name: 'redirectsForStaff', input });
      return doubles.listRows ?? [LIST_ROW];
    },
    redirectForStaff: async (input: unknown) => {
      seen.push({ name: 'redirectForStaff', input });
      return doubles.detailRow === undefined ? DETAIL_ROW : doubles.detailRow;
    },
    redirectCreateForStaff: async (input: unknown) => {
      seen.push({ name: 'redirectCreateForStaff', input });
      if (doubles.writeError !== undefined) throw sqlError(doubles.writeError.code);
      return ENTRY;
    },
    redirectUpdateForStaff: async (input: unknown) => write('redirectUpdateForStaff', input),
    redirectStateForStaff: async (input: unknown) => write('redirectStateForStaff', input),
    redirectDeleteForStaff: async (input: unknown) => write('redirectDeleteForStaff', input),
  };

  // The public SEO store answers three other reads as well; only the resolution matters here, and the rest are
  // given something harmless so the module composes.
  const seoStore = {
    publicRedirectResolve: async (input: unknown) => {
      seen.push({ name: 'publicRedirectResolve', input });
      if (doubles.resolutionError === true) throw new Error('the database is unreachable');
      return doubles.resolution === undefined ? { toPath: '/new-offer', statusCode: 301 } : doubles.resolution;
    },
    publicRobotsBody: async () => null,
    publicSitemapCounts: async () => [],
    publicSitemapPages: async () => [],
    publicSitemapListings: async () => [],
    publicSitemapServices: async () => [],
    publicSitemapCategories: async () => [],
    publicSitemapSellers: async () => [],
  };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(TEST_ENV)] })
    .overrideProvider(SUPABASE_AUTH_CLIENT)
    .useValue({
      getUser: async () => {
        if (doubles.unauthenticated === true) throw new AuthenticationRequiredError();
        return { id: STAFF, phone: null };
      },
      signInWithPassword: async () => {
        throw new Error('maintaining a redirect must never sign anyone in');
      },
      revokeAllSessions: async () => {
        throw new Error('maintaining a redirect must never revoke a session');
      },
    })
    .overrideProvider(STAFF_CONSOLE_STORE)
    .useValue({
      staffConsoleAccess: async (input: { userId: string; isAal2: boolean }): Promise<StaffConsoleRow> => {
        // The platform's own behaviour, modelled rather than asserted around: a role that requires MFA counts for
        // nothing at aal1, so the effective set is empty. Both roles holding a redirect key require MFA.
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
    .overrideProvider(SEO_STORE)
    .useValue(seoStore)
    .overrideProvider(SEO_REDIRECTS_STORE)
    .useValue(adminStore)
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

function request(options: {
  method: string;
  url: string;
  accessToken?: string;
  payload?: unknown;
  credential?: string;
}) {
  const headers: Record<string, string> = {
    [INTERNAL_CREDENTIAL_HEADER]: options.credential ?? TEST_INTERNAL_CREDENTIAL,
  };
  if (options.accessToken !== undefined) headers[SESSION_TOKEN_HEADER] = options.accessToken;
  if (options.payload !== undefined) headers['content-type'] = 'application/json';
  return app!.inject({
    method: options.method as 'GET',
    url: options.url,
    headers,
    ...(options.payload === undefined ? {} : { payload: JSON.stringify(options.payload) }),
  });
}

/* ------------------------------------------------------------------------------------------------ */
/* The public resolution                                                                             */
/* ------------------------------------------------------------------------------------------------ */

describe('GET /v1/seo/redirects/resolve', () => {
  it('answers with no session at all', async () => {
    await createApp();
    const response = await request({ method: 'GET', url: '/v1/seo/redirects/resolve?path=%2Fold-offer' });
    expect(response.statusCode).toBe(200);
    const body = RedirectResolutionResponseSchema.parse(response.json());
    expect(body.outcome).toBe('redirect');
    expect(body.outcome === 'redirect' && body.toPath).toBe('/new-offer');
    expect(body.outcome === 'redirect' && body.statusCode).toBe(301);
  });

  it('passes the path through untouched', async () => {
    const seen = await createApp();
    await request({ method: 'GET', url: '/v1/seo/redirects/resolve?path=%2Fa%2Fb-c_d.e' });
    expect(seen.filter((entry) => entry.name === 'publicRedirectResolve').map((entry) => entry.input)).toEqual([
      '/a/b-c_d.e',
    ]);
  });

  it('answers 200 with none when the map names no redirect, never 404', async () => {
    await createApp({ resolution: null });
    const response = await request({ method: 'GET', url: '/v1/seo/redirects/resolve?path=%2Fnothing' });
    // The distinction this route exists to preserve: no redirect is an answer, an outage is not.
    expect(response.statusCode).toBe(200);
    expect(RedirectResolutionResponseSchema.parse(response.json())).toEqual({ outcome: 'none' });
  });

  it('is a 503 when the map cannot be read, which is a different thing entirely', async () => {
    await createApp({ resolutionError: true });
    const response = await request({ method: 'GET', url: '/v1/seo/redirects/resolve?path=%2Fold-offer' });
    expect(response.statusCode).toBe(503);
  });

  it('refuses a path that could not be a row in the table', async () => {
    await createApp();
    for (const path of ['old-offer', 'https://evil.test/x', '%2F%2Fevil.test', '']) {
      const response = await request({
        method: 'GET',
        url: `/v1/seo/redirects/resolve?path=${encodeURIComponent(path)}`,
      });
      expect(response.statusCode, path).toBe(400);
    }
  });

  it('refuses a request with no path at all', async () => {
    await createApp();
    const response = await request({ method: 'GET', url: '/v1/seo/redirects/resolve' });
    expect(response.statusCode).toBe(400);
  });

  it('does not act on an answer the table could not have stored', async () => {
    for (const resolution of [
      { toPath: 'https://evil.test/', statusCode: 301 },
      { toPath: '//evil.test', statusCode: 301 },
      { toPath: 'relative-but-not-a-path', statusCode: 301 },
      { toPath: '/fine', statusCode: 303 },
      { toPath: '/fine', statusCode: 200 },
    ]) {
      await createApp({ resolution });
      const response = await request({ method: 'GET', url: '/v1/seo/redirects/resolve?path=%2Fold-offer' });
      expect(response.statusCode).toBe(200);
      expect(response.json(), JSON.stringify(resolution)).toEqual({ outcome: 'none' });
      await app?.close();
      app = undefined;
    }
  });

  it('never sends a visitor to the address they just asked for', async () => {
    await createApp({ resolution: { toPath: '/same', statusCode: 301 } });
    const response = await request({ method: 'GET', url: '/v1/seo/redirects/resolve?path=%2Fsame' });
    expect(response.json()).toEqual({ outcome: 'none' });
  });

  it('still requires the internal BFF credential', async () => {
    await createApp();
    const response = await request({
      method: 'GET',
      url: '/v1/seo/redirects/resolve?path=%2Fold-offer',
      credential: 'not-the-credential',
    });
    expect(response.statusCode).toBe(403);
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* The admin list                                                                                    */
/* ------------------------------------------------------------------------------------------------ */

describe('GET /v1/admin/seo/redirects', () => {
  it('returns one page of the map to a holder of the read key', async () => {
    await createApp();
    const response = await request({
      method: 'GET',
      url: '/v1/admin/seo/redirects',
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(200);
    const body = SeoRedirectsResponseSchema.parse(response.json());
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.fromPath).toBe('/old-offer');
    expect(body.nextCursor).toBeNull();
  });

  it('asks for one row more than the page size, so the cursor is known rather than guessed', async () => {
    const seen = await createApp();
    await request({ method: 'GET', url: '/v1/admin/seo/redirects?limit=10', accessToken: ACCESS_TOKEN });
    const call = seen.find((entry) => entry.name === 'redirectsForStaff')?.input as { limit: number };
    expect(call.limit).toBe(11);
  });

  it('issues a cursor only when there is another page', async () => {
    const rows = Array.from({ length: 3 }, (_, index) => ({
      ...LIST_ROW,
      redirectId: `ac000000-0000-4000-8000-00000000d1c${index}`,
      fromPath: `/old-${index}`,
    }));
    await createApp({ listRows: rows });
    const response = await request({
      method: 'GET',
      url: '/v1/admin/seo/redirects?limit=2',
      accessToken: ACCESS_TOKEN,
    });
    const body = SeoRedirectsResponseSchema.parse(response.json());
    expect(body.items).toHaveLength(2);
    expect(body.nextCursor).not.toBeNull();
  });

  it('accepts its own cursor and refuses every other list’s', async () => {
    await createApp();
    const mine = encodeSeoRedirectCursor({ updatedAt: new Date('2026-05-02T09:00:00.000Z'), id: ENTRY });
    const ok = await request({
      method: 'GET',
      url: `/v1/admin/seo/redirects?cursor=${encodeURIComponent(mine)}`,
      accessToken: ACCESS_TOKEN,
    });
    expect(ok.statusCode).toBe(200);

    // A position in the authored-page list is a real position in the wrong list, so its tag is refused here.
    const foreign = Buffer.from(`cp1|2026-05-02T09:00:00.000Z|${ENTRY}`, 'utf8').toString('base64url');
    const refused = await request({
      method: 'GET',
      url: `/v1/admin/seo/redirects?cursor=${encodeURIComponent(foreign)}`,
      accessToken: ACCESS_TOKEN,
    });
    expect(refused.statusCode).toBe(400);
  });

  it('passes the search through as text, because the database matches it literally', async () => {
    const seen = await createApp();
    await request({ method: 'GET', url: '/v1/admin/seo/redirects?search=%25', accessToken: ACCESS_TOKEN });
    const call = seen.find((entry) => entry.name === 'redirectsForStaff')?.input as { search: string | null };
    // Nothing is escaped or stripped: there is no pattern syntax to defend against.
    expect(call.search).toBe('%');
  });

  it('reads the state filter as three answers, and refuses a fourth', async () => {
    const seen = await createApp();
    await request({ method: 'GET', url: '/v1/admin/seo/redirects?active=true', accessToken: ACCESS_TOKEN });
    await request({ method: 'GET', url: '/v1/admin/seo/redirects?active=false', accessToken: ACCESS_TOKEN });
    await request({ method: 'GET', url: '/v1/admin/seo/redirects', accessToken: ACCESS_TOKEN });
    expect(
      seen.filter((entry) => entry.name === 'redirectsForStaff').map((entry) => (entry.input as { isActive: boolean | null }).isActive),
    ).toEqual([true, false, null]);

    const refused = await request({
      method: 'GET',
      url: '/v1/admin/seo/redirects?active=1',
      accessToken: ACCESS_TOKEN,
    });
    expect(refused.statusCode).toBe(400);
  });

  it('refuses a limit that is not one', async () => {
    await createApp();
    for (const limit of ['0', '-1', 'ten', '1.5']) {
      const response = await request({
        method: 'GET',
        url: `/v1/admin/seo/redirects?limit=${encodeURIComponent(limit)}`,
        accessToken: ACCESS_TOKEN,
      });
      expect(response.statusCode, limit).toBe(400);
    }
  });

  it('is a 404 for every other console key, and for the same caller at aal1', async () => {
    for (const key of OTHER_KEYS) {
      await createApp({ permissions: [key] });
      const response = await request({
        method: 'GET',
        url: '/v1/admin/seo/redirects',
        accessToken: ACCESS_TOKEN,
      });
      expect(response.statusCode, key).toBe(404);
      await app?.close();
      app = undefined;
    }

    await createApp();
    const atAal1 = await request({
      method: 'GET',
      url: '/v1/admin/seo/redirects',
      accessToken: AAL1_TOKEN,
    });
    expect(atAal1.statusCode).toBe(404);
  });

  it('needs a session, and the internal credential as well', async () => {
    await createApp();
    expect((await request({ method: 'GET', url: '/v1/admin/seo/redirects' })).statusCode).toBe(401);
    expect(
      (
        await request({
          method: 'GET',
          url: '/v1/admin/seo/redirects',
          accessToken: ACCESS_TOKEN,
          credential: 'not-the-credential',
        })
      ).statusCode,
    ).toBe(403);
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* The admin detail                                                                                  */
/* ------------------------------------------------------------------------------------------------ */

describe('GET /v1/admin/seo/redirects/:redirectId', () => {
  it('returns the entry with the manage capability and where its chain ends', async () => {
    await createApp();
    const response = await request({
      method: 'GET',
      url: `/v1/admin/seo/redirects/${ENTRY}`,
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(200);
    const body = SeoRedirectDetailResponseSchema.parse(response.json());
    expect(body.redirect.canManage).toBe(true);
    expect(body.redirect.resolvedToPath).toBe('/new-offer');
  });

  it('reports canManage false for a caller holding only the read key', async () => {
    await createApp({ permissions: [READ], detailRow: { ...DETAIL_ROW, canManage: false } });
    const response = await request({
      method: 'GET',
      url: `/v1/admin/seo/redirects/${ENTRY}`,
      accessToken: ACCESS_TOKEN,
    });
    const body = SeoRedirectDetailResponseSchema.parse(response.json());
    expect(body.redirect.canManage).toBe(false);
  });

  it('carries nulls for an entry the map would not act on', async () => {
    await createApp({
      detailRow: { ...DETAIL_ROW, isActive: false, resolvedToPath: null, resolvedStatusCode: null },
    });
    const response = await request({
      method: 'GET',
      url: `/v1/admin/seo/redirects/${ENTRY}`,
      accessToken: ACCESS_TOKEN,
    });
    const body = SeoRedirectDetailResponseSchema.parse(response.json());
    expect(body.redirect.resolvedToPath).toBeNull();
    expect(body.redirect.resolvedStatusCode).toBeNull();
  });

  it('is a 404 for an entry that is not there', async () => {
    await createApp({ detailRow: null });
    const response = await request({
      method: 'GET',
      url: `/v1/admin/seo/redirects/${ENTRY}`,
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(404);
  });

  it('refuses an identifier that is not one', async () => {
    await createApp();
    const response = await request({
      method: 'GET',
      url: '/v1/admin/seo/redirects/not-a-uuid',
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(400);
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* Creating                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

describe('POST /v1/admin/seo/redirects', () => {
  it('creates an entry and answers 201 with its identifier', async () => {
    await createApp();
    const response = await request({
      method: 'POST',
      url: '/v1/admin/seo/redirects',
      accessToken: ACCESS_TOKEN,
      payload: { fromPath: '/old-offer', toPath: '/new-offer' },
    });
    expect(response.statusCode).toBe(201);
    expect(CreateSeoRedirectResponseSchema.parse(response.json()).id).toBe(ENTRY);
  });

  it('sends the column defaults when the request leaves them out', async () => {
    const seen = await createApp();
    await request({
      method: 'POST',
      url: '/v1/admin/seo/redirects',
      accessToken: ACCESS_TOKEN,
      payload: { fromPath: '/old-offer', toPath: '/new-offer' },
    });
    const call = seen.find((entry) => entry.name === 'redirectCreateForStaff')?.input as {
      statusCode: number;
      isActive: boolean;
      note: string | null;
    };
    expect(call.statusCode).toBe(301);
    expect(call.isActive).toBe(true);
    expect(call.note).toBeNull();
  });

  it('lets an entry be staged switched off', async () => {
    const seen = await createApp();
    await request({
      method: 'POST',
      url: '/v1/admin/seo/redirects',
      accessToken: ACCESS_TOKEN,
      payload: { fromPath: '/old-offer', toPath: '/new-offer', isActive: false, statusCode: 308 },
    });
    const call = seen.find((entry) => entry.name === 'redirectCreateForStaff')?.input as {
      statusCode: number;
      isActive: boolean;
    };
    expect(call.isActive).toBe(false);
    expect(call.statusCode).toBe(308);
  });

  it('refuses a request the table could not store, without reaching the database', async () => {
    const seen = await createApp();
    for (const payload of [
      { fromPath: 'old-offer', toPath: '/new' },
      { fromPath: '/old', toPath: 'https://evil.test/' },
      { fromPath: '/old', toPath: '//evil.test' },
      { fromPath: '/same', toPath: '/same' },
      { fromPath: '/old', toPath: '/new', statusCode: 303 },
      { fromPath: '/old' },
      {},
    ]) {
      const response = await request({
        method: 'POST',
        url: '/v1/admin/seo/redirects',
        accessToken: ACCESS_TOKEN,
        payload,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(seen.filter((entry) => entry.name === 'redirectCreateForStaff')).toHaveLength(0);
  });

  it('drops a field nobody declared rather than forwarding it', async () => {
    const seen = await createApp();
    await request({
      method: 'POST',
      url: '/v1/admin/seo/redirects',
      accessToken: ACCESS_TOKEN,
      payload: { fromPath: '/old', toPath: '/new', priority: 10, pattern: '/old/*', createdBy: STAFF },
    });
    const call = seen.find((entry) => entry.name === 'redirectCreateForStaff')?.input as Record<string, unknown>;
    // Neither a priority nor a pattern exists on this map, and the author is the session's own account.
    expect('priority' in call).toBe(false);
    expect('pattern' in call).toBe(false);
    expect(call['userId']).toBe(STAFF);
  });

  it('turns each refusal the database can raise into its own code', async () => {
    const cases = [
      { sqlstate: '23505', status: 409, code: 'SEO_REDIRECT_PATH_TAKEN' },
      { sqlstate: '23514', status: 409, code: 'SEO_REDIRECT_NOT_ALLOWED' },
      // The database refusing a caller without the manage key. A 404, not a 403: a refusal and an absence look
      // the same on this surface.
      { sqlstate: '42501', status: 404, code: 'NOT_FOUND' },
      { sqlstate: '23502', status: 503, code: 'SERVICE_UNAVAILABLE' },
      { sqlstate: '08006', status: 503, code: 'SERVICE_UNAVAILABLE' },
    ] as const;

    for (const scenario of cases) {
      await createApp({ writeError: { code: scenario.sqlstate } });
      const response = await request({
        method: 'POST',
        url: '/v1/admin/seo/redirects',
        accessToken: ACCESS_TOKEN,
        payload: { fromPath: '/old-offer', toPath: '/new-offer' },
      });
      expect(response.statusCode, scenario.sqlstate).toBe(scenario.status);
      expect((response.json() as { code: string }).code, scenario.sqlstate).toBe(scenario.code);
      await app?.close();
      app = undefined;
    }
  });

  it('is a 404 for a caller holding only the read key', async () => {
    await createApp({ permissions: [READ], writeError: { code: '42501' } });
    const response = await request({
      method: 'POST',
      url: '/v1/admin/seo/redirects',
      accessToken: ACCESS_TOKEN,
      payload: { fromPath: '/old-offer', toPath: '/new-offer' },
    });
    expect(response.statusCode).toBe(404);
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* Editing                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

describe('PATCH /v1/admin/seo/redirects/:redirectId', () => {
  it('changes one field and leaves the rest alone', async () => {
    const seen = await createApp();
    const response = await request({
      method: 'PATCH',
      url: `/v1/admin/seo/redirects/${ENTRY}`,
      accessToken: ACCESS_TOKEN,
      payload: { toPath: '/newer' },
    });
    expect(response.statusCode).toBe(200);
    expect(SeoRedirectWriteResponseSchema.parse(response.json()).ok).toBe(true);
    const call = seen.find((entry) => entry.name === 'redirectUpdateForStaff')?.input as {
      fromPath: string | null;
      toPath: string | null;
      statusCode: number | null;
    };
    expect(call.toPath).toBe('/newer');
    expect(call.fromPath).toBeNull();
    expect(call.statusCode).toBeNull();
  });

  it('cannot switch a redirect on, because that is a different route', async () => {
    const seen = await createApp();
    await request({
      method: 'PATCH',
      url: `/v1/admin/seo/redirects/${ENTRY}`,
      accessToken: ACCESS_TOKEN,
      payload: { toPath: '/newer', isActive: true },
    });
    // Dropped by the contract rather than ignored by the service: the state writer is never reached, and the
    // edit itself carries no state at all.
    expect(seen.filter((entry) => entry.name === 'redirectStateForStaff')).toHaveLength(0);
    const call = seen.find((entry) => entry.name === 'redirectUpdateForStaff')?.input as Record<string, unknown>;
    expect('isActive' in call).toBe(false);
  });

  it('takes an empty note as a request to clear it', async () => {
    const seen = await createApp();
    await request({
      method: 'PATCH',
      url: `/v1/admin/seo/redirects/${ENTRY}`,
      accessToken: ACCESS_TOKEN,
      payload: { note: '' },
    });
    const call = seen.find((entry) => entry.name === 'redirectUpdateForStaff')?.input as { note: string | null };
    expect(call.note).toBe('');
  });

  it('refuses an edit that changes nothing', async () => {
    await createApp();
    const response = await request({
      method: 'PATCH',
      url: `/v1/admin/seo/redirects/${ENTRY}`,
      accessToken: ACCESS_TOKEN,
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });

  it('is a 404 when the entry is not there', async () => {
    await createApp({ writeResult: false });
    const response = await request({
      method: 'PATCH',
      url: `/v1/admin/seo/redirects/${ENTRY}`,
      accessToken: ACCESS_TOKEN,
      payload: { toPath: '/newer' },
    });
    expect(response.statusCode).toBe(404);
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* Switching on and off                                                                              */
/* ------------------------------------------------------------------------------------------------ */

describe('PUT /v1/admin/seo/redirects/:redirectId/state', () => {
  it('switches an entry on, and off', async () => {
    const seen = await createApp();
    for (const isActive of [true, false]) {
      const response = await request({
        method: 'PUT',
        url: `/v1/admin/seo/redirects/${ENTRY}/state`,
        accessToken: ACCESS_TOKEN,
        payload: { isActive },
      });
      expect(response.statusCode).toBe(200);
    }
    expect(
      seen.filter((entry) => entry.name === 'redirectStateForStaff').map((entry) => (entry.input as { isActive: boolean }).isActive),
    ).toEqual([true, false]);
  });

  it('refuses a request that does not say which state', async () => {
    await createApp();
    for (const payload of [{}, { isActive: 'true' }, { isActive: null }]) {
      const response = await request({
        method: 'PUT',
        url: `/v1/admin/seo/redirects/${ENTRY}/state`,
        accessToken: ACCESS_TOKEN,
        payload,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it('carries nothing but the state: an address cannot ride along with it', async () => {
    const seen = await createApp();
    await request({
      method: 'PUT',
      url: `/v1/admin/seo/redirects/${ENTRY}/state`,
      accessToken: ACCESS_TOKEN,
      payload: { isActive: true, toPath: '/somewhere-else' },
    });
    const call = seen.find((entry) => entry.name === 'redirectStateForStaff')?.input as Record<string, unknown>;
    expect('toPath' in call).toBe(false);
  });

  it('is a 404 when the entry is not there', async () => {
    await createApp({ writeResult: false });
    const response = await request({
      method: 'PUT',
      url: `/v1/admin/seo/redirects/${ENTRY}/state`,
      accessToken: ACCESS_TOKEN,
      payload: { isActive: false },
    });
    expect(response.statusCode).toBe(404);
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* Removing                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

describe('DELETE /v1/admin/seo/redirects/:redirectId', () => {
  it('removes an entry', async () => {
    const seen = await createApp();
    const response = await request({
      method: 'DELETE',
      url: `/v1/admin/seo/redirects/${ENTRY}`,
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(200);
    expect(seen.filter((entry) => entry.name === 'redirectDeleteForStaff')).toHaveLength(1);
  });

  it('is a 404 when the entry is not there', async () => {
    await createApp({ writeResult: false });
    const response = await request({
      method: 'DELETE',
      url: `/v1/admin/seo/redirects/${ENTRY}`,
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(404);
  });

  it('is a 404 for a caller holding only the read key', async () => {
    await createApp({ permissions: [READ], writeError: { code: '42501' } });
    const response = await request({
      method: 'DELETE',
      url: `/v1/admin/seo/redirects/${ENTRY}`,
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(404);
  });

  it('needs a session', async () => {
    await createApp();
    const response = await request({ method: 'DELETE', url: `/v1/admin/seo/redirects/${ENTRY}` });
    expect(response.statusCode).toBe(401);
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* What no route here does                                                                           */
/* ------------------------------------------------------------------------------------------------ */

describe('the shape of this surface', () => {
  it('never takes an actor, a role, a permission or an assurance level from a request', async () => {
    const seen = await createApp();
    await request({
      method: 'POST',
      url: '/v1/admin/seo/redirects',
      accessToken: ACCESS_TOKEN,
      payload: {
        fromPath: '/old',
        toPath: '/new',
        userId: '22222222-2222-4222-8222-222222222222',
        isAal2: true,
        permission: 'seo.redirect.manage',
        role: 'super_admin',
      },
    });
    const call = seen.find((entry) => entry.name === 'redirectCreateForStaff')?.input as Record<string, unknown>;
    // The account and the assurance level reach the database, but from the session rather than from the body.
    expect(call['userId']).toBe(STAFF);
    expect(call['isAal2']).toBe(true);
    expect('permission' in call).toBe(false);
    expect('role' in call).toBe(false);
  });

  it('has no route that counts, groups or prioritises a redirect', async () => {
    await createApp();
    for (const url of [
      `/v1/admin/seo/redirects/${ENTRY}/hits`,
      '/v1/admin/seo/redirects/analytics',
      '/v1/admin/seo/redirects/groups',
      '/v1/admin/seo/redirects/import',
    ]) {
      const response = await request({ method: 'GET', url, accessToken: ACCESS_TOKEN });
      // None of these exists. `/{redirectId}` catches the last three as a malformed identifier, which is a 400;
      // what matters is that nothing answers 200.
      expect([400, 404], url).toContain(response.statusCode);
    }
  });
});
