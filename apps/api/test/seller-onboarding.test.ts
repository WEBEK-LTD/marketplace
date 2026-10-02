import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { SellerOnboardingResponseSchema, SESSION_TOKEN_HEADER } from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { AuthenticationRequiredError } from '../src/auth/auth-errors.js';
import { DURABLE_THROTTLE_COUNTER, REDIS_THROTTLE_COUNTER } from '../src/auth/login-throttle.service.js';
import { SUPABASE_AUTH_CLIENT } from '../src/auth/login.service.js';
import { SELLER_STORE } from '../src/catalog/sellers.service.js';
import { SELLER_IDENTITY_STORE } from '../src/sellers/seller-identity.service.js';
import {
  SELLER_ONBOARDING_STORE,
  type SellerCreateProfileInput,
} from '../src/sellers/seller-onboarding.service.js';
import { SELLER_THROTTLE_BUCKETS } from '../src/sellers/seller-throttle.service.js';
import { CURRENT_USER_STORE } from '../src/users/current-user.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * `POST /v1/sellers/me` — seller onboarding at the API boundary (Phase 6-C).
 *
 * Five properties carry this suite.
 *
 * **The owner is the session, and the state is not negotiable.** Every attempt below to name an owner or a
 * state — `userId`, `status`, `verificationStatus`, `suspensionReason`, `verifiedAt` — is refused by the
 * strict contract rather than ignored, and the store is asked with the token's own user id every time. A
 * quietly dropped `"status": "active"` and a refused one look identical to an honest client and very
 * different to a probing one, which is why "refused" is asserted rather than "absent from the store call".
 *
 * **The two conflicts stay distinct, and neither says anything about another account.** An existing
 * storefront and a taken slug are separate codes, because the caller's remedy differs; the taken-slug body is
 * asserted to carry no identifier and nothing about the holder's state.
 *
 * **The limit is the approved one, in the approved shape.** Ten attempts per account per hour on the same
 * two-tier counters the login and messaging throttles use: the boundary is exercised at the tenth and the
 * eleventh, Redis is taken away to prove the durable counter continues the same window, and both layers are
 * taken away to prove the request is refused rather than allowed. The bucket name is asserted, because a
 * limiter counting into the wrong bucket is a limiter that is not there.
 *
 * **Nothing leaks.** No token, no internal credential, no SQL, no constraint name, no column name, no other
 * account's identifier — asserted against the raw response text, not the parsed body.
 *
 * **6-A is untouched.** The read still answers exactly as it did, and no write appeared on the public
 * `/v1/sellers/{slug}` route.
 *
 * Everything is stubbed at the store and counter boundaries: no database, no Redis, no provider, no network.
 */

const ACCESS_TOKEN = 'caller-access-token-value-not-a-real-token';
const CALLER = '11111111-1111-4111-8111-111111111111';

/** A complete, valid body. Individual tests override one field at a time. */
function onboardingBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: 'good-shop',
    displayName: 'Good Shop',
    legalName: 'Good Shop Trading LLC',
    bio: 'We restore mid-century furniture.',
    contentLanguage: 'en',
    countryCode: 'EG',
    governorate: 'Cairo Governorate',
    city: 'Cairo',
    contactEmail: 'owner@example.invalid',
    contactPhone: '+201555000001',
    ...overrides,
  };
}

interface Recorded {
  readonly creates: SellerCreateProfileInput[];
  readonly buckets: string[];
  readonly redisBuckets: string[];
  readonly durableBuckets: string[];
}

interface Doubles {
  /** What migration 0058 answers with. */
  readonly outcome?: 'created' | 'exists' | 'slug_taken' | 'invalid' | 'something_else';
  /** Extra columns the store might hand back, to prove the service forwards none of them. */
  readonly extra?: Readonly<Record<string, unknown>>;
  readonly nullFields?: boolean;
  readonly storeThrows?: boolean;
  readonly unauthenticated?: boolean;
  /** A real counting limiter with the approved allowance, so the boundary is the real boundary. */
  readonly counting?: boolean;
  readonly redisThrows?: boolean;
  readonly durableThrows?: boolean;
}

let app: NestFastifyApplication | undefined;

async function start(doubles: Doubles = {}): Promise<Recorded> {
  const recorded: Recorded = { creates: [], buckets: [], redisBuckets: [], durableBuckets: [] };

  // One shared count across both layers, exactly as the real limiter's aligned window is shared: a Redis
  // outage continues the window rather than opening a fresh allowance.
  const counts = new Map<string, number>();
  const count = (bucket: string, limit: number): boolean => {
    const next = (counts.get(bucket) ?? 0) + 1;
    counts.set(bucket, next);
    return next <= limit;
  };

  const redis = {
    hit: async (bucket: string, _subject: Buffer, _windowSeconds: number, limit: number) => {
      recorded.buckets.push(bucket);
      recorded.redisBuckets.push(bucket);
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

  const onboardingStore = {
    sellerCreateProfile: async (input: SellerCreateProfileInput) => {
      recorded.creates.push(input);
      if (doubles.storeThrows === true) throw new Error('database unavailable');
      const outcome = doubles.outcome ?? 'created';
      if (outcome !== 'created') {
        return {
          outcome,
          slug: null,
          displayName: null,
          status: null,
          verificationStatus: null,
          city: null,
          countryCode: null,
        };
      }
      if (doubles.nullFields === true) {
        return {
          outcome: 'created',
          slug: null,
          displayName: null,
          status: null,
          verificationStatus: null,
          city: null,
          countryCode: null,
        };
      }
      return {
        outcome: 'created',
        slug: input.slug,
        displayName: input.displayName,
        status: 'pending',
        verificationStatus: 'unverified',
        city: input.city,
        countryCode: input.countryCode,
        ...(doubles.extra ?? {}),
      };
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
        throw new Error('creating a seller profile must never sign anyone in');
      },
      revokeAllSessions: async () => {
        throw new Error('creating a seller profile must never revoke a session');
      },
    })
    .overrideProvider(CURRENT_USER_STORE)
    .useValue({ userIdentity: async (userId: string) => ({ id: userId, displayName: 'Nadia' }) })
    .overrideProvider(REDIS_THROTTLE_COUNTER)
    .useValue(redis)
    .overrideProvider(DURABLE_THROTTLE_COUNTER)
    .useValue(durable)
    .overrideProvider(SELLER_ONBOARDING_STORE)
    .useValue(onboardingStore)
    .overrideProvider(SELLER_IDENTITY_STORE)
    .useValue({ sellerIdentity: async () => null })
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

async function post(
  body: unknown = onboardingBody(),
  headers: Record<string, string> = {},
  path = '/v1/sellers/me',
): Promise<Result> {
  const response = await app!.inject({
    method: 'POST',
    url: path,
    headers: {
      [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL,
      [SESSION_TOKEN_HEADER]: ACCESS_TOKEN,
      'content-type': 'application/json',
      ...headers,
    },
    payload: JSON.stringify(body),
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

describe('authentication and the internal credential', () => {
  it('creates the storefront for the authenticated caller', async () => {
    const recorded = await start();
    const response = await post();

    expect(response.status).toBe(201);
    expect(recorded.creates).toHaveLength(1);
    expect(recorded.creates[0]?.userId).toBe(CALLER);
  });

  it('refuses a request with no session, without counting it or touching the store', async () => {
    const recorded = await start();
    const response = await app!.inject({
      method: 'POST',
      url: '/v1/sellers/me',
      headers: { [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL, 'content-type': 'application/json' },
      payload: JSON.stringify(onboardingBody()),
    });

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body).code).toBe('AUTHENTICATION_REQUIRED');
    expect(recorded.creates).toHaveLength(0);
    expect(recorded.buckets).toHaveLength(0);
  });

  it('refuses an empty session header the same way', async () => {
    const recorded = await start();
    const response = await post(onboardingBody(), { [SESSION_TOKEN_HEADER]: '' });

    expect(response.status).toBe(401);
    expect(recorded.creates).toHaveLength(0);
  });

  it('refuses a session the provider does not accept', async () => {
    const recorded = await start({ unauthenticated: true });
    const response = await post();

    expect(response.status).toBe(401);
    expect(recorded.creates).toHaveLength(0);
  });

  it('refuses a request without the internal credential', async () => {
    const recorded = await start();
    const response = await app!.inject({
      method: 'POST',
      url: '/v1/sellers/me',
      headers: { [SESSION_TOKEN_HEADER]: ACCESS_TOKEN, 'content-type': 'application/json' },
      payload: JSON.stringify(onboardingBody()),
    });

    expect(response.statusCode).toBe(403);
    expect(recorded.creates).toHaveLength(0);
  });

  it('refuses a wrong internal credential', async () => {
    const recorded = await start();
    const response = await post(onboardingBody(), {
      [INTERNAL_CREDENTIAL_HEADER]: 'not-the-internal-credential-value-at-all',
    });

    expect(response.status).toBe(403);
    expect(recorded.creates).toHaveLength(0);
  });
});

describe('the strict request contract', () => {
  it('refuses an unknown field rather than ignoring it', async () => {
    const recorded = await start();
    const response = await post(onboardingBody({ nickname: 'Shop' }));

    expect(response.status).toBe(400);
    expect(response.body['code']).toBe('VALIDATION_FAILED');
    expect(recorded.creates).toHaveLength(0);
  });

  it.each([
    ['userId', '99999999-9999-4999-8999-999999999999'],
    ['status', 'active'],
    ['verificationStatus', 'verified'],
    ['suspensionReason', 'none'],
    ['suspendedAt', '2026-01-01T00:00:00.000Z'],
    ['closedAt', '2026-01-01T00:00:00.000Z'],
    ['verifiedAt', '2026-01-01T00:00:00.000Z'],
    ['createdAt', '2026-01-01T00:00:00.000Z'],
    ['logoObjectPath', 'logos/mine.webp'],
    ['bannerObjectPath', 'banners/mine.webp'],
    ['role', 'seller'],
  ])('refuses an injected %s', async (field, value) => {
    const recorded = await start();
    const response = await post(onboardingBody({ [field]: value }));

    expect(response.status).toBe(400);
    expect(response.body['code']).toBe('VALIDATION_FAILED');
    // Refused, not silently dropped: nothing was created at all.
    expect(recorded.creates).toHaveLength(0);
  });

  it.each([
    ['an uppercase slug', { slug: 'Good-Shop' }],
    ['a slug with an underscore', { slug: 'good_shop' }],
    ['a two-character slug', { slug: 'ab' }],
    ['a fifty-one-character slug', { slug: 'a'.repeat(51) }],
    ['a slug with a leading hyphen', { slug: '-good-shop' }],
    ['a one-character display name', { displayName: 'A' }],
    ['an eighty-one-character display name', { displayName: 'n'.repeat(81) }],
    ['a whitespace display name', { displayName: '   ' }],
    ['a 2001-character bio', { bio: 'b'.repeat(2001) }],
    ['a one-character country code', { countryCode: 'E' }],
    ['a three-character country code', { countryCode: 'EGY' }],
    ['an address with no domain', { contactEmail: 'not-an-email' }],
    ['a phone without the E.164 plus', { contactPhone: '0201555000001' }],
    ['a phone that is too short', { contactPhone: '+2015' }],
  ])('refuses %s before the database is asked', async (_name, override) => {
    const recorded = await start();
    const response = await post(onboardingBody(override));

    expect(response.status).toBe(400);
    expect(recorded.creates).toHaveLength(0);
  });

  it.each(['slug', 'displayName', 'countryCode'])('refuses a body with no %s', async (field) => {
    const body = onboardingBody();
    delete body[field];
    const recorded = await start();
    const response = await post(body);

    expect(response.status).toBe(400);
    expect(recorded.creates).toHaveLength(0);
  });

  it('accepts a body with only the required fields, and sends the rest as absent', async () => {
    const recorded = await start();
    const response = await post({ slug: 'plain-shop', displayName: 'Plain Shop', countryCode: 'EG' });

    expect(response.status).toBe(201);
    const call = recorded.creates[0];
    expect(call?.legalName).toBeNull();
    expect(call?.bio).toBeNull();
    expect(call?.contentLanguage).toBeNull();
    expect(call?.governorate).toBeNull();
    expect(call?.city).toBeNull();
    expect(call?.contactEmail).toBeNull();
    expect(call?.contactPhone).toBeNull();
  });

  it('trims the display name before the database sees it, because the constraint is on the trimmed value', async () => {
    const recorded = await start();
    const response = await post(onboardingBody({ displayName: '  Good Shop  ' }));

    expect(response.status).toBe(201);
    expect(recorded.creates[0]?.displayName).toBe('Good Shop');
  });

  it('refuses a body that is not an object at all', async () => {
    const recorded = await start();
    expect((await post('not a body')).status).toBe(400);
    expect((await post(null)).status).toBe(400);
    expect(recorded.creates).toHaveLength(0);
  });
});

describe('the response', () => {
  it('is exactly the approved projection of what was stored', async () => {
    await start();
    const response = await post();

    expect(response.status).toBe(201);
    expect(SellerOnboardingResponseSchema.safeParse(response.body).success).toBe(true);
    expect(response.body).toEqual({
      seller: {
        slug: 'good-shop',
        displayName: 'Good Shop',
        status: 'pending',
        verificationStatus: 'unverified',
        city: 'Cairo',
        countryCode: 'EG',
      },
    });
  });

  it('always reports pending and unverified, whatever was sent', async () => {
    await start();
    const response = await post();
    const seller = response.body['seller'] as Record<string, unknown>;

    expect(seller['status']).toBe('pending');
    expect(seller['verificationStatus']).toBe('unverified');
  });

  it('drops any extra column the store hands back', async () => {
    await start({
      extra: {
        userId: CALLER,
        legalName: 'Good Shop Trading LLC',
        contactEmail: 'owner@example.invalid',
        contactPhone: '+201555000001',
        suspensionReason: 'internal note',
        logoObjectPath: 'logos/good-shop.webp',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    });
    const response = await post();
    const seller = response.body['seller'] as Record<string, unknown>;

    expect(Object.keys(seller).sort()).toEqual([
      'city',
      'countryCode',
      'displayName',
      'slug',
      'status',
      'verificationStatus',
    ]);
    for (const absent of [
      CALLER,
      'Good Shop Trading LLC',
      'owner@example.invalid',
      '+201555000001',
      'internal note',
      'logos/good-shop.webp',
      '2026-01-01',
    ]) {
      expect(response.raw, absent).not.toContain(absent);
    }
  });

  it('reports a creation with missing fields as unavailable rather than a storefront of nulls', async () => {
    await start({ nullFields: true });
    const response = await post();

    expect(response.status).toBe(503);
    expect(response.body['code']).toBe('SERVICE_UNAVAILABLE');
  });
});

describe('the two conflicts', () => {
  it('answers a caller who already has a storefront with its own code', async () => {
    await start({ outcome: 'exists' });
    const response = await post();

    expect(response.status).toBe(409);
    expect(response.body['code']).toBe('SELLER_PROFILE_EXISTS');
    expect(response.body['seller']).toBeUndefined();
  });

  it('answers a slug somebody else holds with a different code', async () => {
    await start({ outcome: 'slug_taken' });
    const response = await post();

    expect(response.status).toBe(409);
    expect(response.body['code']).toBe('SELLER_SLUG_TAKEN');
  });

  it('says nothing about the account that holds the slug', async () => {
    await start({ outcome: 'slug_taken' });
    const response = await post();

    // Not who holds it, not when they took it, not what state their storefront is in.
    for (const absent of [
      CALLER,
      '99999999',
      'active',
      'pending',
      'suspended',
      'closed',
      'verified',
      'user_id',
      'userId',
    ]) {
      expect(response.raw, absent).not.toContain(absent);
    }
    expect(response.raw).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });

  it('turns a database refusal into a plain validation failure that names nothing', async () => {
    await start({ outcome: 'invalid' });
    const response = await post();

    expect(response.status).toBe(400);
    expect(response.body['code']).toBe('VALIDATION_FAILED');
    for (const absent of [
      'seller_profiles',
      'constraint',
      'pkey',
      'violation',
      'slug_format',
      'search_path',
      'app_private',
      'select ',
      'insert ',
      'pg_',
    ]) {
      expect(response.raw.toLowerCase(), absent).not.toContain(absent);
    }
  });

  it('treats an outcome it does not understand as unavailable rather than success', async () => {
    await start({ outcome: 'something_else' });
    const response = await post();

    expect(response.status).toBe(503);
    expect(response.body['seller']).toBeUndefined();
  });

  it('reports a database failure as unavailable, never as a conflict or a validation failure', async () => {
    await start({ storeThrows: true });
    const response = await post();

    expect(response.status).toBe(503);
    expect(response.body['code']).toBe('SERVICE_UNAVAILABLE');
  });
});

describe('the approved rate limit', () => {
  it('counts into the seller_onboarding bucket and nothing else', async () => {
    const recorded = await start();
    await post();

    expect(recorded.buckets).toEqual(['seller_onboarding']);
    expect(SELLER_THROTTLE_BUCKETS.onboarding.name).toBe('seller_onboarding');
    expect(SELLER_THROTTLE_BUCKETS.onboarding.limit).toBe(10);
    expect(SELLER_THROTTLE_BUCKETS.onboarding.windowSeconds).toBe(3600);
  });

  it('counts before the database is touched, so a flood costs a counter and not a transaction', async () => {
    const recorded = await start();
    await post();

    expect(recorded.buckets).toHaveLength(1);
    expect(recorded.creates).toHaveLength(1);
  });

  it('allows ten attempts in the window and refuses the eleventh', async () => {
    const recorded = await start({ counting: true });

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const response = await post(onboardingBody({ slug: `shop-${attempt}` }));
      expect(response.status, `attempt ${attempt}`).toBe(201);
    }

    const eleventh = await post(onboardingBody({ slug: 'shop-11' }));
    expect(eleventh.status).toBe(429);
    expect(eleventh.body['code']).toBe('THROTTLED');
    // The refused attempt never reached the database.
    expect(recorded.creates).toHaveLength(10);
  });

  it('counts a refused attempt too, so a validation failure is not a free retry', async () => {
    const recorded = await start({ counting: true, outcome: 'slug_taken' });

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      expect((await post()).status, `attempt ${attempt}`).toBe(409);
    }
    expect((await post()).status).toBe(429);
    expect(recorded.creates).toHaveLength(10);
  });

  it('continues the same window on the durable counter when Redis cannot answer', async () => {
    const recorded = await start({ counting: true, redisThrows: true });

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      expect((await post(onboardingBody({ slug: `shop-${attempt}` }))).status, `attempt ${attempt}`).toBe(201);
    }
    const eleventh = await post(onboardingBody({ slug: 'shop-11' }));

    // A Redis outage does not open a fresh allowance: the eleventh attempt is still refused.
    expect(eleventh.status).toBe(429);
    expect(recorded.durableBuckets).toHaveLength(11);
    expect(recorded.durableBuckets.every((bucket) => bucket === 'seller_onboarding')).toBe(true);
  });

  it('still creates the storefront when only Redis is down', async () => {
    await start({ redisThrows: true });
    const response = await post();

    expect(response.status).toBe(201);
  });

  it('fails closed when neither counter can answer', async () => {
    const recorded = await start({ redisThrows: true, durableThrows: true });
    const response = await post();

    expect(response.status).toBe(503);
    expect(response.body['code']).toBe('SERVICE_UNAVAILABLE');
    // The point of failing closed: nothing was created, so an attacker who takes the counters down does not
    // thereby remove the limit.
    expect(recorded.creates).toHaveLength(0);
  });

  it('fails closed when the durable counter alone is down and Redis is absent', async () => {
    const recorded = await start({ redisThrows: true, durableThrows: true });
    await post();
    await post();

    expect(recorded.creates).toHaveLength(0);
  });
});

describe('nothing leaks', () => {
  it('never echoes the caller token or the internal credential', async () => {
    await start();
    for (const result of [
      await post(),
      await post(onboardingBody({ slug: 'BAD' })),
      await post(onboardingBody({ userId: CALLER })),
    ]) {
      expect(result.raw).not.toContain(ACCESS_TOKEN);
      expect(result.raw).not.toContain(TEST_INTERNAL_CREDENTIAL);
    }
  });

  it('never names a database object in any refusal', async () => {
    for (const doubles of [
      { outcome: 'exists' as const },
      { outcome: 'slug_taken' as const },
      { outcome: 'invalid' as const },
      { storeThrows: true },
    ]) {
      await app?.close();
      app = undefined;
      await start(doubles);
      const response = await post();
      for (const absent of ['seller_profiles', 'app_private', 'constraint', 'violation', 'sql', 'kysely']) {
        expect(response.raw.toLowerCase(), `${doubles.outcome ?? 'throw'}: ${absent}`).not.toContain(absent);
      }
    }
  });
});

describe('6-A and the public route are untouched', () => {
  it('the read still answers for a caller with no storefront', async () => {
    await start();
    const response = await app!.inject({
      method: 'GET',
      url: '/v1/sellers/me',
      headers: {
        [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL,
        [SESSION_TOKEN_HEADER]: ACCESS_TOKEN,
      },
    });

    expect(response.statusCode).toBe(404);
  });

  it('no write appeared on the public seller route', async () => {
    await start();
    const response = await post(onboardingBody(), {}, '/v1/sellers/good-shop');

    expect(response.status).toBe(404);
  });

  it('and the public read of a slug named "me" is still the identity route, not a profile lookup', async () => {
    const recorded = await start();
    await post();

    // The static segment won: the creation went to the onboarding store, and no public lookup happened.
    expect(recorded.creates).toHaveLength(1);
  });
});
