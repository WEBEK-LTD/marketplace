import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  AdminAttributeDefinitionsResponseSchema,
  AdminAttributeDetailResponseSchema,
  AdminCategoryAttributesResponseSchema,
  AdminTagsResponseSchema,
  CreateAttributeDefinitionResponseSchema,
  CreateAttributeOptionResponseSchema,
  CreateTagResponseSchema,
  SESSION_TOKEN_HEADER,
  VocabularyWriteResponseSchema,
} from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { AuthenticationRequiredError } from '../src/auth/auth-errors.js';
import { ATTRIBUTES_STORE } from '../src/admin/attributes.service.js';
import { SUPABASE_AUTH_CLIENT } from '../src/auth/login.service.js';
import { STAFF_CONSOLE_STORE, type StaffConsoleRow } from '../src/admin/staff-console.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * The attribute and tag vocabulary at the API boundary.
 *
 * The properties this suite exists for:
 *
 * **Three keys, and each one means only itself.** `catalog.attribute.manage` opens the attribute routes and
 * nothing else; `catalog.tag.manage` opens the tag routes and nothing else; and the category's attribute panel is
 * governed by `catalog.category.manage`, so somebody who maintains the vocabulary cannot reshape every seller's
 * form. Each of the three is driven with the other two held, and refused.
 *
 * **No session, the wrong key and `aal1` all reach nothing**, on every one of the fifteen routes.
 *
 * **A refusal is an absence.** A caller without the key gets the same 404 as something that does not exist,
 * because the database answers `42501` and a 403 would make the console an oracle over the vocabulary.
 *
 * **Identity is not expressible.** The create routes are driven with a key and a data type; the updates are
 * driven with a `key`, a `dataType`, a `value` and a `slug` in the body, every one refused by the contract, and
 * the store is asserted never to have been asked to change one.
 *
 * **Each refusal from the database becomes its own code**, including that `23001` is reported as something
 * sellers could not answer rather than as a name clash.
 *
 * Everything is stubbed at the store boundary: no database, no Redis, no network.
 */

const STAFF = '11111111-1111-4111-8111-111111111111';
const DEFINITION = 'dd000000-0000-4000-8000-0000000000d1';
const OPTION = 'ee000000-0000-4000-8000-0000000000e1';
const TAG = 'ff000000-0000-4000-8000-0000000000f1';
const CATEGORY = 'cc000000-0000-4000-8000-0000000000c1';

function token(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.c2lnbmF0dXJl`;
}

const ACCESS_TOKEN = token({ sub: STAFF, aal: 'aal2' });
const AAL1_TOKEN = token({ sub: STAFF, aal: 'aal1' });

const ATTRIBUTE_MANAGE = 'catalog.attribute.manage';
const TAG_MANAGE = 'catalog.tag.manage';
const CATEGORY_READ = 'catalog.category.read';
const CATEGORY_MANAGE = 'catalog.category.manage';
const ALL_KEYS = [ATTRIBUTE_MANAGE, TAG_MANAGE, CATEGORY_READ, CATEGORY_MANAGE];

/** Every other console key. Not one of them opens any of these routes. */
const OTHER_KEYS = [
  'cms.page.read',
  'cms.page.manage',
  'catalog.listing.read',
  'catalog.listing.moderate',
  'reviews.review.read',
  'support.ticket.read',
  'disputes.dispute.read',
  'users.profile.read',
  'audit.read',
  'platform.job.read',
  'sellers.profile.read',
];

const DEFINITION_ROW = {
  definitionId: DEFINITION,
  key: 'width',
  dataType: 'number',
  unit: 'cm',
  nameEn: 'Width',
  nameAr: 'العرض',
  isFilterable: true,
  isActive: true,
  sortOrder: 1,
  optionCount: 0,
  categoryCount: 2,
  answerCount: 7,
  createdAt: new Date('2026-04-01T09:00:00.000Z'),
  updatedAt: new Date('2026-05-02T09:00:00.000Z'),
};

const OPTION_ROW = {
  optionId: OPTION,
  value: 'oak',
  labelEn: 'Oak',
  labelAr: 'بلوط',
  sortOrder: 1,
  isActive: true,
  answerCount: 3,
};

const TAG_ROW = {
  tagId: TAG,
  slug: 'handmade',
  nameEn: 'Handmade',
  nameAr: 'صناعة يدوية',
  isActive: true,
  usageCount: 4,
  createdAt: new Date('2026-04-01T09:00:00.000Z'),
  updatedAt: new Date('2026-05-02T09:00:00.000Z'),
};

const CATEGORY_ATTRIBUTE_ROW = {
  definitionId: DEFINITION,
  key: 'width',
  dataType: 'number',
  unit: 'cm',
  nameEn: 'Width',
  nameAr: 'العرض',
  definitionIsActive: true,
  isRequired: true,
  isFilterable: true,
  sortOrder: 1,
  optionCount: 0,
};

interface Seen {
  readonly name: string;
  readonly input: unknown;
}

interface Doubles {
  readonly permissions?: readonly string[];
  readonly unauthenticated?: boolean;
  readonly missing?: boolean;
  readonly writeError?: string;
  readonly writeChanged?: boolean;
  readonly readError?: boolean;
  readonly dataType?: string;
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

/**
 * The store double models the database's own behaviour rather than a convenient version of it: a reader whose
 * permission test is in its WHERE clause answers with an empty set, and a writer whose test raises answers 42501.
 */
async function start(doubles: Doubles = {}): Promise<Seen[]> {
  const seen: Seen[] = [];
  const granted = (): readonly string[] => doubles.permissions ?? ALL_KEYS;

  const write = async (name: string, input: unknown, key: string): Promise<boolean> => {
    seen.push({ name, input });
    if (!granted().includes(key)) throw sqlError('42501');
    if (doubles.writeError !== undefined) throw sqlError(doubles.writeError);
    return doubles.writeChanged ?? true;
  };
  const created = async (name: string, input: unknown, key: string, id: string): Promise<string> => {
    seen.push({ name, input });
    if (!granted().includes(key)) throw sqlError('42501');
    if (doubles.writeError !== undefined) throw sqlError(doubles.writeError);
    return id;
  };

  const store = {
    attributeCanManage: async (input: unknown) => {
      seen.push({ name: 'attributeCanManage', input });
      return granted().includes(ATTRIBUTE_MANAGE);
    },
    tagCanManage: async (input: unknown) => {
      seen.push({ name: 'tagCanManage', input });
      return granted().includes(TAG_MANAGE);
    },
    categoryCanManage: async (input: unknown) => {
      seen.push({ name: 'categoryCanManage', input });
      return granted().includes(CATEGORY_MANAGE);
    },
    attributeDefinitionsForStaff: async (input: unknown) => {
      seen.push({ name: 'attributeDefinitionsForStaff', input });
      if (doubles.readError === true) throw sqlError('57014');
      return granted().includes(ATTRIBUTE_MANAGE) ? [DEFINITION_ROW] : [];
    },
    attributeDefinitionForStaff: async (input: unknown) => {
      seen.push({ name: 'attributeDefinitionForStaff', input });
      if (doubles.readError === true) throw sqlError('57014');
      if (doubles.missing === true) return null;
      if (!granted().includes(ATTRIBUTE_MANAGE)) return null;
      return { ...DEFINITION_ROW, dataType: doubles.dataType ?? DEFINITION_ROW.dataType };
    },
    attributeOptionsForStaff: async (input: unknown) => {
      seen.push({ name: 'attributeOptionsForStaff', input });
      return granted().includes(ATTRIBUTE_MANAGE) ? [OPTION_ROW] : [];
    },
    attributeDefinitionCreateForStaff: async (input: unknown) =>
      created('attributeDefinitionCreateForStaff', input, ATTRIBUTE_MANAGE, DEFINITION),
    attributeDefinitionUpdateForStaff: async (input: unknown) =>
      write('attributeDefinitionUpdateForStaff', input, ATTRIBUTE_MANAGE),
    attributeDefinitionStateForStaff: async (input: unknown) =>
      write('attributeDefinitionStateForStaff', input, ATTRIBUTE_MANAGE),
    attributeOptionCreateForStaff: async (input: unknown) =>
      created('attributeOptionCreateForStaff', input, ATTRIBUTE_MANAGE, OPTION),
    attributeOptionUpdateForStaff: async (input: unknown) =>
      write('attributeOptionUpdateForStaff', input, ATTRIBUTE_MANAGE),
    attributeOptionStateForStaff: async (input: unknown) =>
      write('attributeOptionStateForStaff', input, ATTRIBUTE_MANAGE),
    tagsForStaff: async (input: unknown) => {
      seen.push({ name: 'tagsForStaff', input });
      if (doubles.readError === true) throw sqlError('57014');
      return granted().includes(TAG_MANAGE) ? [TAG_ROW] : [];
    },
    tagCreateForStaff: async (input: unknown) => created('tagCreateForStaff', input, TAG_MANAGE, TAG),
    tagUpdateForStaff: async (input: unknown) => write('tagUpdateForStaff', input, TAG_MANAGE),
    tagStateForStaff: async (input: unknown) => write('tagStateForStaff', input, TAG_MANAGE),
    categoryAttributesForStaff: async (input: unknown) => {
      seen.push({ name: 'categoryAttributesForStaff', input });
      if (doubles.readError === true) throw sqlError('57014');
      return granted().includes(CATEGORY_READ) ? [CATEGORY_ATTRIBUTE_ROW] : [];
    },
    categoryAttributeAttachForStaff: async (input: unknown) =>
      write('categoryAttributeAttachForStaff', input, CATEGORY_MANAGE),
    categoryAttributeDetachForStaff: async (input: unknown) =>
      write('categoryAttributeDetachForStaff', input, CATEGORY_MANAGE),
  };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(TEST_ENV)] })
    .overrideProvider(SUPABASE_AUTH_CLIENT)
    .useValue({
      getUser: async () => {
        if (doubles.unauthenticated === true) throw new AuthenticationRequiredError();
        return { id: STAFF, phone: null };
      },
      signInWithPassword: async () => {
        throw new Error('maintaining the vocabulary must never sign anyone in');
      },
      revokeAllSessions: async () => {
        throw new Error('maintaining the vocabulary must never revoke a session');
      },
    })
    .overrideProvider(STAFF_CONSOLE_STORE)
    .useValue({
      staffConsoleAccess: async (input: { userId: string; isAal2: boolean }): Promise<StaffConsoleRow> => ({
        hasConsoleRole: true,
        requiresStepUp: false,
        roles: ['admin'],
        // Every role holding one of these keys requires MFA, so at aal1 the effective set is empty.
        permissions: input.isAal2 ? [...granted()] : [],
      }),
      buyerProfile: async (userId: string) => ({ id: userId, displayName: 'Nadia', localeCode: 'en' }),
    })
    .overrideProvider(ATTRIBUTES_STORE)
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

/** Every route on this surface, with the key that opens it and a body where one is required. */
const ROUTES = [
  { method: 'GET', url: '/v1/admin/attributes', key: ATTRIBUTE_MANAGE },
  { method: 'GET', url: `/v1/admin/attributes/${DEFINITION}`, key: ATTRIBUTE_MANAGE },
  {
    method: 'POST',
    url: '/v1/admin/attributes',
    key: ATTRIBUTE_MANAGE,
    payload: { key: 'depth', dataType: 'number', nameEn: 'Depth', nameAr: 'العمق' },
  },
  {
    method: 'PATCH',
    url: `/v1/admin/attributes/${DEFINITION}`,
    key: ATTRIBUTE_MANAGE,
    payload: { nameEn: 'Width', nameAr: 'العرض', isFilterable: true, sortOrder: 2 },
  },
  {
    method: 'PUT',
    url: `/v1/admin/attributes/${DEFINITION}/state`,
    key: ATTRIBUTE_MANAGE,
    payload: { isActive: true },
  },
  {
    method: 'POST',
    url: `/v1/admin/attributes/${DEFINITION}/options`,
    key: ATTRIBUTE_MANAGE,
    payload: { value: 'pine', labelEn: 'Pine', labelAr: 'صنوبر' },
  },
  {
    method: 'PATCH',
    url: `/v1/admin/attributes/${DEFINITION}/options/${OPTION}`,
    key: ATTRIBUTE_MANAGE,
    payload: { labelEn: 'Oak', labelAr: 'بلوط', sortOrder: 1 },
  },
  {
    method: 'PUT',
    url: `/v1/admin/attributes/${DEFINITION}/options/${OPTION}/state`,
    key: ATTRIBUTE_MANAGE,
    payload: { isActive: false },
  },
  { method: 'GET', url: '/v1/admin/tags', key: TAG_MANAGE },
  {
    method: 'POST',
    url: '/v1/admin/tags',
    key: TAG_MANAGE,
    payload: { slug: 'vintage', nameEn: 'Vintage', nameAr: 'عتيق' },
  },
  {
    method: 'PATCH',
    url: `/v1/admin/tags/${TAG}`,
    key: TAG_MANAGE,
    payload: { nameEn: 'Handmade', nameAr: 'يدوي' },
  },
  { method: 'PUT', url: `/v1/admin/tags/${TAG}/state`, key: TAG_MANAGE, payload: { isActive: false } },
  { method: 'GET', url: `/v1/admin/categories/${CATEGORY}/attributes`, key: CATEGORY_READ },
  {
    method: 'PUT',
    url: `/v1/admin/categories/${CATEGORY}/attributes`,
    key: CATEGORY_MANAGE,
    payload: { definitionId: DEFINITION, isRequired: true },
  },
  {
    method: 'DELETE',
    url: `/v1/admin/categories/${CATEGORY}/attributes/${DEFINITION}`,
    key: CATEGORY_MANAGE,
  },
] as const;

const WRITES = ROUTES.filter((route) => route.method !== 'GET');

describe('who may reach this surface', () => {
  it('refuses every route without a session', async () => {
    await start();
    for (const route of ROUTES) {
      const response = await request({ ...route });
      expect(response.statusCode, route.url).toBe(401);
    }
  });

  it('refuses every route without the internal credential', async () => {
    await start();
    for (const route of ROUTES) {
      const response = await request({ ...route, accessToken: ACCESS_TOKEN, credential: 'wrong' });
      expect(response.statusCode, route.url).toBe(403);
    }
  });

  it('refuses every route at aal1, because every role holding these keys requires MFA', async () => {
    await start();
    for (const route of ROUTES) {
      const response = await request({ ...route, accessToken: AAL1_TOKEN });
      expect(response.statusCode, route.url).toBe(404);
    }
  });

  it('refuses every route to a caller holding only other console keys', async () => {
    await start({ permissions: OTHER_KEYS });
    for (const route of ROUTES) {
      const response = await request({ ...route, accessToken: ACCESS_TOKEN });
      expect(response.statusCode, route.url).toBe(404);
    }
  });

  it('opens each route only to its own key', async () => {
    for (const route of ROUTES) {
      // Every key but this route's. The surface must still refuse.
      const others = ALL_KEYS.filter((key) => key !== route.key);
      // Reading a category's attributes needs the read key, and managing them needs the manage key; holding
      // only the other one of that pair is the interesting case, so the pair is not collapsed here.
      await start({ permissions: others });
      const response = await request({ ...route, accessToken: ACCESS_TOKEN });
      expect(response.statusCode, `${route.url} without ${route.key}`).toBe(404);
      await app?.close();
      app = undefined;
    }
  });

  it('lets the attribute key through, and it alone', async () => {
    await start({ permissions: [ATTRIBUTE_MANAGE] });
    const response = await request({ method: 'GET', url: '/v1/admin/attributes', accessToken: ACCESS_TOKEN });
    expect(response.statusCode).toBe(200);
    expect(AdminAttributeDefinitionsResponseSchema.parse(response.json()).attributes).toHaveLength(1);

    const tags = await request({ method: 'GET', url: '/v1/admin/tags', accessToken: ACCESS_TOKEN });
    expect(tags.statusCode).toBe(404);
  });

  it('lets the tag key through, and it alone', async () => {
    await start({ permissions: [TAG_MANAGE] });
    const response = await request({ method: 'GET', url: '/v1/admin/tags', accessToken: ACCESS_TOKEN });
    expect(response.statusCode).toBe(200);
    expect(AdminTagsResponseSchema.parse(response.json()).tags).toHaveLength(1);

    const attributes = await request({
      method: 'GET',
      url: '/v1/admin/attributes',
      accessToken: ACCESS_TOKEN,
    });
    expect(attributes.statusCode).toBe(404);
  });

  it('governs a category’s attributes by the category keys, not the attribute key', async () => {
    await start({ permissions: [ATTRIBUTE_MANAGE] });
    const read = await request({
      method: 'GET',
      url: `/v1/admin/categories/${CATEGORY}/attributes`,
      accessToken: ACCESS_TOKEN,
    });
    expect(read.statusCode).toBe(404);

    const attach = await request({
      method: 'PUT',
      url: `/v1/admin/categories/${CATEGORY}/attributes`,
      accessToken: ACCESS_TOKEN,
      payload: { definitionId: DEFINITION },
    });
    expect(attach.statusCode).toBe(404);
  });

  it('reports a reader of a category’s attributes as unable to manage them', async () => {
    await start({ permissions: [CATEGORY_READ] });
    const response = await request({
      method: 'GET',
      url: `/v1/admin/categories/${CATEGORY}/attributes`,
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(200);
    const body = AdminCategoryAttributesResponseSchema.parse(response.json());
    expect(body.canManage).toBe(false);
    expect(body.attributes[0]?.isRequired).toBe(true);
  });
});

describe('what the surface answers', () => {
  it('returns the vocabulary with its three counts', async () => {
    await start();
    const response = await request({ method: 'GET', url: '/v1/admin/attributes', accessToken: ACCESS_TOKEN });
    expect(response.statusCode).toBe(200);
    const body = AdminAttributeDefinitionsResponseSchema.parse(response.json());
    expect(body.attributes[0]).toMatchObject({
      key: 'width',
      dataType: 'number',
      unit: 'cm',
      optionCount: 0,
      categoryCount: 2,
      answerCount: 7,
    });
  });

  it('returns one attribute with its options', async () => {
    await start();
    const response = await request({
      method: 'GET',
      url: `/v1/admin/attributes/${DEFINITION}`,
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(200);
    const body = AdminAttributeDetailResponseSchema.parse(response.json());
    expect(body.options[0]).toMatchObject({ value: 'oak', answerCount: 3 });
  });

  it('answers 404 for an attribute that does not exist', async () => {
    await start({ missing: true });
    const response = await request({
      method: 'GET',
      url: `/v1/admin/attributes/${DEFINITION}`,
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(404);
  });

  it('answers 400 for a path that cannot name anything', async () => {
    await start();
    const response = await request({
      method: 'GET',
      url: '/v1/admin/attributes/not-a-uuid',
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns 201 and the new identifier from each create', async () => {
    await start();
    const definition = await request({
      method: 'POST',
      url: '/v1/admin/attributes',
      accessToken: ACCESS_TOKEN,
      payload: { key: 'depth', dataType: 'number', nameEn: 'Depth', nameAr: 'العمق', unit: 'cm' },
    });
    expect(definition.statusCode).toBe(201);
    expect(CreateAttributeDefinitionResponseSchema.parse(definition.json()).definitionId).toBe(DEFINITION);

    const option = await request({
      method: 'POST',
      url: `/v1/admin/attributes/${DEFINITION}/options`,
      accessToken: ACCESS_TOKEN,
      payload: { value: 'pine', labelEn: 'Pine', labelAr: 'صنوبر' },
    });
    expect(option.statusCode).toBe(201);
    expect(CreateAttributeOptionResponseSchema.parse(option.json()).optionId).toBe(OPTION);

    const tag = await request({
      method: 'POST',
      url: '/v1/admin/tags',
      accessToken: ACCESS_TOKEN,
      payload: { slug: 'vintage', nameEn: 'Vintage', nameAr: 'عتيق' },
    });
    expect(tag.statusCode).toBe(201);
    expect(CreateTagResponseSchema.parse(tag.json()).tagId).toBe(TAG);
  });

  it('answers whether a write changed anything', async () => {
    await start({ writeChanged: true });
    const response = await request({
      method: 'DELETE',
      url: `/v1/admin/categories/${CATEGORY}/attributes/${DEFINITION}`,
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(200);
    expect(VocabularyWriteResponseSchema.parse(response.json()).changed).toBe(true);
  });

  it('answers that detaching an attribute a category does not ask for changed nothing, not 404', async () => {
    await start({ writeChanged: false });
    const response = await request({
      method: 'DELETE',
      url: `/v1/admin/categories/${CATEGORY}/attributes/${DEFINITION}`,
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(200);
    expect(VocabularyWriteResponseSchema.parse(response.json()).changed).toBe(false);
  });

  it('answers 404 when an edit finds nothing to edit', async () => {
    await start({ writeChanged: false });
    const response = await request({
      method: 'PATCH',
      url: `/v1/admin/attributes/${DEFINITION}`,
      accessToken: ACCESS_TOKEN,
      payload: { nameEn: 'Width', nameAr: 'العرض', isFilterable: true, sortOrder: 1 },
    });
    expect(response.statusCode).toBe(404);
  });

  it('answers 503 when the vocabulary cannot be read', async () => {
    await start({ readError: true });
    const response = await request({ method: 'GET', url: '/v1/admin/attributes', accessToken: ACCESS_TOKEN });
    expect(response.statusCode).toBe(503);
  });
});

describe('what cannot be said', () => {
  it('refuses a key or a data type in an edit', async () => {
    const seen = await start();
    for (const payload of [
      { nameEn: 'W', nameAr: 'ع', isFilterable: true, sortOrder: 1, key: 'renamed' },
      { nameEn: 'W', nameAr: 'ع', isFilterable: true, sortOrder: 1, dataType: 'text' },
    ]) {
      const response = await request({
        method: 'PATCH',
        url: `/v1/admin/attributes/${DEFINITION}`,
        accessToken: ACCESS_TOKEN,
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(seen.filter((entry) => entry.name === 'attributeDefinitionUpdateForStaff')).toHaveLength(0);
  });

  it('refuses an option value in an edit', async () => {
    const seen = await start();
    const response = await request({
      method: 'PATCH',
      url: `/v1/admin/attributes/${DEFINITION}/options/${OPTION}`,
      accessToken: ACCESS_TOKEN,
      payload: { labelEn: 'Oak', labelAr: 'بلوط', sortOrder: 1, value: 'renamed' },
    });
    expect(response.statusCode).toBe(400);
    expect(seen.filter((entry) => entry.name === 'attributeOptionUpdateForStaff')).toHaveLength(0);
  });

  it('refuses a slug in a tag rename', async () => {
    const seen = await start();
    const response = await request({
      method: 'PATCH',
      url: `/v1/admin/tags/${TAG}`,
      accessToken: ACCESS_TOKEN,
      payload: { nameEn: 'Handmade', nameAr: 'يدوي', slug: 'renamed' },
    });
    expect(response.statusCode).toBe(400);
    expect(seen.filter((entry) => entry.name === 'tagUpdateForStaff')).toHaveLength(0);
  });

  it('refuses a unit on an attribute that is not a number, before the database is asked', async () => {
    const seen = await start();
    const response = await request({
      method: 'POST',
      url: '/v1/admin/attributes',
      accessToken: ACCESS_TOKEN,
      payload: { key: 'colour', dataType: 'text', nameEn: 'Colour', nameAr: 'اللون', unit: 'cm' },
    });
    expect(response.statusCode).toBe(400);
    expect(seen.filter((entry) => entry.name === 'attributeDefinitionCreateForStaff')).toHaveLength(0);
  });

  it('refuses an activation request on a create, so a new definition is always hidden', async () => {
    const seen = await start();
    const response = await request({
      method: 'POST',
      url: '/v1/admin/attributes',
      accessToken: ACCESS_TOKEN,
      payload: { key: 'depth', dataType: 'number', nameEn: 'Depth', nameAr: 'العمق', isActive: true },
    });
    expect(response.statusCode).toBe(400);
    expect(seen.filter((entry) => entry.name === 'attributeDefinitionCreateForStaff')).toHaveLength(0);
  });

  it('refuses a blank label', async () => {
    await start();
    const response = await request({
      method: 'PATCH',
      url: `/v1/admin/tags/${TAG}`,
      accessToken: ACCESS_TOKEN,
      payload: { nameEn: '   ', nameAr: 'يدوي' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rebuilds the body from the contract rather than forwarding it', async () => {
    const seen = await start();
    await request({
      method: 'PUT',
      url: `/v1/admin/categories/${CATEGORY}/attributes`,
      accessToken: ACCESS_TOKEN,
      payload: { definitionId: DEFINITION, isRequired: true },
    });
    const attach = seen.find((entry) => entry.name === 'categoryAttributeAttachForStaff');
    expect(attach?.input).toEqual({
      userId: STAFF,
      isAal2: true,
      categoryId: CATEGORY,
      definitionId: DEFINITION,
      isRequired: true,
      // Defaulted by the controller from the contract, never read from the request.
      isFilterable: true,
      sortOrder: 0,
    });
  });
});

describe('how the database’s refusals are reported', () => {
  const CASES = [
    { sqlstate: '23505', status: 409, code: 'ATTRIBUTE_KEY_TAKEN' },
    { sqlstate: '23001', status: 409, code: 'ATTRIBUTE_NOT_ANSWERABLE' },
    { sqlstate: '23514', status: 409, code: 'ATTRIBUTE_VALUE_NOT_ALLOWED' },
    { sqlstate: '23503', status: 404, code: 'NOT_FOUND' },
    // A not-null violation would mean this API sent something it should have caught; it is a failure, not a
    // refusal, so it must never become a confident 409 about a rule nobody wrote.
    { sqlstate: '23502', status: 503, code: 'SERVICE_UNAVAILABLE' },
  ] as const;

  for (const scenario of CASES) {
    it(`reports ${scenario.sqlstate} as ${scenario.status} ${scenario.code}`, async () => {
      await start({ writeError: scenario.sqlstate });
      const response = await request({
        method: 'POST',
        url: '/v1/admin/attributes',
        accessToken: ACCESS_TOKEN,
        payload: { key: 'depth', dataType: 'number', nameEn: 'Depth', nameAr: 'العمق' },
      });
      expect(response.statusCode).toBe(scenario.status);
      expect(response.json().code).toBe(scenario.code);
    });
  }

  it('never forwards the database’s own message', async () => {
    await start({ writeError: '23505' });
    const response = await request({
      method: 'POST',
      url: '/v1/admin/tags',
      accessToken: ACCESS_TOKEN,
      payload: { slug: 'vintage', nameEn: 'Vintage', nameAr: 'عتيق' },
    });
    expect(JSON.stringify(response.json())).not.toContain('the database refused this');
  });

  it('reports a write refused for want of the key as an absence', async () => {
    await start({ permissions: [CATEGORY_READ, TAG_MANAGE] });
    for (const route of WRITES.filter((candidate) => candidate.key === ATTRIBUTE_MANAGE)) {
      const response = await request({ ...route, accessToken: ACCESS_TOKEN });
      expect(response.statusCode, route.url).toBe(404);
    }
  });
});
