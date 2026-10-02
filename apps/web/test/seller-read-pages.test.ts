import type { ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import ar from '../messages/ar.json';
import en from '../messages/en.json';
import { startBuiltApp, type RunningApp } from './support/next-server.js';
import { problem, startStubApi, type StubApi } from './support/stub-api.js';

/**
 * The five read-only seller surfaces, over real HTTP against the built app (Phase 6-J).
 *
 * What these pages owe, and what the assertions are about:
 *
 * **They are read-only, and the document proves it.** No form, no button, no mutation copy: the assertions
 * look for the words a write control would need — refund, cancel, withdraw, moderate, delete — and find none.
 *
 * **There is no client component anywhere in 6-J**, so nothing crosses an RSC boundary at all. The assertions
 * check that the private values the stub API offers appear nowhere in the document, flight data included,
 * because that payload is the whole of what a browser receives.
 *
 * **A failure is not an empty shop.** An unavailable API gets the error view on every surface, never "you
 * have no orders" — which would tell somebody their business had vanished because a request timed out.
 *
 * **Money is displayed through `@repo/money` at the currency's own minor unit**, so `106000` at two decimal
 * places reads as `1060.00` and nothing is converted by hand.
 *
 * **The rating average stays the view's number**, shown as stars without the stored basis points being
 * rewritten.
 *
 * **Both locales, and no physical direction anywhere.**
 *
 * No browser, no Playwright, no live provider, no deployment.
 */

// Exactly 43 base64url characters, or the web app's env validation refuses it at startup.
const CANARY_CREDENTIAL = 'test-web-read-pages-canary-not-real-xxxxxxx';
const ACCESS = '__Host-mp_access=canary-access-token-value-not-a-real-token';
const REFRESH = '__Host-mp_refresh=canary-refresh-token-value-not-a-real-toke';
const SESSION = `${ACCESS}; ${REFRESH}`;
const USER_ID = '11111111-1111-4111-8111-111111111111';
const IDENTITY = { user: { id: USER_ID, displayName: 'Nadia' } };

const SELLER = {
  slug: 'read-shop',
  displayName: 'Read Shop',
  status: 'active',
  verificationStatus: 'verified',
  city: 'Cairo',
  countryCode: 'EG',
};

const ORDER = {
  orderNumber: 'MP-26-001001',
  orderType: 'product',
  status: 'completed',
  currencyCode: 'EGP',
  currencyDecimalPlaces: 2,
  subtotalMinor: '100000',
  shippingTotalMinor: '5000',
  taxTotalMinor: '2000',
  discountTotalMinor: '1000',
  commissionTotalMinor: '8000',
  grandTotalMinor: '106000',
  sellerNetMinor: '98000',
  itemCount: 1,
  placedAt: '2026-05-01T10:00:00.000Z',
  paidAt: '2026-05-01T10:05:00.000Z',
  shippedAt: null,
  deliveredAt: null,
  completedAt: '2026-05-08T10:00:00.000Z',
  cancelledAt: null,
  items: [
    {
      title: 'Title As Purchased',
      slug: 'a-listing',
      listingTypeCode: 'product',
      quantity: 2,
      cancelledQuantity: 0,
      unitPriceMinor: '50000',
      lineTotalMinor: '101000',
    },
  ],
};

const REVIEW = {
  orderNumber: 'MP-26-001001',
  rating: 5,
  title: 'Great work',
  body: 'Very good seller.',
  status: 'hidden',
  publishedAt: '2026-05-10T10:00:00.000Z',
  createdAt: '2026-05-09T10:00:00.000Z',
  replyBody: 'Thank you very much.',
  replyStatus: 'published',
  replyCreatedAt: '2026-05-11T10:00:00.000Z',
};

const SUMMARY = {
  reviewCount: 3,
  averageRatingBasisPoints: 46_667,
  fiveStarCount: 2,
  fourStarCount: 1,
  threeStarCount: 0,
  twoStarCount: 0,
  oneStarCount: 0,
  latestReviewAt: '2026-05-10T10:00:00.000Z',
};

const BALANCE = {
  currencyCode: 'EGP',
  currencyDecimalPlaces: 2,
  pendingMinor: '12000',
  availableMinor: '98000',
  reservedMinor: '3000',
  updatedAt: '2026-05-01T10:00:00.000Z',
};

const PROMOTION = {
  listingSlug: 'a-listing',
  listingTitle: 'A Promoted Listing',
  status: 'active',
  currencyCode: 'EGP',
  currencyDecimalPlaces: 2,
  priceMinor: '25000',
  refundedAmountMinor: '0',
  priority: 10,
  durationDays: 7,
  startsAt: '2026-05-01T00:00:00.000Z',
  endsAt: '2026-05-08T00:00:00.000Z',
  activatedAt: '2026-05-01T00:00:00.000Z',
  pausedAt: null,
  expiredAt: null,
  cancelledAt: null,
  createdAt: '2026-04-30T00:00:00.000Z',
};

const PERFORMANCE = {
  listingSlug: 'a-listing',
  listingTitle: 'A Promoted Listing',
  status: 'active',
  firstDay: '2026-05-01',
  lastDay: '2026-05-02',
  impressions: '2500',
  views: '450',
  clicks: '75',
};

/**
 * Values no 6-J contract carries. The stub offers them on every surface; none may reach the document.
 *
 * These are the exact classes the owner named: seller uuids, order internal ids, ledger account ids, payout
 * ids, reviewer ids and private financial fields.
 */
const PRIVATE_VALUES = {
  sellerUserId: USER_ID,
  buyerUserId: '88888888-8888-4888-8888-888888888888',
  orderId: '77777777-7777-4777-8777-777777777777',
  checkoutId: '66666666-6666-4666-8666-666666666666',
  commissionSnapshot: 'COMMISSION-SNAPSHOT-SECRET',
  cancellationPolicySnapshot: 'POLICY-SNAPSHOT-SECRET',
  moderationReason: 'MODERATION-REASON-SECRET',
  moderatedBy: '55555555-5555-4555-8555-555555555555',
  autoHiddenReason: 'AUTO-HIDDEN-SECRET',
  ledgerAccountId: 'LEDGER-ACCOUNT-SECRET',
  journalId: 'JOURNAL-SECRET',
  payoutId: 'PAYOUT-ID-SECRET',
  providerPayoutRef: 'PROVIDER-PAYOUT-SECRET',
  destinationMaskedSnapshot: 'DESTINATION-SNAPSHOT-SECRET',
  packageSnapshot: 'PACKAGE-SNAPSHOT-SECRET',
  idempotencyKey: 'IDEMPOTENCY-SECRET',
  promotionId: '44444444-4444-4444-8444-444444444444',
} as const;

type Mode =
  | { readonly kind: 'ok'; readonly leak?: boolean; readonly empty?: boolean }
  | { readonly kind: 'not_a_seller' }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'unavailable' };

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
      return json(response, { seller: SELLER });
    }

    const READ_PATHS = new Set([
      '/v1/sellers/me/orders',
      '/v1/sellers/me/reviews',
      '/v1/sellers/me/earnings',
      '/v1/sellers/me/promotions',
      '/v1/sellers/me/analytics',
    ]);
    if (READ_PATHS.has(path)) {
      if (mode.kind === 'not_a_seller') return problem(response, 404, 'NOT_FOUND');
      if (mode.kind === 'unauthenticated') return problem(response, 401, 'AUTHENTICATION_REQUIRED');
      if (mode.kind === 'unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');

      const leak = mode.leak === true ? PRIVATE_VALUES : {};
      const empty = mode.empty === true;
      if (path === '/v1/sellers/me/orders') {
        return json(response, {
          orders: empty ? [] : [{ ...ORDER, ...leak, items: [{ ...ORDER.items[0], ...leak }] }],
          nextCursor: null,
        });
      }
      if (path === '/v1/sellers/me/reviews') {
        return json(response, {
          summary: empty ? null : { ...SUMMARY, ...leak },
          reviews: empty ? [] : [{ ...REVIEW, ...leak }],
          nextCursor: null,
        });
      }
      if (path === '/v1/sellers/me/earnings') {
        return json(response, { balances: empty ? [] : [{ ...BALANCE, ...leak }] });
      }
      if (path === '/v1/sellers/me/promotions') {
        return json(response, {
          promotions: empty ? [] : [{ ...PROMOTION, ...leak }],
          nextCursor: null,
        });
      }
      return json(response, {
        days: 30,
        promotions: empty ? [] : [{ ...PERFORMANCE, ...leak }],
      });
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

const SURFACES = ['orders', 'reviews', 'earnings', 'promotions', 'analytics'] as const;
const NAMESPACE = {
  orders: en.SellerOrders,
  reviews: en.SellerReviews,
  earnings: en.SellerEarnings,
  promotions: en.SellerPromotions,
  analytics: en.SellerAnalytics,
} as const;

describe('protection', () => {
  it('redirects a signed-out visitor into the existing login flow, on every surface', async () => {
    for (const surface of SURFACES) {
      const page = await load(`/dashboard/seller/${surface}`, null);
      expect(page.status, surface).toBe(307);
      expect(page.location, surface).toContain('/login');
      expect(page.robotsHeader, surface).toBe('noindex');
    }
  });

  it('redirects to the Arabic sign-in under /ar', async () => {
    const page = await load('/ar/dashboard/seller/earnings', null);
    expect(page.status).toBe(307);
    expect(page.location).toContain('/ar/login');
  });

  it('gives a signed-out visitor no data at all, payload included', async () => {
    for (const surface of SURFACES) {
      const page = await load(`/dashboard/seller/${surface}`, null);
      for (const absent of ['MP-26-001001', '1060.00', '980.00', 'A Promoted Listing', '2500']) {
        expect(page.html, `${surface} ${absent}`).not.toContain(absent);
      }
    }
  });
});

describe('what never reaches the payload', () => {
  it('ships no identifier, snapshot, moderation field, ledger or payout value on any surface', async () => {
    apiServes({ kind: 'ok', leak: true });
    for (const surface of SURFACES) {
      const page = await load(`/dashboard/seller/${surface}`);
      expect(page.status, surface).toBe(200);
      for (const [name, value] of Object.entries(PRIVATE_VALUES)) {
        expect(page.html, `${surface} ${name}`).not.toContain(value);
      }
      for (const key of [
        'sellerUserId',
        'buyerUserId',
        'commissionSnapshot',
        'moderationReason',
        'ledgerAccountId',
        'providerPayoutRef',
        'idempotencyKey',
        'packageSnapshot',
      ]) {
        expect(page.html, `${surface} ${key}`).not.toContain(key);
      }
    }
  });

  it('ships no session token and no internal address', async () => {
    for (const surface of SURFACES) {
      const page = await load(`/dashboard/seller/${surface}`);
      expect(page.html, surface).not.toContain('canary-access-token');
      expect(page.html, surface).not.toContain('canary-refresh-token');
      expect(page.html, surface).not.toContain(CANARY_CREDENTIAL);
      expect(page.html, surface).not.toContain(api.baseUrl);
    }
  });
});

describe('the surfaces are read-only', () => {
  it('renders no form and no mutation control anywhere', async () => {
    for (const surface of SURFACES) {
      const page = await load(`/dashboard/seller/${surface}`);
      // Nothing to submit, nothing to click, nothing to type: these pages only display.
      expect(page.html, surface).not.toContain('<form');
      expect(page.html, surface).not.toContain('<button');
      expect(page.html, surface).not.toContain('<input');
      expect(page.html, surface).not.toContain('<select');
      expect(page.html, surface).not.toContain('<textarea');
    }
  });

  it('ships no copy for an action the surface cannot perform', async () => {
    for (const surface of SURFACES) {
      const page = await load(`/dashboard/seller/${surface}`);
      // The earnings page states that withdrawals are *not* available, which is the opposite of offering one.
      // That one denial is removed before the scan so the assertion tests offers rather than the word.
      const lowered = page.html
        .toLowerCase()
        .replaceAll(en.SellerEarnings.note.toLowerCase(), '')
        .replaceAll(ar.SellerEarnings.note, '');
      for (const forbidden of [
        'refund this',
        'change status',
        'mark as shipped',
        'cancel order',
        'withdraw',
        'request payout',
        'moderate',
        'delete review',
        'hide review',
        'promote listing',
        'cancel promotion',
      ]) {
        expect(lowered, `${surface} ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('says plainly that withdrawals are not available, rather than leaving somebody hunting', async () => {
    const page = await load('/dashboard/seller/earnings');
    expect(page.html).toContain(en.SellerEarnings.note);
  });
});

describe('orders', () => {
  it('shows the order, its money through the money package, and the purchased title', async () => {
    const page = await load('/dashboard/seller/orders');
    expect(page.status).toBe(200);
    expect(page.html).toContain('MP-26-001001');
    // 106000 minor units at two decimal places. Nothing is converted by hand.
    expect(page.html).toContain('EGP 1060.00');
    expect(page.html).toContain('EGP 980.00');
    expect(page.html).toContain('EGP 80.00');
    expect(page.html).toContain('Title As Purchased');
    expect(page.html).toContain(en.SellerOrders.sellerNet);
    expect(page.html).toContain(en.SellerOrders.commission);
  });

  it('labels the status rather than printing the database value', async () => {
    const page = await load('/dashboard/seller/orders');
    expect(page.html).toContain(en.SellerOrders.statusCompleted);
    expect(page.html).not.toContain('pending_payment');
    expect(page.html).not.toContain('refund_requested');
  });

  it('shows an honest empty state, and no invented order', async () => {
    apiServes({ kind: 'ok', empty: true });
    const page = await load('/dashboard/seller/orders');
    expect(page.html).toContain(en.SellerOrders.empty);
    expect(page.html).not.toContain('MP-26-001001');
    expect(page.html).not.toContain('EGP 1060.00');
  });
});

describe('reviews', () => {
  it('shows the review, its state, and the seller’s own reply', async () => {
    const page = await load('/dashboard/seller/reviews');
    expect(page.status).toBe(200);
    expect(page.html).toContain('Great work');
    expect(page.html).toContain('Very good seller.');
    // A seller sees their own hidden review, because it is a fact about their storefront.
    expect(page.html).toContain(en.SellerReviews.statusHidden);
    expect(page.html).toContain('Thank you very much.');
  });

  it('shows the view’s average as stars without rewriting the stored number', async () => {
    const page = await load('/dashboard/seller/reviews');
    // 46667 basis points is 4.67 stars. The basis points themselves are not rendered.
    expect(page.html).toContain('4.67');
    expect(page.html).not.toContain('46667');
    expect(page.html).toContain(en.SellerReviews.summaryNote);
  });

  it('says there is no rating rather than showing zero', async () => {
    apiServes({ kind: 'ok', empty: true });
    const page = await load('/dashboard/seller/reviews');
    expect(page.html).toContain(en.SellerReviews.noSummary);
    expect(page.html).toContain(en.SellerReviews.empty);
    expect(page.html).not.toContain('0.00');
  });
});

describe('earnings', () => {
  it('shows the three balances through the money package and computes no total', async () => {
    const page = await load('/dashboard/seller/earnings');
    expect(page.status).toBe(200);
    expect(page.html).toContain('EGP 980.00');
    expect(page.html).toContain('EGP 120.00');
    expect(page.html).toContain('EGP 30.00');
    for (const label of [
      en.SellerEarnings.available,
      en.SellerEarnings.pending,
      en.SellerEarnings.reserved,
    ]) {
      expect(page.html, label).toContain(label);
    }
    // 12000 + 98000 + 3000 would be 1130.00. No such figure is on the page.
    expect(page.html).not.toContain('EGP 1130.00');
  });

  it('shows an honest empty state', async () => {
    apiServes({ kind: 'ok', empty: true });
    const page = await load('/dashboard/seller/earnings');
    expect(page.html).toContain(en.SellerEarnings.empty);
    expect(page.html).not.toContain('EGP 980.00');
  });
});

describe('promotions', () => {
  it('shows the promotion, named by its listing, with its price and status', async () => {
    const page = await load('/dashboard/seller/promotions');
    expect(page.status).toBe(200);
    expect(page.html).toContain('A Promoted Listing');
    expect(page.html).toContain('EGP 250.00');
    expect(page.html).toContain(en.SellerPromotions.statusActive);
  });

  it('shows an honest empty state', async () => {
    apiServes({ kind: 'ok', empty: true });
    const page = await load('/dashboard/seller/promotions');
    expect(page.html).toContain(en.SellerPromotions.empty);
  });
});

describe('analytics', () => {
  it('shows the rollup’s three totals and no derived metric', async () => {
    const page = await load('/dashboard/seller/analytics');
    expect(page.status).toBe(200);
    expect(page.html).toContain('2500');
    expect(page.html).toContain('450');
    expect(page.html).toContain('75');
    for (const label of [
      en.SellerAnalytics.impressions,
      en.SellerAnalytics.views,
      en.SellerAnalytics.clicks,
    ]) {
      expect(page.html, label).toContain(label);
    }
    // 75/2500 is 3%. No rate, ratio or percentage is anywhere on the page.
    expect(page.html).not.toContain('3%');
    expect(page.html.toLowerCase()).not.toContain('click-through');
    expect(page.html.toLowerCase()).not.toContain('conversion');
  });

  it('says plainly that per-listing analytics is not available yet', async () => {
    const page = await load('/dashboard/seller/analytics');
    // A truthful sentence rather than a fabricated chart.
    expect(page.html).toContain(en.SellerAnalytics.listingNote);
  });

  it('reports the window the server resolved', async () => {
    const page = await load('/dashboard/seller/analytics');
    expect(page.html).toContain('30');
  });

  it('shows an honest empty state', async () => {
    apiServes({ kind: 'ok', empty: true });
    const page = await load('/dashboard/seller/analytics');
    expect(page.html).toContain(en.SellerAnalytics.empty);
    expect(page.html).not.toContain('2500');
  });
});

describe('failures', () => {
  it('shows the error view rather than an empty list, on every surface', async () => {
    apiServes({ kind: 'unavailable' });
    for (const surface of SURFACES) {
      const page = await load(`/dashboard/seller/${surface}`);
      expect(page.status, surface).toBe(200);
      expect(page.html, surface).toContain(NAMESPACE[surface].errorUnavailable);
      // The critical distinction: a timeout must never read as "you have none of these".
      expect(page.html, surface).not.toContain(NAMESPACE[surface].empty);
    }
  });

  it('sends a non-seller to the dashboard instead', async () => {
    apiServes({ kind: 'not_a_seller' });
    for (const surface of SURFACES) {
      const page = await load(`/dashboard/seller/${surface}`);
      expect(page.html, surface).toContain(en.SellerDashboard.notASeller);
      expect(page.html, surface).not.toContain(NAMESPACE[surface].empty);
    }
  });

  it('shows the signed-out view when the API refuses the session', async () => {
    apiServes({ kind: 'unauthenticated' });
    for (const surface of SURFACES) {
      const page = await load(`/dashboard/seller/${surface}`);
      expect(page.html, surface).toContain(en.Session.expiredBody);
    }
  });
});

describe('both locales', () => {
  it('renders every Arabic surface with Arabic copy and no physical direction', async () => {
    const arabic = {
      orders: ar.SellerOrders,
      reviews: ar.SellerReviews,
      earnings: ar.SellerEarnings,
      promotions: ar.SellerPromotions,
      analytics: ar.SellerAnalytics,
    } as const;
    for (const surface of SURFACES) {
      const page = await load(`/ar/dashboard/seller/${surface}`);
      expect(page.status, surface).toBe(200);
      expect(page.html, surface).toContain(arabic[surface].title);
      expect(page.html, surface).toContain('dir="rtl"');
      // Logical properties only: no left/right in any of the document's own classes.
      expect(page.html, surface).not.toMatch(
        /\bclass="[^"]*\b(?:ml-|mr-|pl-|pr-|text-left|text-right)\b/,
      );
    }
  });

  it('carries every key these pages use in both catalogues', () => {
    for (const namespace of [
      'SellerOrders',
      'SellerReviews',
      'SellerEarnings',
      'SellerPromotions',
      'SellerAnalytics',
    ] as const) {
      expect(Object.keys(en[namespace]).sort(), namespace).toEqual(
        Object.keys(ar[namespace]).sort(),
      );
    }
  });

  it('never names an action a seller cannot take, in either catalogue', () => {
    for (const namespace of [
      'SellerOrders',
      'SellerReviews',
      'SellerEarnings',
      'SellerPromotions',
      'SellerAnalytics',
    ] as const) {
      const prose = Object.values(en[namespace]).join(' ').toLowerCase();
      // "Withdrawals are not available" is the one permitted mention, and it is a denial.
      const withoutDenials = prose.replace('withdrawals are not available on this page.', '');
      for (const verb of ['refund this', 'moderate', 'cancel this order', 'change the status']) {
        expect(withoutDenials, `${namespace} ${verb}`).not.toContain(verb);
      }
    }
  });
});
