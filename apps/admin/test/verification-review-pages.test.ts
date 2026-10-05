import type { ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import arMessages from '../messages/ar.json';
import enMessages from '../messages/en.json';
import { startBuiltApp, type RunningApp } from './support/next-server.js';
import { problem, startStubApi, type StubApi } from './support/stub-api.js';

/**
 * The seller verification review screens, over real HTTP against the built app (Phase 7-G).
 *
 * Run against the built app rather than a unit harness for the reason 7-F's shell test is: what matters
 * is what actually reaches a browser, **including the streamed RSC payload**. A reviewer surface is the
 * sharpest case of that — the thing that must not be in a refused response is somebody's legal name,
 * their phone number and the existence of their identity documents.
 *
 * Five groups of assertions:
 *
 *   * **who is refused**, on the queue and on a submission addressed directly: a guest, a buyer, a
 *     seller, staff at aal1, and a moderator at aal2 who holds `sellers.profile.read` but not
 *     `sellers.verification.review` — the last of which is the case that proves the gate is the
 *     permission and not the section;
 *   * **what is absent from a refusal** — no name, no slug, no document, no filename, no status, no
 *     object path, no permission key, anywhere in the response;
 *   * **what an authorized reviewer sees**, and that the page still has a title when the read behind it
 *     fails;
 *   * **what is never in the markup even when allowed** — no object path, no bucket, no credential;
 *   * **both languages, and the direction that goes with each.**
 *
 * No browser, no Playwright, no live provider, no live storage, no deployment.
 */

const CANARY_CREDENTIAL = 'test-admin-shell-canary-credential-notrea12';

const EN = enMessages;
const AR = arMessages;

const ACCESS = '__Host-mp_admin_access=canary-admin-access-token-not-a-real-token';
const REFRESH = '__Host-mp_admin_refresh=canary-admin-refresh-token-not-a-real-tok';
const SESSION = `${ACCESS}; ${REFRESH}`;

const STAFF_ID = '11111111-1111-4111-8111-111111111111';
const VERIFICATION = 'f0000000-0000-4000-8000-000000000001';
const DOCUMENT = 'a0000000-0000-4000-8000-000000000001';

const OBJECT_PATH = 'verification-documents/rev-shop-one/national_id/2222.jpg';
const SELLER_NAME = 'Canary Storefront';
const SELLER_SLUG = 'canary-storefront';
const LEGAL_NAME = 'Canary Trading LLC';
const CONTACT_PHONE = '+201000000777';
const FILENAME = 'canary-id-front.jpg';

const REVIEW_PERMISSION = 'sellers.verification.review';

/** A moderator: holds the seller *profile* read, and not the verification review. */
const MODERATOR_PERMISSIONS = [
  'catalog.listing.read',
  'moderation.report.read',
  'reviews.review.read',
  'sellers.profile.read',
  'users.profile.read',
];

const REVIEWER_PERMISSIONS = [...MODERATOR_PERMISSIONS, REVIEW_PERMISSION].sort();

const QUEUE_ITEM = {
  id: VERIFICATION,
  status: 'submitted',
  submittedAt: '2026-05-01T09:00:00.000Z',
  createdAt: '2026-05-01T08:00:00.000Z',
  reviewedAt: null,
  emailVerified: true,
  phoneVerified: true,
  documentCount: 1,
  sellerSlug: SELLER_SLUG,
  sellerDisplayName: SELLER_NAME,
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
    slug: SELLER_SLUG,
    displayName: SELLER_NAME,
    legalName: LEGAL_NAME,
    countryCode: 'EG',
    governorate: 'Giza',
    city: 'Dokki',
    contactEmail: 'canary@shops.invalid',
    contactPhone: CONTACT_PHONE,
    status: 'pending',
    verificationStatus: 'pending',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  documents: [
    {
      id: DOCUMENT,
      documentType: 'national_id',
      originalFilename: FILENAME,
      contentType: 'image/jpeg',
      byteSize: '120000',
      status: 'pending',
      uploadedAt: '2026-05-01T08:30:00.000Z',
    },
  ],
};

type Who =
  | { kind: 'staff'; permissions: string[]; locale?: 'en' | 'ar' }
  | { kind: 'staff-aal1' }
  | { kind: 'buyer' }
  | { kind: 'unauthenticated' };

interface Serve {
  readonly who: Who;
  /** What the review operations answer. `ok` serves the canary data. */
  readonly data?: 'ok' | 'notFound' | 'unavailable';
  readonly review?: Record<string, unknown>;
}

let api: StubApi;
let app: RunningApp;

beforeAll(async () => {
  api = await startStubApi();
  app = await startBuiltApp({ API_BASE_URL: api.baseUrl, INTERNAL_BFF_CREDENTIAL: CANARY_CREDENTIAL });
}, 180_000);

afterAll(async () => {
  await app.stop();
  await api.stop();
});

function json(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function apiServes(serve: Serve): void {
  api.seen.length = 0;
  api.reply((request, response) => {
    const [path] = request.url.split('?');
    const who = serve.who;

    if (path === '/v1/admin/session') {
      if (who.kind === 'unauthenticated') return problem(response, 401, 'AUTHENTICATION_REQUIRED');
      const base = { id: STAFF_ID, displayName: 'Nadia', localeCode: who.kind === 'staff' ? (who.locale ?? 'en') : 'en' };
      if (who.kind === 'buyer') {
        return json(response, {
          session: { ...base, isStaff: false, requiresStepUp: false, roles: [], permissions: [] },
        });
      }
      if (who.kind === 'staff-aal1') {
        return json(response, {
          session: { ...base, isStaff: true, requiresStepUp: true, roles: [], permissions: [] },
        });
      }
      return json(response, {
        session: {
          ...base,
          isStaff: true,
          requiresStepUp: false,
          roles: ['admin'],
          permissions: who.permissions,
        },
      });
    }

    if (path?.startsWith('/v1/admin/seller-verifications')) {
      if (serve.data === 'notFound') return problem(response, 404, 'NOT_FOUND');
      if (serve.data === 'unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      if (path === '/v1/admin/seller-verifications') {
        return json(response, { items: [QUEUE_ITEM], nextCursor: null });
      }
      return json(response, { verification: serve.review ?? REVIEW });
    }

    return problem(response, 404, 'NOT_FOUND');
  });
}

async function get(path: string, cookie = SESSION): Promise<{ status: number; html: string }> {
  const response = await fetch(`${app.baseUrl}${path}`, {
    redirect: 'manual',
    headers: cookie === '' ? {} : { cookie },
  });
  return { status: response.status, html: await response.text() };
}

const QUEUE_PATH = '/sellers/verification';
const DETAIL_PATH = `/sellers/verification/${VERIFICATION}`;

/** Everything a refused response must not contain, in markup or in flight data. */
const SECRETS = [SELLER_NAME, SELLER_SLUG, LEGAL_NAME, CONTACT_PHONE, FILENAME, OBJECT_PATH];

/* ------------------------------------------------------------------------------------------------ */

describe('who may reach the reviewer surface', () => {
  it.each([
    ['a visitor with no session', { kind: 'unauthenticated' } as Who, ''],
    ['a buyer', { kind: 'buyer' } as Who, SESSION],
    ['staff who have not reached aal2', { kind: 'staff-aal1' } as Who, SESSION],
    ['a moderator at aal2 without the review permission', { kind: 'staff', permissions: MODERATOR_PERMISSIONS } as Who, SESSION],
  ])('refuses %s, on the queue and on a submission addressed directly', async (_name, who, cookie) => {
    apiServes({ who });

    for (const path of [QUEUE_PATH, DETAIL_PATH]) {
      const { status, html } = await get(path, cookie);
      expect(status, path).toBe(200);

      // Nothing about the application is anywhere in the response — markup or flight data.
      for (const secret of SECRETS) {
        expect(html, `${path} ${secret}`).not.toContain(secret);
      }
      expect(html, path).not.toContain(EN.Verification.approve);
      expect(html, path).not.toContain(EN.Verification.documents);
      expect(html, path).not.toContain(REVIEW_PERMISSION);
      // The verification id is in the address the caller typed, so its presence in the router state is
      // their own input. The document id is not: it is data, and it must be absent.
      expect(html, path).not.toContain(DOCUMENT);
    }
  });

  it('never asks the API for an application on behalf of somebody who may not see one', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR_PERMISSIONS } });
    await get(QUEUE_PATH);
    await get(DETAIL_PATH);

    // The gate refused before its children rendered, so no review operation was ever called.
    expect(api.seen.length).toBeGreaterThan(0);
    for (const request of api.seen) {
      expect(request.url).toBe('/v1/admin/session');
    }
  });

  it('refuses a moderator exactly as it refuses somebody who is not staff at all', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR_PERMISSIONS } });
    const moderator = await get(DETAIL_PATH);
    apiServes({ who: { kind: 'buyer' } });
    const buyer = await get(DETAIL_PATH);

    expect(refusalOf(moderator.html)).toBe(refusalOf(buyer.html));
    expect(moderator.html).toContain(EN.Console.forbiddenTitle);
  });

  it('sends staff at aal1 to the existing challenge rather than refusing them blankly', async () => {
    apiServes({ who: { kind: 'staff-aal1' } });
    const { html } = await get(QUEUE_PATH);
    expect(html).toContain(EN.Console.stepUpTitle);
    expect(html).toContain('href="/security/totp"');
  });
});

describe('what an authorized reviewer sees', () => {
  it('renders the queue', async () => {
    apiServes({ who: { kind: 'staff', permissions: REVIEWER_PERMISSIONS } });
    const { status, html } = await get(QUEUE_PATH);

    expect(status).toBe(200);
    expect(html).toContain(EN.Sections.sellerVerification.title);
    expect(html).toContain(SELLER_NAME);
    expect(html).toContain(SELLER_SLUG);
    expect(html).toContain(EN.Verification.open);
    expect(html).toContain(`href="/sellers/verification/${VERIFICATION}"`);
  });

  it('renders one submission, with the identity a decision is made against', async () => {
    apiServes({ who: { kind: 'staff', permissions: REVIEWER_PERMISSIONS } });
    const { status, html } = await get(DETAIL_PATH);

    expect(status).toBe(200);
    expect(html).toContain(SELLER_NAME);
    expect(html).toContain(LEGAL_NAME);
    expect(html).toContain(CONTACT_PHONE);
    expect(html).toContain(FILENAME);
    expect(html).toContain(EN.Verification.documentType.national_id);
    expect(html).toContain(EN.Verification.approve);
    expect(html).toContain(EN.Verification.reject);
  });

  it('shows no storage location, bucket or credential even when everything is allowed', async () => {
    apiServes({ who: { kind: 'staff', permissions: REVIEWER_PERMISSIONS } });
    const { html } = await get(DETAIL_PATH);

    expect(html).not.toContain(OBJECT_PATH);
    expect(html).not.toContain('verification-documents');
    expect(html).not.toContain(CANARY_CREDENTIAL);
    expect(html).not.toContain('canary-admin-access-token');
  });

  it('offers no approval until both contact checks have passed, and says why', async () => {
    apiServes({
      who: { kind: 'staff', permissions: REVIEWER_PERMISSIONS },
      review: { ...REVIEW, phoneVerified: false },
    });
    const { html } = await get(DETAIL_PATH);

    expect(html).toContain(EN.Verification.contactsBlocked);
    expect(html).toContain(EN.Verification.phoneUnverified);
  });

  it('offers no decision at all on an application that has already been decided', async () => {
    apiServes({
      who: { kind: 'staff', permissions: REVIEWER_PERMISSIONS },
      review: {
        ...REVIEW,
        status: 'rejected',
        decidable: false,
        reviewedAt: '2026-05-02T09:00:00.000Z',
        decisionReason: 'The scan was unreadable.',
      },
    });
    const { html } = await get(DETAIL_PATH);

    expect(html).toContain(EN.Verification.alreadyDecided);
    expect(html).toContain('The scan was unreadable.');
    expect(html).not.toContain(EN.Verification.approve);
    expect(html).not.toContain(EN.Verification.confirmReject);
  });

  it('says so plainly when an application is not available', async () => {
    apiServes({ who: { kind: 'staff', permissions: REVIEWER_PERMISSIONS }, data: 'notFound' });
    const { status, html } = await get(DETAIL_PATH);

    expect(status).toBe(200);
    expect(html).toContain(EN.Verification.notFoundTitle);
    // The page still has its heading, so a reviewer is not left on a bare error.
    expect(html).toContain(EN.Sections.sellerVerification.title);
  });

  it('distinguishes an outage from a refusal, and still renders the page around it', async () => {
    apiServes({ who: { kind: 'staff', permissions: REVIEWER_PERMISSIONS }, data: 'unavailable' });
    const { html } = await get(QUEUE_PATH);

    expect(html).toContain(EN.Console.unavailableTitle);
    expect(html).toContain(EN.Sections.sellerVerification.title);
    expect(html).not.toContain(EN.Verification.emptyTitle);
  });

  it('renders an empty queue as an empty queue, not as a failure', async () => {
    api.seen.length = 0;
    api.reply((request, response) => {
      const [path] = request.url.split('?');
      if (path === '/v1/admin/session') {
        return json(response, {
          session: {
            id: STAFF_ID,
            displayName: 'Nadia',
            localeCode: 'en',
            isStaff: true,
            requiresStepUp: false,
            roles: ['admin'],
            permissions: REVIEWER_PERMISSIONS,
          },
        });
      }
      if (path === '/v1/admin/seller-verifications') {
        return json(response, { items: [], nextCursor: null });
      }
      return problem(response, 404, 'NOT_FOUND');
    });

    const { html } = await get(QUEUE_PATH);
    expect(html).toContain(EN.Verification.emptyTitle);
    expect(html).not.toContain(EN.Console.unavailableTitle);
  });

  it('shows the section in the navigation only to somebody who may open it', async () => {
    apiServes({ who: { kind: 'staff', permissions: REVIEWER_PERMISSIONS } });
    const allowed = await get('/');
    expect(allowed.html).toContain(`href="${QUEUE_PATH}"`);

    apiServes({ who: { kind: 'staff', permissions: MODERATOR_PERMISSIONS } });
    const notAllowed = await get('/');
    expect(notAllowed.html).not.toContain(`href="${QUEUE_PATH}"`);
    expect(notAllowed.html).not.toContain(EN.Sections.sellerVerification.title);
  });
});

describe('the queue filters', () => {
  it('passes a status the console offers to the API', async () => {
    apiServes({ who: { kind: 'staff', permissions: REVIEWER_PERMISSIONS } });
    await get(`${QUEUE_PATH}?status=approved`);

    const queue = api.seen.find((request) => request.url.startsWith('/v1/admin/seller-verifications'));
    expect(queue?.url).toBe('/v1/admin/seller-verifications?status=approved');
  });

  it('drops a status it does not offer rather than forwarding it', async () => {
    apiServes({ who: { kind: 'staff', permissions: REVIEWER_PERMISSIONS } });
    await get(`${QUEUE_PATH}?status=draft`);

    const queue = api.seen.find((request) => request.url.startsWith('/v1/admin/seller-verifications'));
    expect(queue?.url).toBe('/v1/admin/seller-verifications');
  });
});

describe('both languages', () => {
  it('renders the reviewer surface in Arabic, mirrored', async () => {
    apiServes({ who: { kind: 'staff', permissions: REVIEWER_PERMISSIONS, locale: 'ar' } });

    const queue = await get(QUEUE_PATH);
    expect(queue.html).toContain('<html lang="ar" dir="rtl">');
    expect(queue.html).toContain(AR.Sections.sellerVerification.title);
    expect(queue.html).toContain(AR.Verification.open);

    const detail = await get(DETAIL_PATH);
    expect(detail.html).toContain('dir="rtl"');
    expect(detail.html).toContain(AR.Verification.approve);
    expect(detail.html).toContain(AR.Verification.documentType.national_id);
  });

  it('refuses in Arabic too, naming nothing', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR_PERMISSIONS, locale: 'ar' } });
    const { html } = await get(DETAIL_PATH);

    expect(html).toContain('dir="rtl"');
    expect(html).toContain(AR.Console.forbiddenTitle);
    for (const secret of SECRETS) expect(html, secret).not.toContain(secret);
  });

  it('has a message for every key the reviewer screens use, in both languages', () => {
    const en = JSON.stringify(EN.Verification);
    const ar = JSON.stringify(AR.Verification);
    expect(keysOf(EN.Verification)).toEqual(keysOf(AR.Verification));
    expect(en).not.toBe(ar);
  });
});

/* ------------------------------------------------------------------------------------------------ */

/** The refusal's own markup, with the per-request CSP nonce blanked so two responses can be compared. */
function refusalOf(html: string): string {
  const main = html.match(/<main[^>]*>([\s\S]*?)<\/main>/)?.[1] ?? '';
  return main.replaceAll(/nonce="[^"]*"/g, 'nonce=""');
}

function keysOf(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([key, child]) => keysOf(child, prefix === '' ? key : `${prefix}.${key}`))
    .sort();
}
