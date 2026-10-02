import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  SellerVerificationDocumentCountResponseSchema,
  SellerVerificationResponseSchema,
  SellerVerificationStateResponseSchema,
  SellerVerificationUploadResponseSchema,
  SESSION_TOKEN_HEADER,
} from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { AuthenticationRequiredError } from '../src/auth/auth-errors.js';
import {
  DURABLE_THROTTLE_COUNTER,
  REDIS_THROTTLE_COUNTER,
} from '../src/auth/login-throttle.service.js';
import { SUPABASE_AUTH_CLIENT } from '../src/auth/login.service.js';
import { SELLER_STORE } from '../src/catalog/sellers.service.js';
import { SELLER_IDENTITY_STORE } from '../src/sellers/seller-identity.service.js';
import {
  SELLER_MEDIA_STORAGE,
  SellerMediaStorageUnavailableError,
} from '../src/sellers/seller-media.storage.js';
import { SELLER_THROTTLE_BUCKETS } from '../src/sellers/seller-throttle.service.js';
import {
  SELLER_VERIFICATION_STORE,
  type SellerVerificationAttachInput,
  type SellerVerificationTargetInput,
} from '../src/sellers/seller-verification.service.js';
import { CURRENT_USER_STORE } from '../src/users/current-user.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * The seller's own verification submission at the API boundary (Phase 6-I).
 *
 * Six properties carry this suite.
 *
 * **A seller reaches no decision.** No route accepts a status, a reviewer, a review time or a decision
 * reason; every attempt to send one is refused by the strict contract, and the store calls are asserted to
 * carry only what the caller legitimately states. Nothing in any response says how a decision went beyond the
 * applicant's own status.
 *
 * **The browser never names a destination.** Every attempt to send an `objectPath`, a `bucket`, a `slug` or a
 * seller to the authorization route is refused, and the store call carries the caller's own id plus the three
 * values that describe the file. The path in the response is the database's.
 *
 * **A path never comes back in a readback.** The store's `documents` payload is deliberately fed extra fields
 * — an object path, a review note, a reviewer — and the response is asserted to contain none of them. This is
 * the projection's whole purpose, so it is tested against a store that is trying to leak.
 *
 * **The provider is a port.** The storage client is a double throughout, and it is 6-E's port unchanged:
 * what is proven here is this increment's logic, independently of Supabase Storage's HTTP surface, which is
 * exercised nowhere before Final QA.
 *
 * **The approved limits count the approved operations.** Start and submit count against
 * `seller_verification_submission`; the three document operations count against `seller_media_upload`;
 * reading counts against neither. Asserted by bucket name, not by number of calls.
 *
 * **Nothing leaks.** No signed URL in a refusal, no token, no internal credential, no identifier, no path —
 * asserted against the raw response text.
 */

const ACCESS_TOKEN = 'caller-access-token-value-not-a-real-token';
const CALLER = '11111111-1111-4111-8111-111111111111';
const DOCUMENT_ID = '22222222-2222-4222-8222-222222222222';
const OBJECT_PATH =
  'verification-documents/good-shop/national_id/33333333-3333-4333-8333-333333333333.pdf';
const SIGNED_URL =
  'https://provider.invalid/storage/v1/object/upload/sign/verification-documents/x?token=signed-token';
const SECRET_PATH = 'verification-documents/good-shop/passport/leaked-path-value.pdf';
const SECRET_NOTE = 'reviewer said the scan was illegible';

const IDENTITY = {
  slug: 'good-shop',
  displayName: 'Good Shop',
  status: 'pending',
  verificationStatus: 'unverified',
  city: 'Cairo',
  countryCode: 'EG',
};

type StateOutcome =
  | 'created'
  | 'submitted'
  | 'exists'
  | 'already_verified'
  | 'not_found'
  | 'not_editable'
  | 'invalid'
  | 'something_else';

type DocumentOutcome =
  | 'authorized'
  | 'attached'
  | 'removed'
  | 'not_found'
  | 'not_editable'
  | 'invalid'
  | 'path_taken'
  | 'something_else';

interface Recorded {
  readonly reads: string[];
  readonly starts: string[];
  readonly submits: string[];
  readonly targets: SellerVerificationTargetInput[];
  readonly attaches: SellerVerificationAttachInput[];
  readonly removes: { userId: string; documentId: string }[];
  readonly signs: { bucket: string; objectPath: string; contentType: string }[];
  readonly exists: { bucket: string; objectPath: string }[];
  readonly buckets: string[];
  readonly durableBuckets: string[];
}

interface Doubles {
  readonly readOutcome?: 'found' | 'none' | 'not_found' | 'something_else';
  readonly startOutcome?: StateOutcome;
  readonly submitOutcome?: StateOutcome;
  readonly targetOutcome?: DocumentOutcome;
  readonly attachOutcome?: DocumentOutcome;
  readonly removeOutcome?: DocumentOutcome;
  readonly leakyDocuments?: boolean;
  readonly noDocuments?: boolean;
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
    reads: [],
    starts: [],
    submits: [],
    targets: [],
    attaches: [],
    removes: [],
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

  // A store that hands back more than the contract allows, so the projection is tested against something
  // actively trying to leak rather than against a well-behaved fixture.
  const documents = doubles.noDocuments === true
    ? []
    : [
        {
          id: DOCUMENT_ID,
          documentType: 'national_id',
          originalFilename: 'id.pdf',
          contentType: 'application/pdf',
          byteSize: '4096',
          status: 'pending',
          uploadedAt: '2026-05-01T00:00:00.000Z',
          ...(doubles.leakyDocuments === true
            ? {
                objectPath: SECRET_PATH,
                reviewNote: SECRET_NOTE,
                reviewedBy: '99999999-9999-4999-8999-999999999999',
                reviewedAt: '2026-05-02T00:00:00.000Z',
                verificationId: '44444444-4444-4444-8444-444444444444',
              }
            : {}),
        },
      ];

  const store = {
    sellerVerification: async (userId: string) => {
      recorded.reads.push(userId);
      if (doubles.storeThrows === true) throw new Error('database unavailable');
      const outcome = doubles.readOutcome ?? 'found';
      if (outcome !== 'found') {
        return {
          outcome,
          status: null,
          submittedAt: null,
          createdAt: null,
          emailVerified: null,
          phoneVerified: null,
          documentCount: null,
          documents: null,
        };
      }
      return {
        outcome: 'found',
        status: 'submitted',
        submittedAt: '2026-05-01T00:00:00.000Z',
        createdAt: '2026-04-01T00:00:00.000Z',
        emailVerified: true,
        phoneVerified: false,
        documentCount: documents.length,
        documents,
      };
    },
    sellerVerificationStart: async (userId: string) => {
      recorded.starts.push(userId);
      if (doubles.storeThrows === true) throw new Error('database unavailable');
      const outcome = doubles.startOutcome ?? 'created';
      return { outcome, status: outcome === 'created' ? 'draft' : null };
    },
    sellerVerificationDocumentTarget: async (input: SellerVerificationTargetInput) => {
      recorded.targets.push(input);
      if (doubles.storeThrows === true) throw new Error('database unavailable');
      const outcome = doubles.targetOutcome ?? 'authorized';
      if (outcome !== 'authorized' || doubles.incompleteTarget === true) {
        return { outcome, bucketId: null, objectPath: null, maxByteSize: null };
      }
      return {
        outcome: 'authorized',
        bucketId: 'verification-documents',
        objectPath: `verification-documents/good-shop/${input.documentType}/33333333-3333-4333-8333-333333333333.pdf`,
        maxByteSize: 20_971_520,
      };
    },
    sellerVerificationDocumentAttach: async (input: SellerVerificationAttachInput) => {
      recorded.attaches.push(input);
      if (doubles.storeThrows === true) throw new Error('database unavailable');
      const outcome = doubles.attachOutcome ?? 'attached';
      return { outcome, documentCount: outcome === 'attached' ? 2 : null };
    },
    sellerVerificationDocumentRemove: async (userId: string, documentId: string) => {
      recorded.removes.push({ userId, documentId });
      if (doubles.storeThrows === true) throw new Error('database unavailable');
      const outcome = doubles.removeOutcome ?? 'removed';
      return { outcome, documentCount: outcome === 'removed' ? 1 : null };
    },
    sellerVerificationSubmit: async (userId: string) => {
      recorded.submits.push(userId);
      if (doubles.storeThrows === true) throw new Error('database unavailable');
      const outcome = doubles.submitOutcome ?? 'submitted';
      return { outcome, status: outcome === 'submitted' ? 'submitted' : null };
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
        throw new Error('a verification request must never sign anyone in');
      },
      revokeAllSessions: async () => {
        throw new Error('a verification request must never revoke a session');
      },
    })
    .overrideProvider(CURRENT_USER_STORE)
    .useValue({ userIdentity: async (userId: string) => ({ id: userId, displayName: 'Nadia' }) })
    .overrideProvider(REDIS_THROTTLE_COUNTER)
    .useValue(redis)
    .overrideProvider(DURABLE_THROTTLE_COUNTER)
    .useValue(durable)
    .overrideProvider(SELLER_VERIFICATION_STORE)
    .useValue(store)
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

async function call(
  method: 'GET' | 'POST' | 'DELETE',
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
  return {
    status: response.statusCode,
    body: response.body.length > 0 ? (JSON.parse(response.body) as Record<string, unknown>) : {},
    raw: response.body,
  };
}

const read = () => call('GET', '/v1/sellers/me/verification');
const begin = () => call('POST', '/v1/sellers/me/verification', {});
const submit = () => call('POST', '/v1/sellers/me/verification/submission', {});
const authorize = (
  body: unknown = { documentType: 'national_id', contentType: 'application/pdf', byteSize: 4096 },
) => call('POST', '/v1/sellers/me/verification/documents/uploads', body);
const record = (
  body: unknown = {
    documentType: 'national_id',
    objectPath: OBJECT_PATH,
    originalFilename: 'id.pdf',
    contentType: 'application/pdf',
    byteSize: 4096,
  },
) => call('POST', '/v1/sellers/me/verification/documents', body);
const remove = (id: string = DOCUMENT_ID) =>
  call('DELETE', `/v1/sellers/me/verification/documents/${id}`);

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('authentication and the internal credential', () => {
  it('serves the caller their own attempt', async () => {
    const recorded = await start();
    const result = await read();
    expect(result.status).toBe(200);
    expect(SellerVerificationResponseSchema.safeParse(result.body).success).toBe(true);
    // The caller's own id, from their own token, and nothing from the request.
    expect(recorded.reads).toEqual([CALLER]);
  });

  it('refuses every route without a session', async () => {
    await start();
    for (const result of [
      await call('GET', '/v1/sellers/me/verification', undefined, { [SESSION_TOKEN_HEADER]: '' }),
      await call('POST', '/v1/sellers/me/verification', {}, { [SESSION_TOKEN_HEADER]: '' }),
      await call(
        'POST',
        '/v1/sellers/me/verification/documents/uploads',
        { documentType: 'national_id', contentType: 'application/pdf', byteSize: 10 },
        { [SESSION_TOKEN_HEADER]: '' },
      ),
      await call('DELETE', `/v1/sellers/me/verification/documents/${DOCUMENT_ID}`, undefined, {
        [SESSION_TOKEN_HEADER]: '',
      }),
      await call('POST', '/v1/sellers/me/verification/submission', {}, { [SESSION_TOKEN_HEADER]: '' }),
    ]) {
      expect(result.status).toBe(401);
    }
  });

  it('refuses every route without the internal credential', async () => {
    await start();
    for (const result of [
      await call('GET', '/v1/sellers/me/verification', undefined, {
        [INTERNAL_CREDENTIAL_HEADER]: 'wrong',
      }),
      await call('POST', '/v1/sellers/me/verification', {}, { [INTERNAL_CREDENTIAL_HEADER]: 'wrong' }),
      await call('POST', '/v1/sellers/me/verification/submission', {}, {
        [INTERNAL_CREDENTIAL_HEADER]: 'wrong',
      }),
    ]) {
      expect(result.status).toBe(403);
    }
  });

  it('never reads a seller from the request', async () => {
    const recorded = await start();
    await call('GET', '/v1/sellers/me/verification?sellerUserId=99999999-9999-4999-8999-999999999999');
    expect(recorded.reads).toEqual([CALLER]);
  });
});

describe('the readback', () => {
  it('returns null for a storefront that has never applied', async () => {
    await start({ readOutcome: 'none' });
    const result = await read();
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ verification: null });
  });

  it('is a 404 for an account with no storefront', async () => {
    await start({ readOutcome: 'not_found' });
    const result = await read();
    expect(result.status).toBe(404);
    expect((result.body as { code?: string }).code).toBe('NOT_FOUND');
  });

  it('never returns an object path, a review note, a reviewer or a verification id', async () => {
    await start({ leakyDocuments: true });
    const result = await read();
    expect(result.status).toBe(200);
    // The store handed the service all four. None of them is in the response, because the projection builds
    // each document field by field rather than passing the row through.
    expect(result.raw).not.toContain(SECRET_PATH);
    expect(result.raw).not.toContain(SECRET_NOTE);
    expect(result.raw).not.toContain('objectPath');
    expect(result.raw).not.toContain('reviewNote');
    expect(result.raw).not.toContain('reviewedBy');
    expect(result.raw).not.toContain('reviewedAt');
    expect(result.raw).not.toContain('verificationId');
    // And the strict contract agrees the shape is exactly the seven documented fields.
    expect(SellerVerificationResponseSchema.safeParse(result.body).success).toBe(true);
  });

  it('carries the contact facts as booleans and the byte size as a string', async () => {
    await start();
    const result = await read();
    const verification = (result.body as { verification: Record<string, unknown> }).verification;
    expect(verification['emailVerified']).toBe(true);
    expect(verification['phoneVerified']).toBe(false);
    expect(result.raw).not.toContain('emailVerifiedAt');
    const documents = verification['documents'] as { byteSize: unknown }[];
    expect(documents[0]?.byteSize).toBe('4096');
  });

  it('counts against no rate limit at all', async () => {
    const recorded = await start();
    await read();
    // Reading your own application is not a mutation, and must not spend the daily submission allowance.
    expect(recorded.buckets).toEqual([]);
    expect(recorded.durableBuckets).toEqual([]);
  });

  it('is a 503 when the store cannot be asked', async () => {
    await start({ storeThrows: true });
    const result = await read();
    expect(result.status).toBe(503);
  });
});

describe('starting an attempt', () => {
  it('creates a draft and answers 201', async () => {
    const recorded = await start();
    const result = await begin();
    expect(result.status).toBe(201);
    expect(result.body).toEqual({ status: 'draft' });
    expect(SellerVerificationStateResponseSchema.safeParse(result.body).success).toBe(true);
    expect(recorded.starts).toEqual([CALLER]);
  });

  it('answers 409 with its own code when an attempt is already open', async () => {
    await start({ startOutcome: 'exists' });
    const result = await begin();
    expect(result.status).toBe(409);
    expect((result.body as { code?: string }).code).toBe('SELLER_VERIFICATION_EXISTS');
  });

  it('answers 409 for a storefront that is already verified, and says only that', async () => {
    await start({ startOutcome: 'already_verified' });
    const result = await begin();
    expect(result.status).toBe(409);
    expect((result.body as { code?: string }).code).toBe('SELLER_VERIFICATION_ALREADY_VERIFIED');
    // Owner decision 2: no form, no reapplication, and no hint that one might be possible.
    expect(result.raw.toLowerCase()).not.toContain('again');
  });

  it('answers 409 for a suspended or closed storefront, naming no reason', async () => {
    await start({ startOutcome: 'not_editable' });
    const result = await begin();
    expect(result.status).toBe(409);
    expect((result.body as { code?: string }).code).toBe('SELLER_VERIFICATION_NOT_EDITABLE');
    expect(result.raw.toLowerCase()).not.toContain('suspend');
    expect(result.raw.toLowerCase()).not.toContain('reason');
  });

  it('answers 404 for an account with no storefront', async () => {
    await start({ startOutcome: 'not_found' });
    expect((await begin()).status).toBe(404);
  });

  it('is a 503 for an outcome this service does not understand', async () => {
    await start({ startOutcome: 'something_else' });
    expect((await begin()).status).toBe(503);
  });

  it('counts against the approved verification submission bucket', async () => {
    const recorded = await start();
    await begin();
    expect(recorded.buckets).toEqual([SELLER_THROTTLE_BUCKETS.verificationSubmission.name]);
  });

  it('accepts no status, reviewer or decision in a body', async () => {
    const recorded = await start();
    // The route takes no body; a body naming a status must not reach the store as anything at all.
    await call('POST', '/v1/sellers/me/verification', {
      status: 'approved',
      reviewedBy: CALLER,
      decisionReason: 'because I said so',
    });
    expect(recorded.starts).toEqual([CALLER]);
  });
});

describe('authorizing a document upload', () => {
  it('returns the database’s path and the bucket’s own ceiling', async () => {
    const recorded = await start();
    const result = await authorize();
    expect(result.status).toBe(201);
    expect(SellerVerificationUploadResponseSchema.safeParse(result.body).success).toBe(true);
    const upload = (result.body as { upload: Record<string, unknown> }).upload;
    expect(upload['objectPath']).toBe(OBJECT_PATH);
    expect(upload['maxByteSize']).toBe(20_971_520);
    // The store was asked with the caller's own id and the three values describing the file — no path.
    expect(recorded.targets).toEqual([
      { userId: CALLER, documentType: 'national_id', contentType: 'application/pdf', byteSize: 4096 },
    ]);
    // And the provider was asked to sign exactly the path the database issued.
    expect(recorded.signs).toEqual([
      { bucket: 'verification-documents', objectPath: OBJECT_PATH, contentType: 'application/pdf' },
    ]);
  });

  it('refuses a request that names a destination', async () => {
    const recorded = await start();
    for (const body of [
      { documentType: 'national_id', contentType: 'application/pdf', byteSize: 10, objectPath: OBJECT_PATH },
      { documentType: 'national_id', contentType: 'application/pdf', byteSize: 10, bucket: 'x' },
      { documentType: 'national_id', contentType: 'application/pdf', byteSize: 10, slug: 'other-shop' },
      { documentType: 'national_id', contentType: 'application/pdf', byteSize: 10, sellerUserId: CALLER },
      { documentType: 'national_id', contentType: 'application/pdf', byteSize: 10, fileName: '../x' },
    ]) {
      expect((await authorize(body)).status, JSON.stringify(body)).toBe(400);
    }
    // Not one of them reached the database or the provider.
    expect(recorded.targets).toEqual([]);
    expect(recorded.signs).toEqual([]);
  });

  it('refuses a type, a content type or a size the bucket does not allow', async () => {
    const recorded = await start();
    for (const body of [
      { documentType: 'drivers_licence', contentType: 'application/pdf', byteSize: 10 },
      { documentType: 'national_id', contentType: 'image/webp', byteSize: 10 },
      { documentType: 'national_id', contentType: 'image/svg+xml', byteSize: 10 },
      { documentType: 'national_id', contentType: 'application/pdf', byteSize: 20_971_521 },
      { documentType: 'national_id', contentType: 'application/pdf', byteSize: 0 },
      { documentType: 'national_id', contentType: 'application/pdf', byteSize: -1 },
    ]) {
      expect((await authorize(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(recorded.targets).toEqual([]);
  });

  it('accepts exactly the bucket’s limit', async () => {
    await start();
    const result = await authorize({
      documentType: 'passport',
      contentType: 'image/jpeg',
      byteSize: 20_971_520,
    });
    expect(result.status).toBe(201);
  });

  it('answers 404 with no open attempt and 409 for an unusable storefront', async () => {
    await start({ targetOutcome: 'not_found' });
    expect((await authorize()).status).toBe(404);
    await app?.close();
    app = undefined;
    await start({ targetOutcome: 'not_editable' });
    const result = await authorize();
    expect(result.status).toBe(409);
    expect((result.body as { code?: string }).code).toBe('SELLER_PROFILE_NOT_EDITABLE');
  });

  it('is a 503 when signing fails, and the refusal carries no URL', async () => {
    await start({ signThrows: true });
    const result = await authorize();
    expect(result.status).toBe(503);
    expect(result.raw).not.toContain('token');
    expect(result.raw).not.toContain('provider.invalid');
  });

  it('counts against the approved media bucket, not the daily submission one', async () => {
    const recorded = await start();
    await authorize();
    // A document upload is an upload. Counting it against five-per-day would let a handful of photographs
    // exhaust somebody's whole allowance of submissions.
    expect(recorded.buckets).toEqual([SELLER_THROTTLE_BUCKETS.mediaUpload.name]);
  });

  it('refuses when both counters are unavailable', async () => {
    await start({ redisThrows: true, durableThrows: true });
    expect((await authorize()).status).toBe(503);
  });
});

describe('recording a document', () => {
  it('verifies the object is there before it writes', async () => {
    const recorded = await start();
    const result = await record();
    expect(result.status).toBe(201);
    expect(SellerVerificationDocumentCountResponseSchema.safeParse(result.body).success).toBe(true);
    expect(result.body).toEqual({ documentCount: 2 });
    expect(recorded.exists).toEqual([
      { bucket: 'verification-documents', objectPath: OBJECT_PATH },
    ]);
    expect(recorded.attaches).toHaveLength(1);
  });

  it('refuses a path for an object nobody uploaded, and never reaches the store', async () => {
    const recorded = await start({ objectMissing: true });
    const result = await record();
    expect(result.status).toBe(404);
    expect((result.body as { code?: string }).code).toBe('SELLER_MEDIA_OBJECT_MISSING');
    expect(recorded.attaches).toEqual([]);
  });

  it('answers 409 with its own code when that object is already recorded', async () => {
    await start({ attachOutcome: 'path_taken' });
    const result = await record();
    expect(result.status).toBe(409);
    expect((result.body as { code?: string }).code).toBe(
      'SELLER_VERIFICATION_DOCUMENT_PATH_TAKEN',
    );
  });

  it('answers 400 for a path the database refuses, explaining nothing about its shape', async () => {
    await start({ attachOutcome: 'invalid' });
    const result = await record();
    expect(result.status).toBe(400);
    // A refusal that described the expected path would be a map to the namespace.
    expect(result.raw).not.toContain('verification-documents/');
    expect(result.raw.toLowerCase()).not.toContain('uuid');
    expect(result.raw.toLowerCase()).not.toContain('prefix');
  });

  it('accepts no status, reviewer or review note in the body', async () => {
    const recorded = await start();
    const base = {
      documentType: 'national_id',
      objectPath: OBJECT_PATH,
      originalFilename: 'id.pdf',
      contentType: 'application/pdf',
      byteSize: 4096,
    };
    for (const field of ['status', 'reviewNote', 'reviewedBy', 'reviewedAt', 'verificationId']) {
      expect((await record({ ...base, [field]: 'x' })).status, field).toBe(400);
    }
    expect(recorded.attaches).toEqual([]);
  });

  it('counts against the approved media bucket', async () => {
    const recorded = await start();
    await record();
    expect(recorded.buckets).toEqual([SELLER_THROTTLE_BUCKETS.mediaUpload.name]);
  });
});

describe('removing a document', () => {
  it('removes one of the caller’s own and answers with what is left', async () => {
    const recorded = await start();
    const result = await remove();
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ documentCount: 1 });
    // The caller's own id travels with the document id: ownership is resolved in the database, not here.
    expect(recorded.removes).toEqual([{ userId: CALLER, documentId: DOCUMENT_ID }]);
  });

  it('answers 404 for a document that is not removable, whatever the reason', async () => {
    await start({ removeOutcome: 'not_found' });
    const result = await remove();
    expect(result.status).toBe(404);
    expect((result.body as { code?: string }).code).toBe('NOT_FOUND');
    // Another seller's document, one that does not exist, and one of the caller's own on an attempt that has
    // reached the reviewer are all this same answer — asserted by the absence of anything distinguishing.
    expect(result.raw.toLowerCase()).not.toContain('review');
    expect(result.raw.toLowerCase()).not.toContain('belong');
  });

  it('answers 400 for an id that is not a uuid, without asking the database', async () => {
    const recorded = await start();
    expect((await remove('not-a-uuid')).status).toBe(400);
    expect(recorded.removes).toEqual([]);
  });

  it('counts against the approved media bucket', async () => {
    const recorded = await start();
    await remove();
    expect(recorded.buckets).toEqual([SELLER_THROTTLE_BUCKETS.mediaUpload.name]);
  });
});

describe('submitting', () => {
  it('submits and answers 200', async () => {
    const recorded = await start();
    const result = await submit();
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: 'submitted' });
    expect(recorded.submits).toEqual([CALLER]);
  });

  it('submits with no document at all', async () => {
    // Owner decision 1: there is no minimum, so nothing in this API counts documents before submitting —
    // asserted by the store being asked to submit without the readback being consulted first.
    const recorded = await start({ noDocuments: true });
    expect((await submit()).status).toBe(200);
    expect(recorded.submits).toEqual([CALLER]);
    expect(recorded.reads).toEqual([]);
  });

  it('answers 409 for an attempt that is no longer the seller’s to change', async () => {
    await start({ submitOutcome: 'not_editable' });
    const result = await submit();
    expect(result.status).toBe(409);
    expect((result.body as { code?: string }).code).toBe('SELLER_VERIFICATION_NOT_EDITABLE');
    expect(result.raw.toLowerCase()).not.toContain('reviewer');
  });

  it('answers 404 when there is nothing to submit', async () => {
    await start({ submitOutcome: 'not_found' });
    expect((await submit()).status).toBe(404);
  });

  it('counts against the approved verification submission bucket', async () => {
    const recorded = await start();
    await submit();
    expect(recorded.buckets).toEqual([SELLER_THROTTLE_BUCKETS.verificationSubmission.name]);
  });

  it('refuses the sixth submission of a day', async () => {
    const recorded = await start({ counting: true });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await submit()).status, `attempt ${attempt + 1}`).toBe(200);
    }
    const sixth = await submit();
    expect(sixth.status).toBe(429);
    expect(recorded.submits).toHaveLength(5);
  });

  it('uses the approved number and a daily window', async () => {
    expect(SELLER_THROTTLE_BUCKETS.verificationSubmission).toEqual({
      name: 'seller_verification_submission',
      limit: 5,
      windowSeconds: 86_400,
    });
  });

  it('falls back to the durable counter and still refuses when neither answers', async () => {
    const recorded = await start({ redisThrows: true });
    expect((await submit()).status).toBe(200);
    expect(recorded.durableBuckets).toEqual([
      SELLER_THROTTLE_BUCKETS.verificationSubmission.name,
    ]);
    await app?.close();
    app = undefined;
    await start({ redisThrows: true, durableThrows: true });
    expect((await submit()).status).toBe(503);
  });
});

describe('what never appears in a response', () => {
  it('leaks no token, credential or identifier on any route', async () => {
    await start({ leakyDocuments: true });
    for (const result of [
      await read(),
      await begin(),
      await authorize(),
      await record(),
      await remove(),
      await submit(),
    ]) {
      expect(result.raw).not.toContain(ACCESS_TOKEN);
      expect(result.raw).not.toContain(TEST_INTERNAL_CREDENTIAL);
      expect(result.raw).not.toContain(CALLER);
      expect(result.raw).not.toContain(SECRET_PATH);
      expect(result.raw).not.toContain(SECRET_NOTE);
    }
  });

  it('exposes no route that decides a verification', async () => {
    await start();
    for (const [method, url] of [
      ['POST', '/v1/sellers/me/verification/approval'],
      ['POST', '/v1/sellers/me/verification/decision'],
      ['POST', '/v1/sellers/me/verification/rejection'],
      ['PATCH', '/v1/sellers/me/verification'],
      ['PUT', '/v1/sellers/me/verification'],
      ['DELETE', '/v1/sellers/me/verification'],
      ['GET', '/v1/sellers/me/verification/documents'],
      ['POST', '/v1/admin/verifications'],
    ] as const) {
      const response = await app!.inject({
        method,
        url,
        headers: {
          [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL,
          [SESSION_TOKEN_HEADER]: ACCESS_TOKEN,
          'content-type': 'application/json',
        },
        payload: '{}',
      });
      expect([404, 405], `${method} ${url}`).toContain(response.statusCode);
    }
  });
});
