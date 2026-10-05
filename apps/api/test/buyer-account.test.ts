import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { SESSION_TOKEN_HEADER } from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BUYER_ACCOUNT_STORE,
  type AddressRow,
  type BuyerProfileRow,
  type BlockRow,
  type BuyerSettingsRow,
  type FavoriteRow,
  type SavedSearchRow,
} from '../src/account/buyer-account.service.js';
import {
  encodeFavoritesCursor,
  encodeSavedSearchesCursor,
} from '../src/account/account-cursor.js';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { AuthenticationRequiredError } from '../src/auth/auth-errors.js';
import { SUPABASE_AUTH_CLIENT } from '../src/auth/login.service.js';
import { CURRENT_USER_STORE } from '../src/users/current-user.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * The buyer account surfaces at the API boundary (Phase 7-E).
 *
 * The assertions that matter are about authority and about what leaks:
 *
 *   * the account is always the caller's own — no route accepts a user identifier anywhere, and the
 *     account every store call is given is the one resolved from the token, never one from the request;
 *   * a row that is not the caller's is indistinguishable from one that does not exist;
 *   * unauthenticated and uncredentialled requests are refused before any store call happens;
 *   * writes are idempotent and report what actually moved;
 *   * nothing on these surfaces can change a role, a permission, a status, a password or a phone number;
 *   * a saved search never schedules anything, whatever `notify` says.
 */

const SESSION_TOKEN = 'caller-access-token-value-not-a-real-token';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '99999999-9999-4999-8999-999999999999';
const LISTING_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const LISTING_B = 'aaaaaaaa-0000-4000-8000-000000000002';
const SAVED_A = 'bbbbbbbb-0000-4000-8000-000000000001';
const ADDRESS_A = 'cccccccc-0000-4000-8000-000000000001';
const CREATED = new Date('2026-09-01T10:00:00.000Z');

function favorite(listingId: string, overrides: Partial<FavoriteRow> = {}): FavoriteRow {
  return {
    listingId,
    createdAt: CREATED,
    isAvailable: true,
    slug: 'sofa',
    title: 'A sofa',
    city: 'Cairo',
    priceMinor: '250000',
    currencyCode: 'EGP',
    currencyMinorUnit: 2,
    isNegotiable: false,
    listingTypeCode: 'product',
    ...overrides,
  };
}

function savedSearch(id: string, overrides: Partial<SavedSearchRow> = {}): SavedSearchRow {
  return {
    id,
    name: 'Sofas',
    query: { q: 'sofa' },
    notify: true,
    lastMatchedAt: null,
    lastNotifiedAt: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

function addressRow(id: string, overrides: Partial<AddressRow> = {}): AddressRow {
  return {
    id,
    label: 'Home',
    purpose: 'both',
    recipientName: 'Amina Hassan',
    phoneE164: '+201000000001',
    countryCode: 'EG',
    governorate: 'Cairo',
    city: 'Cairo',
    district: null,
    streetAddress: '12 Street',
    building: null,
    apartment: null,
    postalCode: null,
    landmark: null,
    isDefaultShipping: true,
    isDefaultBilling: true,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

const PROFILE: BuyerProfileRow = {
  id: USER,
  displayName: 'Amina',
  fullName: 'Amina Hassan',
  phoneE164: '+201000000001',
  localeCode: 'ar',
  timezone: 'Africa/Cairo',
  status: 'active',
  emailVerifiedAt: null,
  phoneVerifiedAt: CREATED,
  createdAt: CREATED,
};

const SETTINGS: BuyerSettingsRow = {
  notifyEmail: true,
  notifySms: false,
  notifyWhatsapp: false,
  notifyInApp: true,
  marketingOptIn: false,
  digitStyle: null,
};

const SETTINGS_BODY = {
  notifyEmail: false,
  notifySms: true,
  notifyWhatsapp: true,
  notifyInApp: false,
  marketingOptIn: true,
  digitStyle: 'arabic_indic' as const,
};

const ADDRESS_BODY = {
  purpose: 'both' as const,
  recipientName: 'Amina Hassan',
  phoneE164: '+201000000001',
  countryCode: 'EG',
  governorate: 'Cairo',
  city: 'Cairo',
  streetAddress: '12 Street',
};

interface Recorded {
  readonly calls: string[];
  readonly args: Array<Record<string, unknown>>;
}

interface Doubles {
  readonly favorites?: FavoriteRow[];
  readonly savedSearches?: SavedSearchRow[];
  readonly addresses?: AddressRow[];
  readonly profile?: BuyerProfileRow | null;
  readonly settings?: BuyerSettingsRow | null;
  readonly favoriteAdd?: 'added' | 'exists' | 'not_found';
  readonly favoriteRemove?: boolean;
  readonly savedSearchCreate?: { outcome: 'created' | 'duplicate_name'; id: string | null };
  readonly savedSearchUpdate?: 'updated' | 'not_found' | 'duplicate_name';
  readonly savedSearchDelete?: boolean;
  readonly addressCreate?: {
    outcome: 'created' | 'country_not_enabled' | 'invalid_country';
    id: string | null;
  };
  readonly addressUpdate?: 'updated' | 'not_found' | 'country_not_enabled' | 'invalid_country';
  readonly addressDelete?: boolean;
  readonly profileUpdate?: 'updated' | 'not_found' | 'invalid_locale' | 'invalid_timezone';
  readonly settingsUpdate?: boolean;
  readonly blocks?: BlockRow[];
  readonly blockAdd?: 'blocked' | 'exists' | 'not_found';
  readonly blockRemove?: boolean;
  readonly throws?: boolean;
  readonly tokenFails?: boolean;
}

let app: NestFastifyApplication | undefined;

async function start(doubles: Doubles = {}): Promise<Recorded> {
  const recorded: Recorded = { calls: [], args: [] };
  const record = <T>(name: string, input: unknown, value: T): T => {
    recorded.calls.push(name);
    recorded.args.push((typeof input === 'object' && input !== null ? input : { input }) as Record<string, unknown>);
    if (doubles.throws === true) throw new Error('database unavailable');
    return value;
  };

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
    .useValue({
      userIdentity: async (userId: string) => ({ id: userId, displayName: 'Amina' }),
    })
    .overrideProvider(BUYER_ACCOUNT_STORE)
    .useValue({
      buyerFavorites: async (input: unknown) => record('favorites', input, doubles.favorites ?? []),
      buyerFavoriteAdd: async (input: unknown) => record('favorite-add', input, doubles.favoriteAdd ?? 'added'),
      buyerFavoriteRemove: async (input: unknown) => record('favorite-remove', input, doubles.favoriteRemove ?? true),
      buyerSavedSearches: async (input: unknown) => record('saved-searches', input, doubles.savedSearches ?? []),
      buyerSavedSearchCreate: async (input: unknown) =>
        record('saved-search-create', input, doubles.savedSearchCreate ?? { outcome: 'created', id: SAVED_A }),
      buyerSavedSearchUpdate: async (input: unknown) =>
        record('saved-search-update', input, doubles.savedSearchUpdate ?? 'updated'),
      buyerSavedSearchDelete: async (input: unknown) =>
        record('saved-search-delete', input, doubles.savedSearchDelete ?? true),
      buyerBlocks: async (input: unknown) => record('blocks', input, doubles.blocks ?? []),
      buyerBlockAdd: async (input: unknown) => record('block-add', input, doubles.blockAdd ?? 'blocked'),
      buyerBlockRemove: async (input: unknown) => record('block-remove', input, doubles.blockRemove ?? true),
      buyerAddresses: async (input: unknown) => record('addresses', input, doubles.addresses ?? []),
      buyerAddressCreate: async (input: unknown) =>
        record('address-create', input, doubles.addressCreate ?? { outcome: 'created', id: ADDRESS_A }),
      buyerAddressUpdate: async (input: unknown) =>
        record('address-update', input, doubles.addressUpdate ?? 'updated'),
      buyerAddressDelete: async (input: unknown) => record('address-delete', input, doubles.addressDelete ?? true),
      buyerProfile: async (input: unknown) =>
        record('profile', input, doubles.profile === undefined ? PROFILE : doubles.profile),
      buyerProfileUpdate: async (input: unknown) => record('profile-update', input, doubles.profileUpdate ?? 'updated'),
      buyerSettings: async (input: unknown) =>
        record('settings', input, doubles.settings === undefined ? SETTINGS : doubles.settings),
      buyerSettingsUpdate: async (input: unknown) =>
        record('settings-update', input, doubles.settingsUpdate ?? true),
      referenceCountries: async () =>
        record('countries', {}, [
          { code: 'EG', nameEn: 'Egypt', nameAr: 'مصر', phoneCode: '20', isMarketplaceEnabled: true },
        ]),
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
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  payload?: unknown,
  headers: Record<string, string | null> = {},
): Promise<Result> {
  const base: Record<string, string> = {
    [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL,
    [SESSION_TOKEN_HEADER]: SESSION_TOKEN,
  };
  // A request with no body declares no content type, exactly as a browser's fetch would.
  if (payload !== undefined) base['content-type'] = 'application/json';
  for (const [name, value] of Object.entries(headers)) {
    if (value === null) delete base[name];
    else base[name] = value;
  }
  const response = await app!.inject({
    method,
    url: `/v1${path}`,
    headers: base,
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
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

describe('7-E authority', () => {
  const routes: Array<[('GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'), string, unknown]> = [
    ['GET', '/users/me/favorites', undefined],
    ['POST', '/users/me/favorites', { listingId: LISTING_A }],
    ['DELETE', `/users/me/favorites/${LISTING_A}`, undefined],
    ['GET', '/users/me/saved-searches', undefined],
    ['POST', '/users/me/saved-searches', { name: 'Sofas', query: {} }],
    ['PATCH', `/users/me/saved-searches/${SAVED_A}`, { name: 'Sofas', query: {} }],
    ['DELETE', `/users/me/saved-searches/${SAVED_A}`, undefined],
    ['GET', '/users/me/blocks', undefined],
    ['POST', '/users/me/blocks', { sellerSlug: 'good-shop' }],
    ['DELETE', '/users/me/blocks/YnIxfG5vdC1yZWFs', undefined],
    ['GET', '/users/me/addresses', undefined],
    ['POST', '/users/me/addresses', ADDRESS_BODY],
    ['PATCH', `/users/me/addresses/${ADDRESS_A}`, ADDRESS_BODY],
    ['DELETE', `/users/me/addresses/${ADDRESS_A}`, undefined],
    ['GET', '/users/me/profile', undefined],
    ['PATCH', '/users/me/profile', { displayName: 'Amina' }],
    ['GET', '/users/me/settings', undefined],
    ['PUT', '/users/me/settings', SETTINGS_BODY],
    ['GET', '/reference/countries', undefined],
  ];

  it('refuses every route without a session, before any store call', async () => {
    for (const [method, path, payload] of routes) {
      const recorded = await start();
      const result = await call(method, path, payload, { [SESSION_TOKEN_HEADER]: null });
      expect(result.status, `${method} ${path}`).toBe(401);
      expect(result.body['code']).toBe('AUTHENTICATION_REQUIRED');
      expect(recorded.calls).toEqual([]);
      await app?.close();
      app = undefined;
    }
  });

  it('refuses every route without the internal credential', async () => {
    for (const [method, path, payload] of routes) {
      const recorded = await start();
      const result = await call(method, path, payload, { [INTERNAL_CREDENTIAL_HEADER]: null });
      expect(result.status, `${method} ${path}`).toBe(403);
      expect(recorded.calls).toEqual([]);
      await app?.close();
      app = undefined;
    }
  });

  it('refuses a token the provider rejects', async () => {
    const recorded = await start({ tokenFails: true });
    const result = await call('GET', '/users/me/favorites');
    expect(result.status).toBe(401);
    expect(recorded.calls).toEqual(['get-user']);
  });

  it('never asks the store about an account the request named', async () => {
    const recorded = await start({ favorites: [favorite(LISTING_A)] });
    await call('GET', `/users/me/favorites?userId=${OTHER_USER}`);
    await call('POST', '/users/me/favorites', { listingId: LISTING_A, userId: OTHER_USER });
    await call('PATCH', '/users/me/profile', { displayName: 'X', userId: OTHER_USER });
    await call('GET', `/users/me/blocks?userId=${OTHER_USER}`);
    await call('POST', '/users/me/blocks', { sellerSlug: 'good-shop', userId: OTHER_USER });

    for (const args of recorded.args) {
      if ('userId' in args) expect(args['userId']).toBe(USER);
      expect(JSON.stringify(args)).not.toContain(OTHER_USER);
    }
  });

  it('refuses a body that names an account, rather than ignoring it', async () => {
    await start();
    const refused = await call('POST', '/users/me/favorites', { listingId: LISTING_A, userId: OTHER_USER });
    expect(refused.status).toBe(400);
    expect(refused.body['code']).toBe('VALIDATION_FAILED');
  });

  it('answers 503 rather than an empty list when the store cannot be reached', async () => {
    await start({ throws: true });
    const result = await call('GET', '/users/me/favorites');
    expect(result.status).toBe(503);
    expect(result.body['code']).toBe('SERVICE_UNAVAILABLE');
    expect(result.raw).not.toContain('database unavailable');
  });
});

/* ------------------------------------------------------------------------------------------------ */

describe('GET /v1/users/me/favorites', () => {
  it('returns the card for a visible listing, with money as a decimal string', async () => {
    await start({ favorites: [favorite(LISTING_A)] });
    const result = await call('GET', '/users/me/favorites');

    expect(result.status).toBe(200);
    expect(Object.keys(result.body).sort()).toEqual(['items', 'nextCursor']);
    const [item] = result.body['items'] as Record<string, unknown>[];
    expect(Object.keys(item!).sort()).toEqual(['isAvailable', 'listing', 'listingId', 'savedAt']);
    const listing = item!['listing'] as Record<string, unknown>;
    expect(listing['priceMinor']).toBe('250000');
    expect(listing['currencyCode']).toBe('EGP');
    expect(listing['currencyMinorUnit']).toBe(2);
  });

  it('returns a withdrawn favorite with no card at all', async () => {
    await start({
      favorites: [
        favorite(LISTING_B, {
          isAvailable: false,
          slug: null,
          title: null,
          city: null,
          priceMinor: null,
          currencyCode: null,
          currencyMinorUnit: null,
          isNegotiable: null,
          listingTypeCode: null,
        }),
      ],
    });
    const result = await call('GET', '/users/me/favorites');

    const [item] = result.body['items'] as Record<string, unknown>[];
    expect(item!['isAvailable']).toBe(false);
    expect(item!['listing']).toBeNull();
    expect(result.raw).not.toContain('sofa');
  });

  it('asks for one more row than the page, and only returns a cursor when there is one', async () => {
    const recorded = await start({ favorites: [favorite(LISTING_A)] });
    await call('GET', '/users/me/favorites?limit=1');
    expect(recorded.args[0]?.['limit']).toBe(2);

    const result = await call('GET', '/users/me/favorites?limit=1');
    expect(result.body['nextCursor']).toBeNull();
  });

  it('pages deterministically', async () => {
    await start({ favorites: [favorite(LISTING_A), favorite(LISTING_B)] });
    const result = await call('GET', '/users/me/favorites?limit=1');
    expect((result.body['items'] as unknown[]).length).toBe(1);
    expect(typeof result.body['nextCursor']).toBe('string');
  });

  it('refuses a cursor from another list, and says only that', async () => {
    await start();
    const foreign = encodeSavedSearchesCursor({ createdAt: CREATED, id: SAVED_A });
    const result = await call('GET', `/users/me/favorites?cursor=${foreign}`);
    expect(result.status).toBe(400);
    expect(result.body['code']).toBe('ACCOUNT_CURSOR_INVALID');
  });

  it.each(['not-base64!', 'YWJj', ''])('refuses the malformed cursor %j', async (cursor) => {
    await start({ favorites: [] });
    const result = await call('GET', `/users/me/favorites?cursor=${encodeURIComponent(cursor)}`);
    // An empty cursor is an absent cursor; anything else is refused.
    expect(result.status).toBe(cursor === '' ? 200 : 400);
  });

  it('accepts its own cursor and passes the decoded position to the store', async () => {
    const recorded = await start();
    const cursor = encodeFavoritesCursor({ createdAt: CREATED, id: LISTING_A });
    const result = await call('GET', `/users/me/favorites?cursor=${cursor}`);
    expect(result.status).toBe(200);
    expect(recorded.args[0]?.['cursorId']).toBe(LISTING_A);
  });

  it('refuses an unusable limit', async () => {
    await start();
    expect((await call('GET', '/users/me/favorites?limit=abc')).status).toBe(400);
  });
});

describe('POST /v1/users/me/favorites', () => {
  it('is idempotent and says which request saved it', async () => {
    await start({ favoriteAdd: 'added' });
    expect((await call('POST', '/users/me/favorites', { listingId: LISTING_A })).body).toEqual({ changed: true });
    await app?.close();
    app = undefined;

    await start({ favoriteAdd: 'exists' });
    expect((await call('POST', '/users/me/favorites', { listingId: LISTING_A })).body).toEqual({ changed: false });
  });

  it('answers 404 for a listing that is not publicly visible', async () => {
    await start({ favoriteAdd: 'not_found' });
    const result = await call('POST', '/users/me/favorites', { listingId: LISTING_A });
    expect(result.status).toBe(404);
    expect(result.body['code']).toBe('NOT_FOUND');
  });

  it('refuses a listing identifier that is not one', async () => {
    await start();
    expect((await call('POST', '/users/me/favorites', { listingId: 'sofa' })).status).toBe(400);
    expect((await call('DELETE', '/users/me/favorites/sofa')).status).toBe(400);
  });
});

describe('DELETE /v1/users/me/favorites/{listingId}', () => {
  it('is idempotent', async () => {
    await start({ favoriteRemove: true });
    expect((await call('DELETE', `/users/me/favorites/${LISTING_A}`)).body).toEqual({ changed: true });
    await app?.close();
    app = undefined;

    await start({ favoriteRemove: false });
    expect((await call('DELETE', `/users/me/favorites/${LISTING_A}`)).body).toEqual({ changed: false });
  });

  it('scopes the removal to the caller', async () => {
    const recorded = await start();
    await call('DELETE', `/users/me/favorites/${LISTING_A}`);
    expect(recorded.args.at(-1)).toEqual({ userId: USER, listingId: LISTING_A });
  });
});

/* ------------------------------------------------------------------------------------------------ */

describe('saved searches', () => {
  it('returns the stored search with both matching timestamps as data', async () => {
    await start({ savedSearches: [savedSearch(SAVED_A)] });
    const result = await call('GET', '/users/me/saved-searches');

    const [item] = result.body['items'] as Record<string, unknown>[];
    expect(Object.keys(item!).sort()).toEqual([
      'createdAt',
      'id',
      'lastMatchedAt',
      'lastNotifiedAt',
      'name',
      'notify',
      'query',
      'updatedAt',
    ]);
    expect(item!['lastMatchedAt']).toBeNull();
    expect(item!['notify']).toBe(true);
  });

  it('creates one and returns only its identifier', async () => {
    await start();
    const result = await call('POST', '/users/me/saved-searches', { name: '  Sofas  ', query: { q: 'sofa' } });
    expect(result.status).toBe(201);
    expect(result.body).toEqual({ id: SAVED_A });
  });

  it('trims the name before the database sees it', async () => {
    const recorded = await start();
    await call('POST', '/users/me/saved-searches', { name: '  Sofas  ', query: {} });
    expect(recorded.args.at(-1)?.['name']).toBe('Sofas');
  });

  it('schedules nothing, whatever notify says', async () => {
    const recorded = await start();
    await call('POST', '/users/me/saved-searches', { name: 'Sofas', query: {}, notify: true });
    // One store call, and it is the writer. No notification, no email, no job.
    expect(recorded.calls.filter((name) => name !== 'get-user')).toEqual(['saved-search-create']);
  });

  it('reports a duplicate name as a conflict the caller can act on', async () => {
    await start({ savedSearchCreate: { outcome: 'duplicate_name', id: null } });
    const result = await call('POST', '/users/me/saved-searches', { name: 'Sofas', query: {} });
    expect(result.status).toBe(409);
    expect(result.body['code']).toBe('SAVED_SEARCH_NAME_TAKEN');
  });

  it('reports another account’s saved search as absent on edit', async () => {
    await start({ savedSearchUpdate: 'not_found' });
    const result = await call('PATCH', `/users/me/saved-searches/${SAVED_A}`, { name: 'X', query: {} });
    expect(result.status).toBe(404);
    expect(result.body['code']).toBe('NOT_FOUND');
  });

  it('refuses a request that tries to set a matching timestamp', async () => {
    await start();
    const result = await call('PATCH', `/users/me/saved-searches/${SAVED_A}`, {
      name: 'X',
      query: {},
      lastMatchedAt: '2026-09-01T00:00:00.000Z',
    });
    expect(result.status).toBe(400);
  });

  it('deletes idempotently', async () => {
    await start({ savedSearchDelete: false });
    const result = await call('DELETE', `/users/me/saved-searches/${SAVED_A}`);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ changed: false });
  });
});

/* ------------------------------------------------------------------------------------------------ */

describe('addresses', () => {
  it('returns the caller’s addresses unpaged and without a geography point', async () => {
    await start({ addresses: [addressRow(ADDRESS_A)] });
    const result = await call('GET', '/users/me/addresses');

    expect(Object.keys(result.body)).toEqual(['items']);
    const [item] = result.body['items'] as Record<string, unknown>[];
    expect(Object.keys(item!).sort()).toEqual([
      'apartment',
      'building',
      'city',
      'countryCode',
      'createdAt',
      'district',
      'governorate',
      'id',
      'isDefaultBilling',
      'isDefaultShipping',
      'label',
      'landmark',
      'phoneE164',
      'postalCode',
      'purpose',
      'recipientName',
      'streetAddress',
      'updatedAt',
    ]);
  });

  it('reports the D17 shipping rule as a conflict the caller can act on', async () => {
    await start({ addressCreate: { outcome: 'country_not_enabled', id: null } });
    const result = await call('POST', '/users/me/addresses', { ...ADDRESS_BODY, countryCode: 'SA' });
    expect(result.status).toBe(409);
    expect(result.body['code']).toBe('ADDRESS_COUNTRY_NOT_SHIPPABLE');
  });

  it('reports an unknown country as a field the caller can correct', async () => {
    await start({ addressCreate: { outcome: 'invalid_country', id: null } });
    const result = await call('POST', '/users/me/addresses', { ...ADDRESS_BODY, countryCode: 'ZZ' });
    expect(result.status).toBe(400);
    expect(result.body['code']).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(result.body['errors'])).toContain('countryCode');
  });

  it('normalises the country code before the database sees it', async () => {
    const recorded = await start();
    await call('POST', '/users/me/addresses', { ...ADDRESS_BODY, countryCode: ' eg ' });
    const address = recorded.args.at(-1)?.['address'] as Record<string, unknown>;
    expect(address['countryCode']).toBe('EG');
  });

  it('refuses a malformed phone before a round trip', async () => {
    const recorded = await start();
    const result = await call('POST', '/users/me/addresses', { ...ADDRESS_BODY, phoneE164: '01000000001' });
    expect(result.status).toBe(400);
    expect(recorded.calls.filter((name) => name !== 'get-user')).toEqual([]);
  });

  it('refuses a default that contradicts its own purpose', async () => {
    await start();
    const result = await call('POST', '/users/me/addresses', {
      ...ADDRESS_BODY,
      purpose: 'billing',
      isDefaultShipping: true,
    });
    expect(result.status).toBe(400);
  });

  it('reports another account’s address as absent', async () => {
    await start({ addressUpdate: 'not_found' });
    const result = await call('PATCH', `/users/me/addresses/${ADDRESS_A}`, ADDRESS_BODY);
    expect(result.status).toBe(404);
  });

  it('removes idempotently', async () => {
    await start({ addressDelete: false });
    expect((await call('DELETE', `/users/me/addresses/${ADDRESS_A}`)).body).toEqual({ changed: false });
  });

  it('accepts nothing about an order or a shipment', async () => {
    await start();
    for (const field of ['orderId', 'shippingMethod', 'location', 'userId']) {
      const result = await call('POST', '/users/me/addresses', { ...ADDRESS_BODY, [field]: 'x' });
      expect(result.status, field).toBe(400);
    }
  });
});

/* ------------------------------------------------------------------------------------------------ */

describe('profile', () => {
  it('returns the caller’s own profile and nothing about a role', async () => {
    await start();
    const result = await call('GET', '/users/me/profile');

    expect(result.status).toBe(200);
    const profile = result.body['profile'] as Record<string, unknown>;
    expect(Object.keys(profile).sort()).toEqual([
      'createdAt',
      'displayName',
      'emailVerifiedAt',
      'fullName',
      'id',
      'localeCode',
      'phoneE164',
      'phoneVerifiedAt',
      'status',
      'timezone',
    ]);
    expect(result.raw).not.toMatch(/role|permission|password|token/i);
  });

  it('answers 404 for a deleted profile', async () => {
    await start({ profile: null });
    const result = await call('GET', '/users/me/profile');
    expect(result.status).toBe(404);
  });

  it('writes the four fields a person owns and nothing else', async () => {
    const recorded = await start();
    await call('PATCH', '/users/me/profile', { displayName: 'Amina', fullName: 'Amina Hassan', localeCode: 'ar', timezone: 'Africa/Cairo' });
    expect(Object.keys(recorded.args.at(-1) ?? {}).sort()).toEqual([
      'displayName',
      'fullName',
      'localeCode',
      'timezone',
      'userId',
    ]);
  });

  it.each(['phoneE164', 'status', 'emailVerifiedAt', 'phoneVerifiedAt', 'role', 'deletedAt', 'id'])(
    'refuses a profile write carrying %s',
    async (field) => {
      const recorded = await start();
      const result = await call('PATCH', '/users/me/profile', { displayName: 'Amina', [field]: 'x' });
      expect(result.status).toBe(400);
      expect(recorded.calls.filter((name) => name !== 'get-user')).toEqual([]);
    },
  );

  it('reports an unknown locale and timezone as correctable fields', async () => {
    await start({ profileUpdate: 'invalid_locale' });
    const locale = await call('PATCH', '/users/me/profile', { localeCode: 'zz' });
    expect(locale.status).toBe(400);
    expect(JSON.stringify(locale.body['errors'])).toContain('localeCode');
    await app?.close();
    app = undefined;

    await start({ profileUpdate: 'invalid_timezone' });
    const zone = await call('PATCH', '/users/me/profile', { timezone: 'Mars/Olympus' });
    expect(zone.status).toBe(400);
    expect(JSON.stringify(zone.body['errors'])).toContain('timezone');
  });
});

/* ------------------------------------------------------------------------------------------------ */

describe('settings', () => {
  it('returns the schema’s own switches and never the preferences object', async () => {
    await start();
    const result = await call('GET', '/users/me/settings');

    const settings = result.body['settings'] as Record<string, unknown>;
    expect(Object.keys(settings).sort()).toEqual([
      'digitStyle',
      'marketingOptIn',
      'notifyEmail',
      'notifyInApp',
      'notifySms',
      'notifyWhatsapp',
    ]);
    expect(result.raw).not.toContain('preferences');
  });

  it('is a whole-state write and is idempotent', async () => {
    await start();
    expect((await call('PUT', '/users/me/settings', SETTINGS_BODY)).body).toEqual({ changed: true });
    expect((await call('PUT', '/users/me/settings', SETTINGS_BODY)).body).toEqual({ changed: true });
  });

  it('refuses a partial write, because there is no merge rule', async () => {
    await start();
    expect((await call('PUT', '/users/me/settings', { notifyEmail: false })).status).toBe(400);
  });

  it.each(['preferences', 'role', 'permissions', 'commissionRate'])(
    'refuses a settings write carrying %s',
    async (field) => {
      const recorded = await start();
      const result = await call('PUT', '/users/me/settings', { ...SETTINGS_BODY, [field]: 'x' });
      expect(result.status).toBe(400);
      expect(recorded.calls.filter((name) => name !== 'get-user')).toEqual([]);
    },
  );

  it('refuses a digit style the schema does not define', async () => {
    await start();
    expect((await call('PUT', '/users/me/settings', { ...SETTINGS_BODY, digitStyle: 'roman' })).status).toBe(400);
  });
});

describe('country reference', () => {
  it('returns both names and the flag, behind the session', async () => {
    await start();
    const result = await call('GET', '/reference/countries');
    expect(result.status).toBe(200);
    expect(result.body['items']).toEqual([
      { code: 'EG', nameEn: 'Egypt', nameAr: 'مصر', phoneCode: '20', isMarketplaceEnabled: true },
    ]);
  });
});
