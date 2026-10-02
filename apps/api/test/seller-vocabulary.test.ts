import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  SESSION_TOKEN_HEADER,
  SellerListingAttributesResponseSchema,
  SellerListingAttributesWriteResponseSchema,
  SellerListingTagsResponseSchema,
} from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { AuthenticationRequiredError } from '../src/auth/auth-errors.js';
import { SELLER_VOCABULARY_STORE } from '../src/sellers/seller-vocabulary.service.js';
import { SUPABASE_AUTH_CLIENT } from '../src/auth/login.service.js';
import { CURRENT_USER_STORE } from '../src/users/current-user.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * A seller's own attribute answers and tags, at the API boundary.
 *
 * The properties this suite exists for:
 *
 * **`is_required` is advisory.** A required attribute left unanswered saves, and nothing on this surface calls,
 * imports or reaches a submission writer — asserted by driving the save with the required attribute missing and
 * by checking that no store method but the two savers was touched.
 *
 * **The surface is the route's.** The eight routes are driven in pairs, and each asserts that the listing type it
 * passed to the database is the one its own path names, never anything from the request.
 *
 * **The caller is their own token.** No route takes a seller, an owner or an account; the id that reaches the
 * store is the one the session resolved to.
 *
 * **Option identifiers never leave the API.** The store answers with ids and a second reader's values; the
 * response is asserted to carry values only, and an id with no option behind it is dropped rather than forwarded.
 *
 * **An absence and somebody else's listing are the same 404**, and a refused answer is a 409 with its own code
 * rather than a validation failure, because the request was well formed and the catalogue is what refused it.
 *
 * Everything is stubbed at the store boundary: no database, no Redis, no network.
 */

const SELLER = '22222222-2222-4222-8222-222222222222';
const DEFINITION = 'dd000000-0000-4000-8000-0000000000d1';
const OPTION = 'ee000000-0000-4000-8000-0000000000e1';

function token(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.c2lnbmF0dXJl`;
}

const ACCESS_TOKEN = token({ sub: SELLER, aal: 'aal1' });

interface Seen {
  readonly name: string;
  readonly input: unknown;
}

interface Doubles {
  readonly unauthenticated?: boolean;
  readonly context?: 'found' | 'not_found';
  readonly isEditable?: boolean;
  readonly outcome?: string;
  readonly readError?: boolean;
  readonly strayOptionId?: boolean;
  readonly dataType?: string;
}

let app: NestFastifyApplication | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(doubles: Doubles = {}): Promise<Seen[]> {
  const seen: Seen[] = [];

  const store = {
    sellerListingVocabularyContext: async (input: unknown) => {
      seen.push({ name: 'sellerListingVocabularyContext', input });
      if (doubles.readError === true) throw new Error('the database could not be reached');
      return {
        outcome: doubles.context ?? 'found',
        isEditable: doubles.isEditable ?? true,
      };
    },
    sellerListingAttributes: async (input: unknown) => {
      seen.push({ name: 'sellerListingAttributes', input });
      return [
        {
          definitionId: DEFINITION,
          key: 'width',
          dataType: doubles.dataType ?? 'number',
          unit: 'cm',
          label: 'Width',
          isRequired: true,
          sortOrder: 1,
          valueText: null,
          valueNumber: 180,
          valueBoolean: null,
          optionIds: [],
        },
        {
          definitionId: 'dd000000-0000-4000-8000-0000000000d2',
          key: 'material',
          dataType: 'single_select',
          unit: null,
          label: 'Material',
          isRequired: false,
          sortOrder: 2,
          valueText: null,
          valueNumber: null,
          valueBoolean: null,
          // A stray id models the two readers disagreeing: it must be dropped, not forwarded.
          optionIds: doubles.strayOptionId === true ? ['99999999-9999-4999-8999-999999999999'] : [OPTION],
        },
      ];
    },
    sellerListingAttributeOptions: async (input: unknown) => {
      seen.push({ name: 'sellerListingAttributeOptions', input });
      return [
        {
          definitionId: 'dd000000-0000-4000-8000-0000000000d2',
          optionId: OPTION,
          value: 'oak',
          label: 'Oak',
          sortOrder: 1,
        },
      ];
    },
    sellerListingAttributesSave: async (input: unknown) => {
      seen.push({ name: 'sellerListingAttributesSave', input });
      return { outcome: doubles.outcome ?? 'saved' };
    },
    sellerListingTagChoices: async (input: unknown) => {
      seen.push({ name: 'sellerListingTagChoices', input });
      return [
        { slug: 'handmade', label: 'Handmade', isSelected: true },
        { slug: 'vintage', label: 'Vintage', isSelected: false },
      ];
    },
    sellerListingTagsSave: async (input: unknown) => {
      seen.push({ name: 'sellerListingTagsSave', input });
      return { outcome: doubles.outcome ?? 'saved' };
    },
  };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(TEST_ENV)] })
    .overrideProvider(SUPABASE_AUTH_CLIENT)
    .useValue({
      getUser: async () => {
        if (doubles.unauthenticated === true) throw new AuthenticationRequiredError();
        return { id: SELLER, phone: null };
      },
      signInWithPassword: async () => {
        throw new Error('answering an attribute must never sign anyone in');
      },
      revokeAllSessions: async () => {
        throw new Error('answering an attribute must never revoke a session');
      },
    })
    .overrideProvider(CURRENT_USER_STORE)
    .useValue({ userIdentity: async (userId: string) => ({ id: userId, displayName: 'Nadia' }) })
    .overrideProvider(SELLER_VOCABULARY_STORE)
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

/** All eight routes, with the listing type each one must pass to the database. */
const ROUTES = [
  { method: 'GET', url: '/v1/sellers/me/listings/oak-table/attributes', surface: 'product' },
  {
    method: 'POST',
    url: '/v1/sellers/me/listings/oak-table/attributes',
    surface: 'product',
    payload: { answers: [] },
  },
  { method: 'GET', url: '/v1/sellers/me/listings/oak-table/tags', surface: 'product' },
  { method: 'POST', url: '/v1/sellers/me/listings/oak-table/tags', surface: 'product', payload: { tags: [] } },
  { method: 'GET', url: '/v1/sellers/me/services/a-service/attributes', surface: 'service' },
  {
    method: 'POST',
    url: '/v1/sellers/me/services/a-service/attributes',
    surface: 'service',
    payload: { answers: [] },
  },
  { method: 'GET', url: '/v1/sellers/me/services/a-service/tags', surface: 'service' },
  { method: 'POST', url: '/v1/sellers/me/services/a-service/tags', surface: 'service', payload: { tags: [] } },
] as const;

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

  it('refuses every route when the token names nobody', async () => {
    await start({ unauthenticated: true });
    for (const route of ROUTES) {
      const response = await request({ ...route, accessToken: ACCESS_TOKEN });
      expect(response.statusCode, route.url).toBe(401);
    }
  });

  it('passes the caller’s own id and no identifier from the request', async () => {
    const seen = await start();
    await request({
      method: 'GET',
      url: '/v1/sellers/me/listings/oak-table/attributes',
      accessToken: ACCESS_TOKEN,
    });
    for (const entry of seen) {
      expect(entry.input).toMatchObject({ userId: SELLER });
    }
  });

  it('passes the listing type its own path names, on all eight routes', async () => {
    for (const route of ROUTES) {
      const seen = await start();
      await request({ ...route, accessToken: ACCESS_TOKEN });
      expect(seen.length, route.url).toBeGreaterThan(0);
      for (const entry of seen) {
        expect(entry.input, `${route.url} → ${entry.name}`).toMatchObject({ expectedType: route.surface });
      }
      await app?.close();
      app = undefined;
    }
  });

  it('answers 404 for a listing that is not the caller’s, on every route', async () => {
    await start({ context: 'not_found', outcome: 'not_found' });
    for (const route of ROUTES) {
      const response = await request({ ...route, accessToken: ACCESS_TOKEN });
      expect(response.statusCode, route.url).toBe(404);
    }
  });
});

describe('what a seller is asked', () => {
  it('returns the questions, the answers and the choices', async () => {
    await start();
    const response = await request({
      method: 'GET',
      url: '/v1/sellers/me/listings/oak-table/attributes',
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(200);
    const body = SellerListingAttributesResponseSchema.parse(response.json());

    expect(body.isEditable).toBe(true);
    expect(body.attributes[0]).toMatchObject({
      key: 'width',
      dataType: 'number',
      unit: 'cm',
      isRequired: true,
      number: 180,
      options: [],
      choices: [],
    });
    expect(body.attributes[1]).toMatchObject({
      key: 'material',
      dataType: 'single_select',
      // Values, never identifiers.
      options: ['oak'],
      choices: [{ value: 'oak', label: 'Oak' }],
    });
  });

  it('carries no option identifier anywhere in the response', async () => {
    await start();
    const response = await request({
      method: 'GET',
      url: '/v1/sellers/me/listings/oak-table/attributes',
      accessToken: ACCESS_TOKEN,
    });
    expect(JSON.stringify(response.json())).not.toContain(OPTION);
    expect(JSON.stringify(response.json())).not.toContain(DEFINITION);
  });

  it('drops a chosen option with no option behind it rather than forwarding it', async () => {
    await start({ strayOptionId: true });
    const response = await request({
      method: 'GET',
      url: '/v1/sellers/me/listings/oak-table/attributes',
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(200);
    const body = SellerListingAttributesResponseSchema.parse(response.json());
    expect(body.attributes[1]?.options).toEqual([]);
  });

  it('reports a listing that is no longer a draft as not editable, and still answers', async () => {
    await start({ isEditable: false });
    const response = await request({
      method: 'GET',
      url: '/v1/sellers/me/listings/oak-table/attributes',
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(200);
    expect(SellerListingAttributesResponseSchema.parse(response.json()).isEditable).toBe(false);
  });

  it('returns every active tag with whether this listing carries it', async () => {
    await start();
    const response = await request({
      method: 'GET',
      url: '/v1/sellers/me/listings/oak-table/tags',
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(200);
    const body = SellerListingTagsResponseSchema.parse(response.json());
    expect(body.tags).toEqual([
      { slug: 'handmade', name: 'Handmade', isSelected: true },
      { slug: 'vintage', name: 'Vintage', isSelected: false },
    ]);
  });

  it('answers 503 when the listing cannot be looked up', async () => {
    await start({ readError: true });
    const response = await request({
      method: 'GET',
      url: '/v1/sellers/me/listings/oak-table/attributes',
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(503);
  });

  it('answers 503 for an attribute whose data type this API does not know', async () => {
    await start({ dataType: 'colour' });
    const response = await request({
      method: 'GET',
      url: '/v1/sellers/me/listings/oak-table/attributes',
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(503);
  });
});

describe('answering', () => {
  it('sends one payload member per answer, shaped by its kind', async () => {
    const seen = await start();
    const response = await request({
      method: 'POST',
      url: '/v1/sellers/me/listings/oak-table/attributes',
      accessToken: ACCESS_TOKEN,
      payload: {
        answers: [
          { kind: 'number', key: 'width', number: 180 },
          { kind: 'text', key: 'note', text: 'A note' },
          { kind: 'boolean', key: 'assembled', boolean: true },
          { kind: 'single_select', key: 'material', options: ['oak'] },
          { kind: 'multi_select', key: 'features', options: ['folding', 'extendable'] },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(SellerListingAttributesWriteResponseSchema.parse(response.json())).toEqual({
      slug: 'oak-table',
      saved: true,
    });

    const save = seen.find((entry) => entry.name === 'sellerListingAttributesSave');
    expect(save?.input).toEqual({
      userId: SELLER,
      slug: 'oak-table',
      expectedType: 'product',
      answers: [
        { key: 'width', number: 180 },
        { key: 'note', text: 'A note' },
        { key: 'assembled', boolean: true },
        { key: 'material', options: ['oak'] },
        { key: 'features', options: ['folding', 'extendable'] },
      ],
    });
  });

  it('refuses an answer that carries the wrong field for its kind', async () => {
    const seen = await start();
    for (const answer of [
      { kind: 'number', key: 'width', text: '180' },
      { kind: 'text', key: 'note', number: 1 },
      { kind: 'boolean', key: 'assembled', options: ['yes'] },
      { kind: 'single_select', key: 'material', text: 'oak' },
      // A kind that is not one of the five.
      { kind: 'colour', key: 'colour', text: 'red' },
    ]) {
      const response = await request({
        method: 'POST',
        url: '/v1/sellers/me/listings/oak-table/attributes',
        accessToken: ACCESS_TOKEN,
        payload: { answers: [answer] },
      });
      expect(response.statusCode, JSON.stringify(answer)).toBe(400);
    }
    expect(seen.filter((entry) => entry.name === 'sellerListingAttributesSave')).toHaveLength(0);
  });

  it('refuses two options on a single-select and none on either select', async () => {
    const seen = await start();
    for (const answer of [
      { kind: 'single_select', key: 'material', options: ['oak', 'pine'] },
      { kind: 'single_select', key: 'material', options: [] },
      { kind: 'multi_select', key: 'features', options: [] },
    ]) {
      const response = await request({
        method: 'POST',
        url: '/v1/sellers/me/listings/oak-table/attributes',
        accessToken: ACCESS_TOKEN,
        payload: { answers: [answer] },
      });
      expect(response.statusCode, JSON.stringify(answer)).toBe(400);
    }
    expect(seen.filter((entry) => entry.name === 'sellerListingAttributesSave')).toHaveLength(0);
  });

  it('refuses the same attribute answered twice', async () => {
    await start();
    const response = await request({
      method: 'POST',
      url: '/v1/sellers/me/listings/oak-table/attributes',
      accessToken: ACCESS_TOKEN,
      payload: {
        answers: [
          { kind: 'number', key: 'width', number: 180 },
          { kind: 'number', key: 'width', number: 200 },
        ],
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses a blank text answer and one past the column’s length', async () => {
    await start();
    for (const text of ['   ', 'x'.repeat(501)]) {
      const response = await request({
        method: 'POST',
        url: '/v1/sellers/me/listings/oak-table/attributes',
        accessToken: ACCESS_TOKEN,
        payload: { answers: [{ kind: 'text', key: 'note', text }] },
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it('accepts an empty set, which is how a seller clears every answer', async () => {
    const seen = await start();
    const response = await request({
      method: 'POST',
      url: '/v1/sellers/me/listings/oak-table/attributes',
      accessToken: ACCESS_TOKEN,
      payload: { answers: [] },
    });
    expect(response.statusCode).toBe(200);
    expect(seen.find((entry) => entry.name === 'sellerListingAttributesSave')?.input).toMatchObject({
      answers: [],
    });
  });

  it('reports a refused answer as 409 with its own code, not as a validation failure', async () => {
    await start({ outcome: 'invalid' });
    const response = await request({
      method: 'POST',
      url: '/v1/sellers/me/listings/oak-table/attributes',
      accessToken: ACCESS_TOKEN,
      payload: { answers: [{ kind: 'single_select', key: 'material', options: ['mahogany'] }] },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('LISTING_ATTRIBUTE_ANSWER_NOT_ALLOWED');
  });

  it('reports a listing that is not a draft as 409 not-editable', async () => {
    await start({ outcome: 'not_editable' });
    const response = await request({
      method: 'POST',
      url: '/v1/sellers/me/listings/oak-table/attributes',
      accessToken: ACCESS_TOKEN,
      payload: { answers: [] },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('SELLER_LISTING_NOT_EDITABLE');
  });

  it('answers 503 for an outcome it does not understand, rather than reporting success', async () => {
    await start({ outcome: 'something_else' });
    const response = await request({
      method: 'POST',
      url: '/v1/sellers/me/listings/oak-table/attributes',
      accessToken: ACCESS_TOKEN,
      payload: { answers: [] },
    });
    expect(response.statusCode).toBe(503);
  });
});

describe('is_required is advisory in this increment', () => {
  it('saves a set that leaves the required attribute unanswered', async () => {
    const seen = await start();
    // `width` is the required one the reader reports; this save answers only the optional attribute.
    const response = await request({
      method: 'POST',
      url: '/v1/sellers/me/listings/oak-table/attributes',
      accessToken: ACCESS_TOKEN,
      payload: { answers: [{ kind: 'single_select', key: 'material', options: ['oak'] }] },
    });
    expect(response.statusCode).toBe(200);

    const save = seen.find((entry) => entry.name === 'sellerListingAttributesSave');
    expect(save?.input).toMatchObject({ answers: [{ key: 'material', options: ['oak'] }] });
  });

  it('saves an empty set even though an attribute is required', async () => {
    await start();
    const response = await request({
      method: 'POST',
      url: '/v1/sellers/me/listings/oak-table/attributes',
      accessToken: ACCESS_TOKEN,
      payload: { answers: [] },
    });
    expect(response.statusCode).toBe(200);
  });

  it('tells the seller which attributes are required, which is all the flag does here', async () => {
    await start();
    const response = await request({
      method: 'GET',
      url: '/v1/sellers/me/listings/oak-table/attributes',
      accessToken: ACCESS_TOKEN,
    });
    const body = SellerListingAttributesResponseSchema.parse(response.json());
    expect(body.attributes.map((attribute) => attribute.isRequired)).toEqual([true, false]);
  });

  it('touches nothing but the two savers, so no submission writer is reachable from here', async () => {
    const seen = await start();
    await request({
      method: 'POST',
      url: '/v1/sellers/me/listings/oak-table/attributes',
      accessToken: ACCESS_TOKEN,
      payload: { answers: [] },
    });
    await request({
      method: 'POST',
      url: '/v1/sellers/me/listings/oak-table/tags',
      accessToken: ACCESS_TOKEN,
      payload: { tags: ['handmade'] },
    });
    expect(seen.map((entry) => entry.name)).toEqual([
      'sellerListingAttributesSave',
      'sellerListingTagsSave',
    ]);
  });
});

describe('tagging', () => {
  it('replaces the selection by slug', async () => {
    const seen = await start();
    const response = await request({
      method: 'POST',
      url: '/v1/sellers/me/services/a-service/tags',
      accessToken: ACCESS_TOKEN,
      payload: { tags: ['handmade', 'vintage'] },
    });
    expect(response.statusCode).toBe(200);
    expect(seen.find((entry) => entry.name === 'sellerListingTagsSave')?.input).toEqual({
      userId: SELLER,
      slug: 'a-service',
      expectedType: 'service',
      tags: ['handmade', 'vintage'],
    });
  });

  it('accepts an empty array, which removes every tag', async () => {
    const seen = await start();
    const response = await request({
      method: 'POST',
      url: '/v1/sellers/me/listings/oak-table/tags',
      accessToken: ACCESS_TOKEN,
      payload: { tags: [] },
    });
    expect(response.statusCode).toBe(200);
    expect(seen.find((entry) => entry.name === 'sellerListingTagsSave')?.input).toMatchObject({ tags: [] });
  });

  it('refuses the same tag twice, a badly shaped slug and anything but an array', async () => {
    const seen = await start();
    for (const payload of [
      { tags: ['handmade', 'handmade'] },
      { tags: ['Handmade'] },
      { tags: 'handmade' },
      { tags: [{ slug: 'handmade' }] },
      {},
    ]) {
      const response = await request({
        method: 'POST',
        url: '/v1/sellers/me/listings/oak-table/tags',
        accessToken: ACCESS_TOKEN,
        payload,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(seen.filter((entry) => entry.name === 'sellerListingTagsSave')).toHaveLength(0);
  });

  it('reports an unknown or hidden tag as 409, with the whole selection refused', async () => {
    await start({ outcome: 'invalid' });
    const response = await request({
      method: 'POST',
      url: '/v1/sellers/me/listings/oak-table/tags',
      accessToken: ACCESS_TOKEN,
      payload: { tags: ['handmade', 'retired'] },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('LISTING_ATTRIBUTE_ANSWER_NOT_ALLOWED');
  });
});
