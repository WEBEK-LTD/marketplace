import type { SellerVerification } from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_ACCEPT,
  DOCUMENT_TYPES,
  authorizeDocumentUpload,
  checkChosenDocument,
  putBytes,
  recordDocument,
  refusal,
  removeDocument,
  runDocumentUpload,
  startVerification,
  submitVerification,
  verificationActions,
} from '../src/components/seller-verification';

/**
 * The verification surface's logic, as pure functions (Phase 6-I).
 *
 * The page test drives the rendered document; this drives the decisions, which is where the rules actually
 * live. Four of them matter most:
 *
 * **`verificationActions` is the page's whole safety argument**, so it is exercised over every one of the six
 * states, both storefront situations, and an unrecognised state — which must permit nothing. A gap here would
 * be a control shipped for an action the server will refuse.
 *
 * **Owner decisions 1, 2 and 3 are assertions, not comments.** No document requirement anywhere; a verified
 * storefront permits nothing; removal exactly in the `draft`/`submitted` window.
 *
 * **The browser chooses nothing about the destination**: every request body is asserted field by field, and
 * none carries a path the client composed, a status, a reviewer or a decision.
 *
 * **A signed URL is used once and kept nowhere**: `runDocumentUpload` returns no URL, and the confirmation
 * carries the path the server issued rather than anything derived in a browser.
 */

const verification = (status: string, documentCount = 0): SellerVerification =>
  ({
    status,
    submittedAt: status === 'draft' ? null : '2026-05-01T00:00:00.000Z',
    createdAt: '2026-04-01T00:00:00.000Z',
    emailVerified: true,
    phoneVerified: false,
    documentCount,
    documents: [],
  }) as SellerVerification;

describe('what the current state permits', () => {
  it('offers a start, and nothing else, to a storefront that has never applied', () => {
    expect(verificationActions('unverified', null)).toEqual({
      canStart: true,
      canAddDocuments: false,
      canRemoveDocuments: false,
      canSubmit: false,
      awaitingReview: false,
    });
  });

  it('offers a verified storefront nothing at all (owner decision 2)', () => {
    // Not a hidden control, not a disabled one: no permission, so the page builds no label group, so the
    // copy for "verify again" is not even in the RSC payload.
    expect(verificationActions('verified', null)).toEqual({
      canStart: false,
      canAddDocuments: false,
      canRemoveDocuments: false,
      canSubmit: false,
      awaitingReview: false,
    });
    // And that holds even if an attempt somehow exists beside a verified storefront.
    expect(verificationActions('verified', verification('draft')).canStart).toBe(false);
    expect(verificationActions('verified', verification('draft')).canSubmit).toBe(false);
    expect(verificationActions('verified', verification('draft')).canAddDocuments).toBe(false);
  });

  it('lets a draft be amended and submitted', () => {
    expect(verificationActions('unverified', verification('draft'))).toEqual({
      canStart: false,
      canAddDocuments: true,
      canRemoveDocuments: true,
      canSubmit: true,
      awaitingReview: false,
    });
  });

  it('submits a draft with no documents at all (owner decision 1)', () => {
    // There is no minimum, so nothing here counts documents before permitting a submission.
    expect(verificationActions('pending', verification('draft', 0)).canSubmit).toBe(true);
    expect(verificationActions('pending', verification('draft', 7)).canSubmit).toBe(true);
  });

  it('lets a submitted attempt be amended but not submitted again', () => {
    const actions = verificationActions('pending', verification('submitted'));
    expect(actions.canSubmit).toBe(false);
    // The verification schema's own rule: a submitted attempt is still the applicant's to add to.
    expect(actions.canAddDocuments).toBe(true);
    expect(actions.canRemoveDocuments).toBe(true);
    expect(actions.awaitingReview).toBe(true);
  });

  it('permits nothing once the attempt is with a reviewer or decided (owner decision 3)', () => {
    for (const status of ['under_review', 'approved', 'rejected', 'expired']) {
      const actions = verificationActions('pending', verification(status));
      expect(actions.canAddDocuments, status).toBe(false);
      expect(actions.canRemoveDocuments, status).toBe(false);
      expect(actions.canSubmit, status).toBe(false);
      expect(actions.canStart, status).toBe(false);
    }
    // Only `under_review` is "with a reviewer now"; a decided attempt is finished, not waiting.
    expect(verificationActions('pending', verification('under_review')).awaitingReview).toBe(true);
    expect(verificationActions('pending', verification('rejected')).awaitingReview).toBe(false);
  });

  it('permits nothing for a state it does not recognise', () => {
    // Fail closed: a seventh status added to the schema one day must not silently unlock a control here.
    expect(verificationActions('unverified', verification('escalated'))).toEqual({
      canStart: false,
      canAddDocuments: false,
      canRemoveDocuments: false,
      canSubmit: false,
      awaitingReview: false,
    });
  });
});

describe('choosing a file', () => {
  it('offers the bucket’s three types and no more', () => {
    expect(DOCUMENT_ACCEPT).toBe('image/jpeg,image/png,application/pdf');
    expect(DOCUMENT_ACCEPT).not.toContain('svg');
    expect(DOCUMENT_TYPES).toHaveLength(6);
  });

  it('accepts a file inside the bucket’s limits and refuses one outside them', () => {
    expect(checkChosenDocument({ type: 'application/pdf', size: 4096 })).toEqual({
      ok: true,
      contentType: 'application/pdf',
    });
    expect(checkChosenDocument({ type: 'application/pdf', size: 20_971_520 }).ok).toBe(true);
    expect(checkChosenDocument(null)).toEqual({ ok: false, reason: 'missing' });
    expect(checkChosenDocument({ type: 'image/webp', size: 10 })).toEqual({
      ok: false,
      reason: 'type',
    });
    expect(checkChosenDocument({ type: 'image/svg+xml', size: 10 })).toEqual({
      ok: false,
      reason: 'type',
    });
    expect(checkChosenDocument({ type: 'application/pdf', size: 20_971_521 })).toEqual({
      ok: false,
      reason: 'size',
    });
    expect(checkChosenDocument({ type: 'application/pdf', size: 0 }).ok).toBe(false);
    expect(checkChosenDocument({ type: 'application/pdf', size: -1 }).ok).toBe(false);
  });
});

describe('what a refusal becomes', () => {
  const body = (code: string) => JSON.stringify({ code });

  it('maps each declared code to its own sentence', () => {
    expect(refusal(409, body('SELLER_VERIFICATION_EXISTS'))).toEqual({ kind: 'exists' });
    expect(refusal(409, body('SELLER_VERIFICATION_ALREADY_VERIFIED'))).toEqual({
      kind: 'already_verified',
    });
    expect(refusal(409, body('SELLER_VERIFICATION_NOT_EDITABLE'))).toEqual({
      kind: 'not_editable',
    });
    expect(refusal(409, body('SELLER_PROFILE_NOT_EDITABLE'))).toEqual({ kind: 'not_editable' });
    expect(refusal(409, body('SELLER_VERIFICATION_DOCUMENT_PATH_TAKEN'))).toEqual({
      kind: 'path_taken',
    });
    expect(refusal(404, body('SELLER_MEDIA_OBJECT_MISSING'))).toEqual({ kind: 'missing_object' });
    expect(refusal(404, body('NOT_FOUND'))).toEqual({ kind: 'not_found' });
    expect(refusal(401, '')).toEqual({ kind: 'unauthenticated' });
    expect(refusal(400, '')).toEqual({ kind: 'invalid' });
    expect(refusal(429, '')).toEqual({ kind: 'unavailable' });
  });

  it('falls back to unavailable for a code it does not know, and for nonsense', () => {
    expect(refusal(409, body('SOMETHING_NEW'))).toEqual({ kind: 'unavailable' });
    expect(refusal(409, 'not json at all')).toEqual({ kind: 'unavailable' });
    expect(refusal(500, '')).toEqual({ kind: 'unavailable' });
  });
});

interface Sent {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function recorder(
  responses: { status: number; body: string }[],
): { readonly sent: Sent[]; readonly fetcher: typeof fetch } {
  const sent: Sent[] = [];
  let index = 0;
  const fetcher = (async (url: string, init?: RequestInit) => {
    sent.push({ url, init });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return {
      ok: (next?.status ?? 200) < 400,
      status: next?.status ?? 200,
      text: async () => next?.body ?? '',
    };
  }) as unknown as typeof fetch;
  return { sent, fetcher };
}

describe('starting and submitting', () => {
  it('starts with no body at all', async () => {
    const { sent, fetcher } = recorder([{ status: 201, body: JSON.stringify({ status: 'draft' }) }]);
    expect(await startVerification(fetcher)).toEqual({ kind: 'state', status: 'draft' });
    expect(sent[0]?.url).toBe('/api/sellers/me/verification');
    expect(sent[0]?.init?.method).toBe('POST');
    // A status a browser could put in a body would be a status the browser chose.
    expect(sent[0]?.init?.body).toBeUndefined();
    expect(sent[0]?.init?.credentials).toBe('same-origin');
  });

  it('submits with no body at all, and no document count', async () => {
    const { sent, fetcher } = recorder([
      { status: 200, body: JSON.stringify({ status: 'submitted' }) },
    ]);
    expect(await submitVerification(fetcher)).toEqual({ kind: 'state', status: 'submitted' });
    expect(sent[0]?.url).toBe('/api/sellers/me/verification/submission');
    expect(sent[0]?.init?.body).toBeUndefined();
  });

  it('reports a refusal rather than a state', async () => {
    const { fetcher } = recorder([
      { status: 409, body: JSON.stringify({ code: 'SELLER_VERIFICATION_EXISTS' }) },
    ]);
    expect(await startVerification(fetcher)).toEqual({ kind: 'exists' });
  });

  it('treats an unparseable success as unavailable', async () => {
    const { fetcher } = recorder([{ status: 201, body: '{"status":"invented"}' }]);
    expect(await startVerification(fetcher)).toEqual({ kind: 'unavailable' });
  });
});

describe('the three upload steps', () => {
  it('sends a type, a content type and a size — and no destination', async () => {
    const { sent, fetcher } = recorder([
      {
        status: 201,
        body: JSON.stringify({
          upload: {
            documentType: 'passport',
            uploadUrl: 'https://provider.invalid/put?token=secret-token',
            objectPath: 'verification-documents/shop/passport/abc.pdf',
            expiresAt: '2026-05-01T00:00:00.000Z',
            maxByteSize: 20_971_520,
          },
        }),
      },
    ]);
    const result = await authorizeDocumentUpload(
      'passport',
      { type: 'application/pdf', size: 4096 },
      fetcher,
    );
    expect(result.ok).toBe(true);
    expect(JSON.parse(String(sent[0]?.init?.body))).toEqual({
      documentType: 'passport',
      contentType: 'application/pdf',
      byteSize: 4096,
    });
  });

  it('refuses a file the bucket would refuse, without asking the server', async () => {
    const { sent, fetcher } = recorder([{ status: 201, body: '{}' }]);
    const result = await authorizeDocumentUpload(
      'passport',
      { type: 'image/webp', size: 10 },
      fetcher,
    );
    expect(result).toEqual({ ok: false, outcome: { kind: 'invalid' } });
    expect(sent).toEqual([]);
  });

  it('sends the bytes with no cookie of this site’s attached', async () => {
    const { sent, fetcher } = recorder([{ status: 200, body: '' }]);
    expect(await putBytes('https://provider.invalid/put', new ArrayBuffer(4), 'application/pdf', fetcher)).toBe(
      true,
    );
    expect(sent[0]?.init?.credentials).toBe('omit');
    expect(sent[0]?.init?.method).toBe('PUT');
  });

  it('confirms with the path the server issued and no status', async () => {
    const { sent, fetcher } = recorder([
      { status: 201, body: JSON.stringify({ documentCount: 3 }) },
    ]);
    const outcome = await recordDocument(
      'national_id',
      'verification-documents/shop/national_id/abc.pdf',
      'id.pdf',
      'application/pdf',
      4096,
      fetcher,
    );
    expect(outcome).toEqual({ kind: 'ok', documentCount: 3 });
    const body = JSON.parse(String(sent[0]?.init?.body)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'byteSize',
      'contentType',
      'documentType',
      'objectPath',
      'originalFilename',
    ]);
    expect(body['objectPath']).toBe('verification-documents/shop/national_id/abc.pdf');
  });

  it('runs all three in order and returns no URL', async () => {
    const { sent, fetcher } = recorder([
      {
        status: 201,
        body: JSON.stringify({
          upload: {
            documentType: 'national_id',
            uploadUrl: 'https://provider.invalid/put?token=secret-token',
            objectPath: 'verification-documents/shop/national_id/abc.pdf',
            expiresAt: '2026-05-01T00:00:00.000Z',
            maxByteSize: 20_971_520,
          },
        }),
      },
      { status: 200, body: '' },
      { status: 201, body: JSON.stringify({ documentCount: 1 }) },
    ]);
    const outcome = await runDocumentUpload(
      'national_id',
      { type: 'application/pdf', size: 4096, body: new ArrayBuffer(4), name: 'id.pdf' },
      { origin: fetcher, storage: fetcher },
    );
    expect(outcome).toEqual({ kind: 'ok', documentCount: 1 });
    expect(sent.map((one) => one.url)).toEqual([
      '/api/sellers/me/verification/documents/uploads',
      'https://provider.invalid/put?token=secret-token',
      '/api/sellers/me/verification/documents',
    ]);
    // The signed URL lives inside that one call: it is in no outcome and in no returned value.
    expect(JSON.stringify(outcome)).not.toContain('secret-token');
  });

  it('never confirms an upload that did not happen', async () => {
    const { sent, fetcher } = recorder([
      {
        status: 201,
        body: JSON.stringify({
          upload: {
            documentType: 'national_id',
            uploadUrl: 'https://provider.invalid/put',
            objectPath: 'verification-documents/shop/national_id/abc.pdf',
            expiresAt: '2026-05-01T00:00:00.000Z',
            maxByteSize: 20_971_520,
          },
        }),
      },
      { status: 500, body: '' },
    ]);
    const outcome = await runDocumentUpload(
      'national_id',
      { type: 'application/pdf', size: 4096, body: new ArrayBuffer(4), name: 'id.pdf' },
      { origin: fetcher, storage: fetcher },
    );
    expect(outcome).toEqual({ kind: 'unavailable' });
    // Two calls, not three: a document that did not upload is never recorded as evidence.
    expect(sent).toHaveLength(2);
  });
});

describe('removing a document', () => {
  it('addresses the document by its own id and sends no body', async () => {
    const { sent, fetcher } = recorder([
      { status: 200, body: JSON.stringify({ documentCount: 0 }) },
    ]);
    const outcome = await removeDocument('22222222-2222-4222-8222-222222222222', fetcher);
    expect(outcome).toEqual({ kind: 'ok', documentCount: 0 });
    expect(sent[0]?.url).toBe(
      '/api/sellers/me/verification/documents/22222222-2222-4222-8222-222222222222',
    );
    expect(sent[0]?.init?.method).toBe('DELETE');
    expect(sent[0]?.init?.body).toBeUndefined();
  });

  it('percent-encodes whatever it is given', async () => {
    const { sent, fetcher } = recorder([{ status: 404, body: JSON.stringify({ code: 'NOT_FOUND' }) }]);
    await removeDocument('../../etc/passwd', fetcher);
    expect(sent[0]?.url).toBe('/api/sellers/me/verification/documents/..%2F..%2Fetc%2Fpasswd');
  });

  it('reads a refusal as absence, saying nothing about why', async () => {
    const { fetcher } = recorder([{ status: 404, body: JSON.stringify({ code: 'NOT_FOUND' }) }]);
    expect(await removeDocument('22222222-2222-4222-8222-222222222222', fetcher)).toEqual({
      kind: 'not_found',
    });
  });
});
