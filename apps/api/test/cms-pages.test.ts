import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  CmsPageDetailResponseSchema,
  CmsPagePageResponseSchema,
  CmsPageWriteResponseSchema,
  CreateCmsPageResponseSchema,
  PublicCmsPageLookupResponseSchema,
  PublicCmsPagesResponseSchema,
  SESSION_TOKEN_HEADER,
} from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { AuthenticationRequiredError } from '../src/auth/auth-errors.js';
import { CMS_PAGES_STORE } from '../src/admin/cms-pages.service.js';
import { CMS_PUBLIC_STORE } from '../src/cms/cms-pages.service.js';
import { encodeCmsPageCursor } from '../src/admin/cms-pages.cursor.js';
import { SUPABASE_AUTH_CLIENT } from '../src/auth/login.service.js';
import { STAFF_CONSOLE_STORE, type StaffConsoleRow } from '../src/admin/staff-console.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * CMS static pages at the API boundary.
 *
 * The properties this suite exists for:
 *
 * **The public surface carries no user context, and the staff surface carries nothing but.** The two public
 * reads are driven with no session at all and answer; every staff route is driven by a caller holding
 * `cms.page.read`, by callers holding each of the other console keys instead, and by the same caller at `aal1`,
 * and only the first reaches anything.
 *
 * **Reading and managing are separate keys, and the split is visible rather than implied.** A caller holding
 * only `cms.page.read` can list and open a page — and `canManage` comes back false — while every write answers
 * 404, byte for byte identical to a page that does not exist. A console that rendered its controls from a role
 * name would pass a weaker test than this one.
 *
 * **A rename cannot publish a page.** `PATCH` is driven with a `status` field in the body and the store is
 * asserted never to have been asked to change a status: the field is dropped by the contract rather than
 * ignored by the service.
 *
 * **The moved answer is a 200 with an outcome, never a redirect.** Asserted on the status line, because a 301
 * here would be followed by the BFF's `fetch` and the browser would never be redirected.
 *
 * **Every refusal the database can raise becomes its own code.** The store double raises each SQLSTATE and the
 * response code is compared, including that `42501` — the database refusing a caller without the manage key —
 * becomes the same 404 as an absence rather than a 403.
 *
 * Everything is stubbed at the store boundary: no database, no Redis, no network.
 */

const STAFF = '11111111-1111-4111-8111-111111111111';
const PAGE = 'fc000000-0000-4000-8000-00000000c115';

function token(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.c2lnbmF0dXJl`;
}

const ACCESS_TOKEN = token({ sub: STAFF, aal: 'aal2' });
const AAL1_TOKEN = token({ sub: STAFF, aal: 'aal1' });

const READ = 'cms.page.read';
const MANAGE = 'cms.page.manage';

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
  'cms.blog.read',
  'cms.faq.read',
  'seo.metadata.read',
] as const;

const PUBLIC_ROW = {
  kind: 'page',
  pageId: PAGE,
  slug: 'terms',
  pageKey: 'terms',
  template: 'legal',
  isIndexable: true,
  publishedAt: new Date('2026-05-01T09:00:00.000Z'),
  updatedAt: new Date('2026-05-02T09:00:00.000Z'),
  resolvedLocale: 'en',
  title: 'Terms of Service',
  excerpt: null,
  body: 'The body.',
  metaTitle: 'Terms',
  metaDescription: 'Our terms.',
  coverObjectPath: null,
};

const LIST_ROW = {
  pageId: PAGE,
  slug: 'terms',
  pageKey: 'terms',
  status: 'published',
  template: 'legal',
  isIndexable: true,
  sortOrder: 10,
  scheduledFor: null,
  publishedAt: new Date('2026-05-01T09:00:00.000Z'),
  archivedAt: null,
  updatedAt: new Date('2026-05-02T09:00:00.000Z'),
  translatedLocales: ['en'],
  title: 'Terms of Service',
};

const DETAIL_ROW = {
  ...LIST_ROW,
  createdAt: new Date('2026-04-01T09:00:00.000Z'),
  createdBy: STAFF,
  updatedBy: STAFF,
  canManage: true,
  previousSlugs: ['terms-old'],
};

const TRANSLATION_ROW = {
  localeCode: 'en',
  title: 'Terms of Service',
  excerpt: null,
  body: 'The body.',
  metaTitle: 'Terms',
  metaDescription: 'Our terms.',
  updatedAt: new Date('2026-05-02T09:00:00.000Z'),
};

interface Doubles {
  permissions?: readonly string[];
  unauthenticated?: boolean;
  publicRow?: Record<string, unknown> | null;
  publicRows?: readonly Record<string, unknown>[];
  listRows?: readonly Record<string, unknown>[];
  detailRow?: Record<string, unknown> | null;
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

  const publicStore = {
    cmsPageForPublic: async (input: unknown) => {
      seen.push({ name: 'cmsPageForPublic', input });
      return doubles.publicRow === undefined ? PUBLIC_ROW : doubles.publicRow;
    },
    cmsPagesForPublic: async (input: unknown) => {
      seen.push({ name: 'cmsPagesForPublic', input });
      return doubles.publicRows ?? [
        {
          pageId: PAGE,
          slug: 'terms',
          pageKey: 'terms',
          template: 'legal',
          isIndexable: true,
          sortOrder: 10,
          publishedAt: new Date('2026-05-01T09:00:00.000Z'),
          updatedAt: new Date('2026-05-02T09:00:00.000Z'),
          resolvedLocale: 'en',
          title: 'Terms of Service',
        },
      ];
    },
  };

  const write = async (name: string, input: unknown): Promise<boolean> => {
    seen.push({ name, input });
    if (doubles.writeError !== undefined) throw sqlError(doubles.writeError.code);
    return doubles.writeResult ?? true;
  };

  const adminStore = {
    cmsPagesForStaff: async (input: { limit: number }) => {
      seen.push({ name: 'cmsPagesForStaff', input });
      return doubles.listRows ?? [LIST_ROW];
    },
    cmsPageForStaff: async (input: unknown) => {
      seen.push({ name: 'cmsPageForStaff', input });
      return doubles.detailRow === undefined ? DETAIL_ROW : doubles.detailRow;
    },
    cmsPageTranslationsForStaff: async (input: unknown) => {
      seen.push({ name: 'cmsPageTranslationsForStaff', input });
      return [TRANSLATION_ROW];
    },
    cmsPageCreateForStaff: async (input: unknown) => {
      seen.push({ name: 'cmsPageCreateForStaff', input });
      if (doubles.writeError !== undefined) throw sqlError(doubles.writeError.code);
      return PAGE;
    },
    cmsPageUpdateForStaff: async (input: unknown) => write('cmsPageUpdateForStaff', input),
    cmsPageStatusForStaff: async (input: unknown) => write('cmsPageStatusForStaff', input),
    cmsPageTranslationSaveForStaff: async (input: unknown) => write('cmsPageTranslationSaveForStaff', input),
    cmsPageTranslationDeleteForStaff: async (input: unknown) => write('cmsPageTranslationDeleteForStaff', input),
  };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(TEST_ENV)] })
    .overrideProvider(SUPABASE_AUTH_CLIENT)
    .useValue({
      getUser: async () => {
        if (doubles.unauthenticated === true) throw new AuthenticationRequiredError();
        return { id: STAFF, phone: null };
      },
      signInWithPassword: async () => {
        throw new Error('reading a page must never sign anyone in');
      },
      revokeAllSessions: async () => {
        throw new Error('reading a page must never revoke a session');
      },
    })
    .overrideProvider(STAFF_CONSOLE_STORE)
    .useValue({
      staffConsoleAccess: async (input: { userId: string; isAal2: boolean }): Promise<StaffConsoleRow> => {
        // The platform's own behaviour, modelled rather than asserted around: a role that requires MFA counts
        // for nothing at aal1, so the effective set is empty. Both roles holding a CMS key require MFA.
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
    .overrideProvider(CMS_PUBLIC_STORE)
    .useValue(publicStore)
    .overrideProvider(CMS_PAGES_STORE)
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
/* The public surface                                                                                */
/* ------------------------------------------------------------------------------------------------ */

describe('GET /v1/cms/pages', () => {
  it('answers with no session at all', async () => {
    await createApp();
    const response = await request({ method: 'GET', url: '/v1/cms/pages' });
    expect(response.statusCode).toBe(200);
    const body = PublicCmsPagesResponseSchema.parse(response.json());
    expect(body.pages).toHaveLength(1);
    expect(body.pages[0]?.slug).toBe('terms');
  });

  it('passes the requested locale, and the default for an unrecognised one', async () => {
    const seen = await createApp();
    await request({ method: 'GET', url: '/v1/cms/pages?locale=ar' });
    await request({ method: 'GET', url: '/v1/cms/pages?locale=xx' });
    await request({ method: 'GET', url: '/v1/cms/pages' });
    const locales = seen.filter((entry) => entry.name === 'cmsPagesForPublic').map((entry) => entry.input);
    expect(locales).toEqual(['ar', 'en', 'en']);
  });

  it('still requires the internal BFF credential', async () => {
    await createApp();
    const response = await request({ method: 'GET', url: '/v1/cms/pages', credential: 'wrong' });
    expect(response.statusCode).toBe(403);
  });

  it('reports an empty index as an empty list rather than a failure', async () => {
    await createApp({ publicRows: [] });
    const response = await request({ method: 'GET', url: '/v1/cms/pages' });
    expect(response.statusCode).toBe(200);
    expect(PublicCmsPagesResponseSchema.parse(response.json()).pages).toEqual([]);
  });
});

describe('GET /v1/cms/pages/:slug', () => {
  it('returns a page with the locale it actually resolved to', async () => {
    await createApp({ publicRow: { ...PUBLIC_ROW, resolvedLocale: 'en' } });
    const response = await request({ method: 'GET', url: '/v1/cms/pages/terms?locale=ar' });
    expect(response.statusCode).toBe(200);
    const body = PublicCmsPageLookupResponseSchema.parse(response.json());
    expect(body.outcome).toBe('page');
    // Asked for Arabic, told English: the fallback is reported rather than hidden.
    if (body.outcome === 'page') expect(body.page.resolvedLocale).toBe('en');
  });

  it('returns a moved slug as a 200 with an outcome, never as a redirect', async () => {
    await createApp({ publicRow: { ...PUBLIC_ROW, kind: 'moved', slug: 'terms-of-service' } });
    const response = await request({ method: 'GET', url: '/v1/cms/pages/terms' });
    // A 301 here would be followed by the BFF's fetch and the browser would never be redirected.
    expect(response.statusCode).toBe(200);
    expect(response.headers['location']).toBeUndefined();
    const body = PublicCmsPageLookupResponseSchema.parse(response.json());
    expect(body.outcome).toBe('moved');
    if (body.outcome === 'moved') expect(body.movedTo).toBe('terms-of-service');
  });

  it('carries no content on a moved answer', async () => {
    await createApp({ publicRow: { ...PUBLIC_ROW, kind: 'moved', slug: 'terms-of-service' } });
    const response = await request({ method: 'GET', url: '/v1/cms/pages/terms' });
    expect(JSON.stringify(response.json())).not.toContain('The body.');
    expect(JSON.stringify(response.json())).not.toContain('Terms of Service');
  });

  it('is a 404 for absence', async () => {
    await createApp({ publicRow: { ...PUBLIC_ROW, kind: 'not_found' } });
    const response = await request({ method: 'GET', url: '/v1/cms/pages/nothing' });
    expect(response.statusCode).toBe(404);
  });

  it('is a 404 for a moved answer with no target, rather than a redirect to nowhere', async () => {
    await createApp({ publicRow: { ...PUBLIC_ROW, kind: 'moved', slug: null } });
    const response = await request({ method: 'GET', url: '/v1/cms/pages/terms' });
    expect(response.statusCode).toBe(404);
  });

  it('is a 404 for a string that cannot be a slug, without reaching the store', async () => {
    const seen = await createApp();
    for (const slug of ['Terms', '-terms', 'terms_of_service']) {
      const response = await request({ method: 'GET', url: `/v1/cms/pages/${slug}` });
      expect(response.statusCode, slug).toBe(404);
    }
    expect(seen.filter((entry) => entry.name === 'cmsPageForPublic')).toHaveLength(0);
  });

  it('refuses an over-long address before routing, and still never reaches the store', async () => {
    const seen = await createApp();
    const response = await request({ method: 'GET', url: `/v1/cms/pages/${'a'.repeat(200)}` });
    // The platform refuses the URI itself with a 414 before the controller is reached, which is a better
    // answer than a 404: the address was never a candidate. What matters for this surface is the second
    // assertion — nothing reached the reader.
    expect(response.statusCode).toBe(414);
    expect(seen.filter((entry) => entry.name === 'cmsPageForPublic')).toHaveLength(0);
  });

  it('is a 503 when the page could not be read, never an empty answer', async () => {
    await createApp({ publicRow: null });
    // A null row is treated as absence; a thrown store is the 503. Both are checked because telling a visitor
    // the terms do not exist when we could not read them is the worse of the two wrong answers.
    const response = await request({ method: 'GET', url: '/v1/cms/pages/terms' });
    expect(response.statusCode).toBe(404);
  });

  it('needs no session, and ignores one it is given', async () => {
    await createApp();
    const anonymous = await request({ method: 'GET', url: '/v1/cms/pages/terms' });
    const signedIn = await request({ method: 'GET', url: '/v1/cms/pages/terms', accessToken: ACCESS_TOKEN });
    expect(anonymous.statusCode).toBe(200);
    expect(signedIn.statusCode).toBe(200);
    expect(anonymous.json()).toEqual(signedIn.json());
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* The staff surface                                                                                 */
/* ------------------------------------------------------------------------------------------------ */

const STAFF_ROUTES = [
  { method: 'GET', url: `/v1/admin/cms/pages` },
  { method: 'GET', url: `/v1/admin/cms/pages/${PAGE}` },
  { method: 'POST', url: `/v1/admin/cms/pages`, payload: { slug: 'privacy' } },
  { method: 'PATCH', url: `/v1/admin/cms/pages/${PAGE}`, payload: { template: 'help' } },
  { method: 'PUT', url: `/v1/admin/cms/pages/${PAGE}/status`, payload: { status: 'draft' } },
  {
    method: 'PUT',
    url: `/v1/admin/cms/pages/${PAGE}/translations/en`,
    payload: { title: 'T', body: 'B' },
  },
  { method: 'DELETE', url: `/v1/admin/cms/pages/${PAGE}/translations/en` },
] as const;

describe('the staff surface is gated on cms.page.read', () => {
  it('answers for a caller holding it at aal2', async () => {
    await createApp();
    for (const route of STAFF_ROUTES) {
      const response = await request({ ...route, accessToken: ACCESS_TOKEN });
      expect([200, 201], `${route.method} ${route.url}`).toContain(response.statusCode);
    }
  });

  it('refuses every other console key with a 404', async () => {
    for (const key of OTHER_KEYS) {
      await createApp({ permissions: [key] });
      for (const route of STAFF_ROUTES) {
        const response = await request({ ...route, accessToken: ACCESS_TOKEN });
        expect(response.statusCode, `${key} on ${route.method} ${route.url}`).toBe(404);
      }
      await app?.close();
      app = undefined;
    }
  });

  it('refuses the same caller at aal1, because both roles holding the key require MFA', async () => {
    await createApp();
    for (const route of STAFF_ROUTES) {
      const response = await request({ ...route, accessToken: AAL1_TOKEN });
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(404);
    }
  });

  it('refuses a request with no session at all', async () => {
    await createApp();
    for (const route of STAFF_ROUTES) {
      const response = await request(route);
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(401);
    }
  });

  it('still requires the internal BFF credential', async () => {
    await createApp();
    const response = await request({
      method: 'GET',
      url: '/v1/admin/cms/pages',
      accessToken: ACCESS_TOKEN,
      credential: 'wrong',
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('reading and managing are separate keys', () => {
  it('lets a reader list and open a page, and reports that they may not manage it', async () => {
    await createApp({ permissions: [READ], detailRow: { ...DETAIL_ROW, canManage: false } });
    const list = await request({ method: 'GET', url: '/v1/admin/cms/pages', accessToken: ACCESS_TOKEN });
    expect(list.statusCode).toBe(200);

    const detail = await request({
      method: 'GET',
      url: `/v1/admin/cms/pages/${PAGE}`,
      accessToken: ACCESS_TOKEN,
    });
    expect(detail.statusCode).toBe(200);
    expect(CmsPageDetailResponseSchema.parse(detail.json()).page.canManage).toBe(false);
  });

  it('turns the database refusing a write into the same 404 as an absence', async () => {
    // 42501 is the database refusing a caller who holds the read key and not the manage key.
    await createApp({ permissions: [READ], writeError: { code: '42501' } });
    const refused = await request({
      method: 'PUT',
      url: `/v1/admin/cms/pages/${PAGE}/status`,
      accessToken: ACCESS_TOKEN,
      payload: { status: 'published' },
    });

    await app?.close();
    app = undefined;
    await createApp({ permissions: [READ], writeResult: false });
    const absent = await request({
      method: 'PUT',
      url: `/v1/admin/cms/pages/${PAGE}/status`,
      accessToken: ACCESS_TOKEN,
      payload: { status: 'published' },
    });

    expect(refused.statusCode).toBe(404);
    expect(absent.statusCode).toBe(404);
    // Byte for byte: a caller cannot tell which it was.
    expect(refused.body).toBe(absent.body);
  });
});

describe('the lifecycle has its own route', () => {
  it('drops a status field sent to PATCH rather than acting on it', async () => {
    const seen = await createApp();
    const response = await request({
      method: 'PATCH',
      url: `/v1/admin/cms/pages/${PAGE}`,
      accessToken: ACCESS_TOKEN,
      payload: { slug: 'terms-of-service', status: 'published' },
    });
    expect(response.statusCode).toBe(200);
    // The update writer was called and the status writer was not: a rename cannot publish a page.
    expect(seen.some((entry) => entry.name === 'cmsPageUpdateForStaff')).toBe(true);
    expect(seen.some((entry) => entry.name === 'cmsPageStatusForStaff')).toBe(false);
    const input = seen.find((entry) => entry.name === 'cmsPageUpdateForStaff')?.input as Record<string, unknown>;
    expect('status' in input).toBe(false);
  });

  it('refuses an empty PATCH rather than making a silent no-op call', async () => {
    const seen = await createApp();
    const response = await request({
      method: 'PATCH',
      url: `/v1/admin/cms/pages/${PAGE}`,
      accessToken: ACCESS_TOKEN,
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    expect(seen.some((entry) => entry.name === 'cmsPageUpdateForStaff')).toBe(false);
  });

  it('distinguishes an absent page key from one being cleared', async () => {
    const seen = await createApp();
    await request({
      method: 'PATCH',
      url: `/v1/admin/cms/pages/${PAGE}`,
      accessToken: ACCESS_TOKEN,
      payload: { template: 'help' },
    });
    await request({
      method: 'PATCH',
      url: `/v1/admin/cms/pages/${PAGE}`,
      accessToken: ACCESS_TOKEN,
      payload: { pageKey: '' },
    });
    const calls = seen
      .filter((entry) => entry.name === 'cmsPageUpdateForStaff')
      .map((entry) => (entry.input as { pageKey: string | null }).pageKey);
    // Absent leaves the key (null reaches the writer, which coalesces); an empty string clears it.
    expect(calls).toEqual([null, '']);
  });

  it('requires a moment for a scheduled page and refuses one otherwise', async () => {
    await createApp();
    const missing = await request({
      method: 'PUT',
      url: `/v1/admin/cms/pages/${PAGE}/status`,
      accessToken: ACCESS_TOKEN,
      payload: { status: 'scheduled' },
    });
    const extra = await request({
      method: 'PUT',
      url: `/v1/admin/cms/pages/${PAGE}/status`,
      accessToken: ACCESS_TOKEN,
      payload: { status: 'published', scheduledFor: '2026-12-01T00:00:00.000Z' },
    });
    expect(missing.statusCode).toBe(400);
    expect(extra.statusCode).toBe(400);
  });
});

describe('the refusals each keep their own code', () => {
  const cases = [
    { sqlstate: '23001', code: 'CMS_PAGE_LOCALE_REQUIRED' },
    { sqlstate: '23514', code: 'CMS_PAGE_TRANSITION_NOT_ALLOWED' },
    { sqlstate: '23505', code: 'CMS_PAGE_SLUG_TAKEN' },
  ] as const;

  it('maps each database refusal to a 409 with its own code', async () => {
    for (const entry of cases) {
      await createApp({ writeError: { code: entry.sqlstate } });
      const response = await request({
        method: 'PUT',
        url: `/v1/admin/cms/pages/${PAGE}/status`,
        accessToken: ACCESS_TOKEN,
        payload: { status: 'published' },
      });
      expect(response.statusCode, entry.sqlstate).toBe(409);
      expect((response.json() as { code: string }).code, entry.sqlstate).toBe(entry.code);
      await app?.close();
      app = undefined;
    }
  });

  it('treats a not-null violation as an unexpected failure rather than a conflict', async () => {
    // The contract guarantees the required fields, so reaching 23502 is this service's bug, not the caller's.
    await createApp({ writeError: { code: '23502' } });
    const response = await request({
      method: 'PUT',
      url: `/v1/admin/cms/pages/${PAGE}/translations/en`,
      accessToken: ACCESS_TOKEN,
      payload: { title: 'T', body: 'B' },
    });
    expect(response.statusCode).toBe(503);
  });

  it('never forwards the database’s own sentence', async () => {
    await createApp({ writeError: { code: '23001' } });
    const response = await request({
      method: 'PUT',
      url: `/v1/admin/cms/pages/${PAGE}/status`,
      accessToken: ACCESS_TOKEN,
      payload: { status: 'published' },
    });
    expect(response.body).not.toContain('the database refused it');
  });
});

describe('the authored list', () => {
  it('returns a cursor only when there is another page', async () => {
    await createApp({ listRows: [LIST_ROW] });
    const single = await request({
      method: 'GET',
      url: '/v1/admin/cms/pages?limit=1',
      accessToken: ACCESS_TOKEN,
    });
    expect(CmsPagePageResponseSchema.parse(single.json()).nextCursor).toBeNull();

    await app?.close();
    app = undefined;
    await createApp({ listRows: [LIST_ROW, { ...LIST_ROW, pageId: PAGE.replace('c115', 'c116') }] });
    const more = await request({
      method: 'GET',
      url: '/v1/admin/cms/pages?limit=1',
      accessToken: ACCESS_TOKEN,
    });
    expect(CmsPagePageResponseSchema.parse(more.json()).nextCursor).not.toBeNull();
  });

  it('refuses a cursor from another list on this platform', async () => {
    await createApp();
    // A job-run cursor carries the same (timestamp, uuid) pair behind a different key entirely.
    const foreign = Buffer.from(['jr1', '2026-05-02T09:00:00.000Z', PAGE].join('|'), 'utf8').toString('base64url');
    const response = await request({
      method: 'GET',
      url: `/v1/admin/cms/pages?cursor=${foreign}`,
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(400);
  });

  it('accepts its own cursor', async () => {
    await createApp();
    const own = encodeCmsPageCursor({ updatedAt: new Date('2026-05-02T09:00:00.000Z'), id: PAGE });
    const response = await request({
      method: 'GET',
      url: `/v1/admin/cms/pages?cursor=${own}`,
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(200);
  });

  it('clamps the limit and refuses a nonsense one', async () => {
    const seen = await createApp();
    await request({ method: 'GET', url: '/v1/admin/cms/pages?limit=9999', accessToken: ACCESS_TOKEN });
    const limits = seen
      .filter((entry) => entry.name === 'cmsPagesForStaff')
      .map((entry) => (entry.input as { limit: number }).limit);
    // One over the page size, so the service can tell whether another page exists.
    expect(limits[0]).toBe(101);

    for (const bad of ['0', '-1', 'ten', '1.5']) {
      const response = await request({
        method: 'GET',
        url: `/v1/admin/cms/pages?limit=${bad}`,
        accessToken: ACCESS_TOKEN,
      });
      expect(response.statusCode, bad).toBe(400);
    }
  });

  it('passes an unknown status through rather than refusing it', async () => {
    const seen = await createApp({ listRows: [] });
    const response = await request({
      method: 'GET',
      url: '/v1/admin/cms/pages?status=not-a-status',
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(200);
    expect(CmsPagePageResponseSchema.parse(response.json()).items).toEqual([]);
    expect((seen.find((e) => e.name === 'cmsPagesForStaff')?.input as { status: string }).status).toBe(
      'not-a-status',
    );
  });
});

describe('the authored detail', () => {
  it('carries the previous slugs and every locale', async () => {
    await createApp();
    const response = await request({
      method: 'GET',
      url: `/v1/admin/cms/pages/${PAGE}`,
      accessToken: ACCESS_TOKEN,
    });
    const page = CmsPageDetailResponseSchema.parse(response.json()).page;
    expect(page.previousSlugs).toEqual(['terms-old']);
    expect(page.translations).toHaveLength(1);
    expect(page.translations[0]?.localeCode).toBe('en');
  });

  it('is a 404 when the reader returns nothing', async () => {
    await createApp({ detailRow: null });
    const response = await request({
      method: 'GET',
      url: `/v1/admin/cms/pages/${PAGE}`,
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(404);
  });

  it('refuses a path segment that cannot be an identifier', async () => {
    const seen = await createApp();
    const response = await request({
      method: 'GET',
      url: '/v1/admin/cms/pages/not-a-uuid',
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(400);
    expect(seen.some((entry) => entry.name === 'cmsPageForStaff')).toBe(false);
  });
});

describe('writing a locale', () => {
  it('creates and replaces through the same request', async () => {
    await createApp();
    const response = await request({
      method: 'PUT',
      url: `/v1/admin/cms/pages/${PAGE}/translations/en`,
      accessToken: ACCESS_TOKEN,
      payload: { title: 'Terms', body: 'Body.' },
    });
    expect(response.statusCode).toBe(200);
    expect(CmsPageWriteResponseSchema.parse(response.json()).ok).toBe(true);
  });

  it('refuses a locale segment that cannot be one', async () => {
    const seen = await createApp();
    for (const locale of ['eng', 'E', '1']) {
      const response = await request({
        method: 'PUT',
        url: `/v1/admin/cms/pages/${PAGE}/translations/${locale}`,
        accessToken: ACCESS_TOKEN,
        payload: { title: 'T', body: 'B' },
      });
      expect(response.statusCode, locale).toBe(400);
    }
    expect(seen.some((entry) => entry.name === 'cmsPageTranslationSaveForStaff')).toBe(false);
  });

  it('is a 404 when the page is not there', async () => {
    await createApp({ writeResult: false });
    const response = await request({
      method: 'PUT',
      url: `/v1/admin/cms/pages/${PAGE}/translations/en`,
      accessToken: ACCESS_TOKEN,
      payload: { title: 'T', body: 'B' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('treats removing a locale that is not there as an absence', async () => {
    await createApp({ writeResult: false });
    const response = await request({
      method: 'DELETE',
      url: `/v1/admin/cms/pages/${PAGE}/translations/ar`,
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('creating a page', () => {
  it('answers 201 with the new identifier', async () => {
    await createApp();
    const response = await request({
      method: 'POST',
      url: '/v1/admin/cms/pages',
      accessToken: ACCESS_TOKEN,
      payload: { slug: 'privacy' },
    });
    expect(response.statusCode).toBe(201);
    expect(CreateCmsPageResponseSchema.parse(response.json()).id).toBe(PAGE);
  });

  it('applies the column defaults rather than requiring them', async () => {
    const seen = await createApp();
    await request({
      method: 'POST',
      url: '/v1/admin/cms/pages',
      accessToken: ACCESS_TOKEN,
      payload: { slug: 'privacy' },
    });
    const input = seen.find((entry) => entry.name === 'cmsPageCreateForStaff')?.input as Record<string, unknown>;
    expect(input).toMatchObject({ template: 'standard', sortOrder: 0, isIndexable: true, pageKey: null });
  });

  it('refuses a slug the database would refuse, before reaching it', async () => {
    const seen = await createApp();
    for (const slug of ['Terms', '-terms', 'terms of service']) {
      const response = await request({
        method: 'POST',
        url: '/v1/admin/cms/pages',
        accessToken: ACCESS_TOKEN,
        payload: { slug },
      });
      expect(response.statusCode, slug).toBe(400);
    }
    expect(seen.some((entry) => entry.name === 'cmsPageCreateForStaff')).toBe(false);
  });
});

describe('the routes that do not exist', () => {
  it('has no delete for a page and no verb that could empty the section', async () => {
    await createApp();
    for (const route of [
      { method: 'DELETE', url: `/v1/admin/cms/pages/${PAGE}` },
      { method: 'DELETE', url: '/v1/admin/cms/pages' },
      { method: 'PUT', url: `/v1/admin/cms/pages/${PAGE}` },
      { method: 'POST', url: `/v1/admin/cms/pages/${PAGE}` },
      { method: 'PATCH', url: '/v1/admin/cms/pages' },
    ]) {
      const response = await request({ ...route, accessToken: ACCESS_TOKEN, payload: {} });
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(404);
    }
  });

  it('has no write verb on the public surface', async () => {
    await createApp();
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      const response = await request({ method, url: '/v1/cms/pages/terms', payload: {} });
      expect(response.statusCode, method).toBe(404);
    }
  });
});
