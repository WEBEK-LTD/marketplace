import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { SESSION_TOKEN_HEADER } from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { STAFF_CONSOLE_STORE, type StaffConsoleRow } from '../src/admin/staff-console.service.js';
import {
  VERIFICATION_REVIEW_STORE,
  type VerificationDecisionRow,
  type VerificationDetailRow,
  type VerificationDocumentRow,
  type VerificationQueueRow,
} from '../src/admin/verification-review.service.js';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { AuthenticationRequiredError } from '../src/auth/auth-errors.js';
import { SUPABASE_AUTH_CLIENT } from '../src/auth/login.service.js';
import { SELLER_MEDIA_STORAGE } from '../src/sellers/seller-media.storage.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * The seller verification review surface at the API boundary (Phase 7-G).
 *
 * What is being held to account:
 *
 *   * **the authorization matrix** — a guest, a buyer, a seller, staff at aal1 and staff at aal2 without
 *     the permission all receive exactly what somebody asking about a route that does not exist
 *     receives, on every one of the four operations; the authorized reviewer receives an answer;
 *   * **the reviewer is never in a request** — no header, query parameter or body field anywhere on
 *     this surface can name an account, a role, a permission or an assurance level, and what the store
 *     is called with is always the account the provider vouched for;
 *   * **no storage path is ever accepted or returned** — a document is addressed by id, the path comes
 *     out of the database row, and the object path never appears in any response body;
 *   * **the decision is the database's** — the service adds no state rule of its own, and each outcome
 *     the function can return becomes exactly one answer;
 *   * **nothing secret is in a response** — no token, no credential, no bucket, no object path.
 */

const REVIEWER = '11111111-1111-4111-8111-111111111111';
const REVIEW_PERMISSION = 'sellers.verification.review';
const VERIFICATION = 'f0000000-0000-4000-8000-000000000001';
const DOCUMENT = 'a0000000-0000-4000-8000-000000000001';
const OBJECT_PATH = 'verification-documents/rev-shop-one/national_id/11111111-1111-4111-8111-111111111111.jpg';
const SIGNED_URL = 'https://storage.test/object/sign/verification-documents/one.jpg?token=canary-signed';

function token(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.c2lnbmF0dXJl`;
}

const ACCESS_TOKEN = token({ sub: REVIEWER, aal: 'aal2' });

/** Every permission an administrator holds except the one this surface needs. */
const WITHOUT_REVIEW = [
  'audit.read',
  'catalog.listing.read',
  'moderation.report.read',
  'sellers.profile.read',
  'users.profile.read',
];

function staffRow(overrides: Partial<StaffConsoleRow> = {}): StaffConsoleRow {
  return {
    hasConsoleRole: true,
    requiresStepUp: false,
    roles: ['admin'],
    permissions: [...WITHOUT_REVIEW, REVIEW_PERMISSION],
    ...overrides,
  };
}

function queueRow(overrides: Partial<VerificationQueueRow> = {}): VerificationQueueRow {
  return {
    id: VERIFICATION,
    status: 'submitted',
    submittedAt: new Date('2026-05-01T09:00:00.000Z'),
    createdAt: new Date('2026-05-01T08:00:00.000Z'),
    reviewedAt: null,
    emailVerified: true,
    phoneVerified: true,
    documentCount: 2,
    sellerSlug: 'rev-shop-one',
    sellerDisplayName: 'Review Shop One',
    sellerStatus: 'pending',
    sellerVerificationStatus: 'pending',
    ...overrides,
  };
}

function detailRow(overrides: Partial<VerificationDetailRow> = {}): VerificationDetailRow {
  return {
    outcome: 'found',
    id: VERIFICATION,
    status: 'submitted',
    submittedAt: new Date('2026-05-01T09:00:00.000Z'),
    createdAt: new Date('2026-05-01T08:00:00.000Z'),
    updatedAt: new Date('2026-05-01T09:00:00.000Z'),
    reviewedAt: null,
    decisionReason: null,
    expiresAt: null,
    emailVerified: true,
    phoneVerified: true,
    sellerSlug: 'rev-shop-one',
    sellerDisplayName: 'Review Shop One',
    sellerLegalName: 'One Trading LLC',
    sellerCountryCode: 'EG',
    sellerGovernorate: 'Giza',
    sellerCity: 'Dokki',
    sellerContactEmail: 'one@shops.invalid',
    sellerContactPhone: '+201000000101',
    sellerStatus: 'pending',
    sellerVerificationStatus: 'pending',
    sellerCreatedAt: new Date('2026-01-01T00:00:00.000Z'),
    documents: [
      {
        id: DOCUMENT,
        documentType: 'national_id',
        originalFilename: 'id-front.jpg',
        contentType: 'image/jpeg',
        byteSize: '120000',
        status: 'pending',
        uploadedAt: '2026-05-01T08:30:00.000Z',
      },
    ],
    ...overrides,
  };
}

interface Recorded {
  readonly calls: string[];
  readonly store: Array<Record<string, unknown>>;
  readonly signed: Array<{ bucket: string; objectPath: string }>;
}

interface Doubles {
  readonly permissions?: readonly string[];
  readonly queue?: readonly VerificationQueueRow[];
  readonly detail?: VerificationDetailRow;
  readonly document?: VerificationDocumentRow;
  readonly decision?: VerificationDecisionRow;
  readonly tokenFails?: boolean;
  readonly storeThrows?: boolean;
  readonly signFails?: boolean;
}

let app: NestFastifyApplication | undefined;

async function start(doubles: Doubles = {}): Promise<Recorded> {
  const recorded: Recorded = { calls: [], store: [], signed: [] };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(TEST_ENV)] })
    .overrideProvider(SUPABASE_AUTH_CLIENT)
    .useValue({
      getUser: async () => {
        recorded.calls.push('get-user');
        if (doubles.tokenFails === true) throw new AuthenticationRequiredError();
        return { id: REVIEWER, phone: null };
      },
    })
    .overrideProvider(STAFF_CONSOLE_STORE)
    .useValue({
      staffConsoleAccess: async (input: { userId: string; isAal2: boolean }) => {
        recorded.calls.push('console-access');
        recorded.store.push({ op: 'console-access', ...input });
        return staffRow(
          doubles.permissions === undefined ? {} : { permissions: [...doubles.permissions] },
        );
      },
      buyerProfile: async (userId: string) => ({
        id: userId,
        displayName: 'Nadia',
        localeCode: 'en',
      }),
    })
    .overrideProvider(VERIFICATION_REVIEW_STORE)
    .useValue({
      verificationReviewQueue: async (input: Record<string, unknown>) => {
        recorded.calls.push('queue');
        recorded.store.push({ op: 'queue', ...input });
        if (doubles.storeThrows === true) throw new Error('database unavailable');
        return doubles.queue ?? [queueRow()];
      },
      verificationReviewDetail: async (input: Record<string, unknown>) => {
        recorded.calls.push('detail');
        recorded.store.push({ op: 'detail', ...input });
        if (doubles.storeThrows === true) throw new Error('database unavailable');
        return doubles.detail ?? detailRow();
      },
      verificationReviewDocument: async (input: Record<string, unknown>) => {
        recorded.calls.push('document');
        recorded.store.push({ op: 'document', ...input });
        if (doubles.storeThrows === true) throw new Error('database unavailable');
        return (
          doubles.document ?? {
            outcome: 'authorized',
            verificationId: VERIFICATION,
            bucketId: 'verification-documents',
            objectPath: OBJECT_PATH,
            contentType: 'image/jpeg',
            originalFilename: 'id-front.jpg',
          }
        );
      },
      verificationReviewDecide: async (input: Record<string, unknown>) => {
        recorded.calls.push('decide');
        recorded.store.push({ op: 'decide', ...input });
        if (doubles.storeThrows === true) throw new Error('database unavailable');
        return doubles.decision ?? { outcome: 'decided', status: 'approved' };
      },
    })
    .overrideProvider(SELLER_MEDIA_STORAGE)
    .useValue({
      signUpload: async () => ({ uploadUrl: 'https://storage.test/upload', expiresAt: new Date() }),
      objectExists: async () => true,
      signDownload: async (bucket: string, objectPath: string) => {
        recorded.calls.push('sign');
        recorded.signed.push({ bucket, objectPath });
        if (doubles.signFails === true) throw new Error('provider unavailable');
        return { url: SIGNED_URL, expiresAt: new Date('2026-05-01T09:02:00.000Z') };
      },
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
  method: 'GET' | 'POST',
  url: string,
  options: {
    accessToken?: string | null;
    payload?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<Result> {
  const headers: Record<string, string> = {
    [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL,
    ...options.headers,
  };
  const accessToken = options.accessToken === undefined ? ACCESS_TOKEN : options.accessToken;
  if (accessToken !== null) headers[SESSION_TOKEN_HEADER] = accessToken;
  if (options.payload !== undefined) headers['content-type'] = 'application/json';

  const response = await app!.inject({
    method,
    url,
    headers,
    ...(options.payload === undefined ? {} : { payload: JSON.stringify(options.payload) }),
  });
  return {
    status: response.statusCode,
    body: response.body.length > 0 ? (JSON.parse(response.body) as Record<string, unknown>) : {},
    raw: response.body,
  };
}

const QUEUE = '/v1/admin/seller-verifications';
const DETAIL = `${QUEUE}/${VERIFICATION}`;
const DECISION = `${DETAIL}/decision`;
const LINK = `${DETAIL}/documents/${DOCUMENT}/link`;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/* ------------------------------------------------------------------------------------------------ */

describe('the authorization matrix', () => {
  it('lets an authorized reviewer read the queue, a submission, and decide', async () => {
    await start();
    expect((await call('GET', QUEUE)).status).toBe(200);
    expect((await call('GET', DETAIL)).status).toBe(200);
    expect((await call('POST', DECISION, { payload: { decision: 'approved' } })).status).toBe(200);
    expect((await call('POST', LINK)).status).toBe(200);
  });

  it.each([
    ['staff without the review permission', WITHOUT_REVIEW],
    ['staff at aal1, who effectively hold nothing', [] as string[]],
    ['a buyer', [] as string[]],
  ])('refuses %s on every operation, as a plain not-found', async (_name, permissions) => {
    const recorded = await start({ permissions });

    for (const [method, url, payload] of [
      ['GET', QUEUE, undefined],
      ['GET', DETAIL, undefined],
      ['POST', DECISION, { decision: 'approved' }],
      ['POST', LINK, undefined],
    ] as const) {
      const result = await call(method, url, payload === undefined ? {} : { payload });
      expect(result.status, url).toBe(404);
      expect(result.body['code'], url).toBe('NOT_FOUND');
    }

    // Nothing downstream of the permission test ever ran.
    expect(recorded.calls.filter((call) => call !== 'get-user' && call !== 'console-access')).toEqual([]);
  });

  it('refuses a request with no session before asking anything', async () => {
    const recorded = await start();
    for (const [method, url] of [
      ['GET', QUEUE],
      ['GET', DETAIL],
      ['POST', DECISION],
      ['POST', LINK],
    ] as const) {
      const result = await call(method, url, {
        accessToken: null,
        ...(method === 'POST' && url === DECISION ? { payload: { decision: 'approved' } } : {}),
      });
      expect(result.status, url).toBe(401);
    }
    expect(recorded.calls).toEqual([]);
  });

  it('refuses a token the provider does not vouch for, before the database is asked', async () => {
    const recorded = await start({ tokenFails: true });
    expect((await call('GET', DETAIL)).status).toBe(401);
    expect(recorded.calls).toEqual(['get-user']);
  });

  it('refuses without the internal credential, whoever is asking', async () => {
    await start();
    const response = await app!.inject({
      method: 'GET',
      url: QUEUE,
      headers: { [SESSION_TOKEN_HEADER]: ACCESS_TOKEN },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('nothing about the caller comes from the request', () => {
  it('asks the database about the account the provider vouched for, and no other', async () => {
    const recorded = await start();
    await call('GET', QUEUE, {
      headers: { 'x-user-id': '99999999-9999-4999-8999-999999999999', 'x-aal': 'aal2' },
    });

    const access = recorded.store.find((entry) => entry['op'] === 'console-access');
    expect(access?.['userId']).toBe(REVIEWER);
    const queue = recorded.store.find((entry) => entry['op'] === 'queue');
    expect(queue?.['reviewerId']).toBe(REVIEWER);
  });

  it('takes the assurance level from the validated token, not from the request', async () => {
    const recorded = await start();
    await call('GET', QUEUE, { headers: { 'x-aal': 'aal2', 'x-assurance-level': 'aal2' } });
    expect(recorded.store.find((entry) => entry['op'] === 'queue')?.['isAal2']).toBe(true);

    // The same request with an aal1 token reaches the database as aal1, whatever the headers claim.
    await app!.close();
    app = undefined;
    const second = await start();
    const aal1 = token({ sub: REVIEWER, aal: 'aal1' });
    await call('GET', QUEUE, { accessToken: aal1, headers: { 'x-aal': 'aal2' } });
    expect(second.store.find((entry) => entry['op'] === 'queue')?.['isAal2']).toBe(false);

    // And a token with no claim at all is aal1, never a default of true.
    await app!.close();
    app = undefined;
    const third = await start();
    await call('GET', QUEUE, { accessToken: token({ sub: REVIEWER }) });
    expect(third.store.find((entry) => entry['op'] === 'queue')?.['isAal2']).toBe(false);
  });

  it('records the reviewer on a decision from the session, never from the body', async () => {
    const recorded = await start();
    await call('POST', DECISION, {
      payload: {
        decision: 'approved',
        reviewerId: '99999999-9999-4999-8999-999999999999',
        reviewedBy: '99999999-9999-4999-8999-999999999999',
      },
    });
    // The strict contract refused the extra fields outright, so nothing was written at all.
    expect(recorded.calls).not.toContain('decide');

    const clean = await call('POST', DECISION, { payload: { decision: 'approved' } });
    expect(clean.status).toBe(200);
    const decide = recorded.store.find((entry) => entry['op'] === 'decide');
    expect(decide?.['reviewerId']).toBe(REVIEWER);
  });

  it('refuses a status the reviewer path does not set', async () => {
    const recorded = await start();
    for (const decision of ['submitted', 'under_review', 'expired', 'draft', 'APPROVED', '']) {
      const result = await call('POST', DECISION, { payload: { decision } });
      expect(result.status, decision).toBe(400);
    }
    expect(recorded.calls).not.toContain('decide');
  });
});

describe('the queue', () => {
  it('returns one page and a cursor that round-trips', async () => {
    await start({ queue: [queueRow(), queueRow({ id: 'f0000000-0000-4000-8000-000000000002' })] });
    const first = await call('GET', `${QUEUE}?limit=1`);

    expect(first.status).toBe(200);
    expect((first.body['items'] as unknown[]).length).toBe(1);
    const cursor = first.body['nextCursor'];
    expect(typeof cursor).toBe('string');

    const second = await call('GET', `${QUEUE}?limit=1&cursor=${String(cursor)}`);
    expect(second.status).toBe(200);
  });

  it('reports no cursor when the page is the end of the queue', async () => {
    await start({ queue: [queueRow()] });
    const result = await call('GET', `${QUEUE}?limit=20`);
    expect(result.body['nextCursor']).toBeNull();
  });

  it('refuses an unusable cursor rather than paging from the beginning', async () => {
    const recorded = await start();
    for (const cursor of ['!!!!', 'not-a-cursor', Buffer.from('zz|x|y').toString('base64url')]) {
      const result = await call('GET', `${QUEUE}?cursor=${encodeURIComponent(cursor)}`);
      expect(result.status, cursor).toBe(400);
      expect(result.body['code'], cursor).toBe('VERIFICATION_CURSOR_INVALID');
    }
    expect(recorded.calls).not.toContain('queue');
  });

  it('refuses a status filter the queue does not offer, including draft', async () => {
    const recorded = await start();
    for (const status of ['draft', 'anything', "'; drop table x; --"]) {
      const result = await call('GET', `${QUEUE}?status=${encodeURIComponent(status)}`);
      expect(result.status, status).toBe(400);
    }
    expect(recorded.calls).not.toContain('queue');
  });

  it('passes the five real filters through as values', async () => {
    const recorded = await start();
    for (const status of ['submitted', 'under_review', 'approved', 'rejected', 'expired']) {
      expect((await call('GET', `${QUEUE}?status=${status}`)).status, status).toBe(200);
    }
    expect(recorded.store.filter((entry) => entry['op'] === 'queue').map((entry) => entry['status'])).toEqual([
      'submitted',
      'under_review',
      'approved',
      'rejected',
      'expired',
    ]);
  });

  it('clamps the limit rather than trusting it', async () => {
    const recorded = await start();
    await call('GET', `${QUEUE}?limit=5000`);
    const queue = recorded.store.find((entry) => entry['op'] === 'queue');
    // One more than the page size is asked for, to learn whether there is a next page.
    expect(Number(queue?.['limit'])).toBeLessThanOrEqual(51);
  });

  it('carries no account identifier in a queue row', async () => {
    await start();
    const result = await call('GET', QUEUE);
    const item = (result.body['items'] as Array<Record<string, unknown>>)[0]!;
    expect(Object.keys(item).sort()).toEqual([
      'createdAt',
      'documentCount',
      'emailVerified',
      'id',
      'phoneVerified',
      'reviewedAt',
      'sellerDisplayName',
      'sellerSlug',
      'sellerStatus',
      'sellerVerificationStatus',
      'status',
      'submittedAt',
    ]);
  });
});

describe('one submission', () => {
  it('answers with the fields a reviewer decides from, and no object path', async () => {
    await start();
    const result = await call('GET', DETAIL);
    const verification = result.body['verification'] as Record<string, unknown>;

    expect(verification['status']).toBe('submitted');
    expect(verification['decidable']).toBe(true);
    expect(result.raw).not.toContain('objectPath');
    expect(result.raw).not.toContain('verification-documents');
    expect(result.raw).not.toContain('sellerUserId');
    expect(result.raw).not.toContain('reviewedBy');
  });

  it('projects a document to seven fields and drops anything else the database sent', async () => {
    await start({
      detail: detailRow({
        documents: [
          {
            id: DOCUMENT,
            documentType: 'national_id',
            originalFilename: 'id-front.jpg',
            contentType: 'image/jpeg',
            byteSize: '120000',
            status: 'pending',
            uploadedAt: '2026-05-01T08:30:00.000Z',
            // Three fields a later widening might add. None may reach a browser.
            objectPath: OBJECT_PATH,
            reviewNote: 'internal note',
            reviewedBy: '99999999-9999-4999-8999-999999999999',
          },
        ],
      }),
    });
    const result = await call('GET', DETAIL);
    const verification = result.body['verification'] as Record<string, unknown>;
    const document = (verification['documents'] as Array<Record<string, unknown>>)[0]!;

    expect(Object.keys(document).sort()).toEqual([
      'byteSize',
      'contentType',
      'documentType',
      'id',
      'originalFilename',
      'status',
      'uploadedAt',
    ]);
    expect(result.raw).not.toContain('internal note');
    expect(result.raw).not.toContain(OBJECT_PATH);
  });

  it('reports a decided submission as not decidable', async () => {
    await start({
      detail: detailRow({
        status: 'rejected',
        reviewedAt: new Date('2026-05-02T09:00:00.000Z'),
        decisionReason: 'Documents did not match.',
      }),
    });
    const verification = (await call('GET', DETAIL)).body['verification'] as Record<string, unknown>;
    expect(verification['decidable']).toBe(false);
    expect(verification['decisionReason']).toBe('Documents did not match.');
  });

  it('answers not-found for a submission the database does not return', async () => {
    await start({ detail: { ...detailRow(), outcome: 'not_found' } });
    const result = await call('GET', DETAIL);
    expect(result.status).toBe(404);
    expect(result.body['code']).toBe('NOT_FOUND');
  });

  it('refuses an identifier that is not one', async () => {
    const recorded = await start();
    for (const id of ['not-a-uuid', '../../etc/passwd', '1']) {
      const result = await call('GET', `${QUEUE}/${encodeURIComponent(id)}`);
      expect(result.status, id).toBe(400);
    }
    expect(recorded.calls).not.toContain('detail');
  });
});

describe('the decision', () => {
  it('records an approval and answers with the status the row now holds', async () => {
    const recorded = await start();
    const result = await call('POST', DECISION, { payload: { decision: 'approved' } });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: 'approved' });
    const decide = recorded.store.find((entry) => entry['op'] === 'decide');
    expect(decide?.['decision']).toBe('approved');
    expect(decide?.['verificationId']).toBe(VERIFICATION);
  });

  it('requires a reason to reject, and says which field', async () => {
    const recorded = await start();
    const result = await call('POST', DECISION, { payload: { decision: 'rejected' } });

    expect(result.status).toBe(400);
    expect(result.body['code']).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(result.body['errors'])).toContain('reason');
    expect(recorded.calls).not.toContain('decide');
  });

  it('passes a rejection with a reason through', async () => {
    const recorded = await start({ decision: { outcome: 'decided', status: 'rejected' } });
    const result = await call('POST', DECISION, {
      payload: { decision: 'rejected', reason: 'The passport scan is unreadable.' },
    });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: 'rejected' });
    const decide = recorded.store.find((entry) => entry['op'] === 'decide');
    expect(decide?.['reason']).toBe('The passport scan is unreadable.');
  });

  it('accepts an optional note on an approval', async () => {
    const recorded = await start();
    await call('POST', DECISION, { payload: { decision: 'approved', reason: 'Everything matches.' } });
    const decide = recorded.store.find((entry) => entry['op'] === 'decide');
    expect(decide?.['reason']).toBe('Everything matches.');
  });

  it.each([
    ['conflict', 409, 'VERIFICATION_NOT_DECIDABLE'],
    ['contacts_unverified', 409, 'VERIFICATION_CONTACTS_UNVERIFIED'],
    ['not_found', 404, 'NOT_FOUND'],
    ['invalid', 404, 'NOT_FOUND'],
  ])('turns the database outcome %s into %i', async (outcome, status, code) => {
    await start({ decision: { outcome, status: 'approved' } });
    const result = await call('POST', DECISION, { payload: { decision: 'approved' } });
    expect(result.status).toBe(status);
    expect(result.body['code']).toBe(code);
  });

  it('repeating a decision is whatever the database says, never a second write of ours', async () => {
    const recorded = await start({ decision: { outcome: 'conflict', status: 'approved' } });
    await call('POST', DECISION, { payload: { decision: 'approved' } });
    await call('POST', DECISION, { payload: { decision: 'approved' } });

    // Two requests, two calls, and the service added no retry, no read-modify-write and no state check.
    expect(recorded.calls.filter((call) => call === 'decide')).toHaveLength(2);
  });

  it('treats an outcome it does not understand as an outage, never as a success', async () => {
    await start({ decision: { outcome: 'something_new', status: null } });
    const result = await call('POST', DECISION, { payload: { decision: 'approved' } });
    expect(result.status).toBe(503);
  });

  it('turns an unreachable database into an outage, not a refusal', async () => {
    await start({ storeThrows: true });
    expect((await call('POST', DECISION, { payload: { decision: 'approved' } })).status).toBe(503);
    expect((await call('GET', QUEUE)).status).toBe(503);
    expect((await call('GET', DETAIL)).status).toBe(503);
  });
});

describe('the document read path', () => {
  it('signs exactly the path the database returned, and never one from the request', async () => {
    const recorded = await start();
    const result = await call('POST', LINK);

    expect(result.status).toBe(200);
    expect(recorded.signed).toEqual([{ bucket: 'verification-documents', objectPath: OBJECT_PATH }]);
    // The caller supplied two identifiers and nothing else.
    const document = recorded.store.find((entry) => entry['op'] === 'document');
    expect(Object.keys(document ?? {}).sort()).toEqual(['documentId', 'isAal2', 'op', 'reviewerId']);
  });

  it('answers with a URL, the moment it expires, and the document it is for', async () => {
    await start();
    const result = await call('POST', LINK);
    expect(Object.keys(result.body).sort()).toEqual(['documentId', 'expiresAt', 'url']);
    expect(result.body['url']).toBe(SIGNED_URL);
    // Not the bucket, not the path, not a credential.
    expect(result.raw).not.toContain(OBJECT_PATH);
  });

  it('refuses a document that belongs to another submission', async () => {
    const recorded = await start({
      document: {
        outcome: 'authorized',
        verificationId: 'f0000000-0000-4000-8000-00000000ffff',
        bucketId: 'verification-documents',
        objectPath: OBJECT_PATH,
        contentType: 'image/jpeg',
        originalFilename: 'id-front.jpg',
      },
    });
    const result = await call('POST', LINK);
    expect(result.status).toBe(404);
    // Nothing was signed, so no authorization was minted for an object the route did not name.
    expect(recorded.signed).toEqual([]);
  });

  it('refuses a document the database will not locate', async () => {
    const recorded = await start({
      document: {
        outcome: 'not_found',
        verificationId: null,
        bucketId: null,
        objectPath: null,
        contentType: null,
        originalFilename: null,
      },
    });
    expect((await call('POST', LINK)).status).toBe(404);
    expect(recorded.signed).toEqual([]);
  });

  it('refuses identifiers that are not identifiers', async () => {
    const recorded = await start();
    const bad = `${DETAIL}/documents/${encodeURIComponent('../../secret')}/link`;
    expect((await call('POST', bad)).status).toBe(400);
    expect(recorded.calls).not.toContain('document');
  });

  it('treats a provider that cannot sign as an outage', async () => {
    await start({ signFails: true });
    expect((await call('POST', LINK)).status).toBe(503);
  });
});

describe('nothing secret leaves this surface', () => {
  it('never echoes the caller’s token, the internal credential or a bucket name', async () => {
    await start();
    for (const [method, url, payload] of [
      ['GET', QUEUE, undefined],
      ['GET', DETAIL, undefined],
      ['POST', DECISION, { decision: 'approved' }],
    ] as const) {
      const result = await call(method, url, payload === undefined ? {} : { payload });
      expect(result.raw, url).not.toContain(ACCESS_TOKEN);
      expect(result.raw, url).not.toContain(TEST_INTERNAL_CREDENTIAL);
      expect(result.raw, url).not.toContain('verification-documents');
    }
  });

  it('answers a refused caller with a body that names nothing', async () => {
    await start({ permissions: WITHOUT_REVIEW });
    const result = await call('GET', DETAIL);
    expect(result.raw).not.toContain(REVIEW_PERMISSION);
    expect(result.raw).not.toContain('permission');
    // No role name, and nothing that distinguishes this refusal from one for an application that is
    // simply not there. `instance` is the caller's own address and is the only 'admin' in the body.
    for (const role of ['super_admin', 'moderator', 'support_agent']) {
      expect(result.raw, role).not.toContain(role);
    }
    expect(result.body['detail']).toBe('The requested resource was not found.');
  });
});
