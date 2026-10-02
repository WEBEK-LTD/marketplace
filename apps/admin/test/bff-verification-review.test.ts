import { describe, expect, it } from 'vitest';
import { SESSION_COOKIES } from '../src/server/bff/session-cookies';
import {
  handleVerificationDecision,
  handleVerificationDocumentLink,
  readVerificationDetail,
  readVerificationQueue,
} from '../src/server/bff/verification-review';

/**
 * The BFF half of the seller verification review surface (Phase 7-G).
 *
 * What matters at this boundary:
 *
 *   * the caller's token comes from `__Host-mp_admin_access` and never from a body, and the browser's
 *     own `Cookie` header is never forwarded upstream;
 *   * **bodies are rebuilt, never forwarded** — a page that added a reviewer, a status, a timestamp or
 *     a storage path has all four dropped before anything leaves this origin;
 *   * **answers are validated against the contract, not passed through** — an object path or an account
 *     identifier the API somehow sent cannot reach a page;
 *   * a session that ended, an application that is not available and a service that could not answer
 *     stay three distinct things, because an outage must never be rendered as a refusal;
 *   * every write refuses a cross-site request before it reads anything else.
 */

const ENV = Object.freeze({
  API_BASE_URL: 'https://api.internal.test',
  INTERNAL_BFF_CREDENTIAL: 'test-current-credential-value-not-a-real-se',
});

const SESSION_TOKEN = 'admin-session-token-canary-not-a-real-token';
const COOKIE = `${SESSION_COOKIES.access.name}=${SESSION_TOKEN}`;

const VERIFICATION = 'f0000000-0000-4000-8000-000000000001';
const DOCUMENT = 'a0000000-0000-4000-8000-000000000001';
const OBJECT_PATH = 'verification-documents/rev-shop-one/national_id/1111.jpg';

const QUEUE_ITEM = {
  id: VERIFICATION,
  status: 'submitted',
  submittedAt: '2026-05-01T09:00:00.000Z',
  createdAt: '2026-05-01T08:00:00.000Z',
  reviewedAt: null,
  emailVerified: true,
  phoneVerified: true,
  documentCount: 1,
  sellerSlug: 'rev-shop-one',
  sellerDisplayName: 'Review Shop One',
  sellerStatus: 'pending',
  sellerVerificationStatus: 'pending',
};

const REVIEW = {
  id: VERIFICATION,
  status: 'submitted',
  submittedAt: '2026-05-01T09:00:00.000Z',
  createdAt: '2026-05-01T08:00:00.000Z',
  updatedAt: '2026-05-01T09:00:00.000Z',
  reviewedAt: null,
  decisionReason: null,
  expiresAt: null,
  emailVerified: true,
  phoneVerified: true,
  decidable: true,
  seller: {
    slug: 'rev-shop-one',
    displayName: 'Review Shop One',
    legalName: 'One Trading LLC',
    countryCode: 'EG',
    governorate: 'Giza',
    city: 'Dokki',
    contactEmail: 'one@shops.invalid',
    contactPhone: '+201000000101',
    status: 'pending',
    verificationStatus: 'pending',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
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
};

interface Seen {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string;
}

function api(status: number, payload: unknown, seen: Seen[] = []): typeof fetch {
  return (async (input: unknown, init: RequestInit) => {
    seen.push({
      url: String(input),
      method: String(init.method ?? 'GET'),
      headers: new Headers(init.headers),
      body: String(init.body ?? ''),
    });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': status < 400 ? 'application/json' : 'application/problem+json' },
    });
  }) as unknown as typeof fetch;
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://admin.test${path}`, {
    method: 'POST',
    headers: { origin: 'https://admin.test', 'content-type': 'application/json', cookie: COOKIE, ...headers },
    body: JSON.stringify(body),
  });
}

const DECISION_PATH = '/api/sellers/verification/decision';
const DOCUMENT_PATH = '/api/sellers/verification/document';

/* ------------------------------------------------------------------------------------------------ */

describe('reading the queue', () => {
  it('presents the caller’s token and the internal credential, and never the browser cookie', async () => {
    const seen: Seen[] = [];
    await readVerificationQueue(
      {},
      { env: ENV, cookieHeader: COOKIE, fetch: api(200, { items: [QUEUE_ITEM], nextCursor: null }, seen) },
    );

    expect(seen[0]!.url).toBe('https://api.internal.test/v1/admin/seller-verifications');
    expect(seen[0]!.method).toBe('GET');
    expect(seen[0]!.headers.get('x-session-token')).toBe(SESSION_TOKEN);
    expect(seen[0]!.headers.get('x-internal-credential')).toBe(ENV.INTERNAL_BFF_CREDENTIAL);
    expect(seen[0]!.headers.get('cookie')).toBeNull();
  });

  it('never reaches the API without a session cookie', async () => {
    const seen: Seen[] = [];
    const result = await readVerificationQueue({}, { env: ENV, cookieHeader: null, fetch: api(200, {}, seen) });
    expect(result.kind).toBe('unauthenticated');
    expect(seen).toEqual([]);
  });

  it('forwards only a status the console offers', async () => {
    for (const [status, expected] of [
      ['submitted', '?status=submitted'],
      ['approved', '?status=approved'],
      ['draft', ''],
      ['nonsense', ''],
      ["'; drop table x; --", ''],
    ] as const) {
      const seen: Seen[] = [];
      await readVerificationQueue(
        { status },
        { env: ENV, cookieHeader: COOKIE, fetch: api(200, { items: [], nextCursor: null }, seen) },
      );
      expect(seen[0]!.url, status).toBe(`https://api.internal.test/v1/admin/seller-verifications${expected}`);
    }
  });

  it('forwards only a cursor that looks like one', async () => {
    const seen: Seen[] = [];
    await readVerificationQueue(
      { cursor: 'not a cursor!' },
      { env: ENV, cookieHeader: COOKIE, fetch: api(200, { items: [], nextCursor: null }, seen) },
    );
    expect(seen[0]!.url).toBe('https://api.internal.test/v1/admin/seller-verifications');
  });

  it.each([
    ['an item with a field the contract does not name', { items: [{ ...QUEUE_ITEM, sellerUserId: 'x' }], nextCursor: null }],
    ['an item with an object path', { items: [{ ...QUEUE_ITEM, objectPath: OBJECT_PATH }], nextCursor: null }],
    ['a status the contract does not name', { items: [{ ...QUEUE_ITEM, status: 'promoted' }], nextCursor: null }],
    ['items that are not an array', { items: 'all', nextCursor: null }],
    ['no items at all', { nextCursor: null }],
  ])('refuses an answer carrying %s', async (_name, payload) => {
    const result = await readVerificationQueue(
      {},
      { env: ENV, cookieHeader: COOKIE, fetch: api(200, payload) },
    );
    // A drifted body is an outage, never a half-rendered queue.
    expect(result.kind).toBe('unavailable');
  });

  it('keeps an ended session, an unavailable queue and an outage apart', async () => {
    const ended = await readVerificationQueue({}, { env: ENV, cookieHeader: COOKIE, fetch: api(401, {}) });
    expect(ended.kind).toBe('unauthenticated');

    const refused = await readVerificationQueue({}, { env: ENV, cookieHeader: COOKIE, fetch: api(404, {}) });
    expect(refused.kind).toBe('notFound');

    for (const status of [400, 403, 500, 503]) {
      const down = await readVerificationQueue({}, { env: ENV, cookieHeader: COOKIE, fetch: api(status, {}) });
      expect(down.kind, String(status)).toBe('unavailable');
    }
  });
});

describe('reading one submission', () => {
  it('addresses the submission by identifier and sends no body', async () => {
    const seen: Seen[] = [];
    const result = await readVerificationDetail(VERIFICATION, {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: api(200, { verification: REVIEW }, seen),
    });

    expect(result.kind).toBe('ok');
    expect(seen[0]!.url).toBe(`https://api.internal.test/v1/admin/seller-verifications/${VERIFICATION}`);
    expect(seen[0]!.body).toBe('');
  });

  it('refuses an identifier that is not one, without a round trip', async () => {
    const seen: Seen[] = [];
    for (const id of ['../../secret', 'nope', '']) {
      const result = await readVerificationDetail(id, { env: ENV, cookieHeader: COOKIE, fetch: api(200, {}, seen) });
      expect(result.kind, id).toBe('notFound');
    }
    expect(seen).toEqual([]);
  });

  it('refuses an answer that smuggles an object path into a document', async () => {
    const result = await readVerificationDetail(VERIFICATION, {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: api(200, {
        verification: {
          ...REVIEW,
          documents: [{ ...REVIEW.documents[0], objectPath: OBJECT_PATH }],
        },
      }),
    });
    expect(result.kind).toBe('unavailable');
  });

  it('refuses an answer that adds an account identifier', async () => {
    const result = await readVerificationDetail(VERIFICATION, {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: api(200, { verification: { ...REVIEW, sellerUserId: VERIFICATION } }),
    });
    expect(result.kind).toBe('unavailable');
  });
});

describe('the decision write', () => {
  it('sends exactly the two contract fields and drops everything else a page added', async () => {
    const seen: Seen[] = [];
    const response = await handleVerificationDecision(
      post(DECISION_PATH, {
        verificationId: VERIFICATION,
        decision: 'rejected',
        reason: '  The passport scan is unreadable.  ',
        reviewerId: '99999999-9999-4999-8999-999999999999',
        status: 'approved',
        reviewedAt: '2026-01-01T00:00:00.000Z',
        objectPath: OBJECT_PATH,
      }),
      { env: ENV, fetch: api(200, { status: 'rejected' }, seen) },
    );

    expect(response.status).toBe(200);
    expect(JSON.parse(seen[0]!.body)).toEqual({
      decision: 'rejected',
      reason: 'The passport scan is unreadable.',
    });
    expect(seen[0]!.url).toBe(
      `https://api.internal.test/v1/admin/seller-verifications/${VERIFICATION}/decision`,
    );
    expect(seen[0]!.headers.get('cookie')).toBeNull();
    expect(seen[0]!.headers.get('x-session-token')).toBe(SESSION_TOKEN);
  });

  it('returns only the status, never the API’s body', async () => {
    const response = await handleVerificationDecision(
      post(DECISION_PATH, { verificationId: VERIFICATION, decision: 'approved' }),
      { env: ENV, fetch: api(200, { status: 'approved' }) },
    );
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ status: 'approved' });
  });

  it('refuses a success that carries anything the contract does not name', async () => {
    // The strict contract is what stops an upstream field reaching the browser: a body with a secret in
    // it is not filtered down to the safe part, it is refused outright.
    const response = await handleVerificationDecision(
      post(DECISION_PATH, { verificationId: VERIFICATION, decision: 'approved' }),
      { env: ENV, fetch: api(200, { status: 'approved', secret: 'leaked', token: SESSION_TOKEN }) },
    );
    const text = await response.text();
    expect(response.status).toBe(503);
    expect(text).not.toContain('leaked');
    expect(text).not.toContain(SESSION_TOKEN);
  });

  it('refuses a cross-site request before anything else', async () => {
    const seen: Seen[] = [];
    const response = await handleVerificationDecision(
      post(DECISION_PATH, { verificationId: VERIFICATION, decision: 'approved' }, { origin: 'https://evil.test' }),
      { env: ENV, fetch: api(200, {}, seen) },
    );
    expect(response.status).toBe(403);
    expect(seen).toEqual([]);
  });

  it('refuses a request with no session, before reaching the API', async () => {
    const seen: Seen[] = [];
    const request = new Request(`https://admin.test${DECISION_PATH}`, {
      method: 'POST',
      headers: { origin: 'https://admin.test', 'content-type': 'application/json' },
      body: JSON.stringify({ verificationId: VERIFICATION, decision: 'approved' }),
    });
    const response = await handleVerificationDecision(request, { env: ENV, fetch: api(200, {}, seen) });
    expect(response.status).toBe(401);
    expect(seen).toEqual([]);
  });

  it.each([
    ['no verification', { decision: 'approved' }],
    ['an identifier that is not one', { verificationId: '../secret', decision: 'approved' }],
    ['a status the reviewer path does not set', { verificationId: VERIFICATION, decision: 'under_review' }],
    ['no decision at all', { verificationId: VERIFICATION }],
    ['a rejection with no reason', { verificationId: VERIFICATION, decision: 'rejected' }],
    ['a rejection with a blank reason', { verificationId: VERIFICATION, decision: 'rejected', reason: '   ' }],
    ['a reason longer than the column', { verificationId: VERIFICATION, decision: 'rejected', reason: 'x'.repeat(2001) }],
  ])('refuses %s without a round trip', async (_name, body) => {
    const seen: Seen[] = [];
    const response = await handleVerificationDecision(post(DECISION_PATH, body), {
      env: ENV,
      fetch: api(200, {}, seen),
    });
    expect(response.status).toBe(400);
    expect(seen).toEqual([]);
  });

  it('keeps the two conflicts apart by code, and says nothing else about them', async () => {
    const decided = await handleVerificationDecision(
      post(DECISION_PATH, { verificationId: VERIFICATION, decision: 'approved' }),
      { env: ENV, fetch: api(409, { code: 'VERIFICATION_NOT_DECIDABLE', detail: 'Reviewed by Nadia.' }) },
    );
    expect(decided.status).toBe(409);
    const decidedText = await decided.text();
    expect(JSON.parse(decidedText)['code']).toBe('VERIFICATION_NOT_DECIDABLE');
    // The upstream sentence, which named a person, is not repeated to the browser.
    expect(decidedText).not.toContain('Nadia');

    const contacts = await handleVerificationDecision(
      post(DECISION_PATH, { verificationId: VERIFICATION, decision: 'approved' }),
      { env: ENV, fetch: api(409, { code: 'VERIFICATION_CONTACTS_UNVERIFIED' }) },
    );
    expect(JSON.parse(await contacts.text())['code']).toBe('VERIFICATION_CONTACTS_UNVERIFIED');
  });

  it('turns every other upstream answer into the right one, and never a success', async () => {
    for (const [status, expected] of [
      [401, 401],
      [404, 404],
      [400, 400],
      [403, 503],
      [500, 503],
      [503, 503],
    ] as const) {
      const response = await handleVerificationDecision(
        post(DECISION_PATH, { verificationId: VERIFICATION, decision: 'approved' }),
        { env: ENV, fetch: api(status, { code: 'HTTP_ERROR' }) },
      );
      expect(response.status, String(status)).toBe(expected);
    }
  });

  it('treats a drifted success as an outage rather than reporting a decision', async () => {
    const response = await handleVerificationDecision(
      post(DECISION_PATH, { verificationId: VERIFICATION, decision: 'approved' }),
      { env: ENV, fetch: api(200, { status: 'promoted' }) },
    );
    expect(response.status).toBe(503);
  });

  it('never returns a cacheable answer', async () => {
    const response = await handleVerificationDecision(
      post(DECISION_PATH, { verificationId: VERIFICATION, decision: 'approved' }),
      { env: ENV, fetch: api(200, { status: 'approved' }) },
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('the document link', () => {
  it('sends two identifiers in the address and no body at all', async () => {
    const seen: Seen[] = [];
    const response = await handleVerificationDocumentLink(
      post(DOCUMENT_PATH, { verificationId: VERIFICATION, documentId: DOCUMENT }),
      {
        env: ENV,
        fetch: api(
          200,
          { documentId: DOCUMENT, url: 'https://storage.test/one.jpg?token=abc', expiresAt: '2026-05-01T09:02:00.000Z' },
          seen,
        ),
      },
    );

    expect(response.status).toBe(200);
    expect(seen[0]!.url).toBe(
      `https://api.internal.test/v1/admin/seller-verifications/${VERIFICATION}/documents/${DOCUMENT}/link`,
    );
    expect(seen[0]!.body).toBe('');
    expect(seen[0]!.headers.get('cookie')).toBeNull();
  });

  it('accepts no path, ever', async () => {
    const seen: Seen[] = [];
    const response = await handleVerificationDocumentLink(
      post(DOCUMENT_PATH, {
        verificationId: VERIFICATION,
        documentId: DOCUMENT,
        objectPath: 'verification-documents/someone-else/passport/secret.pdf',
        bucket: 'verification-documents',
      }),
      {
        env: ENV,
        fetch: api(
          200,
          { documentId: DOCUMENT, url: 'https://storage.test/one.jpg', expiresAt: '2026-05-01T09:02:00.000Z' },
          seen,
        ),
      },
    );

    expect(response.status).toBe(200);
    // Nothing from the body reached the API: the address is built from two identifiers.
    expect(seen[0]!.body).toBe('');
    expect(seen[0]!.url).not.toContain('someone-else');
    expect(seen[0]!.url).not.toContain('secret.pdf');
  });

  it('returns the URL and its expiry, and nothing else the API said', async () => {
    const response = await handleVerificationDocumentLink(
      post(DOCUMENT_PATH, { verificationId: VERIFICATION, documentId: DOCUMENT }),
      {
        env: ENV,
        fetch: api(200, {
          documentId: DOCUMENT,
          url: 'https://storage.test/one.jpg?token=abc',
          expiresAt: '2026-05-01T09:02:00.000Z',
        }),
      },
    );
    expect(JSON.parse(await response.text())).toEqual({
      url: 'https://storage.test/one.jpg?token=abc',
      expiresAt: '2026-05-01T09:02:00.000Z',
    });
  });

  it('refuses a cross-site request, a session-less one and a malformed one', async () => {
    const seen: Seen[] = [];

    const crossSite = await handleVerificationDocumentLink(
      post(DOCUMENT_PATH, { verificationId: VERIFICATION, documentId: DOCUMENT }, { origin: 'https://evil.test' }),
      { env: ENV, fetch: api(200, {}, seen) },
    );
    expect(crossSite.status).toBe(403);

    const noSession = await handleVerificationDocumentLink(
      new Request(`https://admin.test${DOCUMENT_PATH}`, {
        method: 'POST',
        headers: { origin: 'https://admin.test', 'content-type': 'application/json' },
        body: JSON.stringify({ verificationId: VERIFICATION, documentId: DOCUMENT }),
      }),
      { env: ENV, fetch: api(200, {}, seen) },
    );
    expect(noSession.status).toBe(401);

    for (const body of [
      {},
      { verificationId: VERIFICATION },
      { documentId: DOCUMENT },
      { verificationId: '../x', documentId: DOCUMENT },
      { verificationId: VERIFICATION, documentId: 'not-a-uuid' },
    ]) {
      const response = await handleVerificationDocumentLink(post(DOCUMENT_PATH, body), {
        env: ENV,
        fetch: api(200, {}, seen),
      });
      expect(response.status).toBe(400);
    }

    expect(seen).toEqual([]);
  });

  it('turns a refusal upstream into a refusal here, and an outage into an outage', async () => {
    for (const [status, expected] of [
      [401, 401],
      [404, 404],
      [400, 400],
      [500, 503],
      [503, 503],
    ] as const) {
      const response = await handleVerificationDocumentLink(
        post(DOCUMENT_PATH, { verificationId: VERIFICATION, documentId: DOCUMENT }),
        { env: ENV, fetch: api(status, { code: 'HTTP_ERROR' }) },
      );
      expect(response.status, String(status)).toBe(expected);
    }
  });

  it('never returns a cacheable answer', async () => {
    const response = await handleVerificationDocumentLink(
      post(DOCUMENT_PATH, { verificationId: VERIFICATION, documentId: DOCUMENT }),
      {
        env: ENV,
        fetch: api(200, {
          documentId: DOCUMENT,
          url: 'https://storage.test/one.jpg',
          expiresAt: '2026-05-01T09:02:00.000Z',
        }),
      },
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('nothing about the caller is ever read from a request', () => {
  it('has no field anywhere in this module that a browser could assert authority with', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../src/server/bff/verification-review.ts', import.meta.url), 'utf8'),
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const field of ['reviewerId', 'reviewedBy', 'permissions', 'roles', 'aal', 'isStaff', 'objectPath', 'bucket']) {
      expect(code, field).not.toContain(`fields['${field}']`);
      expect(code, field).not.toContain(`body.${field}`);
    }
  });
});
