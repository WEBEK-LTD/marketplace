import type { ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startBuiltApp, type RunningApp } from './support/next-server.js';
import { problem, startStubApi, type StubApi } from './support/stub-api.js';

/**
 * The four service request surfaces, over real HTTP against the built app (Phase 7-I).
 *
 * Run against the built app rather than a unit harness for the same reason the other protection tests are:
 * what matters is what actually reaches a browser, **including the streamed RSC payload**. A signed-out
 * visitor must receive none of a brief, and "none" has to mean none of the document.
 *
 * The assertions fall into six groups:
 *
 *   * **who is refused** — a signed-out visitor gets none of any of the four pages, in markup or flight data;
 *   * **the two sides are separate** — the buyer's list reads one operation and the seller's another, neither
 *     address carries a role, and each side's page ships only its own side's words;
 *   * **the validity window and the payment deadline are separate** — labelled differently and never merged;
 *   * **no Phase 8 anywhere** — no payment, checkout, order or cart control is on any page, and an accepted
 *     quote says payment is not open yet;
 *   * **no Option 2** — nothing on any page routes a brief to staff;
 *   * **both languages, the direction that goes with each, and every state**: loading, empty, error,
 *     not-found, lapsed and accepted.
 *
 * No browser, no Playwright, no live provider, no payment provider, no deployment.
 */

const CANARY_CREDENTIAL = 'test-web-requests-canary-credential-notreal';
const ACCESS = '__Host-mp_access=canary-access-token-value-not-a-real-token';
const REFRESH = '__Host-mp_refresh=canary-refresh-token-value-not-a-real-toke';
const SESSION = `${ACCESS}; ${REFRESH}`;
const IDENTITY = { user: { id: '11111111-1111-4111-8111-111111111111', displayName: 'Nadia' } };

const REQUEST = 'd1000000-0000-4000-8000-000000000001';
const QUOTE = 'd1000000-0000-4000-8000-0000000000a1';
const NEXT_CURSOR = 'c3IxfDIwMjYtMDUtMDFUMDk6MDA6MDAuMDAwWnxkMTAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDE';

const REQUEST_TITLE = 'Canary brief for a custom service';
const SERVICE_TITLE = 'Canary quotable service';
const SELLER_NAME = 'Canary Storefront';
const BUYER_NAME = 'Canary Buyer';
const BRIEF = 'Canary brief body, comfortably past ten characters.';
const SCOPE = 'Canary scope of work, also past ten characters.';

const SUMMARY = {
  id: REQUEST,
  status: 'quoted',
  routingMode: 'seller',
  title: REQUEST_TITLE,
  budgetMinor: '400000',
  currencyCode: 'EGP',
  currencyMinorUnit: 2,
  neededBy: '2026-06-01',
  listingSlug: 'canary-quotable-service',
  listingTitle: SERVICE_TITLE,
  counterpartyName: SELLER_NAME,
  quoteCount: 1,
  liveQuoteCount: 1,
  acceptedPaymentDueAt: null,
  closedAt: null,
  createdAt: '2026-05-01T09:00:00.000Z',
};

const SENT_QUOTE = {
  id: QUOTE,
  status: 'sent',
  amountMinor: '380000',
  deliveryDays: 10,
  revisionsIncluded: 2,
  scope: SCOPE,
  isLapsed: false,
  expiresAt: '2026-05-15T09:00:00.000Z',
  respondedAt: null,
  acceptedAt: null,
  paymentDueAt: null,
  createdAt: '2026-05-02T09:00:00.000Z',
};

const ACCEPTED_QUOTE = {
  ...SENT_QUOTE,
  status: 'accepted',
  respondedAt: '2026-05-03T09:00:00.000Z',
  acceptedAt: '2026-05-03T09:00:00.000Z',
  paymentDueAt: '2026-05-05T09:00:00.000Z',
};

const DETAIL = {
  id: REQUEST,
  status: 'quoted',
  routingMode: 'seller',
  isBuyer: true,
  isSeller: false,
  title: REQUEST_TITLE,
  brief: BRIEF,
  budgetMinor: '400000',
  currencyCode: 'EGP',
  currencyMinorUnit: 2,
  neededBy: '2026-06-01',
  listingSlug: 'canary-quotable-service',
  listingTitle: SERVICE_TITLE,
  buyerName: BUYER_NAME,
  sellerSlug: 'canary-storefront',
  sellerName: SELLER_NAME,
  closedAt: null,
  createdAt: '2026-05-01T09:00:00.000Z',
  quotes: [SENT_QUOTE],
};

/** One public service, as `/v1/services/{slug}` answers. `pricingModel` is what the action turns on. */
const SERVICE = {
  id: 'd1000000-0000-4000-8000-0000000000f1',
  slug: 'canary-quotable-service',
  title: SERVICE_TITLE,
  city: 'Cairo',
  priceMinor: null,
  currencyCode: 'EGP',
  currencyMinorUnit: 2,
  pricingModel: 'custom',
  deliveryDays: 5,
  revisionsIncluded: 2,
  description: 'A canary description long enough to be real.',
  contentLanguage: 'en',
  requiresBrief: true,
  scope: 'Canary scope on the public page.',
  availability: 'available',
  category: { slug: 'design', name: 'Design' },
  seller: { slug: 'canary-storefront', displayName: SELLER_NAME },
  attributes: [],
  tags: [],
} as const;

type ListMode = 'ok' | 'empty' | 'fails' | 'paged' | 'accepted' | 'adminOnly';
type DetailMode =
  | 'buyer'
  | 'seller'
  | 'accepted'
  | 'lapsed'
  | 'noQuotes'
  | 'closed'
  | 'missing'
  | 'fails'
  | 'adminOnly'
  | 'adminOnlyClosed';

let api: StubApi;
let app: RunningApp;

beforeAll(async () => {
  api = await startStubApi();
  app = await startBuiltApp({ API_BASE_URL: api.baseUrl, INTERNAL_BFF_CREDENTIAL: CANARY_CREDENTIAL });
}, 240_000);

afterAll(async () => {
  await app.stop();
  await api.stop();
});

function json(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function listFor(mode: ListMode, side: 'made' | 'received'): unknown {
  const base = { ...SUMMARY, counterpartyName: side === 'made' ? SELLER_NAME : BUYER_NAME };
  if (mode === 'empty') return { items: [], nextCursor: null };
  if (mode === 'paged') return { items: [base], nextCursor: NEXT_CURSOR };
  if (mode === 'accepted') {
    return {
      items: [
        { ...base, status: 'accepted', acceptedPaymentDueAt: '2026-05-05T09:00:00.000Z', closedAt: '2026-05-03T09:00:00.000Z' },
      ],
      nextCursor: null,
    };
  }
  if (mode === 'adminOnly') {
    // What the database returns for a brief no seller answers: no listing, no storefront, no quote.
    return {
      items: [
        {
          ...base,
          status: 'open',
          routingMode: 'admin_only',
          listingSlug: null,
          listingTitle: null,
          counterpartyName: null,
          quoteCount: 0,
          liveQuoteCount: 0,
        },
      ],
      nextCursor: null,
    };
  }
  return { items: [base], nextCursor: null };
}

function detailFor(mode: DetailMode): unknown {
  if (mode === 'seller') return { request: { ...DETAIL, isBuyer: false, isSeller: true } };
  if (mode === 'noQuotes') return { request: { ...DETAIL, status: 'open', quotes: [] } };
  if (mode === 'lapsed') {
    return {
      request: {
        ...DETAIL,
        quotes: [{ ...SENT_QUOTE, isLapsed: true, expiresAt: '2026-05-02T09:00:00.000Z' }],
      },
    };
  }
  if (mode === 'accepted') {
    return {
      request: {
        ...DETAIL,
        status: 'accepted',
        closedAt: '2026-05-03T09:00:00.000Z',
        quotes: [ACCEPTED_QUOTE],
      },
    };
  }
  if (mode === 'closed') {
    return { request: { ...DETAIL, status: 'cancelled', closedAt: '2026-05-03T09:00:00.000Z' } };
  }
  if (mode === 'adminOnly' || mode === 'adminOnlyClosed') {
    return {
      request: {
        ...DETAIL,
        status: mode === 'adminOnlyClosed' ? 'declined' : 'open',
        closedAt: mode === 'adminOnlyClosed' ? '2026-05-03T09:00:00.000Z' : null,
        routingMode: 'admin_only',
        listingSlug: null,
        listingTitle: null,
        sellerSlug: null,
        sellerName: null,
        isSeller: false,
        quotes: [],
      },
    };
  }
  return { request: DETAIL };
}

function apiServes(
  modes: { made?: ListMode; received?: ListMode; detail?: DetailMode } = {},
): void {
  const { made = 'ok', received = 'ok', detail = 'buyer' } = modes;
  api.seen.length = 0;
  api.reply((request, response) => {
    const path = request.url.split('?')[0] ?? '';

    if (path === '/v1/users/me') return json(response, IDENTITY);
    if (path === '/v1/messaging/unread-count') return json(response, { unreadCount: 0 });
    if (path === '/v1/notifications/unread-count') return json(response, { unreadCount: 0 });

    if (path === '/v1/service-requests/made') {
      if (made === 'fails') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      return json(response, listFor(made, 'made'));
    }
    if (path === '/v1/service-requests/received') {
      if (received === 'fails') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      return json(response, listFor(received, 'received'));
    }
    if (path === `/v1/service-requests/${REQUEST}`) {
      if (detail === 'missing') return problem(response, 404, 'NOT_FOUND');
      if (detail === 'fails') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      return json(response, detailFor(detail));
    }

    if (path === '/v1/listings') return json(response, { listings: [], nextCursor: null });
    if (path === '/v1/services') return json(response, { services: [], nextCursor: null });
    if (path === '/v1/categories') return json(response, { categories: [] });
    if (path === '/v1/search') return json(response, { results: [], nextCursor: null });
    return problem(response, 404, 'NOT_FOUND');
  });
}

beforeEach(() => {
  apiServes();
});

interface Page {
  readonly status: number;
  readonly html: string;
}

/** `cookie: null` means a signed-out visitor; omitting it means the signed-in session. */
async function load(path: string, cookie: string | null = SESSION): Promise<Page> {
  const response = await fetch(`${app.baseUrl}${path}`, {
    redirect: 'manual',
    headers: cookie === null ? {} : { cookie },
  });
  return { status: response.status, html: await response.text() };
}

const BUYER_LIST = '/dashboard/service-requests';
const BUYER_DETAIL = `${BUYER_LIST}/${REQUEST}`;
const SELLER_LIST = '/dashboard/seller/service-requests';
const SELLER_DETAIL = `${SELLER_LIST}/${REQUEST}`;
const ALL = [BUYER_LIST, BUYER_DETAIL, SELLER_LIST, SELLER_DETAIL];

/** Everything a signed-out response must not contain, in markup or flight data. */
const SECRETS = [REQUEST_TITLE, SERVICE_TITLE, SELLER_NAME, BUYER_NAME, BRIEF, SCOPE];

/* ------------------------------------------------------------------------------------------------ */

describe('who may see a brief', () => {
  it('gives a signed-out visitor none of any of the four pages', async () => {
    apiServes();
    for (const path of ALL) {
      const page = await load(path, null);
      for (const secret of SECRETS) {
        expect(page.html, `${path} ${secret}`).not.toContain(secret);
      }
      expect(page.html, path).not.toContain('380000');
      expect(page.html, path).not.toContain('400000');
    }
  });

  it('never asks the API about a brief on behalf of a signed-out visitor', async () => {
    apiServes();
    for (const path of ALL) await load(path, null);
    for (const request of api.seen) {
      expect(request.url).not.toContain('/v1/service-requests');
    }
  });

  it('leaks no token, credential or internal address into any page', async () => {
    apiServes();
    for (const path of ALL) {
      const page = await load(path);
      expect(page.html, path).not.toContain('canary-access-token-value');
      expect(page.html, path).not.toContain('canary-refresh-token-value');
      expect(page.html, path).not.toContain(CANARY_CREDENTIAL);
      expect(page.html, path).not.toContain('/v1/service-requests');
    }
  });
});

describe('the two sides are separate', () => {
  it('reads the buyer’s briefs from one operation and the seller’s from another', async () => {
    apiServes();
    await load(BUYER_LIST);
    expect(api.seen.some((entry) => entry.url.startsWith('/v1/service-requests/made'))).toBe(true);
    expect(api.seen.some((entry) => entry.url.startsWith('/v1/service-requests/received'))).toBe(false);

    apiServes();
    await load(SELLER_LIST);
    expect(api.seen.some((entry) => entry.url.startsWith('/v1/service-requests/received'))).toBe(true);
    expect(api.seen.some((entry) => entry.url.startsWith('/v1/service-requests/made'))).toBe(false);
  });

  it('sends no role, side or account in any address', async () => {
    apiServes();
    for (const path of ALL) await load(path);
    for (const entry of api.seen.filter((request) => request.url.startsWith('/v1/service-requests'))) {
      expect(entry.url).not.toContain('role');
      expect(entry.url).not.toContain('user');
      expect(entry.url).not.toContain('buyer');
      expect(entry.url).not.toContain('seller=');
      expect(entry.url).not.toContain('side');
    }
  });

  it('ships only the buyer’s words to the buyer’s detail page', async () => {
    apiServes({ detail: 'buyer' });
    const page = await load(BUYER_DETAIL);
    expect(page.html).toContain('Accept quote');
    // The seller's controls and their words are built nowhere in this document.
    expect(page.html).not.toContain('Send a quote');
    expect(page.html).not.toContain('Withdraw quote');
    expect(page.html).not.toContain('Decline this request');
  });

  it('ships only the seller’s words to the seller’s detail page', async () => {
    apiServes({ detail: 'seller' });
    const page = await load(SELLER_DETAIL);
    expect(page.html).toContain('Send a quote');
    expect(page.html).toContain('Decline this request');
    expect(page.html).not.toContain('Accept quote');
    expect(page.html).not.toContain('Cancel this request');
  });

  it('reads the same operation for both detail pages, and lets the API decide the side', async () => {
    apiServes({ detail: 'buyer' });
    await load(BUYER_DETAIL);
    apiServes({ detail: 'seller' });
    await load(SELLER_DETAIL);
    for (const entry of api.seen.filter((request) => request.url.startsWith('/v1/service-requests/'))) {
      expect(entry.url).toBe(`/v1/service-requests/${REQUEST}`);
    }
  });
});

describe('the validity window and the payment deadline stay apart', () => {
  it('labels a live quote’s window and shows no deadline for it', async () => {
    apiServes({ detail: 'buyer' });
    const page = await load(BUYER_DETAIL);
    expect(page.html).toContain('Quote stands until');
    expect(page.html).toContain('2026-05-15 09:00');
    expect(page.html).not.toContain('2026-05-05 09:00');
  });

  it('labels the payment deadline of an accepted quote separately, and says payment is not open yet', async () => {
    apiServes({ detail: 'accepted' });
    const page = await load(BUYER_DETAIL);
    expect(page.html).toContain('Payment due by');
    expect(page.html).toContain('2026-05-05 09:00');
    expect(page.html).toContain('checkout opens');
    // Never the two under one label.
    expect(page.html).not.toContain('Payment stands until');
  });

  it('shows the accepted quote’s deadline on the list, and no window there', async () => {
    apiServes({ made: 'accepted' });
    const page = await load(BUYER_LIST);
    expect(page.html).toContain('Payment due by');
    expect(page.html).not.toContain('Quote stands until');
  });

  it('tells the truth about a lapsed quote without inventing a status', async () => {
    apiServes({ detail: 'lapsed' });
    const page = await load(BUYER_DETAIL);
    expect(page.html).toContain('Deadline passed');
    // A lapsed quote offers no decision, because the database would refuse one.
    expect(page.html).not.toContain('Accept quote');
  });
});

describe('nothing from Phase 8, and nothing for staff', () => {
  it('offers no payment, checkout, cart or order control on any page', async () => {
    for (const modes of [{}, { detail: 'accepted' as DetailMode }, { made: 'accepted' as ListMode }]) {
      apiServes(modes);
      for (const path of ALL) {
        const page = await load(path);
        for (const word of ['Pay now', 'Checkout', 'Add to cart', 'Place order', 'Refund', 'Payout']) {
          expect(page.html, `${path} ${word}`).not.toContain(word);
        }
        expect(page.html, path).not.toContain('/api/checkout');
        expect(page.html, path).not.toContain('/api/orders');
      }
    }
  });

  it('offers nothing that routes a brief to staff', async () => {
    apiServes({ detail: 'seller' });
    for (const path of ALL) {
      const page = await load(path);
      for (const word of ['Send to admin', 'Route to', 'Assign to', 'admin-only', 'Admin only']) {
        expect(page.html, `${path} ${word}`).not.toContain(word);
      }
      expect(page.html, path).not.toContain('/api/admin');
      // D7-08's column and D7-10's keys are schema and permissions only in 7-I: no page names either.
      expect(page.html, path).not.toContain('routingMode');
      expect(page.html, path).not.toContain('routing_mode');
      expect(page.html, path).not.toContain('admin_only');
      expect(page.html, path).not.toContain('service_requests.request.');
    }
  });

  it('leaks no internal address into any page, on either side', async () => {
    // The steps post to this origin's own routes, which the client component builds at run time — so what is
    // asserted here is what must never be in the document: the API's own address, on any of the four pages.
    for (const detail of ['buyer', 'seller'] as const) {
      apiServes({ detail });
      for (const path of ALL) {
        const page = await load(path);
        expect(page.html, path).not.toContain('api.internal');
        expect(page.html, path).not.toContain(api.baseUrl);
        expect(page.html, path).not.toContain('/v1/');
      }
    }
  });
});

describe('every state renders, in both languages', () => {
  it('renders the empty state on both lists', async () => {
    apiServes({ made: 'empty', received: 'empty' });
    expect((await load(BUYER_LIST)).html).toContain('No service requests yet');
    expect((await load(SELLER_LIST)).html).toContain('No service requests yet');
  });

  it('renders the error state and a way back on both lists', async () => {
    apiServes({ made: 'fails', received: 'fails' });
    for (const path of [BUYER_LIST, SELLER_LIST]) {
      const page = await load(path);
      expect(page.html, path).toContain('could not be loaded');
      expect(page.html, path).toContain('Try again');
    }
  });

  it('offers an older page only when there is one', async () => {
    apiServes({ made: 'paged' });
    expect((await load(BUYER_LIST)).html).toContain(`cursor=${NEXT_CURSOR}`);
    apiServes({ made: 'ok' });
    expect((await load(BUYER_LIST)).html).not.toContain('cursor=');
  });

  it('renders the same words for a brief that is absent and one that is not the reader’s', async () => {
    apiServes({ detail: 'missing' });
    for (const path of [BUYER_DETAIL, SELLER_DETAIL]) {
      const page = await load(path);
      expect(page.html, path).toContain('could not be found');
      expect(page.html, path).not.toContain(BRIEF);
    }
  });

  it('renders the error state when a brief could not be read', async () => {
    apiServes({ detail: 'fails' });
    const page = await load(BUYER_DETAIL);
    expect(page.html).toContain('could not be loaded');
  });

  it('says so when a brief has no quote yet, on each side in its own words', async () => {
    apiServes({ detail: 'noQuotes' });
    expect((await load(BUYER_DETAIL)).html).toContain('No quote yet');

    apiServes({ detail: 'seller' });
    api.reply((request, response) => {
      const path = request.url.split('?')[0] ?? '';
      if (path === '/v1/users/me') return json(response, IDENTITY);
      if (path === '/v1/messaging/unread-count') return json(response, { unreadCount: 0 });
      if (path === '/v1/notifications/unread-count') return json(response, { unreadCount: 0 });
      if (path === `/v1/service-requests/${REQUEST}`) {
        return json(response, { request: { ...DETAIL, isBuyer: false, isSeller: true, status: 'open', quotes: [] } });
      }
      return problem(response, 404, 'NOT_FOUND');
    });
    expect((await load(SELLER_DETAIL)).html).toContain('have not sent a quote');
  });

  it('offers no closing step once a brief is closed', async () => {
    apiServes({ detail: 'closed' });
    const page = await load(BUYER_DETAIL);
    expect(page.html).not.toContain('Cancel this request');
    expect(page.html).toContain('Cancelled');
  });

  it('serves Arabic under /ar, right-to-left, on all four pages', async () => {
    apiServes({ detail: 'buyer' });
    for (const path of ALL) {
      const page = await load(`/ar${path}`);
      expect(page.status, path).toBe(200);
      expect(page.html, path).toContain('lang="ar"');
      expect(page.html, path).toContain('dir="rtl"');
      expect(page.html, path).toContain('طلبات الخدمة');
    }
  });

  it('serves English left-to-right on all four pages', async () => {
    apiServes({ detail: 'buyer' });
    for (const path of ALL) {
      const page = await load(path);
      expect(page.status, path).toBe(200);
      expect(page.html, path).toContain('lang="en"');
      expect(page.html, path).toContain('dir="ltr"');
    }
  });

  it('keeps both surfaces out of any search index', async () => {
    apiServes();
    for (const path of ALL) {
      const page = await load(path);
      expect(page.html, path).toContain('noindex');
    }
  });

  it('answers not-found for an address that is not an identifier, without asking the API', async () => {
    apiServes();
    const page = await load(`${BUYER_LIST}/not-a-uuid`);
    expect(page.html).toContain('could not be found');
    for (const entry of api.seen) {
      expect(entry.url).not.toContain('not-a-uuid');
    }
  });
});

describe('the navigation offers both surfaces', () => {
  it('links the buyer’s list from the signed-in navigation', async () => {
    apiServes();
    const page = await load(BUYER_LIST);
    expect(page.html).toContain('/dashboard/service-requests');
  });

  it('links the seller’s inbox from inside the seller shell', async () => {
    apiServes();
    const page = await load(SELLER_LIST);
    expect(page.html).toContain('/dashboard/seller/service-requests');
  });
});

describe('the public service page’s request-a-quote action', () => {
  /** Serves one public service and nothing else. The middleware resolves the slug through the same read. */
  function serviceIs(overrides: Record<string, unknown> = {}): void {
    api.seen.length = 0;
    api.reply((request, response) => {
      const path = request.url.split('?')[0] ?? '';
      if (path === `/v1/services/${SERVICE.slug}`) {
        return json(response, { service: { ...SERVICE, ...overrides } });
      }
      if (path === '/v1/users/me') return json(response, IDENTITY);
      return problem(response, 404, 'NOT_FOUND');
    });
  }

  const PAGE = `/service/${SERVICE.slug}`;

  it('offers it on a custom-priced service that is available', async () => {
    serviceIs();
    const page = await load(PAGE, null);
    expect(page.status).toBe(200);
    expect(page.html).toContain('Request a quote');
  });

  it('offers it to a signed-out visitor without reading a session, so the page stays cacheable', async () => {
    serviceIs();
    await load(PAGE, null);
    for (const entry of api.seen) {
      expect(entry.url).not.toBe('/v1/users/me');
      expect(entry.url).not.toContain('/v1/service-requests');
    }
  });

  it('withholds it from a fixed-price service, which is bought rather than quoted', async () => {
    serviceIs({ pricingModel: 'fixed', priceMinor: '150000' });
    const page = await load(PAGE, null);
    expect(page.status).toBe(200);
    expect(page.html).not.toContain('Request a quote');
  });

  it('withholds it from a service with no pricing model recorded', async () => {
    serviceIs({ pricingModel: null });
    expect((await load(PAGE, null)).html).not.toContain('Request a quote');
  });

  it('withholds it from a service that is no longer available', async () => {
    serviceIs({ availability: 'no_longer_available' });
    expect((await load(PAGE, null)).html).not.toContain('Request a quote');
  });

  it('offers it in Arabic under /ar as well', async () => {
    serviceIs();
    const page = await load(`/ar${PAGE}`, null);
    expect(page.status).toBe(200);
    expect(page.html).toContain('dir="rtl"');
    expect(page.html).toContain('طلب عرض سعر');
  });

  it('carries no checkout, cart or payment control beside it', async () => {
    serviceIs();
    const page = await load(PAGE, null);
    for (const word of ['Add to cart', 'Checkout', 'Pay now', 'Place order']) {
      expect(page.html, word).not.toContain(word);
    }
  });
});

describe('the buyer’s Option 2 surface (Phase 7-J)', () => {
  it('offers one entry point for a brief no seller answers', async () => {
    apiServes();
    const page = await load(BUYER_LIST);
    expect(page.html).toContain('Ask the marketplace team');
  });

  it('asks for no seller, no listing, no currency and no routing choice', async () => {
    apiServes();
    const page = await load(BUYER_LIST);
    for (const forbidden of ['routingMode', 'sellerUserId', 'listingId', 'currencyCode', 'admin_only']) {
      expect(page.html, forbidden).not.toContain(forbidden);
    }
  });

  it('warns against typing a credential into the payment field', async () => {
    apiServes();
    const page = await load(BUYER_LIST);
    expect(page.html).toContain('Do not enter card numbers');
    // And asks for no such thing: the assertion is on the form's own fields, since the warning itself has to
    // name what not to type.
    for (const field of ['cardNumber', 'cvv', 'iban', 'accountNumber', 'password', 'otp', 'token']) {
      expect(page.html, field).not.toContain(`name="${field}"`);
    }
    // The two it does ask for are named in the copy the page ships; the fields themselves are rendered when
    // the form is opened, which is why the assertion above is about what must never be asked for at all.
    expect(page.html).toContain('How you would prefer to pay');
    expect(page.html).toContain('Anything else about paying');
  });

  it('says plainly that no seller is involved and nothing is charged', async () => {
    apiServes();
    const page = await load(BUYER_LIST);
    expect(page.html).toContain('not to a seller');
    expect(page.html).toContain('nothing is charged');
  });

  it('offers it to no signed-out visitor', async () => {
    apiServes();
    const page = await load(BUYER_LIST, null);
    expect(page.html).not.toContain('Ask the marketplace team');
  });

  it('names the marketplace team on an Admin Only row rather than showing an empty seller', async () => {
    apiServes({ made: 'adminOnly' });
    const page = await load(BUYER_LIST);
    expect(page.html).toContain('Handled by the marketplace team');
    expect(page.html).not.toContain('Seller:');
  });

  it('shows no quote count on an Admin Only row, because there will never be one', async () => {
    apiServes({ made: 'adminOnly' });
    const page = await load(BUYER_LIST);
    expect(page.html).not.toContain('No quotes');
    expect(page.html).not.toContain('Quotes');
  });

  it('tells the truth on the detail: no quotes section, and no promise of a seller', async () => {
    apiServes({ detail: 'adminOnly' });
    const page = await load(BUYER_DETAIL);
    expect(page.html).toContain('No seller is involved in this request');
    expect(page.html).not.toContain('No quote yet');
    expect(page.html).not.toContain('the seller will answer');
    expect(page.html).not.toContain('Accept quote');
    expect(page.html).not.toContain('Send a quote');
  });

  it('still lets the buyer cancel their own open Admin Only brief', async () => {
    apiServes({ detail: 'adminOnly' });
    expect((await load(BUYER_DETAIL)).html).toContain('Cancel this request');
  });

  it('offers no closing step once staff have declined it', async () => {
    apiServes({ detail: 'adminOnlyClosed' });
    const page = await load(BUYER_DETAIL);
    expect(page.html).not.toContain('Cancel this request');
    expect(page.html).toContain('Declined');
  });

  it('never shows the buyer a payment field back, nor a staff permission', async () => {
    for (const modes of [{ made: 'adminOnly' as ListMode }, { detail: 'adminOnly' as DetailMode }]) {
      apiServes(modes);
      for (const path of [BUYER_LIST, BUYER_DETAIL]) {
        const page = await load(path);
        expect(page.html, path).not.toContain('preferredPaymentMethod');
        expect(page.html, path).not.toContain('paymentNotes');
        expect(page.html, path).not.toContain('service_requests.payment_info');
        expect(page.html, path).not.toContain('service_requests.request.');
      }
    }
  });

  it('keeps it off the seller’s inbox and the seller’s detail entirely', async () => {
    apiServes({ received: 'empty' });
    const page = await load(SELLER_LIST);
    expect(page.html).toContain('No service requests yet');
    expect(page.html).not.toContain('Handled by the marketplace team');
    // And the seller is never offered the entry point either.
    expect(page.html).not.toContain('Ask the marketplace team');
  });

  it('serves the Option 2 form in Arabic under /ar, right-to-left', async () => {
    apiServes();
    const page = await load(`/ar${BUYER_LIST}`);
    expect(page.status).toBe(200);
    expect(page.html).toContain('dir="rtl"');
    expect(page.html).toContain('اسأل فريق المنصة');
  });

  it('posts it to this origin’s own route and names no admin address', async () => {
    apiServes();
    const page = await load(BUYER_LIST);
    expect(page.html).not.toContain('/v1/admin');
    expect(page.html).not.toContain('api.internal');
  });
});
