import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  ListingMediaAttachResponseSchema,
  ListingMediaListResponseSchema,
  ListingMediaUploadResponseSchema,
  SESSION_TOKEN_HEADER,
} from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { AuthenticationRequiredError } from '../src/auth/auth-errors.js';
import { SUPABASE_AUTH_CLIENT } from '../src/auth/login.service.js';
import { LISTING_MEDIA_STORE } from '../src/catalog/listing-images.js';
import { LISTING_MEDIA_WRITE_STORE } from '../src/catalog/listing-media.service.js';
import {
  SELLER_MEDIA_STORAGE,
  SellerMediaStorageUnavailableError,
} from '../src/sellers/seller-media.storage.js';
import { CURRENT_USER_STORE } from '../src/users/current-user.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';
import { mediaDouble } from './support/listing-media.js';

/**
 * A listing's photographs at the API boundary (increment 0116, migration 0114).
 *
 * The properties this suite exists for:
 *
 * **The browser never names a destination.** Every attempt below to send an `objectPath`, a `bucket` or a
 * `fileName` to the authorization route is refused by the strict contract, and the store call is asserted to
 * carry only the caller's own id, the listing the slug resolved to, and the three values that describe each
 * file. The four paths in the response are the ones the database returned.
 *
 * **No surface ever holds a listing identifier.** Every route is addressed by slug and resolves it through
 * `app_private.listing_media_resolve`, whose predicate is the authorizer — so "not yours" and "no such
 * listing" are one 404, asserted to be indistinguishable in both status and body.
 *
 * **The assurance level comes from the caller's own validated token**, never from the request, and it reaches
 * the database as the parameter every one of these functions takes.
 *
 * **A photograph is four objects or none.** The authorization stops at the first refusal rather than signing
 * the rest, and the confirmation checks all four objects exist before anything is written — the order is
 * asserted, not assumed.
 *
 * **The provider is a port.** The storage client is a double throughout, so what is proven here is the API's
 * logic, independently of Supabase Storage's HTTP surface, which this project exercises nowhere before Final
 * QA.
 *
 * **Nothing leaks.** No signed URL in a refusal, no token, no internal credential, no listing identifier —
 * asserted against the raw response text.
 */

const ACCESS_TOKEN = 'caller-access-token-value-not-a-real-token';
const AAL2_TOKEN = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' }), 'utf8').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'x', aal: 'aal2' }), 'utf8').toString('base64url')}.c2ln`;
const CALLER = '11111111-1111-4111-8111-111111111111';
const LISTING = '22222222-2222-4222-8222-222222222222';
const MEDIA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SIGNED_URL = 'https://provider.invalid/storage/v1/object/upload/sign/listing-variants/x?token=signed';

/** The four objects of one photograph, as a browser that did the canvas work would describe them. */
const FOUR_UPLOADS = {
  variants: [
    { variantKey: 'original', contentType: 'image/jpeg', byteSize: 4_000_000 },
    { variantKey: 'thumb', contentType: 'image/webp', byteSize: 20_000 },
    { variantKey: 'card', contentType: 'image/webp', byteSize: 90_000 },
    { variantKey: 'full', contentType: 'image/webp', byteSize: 300_000 },
  ],
} as const;

function pathFor(key: string): string {
  const bucket = key === 'original' ? 'listing-originals' : 'listing-variants';
  return `${bucket}/${LISTING}/${key}/33333333-3333-4333-8333-333333333333.webp`;
}

const FOUR_ATTACHES = {
  variants: [
    { variantKey: 'original', objectPath: pathFor('original'), width: 4000, height: 3000, byteSize: 4_000_000 },
    { variantKey: 'thumb', objectPath: pathFor('thumb'), width: 320, height: 240, byteSize: 20_000 },
    { variantKey: 'card', objectPath: pathFor('card'), width: 800, height: 600, byteSize: 90_000 },
    { variantKey: 'full', objectPath: pathFor('full'), width: 1600, height: 1200, byteSize: 300_000 },
  ],
} as const;

/** What the manager's reader returns for one ready, published photograph. */
const MANAGER_ROWS = [
  { key: 'thumb', width: 320, height: 240 },
  { key: 'card', width: 800, height: 600 },
  { key: 'full', width: 1600, height: 1200 },
].map((variant) => ({
  mediaId: MEDIA,
  mediaPosition: 0,
  isPrimary: true,
  status: 'ready',
  variantKey: variant.key,
  objectPath: `listing-variants/${LISTING}/${variant.key}/${MEDIA}.webp`,
  width: variant.width,
  height: variant.height,
  isPublic: true,
}));

interface Recorded {
  readonly resolves: { userId: string; slug: string; isAal2: boolean }[];
  readonly targets: { userId: string; listingId: string; variantKey: string; isAal2: boolean }[];
  readonly attaches: { userId: string; listingId: string; count: number; isAal2: boolean }[];
  readonly withdraws: { mediaId: string; isAal2: boolean }[];
  readonly primaries: { mediaId: string; isAal2: boolean }[];
  readonly lists: { listingId: string; isAal2: boolean }[];
  readonly signs: { bucket: string; objectPath: string; contentType: string }[];
  readonly exists: { bucket: string; objectPath: string }[];
}

interface Doubles {
  readonly unresolvable?: boolean;
  readonly targetOutcome?: 'authorized' | 'not_found' | 'invalid' | 'something_else';
  readonly attachOutcome?: 'attached' | 'not_found' | 'invalid';
  readonly refuseWrite?: boolean;
  readonly objectMissing?: boolean;
  readonly signThrows?: boolean;
  readonly storeThrows?: boolean;
  readonly unauthenticated?: boolean;
  readonly managerRows?: readonly (typeof MANAGER_ROWS)[number][];
}

let app: NestFastifyApplication | undefined;

async function start(doubles: Doubles = {}): Promise<Recorded> {
  const recorded: Recorded = {
    resolves: [],
    targets: [],
    attaches: [],
    withdraws: [],
    primaries: [],
    lists: [],
    signs: [],
    exists: [],
  };

  const writeStore = {
    listingMediaResolve: async (input: { userId: string; slug: string; isAal2: boolean }) => {
      recorded.resolves.push(input);
      if (doubles.storeThrows === true) throw new Error('database unavailable');
      return doubles.unresolvable === true ? null : LISTING;
    },
    listingMediaUploadTarget: async (input: {
      userId: string;
      listingId: string;
      variantKey: string;
      contentType: string;
      byteSize: number;
      isAal2: boolean;
    }) => {
      recorded.targets.push({
        userId: input.userId,
        listingId: input.listingId,
        variantKey: input.variantKey,
        isAal2: input.isAal2,
      });
      const outcome = doubles.targetOutcome ?? 'authorized';
      if (outcome !== 'authorized') {
        return { outcome, bucketId: null, objectPath: null, maxByteSize: null };
      }
      return {
        outcome: 'authorized',
        bucketId: input.variantKey === 'original' ? 'listing-originals' : 'listing-variants',
        objectPath: pathFor(input.variantKey),
        maxByteSize: input.variantKey === 'original' ? 26_214_400 : 10_485_760,
      };
    },
    listingMediaAttach: async (input: {
      userId: string;
      listingId: string;
      variants: readonly unknown[];
      isAal2: boolean;
    }) => {
      recorded.attaches.push({
        userId: input.userId,
        listingId: input.listingId,
        count: input.variants.length,
        isAal2: input.isAal2,
      });
      const outcome = doubles.attachOutcome ?? 'attached';
      return outcome === 'attached'
        ? { outcome: 'attached', mediaId: MEDIA }
        : { outcome, mediaId: null };
    },
    listingMediaWithdraw: async (input: { mediaId: string; isAal2: boolean }) => {
      recorded.withdraws.push({ mediaId: input.mediaId, isAal2: input.isAal2 });
      return doubles.refuseWrite !== true;
    },
    listingMediaSetPrimary: async (input: { mediaId: string; isAal2: boolean }) => {
      recorded.primaries.push({ mediaId: input.mediaId, isAal2: input.isAal2 });
      return doubles.refuseWrite !== true;
    },
    listingMediaForManager: async (input: { listingId: string; isAal2: boolean }) => {
      recorded.lists.push({ listingId: input.listingId, isAal2: input.isAal2 });
      return doubles.managerRows ?? MANAGER_ROWS;
    },
  };

  const storage = {
    signUpload: async (bucket: string, objectPath: string, contentType: string) => {
      recorded.signs.push({ bucket, objectPath, contentType });
      if (doubles.signThrows === true) {
        throw new SellerMediaStorageUnavailableError(new Error('provider status 500'));
      }
      return { uploadUrl: SIGNED_URL, expiresAt: new Date('2026-10-10T22:00:00.000Z') };
    },
    objectExists: async (bucket: string, objectPath: string) => {
      recorded.exists.push({ bucket, objectPath });
      return doubles.objectMissing !== true;
    },
    signDownload: async () => {
      throw new Error('a photograph is never signed for reading: the bucket is public');
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
        throw new Error('a photograph request must never sign anyone in');
      },
      revokeAllSessions: async () => {
        throw new Error('a photograph request must never revoke a session');
      },
    })
    .overrideProvider(CURRENT_USER_STORE)
    .useValue({ userIdentity: async (userId: string) => ({ id: userId, displayName: 'Nadia' }) })
    .overrideProvider(LISTING_MEDIA_WRITE_STORE)
    .useValue(writeStore)
    .overrideProvider(LISTING_MEDIA_STORE)
    .useValue(mediaDouble())
    .overrideProvider(SELLER_MEDIA_STORAGE)
    .useValue(storage)
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

afterEach(async () => {
  await app?.close();
  app = undefined;
});

interface Result {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly raw: string;
}

async function call(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  options: { body?: unknown; token?: string | null; credential?: boolean } = {},
): Promise<Result> {
  // `content-type` only when there is a body: Fastify refuses a body-less request that declares one, and a
  // 400 from the parser would be mistaken here for a refusal this API made.
  const headers: Record<string, string> =
    options.body === undefined ? {} : { 'content-type': 'application/json' };
  if (options.credential !== false) headers[INTERNAL_CREDENTIAL_HEADER] = TEST_INTERNAL_CREDENTIAL;
  const token = options.token === undefined ? ACCESS_TOKEN : options.token;
  if (token !== null) headers[SESSION_TOKEN_HEADER] = token;

  const response = await app!.inject({
    method,
    url,
    headers,
    ...(options.body === undefined ? {} : { payload: JSON.stringify(options.body) }),
  });
  return {
    status: response.statusCode,
    body: response.body.length > 0 ? (JSON.parse(response.body) as Record<string, unknown>) : {},
    raw: response.body,
  };
}

describe('GET /v1/listings/:slug/media', () => {
  it('answers 200 with the photographs, matching the contract', async () => {
    await start();
    const result = await call('GET', '/v1/listings/a-flat/media');
    expect(result.status).toBe(200);
    const body = ListingMediaListResponseSchema.parse(result.body);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.variants.map((variant) => variant.key)).toEqual(['thumb', 'card', 'full']);
    // Plain public addresses: nothing is signed, because `listing-variants` is a public bucket and a signed
    // URL inside a cached page would expire and leave a broken image behind.
    expect(body.items[0]?.variants[0]?.url).toBe(
      `https://supabase.invalid/storage/v1/object/public/listing-variants/${LISTING}/thumb/${MEDIA}.webp`,
    );
    expect(result.raw).not.toContain('token=');
  });

  it('resolves the slug first, and asks the database for the listing it may manage', async () => {
    const recorded = await start();
    await call('GET', '/v1/listings/a-flat/media');
    expect(recorded.resolves).toEqual([{ userId: CALLER, slug: 'a-flat', isAal2: false }]);
    expect(recorded.lists).toEqual([{ listingId: LISTING, isAal2: false }]);
  });

  it('carries the caller’s own assurance level, read off their validated token', async () => {
    const recorded = await start();
    await call('GET', '/v1/listings/a-flat/media', { token: AAL2_TOKEN });
    expect(recorded.resolves[0]?.isAal2).toBe(true);
    expect(recorded.lists[0]?.isAal2).toBe(true);
  });

  it('answers 404 for a listing this caller may not manage, and says nothing else', async () => {
    await start({ unresolvable: true });
    const result = await call('GET', '/v1/listings/someone-elses-flat/media');
    expect(result.status).toBe(404);
    expect(result.body).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    // The same answer a listing that does not exist gets, which is what keeps this from being a way to ask.
    expect(result.raw).not.toContain(LISTING);
    expect(result.raw).not.toContain('manage');
  });

  it('says a draft’s photographs are not published', async () => {
    await start({ managerRows: MANAGER_ROWS.map((row) => ({ ...row, isPublic: false })) });
    const body = ListingMediaListResponseSchema.parse(
      (await call('GET', '/v1/listings/a-draft/media')).body,
    );
    expect(body.items[0]?.isPublished).toBe(false);
  });

  it('refuses a session-less request and a credential-less one', async () => {
    await start();
    expect((await call('GET', '/v1/listings/a-flat/media', { token: null })).status).toBe(401);
    expect((await call('GET', '/v1/listings/a-flat/media', { credential: false })).status).toBe(403);
  });

  it('does not shadow the public listing detail', async () => {
    // 4-B's `GET /v1/listings/:slug` is a different, shorter path. The router matches them separately, and a
    // photographs route that swallowed the public read would take the catalogue down.
    await start();
    const result = await call('GET', '/v1/listings/a-flat');
    expect(result.status).not.toBe(404);
    expect(result.status).not.toBe(401);
  });
});

describe('POST /v1/listings/:slug/media/uploads', () => {
  it('authorizes four objects and signs each in its own bucket', async () => {
    const recorded = await start();
    const result = await call('POST', '/v1/listings/a-flat/media/uploads', { body: FOUR_UPLOADS });
    expect(result.status).toBe(201);
    const body = ListingMediaUploadResponseSchema.parse(result.body);
    expect(body.targets.map((target) => target.variantKey)).toEqual(['original', 'thumb', 'card', 'full']);

    // The original goes to the private bucket and the three served sizes to the public one. That split is
    // the database's, and this asserts the service passed it through rather than deciding it.
    expect(recorded.signs.map((sign) => sign.bucket)).toEqual([
      'listing-originals',
      'listing-variants',
      'listing-variants',
      'listing-variants',
    ]);
    expect(recorded.targets.map((target) => target.variantKey)).toEqual([
      'original',
      'thumb',
      'card',
      'full',
    ]);
  });

  it('never lets the request name a destination', async () => {
    await start();
    for (const extra of [
      { objectPath: 'listing-variants/elsewhere/x.webp' },
      { bucket: 'listing-originals' },
      { fileName: 'holiday.jpg' },
      { listingId: LISTING },
    ]) {
      const result = await call('POST', '/v1/listings/a-flat/media/uploads', {
        body: { ...FOUR_UPLOADS, ...extra },
      });
      expect(result.status, JSON.stringify(extra)).toBe(400);
    }
  });

  it('refuses anything that is not exactly the four keys', async () => {
    await start();
    const three = { variants: FOUR_UPLOADS.variants.slice(0, 3) };
    const duplicated = {
      variants: [...FOUR_UPLOADS.variants.slice(0, 3), { ...FOUR_UPLOADS.variants[2]! }],
    };
    expect((await call('POST', '/v1/listings/a-flat/media/uploads', { body: three })).status).toBe(400);
    expect((await call('POST', '/v1/listings/a-flat/media/uploads', { body: duplicated })).status).toBe(400);
  });

  it('stops at the first refusal rather than signing the rest', async () => {
    // Four minutes of credentials for an upload that can never be confirmed is worse than no credentials.
    const recorded = await start({ targetOutcome: 'invalid' });
    const result = await call('POST', '/v1/listings/a-flat/media/uploads', { body: FOUR_UPLOADS });
    expect(result.status).toBe(422);
    expect(recorded.targets).toHaveLength(1);
    expect(recorded.signs).toEqual([]);
  });

  it('answers 503 and no URL when the provider cannot sign', async () => {
    await start({ signThrows: true });
    const result = await call('POST', '/v1/listings/a-flat/media/uploads', { body: FOUR_UPLOADS });
    expect(result.status).toBe(503);
    expect(result.raw).not.toContain('token=');
    expect(result.raw).not.toContain('provider.invalid');
  });

  it('answers 404 before it reads the body, for a listing it cannot resolve', async () => {
    const recorded = await start({ unresolvable: true });
    const result = await call('POST', '/v1/listings/not-mine/media/uploads', { body: FOUR_UPLOADS });
    expect(result.status).toBe(404);
    expect(recorded.targets).toEqual([]);
    expect(recorded.signs).toEqual([]);
  });

  it('refuses a slug that is not shaped like one, without querying', async () => {
    const recorded = await start();
    const result = await call('POST', '/v1/listings/-bad-/media/uploads', { body: FOUR_UPLOADS });
    expect(result.status).toBe(422);
    expect(recorded.resolves).toEqual([]);
  });
});

describe('POST /v1/listings/:slug/media', () => {
  it('checks all four objects exist before it writes anything', async () => {
    const recorded = await start();
    const result = await call('POST', '/v1/listings/a-flat/media', { body: FOUR_ATTACHES });
    expect(result.status).toBe(200);
    const body = ListingMediaAttachResponseSchema.parse(result.body);
    expect(body.attachedId).toBe(MEDIA);
    expect(body.items).toHaveLength(1);

    // Four existence checks, in the bucket each key belongs to, and the bucket prefix stripped for a port
    // whose calls take the two separately.
    expect(recorded.exists).toEqual([
      { bucket: 'listing-originals', objectPath: `${LISTING}/original/33333333-3333-4333-8333-333333333333.webp` },
      { bucket: 'listing-variants', objectPath: `${LISTING}/thumb/33333333-3333-4333-8333-333333333333.webp` },
      { bucket: 'listing-variants', objectPath: `${LISTING}/card/33333333-3333-4333-8333-333333333333.webp` },
      { bucket: 'listing-variants', objectPath: `${LISTING}/full/33333333-3333-4333-8333-333333333333.webp` },
    ]);
    expect(recorded.attaches).toEqual([{ userId: CALLER, listingId: LISTING, count: 4, isAal2: false }]);
  });

  it('refuses a confirmation for bytes nobody uploaded, and writes nothing', async () => {
    const recorded = await start({ objectMissing: true });
    const result = await call('POST', '/v1/listings/a-flat/media', { body: FOUR_ATTACHES });
    expect(result.status).toBe(409);
    expect(recorded.attaches).toEqual([]);
  });

  it('refuses a path outside the bucket its key belongs to, before asking storage', async () => {
    const recorded = await start();
    const result = await call('POST', '/v1/listings/a-flat/media', {
      body: {
        variants: [
          { ...FOUR_ATTACHES.variants[0]!, objectPath: 'listing-variants/elsewhere/original/x.webp' },
          ...FOUR_ATTACHES.variants.slice(1),
        ],
      },
    });
    expect(result.status).toBe(422);
    expect(recorded.exists).toEqual([]);
    expect(recorded.attaches).toEqual([]);
  });

  it('forwards the database’s own refusal as a 422, naming no field', async () => {
    await start({ attachOutcome: 'invalid' });
    const result = await call('POST', '/v1/listings/a-flat/media', { body: FOUR_ATTACHES });
    expect(result.status).toBe(422);
    expect(result.raw).not.toContain('width');
    expect(result.raw).not.toContain('objectPath');
  });

  it('forwards a not_found as the same 404 everything else here answers', async () => {
    await start({ attachOutcome: 'not_found' });
    const result = await call('POST', '/v1/listings/a-flat/media', { body: FOUR_ATTACHES });
    expect(result.status).toBe(404);
    expect(result.body).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('PUT /v1/listings/:slug/media/:mediaId/primary and DELETE', () => {
  it('makes one photograph primary and answers with the list as it now stands', async () => {
    const recorded = await start();
    const result = await call('PUT', `/v1/listings/a-flat/media/${MEDIA}/primary`);
    expect(result.status).toBe(200);
    expect(ListingMediaListResponseSchema.parse(result.body).items).toHaveLength(1);
    expect(recorded.primaries).toEqual([{ mediaId: MEDIA, isAal2: false }]);
  });

  it('withdraws one photograph and answers with the list as it now stands', async () => {
    const recorded = await start();
    const result = await call('DELETE', `/v1/listings/a-flat/media/${MEDIA}`);
    expect(result.status).toBe(200);
    expect(ListingMediaListResponseSchema.parse(result.body).items).toHaveLength(1);
    expect(recorded.withdraws).toEqual([{ mediaId: MEDIA, isAal2: false }]);
  });

  it('answers 404 when the database refuses either, which covers both of its two cases', async () => {
    // `listing_media_withdraw` and `listing_media_set_primary` return false for a caller who may not and for
    // a photograph that is not there. One answer, deliberately, so neither can be told from the other.
    await start({ refuseWrite: true });
    expect((await call('DELETE', `/v1/listings/a-flat/media/${MEDIA}`)).status).toBe(404);
    expect((await call('PUT', `/v1/listings/a-flat/media/${MEDIA}/primary`)).status).toBe(404);
  });

  it('refuses a photograph identifier that is not a uuid, without querying', async () => {
    const recorded = await start();
    expect((await call('DELETE', '/v1/listings/a-flat/media/not-a-uuid')).status).toBe(422);
    expect(recorded.withdraws).toEqual([]);
  });

  it('answers 503 and leaks nothing when the database cannot be reached', async () => {
    await start({ storeThrows: true });
    const result = await call('DELETE', `/v1/listings/a-flat/media/${MEDIA}`);
    expect(result.status).toBe(503);
    expect(result.raw).not.toContain('unavailable\\n');
    expect(result.raw).not.toContain(ACCESS_TOKEN);
    expect(result.raw).not.toContain(TEST_INTERNAL_CREDENTIAL);
  });
});
