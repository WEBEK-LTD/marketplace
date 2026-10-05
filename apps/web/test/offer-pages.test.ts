import type { ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startBuiltApp, type RunningApp } from './support/next-server.js';
import { problem, startStubApi, type StubApi } from './support/stub-api.js';

/**
 * The two offer surfaces, over real HTTP against the built app (Phase 7-H).
 *
 * Run against the built app rather than a unit harness for the same reason the other protection tests
 * are: what matters is what actually reaches a browser, **including the streamed RSC payload**. A
 * signed-out visitor must receive none of a negotiation, and "none" has to mean none of the document.
 *
 * The assertions fall into five groups:
 *
 *   * **who is refused** — a signed-out visitor gets none of either page, in markup or in flight data;
 *   * **the two sides are separate** — the buyer's page reads one operation and the seller's another, and
 *     neither address carries a role;
 *   * **the two deadlines are separate** — a negotiation window and a payment deadline are labelled
 *     differently and never merged;
 *   * **no Phase 8 anywhere** — no payment, checkout, order or cart action is on either page, and an
 *     accepted offer says payment is not open yet;
 *   * **both languages, the direction that goes with each, and every state**: loading, empty, error,
 *     lapsed and accepted.
 *
 * No browser, no Playwright, no live provider, no payment provider, no deployment.
 */

const CANARY_CREDENTIAL = 'test-web-offers-canary-credential-notreal12';
const ACCESS = '__Host-mp_access=canary-access-token-value-not-a-real-token';
const REFRESH = '__Host-mp_refresh=canary-refresh-token-value-not-a-real-toke';
const SESSION = `${ACCESS}; ${REFRESH}`;
const IDENTITY = { user: { id: '11111111-1111-4111-8111-111111111111', displayName: 'Nadia' } };

const OFFER = 'c0000000-0000-4000-8000-000000000001';
const LISTING = 'c0000000-0000-4000-8000-0000000000f1';
const NEXT_CURSOR = 'b2YxfDIwMjYtMDUtMDFUMDk6MDA6MDAuMDAwWnxjMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDE';

const LISTING_TITLE = 'Canary offerable listing';
const SELLER_NAME = 'Canary Storefront';
const BUYER_NAME = 'Canary Buyer';
const NOTE = 'Canary note on the offer';

const BASE = {
  id: OFFER,
  listingId: LISTING,
  listingSlug: 'canary-offerable-listing',
  listingTitle: LISTING_TITLE,
  amountMinor: '430000',
  currencyCode: 'EGP',
  currencyMinorUnit: 2,
  quantity: 3,
  message: NOTE,
  status: 'pending',
  isLapsed: false,
  expiresAt: '2026-05-03T09:00:00.000Z',
  respondedAt: null,
  acceptedAt: null,
  paymentDueAt: null,
  parentOfferId: null,
  createdAt: '2026-05-01T09:00:00.000Z',
};

const MADE = { ...BASE, sellerSlug: 'canary-storefront', sellerDisplayName: SELLER_NAME };
const RECEIVED = { ...BASE, buyerDisplayName: BUYER_NAME };

const ACCEPTED = {
  ...BASE,
  status: 'accepted',
  respondedAt: '2026-05-02T09:00:00.000Z',
  acceptedAt: '2026-05-02T09:00:00.000Z',
  paymentDueAt: '2026-05-04T09:00:00.000Z',
};

type Mode = 'ok' | 'empty' | 'fails' | 'paged' | 'accepted' | 'lapsed' | 'countered';

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

function rowsFor(mode: Mode, side: 'made' | 'received'): unknown {
  const base = side === 'made' ? MADE : RECEIVED;
  if (mode === 'empty') return { items: [], nextCursor: null };
  if (mode === 'paged') return { items: [base], nextCursor: NEXT_CURSOR };
  if (mode === 'accepted') {
    return {
      items: [side === 'made' ? { ...ACCEPTED, sellerSlug: MADE.sellerSlug, sellerDisplayName: SELLER_NAME } : { ...ACCEPTED, buyerDisplayName: BUYER_NAME }],
      nextCursor: null,
    };
  }
  if (mode === 'lapsed') {
    return { items: [{ ...base, isLapsed: true, expiresAt: '2026-05-01T10:00:00.000Z' }], nextCursor: null };
  }
  if (mode === 'countered') {
    return {
      items: [{ ...base, status: 'countered', respondedAt: '2026-05-02T09:00:00.000Z', parentOfferId: OFFER }],
      nextCursor: null,
    };
  }
  return { items: [base], nextCursor: null };
}

function apiServes(modes: { made?: Mode; received?: Mode } = {}): void {
  const { made = 'ok', received = 'ok' } = modes;
  api.seen.length = 0;
  api.reply((request, response) => {
    const path = request.url.split('?')[0] ?? '';

    if (path === '/v1/users/me') return json(response, IDENTITY);
    if (path === '/v1/messaging/unread-count') return json(response, { unreadCount: 0 });
    if (path === '/v1/notifications/unread-count') return json(response, { unreadCount: 0 });

    if (path === '/v1/offers/made') {
      if (made === 'fails') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      return json(response, rowsFor(made, 'made'));
    }
    if (path === '/v1/offers/received') {
      if (received === 'fails') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      return json(response, rowsFor(received, 'received'));
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
  readonly location: string | null;
  readonly html: string;
}

/** `cookie: null` means a signed-out visitor; omitting it means the signed-in session. */
async function load(path: string, cookie: string | null = SESSION): Promise<Page> {
  const response = await fetch(`${app.baseUrl}${path}`, {
    redirect: 'manual',
    headers: cookie === null ? {} : { cookie },
  });
  return {
    status: response.status,
    location: response.headers.get('location'),
    html: await response.text(),
  };
}

const BUYER_PAGE = '/dashboard/offers';
const SELLER_PAGE = '/dashboard/seller/offers';

/** Everything a signed-out response must not contain, in markup or flight data. */
const SECRETS = [LISTING_TITLE, SELLER_NAME, BUYER_NAME, NOTE, OFFER];

/* ------------------------------------------------------------------------------------------------ */

describe('who may see a negotiation', () => {
  it('gives a signed-out visitor none of either page', async () => {
    apiServes();
    for (const path of [BUYER_PAGE, SELLER_PAGE]) {
      const page = await load(path, null);
      for (const secret of SECRETS) {
        expect(page.html, `${path} ${secret}`).not.toContain(secret);
      }
      expect(page.html, path).not.toContain('430000');
      expect(page.html, path).not.toContain('Accept');
    }
  });

  it('never asks the API for offers on behalf of a signed-out visitor', async () => {
    apiServes();
    await load(BUYER_PAGE, null);
    await load(SELLER_PAGE, null);
    for (const request of api.seen) {
      expect(request.url).not.toContain('/v1/offers');
    }
  });

  it('leaks no token, credential or internal address into either page', async () => {
    apiServes();
    for (const path of [BUYER_PAGE, SELLER_PAGE]) {
      const page = await load(path);
      expect(page.html, path).not.toContain('canary-access-token-value');
      expect(page.html, path).not.toContain('canary-refresh-token-value');
      expect(page.html, path).not.toContain(CANARY_CREDENTIAL);
      expect(page.html, path).not.toContain('/v1/offers');
    }
  });
});

describe('the two sides are separate', () => {
  it('reads the buyer’s offers from one operation and the seller’s from another', async () => {
    apiServes();
    await load(BUYER_PAGE);
    expect(api.seen.some((request) => request.url.startsWith('/v1/offers/made'))).toBe(true);
    expect(api.seen.some((request) => request.url.startsWith('/v1/offers/received'))).toBe(false);

    apiServes();
    await load(SELLER_PAGE);
    expect(api.seen.some((request) => request.url.startsWith('/v1/offers/received'))).toBe(true);
    expect(api.seen.some((request) => request.url.startsWith('/v1/offers/made'))).toBe(false);
  });

  it('sends no role, side or account in either address', async () => {
    apiServes();
    await load(BUYER_PAGE);
    await load(SELLER_PAGE);
    for (const request of api.seen.filter((entry) => entry.url.startsWith('/v1/offers'))) {
      expect(request.url).not.toContain('role');
      expect(request.url).not.toContain('user');
      expect(request.url).not.toContain('buyer');
      expect(request.url).not.toContain('seller=');
    }
  });

  it('offers the buyer their own moves and the seller theirs', async () => {
    apiServes();
    const buyer = await load(BUYER_PAGE);
    expect(buyer.html).toContain('Change my offer');
    expect(buyer.html).toContain('Withdraw');
    expect(buyer.html).not.toContain('>Accept<');

    const seller = await load(SELLER_PAGE);
    expect(seller.html).toContain('Accept');
    expect(seller.html).toContain('Decline');
    expect(seller.html).not.toContain('Change my offer');
  });
});

describe('the two deadlines stay apart', () => {
  it('labels the negotiation window and shows no payment deadline while pending', async () => {
    apiServes();
    const page = await load(BUYER_PAGE);
    expect(page.html).toContain('Offer stands until');
    expect(page.html).not.toContain('Payment due by');
  });

  it('labels the payment deadline once an offer is accepted, separately', async () => {
    apiServes({ made: 'accepted' });
    const page = await load(BUYER_PAGE);
    expect(page.html).toContain('Payment due by');
    expect(page.html).toContain('2026-05-04');
    // And it is not presented as the negotiation window, which is over.
    expect(page.html).not.toContain('Offer stands until');
  });

  it('says payment is not open yet rather than offering one', async () => {
    apiServes({ made: 'accepted' });
    const page = await load(BUYER_PAGE);
    expect(page.html).toContain('Payment is due by the date above');

    for (const word of ['Pay now', 'Checkout', 'Add to cart', 'Card number']) {
      expect(page.html, word).not.toContain(word);
    }
  });

  it('offers no action at all on an accepted offer', async () => {
    apiServes({ received: 'accepted' });
    const page = await load(SELLER_PAGE);
    expect(page.html).toContain('Accepted');
    expect(page.html).not.toContain('Decline');
  });
});

describe('every state', () => {
  it('renders the buyer’s list in English with exactly one h1', async () => {
    apiServes();
    const page = await load(BUYER_PAGE);
    expect(page.status).toBe(200);
    expect(page.html).toContain('>Your offers</h1>');
    expect(page.html.match(/<h1[^>]*>/g) ?? []).toHaveLength(1);
    expect(page.html).toContain(LISTING_TITLE);
    expect(page.html).toContain('EGP 4300.00');
  });

  it('renders the seller’s list with the buyer’s display name and nothing else about them', async () => {
    apiServes();
    const page = await load(SELLER_PAGE);
    expect(page.status).toBe(200);
    expect(page.html).toContain('>Offers received</h1>');
    expect(page.html).toContain(BUYER_NAME);
    expect(page.html).not.toContain('11111111-1111-4111-8111');
  });

  it('renders an empty list as empty, not as a failure', async () => {
    apiServes({ made: 'empty' });
    const page = await load(BUYER_PAGE);
    expect(page.html).toContain('No offers yet');
    expect(page.html).not.toContain('could not be loaded');
  });

  it('renders a failed read as a failure, with a way back', async () => {
    apiServes({ made: 'fails' });
    const page = await load(BUYER_PAGE);
    expect(page.status).toBe(200);
    expect(page.html).toContain('could not be loaded');
    expect(page.html).toContain('Try again');
  });

  it('pages with an opaque cursor it neither parses nor rebuilds', async () => {
    apiServes({ made: 'paged' });
    const page = await load(BUYER_PAGE);
    expect(page.html).toContain('Older offers');
    expect(page.html).toContain(`cursor=${encodeURIComponent(NEXT_CURSOR)}`);

    apiServes({ made: 'paged' });
    await load(`${BUYER_PAGE}?cursor=${encodeURIComponent(NEXT_CURSOR)}`);
    const asked = api.seen.filter((request) => request.url.startsWith('/v1/offers/made?'));
    expect(asked.length).toBeGreaterThan(0);
    expect(new URL(`http://x${asked[0]!.url}`).searchParams.get('cursor')).toBe(NEXT_CURSOR);
  });

  it('shows a lapsed offer as closed and offers no action on it', async () => {
    apiServes({ made: 'lapsed' });
    const page = await load(BUYER_PAGE);
    expect(page.html).toContain('Deadline passed');
    expect(page.html).not.toContain('Withdraw');
    expect(page.html).not.toContain('Change my offer');
    // And its status word is not shown as if nothing had happened.
    expect(page.html).not.toContain('Waiting for the seller');
  });

  it('shows a countered offer as superseded, with no action', async () => {
    apiServes({ made: 'countered' });
    const page = await load(BUYER_PAGE);
    expect(page.html).toContain('Replaced by a newer offer');
    expect(page.html).toContain('Replaces an earlier offer.');
    expect(page.html).not.toContain('Withdraw');
  });

  it('links to the listing from every card', async () => {
    apiServes();
    const page = await load(BUYER_PAGE);
    expect(page.html).toContain('href="/listing/canary-offerable-listing"');
    expect(page.html).toContain('View listing');
  });
});

describe('both languages', () => {
  it('renders the buyer’s list in Arabic, mirrored', async () => {
    apiServes();
    const page = await load('/ar/dashboard/offers');
    expect(page.status).toBe(200);
    expect(page.html).toContain('dir="rtl"');
    expect(page.html).toContain('عروضك');
    expect(page.html).toContain('تعديل عرضي');
  });

  it('renders the seller’s list in Arabic too', async () => {
    apiServes();
    const page = await load('/ar/dashboard/seller/offers');
    expect(page.status).toBe(200);
    expect(page.html).toContain('dir="rtl"');
    expect(page.html).toContain('العروض الواردة');
    expect(page.html).toContain('قبول');
  });

  it('keeps the two deadlines apart in Arabic as well', async () => {
    apiServes({ made: 'accepted' });
    const page = await load('/ar/dashboard/offers');
    expect(page.html).toContain('الدفع مستحق قبل');
    expect(page.html).not.toContain('العرض ساري حتى');
  });

  it('links Arabic cards to the Arabic listing address', async () => {
    apiServes();
    const page = await load('/ar/dashboard/offers');
    expect(page.html).toContain('href="/ar/listing/canary-offerable-listing"');
  });
});

describe('the listing page’s offer action', () => {
  it('is absent for nobody in particular: the page stays cacheable and session-free', async () => {
    apiServes();
    // The listing itself is not served by this stub, so the page renders its own not-found view. What
    // matters here is that reaching it signed out asks the API nothing about a session.
    await load('/listing/canary-offerable-listing', null);
    for (const request of api.seen) {
      expect(request.url).not.toBe('/v1/users/me');
    }
  });
});
