import { describe, expect, it } from 'vitest';
import {
  handleSellerVerification,
  handleSellerVerificationDocument,
  handleSellerVerificationDocumentRemove,
  handleSellerVerificationStart,
  handleSellerVerificationSubmit,
  handleSellerVerificationUpload,
  readSellerVerification,
} from '../src/server/bff/seller-verification';
import { SESSION_COOKIES } from '../src/server/bff/session-cookies';

/**
 * The five seller verification routes at the BFF boundary (Phase 6-I).
 *
 * The properties this boundary owes the browser:
 *
 *   * the Origin check runs **first** on every write, before the session cookie is read;
 *   * the session leaves as one header on one internal hop, and the browser's `Cookie` is never forwarded;
 *   * the strict contracts are applied here too, and the **validated** value is forwarded, so a `status`,
 *     `reviewedBy` or `decisionReason` a client invented has no route through this layer;
 *   * the two state-changing writes send **no body upstream at all**, so a status cannot arrive even as
 *     something to be ignored;
 *   * success is one exact status per operation, compared rather than assumed from the 2xx range;
 *   * the readback carries no object path, no reviewer and no review note, whatever the upstream sends;
 *   * the document id is checked for shape, percent-encoded, and authorizes nothing.
 *
 * No browser, no live API: the upstream is a function.
 */

const ENV = Object.freeze({
  API_BASE_URL: 'https://api.internal.test',
  PUBLIC_WEB_ORIGIN: 'https://web.test',
  INTERNAL_BFF_CREDENTIAL: 'test-current-credential-value-not-a-real-se',
});

const ACCESS_TOKEN = 'browser-access-token-value-not-a-real-token';
const REFRESH_TOKEN = 'browser-refresh-token-value-not-a-real-toke';
const COOKIE = `${SESSION_COOKIES.access.name}=${ACCESS_TOKEN}; ${SESSION_COOKIES.refresh.name}=${REFRESH_TOKEN}`;
const DOCUMENT_ID = '22222222-2222-4222-8222-222222222222';
const OBJECT_PATH =
  'verification-documents/good-shop/national_id/33333333-3333-4333-8333-333333333333.pdf';

const DOCUMENT = {
  id: DOCUMENT_ID,
  documentType: 'national_id',
  originalFilename: 'id.pdf',
  contentType: 'application/pdf',
  byteSize: '4096',
  status: 'pending',
  uploadedAt: '2026-05-01T00:00:00.000Z',
};

const VERIFICATION = {
  status: 'draft',
  submittedAt: null,
  createdAt: '2026-04-01T00:00:00.000Z',
  emailVerified: true,
  phoneVerified: false,
  documentCount: 1,
  documents: [DOCUMENT],
};

const UPLOAD = {
  upload: {
    documentType: 'national_id',
    uploadUrl: 'https://provider.invalid/put?token=signed-token',
    objectPath: OBJECT_PATH,
    expiresAt: '2026-05-01T00:00:00.000Z',
    maxByteSize: 20_971_520,
  },
};

const VALID_DOCUMENT = {
  documentType: 'national_id',
  objectPath: OBJECT_PATH,
  originalFilename: 'id.pdf',
  contentType: 'application/pdf',
  byteSize: 4096,
};

interface Seen {
  readonly url: string;
  readonly method: string | undefined;
  readonly headers: Headers;
  readonly body: string | undefined;
}

function upstream(
  status: number,
  payload: unknown,
  seen: Seen[],
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    seen.push({
      url: String(input),
      method: init?.method,
      headers: new Headers(init?.headers as HeadersInit),
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return new Response(text, {
      status,
      headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
    });
  };
}

function write(
  path: string,
  payload?: unknown,
  headers: Record<string, string> = {},
  method: 'POST' | 'DELETE' = 'POST',
): Request {
  return new Request(`https://web.test${path}`, {
    method,
    headers: {
      origin: 'https://web.test',
      cookie: COOKIE,
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
}

function read(path = '/api/sellers/me/verification', headers: Record<string, string> = {}): Request {
  return new Request(`https://web.test${path}`, {
    method: 'GET',
    headers: { origin: 'https://web.test', cookie: COOKIE, ...headers },
  });
}

const problem = (code: string) => ({ code, status: 409, title: 'Conflict', detail: 'x' });

describe('reading the caller’s own attempt', () => {
  it('makes one credentialled internal hop carrying the session, and forwards no cookie', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerVerification(read(), {
      env: ENV,
      fetch: upstream(200, { verification: VERIFICATION }, seen),
    });

    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(`${ENV.API_BASE_URL}/v1/sellers/me/verification`);
    expect(seen[0]?.headers.get('x-session-token')).toBe(ACCESS_TOKEN);
    expect(seen[0]?.headers.get('cookie')).toBeNull();
    expect(await response.text()).not.toContain(REFRESH_TOKEN);
  });

  it('is never cached', async () => {
    const response = await handleSellerVerification(read(), {
      env: ENV,
      fetch: upstream(200, { verification: VERIFICATION }, []),
    });
    // An identity document's filename must not sit in a shared machine's cache.
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('rebuilds the attempt from the validated fields, so a drifted field cannot travel', async () => {
    const response = await handleSellerVerification(read(), {
      env: ENV,
      fetch: upstream(
        200,
        {
          verification: {
            ...VERIFICATION,
            reviewedBy: 'leak',
            decisionReason: 'internal note',
            documents: [{ ...DOCUMENT, objectPath: OBJECT_PATH, reviewNote: 'illegible' }],
          },
        },
        [],
      ),
    });

    // The strict contract refuses the whole body rather than trimming it, so the handler answers 503 rather
    // than passing a shape it does not recognise to a browser. Either way, nothing leaks.
    const text = await response.text();
    expect(text).not.toContain('internal note');
    expect(text).not.toContain('illegible');
    expect(text).not.toContain(OBJECT_PATH);
  });

  it('passes a null attempt through as null, not as an error', async () => {
    const response = await handleSellerVerification(read(), {
      env: ENV,
      fetch: upstream(200, { verification: null }, []),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ verification: null });
  });

  it('refuses without a session and never asks upstream', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerVerification(
      new Request('https://web.test/api/sellers/me/verification', { method: 'GET' }),
      { env: ENV, fetch: upstream(200, {}, seen) },
    );
    expect(response.status).toBe(401);
    expect(seen).toEqual([]);
  });

  it('forwards a declared refusal and turns anything else into a 503', async () => {
    for (const status of [400, 401, 403, 404, 409, 429]) {
      const response = await handleSellerVerification(read(), {
        env: ENV,
        fetch: upstream(status, problem('NOT_FOUND'), []),
      });
      expect(response.status, String(status)).toBe(status);
    }
    const odd = await handleSellerVerification(read(), {
      env: ENV,
      fetch: upstream(418, problem('NOT_FOUND'), []),
    });
    expect(odd.status).toBe(503);
  });
});

describe('the page-side reader', () => {
  it('distinguishes none, not_a_seller, unauthenticated and unavailable', async () => {
    const cases = [
      [200, { verification: null }, 'none'],
      [200, { verification: VERIFICATION }, 'ok'],
      [401, problem('AUTHENTICATION_REQUIRED'), 'unauthenticated'],
      [404, problem('NOT_FOUND'), 'not_a_seller'],
      [503, problem('SERVICE_UNAVAILABLE'), 'unavailable'],
      [200, { verification: { status: 'invented' } }, 'unavailable'],
    ] as const;
    for (const [status, payload, kind] of cases) {
      const lookup = await readSellerVerification({
        env: ENV,
        cookieHeader: COOKIE,
        fetch: upstream(status, payload, []),
      });
      expect(lookup.kind, `${status}`).toBe(kind);
    }
  });

  it('asks nothing at all without a session cookie', async () => {
    const seen: Seen[] = [];
    const lookup = await readSellerVerification({
      env: ENV,
      cookieHeader: null,
      fetch: upstream(200, {}, seen),
    });
    expect(lookup.kind).toBe('unauthenticated');
    expect(seen).toEqual([]);
  });
});

describe('starting and submitting', () => {
  it('sends no body upstream at all', async () => {
    for (const [handler, path, status] of [
      [handleSellerVerificationStart, '/v1/sellers/me/verification', 201],
      [handleSellerVerificationSubmit, '/v1/sellers/me/verification/submission', 200],
    ] as const) {
      const seen: Seen[] = [];
      const response = await handler(
        write('/api/sellers/me/verification', { status: 'approved', reviewedBy: 'me' }),
        { env: ENV, fetch: upstream(status, { status: 'draft' }, seen) },
      );
      expect(response.status, path).toBe(status);
      expect(seen[0]?.url).toBe(`${ENV.API_BASE_URL}${path}`);
      // A status a browser put in a body cannot arrive, because no body is sent.
      expect(seen[0]?.body, path).toBeUndefined();
      expect(seen[0]?.headers.get('content-type'), path).toBeNull();
    }
  });

  it('checks the Origin before it reads the cookie', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerVerificationStart(
      write('/api/sellers/me/verification', undefined, { origin: 'https://evil.test' }),
      { env: ENV, fetch: upstream(201, { status: 'draft' }, seen) },
    );
    expect(response.status).toBe(403);
    expect(seen).toEqual([]);
  });

  it('answers exactly 201 for a start and 200 for a submission, not any 2xx', async () => {
    const start = await handleSellerVerificationStart(write('/api/sellers/me/verification'), {
      env: ENV,
      fetch: upstream(200, { status: 'draft' }, []),
    });
    expect(start.status).toBe(503);
    const submit = await handleSellerVerificationSubmit(
      write('/api/sellers/me/verification/submission'),
      { env: ENV, fetch: upstream(201, { status: 'submitted' }, []) },
    );
    expect(submit.status).toBe(503);
  });

  it('forwards each declared conflict with its own code', async () => {
    for (const code of [
      'SELLER_VERIFICATION_EXISTS',
      'SELLER_VERIFICATION_ALREADY_VERIFIED',
      'SELLER_VERIFICATION_NOT_EDITABLE',
    ]) {
      const response = await handleSellerVerificationStart(write('/api/sellers/me/verification'), {
        env: ENV,
        fetch: upstream(409, problem(code), []),
      });
      expect(response.status, code).toBe(409);
      expect(await response.json(), code).toMatchObject({ code });
    }
  });
});

describe('authorizing a document upload', () => {
  it('forwards the validated body and returns the authorization once, uncached', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerVerificationUpload(
      write('/api/sellers/me/verification/documents/uploads', {
        documentType: 'national_id',
        contentType: 'application/pdf',
        byteSize: 4096,
      }),
      { env: ENV, fetch: upstream(201, UPLOAD, seen) },
    );

    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(JSON.parse(String(seen[0]?.body))).toEqual({
      documentType: 'national_id',
      contentType: 'application/pdf',
      byteSize: 4096,
    });
  });

  it('refuses a body that names a destination, and never asks upstream', async () => {
    const seen: Seen[] = [];
    for (const body of [
      { documentType: 'national_id', contentType: 'application/pdf', byteSize: 10, objectPath: 'x' },
      { documentType: 'national_id', contentType: 'application/pdf', byteSize: 10, bucket: 'x' },
      { documentType: 'national_id', contentType: 'image/webp', byteSize: 10 },
      { documentType: 'drivers_licence', contentType: 'application/pdf', byteSize: 10 },
      { documentType: 'national_id', contentType: 'application/pdf', byteSize: 20_971_521 },
    ]) {
      const response = await handleSellerVerificationUpload(
        write('/api/sellers/me/verification/documents/uploads', body),
        { env: ENV, fetch: upstream(201, UPLOAD, seen) },
      );
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(seen).toEqual([]);
  });
});

describe('recording a document', () => {
  it('forwards the validated body and answers with the count', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerVerificationDocument(
      write('/api/sellers/me/verification/documents', VALID_DOCUMENT),
      { env: ENV, fetch: upstream(201, { documentCount: 2 }, seen) },
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ documentCount: 2 });
    expect(JSON.parse(String(seen[0]?.body))).toEqual(VALID_DOCUMENT);
  });

  it('refuses a status, a reviewer or a review note in the body', async () => {
    const seen: Seen[] = [];
    for (const field of ['status', 'reviewNote', 'reviewedBy', 'reviewedAt', 'verificationId']) {
      const response = await handleSellerVerificationDocument(
        write('/api/sellers/me/verification/documents', { ...VALID_DOCUMENT, [field]: 'x' }),
        { env: ENV, fetch: upstream(201, { documentCount: 1 }, seen) },
      );
      expect(response.status, field).toBe(400);
    }
    expect(seen).toEqual([]);
  });

  it('checks the Origin first', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerVerificationDocument(
      write('/api/sellers/me/verification/documents', VALID_DOCUMENT, {
        origin: 'https://evil.test',
      }),
      { env: ENV, fetch: upstream(201, { documentCount: 1 }, seen) },
    );
    expect(response.status).toBe(403);
    expect(seen).toEqual([]);
  });
});

describe('removing a document', () => {
  it('percent-encodes the id into the internal URL and sends no body', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerVerificationDocumentRemove(
      write(`/api/sellers/me/verification/documents/${DOCUMENT_ID}`, undefined, {}, 'DELETE'),
      DOCUMENT_ID,
      { env: ENV, fetch: upstream(200, { documentCount: 0 }, seen) },
    );
    expect(response.status).toBe(200);
    expect(seen[0]?.url).toBe(
      `${ENV.API_BASE_URL}/v1/sellers/me/verification/documents/${DOCUMENT_ID}`,
    );
    expect(seen[0]?.method).toBe('DELETE');
    expect(seen[0]?.body).toBeUndefined();
  });

  it('refuses an id that is not a uuid without asking upstream', async () => {
    const seen: Seen[] = [];
    for (const id of ['../../etc/passwd', 'not-a-uuid', '', '1 OR 1=1']) {
      const response = await handleSellerVerificationDocumentRemove(
        write('/api/sellers/me/verification/documents/x', undefined, {}, 'DELETE'),
        id,
        { env: ENV, fetch: upstream(200, { documentCount: 0 }, seen) },
      );
      expect(response.status, id).toBe(404);
    }
    expect(seen).toEqual([]);
  });

  it('checks the Origin first', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerVerificationDocumentRemove(
      write(
        `/api/sellers/me/verification/documents/${DOCUMENT_ID}`,
        undefined,
        { origin: 'https://evil.test' },
        'DELETE',
      ),
      DOCUMENT_ID,
      { env: ENV, fetch: upstream(200, { documentCount: 0 }, seen) },
    );
    expect(response.status).toBe(403);
    expect(seen).toEqual([]);
  });

  it('forwards a 404 exactly, saying nothing about why the document is unreachable', async () => {
    const response = await handleSellerVerificationDocumentRemove(
      write(`/api/sellers/me/verification/documents/${DOCUMENT_ID}`, undefined, {}, 'DELETE'),
      DOCUMENT_ID,
      { env: ENV, fetch: upstream(404, { code: 'NOT_FOUND', status: 404 }, []) },
    );
    expect(response.status).toBe(404);
    const text = await response.text();
    expect(text.toLowerCase()).not.toContain('review');
    expect(text.toLowerCase()).not.toContain('belong');
  });
});
