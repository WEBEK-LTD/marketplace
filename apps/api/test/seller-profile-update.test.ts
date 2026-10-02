import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { SellerProfileUpdateResponseSchema, SESSION_TOKEN_HEADER } from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { AuthenticationRequiredError } from '../src/auth/auth-errors.js';
import { DURABLE_THROTTLE_COUNTER, REDIS_THROTTLE_COUNTER } from '../src/auth/login-throttle.service.js';
import { SUPABASE_AUTH_CLIENT } from '../src/auth/login.service.js';
import { SELLER_STORE } from '../src/catalog/sellers.service.js';
import { SELLER_IDENTITY_STORE } from '../src/sellers/seller-identity.service.js';
import { SELLER_ONBOARDING_STORE } from '../src/sellers/seller-onboarding.service.js';
import {
  SELLER_PROFILE_UPDATE_STORE,
  type SellerUpdateProfileInput,
} from '../src/sellers/seller-profile-update.service.js';
import { SELLER_THROTTLE_BUCKETS } from '../src/sellers/seller-throttle.service.js';
import { CURRENT_USER_STORE } from '../src/users/current-user.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * `PATCH /v1/sellers/me` — seller profile editing at the API boundary (Phase 6-D).
 *
 * Five properties carry this suite.
 *
 * **The owner, the address and the state are not negotiable.** Every attempt below to send `userId`, `slug`,
 * `status`, `verificationStatus`, `suspensionReason` or a timestamp is refused by the strict contract rather
 * than ignored, and the store is asked with the token's own user id every time. "Refused" is asserted rather
 * than "absent from the store call", because a quietly dropped `"slug": "something-else"` looks like success
 * to whoever sent it.
 *
 * **Absent and null are different requests, all the way down.** The three states each field can be in are
 * asserted at the store boundary: a field the body omits arrives with its set-flag false, a field sent as
 * `null` arrives with the flag true and a null value, and a field with a value arrives with both. This is
 * the whole of the partial-update contract, and it is the thing most easily broken by a refactor.
 *
 * **The status gate is the database's, reported faithfully.** `not_editable` becomes one 409 with one code,
 * and its body carries no reason, no timestamp and nothing about moderation.
 *
 * **The limit is the approved one.** Twenty per account per hour in its own `seller_profile_update` bucket,
 * exercised at the twentieth and the twenty-first, with Redis taken away and then both layers.
 *
 * **Nothing leaks.** No token, no internal credential, no SQL, no constraint name, no column name —
 * asserted against the raw response text.
 *
 * Everything is stubbed at the store and counter boundaries: no database, no Redis, no provider, no network.
 */

const ACCESS_TOKEN = 'caller-access-token-value-not-a-real-token';
const CALLER = '11111111-1111-4111-8111-111111111111';

const STORED = {
  slug: 'good-shop',
  displayName: 'Good Shop',
  status: 'active',
  verificationStatus: 'verified',
  city: 'Cairo',
  countryCode: 'EG',
};

interface Recorded {
  readonly updates: SellerUpdateProfileInput[];
  readonly buckets: string[];
  readonly durableBuckets: string[];
}

interface Doubles {
  readonly outcome?: 'updated' | 'not_found' | 'not_editable' | 'invalid' | 'something_else';
  readonly extra?: Readonly<Record<string, unknown>>;
  readonly nullFields?: boolean;
  readonly storeThrows?: boolean;
  readonly unauthenticated?: boolean;
  readonly counting?: boolean;
  readonly redisThrows?: boolean;
  readonly durableThrows?: boolean;
}

let app: NestFastifyApplication | undefined;

async function start(doubles: Doubles = {}): Promise<Recorded> {
  const recorded: Recorded = { updates: [], buckets: [], durableBuckets: [] };

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

  const updateStore = {
    sellerUpdateProfile: async (input: SellerUpdateProfileInput) => {
      recorded.updates.push(input);
      if (doubles.storeThrows === true) throw new Error('database unavailable');
      const outcome = doubles.outcome ?? 'updated';
      if (outcome !== 'updated' || doubles.nullFields === true) {
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
      return {
        outcome: 'updated',
        slug: STORED.slug,
        displayName: input.setDisplayName ? (input.displayName ?? STORED.displayName) : STORED.displayName,
        status: STORED.status,
        verificationStatus: STORED.verificationStatus,
        city: input.setCity ? input.city : STORED.city,
        countryCode: input.setCountryCode ? (input.countryCode ?? STORED.countryCode) : STORED.countryCode,
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
        throw new Error('editing a seller profile must never sign anyone in');
      },
      revokeAllSessions: async () => {
        throw new Error('editing a seller profile must never revoke a session');
      },
    })
    .overrideProvider(CURRENT_USER_STORE)
    .useValue({ userIdentity: async (userId: string) => ({ id: userId, displayName: 'Nadia' }) })
    .overrideProvider(REDIS_THROTTLE_COUNTER)
    .useValue(redis)
    .overrideProvider(DURABLE_THROTTLE_COUNTER)
    .useValue(durable)
    .overrideProvider(SELLER_PROFILE_UPDATE_STORE)
    .useValue(updateStore)
    .overrideProvider(SELLER_ONBOARDING_STORE)
    .useValue({
      sellerCreateProfile: async () => {
        throw new Error('editing a profile must never create one');
      },
    })
    .overrideProvider(SELLER_IDENTITY_STORE)
    .useValue({ sellerIdentity: async () => STORED })
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

async function patch(
  body: unknown = { displayName: 'Renamed Shop' },
  headers: Record<string, string> = {},
): Promise<Result> {
  const response = await app!.inject({
    method: 'PATCH',
    url: '/v1/sellers/me',
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
  it('edits the storefront for the authenticated caller', async () => {
    const recorded = await start();
    const response = await patch();

    expect(response.status).toBe(200);
    expect(recorded.updates).toHaveLength(1);
    expect(recorded.updates[0]?.userId).toBe(CALLER);
  });

  it('refuses a request with no session, without counting it or touching the store', async () => {
    const recorded = await start();
    const response = await app!.inject({
      method: 'PATCH',
      url: '/v1/sellers/me',
      headers: { [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL, 'content-type': 'application/json' },
      payload: JSON.stringify({ displayName: 'Renamed Shop' }),
    });

    expect(response.statusCode).toBe(401);
    expect(recorded.updates).toHaveLength(0);
    expect(recorded.buckets).toHaveLength(0);
  });

  it('refuses a session the provider does not accept', async () => {
    const recorded = await start({ unauthenticated: true });
    expect((await patch()).status).toBe(401);
    expect(recorded.updates).toHaveLength(0);
  });

  it('refuses a request without the internal credential', async () => {
    const recorded = await start();
    const response = await app!.inject({
      method: 'PATCH',
      url: '/v1/sellers/me',
      headers: { [SESSION_TOKEN_HEADER]: ACCESS_TOKEN, 'content-type': 'application/json' },
      payload: JSON.stringify({ displayName: 'Renamed Shop' }),
    });

    expect(response.statusCode).toBe(403);
    expect(recorded.updates).toHaveLength(0);
  });
});

describe('the strict request contract', () => {
  it.each([
    ['userId', '99999999-9999-4999-8999-999999999999'],
    ['slug', 'a-different-address'],
    ['status', 'active'],
    ['verificationStatus', 'verified'],
    ['suspensionReason', 'none'],
    ['suspendedAt', '2026-01-01T00:00:00.000Z'],
    ['closedAt', '2026-01-01T00:00:00.000Z'],
    ['verifiedAt', '2026-01-01T00:00:00.000Z'],
    ['createdAt', '2026-01-01T00:00:00.000Z'],
    ['updatedAt', '2026-01-01T00:00:00.000Z'],
    ['logoObjectPath', 'logos/mine.webp'],
    ['bannerObjectPath', 'banners/mine.webp'],
    ['role', 'seller'],
    ['nickname', 'Shop'],
  ])('refuses an injected %s rather than ignoring it', async (field, value) => {
    const recorded = await start();
    const response = await patch({ displayName: 'Renamed Shop', [field]: value });

    expect(response.status).toBe(400);
    expect(response.body['code']).toBe('VALIDATION_FAILED');
    expect(recorded.updates).toHaveLength(0);
  });

  it.each([
    ['a one-character display name', { displayName: 'A' }],
    ['an eighty-one-character display name', { displayName: 'n'.repeat(81) }],
    ['a whitespace display name', { displayName: '   ' }],
    ['a null display name', { displayName: null }],
    ['a 2001-character bio', { bio: 'b'.repeat(2001) }],
    ['a one-character country code', { countryCode: 'E' }],
    ['a three-character country code', { countryCode: 'EGY' }],
    ['a null country code', { countryCode: null }],
    ['an address with no domain', { contactEmail: 'not-an-email' }],
    ['a phone without the E.164 plus', { contactPhone: '0201555000001' }],
    ['an empty legal name string', { legalName: '' }],
    ['an empty city string', { city: '' }],
  ])('refuses %s before the database is asked', async (_name, body) => {
    const recorded = await start();
    const response = await patch(body);

    expect(response.status).toBe(400);
    expect(recorded.updates).toHaveLength(0);
  });

  it('refuses a body that is not an object at all', async () => {
    const recorded = await start();
    expect((await patch('not a body')).status).toBe(400);
    expect((await patch(null)).status).toBe(400);
    expect(recorded.updates).toHaveLength(0);
  });

  it('accepts an empty body: an edit that changes nothing is a valid request', async () => {
    const recorded = await start();
    const response = await patch({});

    expect(response.status).toBe(200);
    // Every set-flag is false, so the database is told to change nothing.
    const call = recorded.updates[0];
    expect(call?.setDisplayName).toBe(false);
    expect(call?.setLegalName).toBe(false);
    expect(call?.setBio).toBe(false);
    expect(call?.setContentLanguage).toBe(false);
    expect(call?.setCountryCode).toBe(false);
    expect(call?.setGovernorate).toBe(false);
    expect(call?.setCity).toBe(false);
    expect(call?.setContactEmail).toBe(false);
    expect(call?.setContactPhone).toBe(false);
  });
});

describe('absent, null and value are three different requests', () => {
  it('an omitted field arrives with its set-flag false', async () => {
    const recorded = await start();
    await patch({ displayName: 'Renamed Shop' });

    const call = recorded.updates[0];
    expect(call?.setDisplayName).toBe(true);
    expect(call?.displayName).toBe('Renamed Shop');
    expect(call?.setLegalName).toBe(false);
    expect(call?.setBio).toBe(false);
    expect(call?.setCity).toBe(false);
  });

  it('a field sent as null arrives with the flag true and a null value', async () => {
    const recorded = await start();
    await patch({ legalName: null, bio: null, city: null, contactEmail: null, contactPhone: null });

    const call = recorded.updates[0];
    expect(call?.setLegalName).toBe(true);
    expect(call?.legalName).toBeNull();
    expect(call?.setBio).toBe(true);
    expect(call?.bio).toBeNull();
    expect(call?.setCity).toBe(true);
    expect(call?.city).toBeNull();
    expect(call?.setContactEmail).toBe(true);
    expect(call?.contactEmail).toBeNull();
    expect(call?.setContactPhone).toBe(true);
    expect(call?.contactPhone).toBeNull();
    // And the untouched ones are still untouched.
    expect(call?.setDisplayName).toBe(false);
    expect(call?.setCountryCode).toBe(false);
  });

  it('every editable field can be sent at once', async () => {
    const recorded = await start();
    const response = await patch({
      displayName: 'Renamed Shop',
      legalName: 'Renamed Holdings LLC',
      bio: 'We now restore bicycles.',
      contentLanguage: 'ar',
      countryCode: 'EG',
      governorate: 'Alexandria Governorate',
      city: 'Alexandria',
      contactEmail: 'new@example.invalid',
      contactPhone: '+201555009999',
    });

    expect(response.status).toBe(200);
    const call = recorded.updates[0];
    expect(call?.displayName).toBe('Renamed Shop');
    expect(call?.legalName).toBe('Renamed Holdings LLC');
    expect(call?.bio).toBe('We now restore bicycles.');
    expect(call?.contentLanguage).toBe('ar');
    expect(call?.countryCode).toBe('EG');
    expect(call?.governorate).toBe('Alexandria Governorate');
    expect(call?.city).toBe('Alexandria');
    expect(call?.contactEmail).toBe('new@example.invalid');
    expect(call?.contactPhone).toBe('+201555009999');
  });

  it('trims a display name before the database sees it', async () => {
    const recorded = await start();
    await patch({ displayName: '  Renamed Shop  ' });

    expect(recorded.updates[0]?.displayName).toBe('Renamed Shop');
  });

  it('never sends a slug, a status or an owner other than the caller', async () => {
    const recorded = await start();
    await patch({ displayName: 'Renamed Shop' });

    const call = recorded.updates[0] as unknown as Record<string, unknown>;
    for (const absent of [
      'slug',
      'status',
      'verificationStatus',
      'suspensionReason',
      'suspendedAt',
      'closedAt',
      'verifiedAt',
      'createdAt',
      'updatedAt',
      'role',
    ]) {
      expect(Object.keys(call), absent).not.toContain(absent);
    }
    expect(call['userId']).toBe(CALLER);
  });
});

describe('the response', () => {
  it('is exactly the approved projection of what was stored', async () => {
    await start();
    const response = await patch({ displayName: 'Renamed Shop' });

    expect(response.status).toBe(200);
    expect(SellerProfileUpdateResponseSchema.safeParse(response.body).success).toBe(true);
    expect(response.body).toEqual({
      seller: {
        slug: 'good-shop',
        displayName: 'Renamed Shop',
        status: 'active',
        verificationStatus: 'verified',
        city: 'Cairo',
        countryCode: 'EG',
      },
    });
  });

  it('drops any extra column the store hands back', async () => {
    await start({
      extra: {
        userId: CALLER,
        legalName: 'Good Shop Trading LLC',
        contactEmail: 'owner@example.invalid',
        suspensionReason: 'internal note',
        logoObjectPath: 'logos/good-shop.webp',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    const response = await patch();
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
      'internal note',
      'logos/good-shop.webp',
      '2026-01-01',
    ]) {
      expect(response.raw, absent).not.toContain(absent);
    }
  });

  it('reports an update with missing fields as unavailable rather than a storefront of nulls', async () => {
    await start({ nullFields: true });
    const response = await patch();

    expect(response.status).toBe(503);
    expect(response.body['code']).toBe('SERVICE_UNAVAILABLE');
  });
});

describe('status and existence', () => {
  it('answers a suspended or closed storefront with its own 409 code', async () => {
    await start({ outcome: 'not_editable' });
    const response = await patch();

    expect(response.status).toBe(409);
    expect(response.body['code']).toBe('SELLER_PROFILE_NOT_EDITABLE');
    expect(response.body['seller']).toBeUndefined();
  });

  it('says nothing about why a storefront cannot be edited', async () => {
    await start({ outcome: 'not_editable' });
    const response = await patch();

    for (const absent of [
      'suspend',
      'suspended',
      'closed',
      'reason',
      'moderat',
      'policy',
      'breach',
      'appeal',
    ]) {
      expect(response.raw.toLowerCase(), absent).not.toContain(absent);
    }
  });

  it('answers a caller with no storefront with the ordinary not-found', async () => {
    await start({ outcome: 'not_found' });
    const response = await patch();

    expect(response.status).toBe(404);
    expect(response.body['code']).toBe('NOT_FOUND');
  });

  it('turns a database refusal into a plain validation failure that names nothing', async () => {
    await start({ outcome: 'invalid' });
    const response = await patch();

    expect(response.status).toBe(400);
    expect(response.body['code']).toBe('VALIDATION_FAILED');
    for (const absent of [
      'seller_profiles',
      'constraint',
      'pkey',
      'violation',
      'search_path',
      'app_private',
      'update ',
      'pg_',
    ]) {
      expect(response.raw.toLowerCase(), absent).not.toContain(absent);
    }
  });

  it('treats an outcome it does not understand as unavailable rather than success', async () => {
    await start({ outcome: 'something_else' });
    const response = await patch();

    expect(response.status).toBe(503);
    expect(response.body['seller']).toBeUndefined();
  });

  it('reports a database failure as unavailable, never as a conflict or a validation failure', async () => {
    await start({ storeThrows: true });
    const response = await patch();

    expect(response.status).toBe(503);
    expect(response.body['code']).toBe('SERVICE_UNAVAILABLE');
  });
});

describe('the approved rate limit', () => {
  it('counts into the seller_profile_update bucket and nothing else', async () => {
    const recorded = await start();
    await patch();

    expect(recorded.buckets).toEqual(['seller_profile_update']);
    expect(SELLER_THROTTLE_BUCKETS.profileUpdate.name).toBe('seller_profile_update');
    expect(SELLER_THROTTLE_BUCKETS.profileUpdate.limit).toBe(20);
    expect(SELLER_THROTTLE_BUCKETS.profileUpdate.windowSeconds).toBe(3600);
  });

  it('is a separate allowance from onboarding', async () => {
    expect(SELLER_THROTTLE_BUCKETS.onboarding.name).not.toBe(SELLER_THROTTLE_BUCKETS.profileUpdate.name);
    expect(SELLER_THROTTLE_BUCKETS.onboarding.limit).toBe(10);
  });

  it('counts before the database is touched', async () => {
    const recorded = await start();
    await patch();

    expect(recorded.buckets).toHaveLength(1);
    expect(recorded.updates).toHaveLength(1);
  });

  it('allows twenty edits in the window and refuses the twenty-first', async () => {
    const recorded = await start({ counting: true });

    for (let attempt = 1; attempt <= 20; attempt += 1) {
      const response = await patch({ displayName: `Shop ${attempt}` });
      expect(response.status, `attempt ${attempt}`).toBe(200);
    }

    const twentyFirst = await patch({ displayName: 'Shop 21' });
    expect(twentyFirst.status).toBe(429);
    expect(twentyFirst.body['code']).toBe('THROTTLED');
    expect(recorded.updates).toHaveLength(20);
  });

  it('counts a refused edit too, so a rejection is not a free retry', async () => {
    const recorded = await start({ counting: true, outcome: 'not_editable' });

    for (let attempt = 1; attempt <= 20; attempt += 1) {
      expect((await patch()).status, `attempt ${attempt}`).toBe(409);
    }
    expect((await patch()).status).toBe(429);
    expect(recorded.updates).toHaveLength(20);
  });

  it('continues the same window on the durable counter when Redis cannot answer', async () => {
    const recorded = await start({ counting: true, redisThrows: true });

    for (let attempt = 1; attempt <= 20; attempt += 1) {
      expect((await patch({ displayName: `Shop ${attempt}` })).status, `attempt ${attempt}`).toBe(200);
    }

    expect((await patch({ displayName: 'Shop 21' })).status).toBe(429);
    expect(recorded.durableBuckets).toHaveLength(21);
    expect(recorded.durableBuckets.every((bucket) => bucket === 'seller_profile_update')).toBe(true);
  });

  it('still edits when only Redis is down', async () => {
    await start({ redisThrows: true });
    expect((await patch()).status).toBe(200);
  });

  it('fails closed when neither counter can answer', async () => {
    const recorded = await start({ redisThrows: true, durableThrows: true });
    const response = await patch();

    expect(response.status).toBe(503);
    expect(response.body['code']).toBe('SERVICE_UNAVAILABLE');
    expect(recorded.updates).toHaveLength(0);
  });
});

describe('nothing leaks', () => {
  it('never echoes the caller token or the internal credential', async () => {
    await start();
    for (const result of [
      await patch(),
      await patch({ displayName: 'A' }),
      await patch({ slug: 'new-address' }),
    ]) {
      expect(result.raw).not.toContain(ACCESS_TOKEN);
      expect(result.raw).not.toContain(TEST_INTERNAL_CREDENTIAL);
    }
  });

  it('never renders an identifier in any answer', async () => {
    await start();
    for (const result of [await patch(), await patch({})]) {
      expect(result.raw).not.toContain(CALLER);
      expect(result.raw).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/);
    }
  });
});

describe('6-A and 6-C are untouched', () => {
  it('the read still answers with the identity projection', async () => {
    await start();
    const response = await app!.inject({
      method: 'GET',
      url: '/v1/sellers/me',
      headers: {
        [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL,
        [SESSION_TOKEN_HEADER]: ACCESS_TOKEN,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ seller: STORED });
  });

  it('an edit never creates a storefront: the onboarding store is never called', async () => {
    // The onboarding double throws if it is ever reached, so a 200 here is the assertion.
    await start();
    expect((await patch()).status).toBe(200);
  });

  it('no editor appeared on the public seller route', async () => {
    await start();
    const response = await app!.inject({
      method: 'PATCH',
      url: '/v1/sellers/good-shop',
      headers: {
        [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL,
        [SESSION_TOKEN_HEADER]: ACCESS_TOKEN,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ displayName: 'Renamed' }),
    });

    expect(response.statusCode).toBe(404);
  });

  it('and PUT and DELETE are still not offered on the caller own route', async () => {
    await start();
    for (const method of ['PUT', 'DELETE'] as const) {
      const response = await app!.inject({
        method,
        url: '/v1/sellers/me',
        headers: {
          [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL,
          [SESSION_TOKEN_HEADER]: ACCESS_TOKEN,
        },
        payload: JSON.stringify({ displayName: 'Renamed' }),
      });
      expect(response.statusCode, method).toBe(404);
    }
  });
});
