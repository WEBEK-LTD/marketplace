import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { SellerServicesResponseSchema, SESSION_TOKEN_HEADER } from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { AuthenticationRequiredError } from '../src/auth/auth-errors.js';
import { DURABLE_THROTTLE_COUNTER, REDIS_THROTTLE_COUNTER } from '../src/auth/login-throttle.service.js';
import { SUPABASE_AUTH_CLIENT } from '../src/auth/login.service.js';
import { SELLER_STORE } from '../src/catalog/sellers.service.js';
import { SELLER_IDENTITY_STORE } from '../src/sellers/seller-identity.service.js';
import { SELLER_LISTING_STORE } from '../src/sellers/seller-listing.service.js';
import {
  SELLER_SERVICE_STORE,
  type SellerServiceCreateInput,
  type SellerServiceUpdateInput,
  type SellerServicesQuery,
} from '../src/sellers/seller-service.service.js';
import { SELLER_THROTTLE_BUCKETS } from '../src/sellers/seller-throttle.service.js';
import { CURRENT_USER_STORE } from '../src/users/current-user.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * The three `/v1/sellers/me/services` operations at the API boundary (Phase 6-G).
 *
 * Seven properties carry this suite.
 *
 * **There is no fourth or fifth operation.** A service is submitted and archived through the listing routes,
 * and the assertions below drive those against a service slug to prove it — and check that no
 * `/services/{slug}/submission` or `/services/{slug}/archive` route exists to be found.
 *
 * **The owner, the type and the state are not negotiable.** Every attempt to send `sellerUserId`,
 * `listingTypeCode`, `status`, `listingId` or a timestamp is *refused* by the strict contract rather than
 * ignored, and every store call carries the token's own user id.
 *
 * **Absent, null and a value are three different things, and for the pricing model null is a fourth.** All
 * of it is asserted at the store boundary, where the set-flags are.
 *
 * **The state and detail gates are the database's, reported faithfully.** `not_found`, `not_editable`,
 * `slug_taken` and `invalid` each become one status with one code, and no body carries a reason, a
 * moderation note, a constraint name or a column name.
 *
 * **The limit is 6-F's approved bucket, not a new one.** A service write is a listing draft write, so it
 * counts against `seller_listing_draft` — asserted by name and by number, with Redis taken away and then
 * both layers, which must fail closed.
 *
 * **Money round-trips as a string.** The price is carried as a decimal string in both directions, because
 * that is how this repository carries `listings.price_minor`, and a number would lose the top of a bigint.
 *
 * **Nothing leaks.** No token, no internal credential, no SQL, no identifier — asserted against raw text.
 *
 * Everything is stubbed at the store and counter boundaries: no database, no Redis, no provider, no network.
 */

const ACCESS_TOKEN = 'caller-access-token-value-not-a-real-token';
const CALLER = '11111111-1111-4111-8111-111111111111';

const ROW = {
  slug: 'logo-design',
  title: 'Logo Design',
  description: 'I will design a logo for you.',
  categorySlug: 'design',
  status: 'draft',
  currencyCode: 'EGP',
  currencyMinorUnit: 2,
  priceMinor: '9900' as string | null,
  isNegotiable: false,
  contentLanguage: 'en',
  countryCode: 'EG',
  governorate: null as string | null,
  city: 'Cairo' as string | null,
  pricingModel: 'fixed' as string | null,
  deliveryDays: 5 as number | null,
  revisionsIncluded: 2 as number | null,
  requiresBrief: true as boolean | null,
  scope: 'Two concepts.' as string | null,
  mediaCount: 0,
  createdAt: new Date('2026-05-01T10:00:00.000Z'),
  updatedAt: new Date('2026-05-02T10:00:00.000Z'),
  submittedAt: null as Date | null,
  archivedAt: null as Date | null,
};

const VALID_CREATE = {
  slug: 'logo-design',
  title: 'Logo Design',
  description: 'I will design a logo for you.',
  categorySlug: 'design',
  contentLanguage: 'en',
  currencyCode: 'EGP',
  countryCode: 'EG',
};

interface Recorded {
  readonly queries: SellerServicesQuery[];
  readonly creates: SellerServiceCreateInput[];
  readonly updates: SellerServiceUpdateInput[];
  readonly listingSubmits: { userId: string; slug: string }[];
  readonly listingArchives: { userId: string; slug: string }[];
  readonly buckets: string[];
  readonly durableBuckets: string[];
}

interface Doubles {
  readonly outcome?: string;
  readonly rows?: number;
  readonly rowStatus?: string;
  readonly bareDetails?: boolean;
  readonly badPricingModel?: boolean;
  readonly storeThrows?: boolean;
  readonly unauthenticated?: boolean;
  readonly counting?: boolean;
  readonly redisThrows?: boolean;
  readonly durableThrows?: boolean;
  readonly nullWriteRow?: boolean;
}

let app: NestFastifyApplication | undefined;

async function start(doubles: Doubles = {}): Promise<Recorded> {
  const recorded: Recorded = {
    queries: [],
    creates: [],
    updates: [],
    listingSubmits: [],
    listingArchives: [],
    buckets: [],
    durableBuckets: [],
  };

  const counts = new Map<string, number>();
  const count = (bucket: string, limit: number): boolean => {
    const next = (counts.get(bucket) ?? 0) + 1;
    counts.set(bucket, next);
    return next <= limit;
  };

  const redis = {
    hit: async (bucket: string, _subject: Buffer, _windowSeconds: number, limit: number) => {
      recorded.buckets.push(bucket);
      if (doubles.redisThrows === true) throw new Error('redis unavailable');
      return doubles.counting === true ? count(bucket, limit) : true;
    },
  };
  const durable = {
    hit: async (bucket: string, _subject: Buffer, _windowSeconds: number, limit: number) => {
      recorded.durableBuckets.push(bucket);
      if (doubles.durableThrows === true) throw new Error('database unavailable');
      return doubles.counting === true ? count(bucket, limit) : true;
    },
  };

  const write = (success: string) => {
    if (doubles.storeThrows === true) throw new Error('database unavailable');
    const outcome = doubles.outcome ?? success;
    if (outcome !== success || doubles.nullWriteRow === true) {
      return { outcome, slug: null, status: null };
    }
    return { outcome, slug: ROW.slug, status: doubles.rowStatus ?? 'draft' };
  };

  const serviceStore = {
    sellerServices: async (query: SellerServicesQuery) => {
      recorded.queries.push(query);
      if (doubles.storeThrows === true) throw new Error('database unavailable');
      const total = doubles.rows ?? 1;
      return Array.from({ length: total }, (_value, index) => ({
        ...ROW,
        slug: `${ROW.slug}-${String(index)}`,
        createdAt: new Date(ROW.createdAt.getTime() - index * 1000),
        ...(doubles.bareDetails === true
          ? {
              pricingModel: null,
              deliveryDays: null,
              revisionsIncluded: null,
              requiresBrief: null,
              scope: null,
            }
          : {}),
        ...(doubles.badPricingModel === true ? { pricingModel: 'hourly' } : {}),
      }));
    },
    sellerServiceCreateDraft: async (input: SellerServiceCreateInput) => {
      recorded.creates.push(input);
      return write('created');
    },
    sellerServiceUpdateDraft: async (input: SellerServiceUpdateInput) => {
      recorded.updates.push(input);
      return write('updated');
    },
  };

  // 6-F's store, so the listing transitions can be driven against a service slug.
  const listingStore = {
    sellerListings: async () => [],
    sellerListingCreateDraft: async () => ({ outcome: 'created', slug: ROW.slug, status: 'draft' }),
    sellerListingUpdateDraft: async () => ({ outcome: 'updated', slug: ROW.slug, status: 'draft' }),
    sellerListingSubmit: async (input: { userId: string; slug: string }) => {
      recorded.listingSubmits.push(input);
      return { outcome: 'submitted', slug: input.slug, status: 'pending_review' };
    },
    sellerListingArchive: async (input: { userId: string; slug: string }) => {
      recorded.listingArchives.push(input);
      return { outcome: 'archived', slug: input.slug, status: 'archived' };
    },
  };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(TEST_ENV)] })
    .overrideProvider(SUPABASE_AUTH_CLIENT)
    .useValue({
      getUser: async () => {
        if (doubles.unauthenticated === true) throw new AuthenticationRequiredError();
        return { id: CALLER, phone: null };
      },
      signInWithPassword: async () => {
        throw new Error('a service operation must never sign anyone in');
      },
      revokeAllSessions: async () => {
        throw new Error('a service operation must never revoke a session');
      },
    })
    .overrideProvider(CURRENT_USER_STORE)
    .useValue({ userIdentity: async (userId: string) => ({ id: userId, displayName: 'Nadia' }) })
    .overrideProvider(REDIS_THROTTLE_COUNTER)
    .useValue(redis)
    .overrideProvider(DURABLE_THROTTLE_COUNTER)
    .useValue(durable)
    .overrideProvider(SELLER_SERVICE_STORE)
    .useValue(serviceStore)
    .overrideProvider(SELLER_LISTING_STORE)
    .useValue(listingStore)
    .overrideProvider(SELLER_IDENTITY_STORE)
    .useValue({
      sellerIdentity: async () => ({
        slug: 'svc-shop',
        displayName: 'Service Shop',
        status: 'active',
        verificationStatus: 'verified',
        city: 'Cairo',
        countryCode: 'EG',
      }),
    })
    .overrideProvider(SELLER_STORE)
    .useValue({ publicSellerBySlug: async () => ({ outcome: 'not_found' as const }) })
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
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Result> {
  const response = await app!.inject({
    method,
    url,
    headers: {
      [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL,
      [SESSION_TOKEN_HEADER]: ACCESS_TOKEN,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
  const raw = response.body;
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  return { status: response.statusCode, body: parsed, raw };
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('reading the caller’s own services', () => {
  it('answers the contract, with the caller’s own id and no identifier of any kind', async () => {
    const recorded = await start({ rows: 2 });
    const result = await call('GET', '/v1/sellers/me/services');

    expect(result.status).toBe(200);
    expect(SellerServicesResponseSchema.safeParse(result.body).success).toBe(true);
    expect(recorded.queries[0]?.userId).toBe(CALLER);
    expect(result.raw).not.toContain(CALLER);
    for (const field of [
      'sellerUserId',
      'listingId',
      'categoryId',
      'listingTypeCode',
      'approvedAt',
      'publishedAt',
      'deletedAt',
      'viewCount',
    ]) {
      expect(result.raw, field).not.toContain(field);
    }
  });

  it('carries the price as a string and the currency’s own minor unit beside it', async () => {
    await start();
    const result = await call('GET', '/v1/sellers/me/services');
    const first = (result.body as { services: Record<string, unknown>[] }).services[0]!;

    expect(first['priceMinor']).toBe('9900');
    expect(first['currencyMinorUnit']).toBe(2);
  });

  it('returns nulls for a service with no detail row rather than inventing defaults', async () => {
    await start({ bareDetails: true });
    const result = await call('GET', '/v1/sellers/me/services');
    const first = (result.body as { services: Record<string, unknown>[] }).services[0]!;

    expect(first['pricingModel']).toBeNull();
    expect(first['deliveryDays']).toBeNull();
    // Not 0 and not false: "stated nothing" is different from "stated zero".
    expect(first['revisionsIncluded']).toBeNull();
    expect(first['requiresBrief']).toBeNull();
  });

  it('refuses a row carrying a pricing model the contract does not know', async () => {
    await start({ badPricingModel: true });
    const result = await call('GET', '/v1/sellers/me/services');
    expect(result.status).toBe(503);
    expect(result.raw).not.toContain('hourly');
  });

  it('accepts no seller of any kind from the query string', async () => {
    const recorded = await start();
    await call('GET', '/v1/sellers/me/services?userId=someone&sellerUserId=else');
    expect(recorded.queries[0]?.userId).toBe(CALLER);
  });

  it('reads one row longer than the page, so nextCursor is null exactly on the last page', async () => {
    const recorded = await start({ rows: 2 });
    const result = await call('GET', '/v1/sellers/me/services?limit=5');

    expect(recorded.queries[0]?.limit).toBe(6);
    expect((result.body as { services: unknown[] }).services).toHaveLength(2);
    expect(result.body['nextCursor']).toBeNull();
  });

  it('resumes from a cursor it issued, and refuses one it did not', async () => {
    const recorded = await start({ rows: 4 });
    const first = await call('GET', '/v1/sellers/me/services?limit=3');
    const cursor = String(first.body['nextCursor']);

    const second = await call('GET', `/v1/sellers/me/services?cursor=${encodeURIComponent(cursor)}`);
    expect(second.status).toBe(200);
    expect(recorded.queries[1]?.cursorSlug).toBe('logo-design-2');

    const bad = await call('GET', '/v1/sellers/me/services?cursor=not-a-cursor');
    expect(bad.status).toBe(400);
    expect(bad.body['code']).toBe('SELLER_LISTING_CURSOR_INVALID');
  });

  it('clamps the page size rather than trusting it', async () => {
    const recorded = await start();
    await call('GET', '/v1/sellers/me/services?limit=5000');
    await call('GET', '/v1/sellers/me/services?limit=0');
    await call('GET', '/v1/sellers/me/services?limit=nonsense');

    expect(recorded.queries[0]?.limit).toBe(51);
    expect(recorded.queries[1]?.limit).toBe(2);
    expect(recorded.queries[2]?.limit).toBe(21);
  });

  it('is not throttled: reading one’s own rows is not a mutation', async () => {
    const recorded = await start();
    await call('GET', '/v1/sellers/me/services');
    expect(recorded.buckets).toEqual([]);
    expect(recorded.durableBuckets).toEqual([]);
  });

  it('answers 401 without a session and 403 without the internal credential', async () => {
    await start();
    expect(
      (await call('GET', '/v1/sellers/me/services', undefined, { [SESSION_TOKEN_HEADER]: '' })).status,
    ).toBe(401);
    expect(
      (await call('GET', '/v1/sellers/me/services', undefined, { [INTERNAL_CREDENTIAL_HEADER]: 'x' })).status,
    ).toBe(403);
  });
});

describe('creating a service draft', () => {
  it('creates one, answering 201 with the address and the committed status', async () => {
    const recorded = await start();
    const result = await call('POST', '/v1/sellers/me/services', VALID_CREATE);

    expect(result.status).toBe(201);
    expect(result.body['listing']).toEqual({ slug: 'logo-design', status: 'draft' });
    expect(recorded.creates[0]?.userId).toBe(CALLER);
    expect(recorded.creates[0]?.slug).toBe('logo-design');
  });

  it('creates a draft with no price, no media and no detail row', async () => {
    const recorded = await start();
    expect((await call('POST', '/v1/sellers/me/services', VALID_CREATE)).status).toBe(201);

    expect(recorded.creates[0]?.priceMinor).toBeNull();
    expect(recorded.creates[0]?.pricingModel).toBeNull();
    expect(JSON.stringify(recorded.creates[0])).not.toContain('media');
  });

  it('passes the five detail fields through when they are stated', async () => {
    const recorded = await start();
    await call('POST', '/v1/sellers/me/services', {
      ...VALID_CREATE,
      priceMinor: '9900',
      pricingModel: 'fixed',
      deliveryDays: 7,
      revisionsIncluded: 3,
      requiresBrief: true,
      scope: 'Two concepts.',
    });
    const sent = recorded.creates[0]!;

    expect(sent.priceMinor).toBe('9900');
    expect(sent.pricingModel).toBe('fixed');
    expect(sent.deliveryDays).toBe(7);
    expect(sent.revisionsIncluded).toBe(3);
    expect(sent.requiresBrief).toBe(true);
    expect(sent.scope).toBe('Two concepts.');
  });

  it('never sends a listing type: the operation creates a service and nothing else', async () => {
    const recorded = await start();
    await call('POST', '/v1/sellers/me/services', VALID_CREATE);
    expect(JSON.stringify(recorded.creates[0])).not.toContain('listingType');
  });

  it.each([
    ['a listing type', { ...VALID_CREATE, listingTypeCode: 'product' }],
    ['a status', { ...VALID_CREATE, status: 'active' }],
    ['a seller', { ...VALID_CREATE, sellerUserId: CALLER }],
    ['a user id', { ...VALID_CREATE, userId: CALLER }],
    ['a listing id', { ...VALID_CREATE, listingId: '33333333-3333-4333-8333-333333333333' }],
    ['an approval time', { ...VALID_CREATE, approvedAt: '2026-05-01T00:00:00.000Z' }],
    ['a view count', { ...VALID_CREATE, viewCount: 99 }],
    ['a category id', { ...VALID_CREATE, categoryId: '44444444-4444-4444-8444-444444444444' }],
  ])('refuses a body carrying %s rather than ignoring it', async (_name, body) => {
    const recorded = await start();
    const result = await call('POST', '/v1/sellers/me/services', body);

    expect(result.status).toBe(400);
    expect(result.body['code']).toBe('VALIDATION_FAILED');
    expect(recorded.creates).toHaveLength(0);
  });

  it.each([
    ['an unknown pricing model', { ...VALID_CREATE, pricingModel: 'hourly' }],
    ['a delivery time of zero', { ...VALID_CREATE, pricingModel: 'fixed', deliveryDays: 0 }],
    ['a delivery time of 366', { ...VALID_CREATE, pricingModel: 'fixed', deliveryDays: 366 }],
    ['a negative revision count', { ...VALID_CREATE, pricingModel: 'custom', revisionsIncluded: -1 }],
    ['an over-long scope', { ...VALID_CREATE, pricingModel: 'custom', scope: 's'.repeat(5001) }],
    ['a numeric price', { ...VALID_CREATE, priceMinor: 9900 }],
    ['a decimal price', { ...VALID_CREATE, priceMinor: '99.00' }],
  ])('refuses %s at the contract', async (_name, body) => {
    const recorded = await start();
    expect((await call('POST', '/v1/sellers/me/services', body)).status).toBe(400);
    expect(recorded.creates).toHaveLength(0);
  });

  it.each([
    ['not_found', 404, 'NOT_FOUND'],
    ['not_editable', 409, 'SELLER_PROFILE_NOT_EDITABLE'],
    ['slug_taken', 409, 'SELLER_LISTING_SLUG_TAKEN'],
    ['invalid', 400, 'VALIDATION_FAILED'],
  ])('turns the database outcome %s into %i', async (outcome, status, code) => {
    await start({ outcome });
    const result = await call('POST', '/v1/sellers/me/services', VALID_CREATE);
    expect(result.status).toBe(status);
    expect(result.body['code']).toBe(code);
  });

  it('counts against 6-F’s approved draft bucket rather than a new service one', async () => {
    const recorded = await start();
    await call('POST', '/v1/sellers/me/services', VALID_CREATE);

    expect(recorded.buckets).toEqual([SELLER_THROTTLE_BUCKETS.listingDraft.name]);
    expect(recorded.buckets[0]).toBe('seller_listing_draft');
    // There is no service bucket to count against, and none was invented.
    expect(Object.values(SELLER_THROTTLE_BUCKETS).map((b) => b.name)).not.toContain(
      'seller_service_draft',
    );
  });

  it('refuses the twenty-first draft write of the hour, service or listing', async () => {
    const recorded = await start({ counting: true });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect((await call('POST', '/v1/sellers/me/services', VALID_CREATE)).status).toBe(201);
    }
    const refused = await call('POST', '/v1/sellers/me/services', VALID_CREATE);
    expect(refused.status).toBe(429);
    expect(refused.body['code']).toBe('THROTTLED');
    expect(new Set(recorded.buckets)).toEqual(new Set([SELLER_THROTTLE_BUCKETS.listingDraft.name]));
  });

  it('continues in the durable counter when Redis cannot answer', async () => {
    const recorded = await start({ redisThrows: true });
    expect((await call('POST', '/v1/sellers/me/services', VALID_CREATE)).status).toBe(201);
    expect(recorded.durableBuckets).toEqual([SELLER_THROTTLE_BUCKETS.listingDraft.name]);
  });

  it('fails closed when neither counter can answer', async () => {
    const recorded = await start({ redisThrows: true, durableThrows: true });
    expect((await call('POST', '/v1/sellers/me/services', VALID_CREATE)).status).toBe(503);
    expect(recorded.creates).toHaveLength(0);
  });
});

describe('editing a service draft', () => {
  it('edits one, answering 200 with the committed status', async () => {
    const recorded = await start();
    const result = await call('PATCH', '/v1/sellers/me/services/logo-design', { title: 'Logo Design Pro' });

    expect(result.status).toBe(200);
    expect(result.body['listing']).toEqual({ slug: 'logo-design', status: 'draft' });
    expect(recorded.updates[0]?.userId).toBe(CALLER);
    expect(recorded.updates[0]?.slug).toBe('logo-design');
  });

  it('tells an omitted field from one sent as null from one with a value', async () => {
    const recorded = await start();
    await call('PATCH', '/v1/sellers/me/services/logo-design', {
      title: 'Renamed',
      deliveryDays: null,
      revisionsIncluded: 4,
    });
    const sent = recorded.updates[0]!;

    expect(sent.setTitle).toBe(true);
    expect(sent.title).toBe('Renamed');
    expect(sent.setDeliveryDays).toBe(true);
    expect(sent.deliveryDays).toBeNull();
    expect(sent.setRevisionsIncluded).toBe(true);
    expect(sent.revisionsIncluded).toBe(4);
    expect(sent.setDescription).toBe(false);
    expect(sent.setPricingModel).toBe(false);
    expect(sent.setScope).toBe(false);
  });

  it('carries a withdrawn pricing model as a set flag with a null value', async () => {
    const recorded = await start();
    await call('PATCH', '/v1/sellers/me/services/logo-design', { pricingModel: null });
    const sent = recorded.updates[0]!;

    // The one field whose null means more than "empty this column": it withdraws the detail row.
    expect(sent.setPricingModel).toBe(true);
    expect(sent.pricingModel).toBeNull();
    expect(sent.setDeliveryDays).toBe(false);
  });

  it('accepts an empty edit, which changes nothing', async () => {
    const recorded = await start();
    expect((await call('PATCH', '/v1/sellers/me/services/logo-design', {})).status).toBe(200);
    const sent = recorded.updates[0]!;
    for (const flag of [
      sent.setTitle,
      sent.setDescription,
      sent.setPriceMinor,
      sent.setIsNegotiable,
      sent.setContentLanguage,
      sent.setCurrencyCode,
      sent.setCountryCode,
      sent.setGovernorate,
      sent.setCity,
      sent.setPricingModel,
      sent.setDeliveryDays,
      sent.setRevisionsIncluded,
      sent.setRequiresBrief,
      sent.setScope,
    ]) {
      expect(flag).toBe(false);
    }
  });

  it.each([
    ['a slug', { slug: 'a-different-address' }],
    ['a status', { status: 'active' }],
    ['a listing type', { listingTypeCode: 'product' }],
    ['a category', { categorySlug: 'other' }],
    ['a seller', { sellerUserId: CALLER }],
    ['an approval time', { approvedAt: '2026-05-01T00:00:00.000Z' }],
    ['a view count', { viewCount: 12 }],
  ])('refuses an edit carrying %s rather than ignoring it', async (_name, body) => {
    const recorded = await start();
    expect((await call('PATCH', '/v1/sellers/me/services/logo-design', body)).status).toBe(400);
    expect(recorded.updates).toHaveLength(0);
  });

  it.each([
    ['a cleared title', { title: null }],
    ['a cleared description', { description: null }],
    ['a cleared currency', { currencyCode: null }],
    ['a cleared revision count', { revisionsIncluded: null }],
    ['a cleared brief requirement', { requiresBrief: null }],
  ])('refuses %s: those columns can be changed but never emptied', async (_name, body) => {
    const recorded = await start();
    expect((await call('PATCH', '/v1/sellers/me/services/logo-design', body)).status).toBe(400);
    expect(recorded.updates).toHaveLength(0);
  });

  it.each([
    ['not_found', 404, 'NOT_FOUND'],
    ['not_editable', 409, 'SELLER_LISTING_NOT_EDITABLE'],
    ['invalid', 400, 'VALIDATION_FAILED'],
  ])('turns the database outcome %s into %i', async (outcome, status, code) => {
    await start({ outcome });
    const result = await call('PATCH', '/v1/sellers/me/services/logo-design', { title: 'Renamed Svc' });
    expect(result.status).toBe(status);
    expect(result.body['code']).toBe(code);
  });

  it('says nothing about moderation when a service is not editable', async () => {
    await start({ outcome: 'not_editable' });
    const result = await call('PATCH', '/v1/sellers/me/services/logo-design', { title: 'Renamed Svc' });
    const lower = result.raw.toLowerCase();
    for (const word of ['moderat', 'reject', 'suspend', 'approv', 'reason', 'review']) {
      expect(lower, word).not.toContain(word);
    }
  });

  it('counts against the same approved draft bucket', async () => {
    const recorded = await start();
    await call('PATCH', '/v1/sellers/me/services/logo-design', { title: 'Renamed Svc' });
    expect(recorded.buckets).toEqual([SELLER_THROTTLE_BUCKETS.listingDraft.name]);
  });
});

describe('submitting and archiving a service', () => {
  it('has no service submission or archive route: those transitions are the listing ones', async () => {
    await start();
    for (const url of [
      '/v1/sellers/me/services/logo-design/submission',
      '/v1/sellers/me/services/logo-design/archive',
    ]) {
      expect((await call('POST', url)).status, url).toBe(404);
    }
  });

  it('submits a service through the listing route, which is already service-aware', async () => {
    const recorded = await start();
    const result = await call('POST', '/v1/sellers/me/listings/logo-design/submission');

    expect(result.status).toBe(200);
    expect(result.body['listing']).toEqual({ slug: 'logo-design', status: 'pending_review' });
    expect(recorded.listingSubmits).toEqual([{ userId: CALLER, slug: 'logo-design' }]);
  });

  it('archives a service through the listing route', async () => {
    const recorded = await start();
    const result = await call('POST', '/v1/sellers/me/listings/logo-design/archive');

    expect(result.status).toBe(200);
    expect(result.body['listing']).toEqual({ slug: 'logo-design', status: 'archived' });
    expect(recorded.listingArchives).toEqual([{ userId: CALLER, slug: 'logo-design' }]);
  });

  it('counts a submission against the approved submission bucket, not the draft one', async () => {
    const recorded = await start();
    await call('POST', '/v1/sellers/me/listings/logo-design/submission');
    expect(recorded.buckets).toEqual([SELLER_THROTTLE_BUCKETS.listingSubmission.name]);
  });
});

describe('what this surface cannot do', () => {
  it('offers no DELETE anywhere: a seller archives, and nobody deletes', async () => {
    const recorded = await start();
    for (const url of ['/v1/sellers/me/services', '/v1/sellers/me/services/logo-design']) {
      expect((await call('DELETE', url)).status, url).toBe(404);
    }
    expect(recorded.updates).toHaveLength(0);
  });

  it('offers no PUT anywhere: nothing replaces a service wholesale', async () => {
    await start();
    for (const url of ['/v1/sellers/me/services', '/v1/sellers/me/services/logo-design']) {
      expect((await call('PUT', url, VALID_CREATE)).status, url).toBe(404);
    }
  });

  it('leaves the frozen seller routes exactly as they were', async () => {
    await start();
    expect((await call('GET', '/v1/sellers/me')).status).toBe(200);
    expect((await call('GET', '/v1/sellers/me/listings')).status).toBe(200);
    expect((await call('DELETE', '/v1/sellers/me')).status).toBe(404);
    expect((await call('PUT', '/v1/sellers/me/listings')).status).toBe(404);
  });

  it('never returns a token, a credential or an identifier', async () => {
    await start({ rows: 3 });
    const results = [
      await call('GET', '/v1/sellers/me/services'),
      await call('POST', '/v1/sellers/me/services', VALID_CREATE),
      await call('PATCH', '/v1/sellers/me/services/logo-design', { title: 'Renamed Svc' }),
    ];
    for (const result of results) {
      expect(result.raw).not.toContain(ACCESS_TOKEN);
      expect(result.raw).not.toContain(TEST_INTERNAL_CREDENTIAL);
      expect(result.raw).not.toContain(CALLER);
    }
  });

  it('reports a write whose row came back empty as unavailable rather than as a success', async () => {
    await start({ nullWriteRow: true });
    expect((await call('POST', '/v1/sellers/me/services', VALID_CREATE)).status).toBe(503);
  });

  it('reports an outcome it does not understand as unavailable, and never echoes it', async () => {
    await start({ outcome: 'something_else' });
    const result = await call('POST', '/v1/sellers/me/services', VALID_CREATE);
    expect(result.status).toBe(503);
    expect(result.raw).not.toContain('something_else');
  });

  it('answers 401 for every operation without a session, and asks the store nothing', async () => {
    const recorded = await start({ unauthenticated: true });
    expect((await call('GET', '/v1/sellers/me/services')).status).toBe(401);
    expect((await call('POST', '/v1/sellers/me/services', VALID_CREATE)).status).toBe(401);
    expect((await call('PATCH', '/v1/sellers/me/services/logo-design', { title: 'X Y Z' })).status).toBe(401);

    expect(recorded.queries).toHaveLength(0);
    expect(recorded.creates).toHaveLength(0);
    expect(recorded.updates).toHaveLength(0);
  });

  it('answers 403 for every operation without the internal credential', async () => {
    await start();
    const headers = { [INTERNAL_CREDENTIAL_HEADER]: 'wrong-credential' };
    expect((await call('GET', '/v1/sellers/me/services', undefined, headers)).status).toBe(403);
    expect((await call('POST', '/v1/sellers/me/services', VALID_CREATE, headers)).status).toBe(403);
    expect(
      (await call('PATCH', '/v1/sellers/me/services/logo-design', { title: 'X Y Z' }, headers)).status,
    ).toBe(403);
  });
});
