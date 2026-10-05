import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  CmsMediaAttachResponseSchema,
  CmsMediaPageResponseSchema,
  CmsMediaPreviewResponseSchema,
  CmsMediaUploadResponseSchema,
  CmsMediaUsageResponseSchema,
  CmsMediaWriteResponseSchema,
  SESSION_TOKEN_HEADER,
} from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { AuthenticationRequiredError } from '../src/auth/auth-errors.js';
import { CMS_MEDIA_STORE } from '../src/admin/cms-media.service.js';
import { encodeCmsMediaCursor } from '../src/admin/cms-media.cursor.js';
import {
  SELLER_MEDIA_STORAGE,
  SellerMediaStorageUnavailableError,
} from '../src/sellers/seller-media.storage.js';
import { SUPABASE_AUTH_CLIENT } from '../src/auth/login.service.js';
import { STAFF_CONSOLE_STORE, type StaffConsoleRow } from '../src/admin/staff-console.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * The CMS media library at the API boundary (0098).
 *
 * The properties this suite exists for:
 *
 * **One key gates everything.** `cms.media.manage` opens the section and authorises every write; there is no
 * `cms.media.read` and an invented one is not accepted as a substitute. A caller holding every other console key in
 * the platform reaches nothing here, at `aal2` included.
 *
 * **A client never names a path.** The upload request is strict and refuses an `objectPath` outright, and the path in
 * the answer is the one the database composed.
 *
 * **The confirmation asks storage first.** Asserted from the recorded order of calls, not inferred: `objectExists`
 * runs before the attach, so a confirmation for a file nobody uploaded never reaches a write. When the object is
 * absent the store is never asked at all.
 *
 * **Failure-safe when storage is unavailable.** A signature that cannot be issued is a 503 and no upload; an
 * existence check that throws is a 503 and no row; a preview that cannot be signed is a 503. In each case the store
 * is asserted not to have been written to.
 *
 * **A signed preview targets exactly the stored object.** The bucket and path handed to the port are the ones the
 * database returned for that row, and nothing composes a path on the way.
 *
 * **A delete is the row and nothing else**, and the three refusals the bucket and 0030 decide are reported with our
 * own codes rather than the database's words.
 *
 * Everything is stubbed at the store and port boundaries: no database, no provider, no network.
 */

const STAFF = '11111111-1111-4111-8111-111111111111';
const MEDIA = 'cd000000-0000-4000-8000-0000000000a1';
const OBJECT_PATH = 'cms-media/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png';

function token(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.c2lnbmF0dXJl`;
}

const ACCESS_TOKEN = token({ sub: STAFF, aal: 'aal2' });
const AAL1_TOKEN = token({ sub: STAFF, aal: 'aal1' });

const MANAGE = 'cms.media.manage';

/** Every other key a console surface uses, plus an invented read key that must not open this one. */
const OTHER_KEYS = [
  'cms.media.read',
  'cms.page.read',
  'cms.page.manage',
  'cms.blog.read',
  'cms.homepage.read',
  'cms.navigation.read',
  'cms.faq.read',
  'cms.banner.read',
  'cms.banner.manage',
  'seo.settings.manage',
  'seo.metadata.manage',
  'audit.read',
  'users.role.manage',
] as const;

const ROW = {
  mediaId: MEDIA,
  objectPath: OBJECT_PATH,
  mimeType: 'image/png',
  width: 800,
  height: 600,
  byteSize: '4096',
  altTextEn: 'A photo',
  altTextAr: null,
  usageCount: 2,
  createdAt: '2026-05-02T09:00:00.000Z',
  updatedAt: '2026-05-02T09:00:00.000Z',
};

const USAGE_ROWS = [
  { entityType: 'page', entityId: 'cd100000-0000-4000-8000-000000000001', entityLabel: 'about', entityColumn: 'cover_media_id' },
  { entityType: 'seo_settings', entityId: null, entityLabel: 'en', entityColumn: 'default_share_media_id' },
];

interface Seen {
  name: string;
  input: unknown;
}

interface Doubles {
  permissions?: readonly string[];
  unauthenticated?: boolean;
  rows?: readonly unknown[];
  readError?: boolean;
  uploadTarget?: { outcome: string; bucketId: string | null; objectPath: string | null; maxByteSize: string | null };
  attachResult?: { outcome: string; mediaId: string | null };
  readTarget?: { outcome: string; bucketId: string | null; objectPath: string | null };
  usageRows?: readonly unknown[];
  writeResult?: boolean;
  writeError?: { code: string };
  objectExists?: boolean;
  objectExistsThrows?: boolean;
  signUploadThrows?: boolean;
  signDownloadThrows?: boolean;
}

let app: NestFastifyApplication | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function sqlError(code: string): Error & { code: string } {
  const error = new Error('the database refused the write') as Error & { code: string };
  error.code = code;
  return error;
}

async function createApp(doubles: Doubles = {}): Promise<Seen[]> {
  const seen: Seen[] = [];

  const store = {
    cmsMediaUploadTarget: async (input: unknown) => {
      seen.push({ name: 'cmsMediaUploadTarget', input });
      if (doubles.readError === true) throw new Error('the database is unavailable');
      return (
        doubles.uploadTarget ?? {
          outcome: 'authorized',
          bucketId: 'cms-media',
          objectPath: OBJECT_PATH,
          maxByteSize: '10485760',
        }
      );
    },
    cmsMediaAttach: async (input: unknown) => {
      seen.push({ name: 'cmsMediaAttach', input });
      if (doubles.writeError !== undefined) throw sqlError(doubles.writeError.code);
      return doubles.attachResult ?? { outcome: 'attached', mediaId: MEDIA };
    },
    cmsMediaForStaff: async (input: unknown) => {
      seen.push({ name: 'cmsMediaForStaff', input });
      if (doubles.readError === true) throw new Error('the database is unavailable');
      return doubles.rows ?? [ROW];
    },
    cmsMediaUsage: async (input: unknown) => {
      seen.push({ name: 'cmsMediaUsage', input });
      if (doubles.readError === true) throw new Error('the database is unavailable');
      return doubles.usageRows ?? USAGE_ROWS;
    },
    cmsMediaReadTarget: async (input: unknown) => {
      seen.push({ name: 'cmsMediaReadTarget', input });
      if (doubles.readError === true) throw new Error('the database is unavailable');
      return doubles.readTarget ?? { outcome: 'authorized', bucketId: 'cms-media', objectPath: OBJECT_PATH };
    },
    cmsMediaAltTextForStaff: async (input: unknown) => {
      seen.push({ name: 'cmsMediaAltTextForStaff', input });
      if (doubles.writeError !== undefined) throw sqlError(doubles.writeError.code);
      return doubles.writeResult ?? true;
    },
    cmsMediaDeleteForStaff: async (input: unknown) => {
      seen.push({ name: 'cmsMediaDeleteForStaff', input });
      if (doubles.writeError !== undefined) throw sqlError(doubles.writeError.code);
      return doubles.writeResult ?? true;
    },
  };

  const storage = {
    signUpload: async (bucket: string, objectPath: string, contentType: string) => {
      seen.push({ name: 'signUpload', input: { bucket, objectPath, contentType } });
      if (doubles.signUploadThrows === true) throw new SellerMediaStorageUnavailableError(new Error('the provider could not be reached'));
      return { uploadUrl: 'https://storage.test/upload/opaque', expiresAt: new Date('2026-05-02T09:05:00.000Z') };
    },
    objectExists: async (bucket: string, objectPath: string) => {
      seen.push({ name: 'objectExists', input: { bucket, objectPath } });
      if (doubles.objectExistsThrows === true) throw new SellerMediaStorageUnavailableError(new Error('the provider could not be reached'));
      return doubles.objectExists ?? true;
    },
    signDownload: async (bucket: string, objectPath: string) => {
      seen.push({ name: 'signDownload', input: { bucket, objectPath } });
      if (doubles.signDownloadThrows === true) throw new SellerMediaStorageUnavailableError(new Error('the provider could not be reached'));
      return { url: 'https://storage.test/read/opaque', expiresAt: new Date('2026-05-02T09:05:00.000Z') };
    },
  };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(TEST_ENV)] })
    .overrideProvider(SUPABASE_AUTH_CLIENT)
    .useValue({
      getUser: async () => {
        if (doubles.unauthenticated === true) throw new AuthenticationRequiredError();
        return { id: STAFF, phone: null };
      },
      signInWithPassword: async () => {
        throw new Error('reading the media library must never sign anyone in');
      },
      revokeAllSessions: async () => {
        throw new Error('reading the media library must never revoke a session');
      },
    })
    .overrideProvider(STAFF_CONSOLE_STORE)
    .useValue({
      staffConsoleAccess: async (input: { userId: string; isAal2: boolean }): Promise<StaffConsoleRow> => {
        const granted = [...(doubles.permissions ?? [MANAGE])];
        return {
          hasConsoleRole: true,
          requiresStepUp: false,
          roles: ['admin'],
          permissions: input.isAal2 ? granted : [],
        };
      },
      buyerProfile: async (userId: string) => ({ id: userId, displayName: 'Nadia', localeCode: 'en' }),
    })
    .overrideProvider(CMS_MEDIA_STORE)
    .useValue(store)
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

const CONFIRM = { objectPath: OBJECT_PATH, contentType: 'image/png', byteSize: 4096 } as const;

/* ------------------------------------------------------------------------------------------------ */
/* Reading the library                                                                               */
/* ------------------------------------------------------------------------------------------------ */

describe('GET /v1/admin/cms/media', () => {
  it('returns one page with the entries and the capability', async () => {
    await createApp();
    const response = await request({ method: 'GET', url: '/v1/admin/cms/media', accessToken: ACCESS_TOKEN });
    expect(response.statusCode).toBe(200);
    const body = CmsMediaPageResponseSchema.parse(response.json());
    expect(body.items[0]?.id).toBe(MEDIA);
    expect(body.items[0]?.objectPath).toBe(OBJECT_PATH);
    expect(body.items[0]?.usageCount).toBe(2);
    expect(body.canManage).toBe(true);
    expect(body.nextCursor).toBeNull();
  });

  it('never carries a URL in the list, because the bucket is private', async () => {
    await createApp();
    const response = await request({ method: 'GET', url: '/v1/admin/cms/media', accessToken: ACCESS_TOKEN });
    expect(JSON.stringify(response.json())).not.toContain('http');
  });

  it('asks for one more row than the page, so another page is known rather than guessed', async () => {
    const seen = await createApp();
    await request({ method: 'GET', url: '/v1/admin/cms/media?limit=5', accessToken: ACCESS_TOKEN });
    expect((seen.find((entry) => entry.name === 'cmsMediaForStaff')?.input as { limit: number }).limit).toBe(6);
  });

  it('offers a cursor only when there is another page', async () => {
    await createApp({
      rows: Array.from({ length: 25 }, (_unused, index) => ({
        ...ROW,
        mediaId: `cd${index.toString(16).padStart(6, '0')}-0000-4000-8000-0000000000a1`,
      })),
    });
    const response = await request({ method: 'GET', url: '/v1/admin/cms/media', accessToken: ACCESS_TOKEN });
    expect(CmsMediaPageResponseSchema.parse(response.json()).nextCursor).not.toBeNull();
  });

  it('passes a decoded cursor to the store as two typed values', async () => {
    const cursor = encodeCmsMediaCursor({ createdAt: '2026-05-02T09:00:00.000Z', id: MEDIA });
    const seen = await createApp();
    await request({
      method: 'GET',
      url: `/v1/admin/cms/media?cursor=${encodeURIComponent(cursor)}`,
      accessToken: ACCESS_TOKEN,
    });
    const input = seen.find((entry) => entry.name === 'cmsMediaForStaff')?.input as {
      afterCreatedAt: string;
      afterId: string;
    };
    expect(input.afterCreatedAt).toBe('2026-05-02T09:00:00.000Z');
    expect(input.afterId).toBe(MEDIA);
  });

  it('treats a forged cursor as an absence and never reads', async () => {
    const seen = await createApp();
    for (const cursor of ['not-a-cursor', 'ZmFrZQ', 'cm1|x', '!!!!']) {
      const response = await request({
        method: 'GET',
        url: `/v1/admin/cms/media?cursor=${encodeURIComponent(cursor)}`,
        accessToken: ACCESS_TOKEN,
      });
      expect(response.statusCode, cursor).toBe(404);
    }
    expect(seen.some((entry) => entry.name === 'cmsMediaForStaff')).toBe(false);
  });

  it('refuses a limit that is not a limit', async () => {
    await createApp();
    for (const limit of ['0', '-1', 'ten', '1.5', '1000000']) {
      const response = await request({
        method: 'GET',
        url: `/v1/admin/cms/media?limit=${limit}`,
        accessToken: ACCESS_TOKEN,
      });
      expect([200, 400], limit).toContain(response.statusCode);
    }
  });

  it('needs a session, the credential, and aal2', async () => {
    await createApp();
    expect((await request({ method: 'GET', url: '/v1/admin/cms/media' })).statusCode).toBe(401);
    expect(
      (
        await request({
          method: 'GET',
          url: '/v1/admin/cms/media',
          accessToken: ACCESS_TOKEN,
          credential: 'not-the-credential',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await request({ method: 'GET', url: '/v1/admin/cms/media', accessToken: AAL1_TOKEN })).statusCode,
    ).toBe(404);
  });

  it('is a 404 for a caller holding every other console key, invented read key included', async () => {
    const seen = await createApp({ permissions: OTHER_KEYS });
    const response = await request({ method: 'GET', url: '/v1/admin/cms/media', accessToken: ACCESS_TOKEN });
    expect(response.statusCode).toBe(404);
    expect(seen.some((entry) => entry.name === 'cmsMediaForStaff')).toBe(false);
  });

  it('is a 503 when the library cannot be read', async () => {
    await createApp({ readError: true });
    expect(
      (await request({ method: 'GET', url: '/v1/admin/cms/media', accessToken: ACCESS_TOKEN })).statusCode,
    ).toBe(503);
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* Authorizing an upload                                                                             */
/* ------------------------------------------------------------------------------------------------ */

describe('POST /v1/admin/cms/media/uploads', () => {
  it('authorizes one upload and signs the path the database composed', async () => {
    const seen = await createApp();
    const response = await request({
      method: 'POST',
      url: '/v1/admin/cms/media/uploads',
      accessToken: ACCESS_TOKEN,
      payload: { contentType: 'image/png', byteSize: 4096 },
    });
    expect(response.statusCode).toBe(201);
    const body = CmsMediaUploadResponseSchema.parse(response.json());
    expect(body.upload.objectPath).toBe(OBJECT_PATH);
    expect(body.upload.uploadUrl).toBe('https://storage.test/upload/opaque');
    expect(body.upload.maxByteSize).toBe(10_485_760);
    // The path handed to the provider is the database's, not one this layer built.
    expect(seen.find((entry) => entry.name === 'signUpload')?.input).toEqual({
      bucket: 'cms-media',
      objectPath: OBJECT_PATH,
      contentType: 'image/png',
    });
  });

  it('asks the database before it asks the provider', async () => {
    const seen = await createApp();
    await request({
      method: 'POST',
      url: '/v1/admin/cms/media/uploads',
      accessToken: ACCESS_TOKEN,
      payload: { contentType: 'image/png', byteSize: 4096 },
    });
    const order = seen.map((entry) => entry.name);
    expect(order.indexOf('cmsMediaUploadTarget')).toBeLessThan(order.indexOf('signUpload'));
  });

  it('refuses a request that names a path', async () => {
    const seen = await createApp();
    const response = await request({
      method: 'POST',
      url: '/v1/admin/cms/media/uploads',
      accessToken: ACCESS_TOKEN,
      payload: { contentType: 'image/png', byteSize: 4096, objectPath: 'cms-media/mine.png' },
    });
    expect(response.statusCode).toBe(400);
    expect(seen.some((entry) => entry.name === 'cmsMediaUploadTarget')).toBe(false);
  });

  it('refuses a content type the bucket does not allow, SVG included', async () => {
    const seen = await createApp();
    for (const contentType of ['image/svg+xml', 'text/html', 'application/pdf', 'image/gif']) {
      const response = await request({
        method: 'POST',
        url: '/v1/admin/cms/media/uploads',
        accessToken: ACCESS_TOKEN,
        payload: { contentType, byteSize: 4096 },
      });
      expect(response.statusCode, contentType).toBe(400);
    }
    expect(seen.some((entry) => entry.name === 'signUpload')).toBe(false);
  });

  it('refuses a size outside the bucket limit', async () => {
    await createApp();
    for (const byteSize of [0, -1, 10_485_761]) {
      const response = await request({
        method: 'POST',
        url: '/v1/admin/cms/media/uploads',
        accessToken: ACCESS_TOKEN,
        payload: { contentType: 'image/png', byteSize },
      });
      expect(response.statusCode, String(byteSize)).toBe(400);
    }
  });

  it('turns the database refusing the value into a 409 with our own code', async () => {
    await createApp({
      uploadTarget: { outcome: 'invalid', bucketId: null, objectPath: null, maxByteSize: null },
    });
    const response = await request({
      method: 'POST',
      url: '/v1/admin/cms/media/uploads',
      accessToken: ACCESS_TOKEN,
      payload: { contentType: 'image/png', byteSize: 4096 },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('CMS_MEDIA_NOT_ALLOWED');
  });

  it('turns the database refusing the caller into a 404', async () => {
    await createApp({
      uploadTarget: { outcome: 'not_found', bucketId: null, objectPath: null, maxByteSize: null },
    });
    const response = await request({
      method: 'POST',
      url: '/v1/admin/cms/media/uploads',
      accessToken: ACCESS_TOKEN,
      payload: { contentType: 'image/png', byteSize: 4096 },
    });
    expect(response.statusCode).toBe(404);
  });

  it('is a 503 and no upload when the signature cannot be issued', async () => {
    // Failure-safe: no signature means no upload, never an upload nobody authorized.
    await createApp({ signUploadThrows: true });
    const response = await request({
      method: 'POST',
      url: '/v1/admin/cms/media/uploads',
      accessToken: ACCESS_TOKEN,
      payload: { contentType: 'image/png', byteSize: 4096 },
    });
    expect(response.statusCode).toBe(503);
    expect(JSON.stringify(response.json())).not.toContain('storage.test');
  });

  it('is a 404 for a caller without the key, and signs nothing', async () => {
    const seen = await createApp({ permissions: OTHER_KEYS });
    const response = await request({
      method: 'POST',
      url: '/v1/admin/cms/media/uploads',
      accessToken: ACCESS_TOKEN,
      payload: { contentType: 'image/png', byteSize: 4096 },
    });
    expect(response.statusCode).toBe(404);
    expect(seen.some((entry) => entry.name === 'signUpload')).toBe(false);
  });

  it('is a 404 at aal1, and signs nothing', async () => {
    const seen = await createApp();
    const response = await request({
      method: 'POST',
      url: '/v1/admin/cms/media/uploads',
      accessToken: AAL1_TOKEN,
      payload: { contentType: 'image/png', byteSize: 4096 },
    });
    expect(response.statusCode).toBe(404);
    expect(seen.some((entry) => entry.name === 'signUpload')).toBe(false);
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* Confirming it                                                                                     */
/* ------------------------------------------------------------------------------------------------ */

describe('POST /v1/admin/cms/media', () => {
  it('records the entry and answers with its identifier', async () => {
    const seen = await createApp();
    const response = await request({
      method: 'POST',
      url: '/v1/admin/cms/media',
      accessToken: ACCESS_TOKEN,
      payload: { ...CONFIRM, width: 800, height: 600, altTextEn: 'A photo', altTextAr: null },
    });
    expect(response.statusCode).toBe(201);
    expect(CmsMediaAttachResponseSchema.parse(response.json()).id).toBe(MEDIA);
    expect(seen.find((entry) => entry.name === 'cmsMediaAttach')?.input).toEqual({
      userId: STAFF,
      isAal2: true,
      objectPath: OBJECT_PATH,
      mimeType: 'image/png',
      byteSize: 4096,
      width: 800,
      height: 600,
      altTextEn: 'A photo',
      altTextAr: null,
    });
  });

  it('asks storage whether the object is there BEFORE it writes anything', async () => {
    // The ordering is the point: a confirmation for a file nobody uploaded must never reach a write.
    const seen = await createApp();
    await request({ method: 'POST', url: '/v1/admin/cms/media', accessToken: ACCESS_TOKEN, payload: CONFIRM });
    const order = seen.map((entry) => entry.name);
    expect(order.indexOf('objectExists')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('objectExists')).toBeLessThan(order.indexOf('cmsMediaAttach'));
    expect(seen.find((entry) => entry.name === 'objectExists')?.input).toEqual({
      bucket: 'cms-media',
      objectPath: OBJECT_PATH,
    });
  });

  it('refuses and writes nothing when the object is not there', async () => {
    const seen = await createApp({ objectExists: false });
    const response = await request({
      method: 'POST',
      url: '/v1/admin/cms/media',
      accessToken: ACCESS_TOKEN,
      payload: CONFIRM,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('CMS_MEDIA_OBJECT_MISSING');
    expect(seen.some((entry) => entry.name === 'cmsMediaAttach')).toBe(false);
  });

  it('is a 503 and writes nothing when storage cannot be asked', async () => {
    const seen = await createApp({ objectExistsThrows: true });
    const response = await request({
      method: 'POST',
      url: '/v1/admin/cms/media',
      accessToken: ACCESS_TOKEN,
      payload: CONFIRM,
    });
    expect(response.statusCode).toBe(503);
    expect(seen.some((entry) => entry.name === 'cmsMediaAttach')).toBe(false);
  });

  it('refuses a path that is not the shape the authorizer issues, before touching storage', async () => {
    const seen = await createApp();
    for (const objectPath of [
      'cms-media/../secret.png',
      'cms-media/a/b.png',
      'seller-media/x.png',
      'listing-variants/x.png',
      'cms-media/photo.png',
      'cms-media/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.svg',
      'cms-media/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png.html',
      'x/cms-media/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png',
      '',
    ]) {
      const response = await request({
        method: 'POST',
        url: '/v1/admin/cms/media',
        accessToken: ACCESS_TOKEN,
        payload: { ...CONFIRM, objectPath },
      });
      expect(response.statusCode, objectPath).toBe(400);
    }
    expect(seen.some((entry) => entry.name === 'objectExists')).toBe(false);
  });

  it('refuses a content type the bucket does not allow', async () => {
    await createApp();
    const response = await request({
      method: 'POST',
      url: '/v1/admin/cms/media',
      accessToken: ACCESS_TOKEN,
      payload: { ...CONFIRM, contentType: 'image/svg+xml' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses a dimension that is not positive, which 0030 also refuses', async () => {
    await createApp();
    for (const extra of [{ width: 0 }, { height: -1 }, { width: 1.5 }]) {
      const response = await request({
        method: 'POST',
        url: '/v1/admin/cms/media',
        accessToken: ACCESS_TOKEN,
        payload: { ...CONFIRM, ...extra },
      });
      expect(response.statusCode, JSON.stringify(extra)).toBe(400);
    }
  });

  it('refuses an alt text past 0030 bound', async () => {
    await createApp();
    const response = await request({
      method: 'POST',
      url: '/v1/admin/cms/media',
      accessToken: ACCESS_TOKEN,
      payload: { ...CONFIRM, altTextEn: 'a'.repeat(301) },
    });
    expect(response.statusCode).toBe(400);
  });

  it('reports a retried confirmation as its own refusal', async () => {
    await createApp({ attachResult: { outcome: 'taken', mediaId: null } });
    const response = await request({
      method: 'POST',
      url: '/v1/admin/cms/media',
      accessToken: ACCESS_TOKEN,
      payload: CONFIRM,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('CMS_MEDIA_PATH_TAKEN');
  });

  it('turns a refused value into a 409 and the database refusing the caller into a 404', async () => {
    await createApp({ attachResult: { outcome: 'invalid', mediaId: null } });
    expect(
      (
        await request({
          method: 'POST',
          url: '/v1/admin/cms/media',
          accessToken: ACCESS_TOKEN,
          payload: CONFIRM,
        })
      ).statusCode,
    ).toBe(409);

    await app?.close();
    app = undefined;
    await createApp({ attachResult: { outcome: 'not_found', mediaId: null } });
    expect(
      (
        await request({
          method: 'POST',
          url: '/v1/admin/cms/media',
          accessToken: ACCESS_TOKEN,
          payload: CONFIRM,
        })
      ).statusCode,
    ).toBe(404);
  });

  it('turns a 42501 into a 404 rather than a 403', async () => {
    await createApp({ writeError: { code: '42501' } });
    expect(
      (
        await request({
          method: 'POST',
          url: '/v1/admin/cms/media',
          accessToken: ACCESS_TOKEN,
          payload: CONFIRM,
        })
      ).statusCode,
    ).toBe(404);
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* Usage, preview, alt text and removal                                                              */
/* ------------------------------------------------------------------------------------------------ */

describe('GET /v1/admin/cms/media/{mediaId}/usage', () => {
  it('reports every reference, including the locale-keyed one with no identifier', async () => {
    await createApp();
    const response = await request({
      method: 'GET',
      url: `/v1/admin/cms/media/${MEDIA}/usage`,
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(200);
    const body = CmsMediaUsageResponseSchema.parse(response.json());
    expect(body.references).toHaveLength(2);
    expect(body.references[0]?.entityType).toBe('page');
    expect(body.references[0]?.column).toBe('cover_media_id');
    expect(body.references[1]?.entityId).toBeNull();
    expect(body.references[1]?.label).toBe('en');
  });

  it('reports no references as an empty list rather than a 404', async () => {
    await createApp({ usageRows: [] });
    const response = await request({
      method: 'GET',
      url: `/v1/admin/cms/media/${MEDIA}/usage`,
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(200);
    expect(CmsMediaUsageResponseSchema.parse(response.json()).references).toEqual([]);
  });

  it('refuses an identifier that is not one, and is a 404 without the key', async () => {
    await createApp();
    expect(
      (await request({ method: 'GET', url: '/v1/admin/cms/media/not-a-uuid/usage', accessToken: ACCESS_TOKEN }))
        .statusCode,
    ).toBe(400);

    await app?.close();
    app = undefined;
    const seen = await createApp({ permissions: OTHER_KEYS });
    expect(
      (await request({ method: 'GET', url: `/v1/admin/cms/media/${MEDIA}/usage`, accessToken: ACCESS_TOKEN }))
        .statusCode,
    ).toBe(404);
    expect(seen.some((entry) => entry.name === 'cmsMediaUsage')).toBe(false);
  });
});

describe('GET /v1/admin/cms/media/{mediaId}/preview', () => {
  it('signs exactly the object the row stores', async () => {
    const seen = await createApp();
    const response = await request({
      method: 'GET',
      url: `/v1/admin/cms/media/${MEDIA}/preview`,
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(200);
    const body = CmsMediaPreviewResponseSchema.parse(response.json());
    expect(body.url).toBe('https://storage.test/read/opaque');
    expect(body.id).toBe(MEDIA);
    // The bucket and path are the database's answer for that row, and nothing composed them here.
    expect(seen.find((entry) => entry.name === 'signDownload')?.input).toEqual({
      bucket: 'cms-media',
      objectPath: OBJECT_PATH,
    });
  });

  it('asks the database for the target before it asks the provider', async () => {
    const seen = await createApp();
    await request({ method: 'GET', url: `/v1/admin/cms/media/${MEDIA}/preview`, accessToken: ACCESS_TOKEN });
    const order = seen.map((entry) => entry.name);
    expect(order.indexOf('cmsMediaReadTarget')).toBeLessThan(order.indexOf('signDownload'));
  });

  it('is a 404 when the row does not exist, and signs nothing', async () => {
    const seen = await createApp({
      readTarget: { outcome: 'not_found', bucketId: null, objectPath: null },
    });
    const response = await request({
      method: 'GET',
      url: `/v1/admin/cms/media/${MEDIA}/preview`,
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(404);
    expect(seen.some((entry) => entry.name === 'signDownload')).toBe(false);
  });

  it('is a 503 when the read cannot be signed, and leaks nothing about it', async () => {
    await createApp({ signDownloadThrows: true });
    const response = await request({
      method: 'GET',
      url: `/v1/admin/cms/media/${MEDIA}/preview`,
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(503);
    expect(JSON.stringify(response.json())).not.toContain('storage.test');
  });

  it('is a 404 at aal1 and signs nothing', async () => {
    const seen = await createApp();
    expect(
      (await request({ method: 'GET', url: `/v1/admin/cms/media/${MEDIA}/preview`, accessToken: AAL1_TOKEN }))
        .statusCode,
    ).toBe(404);
    expect(seen.some((entry) => entry.name === 'signDownload')).toBe(false);
  });
});

describe('PUT /v1/admin/cms/media/{mediaId}/alt-text', () => {
  it('writes both alt texts, and neither is required', async () => {
    const seen = await createApp();
    const response = await request({
      method: 'PUT',
      url: `/v1/admin/cms/media/${MEDIA}/alt-text`,
      accessToken: ACCESS_TOKEN,
      payload: { altTextEn: 'A photo', altTextAr: 'صورة' },
    });
    expect(response.statusCode).toBe(200);
    expect(CmsMediaWriteResponseSchema.parse(response.json()).ok).toBe(true);
    expect(seen.find((entry) => entry.name === 'cmsMediaAltTextForStaff')?.input).toEqual({
      userId: STAFF,
      isAal2: true,
      mediaId: MEDIA,
      altTextEn: 'A photo',
      altTextAr: 'صورة',
    });
  });

  it('accepts an empty body, which clears both', async () => {
    const seen = await createApp();
    const response = await request({
      method: 'PUT',
      url: `/v1/admin/cms/media/${MEDIA}/alt-text`,
      accessToken: ACCESS_TOKEN,
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    const input = seen.find((entry) => entry.name === 'cmsMediaAltTextForStaff')?.input as {
      altTextEn: string | null;
      altTextAr: string | null;
    };
    expect(input.altTextEn).toBeNull();
    expect(input.altTextAr).toBeNull();
  });

  it('refuses a field the contract does not name, and one past the bound', async () => {
    await createApp();
    expect(
      (
        await request({
          method: 'PUT',
          url: `/v1/admin/cms/media/${MEDIA}/alt-text`,
          accessToken: ACCESS_TOKEN,
          payload: { altTextEn: 'x', objectPath: 'cms-media/other.png' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await request({
          method: 'PUT',
          url: `/v1/admin/cms/media/${MEDIA}/alt-text`,
          accessToken: ACCESS_TOKEN,
          payload: { altTextEn: 'a'.repeat(301) },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('is a 404 when the entry does not exist', async () => {
    await createApp({ writeResult: false });
    expect(
      (
        await request({
          method: 'PUT',
          url: `/v1/admin/cms/media/${MEDIA}/alt-text`,
          accessToken: ACCESS_TOKEN,
          payload: { altTextEn: 'x' },
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('DELETE /v1/admin/cms/media/{mediaId}', () => {
  it('removes the entry and answers ok', async () => {
    const seen = await createApp();
    const response = await request({
      method: 'DELETE',
      url: `/v1/admin/cms/media/${MEDIA}`,
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(200);
    expect(CmsMediaWriteResponseSchema.parse(response.json()).ok).toBe(true);
    expect(seen.find((entry) => entry.name === 'cmsMediaDeleteForStaff')?.input).toEqual({
      userId: STAFF,
      isAal2: true,
      mediaId: MEDIA,
    });
  });

  it('never asks storage to remove anything, because the port has no such call', async () => {
    const seen = await createApp();
    await request({ method: 'DELETE', url: `/v1/admin/cms/media/${MEDIA}`, accessToken: ACCESS_TOKEN });
    expect(seen.map((entry) => entry.name)).not.toContain('signUpload');
    expect(seen.map((entry) => entry.name)).not.toContain('objectExists');
    expect(seen.map((entry) => entry.name)).not.toContain('signDownload');
  });

  it('is a 404 when the entry does not exist, and at aal1', async () => {
    await createApp({ writeResult: false });
    expect(
      (await request({ method: 'DELETE', url: `/v1/admin/cms/media/${MEDIA}`, accessToken: ACCESS_TOKEN }))
        .statusCode,
    ).toBe(404);

    await app?.close();
    app = undefined;
    const seen = await createApp();
    expect(
      (await request({ method: 'DELETE', url: `/v1/admin/cms/media/${MEDIA}`, accessToken: AAL1_TOKEN }))
        .statusCode,
    ).toBe(404);
    expect(seen.some((entry) => entry.name === 'cmsMediaDeleteForStaff')).toBe(false);
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* What this surface does not have                                                                   */
/* ------------------------------------------------------------------------------------------------ */

describe('the shape of this surface', () => {
  it('has no public route: nothing here serves an image to anybody', async () => {
    // Owner decision 4. These are the addresses a consuming increment would add, and none exists.
    await createApp();
    for (const url of ['/v1/cms/media', '/v1/media', `/v1/cms/media/${MEDIA}`, `/v1/media/${MEDIA}/url`]) {
      const response = await request({ method: 'GET', url, accessToken: ACCESS_TOKEN });
      expect(response.statusCode, url).toBe(404);
    }
  });

  it('has no banner route, because 0098 builds no banner', async () => {
    await createApp();
    for (const url of ['/v1/admin/cms/banners', '/v1/cms/banners']) {
      const response = await request({ method: 'GET', url, accessToken: ACCESS_TOKEN });
      expect(response.statusCode, url).toBe(404);
    }
  });

  it('has no route that replaces a stored object in place', async () => {
    await createApp();
    const response = await request({
      method: 'PUT',
      url: `/v1/admin/cms/media/${MEDIA}`,
      accessToken: ACCESS_TOKEN,
      payload: CONFIRM,
    });
    expect(response.statusCode).toBe(404);
  });
});
