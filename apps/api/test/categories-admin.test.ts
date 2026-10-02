import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  AdminCategoryDetailResponseSchema,
  AdminCategoryTreeResponseSchema,
  CategoryWriteResponseSchema,
  CreateCategoryResponseSchema,
  SESSION_TOKEN_HEADER,
} from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { AuthenticationRequiredError } from '../src/auth/auth-errors.js';
import { CATEGORIES_STORE } from '../src/admin/categories.service.js';
import { SUPABASE_AUTH_CLIENT } from '../src/auth/login.service.js';
import { STAFF_CONSOLE_STORE, type StaffConsoleRow } from '../src/admin/staff-console.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * The category tree at the API boundary.
 *
 * The properties this suite exists for:
 *
 * **Reading and managing are separate keys, and the split is visible rather than implied.** A caller holding only
 * `catalog.category.read` sees the tree and a detail whose `canManage` is false, while every write answers 404 —
 * byte for byte the same answer as a category that does not exist. The database raises `42501`; a 403 would turn
 * the console into a way to ask which categories exist.
 *
 * **No session, the wrong key, and `aal1` all reach nothing**, on every one of the seven routes.
 *
 * **A rename is not expressible.** `PATCH` is driven with a `slug` in the body and refused by the contract, and
 * the store is asserted never to have been asked to change one. There is no rename route to decline.
 *
 * **Each of 0010's refusals becomes its own code.** The store double raises every SQLSTATE and the response code
 * is compared, including that `23001` carries a different sentence for a tree refusal than for a naming one.
 *
 * Everything is stubbed at the store boundary: no database, no Redis, no network.
 */

const STAFF = '11111111-1111-4111-8111-111111111111';
const CATEGORY = 'cc000000-0000-4000-8000-0000000000c1';

function token(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.c2lnbmF0dXJl`;
}

const ACCESS_TOKEN = token({ sub: STAFF, aal: 'aal2' });
const AAL1_TOKEN = token({ sub: STAFF, aal: 'aal1' });

const READ = 'catalog.category.read';
const MANAGE = 'catalog.category.manage';

/** Every other console key. Not one of them opens this section. */
const OTHER_KEYS = [
  'cms.page.read',
  'cms.page.manage',
  'catalog.listing.read',
  'catalog.listing.moderate',
  'catalog.attribute.manage',
  'reviews.review.read',
  'support.ticket.read',
  'disputes.dispute.read',
  'users.profile.read',
  'audit.read',
  'platform.job.read',
  'sellers.profile.read',
];

const NODE = {
  categoryId: CATEGORY,
  parentId: null,
  slug: 'furniture',
  depth: 0,
  sortOrder: 1,
  listingTypeCode: 'product',
  isActive: true,
  isVisible: true,
  childCount: 1,
  listingCount: 4,
  translatedLocales: ['en', 'ar'],
  name: 'Furniture',
  updatedAt: new Date('2026-05-02T09:00:00.000Z'),
};

const DETAIL = {
  ...NODE,
  parentSlug: null,
  createdAt: new Date('2026-04-01T09:00:00.000Z'),
  canManage: true,
};

interface Seen {
  readonly name: string;
  readonly input: unknown;
}

interface Doubles {
  readonly permissions?: readonly string[];
  readonly unauthenticated?: boolean;
  readonly detail?: 'missing' | 'reader';
  readonly writeError?: string;
  readonly writeChanged?: boolean;
  readonly readError?: boolean;
}

let app: NestFastifyApplication | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function sqlError(code: string): Error & { code: string } {
  const error = new Error('the database refused this') as Error & { code: string };
  error.code = code;
  return error;
}

async function start(doubles: Doubles = {}): Promise<Seen[]> {
  const seen: Seen[] = [];
  const write = async (name: string, input: unknown): Promise<boolean> => {
    seen.push({ name, input });
    if (doubles.writeError !== undefined) throw sqlError(doubles.writeError);
    return doubles.writeChanged ?? true;
  };

  const store = {
    categoriesForStaff: async (input: unknown) => {
      seen.push({ name: 'categoriesForStaff', input });
      if (doubles.readError === true) throw sqlError('57014');
      const granted = doubles.permissions ?? [READ, MANAGE];
      // The database's own behaviour, modelled: the reader's permission test is in its WHERE clause, so a
      // caller without the read key receives an empty set rather than a refusal.
      return granted.includes(READ) ? [NODE] : [];
    },
    categoryForStaff: async (input: unknown) => {
      seen.push({ name: 'categoryForStaff', input });
      if (doubles.readError === true) throw sqlError('57014');
      if (doubles.detail === 'missing') return null;
      const granted = doubles.permissions ?? [READ, MANAGE];
      if (!granted.includes(READ)) return null;
      return { ...DETAIL, canManage: doubles.detail === 'reader' ? false : granted.includes(MANAGE) };
    },
    categoryTranslationsForStaff: async (input: unknown) => {
      seen.push({ name: 'categoryTranslationsForStaff', input });
      return [
        {
          localeCode: 'en',
          name: 'Furniture',
          description: null,
          metaTitle: 'Furniture',
          metaDescription: null,
          updatedAt: new Date('2026-05-02T09:00:00.000Z'),
        },
      ];
    },
    categoryCreateForStaff: async (input: unknown) => {
      seen.push({ name: 'categoryCreateForStaff', input });
      if (doubles.writeError !== undefined) throw sqlError(doubles.writeError);
      return CATEGORY;
    },
    categoryUpdateForStaff: async (input: unknown) => write('categoryUpdateForStaff', input),
    categoryStateForStaff: async (input: unknown) => write('categoryStateForStaff', input),
    categoryTranslationSaveForStaff: async (input: unknown) => write('categoryTranslationSaveForStaff', input),
    categoryTranslationDeleteForStaff: async (input: unknown) => write('categoryTranslationDeleteForStaff', input),
  };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(TEST_ENV)] })
    .overrideProvider(SUPABASE_AUTH_CLIENT)
    .useValue({
      getUser: async () => {
        if (doubles.unauthenticated === true) throw new AuthenticationRequiredError();
        return { id: STAFF, phone: null };
      },
      signInWithPassword: async () => {
        throw new Error('reading the catalogue must never sign anyone in');
      },
      revokeAllSessions: async () => {
        throw new Error('reading the catalogue must never revoke a session');
      },
    })
    .overrideProvider(STAFF_CONSOLE_STORE)
    .useValue({
      staffConsoleAccess: async (input: { userId: string; isAal2: boolean }): Promise<StaffConsoleRow> => {
        // Both roles holding a category key require MFA, so at aal1 the effective set is empty.
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
    .overrideProvider(CATEGORIES_STORE)
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

/** Every route on this surface, with a body where one is required. */
const ROUTES = [
  { method: 'GET', url: '/v1/admin/categories' },
  { method: 'GET', url: `/v1/admin/categories/${CATEGORY}` },
  { method: 'POST', url: '/v1/admin/categories', payload: { slug: 'garden' } },
  { method: 'PATCH', url: `/v1/admin/categories/${CATEGORY}`, payload: { setParent: false, sortOrder: 2 } },
  { method: 'PUT', url: `/v1/admin/categories/${CATEGORY}/state`, payload: { isActive: true } },
  { method: 'PUT', url: `/v1/admin/categories/${CATEGORY}/translations/en`, payload: { name: 'Furniture' } },
  { method: 'DELETE', url: `/v1/admin/categories/${CATEGORY}/translations/en` },
] as const;

/** The four writes, which need the manage key. */
const WRITES = ROUTES.filter((route) => route.method !== 'GET');

describe('who may reach this surface', () => {
  it('refuses every route without a session', async () => {
    const seen = await start();
    for (const route of ROUTES) {
      const response = await request({ ...route });
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(401);
    }
    expect(seen).toHaveLength(0);
  });

  it('refuses every route when the provider rejects the token', async () => {
    const seen = await start({ unauthenticated: true });
    for (const route of ROUTES) {
      const response = await request({ ...route, accessToken: ACCESS_TOKEN });
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(401);
    }
    expect(seen).toHaveLength(0);
  });

  it('refuses every route at aal1, because both roles holding a category key require MFA', async () => {
    const seen = await start();
    for (const route of ROUTES) {
      const response = await request({ ...route, accessToken: AAL1_TOKEN });
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(404);
    }
    expect(seen).toHaveLength(0);
  });

  it('refuses every route for each of the other console keys', async () => {
    for (const key of OTHER_KEYS) {
      const seen = await start({ permissions: [key] });
      for (const route of ROUTES) {
        const response = await request({ ...route, accessToken: ACCESS_TOKEN });
        expect(response.statusCode, `${key} ${route.method} ${route.url}`).toBe(404);
      }
      expect(seen, key).toHaveLength(0);
      await app?.close();
      app = undefined;
    }
  });

  it('needs the internal credential as well as a session', async () => {
    const seen = await start();
    const response = await request({
      method: 'GET',
      url: '/v1/admin/categories',
      accessToken: ACCESS_TOKEN,
      credential: 'wrong-credential-value-not-a-real-secret',
    });
    expect(response.statusCode).toBe(403);
    expect(seen).toHaveLength(0);
  });
});

describe('a caller holding only the read key', () => {
  it('sees the tree', async () => {
    await start({ permissions: [READ] });
    const response = await request({ method: 'GET', url: '/v1/admin/categories', accessToken: ACCESS_TOKEN });
    expect(response.statusCode).toBe(200);
    const body = AdminCategoryTreeResponseSchema.parse(response.json());
    expect(body.categories).toHaveLength(1);
    expect(body.categories[0]?.slug).toBe('furniture');
  });

  it('sees a detail that says it may not manage', async () => {
    await start({ permissions: [READ], detail: 'reader' });
    const response = await request({ method: 'GET', url: `/v1/admin/categories/${CATEGORY}`, accessToken: ACCESS_TOKEN });
    expect(response.statusCode).toBe(200);
    expect(AdminCategoryDetailResponseSchema.parse(response.json()).category.canManage).toBe(false);
  });

  it('is refused every write', async () => {
    const seen = await start({ permissions: [READ], writeError: '42501' });
    for (const route of WRITES) {
      const response = await request({ ...route, accessToken: ACCESS_TOKEN });
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(404);
    }
    expect(seen.length).toBeGreaterThan(0);
  });

  it('is refused identically to a category that does not exist, on the same route', async () => {
    // Compared on one path, because RFC 9457's `instance` is the request path and so differs between routes by
    // design. What must not differ is the answer to the same request: a reader who may not write, and a category
    // that is not there, are indistinguishable.
    const route = { method: 'PATCH', url: `/v1/admin/categories/${CATEGORY}`, payload: { setParent: false } } as const;

    await start({ permissions: [READ], writeError: '42501' });
    const refused = await request({ ...route, accessToken: ACCESS_TOKEN });
    expect(refused.statusCode).toBe(404);
    await app?.close();
    app = undefined;

    await start({ permissions: [READ, MANAGE], writeChanged: false });
    const absent = await request({ ...route, accessToken: ACCESS_TOKEN });
    expect(absent.statusCode).toBe(404);

    // Byte for byte.
    expect(refused.body).toBe(absent.body);
  });
});

describe('the tree', () => {
  it('carries the public answer separately from the stored state', async () => {
    await start();
    const response = await request({ method: 'GET', url: '/v1/admin/categories', accessToken: ACCESS_TOKEN });
    const node = AdminCategoryTreeResponseSchema.parse(response.json()).categories[0];
    expect(node?.isActive).toBe(true);
    expect(node?.isVisible).toBe(true);
    expect(node?.childCount).toBe(1);
    expect(node?.listingCount).toBe(4);
    expect(node?.translatedLocales).toEqual(['en', 'ar']);
  });

  it('asks the database with the caller and the assurance level, and nothing else', async () => {
    const seen = await start();
    await request({ method: 'GET', url: '/v1/admin/categories', accessToken: ACCESS_TOKEN });
    expect(seen).toEqual([{ name: 'categoriesForStaff', input: { userId: STAFF, isAal2: true } }]);
  });

  it('answers 503 when the tree cannot be read, rather than an empty tree', async () => {
    await start({ readError: true });
    const response = await request({ method: 'GET', url: '/v1/admin/categories', accessToken: ACCESS_TOKEN });
    expect(response.statusCode).toBe(503);
  });
});

describe('creating one', () => {
  it('creates and answers 201 with the identifier', async () => {
    const seen = await start();
    const response = await request({
      method: 'POST',
      url: '/v1/admin/categories',
      accessToken: ACCESS_TOKEN,
      payload: { slug: 'garden', listingTypeCode: 'product', sortOrder: 3 },
    });
    expect(response.statusCode).toBe(201);
    expect(CreateCategoryResponseSchema.parse(response.json()).categoryId).toBe(CATEGORY);
    expect(seen.at(-1)).toEqual({
      name: 'categoryCreateForStaff',
      input: { userId: STAFF, isAal2: true, slug: 'garden', parentId: null, listingTypeCode: 'product', sortOrder: 3 },
    });
  });

  it('never sends an active state, because a new category is always hidden', async () => {
    const seen = await start();
    await request({
      method: 'POST',
      url: '/v1/admin/categories',
      accessToken: ACCESS_TOKEN,
      payload: { slug: 'garden' },
    });
    expect(JSON.stringify(seen.at(-1)?.input)).not.toContain('isActive');
  });

  it('refuses a body the contract does not allow', async () => {
    const seen = await start();
    for (const payload of [
      {},
      { slug: '' },
      { slug: 'Garden' },
      { slug: 'garden', isActive: true },
      { slug: 'garden', depth: 1 },
      { slug: 'garden', sortOrder: -1 },
      { slug: 'garden', parentId: 'not-a-uuid' },
    ]) {
      const response = await request({
        method: 'POST',
        url: '/v1/admin/categories',
        accessToken: ACCESS_TOKEN,
        payload,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(seen.filter((call) => call.name === 'categoryCreateForStaff')).toHaveLength(0);
  });
});

describe('updating one', () => {
  it('cannot be asked to rename a category', async () => {
    // The decisive assertion: there is no rename route, and the edit route refuses the field outright.
    const seen = await start();
    const response = await request({
      method: 'PATCH',
      url: `/v1/admin/categories/${CATEGORY}`,
      accessToken: ACCESS_TOKEN,
      payload: { setParent: false, slug: 'renamed' },
    });
    expect(response.statusCode).toBe(400);
    expect(seen.filter((call) => call.name === 'categoryUpdateForStaff')).toHaveLength(0);
  });

  it('cannot be asked to change the active state either', async () => {
    const seen = await start();
    const response = await request({
      method: 'PATCH',
      url: `/v1/admin/categories/${CATEGORY}`,
      accessToken: ACCESS_TOKEN,
      payload: { setParent: false, isActive: false },
    });
    expect(response.statusCode).toBe(400);
    expect(seen.filter((call) => call.name === 'categoryUpdateForStaff')).toHaveLength(0);
  });

  it('passes "move to the root" through as a real request', async () => {
    const seen = await start();
    await request({
      method: 'PATCH',
      url: `/v1/admin/categories/${CATEGORY}`,
      accessToken: ACCESS_TOKEN,
      payload: { setParent: true, parentId: null },
    });
    expect(seen.at(-1)?.input).toMatchObject({ setParent: true, parentId: null });
  });

  it('leaves the parent alone when the flag is false', async () => {
    const seen = await start();
    await request({
      method: 'PATCH',
      url: `/v1/admin/categories/${CATEGORY}`,
      accessToken: ACCESS_TOKEN,
      payload: { setParent: false, sortOrder: 9 },
    });
    expect(seen.at(-1)?.input).toMatchObject({ setParent: false, parentId: null, sortOrder: 9 });
  });

  it('answers 404 when nothing changed, because the category was not there', async () => {
    await start({ writeChanged: false });
    const response = await request({
      method: 'PATCH',
      url: `/v1/admin/categories/${CATEGORY}`,
      accessToken: ACCESS_TOKEN,
      payload: { setParent: false },
    });
    expect(response.statusCode).toBe(404);
  });

  it('refuses an identifier that cannot name a category, without reaching the store', async () => {
    const seen = await start();
    const response = await request({
      method: 'PATCH',
      url: '/v1/admin/categories/not-a-uuid',
      accessToken: ACCESS_TOKEN,
      payload: { setParent: false },
    });
    expect(response.statusCode).toBe(400);
    expect(seen.filter((call) => call.name === 'categoryUpdateForStaff')).toHaveLength(0);
  });
});

describe('showing and hiding', () => {
  it('shows a category', async () => {
    const seen = await start();
    const response = await request({
      method: 'PUT',
      url: `/v1/admin/categories/${CATEGORY}/state`,
      accessToken: ACCESS_TOKEN,
      payload: { isActive: true },
    });
    expect(response.statusCode).toBe(200);
    expect(CategoryWriteResponseSchema.parse(response.json()).changed).toBe(true);
    expect(seen.at(-1)).toEqual({
      name: 'categoryStateForStaff',
      input: { userId: STAFF, isAal2: true, categoryId: CATEGORY, isActive: true },
    });
  });

  it('requires the state to be stated', async () => {
    const seen = await start();
    for (const payload of [{}, { isActive: 'yes' }, { isActive: true, slug: 'x' }]) {
      const response = await request({
        method: 'PUT',
        url: `/v1/admin/categories/${CATEGORY}/state`,
        accessToken: ACCESS_TOKEN,
        payload,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(seen.filter((call) => call.name === 'categoryStateForStaff')).toHaveLength(0);
  });
});

describe('writing a locale', () => {
  it('writes one, clearing the fields that arrive blank', async () => {
    const seen = await start();
    const response = await request({
      method: 'PUT',
      url: `/v1/admin/categories/${CATEGORY}/translations/ar`,
      accessToken: ACCESS_TOKEN,
      payload: { name: 'أثاث', description: '', metaTitle: '   ', metaDescription: 'وصف' },
    });
    expect(response.statusCode).toBe(200);
    expect(seen.at(-1)?.input).toMatchObject({
      categoryId: CATEGORY,
      localeCode: 'ar',
      name: 'أثاث',
      description: null,
      metaTitle: null,
      metaDescription: 'وصف',
    });
  });

  it('refuses a locale code that cannot be one, and a body the contract refuses', async () => {
    const seen = await start();
    const bad = await request({
      method: 'PUT',
      url: `/v1/admin/categories/${CATEGORY}/translations/english`,
      accessToken: ACCESS_TOKEN,
      payload: { name: 'Furniture' },
    });
    expect(bad.statusCode).toBe(400);

    for (const payload of [{}, { name: '' }, { name: 'x'.repeat(121) }, { name: 'n', metaTitle: 'x'.repeat(71) }]) {
      const response = await request({
        method: 'PUT',
        url: `/v1/admin/categories/${CATEGORY}/translations/en`,
        accessToken: ACCESS_TOKEN,
        payload,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(seen.filter((call) => call.name === 'categoryTranslationSaveForStaff')).toHaveLength(0);
  });

  it('removes one, and says nothing changed when there was none', async () => {
    await start({ writeChanged: false });
    const response = await request({
      method: 'DELETE',
      url: `/v1/admin/categories/${CATEGORY}/translations/ar`,
      accessToken: ACCESS_TOKEN,
    });
    // A locale that was not there is "nothing changed", not "no such category": the category was found.
    expect(response.statusCode).toBe(200);
    expect(CategoryWriteResponseSchema.parse(response.json()).changed).toBe(false);
  });
});

describe('every refusal the database can raise', () => {
  const cases = [
    { sqlstate: '23505', code: 'CATEGORY_SLUG_TAKEN', status: 409 },
    { sqlstate: '23514', code: 'CATEGORY_VALUE_NOT_ALLOWED', status: 409 },
    { sqlstate: '42501', code: 'NOT_FOUND', status: 404 },
    { sqlstate: '23503', code: 'NOT_FOUND', status: 404 },
    // Not mapped: a not-null violation means this service sent something it should have caught, so it is a
    // failure rather than a confident refusal about a rule that does not exist.
    { sqlstate: '23502', code: 'SERVICE_UNAVAILABLE', status: 503 },
    { sqlstate: '57014', code: 'SERVICE_UNAVAILABLE', status: 503 },
  ] as const;

  it('becomes its own code on a create', async () => {
    for (const { sqlstate, code, status } of cases) {
      await start({ writeError: sqlstate });
      const response = await request({
        method: 'POST',
        url: '/v1/admin/categories',
        accessToken: ACCESS_TOKEN,
        payload: { slug: 'garden' },
      });
      expect(response.statusCode, sqlstate).toBe(status);
      expect((response.json() as { code: string }).code, sqlstate).toBe(code);
      await app?.close();
      app = undefined;
    }
  });

  it('tells a tree refusal from a naming refusal, though both arrive as 23001', async () => {
    // The trigger raises one SQLSTATE for the whole family, so which sentence applies is decided by which
    // operation raised it rather than by reading the database's message.
    await start({ writeError: '23001' });
    const move = await request({
      method: 'PATCH',
      url: `/v1/admin/categories/${CATEGORY}`,
      accessToken: ACCESS_TOKEN,
      payload: { setParent: true, parentId: CATEGORY },
    });
    expect(move.statusCode).toBe(409);
    expect((move.json() as { code: string }).code).toBe('CATEGORY_TREE_NOT_ALLOWED');

    const show = await request({
      method: 'PUT',
      url: `/v1/admin/categories/${CATEGORY}/state`,
      accessToken: ACCESS_TOKEN,
      payload: { isActive: true },
    });
    expect(show.statusCode).toBe(409);
    expect((show.json() as { code: string }).code).toBe('CATEGORY_NAME_REQUIRED');
  });

  it('never forwards what the database said', async () => {
    await start({ writeError: '23505' });
    const response = await request({
      method: 'POST',
      url: '/v1/admin/categories',
      accessToken: ACCESS_TOKEN,
      payload: { slug: 'garden' },
    });
    expect(response.body).not.toContain('the database refused this');
    expect(response.body).not.toContain('app_private');
    expect(response.body).not.toContain('23505');
  });
});

describe('the surface has no other verbs', () => {
  it('offers no way to delete a category', async () => {
    // Hiding is the operation that exists: listings, commission rules, tax rules, coupons and promotion
    // packages all reference a category with ON DELETE RESTRICT.
    await start();
    const response = await request({
      method: 'DELETE',
      url: `/v1/admin/categories/${CATEGORY}`,
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(404);
  });

  it('offers no rename route', async () => {
    await start();
    for (const url of [`/v1/admin/categories/${CATEGORY}/slug`, `/v1/admin/categories/${CATEGORY}/rename`]) {
      const response = await request({ method: 'PUT', url, accessToken: ACCESS_TOKEN, payload: { slug: 'x' } });
      expect(response.statusCode, url).toBe(404);
    }
  });
});
