import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { SellerListingsResponseSchema, SESSION_TOKEN_HEADER } from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { AuthenticationRequiredError } from '../src/auth/auth-errors.js';
import { DURABLE_THROTTLE_COUNTER, REDIS_THROTTLE_COUNTER } from '../src/auth/login-throttle.service.js';
import { SUPABASE_AUTH_CLIENT } from '../src/auth/login.service.js';
import { SELLER_STORE } from '../src/catalog/sellers.service.js';
import { SELLER_IDENTITY_STORE } from '../src/sellers/seller-identity.service.js';
import {
  SELLER_LISTING_STORE,
  type SellerListingCreateInput,
  type SellerListingUpdateInput,
  type SellerListingsQuery,
} from '../src/sellers/seller-listing.service.js';
import { SELLER_THROTTLE_BUCKETS } from '../src/sellers/seller-throttle.service.js';
import { CURRENT_USER_STORE } from '../src/users/current-user.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * The five `/v1/sellers/me/listings` operations at the API boundary (Phase 6-F).
 *
 * Six properties carry this suite.
 *
 * **The owner, the address and the state are not negotiable.** Every attempt below to send `sellerUserId`,
 * `userId`, `status`, `listingId`, `approvedAt` or any other protected field is *refused* by the strict
 * contract rather than ignored, and every store call carries the token's own user id. Refusal is asserted
 * rather than absence, because a quietly dropped `"status": "active"` looks like success to whoever sent it.
 *
 * **Absent and null are different requests, all the way down.** The three states each editable field can be
 * in are asserted at the store boundary: a field the body omits arrives with its set-flag false, a field sent
 * as `null` arrives with the flag true and a null value, and a field with a value arrives with both.
 *
 * **The state gates are the database's, reported faithfully.** `not_found`, `not_editable`, `slug_taken`,
 * `incomplete` and `invalid` each become one status with one code, and no body carries a reason, a
 * moderation note, a constraint name or a column name.
 *
 * **Submission and archival take no body.** Not "ignore the body": there is no schema on those routes at
 * all, so there is nothing a request could say, and the store is called with the slug and the caller alone.
 *
 * **The limits are the approved ones, in their own buckets.** Twenty draft writes and ten submissions per
 * account per hour, exercised at the boundary of each, with Redis taken away and then both layers — which
 * must fail closed rather than open.
 *
 * **Nothing leaks.** No token, no internal credential, no SQL, no identifier — asserted against raw text.
 *
 * Everything is stubbed at the store and counter boundaries: no database, no Redis, no provider, no network.
 */

const ACCESS_TOKEN = 'caller-access-token-value-not-a-real-token';
const CALLER = '11111111-1111-4111-8111-111111111111';

const ROW = {
  slug: 'a-chair',
  title: 'A Chair',
  description: 'A very fine chair indeed.',
  listingTypeCode: 'product',
  categorySlug: 'widgets',
  status: 'draft',
  currencyCode: 'EGP',
  priceMinor: 9900,
  isNegotiable: false,
  contentLanguage: 'en',
  countryCode: 'EG',
  governorate: null as string | null,
  city: 'Cairo' as string | null,
  mediaCount: 2,
  createdAt: new Date('2026-05-01T10:00:00.000Z'),
  updatedAt: new Date('2026-05-02T10:00:00.000Z'),
  submittedAt: null as Date | null,
  archivedAt: null as Date | null,
};

const VALID_CREATE = {
  slug: 'a-chair',
  title: 'A Chair',
  description: 'A very fine chair indeed.',
  listingTypeCode: 'product',
  categorySlug: 'widgets',
  contentLanguage: 'en',
  currencyCode: 'EGP',
  countryCode: 'EG',
};

interface Recorded {
  readonly queries: SellerListingsQuery[];
  readonly creates: SellerListingCreateInput[];
  readonly updates: SellerListingUpdateInput[];
  readonly submits: { userId: string; slug: string }[];
  readonly archives: { userId: string; slug: string }[];
  readonly buckets: string[];
  readonly durableBuckets: string[];
}

interface Doubles {
  readonly outcome?: string;
  readonly rows?: number;
  readonly rowStatus?: string;
  readonly storeThrows?: boolean;
  readonly unauthenticated?: boolean;
  readonly counting?: boolean;
  readonly redisThrows?: boolean;
  readonly durableThrows?: boolean;
  readonly badRowStatus?: boolean;
  readonly nullWriteRow?: boolean;
}

let app: NestFastifyApplication | undefined;

async function start(doubles: Doubles = {}): Promise<Recorded> {
  const recorded: Recorded = {
    queries: [],
    creates: [],
    updates: [],
    submits: [],
    archives: [],
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

  const listingStore = {
    sellerListings: async (query: SellerListingsQuery) => {
      recorded.queries.push(query);
      if (doubles.storeThrows === true) throw new Error('database unavailable');
      const total = doubles.rows ?? 1;
      return Array.from({ length: total }, (_value, index) => ({
        ...ROW,
        slug: `${ROW.slug}-${String(index)}`,
        status: doubles.badRowStatus === true ? 'deleted' : ROW.status,
        createdAt: new Date(ROW.createdAt.getTime() - index * 1000),
      }));
    },
    sellerListingCreateDraft: async (input: SellerListingCreateInput) => {
      recorded.creates.push(input);
      return write('created');
    },
    sellerListingUpdateDraft: async (input: SellerListingUpdateInput) => {
      recorded.updates.push(input);
      return write('updated');
    },
    sellerListingSubmit: async (input: { userId: string; slug: string }) => {
      recorded.submits.push(input);
      return write('submitted');
    },
    sellerListingArchive: async (input: { userId: string; slug: string }) => {
      recorded.archives.push(input);
      return write('archived');
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
        throw new Error('a listing operation must never sign anyone in');
      },
      revokeAllSessions: async () => {
        throw new Error('a listing operation must never revoke a session');
      },
    })
    .overrideProvider(CURRENT_USER_STORE)
    .useValue({ userIdentity: async (userId: string) => ({ id: userId, displayName: 'Nadia' }) })
    .overrideProvider(REDIS_THROTTLE_COUNTER)
    .useValue(redis)
    .overrideProvider(DURABLE_THROTTLE_COUNTER)
    .useValue(durable)
    .overrideProvider(SELLER_LISTING_STORE)
    .useValue(listingStore)
    .overrideProvider(SELLER_IDENTITY_STORE)
    .useValue({
      sellerIdentity: async () => ({
        slug: 'good-shop',
        displayName: 'Good Shop',
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

describe('reading the caller’s own listings', () => {
  it('answers the contract, with the caller’s own id and no identifier of any kind', async () => {
    const recorded = await start({ rows: 2 });
    const result = await call('GET', '/v1/sellers/me/listings');

    expect(result.status).toBe(200);
    expect(SellerListingsResponseSchema.safeParse(result.body).success).toBe(true);
    expect(recorded.queries[0]?.userId).toBe(CALLER);
    // The one thing a listings page must never carry.
    expect(result.raw).not.toContain(CALLER);
    expect(result.raw).not.toContain('sellerUserId');
    expect(result.raw).not.toContain('approvedAt');
    expect(result.raw).not.toContain('publishedAt');
    expect(result.raw).not.toContain('deletedAt');
    expect(result.raw).not.toContain('viewCount');
    expect(result.raw).not.toContain('categoryId');
  });

  it('accepts no seller of any kind from the query string', async () => {
    const recorded = await start();
    await call('GET', `/v1/sellers/me/listings?userId=${'2'.repeat(8)}&sellerUserId=someone-else`);
    // The store was asked about the token's account, and nothing in the URL changed that.
    expect(recorded.queries[0]?.userId).toBe(CALLER);
  });

  it('reads one row longer than the page, so nextCursor is null exactly on the last page', async () => {
    const recorded = await start({ rows: 2 });
    const result = await call('GET', '/v1/sellers/me/listings?limit=5');

    expect(recorded.queries[0]?.limit).toBe(6);
    expect((result.body as { listings: unknown[] }).listings).toHaveLength(2);
    expect(result.body['nextCursor']).toBeNull();
  });

  it('reports a cursor when there is another page, and that cursor is opaque', async () => {
    await start({ rows: 4 });
    const result = await call('GET', '/v1/sellers/me/listings?limit=3');

    expect((result.body as { listings: unknown[] }).listings).toHaveLength(3);
    const cursor = result.body['nextCursor'];
    expect(typeof cursor).toBe('string');
    // Not a readable sort key: a client that parsed it would depend on an order that is not contracted.
    expect(String(cursor)).not.toContain('a-chair');
    expect(String(cursor)).not.toContain('2026');
  });

  it('resumes from a cursor it issued, and refuses one it did not', async () => {
    const recorded = await start({ rows: 4 });
    const first = await call('GET', '/v1/sellers/me/listings?limit=3');
    const cursor = String(first.body['nextCursor']);

    const second = await call('GET', `/v1/sellers/me/listings?cursor=${encodeURIComponent(cursor)}`);
    expect(second.status).toBe(200);
    expect(recorded.queries[1]?.cursorSlug).toBe('a-chair-2');

    const bad = await call('GET', '/v1/sellers/me/listings?cursor=not-a-cursor');
    expect(bad.status).toBe(400);
    expect(bad.body['code']).toBe('SELLER_LISTING_CURSOR_INVALID');
  });

  it('clamps the page size rather than trusting it', async () => {
    const recorded = await start();
    await call('GET', '/v1/sellers/me/listings?limit=5000');
    await call('GET', '/v1/sellers/me/listings?limit=0');
    await call('GET', '/v1/sellers/me/listings?limit=nonsense');

    expect(recorded.queries[0]?.limit).toBe(51);
    expect(recorded.queries[1]?.limit).toBe(2);
    expect(recorded.queries[2]?.limit).toBe(21);
  });

  it('is not throttled: reading one’s own rows is not a mutation', async () => {
    const recorded = await start();
    await call('GET', '/v1/sellers/me/listings');
    expect(recorded.buckets).toEqual([]);
    expect(recorded.durableBuckets).toEqual([]);
  });

  it('refuses a row carrying a status the contract does not know, rather than passing it on', async () => {
    await start({ badRowStatus: true });
    const result = await call('GET', '/v1/sellers/me/listings');
    expect(result.status).toBe(503);
    expect(result.raw).not.toContain('deleted');
  });

  it('answers 401 without a session and 403 without the internal credential', async () => {
    await start();
    expect((await call('GET', '/v1/sellers/me/listings', undefined, { [SESSION_TOKEN_HEADER]: '' })).status).toBe(401);
    expect(
      (await call('GET', '/v1/sellers/me/listings', undefined, { [INTERNAL_CREDENTIAL_HEADER]: 'wrong' })).status,
    ).toBe(403);
  });
});

describe('creating a draft', () => {
  it('creates one, answering 201 with the address and the committed status', async () => {
    const recorded = await start();
    const result = await call('POST', '/v1/sellers/me/listings', VALID_CREATE);

    expect(result.status).toBe(201);
    expect(result.body['listing']).toEqual({ slug: 'a-chair', status: 'draft' });
    expect(recorded.creates[0]?.userId).toBe(CALLER);
    expect(recorded.creates[0]?.slug).toBe('a-chair');
  });

  it('creates a draft with no price and no media, which is what S-9 requires', async () => {
    const recorded = await start();
    const result = await call('POST', '/v1/sellers/me/listings', VALID_CREATE);

    expect(result.status).toBe(201);
    expect(recorded.creates[0]?.priceMinor).toBeNull();
    // There is no media field anywhere in the request, so a draft cannot be made to require one.
    expect(JSON.stringify(recorded.creates[0])).not.toContain('media');
  });

  it.each([
    ['status', { ...VALID_CREATE, status: 'active' }],
    ['a seller', { ...VALID_CREATE, sellerUserId: CALLER }],
    ['a user id', { ...VALID_CREATE, userId: CALLER }],
    ['a listing id', { ...VALID_CREATE, id: '33333333-3333-4333-8333-333333333333' }],
    ['an approval time', { ...VALID_CREATE, approvedAt: '2026-05-01T00:00:00.000Z' }],
    ['a submission time', { ...VALID_CREATE, submittedAt: '2026-05-01T00:00:00.000Z' }],
    ['a view count', { ...VALID_CREATE, viewCount: 99 }],
    ['a category id', { ...VALID_CREATE, categoryId: '44444444-4444-4444-8444-444444444444' }],
  ])('refuses a body carrying %s rather than ignoring it', async (_name, body) => {
    const recorded = await start();
    const result = await call('POST', '/v1/sellers/me/listings', body);

    expect(result.status).toBe(400);
    expect(result.body['code']).toBe('VALIDATION_FAILED');
    // Nothing reached the database: the refusal is the whole request, not a dropped field.
    expect(recorded.creates).toHaveLength(0);
  });

  it.each([
    ['a slug with capitals', { ...VALID_CREATE, slug: 'A-Chair' }],
    ['a two-character title', { ...VALID_CREATE, title: 'ab' }],
    ['a nine-character description', { ...VALID_CREATE, description: 'too short' }],
    ['an unknown listing type', { ...VALID_CREATE, listingTypeCode: 'gizmo' }],
    ['a negative price', { ...VALID_CREATE, priceMinor: -1 }],
    ['a fractional price', { ...VALID_CREATE, priceMinor: 1.5 }],
    ['a four-letter currency', { ...VALID_CREATE, currencyCode: 'EGPP' }],
    ['a three-letter country', { ...VALID_CREATE, countryCode: 'EGY' }],
  ])('refuses %s at the contract', async (_name, body) => {
    const recorded = await start();
    expect((await call('POST', '/v1/sellers/me/listings', body)).status).toBe(400);
    expect(recorded.creates).toHaveLength(0);
  });

  it.each([
    ['not_found', 404, 'NOT_FOUND'],
    ['not_editable', 409, 'SELLER_PROFILE_NOT_EDITABLE'],
    ['slug_taken', 409, 'SELLER_LISTING_SLUG_TAKEN'],
    ['invalid', 400, 'VALIDATION_FAILED'],
  ])('turns the database outcome %s into %i', async (outcome, status, code) => {
    await start({ outcome });
    const result = await call('POST', '/v1/sellers/me/listings', VALID_CREATE);
    expect(result.status).toBe(status);
    expect(result.body['code']).toBe(code);
  });

  it('says nothing about who holds a taken address', async () => {
    await start({ outcome: 'slug_taken' });
    const result = await call('POST', '/v1/sellers/me/listings', VALID_CREATE);
    expect(result.raw).not.toContain(CALLER);
    expect(result.raw.toLowerCase()).not.toContain('seller_profiles');
    expect(result.raw.toLowerCase()).not.toContain('constraint');
  });

  it('counts against the approved draft bucket, and refuses the twenty-first', async () => {
    const recorded = await start({ counting: true });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect((await call('POST', '/v1/sellers/me/listings', VALID_CREATE)).status).toBe(201);
    }
    const refused = await call('POST', '/v1/sellers/me/listings', VALID_CREATE);
    expect(refused.status).toBe(429);
    expect(refused.body['code']).toBe('THROTTLED');
    expect(new Set(recorded.buckets)).toEqual(new Set([SELLER_THROTTLE_BUCKETS.listingDraft.name]));
    expect(SELLER_THROTTLE_BUCKETS.listingDraft.limit).toBe(20);
    expect(SELLER_THROTTLE_BUCKETS.listingDraft.windowSeconds).toBe(3600);
  });

  it('continues in the durable counter when Redis cannot answer', async () => {
    const recorded = await start({ redisThrows: true });
    expect((await call('POST', '/v1/sellers/me/listings', VALID_CREATE)).status).toBe(201);
    expect(recorded.durableBuckets).toEqual([SELLER_THROTTLE_BUCKETS.listingDraft.name]);
  });

  it('fails closed when neither counter can answer', async () => {
    const recorded = await start({ redisThrows: true, durableThrows: true });
    const result = await call('POST', '/v1/sellers/me/listings', VALID_CREATE);
    expect(result.status).toBe(503);
    // Nothing was written: an unreadable counter refuses rather than waves through.
    expect(recorded.creates).toHaveLength(0);
  });
});

describe('editing a draft', () => {
  it('edits one, answering 200 with the committed status', async () => {
    const recorded = await start();
    const result = await call('PATCH', '/v1/sellers/me/listings/a-chair', { title: 'Renamed Chair' });

    expect(result.status).toBe(200);
    expect(result.body['listing']).toEqual({ slug: 'a-chair', status: 'draft' });
    expect(recorded.updates[0]?.userId).toBe(CALLER);
    expect(recorded.updates[0]?.slug).toBe('a-chair');
  });

  it('tells an omitted field from one sent as null from one with a value', async () => {
    const recorded = await start();
    await call('PATCH', '/v1/sellers/me/listings/a-chair', { title: 'Renamed', priceMinor: null });
    const sent = recorded.updates[0]!;

    // Sent with a value.
    expect(sent.setTitle).toBe(true);
    expect(sent.title).toBe('Renamed');
    // Sent as an explicit null: clear it.
    expect(sent.setPriceMinor).toBe(true);
    expect(sent.priceMinor).toBeNull();
    // Absent: leave it exactly as it is.
    expect(sent.setDescription).toBe(false);
    expect(sent.setCity).toBe(false);
    expect(sent.setGovernorate).toBe(false);
    expect(sent.setCurrencyCode).toBe(false);
  });

  it('accepts an empty edit, which changes nothing', async () => {
    const recorded = await start();
    expect((await call('PATCH', '/v1/sellers/me/listings/a-chair', {})).status).toBe(200);
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
    ]) {
      expect(flag).toBe(false);
    }
  });

  it.each([
    ['a slug', { slug: 'a-different-address' }],
    ['a status', { status: 'active' }],
    ['a listing type', { listingTypeCode: 'service' }],
    ['a category', { categorySlug: 'other' }],
    ['a seller', { sellerUserId: CALLER }],
    ['an approval time', { approvedAt: '2026-05-01T00:00:00.000Z' }],
    ['an archival time', { archivedAt: '2026-05-01T00:00:00.000Z' }],
    ['a view count', { viewCount: 12 }],
  ])('refuses an edit carrying %s rather than ignoring it', async (_name, body) => {
    const recorded = await start();
    const result = await call('PATCH', '/v1/sellers/me/listings/a-chair', body);
    expect(result.status).toBe(400);
    expect(recorded.updates).toHaveLength(0);
  });

  it.each([
    ['displayName-like required text', { title: null }],
    ['a description cleared', { description: null }],
    ['a currency cleared', { currencyCode: null }],
    ['a country cleared', { countryCode: null }],
    ['a language cleared', { contentLanguage: null }],
  ])('refuses %s: the six not-null columns can be changed but never emptied', async (_name, body) => {
    const recorded = await start();
    expect((await call('PATCH', '/v1/sellers/me/listings/a-chair', body)).status).toBe(400);
    expect(recorded.updates).toHaveLength(0);
  });

  it.each([
    ['not_found', 404, 'NOT_FOUND'],
    ['not_editable', 409, 'SELLER_LISTING_NOT_EDITABLE'],
    ['invalid', 400, 'VALIDATION_FAILED'],
  ])('turns the database outcome %s into %i', async (outcome, status, code) => {
    await start({ outcome });
    const result = await call('PATCH', '/v1/sellers/me/listings/a-chair', { title: 'Renamed Chair' });
    expect(result.status).toBe(status);
    expect(result.body['code']).toBe(code);
  });

  it('says nothing about moderation when a listing is not editable', async () => {
    await start({ outcome: 'not_editable' });
    const result = await call('PATCH', '/v1/sellers/me/listings/a-chair', { title: 'Renamed Chair' });
    const lower = result.raw.toLowerCase();
    for (const word of ['moderat', 'reject', 'suspend', 'approv', 'reason', 'review']) {
      expect(lower, word).not.toContain(word);
    }
  });

  it('counts against the draft bucket rather than the submission one', async () => {
    const recorded = await start();
    await call('PATCH', '/v1/sellers/me/listings/a-chair', { title: 'Renamed Chair' });
    expect(recorded.buckets).toEqual([SELLER_THROTTLE_BUCKETS.listingDraft.name]);
  });
});

describe('submitting a draft for review', () => {
  it('submits, answering 200 with the committed status', async () => {
    const recorded = await start({ rowStatus: 'pending_review' });
    const result = await call('POST', '/v1/sellers/me/listings/a-chair/submission');

    expect(result.status).toBe(200);
    expect(result.body['listing']).toEqual({ slug: 'a-chair', status: 'pending_review' });
    expect(recorded.submits).toEqual([{ userId: CALLER, slug: 'a-chair' }]);
  });

  it('is its own operation: the store is asked with a slug and a caller, and nothing else', async () => {
    const recorded = await start({ rowStatus: 'pending_review' });
    // A body is sent, and there is no schema on this route for it to steer: what reaches the store is
    // exactly the caller and the address.
    await call('POST', '/v1/sellers/me/listings/a-chair/submission', { status: 'approved', priceMinor: 1 });
    expect(recorded.submits).toEqual([{ userId: CALLER, slug: 'a-chair' }]);
    expect(JSON.stringify(recorded.submits)).not.toContain('approved');
  });

  it.each([
    ['not_found', 404, 'NOT_FOUND'],
    ['not_editable', 409, 'SELLER_LISTING_NOT_EDITABLE'],
    ['incomplete', 409, 'SELLER_LISTING_INCOMPLETE'],
  ])('turns the database outcome %s into %i', async (outcome, status, code) => {
    await start({ outcome });
    const result = await call('POST', '/v1/sellers/me/listings/a-chair/submission');
    expect(result.status).toBe(status);
    expect(result.body['code']).toBe(code);
  });

  it('counts against its own approved bucket, and refuses the eleventh', async () => {
    const recorded = await start({ counting: true, rowStatus: 'pending_review' });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await call('POST', '/v1/sellers/me/listings/a-chair/submission')).status).toBe(200);
    }
    const refused = await call('POST', '/v1/sellers/me/listings/a-chair/submission');
    expect(refused.status).toBe(429);
    expect(new Set(recorded.buckets)).toEqual(new Set([SELLER_THROTTLE_BUCKETS.listingSubmission.name]));
    expect(SELLER_THROTTLE_BUCKETS.listingSubmission.limit).toBe(10);
    expect(SELLER_THROTTLE_BUCKETS.listingSubmission.windowSeconds).toBe(3600);
  });

  it('does not share an allowance with draft writes', async () => {
    const recorded = await start({ counting: true });
    // Ten submissions spend the submission bucket; a draft write is still permitted afterwards.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await call('POST', '/v1/sellers/me/listings/a-chair/submission');
    }
    expect((await call('PATCH', '/v1/sellers/me/listings/a-chair', { title: 'Renamed' })).status).toBe(200);
    expect(recorded.updates).toHaveLength(1);
  });

  it('fails closed when neither counter can answer', async () => {
    const recorded = await start({ redisThrows: true, durableThrows: true });
    expect((await call('POST', '/v1/sellers/me/listings/a-chair/submission')).status).toBe(503);
    expect(recorded.submits).toHaveLength(0);
  });
});

describe('archiving a live listing', () => {
  it('archives, answering 200 with the committed status', async () => {
    const recorded = await start({ rowStatus: 'archived' });
    const result = await call('POST', '/v1/sellers/me/listings/a-chair/archive');

    expect(result.status).toBe(200);
    expect(result.body['listing']).toEqual({ slug: 'a-chair', status: 'archived' });
    expect(recorded.archives).toEqual([{ userId: CALLER, slug: 'a-chair' }]);
  });

  it.each([
    ['not_found', 404, 'NOT_FOUND'],
    ['not_editable', 409, 'SELLER_LISTING_NOT_EDITABLE'],
  ])('turns the database outcome %s into %i', async (outcome, status, code) => {
    await start({ outcome });
    const result = await call('POST', '/v1/sellers/me/listings/a-chair/archive');
    expect(result.status).toBe(status);
    expect(result.body['code']).toBe(code);
  });
});

describe('what this surface cannot do', () => {
  it('offers no DELETE anywhere: a seller archives, and nobody deletes', async () => {
    const recorded = await start();
    for (const url of [
      '/v1/sellers/me/listings',
      '/v1/sellers/me/listings/a-chair',
      '/v1/sellers/me/listings/a-chair/submission',
      '/v1/sellers/me/listings/a-chair/archive',
    ]) {
      expect((await call('DELETE', url)).status, url).toBe(404);
    }
    expect(recorded.archives).toHaveLength(0);
  });

  it('offers no PUT anywhere: nothing replaces a listing wholesale', async () => {
    await start();
    for (const url of ['/v1/sellers/me/listings', '/v1/sellers/me/listings/a-chair']) {
      expect((await call('PUT', url, VALID_CREATE)).status, url).toBe(404);
    }
  });

  it('leaves the frozen seller routes exactly as they were', async () => {
    await start();
    // 6-A, 6-C and 6-D's methods on `/v1/sellers/me` still answer, and no new one appeared beside them.
    expect((await call('GET', '/v1/sellers/me')).status).toBe(200);
    expect((await call('DELETE', '/v1/sellers/me')).status).toBe(404);
    expect((await call('PUT', '/v1/sellers/me')).status).toBe(404);
  });

  it('never returns a token, a credential, a subject hash or an identifier', async () => {
    await start({ rows: 3 });
    const results = [
      await call('GET', '/v1/sellers/me/listings'),
      await call('POST', '/v1/sellers/me/listings', VALID_CREATE),
      await call('PATCH', '/v1/sellers/me/listings/a-chair', { title: 'Renamed Chair' }),
      await call('POST', '/v1/sellers/me/listings/a-chair/submission'),
      await call('POST', '/v1/sellers/me/listings/a-chair/archive'),
    ];
    for (const result of results) {
      expect(result.raw).not.toContain(ACCESS_TOKEN);
      expect(result.raw).not.toContain(TEST_INTERNAL_CREDENTIAL);
      expect(result.raw).not.toContain(CALLER);
    }
  });

  it('reports a write whose row came back empty as unavailable rather than as a success', async () => {
    await start({ nullWriteRow: true });
    const result = await call('POST', '/v1/sellers/me/listings', VALID_CREATE);
    expect(result.status).toBe(503);
  });

  it('reports an outcome it does not understand as unavailable, and never echoes it', async () => {
    await start({ outcome: 'something_else' });
    const result = await call('POST', '/v1/sellers/me/listings', VALID_CREATE);
    expect(result.status).toBe(503);
    expect(result.raw).not.toContain('something_else');
  });

  it('answers 401 for every operation without a session, and asks the store nothing', async () => {
    const recorded = await start({ unauthenticated: true });
    expect((await call('GET', '/v1/sellers/me/listings')).status).toBe(401);
    expect((await call('POST', '/v1/sellers/me/listings', VALID_CREATE)).status).toBe(401);
    expect((await call('PATCH', '/v1/sellers/me/listings/a-chair', { title: 'Renamed Chair' })).status).toBe(401);
    expect((await call('POST', '/v1/sellers/me/listings/a-chair/submission')).status).toBe(401);
    expect((await call('POST', '/v1/sellers/me/listings/a-chair/archive')).status).toBe(401);

    expect(recorded.queries).toHaveLength(0);
    expect(recorded.creates).toHaveLength(0);
    expect(recorded.updates).toHaveLength(0);
    expect(recorded.submits).toHaveLength(0);
    expect(recorded.archives).toHaveLength(0);
  });

  it('answers 403 for every operation without the internal credential', async () => {
    await start();
    const headers = { [INTERNAL_CREDENTIAL_HEADER]: 'wrong-credential' };
    expect((await call('GET', '/v1/sellers/me/listings', undefined, headers)).status).toBe(403);
    expect((await call('POST', '/v1/sellers/me/listings', VALID_CREATE, headers)).status).toBe(403);
    expect((await call('POST', '/v1/sellers/me/listings/a-chair/archive', undefined, headers)).status).toBe(403);
  });
});
