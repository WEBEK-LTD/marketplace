import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  SellerMediaAttachResponseSchema,
  SellerMediaUploadResponseSchema,
  SESSION_TOKEN_HEADER,
} from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { AuthenticationRequiredError } from '../src/auth/auth-errors.js';
import { DURABLE_THROTTLE_COUNTER, REDIS_THROTTLE_COUNTER } from '../src/auth/login-throttle.service.js';
import { SUPABASE_AUTH_CLIENT } from '../src/auth/login.service.js';
import { SELLER_STORE } from '../src/catalog/sellers.service.js';
import { SELLER_IDENTITY_STORE } from '../src/sellers/seller-identity.service.js';
import {
  SELLER_MEDIA_STORE,
  type SellerMediaAttachInput,
  type SellerMediaTargetInput,
} from '../src/sellers/seller-media.service.js';
import {
  SELLER_MEDIA_STORAGE,
  SellerMediaStorageUnavailableError,
} from '../src/sellers/seller-media.storage.js';
import { SELLER_THROTTLE_BUCKETS } from '../src/sellers/seller-throttle.service.js';
import { CURRENT_USER_STORE } from '../src/users/current-user.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * Seller media at the API boundary (Phase 6-E).
 *
 * Five properties carry this suite.
 *
 * **The browser never names a destination.** Every attempt below to send an `objectPath`, a `bucket`, a `slug`,
 * a `fileName` or a seller to the authorization route is refused by the strict contract, and the store call is
 * asserted to carry only the caller's own id plus the three values that describe the file. The path in the
 * response is the one the database returned, and the service composes none of it.
 *
 * **The provider is a port.** The storage client is a double throughout, so what is proven here is the API's
 * logic — the order of the steps, the refusals, the counting — independently of Supabase Storage's HTTP
 * surface, which is deliberately exercised nowhere in this project before Final QA.
 *
 * **The confirmation verifies before it writes.** A path for an object that is not in storage is refused with
 * its own code and never reaches the store; the order is asserted, not assumed.
 *
 * **The state gate holds on both routes**, and its refusal carries no reason.
 *
 * **Nothing leaks.** No signed URL in a refusal, no token, no internal credential, no identifier — asserted
 * against the raw response text.
 */

const ACCESS_TOKEN = 'caller-access-token-value-not-a-real-token';
const CALLER = '11111111-1111-4111-8111-111111111111';
const OBJECT_PATH = 'seller-media/good-shop/logo/11111111-1111-1111-1111-111111111111.webp';
const SIGNED_URL = 'https://provider.invalid/storage/v1/object/upload/sign/seller-media/x?token=signed-token';

const IDENTITY = {
  slug: 'good-shop',
  displayName: 'Good Shop',
  status: 'active',
  verificationStatus: 'verified',
  city: 'Cairo',
  countryCode: 'EG',
};

interface Recorded {
  readonly targets: SellerMediaTargetInput[];
  readonly attaches: SellerMediaAttachInput[];
  readonly signs: { bucket: string; objectPath: string; contentType: string }[];
  readonly exists: { bucket: string; objectPath: string }[];
  readonly buckets: string[];
  readonly durableBuckets: string[];
}

interface Doubles {
  readonly targetOutcome?: 'authorized' | 'not_found' | 'not_editable' | 'invalid' | 'something_else';
  readonly attachOutcome?: 'attached' | 'not_found' | 'not_editable' | 'invalid' | 'something_else';
  readonly incompleteTarget?: boolean;
  readonly objectMissing?: boolean;
  readonly signThrows?: boolean;
  readonly existsThrows?: boolean;
  readonly storeThrows?: boolean;
  readonly unauthenticated?: boolean;
  readonly counting?: boolean;
  readonly redisThrows?: boolean;
  readonly durableThrows?: boolean;
}

let app: NestFastifyApplication | undefined;

async function start(doubles: Doubles = {}): Promise<Recorded> {
  const recorded: Recorded = {
    targets: [],
    attaches: [],
    signs: [],
    exists: [],
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

  const mediaStore = {
    sellerMediaUploadTarget: async (input: SellerMediaTargetInput) => {
      recorded.targets.push(input);
      if (doubles.storeThrows === true) throw new Error('database unavailable');
      const outcome = doubles.targetOutcome ?? 'authorized';
      if (outcome !== 'authorized') {
        return { outcome, bucketId: null, objectPath: null, maxByteSize: null };
      }
      if (doubles.incompleteTarget === true) {
        return { outcome: 'authorized', bucketId: null, objectPath: null, maxByteSize: null };
      }
      return {
        outcome: 'authorized',
        bucketId: 'seller-media',
        objectPath: `seller-media/good-shop/${input.mediaKind}/11111111-1111-1111-1111-111111111111.webp`,
        maxByteSize: 5_242_880,
      };
    },
    sellerMediaAttach: async (input: SellerMediaAttachInput) => {
      recorded.attaches.push(input);
      if (doubles.storeThrows === true) throw new Error('database unavailable');
      const outcome = doubles.attachOutcome ?? 'attached';
      if (outcome !== 'attached') return { outcome, hasLogo: null, hasBanner: null };
      return { outcome: 'attached', hasLogo: input.mediaKind === 'logo', hasBanner: input.mediaKind === 'banner' };
    },
  };

  const storage = {
    signUpload: async (bucket: string, objectPath: string, contentType: string) => {
      recorded.signs.push({ bucket, objectPath, contentType });
      if (doubles.signThrows === true) {
        throw new SellerMediaStorageUnavailableError(new Error('provider status 500'));
      }
      return { uploadUrl: SIGNED_URL, expiresAt: new Date('2026-09-25T22:00:00.000Z') };
    },
    objectExists: async (bucket: string, objectPath: string) => {
      recorded.exists.push({ bucket, objectPath });
      if (doubles.existsThrows === true) {
        throw new SellerMediaStorageUnavailableError(new Error('provider unreachable'));
      }
      return doubles.objectMissing !== true;
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
        throw new Error('a media request must never sign anyone in');
      },
      revokeAllSessions: async () => {
        throw new Error('a media request must never revoke a session');
      },
    })
    .overrideProvider(CURRENT_USER_STORE)
    .useValue({ userIdentity: async (userId: string) => ({ id: userId, displayName: 'Nadia' }) })
    .overrideProvider(REDIS_THROTTLE_COUNTER)
    .useValue(redis)
    .overrideProvider(DURABLE_THROTTLE_COUNTER)
    .useValue(durable)
    .overrideProvider(SELLER_MEDIA_STORE)
    .useValue(mediaStore)
    .overrideProvider(SELLER_MEDIA_STORAGE)
    .useValue(storage)
    .overrideProvider(SELLER_IDENTITY_STORE)
    .useValue({ sellerIdentity: async () => IDENTITY })
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
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Result> {
  const response = await app!.inject({
    method: 'POST',
    url,
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

const authorize = (body: unknown = { mediaKind: 'logo', contentType: 'image/webp', byteSize: 1024 }) =>
  post('/v1/sellers/me/media/uploads', body);

const confirm = (body: unknown = { mediaKind: 'logo', objectPath: OBJECT_PATH }) =>
  post('/v1/sellers/me/media', body);

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('authentication and the internal credential', () => {
  it('authorizes an upload for the authenticated caller', async () => {
    const recorded = await start();
    const response = await authorize();

    expect(response.status).toBe(201);
    expect(recorded.targets).toHaveLength(1);
    expect(recorded.targets[0]?.userId).toBe(CALLER);
  });

  it('confirms an upload for the authenticated caller', async () => {
    const recorded = await start();
    const response = await confirm();

    expect(response.status).toBe(200);
    expect(recorded.attaches).toHaveLength(1);
    expect(recorded.attaches[0]?.userId).toBe(CALLER);
  });

  it.each([
    ['/v1/sellers/me/media/uploads', { mediaKind: 'logo', contentType: 'image/webp', byteSize: 1024 }],
    ['/v1/sellers/me/media', { mediaKind: 'logo', objectPath: OBJECT_PATH }],
  ])('refuses %s with no session, without counting it or touching anything', async (url, body) => {
    const recorded = await start();
    const response = await app!.inject({
      method: 'POST',
      url,
      headers: { [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL, 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });

    expect(response.statusCode).toBe(401);
    expect(recorded.targets).toHaveLength(0);
    expect(recorded.attaches).toHaveLength(0);
    expect(recorded.buckets).toHaveLength(0);
    expect(recorded.signs).toHaveLength(0);
    expect(recorded.exists).toHaveLength(0);
  });

  it('refuses a session the provider does not accept', async () => {
    const recorded = await start({ unauthenticated: true });
    expect((await authorize()).status).toBe(401);
    expect((await confirm()).status).toBe(401);
    expect(recorded.targets).toHaveLength(0);
    expect(recorded.attaches).toHaveLength(0);
  });

  it.each(['/v1/sellers/me/media/uploads', '/v1/sellers/me/media'])(
    'refuses %s without the internal credential',
    async (url) => {
      const recorded = await start();
      const response = await app!.inject({
        method: 'POST',
        url,
        headers: { [SESSION_TOKEN_HEADER]: ACCESS_TOKEN, 'content-type': 'application/json' },
        payload: JSON.stringify({ mediaKind: 'logo', contentType: 'image/webp', byteSize: 1 }),
      });

      expect(response.statusCode).toBe(403);
      expect(recorded.targets).toHaveLength(0);
      expect(recorded.attaches).toHaveLength(0);
    },
  );
});

describe('the browser cannot name a destination', () => {
  it.each([
    ['objectPath', OBJECT_PATH],
    ['bucket', 'seller-media'],
    ['bucketId', 'seller-media'],
    ['slug', 'good-shop'],
    ['fileName', 'logo.webp'],
    ['path', 'anything'],
    ['userId', CALLER],
    ['sellerId', CALLER],
    ['status', 'active'],
  ])('refuses an authorization carrying %s', async (field, value) => {
    const recorded = await start();
    const response = await authorize({
      mediaKind: 'logo',
      contentType: 'image/webp',
      byteSize: 1024,
      [field]: value,
    });

    expect(response.status).toBe(400);
    expect(response.body['code']).toBe('VALIDATION_FAILED');
    expect(recorded.targets).toHaveLength(0);
  });

  it('sends the database only the caller and the three values describing the file', async () => {
    const recorded = await start();
    await authorize({ mediaKind: 'banner', contentType: 'image/avif', byteSize: 2048 });

    expect(recorded.targets[0]).toEqual({
      userId: CALLER,
      mediaKind: 'banner',
      contentType: 'image/avif',
      byteSize: 2048,
    });
  });

  it('signs exactly the bucket and path the database returned', async () => {
    const recorded = await start();
    const response = await authorize();

    expect(recorded.signs).toEqual([
      {
        bucket: 'seller-media',
        objectPath: 'seller-media/good-shop/logo/11111111-1111-1111-1111-111111111111.webp',
        contentType: 'image/webp',
      },
    ]);
    const upload = response.body['upload'] as Record<string, unknown>;
    expect(upload['objectPath']).toBe(recorded.signs[0]?.objectPath);
  });

  it('never signs anything when the database refused', async () => {
    const recorded = await start({ targetOutcome: 'invalid' });
    expect((await authorize()).status).toBe(400);
    expect(recorded.signs).toHaveLength(0);
  });
});

describe('the media rules at the contract boundary', () => {
  it.each([
    ['image/svg+xml', 'an SVG'],
    ['application/pdf', 'a PDF'],
    ['text/html', 'HTML'],
    ['image/gif', 'a GIF'],
    ['IMAGE/WEBP', 'an upper-case type'],
  ])('refuses %s (%s) before the database is asked', async (contentType) => {
    const recorded = await start();
    const response = await authorize({ mediaKind: 'logo', contentType, byteSize: 1024 });

    expect(response.status).toBe(400);
    expect(recorded.targets).toHaveLength(0);
  });

  it.each(['image/jpeg', 'image/png', 'image/webp', 'image/avif'])('accepts %s', async (contentType) => {
    await start();
    expect((await authorize({ mediaKind: 'logo', contentType, byteSize: 1024 })).status).toBe(201);
  });

  it('refuses a size above the ceiling, at zero and below zero', async () => {
    const recorded = await start();
    for (const byteSize of [5_242_881, 0, -1, 1.5]) {
      const response = await authorize({ mediaKind: 'logo', contentType: 'image/webp', byteSize });
      expect(response.status, String(byteSize)).toBe(400);
    }
    expect((await authorize({ mediaKind: 'logo', contentType: 'image/webp', byteSize: 5_242_880 })).status).toBe(
      201,
    );
    expect(recorded.targets).toHaveLength(1);
  });

  it.each(['avatar', 'document', 'video', '', 'LOGO'])('refuses the media kind %s', async (mediaKind) => {
    const recorded = await start();
    const response = await authorize({ mediaKind, contentType: 'image/webp', byteSize: 1024 });

    expect(response.status).toBe(400);
    expect(recorded.targets).toHaveLength(0);
  });

  it('refuses a body that is not an object, and an empty one', async () => {
    const recorded = await start();
    expect((await authorize('nope')).status).toBe(400);
    expect((await authorize(null)).status).toBe(400);
    expect((await authorize({})).status).toBe(400);
    expect(recorded.targets).toHaveLength(0);
  });
});

describe('the response of an authorization', () => {
  it('is exactly the approved shape', async () => {
    await start();
    const response = await authorize();

    expect(response.status).toBe(201);
    expect(SellerMediaUploadResponseSchema.safeParse(response.body).success).toBe(true);
    expect(response.body).toEqual({
      upload: {
        mediaKind: 'logo',
        uploadUrl: SIGNED_URL,
        objectPath: 'seller-media/good-shop/logo/11111111-1111-1111-1111-111111111111.webp',
        expiresAt: '2026-09-25T22:00:00.000Z',
        maxByteSize: 5_242_880,
      },
    });
  });

  it('carries no project credential, no bucket field and no identifier', async () => {
    await start();
    const response = await authorize();

    expect(response.raw).not.toContain(TEST_INTERNAL_CREDENTIAL);
    expect(response.raw).not.toContain(ACCESS_TOKEN);
    expect(response.raw).not.toContain(CALLER);
    expect(response.raw).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/);
    const upload = response.body['upload'] as Record<string, unknown>;
    expect(Object.keys(upload).sort()).toEqual([
      'expiresAt',
      'maxByteSize',
      'mediaKind',
      'objectPath',
      'uploadUrl',
    ]);
  });

  it('reports an authorization with no target as unavailable rather than a broken upload', async () => {
    const recorded = await start({ incompleteTarget: true });
    const response = await authorize();

    expect(response.status).toBe(503);
    expect(recorded.signs).toHaveLength(0);
  });

  it('reports a signing failure as unavailable, and never as a validation failure', async () => {
    await start({ signThrows: true });
    const response = await authorize();

    expect(response.status).toBe(503);
    expect(response.body['code']).toBe('SERVICE_UNAVAILABLE');
    // Nothing about the provider reaches the caller.
    for (const absent of ['provider', 'storage', 'supabase', 'bucket', 'token']) {
      expect(response.raw.toLowerCase(), absent).not.toContain(absent);
    }
  });
});

describe('confirming an upload', () => {
  it('checks storage before it writes, and writes what it was given', async () => {
    const recorded = await start();
    const response = await confirm();

    expect(response.status).toBe(200);
    expect(SellerMediaAttachResponseSchema.safeParse(response.body).success).toBe(true);
    expect(response.body).toEqual({ media: { hasLogo: true, hasBanner: false } });
    expect(recorded.exists).toEqual([{ bucket: 'seller-media', objectPath: OBJECT_PATH }]);
    expect(recorded.attaches[0]?.objectPath).toBe(OBJECT_PATH);
  });

  it('refuses an object that is not in storage, with its own code, and never writes', async () => {
    const recorded = await start({ objectMissing: true });
    const response = await confirm();

    expect(response.status).toBe(404);
    expect(response.body['code']).toBe('SELLER_MEDIA_OBJECT_MISSING');
    expect(recorded.attaches).toHaveLength(0);
  });

  it('reports a storage outage as unavailable rather than as a missing object', async () => {
    const recorded = await start({ existsThrows: true });
    const response = await confirm();

    expect(response.status).toBe(503);
    expect(response.body['code']).toBe('SERVICE_UNAVAILABLE');
    expect(recorded.attaches).toHaveLength(0);
  });

  it('refuses a path the database will not accept, saying nothing about why', async () => {
    const recorded = await start({ attachOutcome: 'invalid' });
    const response = await confirm({
      mediaKind: 'logo',
      objectPath: 'seller-media/other-shop/logo/11111111-1111-1111-1111-111111111111.webp',
    });

    expect(response.status).toBe(400);
    expect(response.body['code']).toBe('VALIDATION_FAILED');
    expect(recorded.attaches).toHaveLength(1);
    for (const absent of ['seller_profiles', 'namespace', 'slug', 'other-shop', 'app_private']) {
      expect(response.raw.toLowerCase(), absent).not.toContain(absent.toLowerCase());
    }
  });

  it.each([
    ['bucket', 'seller-media'],
    ['userId', CALLER],
    ['slug', 'good-shop'],
    ['status', 'active'],
  ])('refuses a confirmation carrying %s', async (field, value) => {
    const recorded = await start();
    const response = await confirm({ mediaKind: 'logo', objectPath: OBJECT_PATH, [field]: value });

    expect(response.status).toBe(400);
    expect(recorded.attaches).toHaveLength(0);
    expect(recorded.exists).toHaveLength(0);
  });

  it('refuses a confirmation with no path or no kind', async () => {
    const recorded = await start();
    expect((await confirm({ mediaKind: 'logo' })).status).toBe(400);
    expect((await confirm({ objectPath: OBJECT_PATH })).status).toBe(400);
    expect((await confirm({ mediaKind: 'logo', objectPath: '' })).status).toBe(400);
    expect(recorded.attaches).toHaveLength(0);
  });

  it('reports a banner confirmation as a banner', async () => {
    await start();
    const response = await confirm({
      mediaKind: 'banner',
      objectPath: 'seller-media/good-shop/banner/11111111-1111-1111-1111-111111111111.webp',
    });

    expect(response.body).toEqual({ media: { hasLogo: false, hasBanner: true } });
  });

  it('returns no path at all: only whether each kind is set', async () => {
    await start();
    const response = await confirm();

    expect(response.raw).not.toContain('seller-media/');
    expect(response.raw).not.toContain('objectPath');
    expect(Object.keys(response.body['media'] as object).sort()).toEqual(['hasBanner', 'hasLogo']);
  });
});

describe('state and existence, on both routes', () => {
  it('refuses a suspended or closed storefront on the authorization, with no reason', async () => {
    await start({ targetOutcome: 'not_editable' });
    const response = await authorize();

    expect(response.status).toBe(409);
    expect(response.body['code']).toBe('SELLER_PROFILE_NOT_EDITABLE');
    for (const absent of ['suspend', 'closed', 'reason', 'moderat', 'policy']) {
      expect(response.raw.toLowerCase(), absent).not.toContain(absent);
    }
  });

  it('refuses a suspended or closed storefront on the confirmation too', async () => {
    await start({ attachOutcome: 'not_editable' });
    const response = await confirm();

    expect(response.status).toBe(409);
    expect(response.body['code']).toBe('SELLER_PROFILE_NOT_EDITABLE');
  });

  it('never signs for a storefront that may not mutate', async () => {
    const recorded = await start({ targetOutcome: 'not_editable' });
    await authorize();

    expect(recorded.signs).toHaveLength(0);
  });

  it('answers an account with no storefront with the ordinary not-found, on both routes', async () => {
    await start({ targetOutcome: 'not_found' });
    const one = await authorize();
    expect(one.status).toBe(404);
    expect(one.body['code']).toBe('NOT_FOUND');

    await app?.close();
    app = undefined;
    await start({ attachOutcome: 'not_found' });
    const two = await confirm();
    expect(two.status).toBe(404);
    expect(two.body['code']).toBe('NOT_FOUND');
  });

  it('treats an outcome it does not understand as unavailable, never as success', async () => {
    await start({ targetOutcome: 'something_else' });
    expect((await authorize()).status).toBe(503);

    await app?.close();
    app = undefined;
    await start({ attachOutcome: 'something_else' });
    expect((await confirm()).status).toBe(503);
  });

  it('reports a database failure as unavailable on both routes', async () => {
    await start({ storeThrows: true });
    expect((await authorize()).status).toBe(503);
    expect((await confirm()).status).toBe(503);
  });
});

describe('the approved rate limit', () => {
  it('counts both routes into the seller_media_upload bucket', async () => {
    const recorded = await start();
    await authorize();
    await confirm();

    expect(recorded.buckets).toEqual(['seller_media_upload', 'seller_media_upload']);
    expect(SELLER_THROTTLE_BUCKETS.mediaUpload.name).toBe('seller_media_upload');
    expect(SELLER_THROTTLE_BUCKETS.mediaUpload.limit).toBe(20);
    expect(SELLER_THROTTLE_BUCKETS.mediaUpload.windowSeconds).toBe(3600);
  });

  it('is a separate allowance from onboarding and from profile editing', async () => {
    const names = new Set([
      SELLER_THROTTLE_BUCKETS.onboarding.name,
      SELLER_THROTTLE_BUCKETS.profileUpdate.name,
      SELLER_THROTTLE_BUCKETS.mediaUpload.name,
    ]);
    expect(names.size).toBe(3);
  });

  it('counts before the provider is asked for anything', async () => {
    const recorded = await start();
    await authorize();

    expect(recorded.buckets).toHaveLength(1);
    expect(recorded.signs).toHaveLength(1);
  });

  it('allows twenty and refuses the twenty-first', async () => {
    const recorded = await start({ counting: true });

    for (let attempt = 1; attempt <= 20; attempt += 1) {
      expect((await authorize()).status, `attempt ${attempt}`).toBe(201);
    }
    const refused = await authorize();

    expect(refused.status).toBe(429);
    expect(refused.body['code']).toBe('THROTTLED');
    expect(recorded.targets).toHaveLength(20);
    expect(recorded.signs).toHaveLength(20);
  });

  it('shares the allowance across both routes, so a confirmation counts too', async () => {
    const recorded = await start({ counting: true });

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      expect((await authorize()).status, `authorize ${attempt}`).toBe(201);
      expect((await confirm()).status, `confirm ${attempt}`).toBe(200);
    }
    expect((await authorize()).status).toBe(429);
    expect(recorded.buckets.length + recorded.durableBuckets.length).toBe(21);
  });

  it('continues the same window on the durable counter when Redis cannot answer', async () => {
    const recorded = await start({ counting: true, redisThrows: true });

    for (let attempt = 1; attempt <= 20; attempt += 1) {
      expect((await authorize()).status, `attempt ${attempt}`).toBe(201);
    }
    expect((await authorize()).status).toBe(429);
    expect(recorded.durableBuckets).toHaveLength(21);
    expect(recorded.durableBuckets.every((bucket) => bucket === 'seller_media_upload')).toBe(true);
  });

  it('still authorizes when only Redis is down', async () => {
    await start({ redisThrows: true });
    expect((await authorize()).status).toBe(201);
  });

  it('fails closed when neither counter can answer, on both routes', async () => {
    const recorded = await start({ redisThrows: true, durableThrows: true });

    expect((await authorize()).status).toBe(503);
    expect((await confirm()).status).toBe(503);
    // Nothing was authorized, nothing was signed, nothing was checked and nothing was written.
    expect(recorded.targets).toHaveLength(0);
    expect(recorded.signs).toHaveLength(0);
    expect(recorded.exists).toHaveLength(0);
    expect(recorded.attaches).toHaveLength(0);
  });
});

describe('nothing leaks', () => {
  it('never puts a signed URL in a refusal', async () => {
    for (const doubles of [
      { targetOutcome: 'not_editable' as const },
      { targetOutcome: 'invalid' as const },
      { targetOutcome: 'not_found' as const },
      { signThrows: true },
    ]) {
      await app?.close();
      app = undefined;
      await start(doubles);
      const response = await authorize();
      expect(response.raw).not.toContain('signed-token');
      expect(response.raw).not.toContain(SIGNED_URL);
    }
  });

  it('never echoes the caller token or the internal credential', async () => {
    await start();
    for (const result of [await authorize(), await confirm(), await authorize({ mediaKind: 'x' })]) {
      expect(result.raw).not.toContain(ACCESS_TOKEN);
      expect(result.raw).not.toContain(TEST_INTERNAL_CREDENTIAL);
    }
  });
});

describe('the earlier seller routes are untouched', () => {
  it('the 6-A read still answers', async () => {
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
    expect(JSON.parse(response.body)).toEqual({ seller: IDENTITY });
  });

  it('and it still carries no media path', async () => {
    await start();
    const response = await app!.inject({
      method: 'GET',
      url: '/v1/sellers/me',
      headers: {
        [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL,
        [SESSION_TOKEN_HEADER]: ACCESS_TOKEN,
      },
    });

    expect(response.body).not.toContain('objectPath');
    expect(response.body).not.toContain('seller-media');
  });

  it('no media route appeared on the public seller path', async () => {
    await start();
    const response = await post('/v1/sellers/good-shop/media', { mediaKind: 'logo' });
    expect(response.status).toBe(404);
  });

  it('and `me/media` did not shadow `me`', async () => {
    const recorded = await start();
    await authorize();
    // The media store answered, so the request reached the media controller and not the identity one.
    expect(recorded.targets).toHaveLength(1);
  });

  it('GET is not offered on either media route', async () => {
    await start();
    for (const url of ['/v1/sellers/me/media', '/v1/sellers/me/media/uploads']) {
      const response = await app!.inject({
        method: 'GET',
        url,
        headers: {
          [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL,
          [SESSION_TOKEN_HEADER]: ACCESS_TOKEN,
        },
      });
      expect(response.statusCode, url).toBe(404);
    }
  });

  it('and neither is DELETE: 6-E uploads and records, and removes nothing', async () => {
    await start();
    for (const url of ['/v1/sellers/me/media', '/v1/sellers/me/media/uploads']) {
      const response = await app!.inject({
        method: 'DELETE',
        url,
        headers: {
          [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL,
          [SESSION_TOKEN_HEADER]: ACCESS_TOKEN,
        },
      });
      expect(response.statusCode, url).toBe(404);
    }
  });
});
