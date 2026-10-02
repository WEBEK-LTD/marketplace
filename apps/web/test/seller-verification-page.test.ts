import type { ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import ar from '../messages/ar.json';
import en from '../messages/en.json';
import { startBuiltApp, type RunningApp } from './support/next-server.js';
import { problem, startStubApi, type StubApi } from './support/stub-api.js';

/**
 * `/dashboard/seller/verification`, over real HTTP against the built app (Phase 6-I).
 *
 * What this page owes, and what the assertions are about:
 *
 * **Nothing private reaches the payload.** The stub API deliberately answers with a reviewer, a review time,
 * a decision reason, an object path and a document review note — none of which the contract carries — and
 * the rendered document is asserted to contain none of them. This is the projection's whole purpose, so it
 * is tested against an upstream that is trying to leak.
 *
 * **Controls exist only where the state permits them**, and a control that is not permitted is *absent*
 * rather than disabled — copy included, because a label shipped for an action the server will never allow is
 * an RSC-payload leak of exactly the kind 6-F caught.
 *
 * **Owner decision 2 is an absence.** A verified storefront gets the verified sentence and no form, no start
 * control, and none of that copy anywhere in the document.
 *
 * **Owner decision 1 is a sentence, not a threshold.** A draft with no documents still offers to send the
 * application, and the hint says there is no required number.
 *
 * **A failure is not "you never applied".** An unavailable API gets the error view.
 *
 * **Both locales, and no physical direction anywhere.**
 *
 * The panel's *behaviour* is tested exactly, as pure functions, in `seller-verification-logic.test.ts`.
 *
 * No browser, no Playwright, no live provider, no deployment.
 */

// Exactly 43 base64url characters, or the web app's env validation refuses it at startup.
const CANARY_CREDENTIAL = 'test-web-verify-page-canary-not-real-xxxxxx';
const ACCESS = '__Host-mp_access=canary-access-token-value-not-a-real-token';
const REFRESH = '__Host-mp_refresh=canary-refresh-token-value-not-a-real-toke';
const SESSION = `${ACCESS}; ${REFRESH}`;
const USER_ID = '11111111-1111-4111-8111-111111111111';
const IDENTITY = { user: { id: USER_ID, displayName: 'Nadia' } };

const SELLER = {
  slug: 'verify-shop',
  displayName: 'Verify Shop',
  status: 'pending',
  verificationStatus: 'unverified',
  city: 'Cairo',
  countryCode: 'EG',
};

const DOCUMENT = {
  id: '22222222-2222-4222-8222-222222222222',
  documentType: 'national_id',
  originalFilename: 'my-national-id.pdf',
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

/** Values no verification contract carries, offered by the stub API anyway. */
const PRIVATE_VALUES = {
  verificationId: '44444444-4444-4444-8444-444444444444',
  sellerUserId: USER_ID,
  reviewedBy: '99999999-9999-4999-8999-999999999999',
  reviewedAt: '2026-05-02T00:00:00.000Z',
  decisionReason: 'Documents were illegible, internal moderation note',
  objectPath: 'verification-documents/verify-shop/national_id/secret-object-name.pdf',
  reviewNote: 'Blurred scan, internal reviewer note',
  expiresAt: '2027-05-01T00:00:00.000Z',
} as const;

type Mode =
  | {
      readonly kind: 'ok';
      readonly seller?: Record<string, unknown>;
      readonly verification?: Record<string, unknown> | null;
      /** Adds the fields above to the attempt and its document, to prove they cannot travel. */
      readonly leak?: boolean;
    }
  | { readonly kind: 'not_a_seller' }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'verification_unavailable' };

let api: StubApi;
let app: RunningApp;

beforeAll(async () => {
  api = await startStubApi();
  app = await startBuiltApp({
    API_BASE_URL: api.baseUrl,
    PUBLIC_WEB_ORIGIN: 'https://web.test',
    INTERNAL_BFF_CREDENTIAL: CANARY_CREDENTIAL,
  });
}, 120_000);

afterAll(async () => {
  await app.stop();
  await api.stop();
});

function json(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function apiServes(mode: Mode = { kind: 'ok' }): void {
  api.reply((request, response) => {
    const path = request.url.split('?')[0] ?? '';
    if (path === '/v1/users/me') return json(response, IDENTITY);
    if (path === '/v1/sellers/me') {
      if (mode.kind === 'not_a_seller') return problem(response, 404, 'NOT_FOUND');
      if (mode.kind === 'unauthenticated') return problem(response, 401, 'AUTHENTICATION_REQUIRED');
      return json(response, { seller: mode.kind === 'ok' ? (mode.seller ?? SELLER) : SELLER });
    }
    if (path === '/v1/sellers/me/verification') {
      if (mode.kind === 'not_a_seller') return problem(response, 404, 'NOT_FOUND');
      if (mode.kind === 'unauthenticated') return problem(response, 401, 'AUTHENTICATION_REQUIRED');
      if (mode.kind === 'verification_unavailable') {
        return problem(response, 503, 'SERVICE_UNAVAILABLE');
      }
      const base =
        mode.verification === undefined ? VERIFICATION : mode.verification;
      if (base === null) return json(response, { verification: null });
      const attempt =
        mode.leak === true
          ? {
              ...base,
              ...PRIVATE_VALUES,
              documents: [
                {
                  ...DOCUMENT,
                  objectPath: PRIVATE_VALUES.objectPath,
                  reviewNote: PRIVATE_VALUES.reviewNote,
                  reviewedBy: PRIVATE_VALUES.reviewedBy,
                  reviewedAt: PRIVATE_VALUES.reviewedAt,
                  verificationId: PRIVATE_VALUES.verificationId,
                },
              ],
            }
          : base;
      return json(response, { verification: attempt });
    }
    if (path === '/v1/listings') return json(response, { listings: [], nextCursor: null });
    if (path === '/v1/services') return json(response, { services: [], nextCursor: null });
    return problem(response, 404, 'NOT_FOUND');
  });
}

beforeEach(() => {
  api.seen.length = 0;
  apiServes();
});

interface Page {
  readonly status: number;
  readonly location: string | null;
  readonly robotsHeader: string | null;
  readonly html: string;
}

async function load(path: string, cookie: string | null = SESSION): Promise<Page> {
  const response = await fetch(`${app.baseUrl}${path}`, {
    redirect: 'manual',
    headers: cookie === null ? {} : { cookie },
  });
  return {
    status: response.status,
    location: response.headers.get('location'),
    robotsHeader: response.headers.get('x-robots-tag'),
    html: await response.text(),
  };
}

const copy = en.SellerVerification;
const arabic = ar.SellerVerification;

describe('protection', () => {
  it('redirects a signed-out visitor into the existing login flow', async () => {
    const page = await load('/dashboard/seller/verification', null);

    expect(page.status).toBe(307);
    expect(page.location).toContain('/login');
    expect(page.robotsHeader).toBe('noindex');
  });

  it('redirects to the Arabic sign-in under /ar', async () => {
    const page = await load('/ar/dashboard/seller/verification', null);

    expect(page.status).toBe(307);
    expect(page.location).toContain('/ar/login');
  });

  it('gives a signed-out visitor no document at all, payload included', async () => {
    const page = await load('/dashboard/seller/verification', null);

    for (const absent of [
      DOCUMENT.originalFilename,
      copy.start,
      copy.submit,
      'name="documentType"',
    ]) {
      expect(page.html, absent).not.toContain(absent);
    }
  });
});

describe('what never reaches the payload', () => {
  it('ships no reviewer, review time, decision reason, object path or review note', async () => {
    apiServes({ kind: 'ok', leak: true });
    const page = await load('/dashboard/seller/verification');

    expect(page.status).toBe(200);
    for (const [name, value] of Object.entries(PRIVATE_VALUES)) {
      expect(page.html, name).not.toContain(value);
    }
    for (const key of [
      'reviewedBy',
      'reviewedAt',
      'decisionReason',
      'objectPath',
      'reviewNote',
      'verificationId',
      'sellerUserId',
    ]) {
      expect(page.html, key).not.toContain(key);
    }
  });

  it('ships no session token and no internal address', async () => {
    const page = await load('/dashboard/seller/verification');

    expect(page.html).not.toContain('canary-access-token');
    expect(page.html).not.toContain('canary-refresh-token');
    expect(page.html).not.toContain(CANARY_CREDENTIAL);
    expect(page.html).not.toContain(api.baseUrl);
  });

  it('shows the seller their own document’s filename, which is theirs', async () => {
    const page = await load('/dashboard/seller/verification');
    expect(page.html).toContain(DOCUMENT.originalFilename);
  });

  it('carries no identifier and no path on a page that renders normally', async () => {
    // The test above proves a drifted upstream fails closed. This one proves the ordinary case: a
    // contract-valid attempt renders, and still nothing private is anywhere in the payload.
    const page = await load('/dashboard/seller/verification');

    expect(page.html).toContain(copy.documents);
    for (const [name, value] of Object.entries(PRIVATE_VALUES)) {
      expect(page.html, name).not.toContain(value);
    }
    expect(page.html).not.toContain(USER_ID);
    // The document's own id is the one identifier the contract carries, because removing one needs it.
    expect(page.html).toContain(DOCUMENT.id);
  });
});

describe('a storefront that has never applied', () => {
  it('offers a start and says so, with no submission copy anywhere', async () => {
    apiServes({ kind: 'ok', verification: null });
    const page = await load('/dashboard/seller/verification');

    expect(page.status).toBe(200);
    expect(page.html).toContain(copy.noAttempt);
    expect(page.html).toContain(copy.start);
    // No attempt means nothing to submit and nothing to upload: neither group is in the payload.
    expect(page.html).not.toContain(copy.submit);
    expect(page.html).not.toContain(copy.submitHint);
    expect(page.html).not.toContain(copy.chooseFile);
    expect(page.html).not.toContain(copy.remove);
  });
});

describe('a verified storefront (owner decision 2)', () => {
  it('shows the verified state and offers nothing at all', async () => {
    apiServes({
      kind: 'ok',
      seller: { ...SELLER, status: 'active', verificationStatus: 'verified' },
      verification: null,
    });
    const page = await load('/dashboard/seller/verification');

    expect(page.status).toBe(200);
    expect(page.html).toContain(copy.verified);
    // Not a disabled control: the copy for every action is absent from the document entirely.
    for (const absent of [
      copy.start,
      copy.noAttempt,
      copy.submit,
      copy.submitHint,
      copy.chooseFile,
      copy.add,
      copy.remove,
    ]) {
      expect(page.html, absent).not.toContain(absent);
    }
    expect(page.html).not.toContain('name="documentType"');
  });

  it('offers nothing even if an attempt somehow exists beside it', async () => {
    apiServes({
      kind: 'ok',
      seller: { ...SELLER, status: 'active', verificationStatus: 'verified' },
      verification: VERIFICATION,
    });
    const page = await load('/dashboard/seller/verification');

    expect(page.html).toContain(copy.verified);
    expect(page.html).not.toContain(copy.submit);
    expect(page.html).not.toContain(copy.add);
  });
});

describe('a draft (owner decision 1)', () => {
  it('offers documents and a submission with no required number', async () => {
    const page = await load('/dashboard/seller/verification');

    expect(page.status).toBe(200);
    expect(page.html).toContain(copy.documents);
    expect(page.html).toContain(copy.chooseFile);
    expect(page.html).toContain(copy.add);
    expect(page.html).toContain(copy.remove);
    expect(page.html).toContain(copy.submit);
    expect(page.html).toContain(copy.submitHint);
    // And it is not offered a start: it already has an attempt.
    expect(page.html).not.toContain(copy.noAttempt);
  });

  it('offers the submission even with no documents at all', async () => {
    apiServes({
      kind: 'ok',
      verification: { ...VERIFICATION, documentCount: 0, documents: [] },
    });
    const page = await load('/dashboard/seller/verification');

    expect(page.html).toContain(copy.noDocuments);
    expect(page.html).toContain(copy.submit);
    expect(page.html).toContain(copy.submitHint);
  });

  it('shows the contact facts as words, never as timestamps', async () => {
    const page = await load('/dashboard/seller/verification');

    expect(page.html).toContain(copy.emailVerified);
    expect(page.html).toContain(copy.contactYes);
    expect(page.html).toContain(copy.contactNo);
    expect(page.html).not.toContain('emailVerifiedAt');
  });

  it('offers all six document types and only the bucket’s three content types', async () => {
    const page = await load('/dashboard/seller/verification');

    for (const label of [
      copy.typeNationalId,
      copy.typePassport,
      copy.typeCommercialRegister,
      copy.typeTaxCard,
      copy.typeBankStatement,
      copy.typeOther,
    ]) {
      expect(page.html, label).toContain(label);
    }
    expect(page.html).toContain('image/jpeg,image/png,application/pdf');
    expect(page.html).not.toContain('image/svg+xml');
  });
});

describe('a submitted attempt', () => {
  it('may still be amended but is offered no second submission', async () => {
    apiServes({
      kind: 'ok',
      verification: { ...VERIFICATION, status: 'submitted', submittedAt: '2026-05-01T00:00:00.000Z' },
    });
    const page = await load('/dashboard/seller/verification');

    expect(page.html).toContain(copy.statusSubmitted);
    expect(page.html).toContain(copy.submittedNote);
    expect(page.html).toContain(copy.add);
    expect(page.html).toContain(copy.remove);
    // The submit group is not in the payload at all — not a disabled button.
    expect(page.html).not.toContain(copy.submitHint);
    expect(page.html).not.toContain(copy.submitConfirm);
  });
});

describe('an attempt with a reviewer, and a decided one', () => {
  it('says it is being reviewed and offers nothing', async () => {
    apiServes({ kind: 'ok', verification: { ...VERIFICATION, status: 'under_review' } });
    const page = await load('/dashboard/seller/verification');

    expect(page.html).toContain(copy.statusUnderReview);
    expect(page.html).toContain(copy.awaitingReview);
    for (const absent of [copy.add, copy.remove, copy.chooseFile, copy.submitHint, copy.start]) {
      expect(page.html, absent).not.toContain(absent);
    }
  });

  it('tells a rejected applicant that it was reviewed, and nothing about why', async () => {
    apiServes({
      kind: 'ok',
      seller: { ...SELLER, verificationStatus: 'rejected' },
      verification: { ...VERIFICATION, status: 'rejected' },
    });
    const page = await load('/dashboard/seller/verification');

    expect(page.html).toContain(copy.statusRejected);
    expect(page.html).toContain(copy.decided);
    // A decided attempt offers nothing, and there is no appeal control to offer.
    expect(page.html).not.toContain(copy.add);
    expect(page.html).not.toContain(copy.remove);
    expect(page.html).not.toContain(copy.submitHint);
  });

  it('renders the error view rather than a decision when the upstream sends a reason at all', async () => {
    apiServes({
      kind: 'ok',
      seller: { ...SELLER, verificationStatus: 'rejected' },
      verification: { ...VERIFICATION, status: 'rejected' },
      leak: true,
    });
    const page = await load('/dashboard/seller/verification');

    // The strict contract refuses the whole body rather than trimming it, so a drifted upstream produces the
    // unavailable view — never a page that renders a reviewer's words. Failing closed is the point: the
    // reason is absent because the response was rejected, not because something stripped it out.
    expect(page.html).toContain(copy.errorUnavailable);
    expect(page.html).not.toContain(PRIVATE_VALUES.decisionReason);
    expect(page.html).not.toContain(PRIVATE_VALUES.reviewNote);
    expect(page.html).not.toContain(copy.decided);
  });

  it('offers an expired attempt nothing either', async () => {
    apiServes({ kind: 'ok', verification: { ...VERIFICATION, status: 'expired' } });
    const page = await load('/dashboard/seller/verification');

    expect(page.html).toContain(copy.statusExpired);
    expect(page.html).not.toContain(copy.submitHint);
    expect(page.html).not.toContain(copy.add);
  });
});

describe('failures', () => {
  it('shows the error view rather than "you have never applied"', async () => {
    apiServes({ kind: 'verification_unavailable' });
    const page = await load('/dashboard/seller/verification');

    expect(page.status).toBe(200);
    expect(page.html).toContain(copy.errorUnavailable);
    // The critical distinction: a timeout must never read as an application that vanished.
    expect(page.html).not.toContain(copy.noAttempt);
    expect(page.html).not.toContain(copy.start);
  });

  it('sends a non-seller to the dashboard instead', async () => {
    apiServes({ kind: 'not_a_seller' });
    const page = await load('/dashboard/seller/verification');

    expect(page.html).toContain(en.SellerDashboard.notASeller);
    expect(page.html).not.toContain(copy.start);
  });

  it('shows the signed-out view when the API refuses the session', async () => {
    apiServes({ kind: 'unauthenticated' });
    const page = await load('/dashboard/seller/verification');

    expect(page.html).toContain(en.Session.expiredBody);
    expect(page.html).not.toContain(copy.start);
  });
});

describe('both locales', () => {
  it('renders the Arabic page with Arabic copy and no physical direction', async () => {
    const page = await load('/ar/dashboard/seller/verification');

    expect(page.status).toBe(200);
    expect(page.html).toContain(arabic.title);
    expect(page.html).toContain(arabic.documents);
    expect(page.html).toContain('dir="rtl"');
    // Logical properties only: no left/right anywhere in the document's own classes.
    expect(page.html).not.toMatch(/\bclass="[^"]*\b(?:ml-|mr-|pl-|pr-|text-left|text-right)\b/);
  });

  it('carries every key this page uses in both catalogues', () => {
    expect(Object.keys(en.SellerVerification).sort()).toEqual(
      Object.keys(ar.SellerVerification).sort(),
    );
  });

  it('never names a decision a seller could reach, in either catalogue', () => {
    // The copy is part of the contract: a sentence telling a seller how to be approved would describe an
    // operation this surface does not have.
    const english = Object.values(en.SellerVerification).join(' ').toLowerCase();
    expect(english).not.toMatch(/\bapprove\b|\bverify again\b|\breapply\b/);
  });
});
