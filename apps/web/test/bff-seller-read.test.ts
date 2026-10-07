import { describe, expect, it } from 'vitest';
import {
  handleSellerAnalytics,
  handleSellerEarnings,
  handleSellerListingAnalytics,
  handleSellerOrders,
  handleSellerPromotions,
  handleSellerReviews,
  readSellerAnalytics,
  readSellerEarnings,
  readSellerListingAnalytics,
  readSellerOrders,
  readSellerPromotions,
  readSellerReviews,
} from '../src/server/bff/seller-read';
import { SESSION_COOKIES } from '../src/server/bff/session-cookies';

/**
 * The five read-only seller routes at the BFF boundary (Phase 6-J).
 *
 * The properties this boundary owes the browser:
 *
 *   * the session leaves as one header on one internal hop, and the browser's `Cookie` is never forwarded;
 *   * every response is rebuilt from the **validated** contract fields, so a commission snapshot, moderation
 *     reason, ledger account or payout reference an upstream offered has no route through this layer;
 *   * nothing is cached: a balance, an order and a review are private to one seller;
 *   * there is **no write handler at all** — the module exports five readers and five GET handlers, and
 *     nothing else;
 *   * `unavailable` is never conflated with empty, because a failing read must not read as "you have none";
 *   * the page size and the analytics window are clamped here as well as upstream, so a hand-edited URL costs
 *     nothing.
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
  paidAt: null,
  shippedAt: null,
  deliveredAt: null,
  completedAt: null,
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
  title: 'Great',
  body: 'Very good seller.',
  status: 'published',
  publishedAt: '2026-05-10T10:00:00.000Z',
  createdAt: '2026-05-09T10:00:00.000Z',
  replyBody: null,
  replyStatus: null,
  replyCreatedAt: null,
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
  listingTitle: 'A Listing',
  status: 'active',
  currencyCode: 'EGP',
  currencyDecimalPlaces: 2,
  priceMinor: '25000',
  refundedAmountMinor: '0',
  priority: 10,
  durationDays: 7,
  startsAt: null,
  endsAt: null,
  activatedAt: null,
  pausedAt: null,
  expiredAt: null,
  cancelledAt: null,
  createdAt: '2026-04-30T00:00:00.000Z',
};

const PERFORMANCE = {
  listingSlug: 'a-listing',
  listingTitle: 'A Listing',
  status: 'active',
  firstDay: '2026-05-01',
  lastDay: '2026-05-02',
  impressions: '2500',
  views: '450',
  clicks: '75',
};

/** 0102's rollup totals. Counts, not money: no currency and no minor unit anywhere in the shape. */
const LISTING_PERFORMANCE = {
  listingSlug: 'a-chair',
  listingTitle: 'A Chair',
  listingStatus: 'active',
  firstDay: '2026-05-03',
  lastDay: '2026-05-04',
  clicks: '4294967296',
  contacts: '17',
  favorites: '0',
  shares: '0',
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

function read(path: string): Request {
  return new Request(`https://web.test${path}`, {
    method: 'GET',
    headers: { origin: 'https://web.test', cookie: COOKIE },
  });
}

const problem = (code: string, status: number) => ({
  code,
  status,
  title: 'Problem',
  detail: 'x',
});

/** Each surface: its handler, its page reader, the upstream path, and a successful payload. */
const SURFACES = [
  {
    name: 'orders',
    handler: handleSellerOrders,
    reader: readSellerOrders,
    local: '/api/sellers/me/orders',
    remote: '/v1/sellers/me/orders',
    payload: { orders: [ORDER], nextCursor: null },
    paged: true,
  },
  {
    name: 'reviews',
    handler: handleSellerReviews,
    reader: readSellerReviews,
    local: '/api/sellers/me/reviews',
    remote: '/v1/sellers/me/reviews',
    payload: { summary: SUMMARY, reviews: [REVIEW], nextCursor: null },
    paged: true,
  },
  {
    name: 'earnings',
    handler: handleSellerEarnings,
    reader: readSellerEarnings,
    local: '/api/sellers/me/earnings',
    remote: '/v1/sellers/me/earnings',
    payload: { balances: [BALANCE] },
    paged: false,
  },
  {
    name: 'promotions',
    handler: handleSellerPromotions,
    reader: readSellerPromotions,
    local: '/api/sellers/me/promotions',
    remote: '/v1/sellers/me/promotions',
    payload: { promotions: [PROMOTION], nextCursor: null },
    paged: true,
  },
  {
    name: 'analytics',
    handler: handleSellerAnalytics,
    reader: readSellerAnalytics,
    local: '/api/sellers/me/analytics',
    remote: '/v1/sellers/me/analytics',
    payload: { days: 30, promotions: [PERFORMANCE] },
    paged: false,
  },
  {
    name: 'listing analytics',
    handler: handleSellerListingAnalytics,
    reader: readSellerListingAnalytics,
    local: '/api/sellers/me/listing-analytics',
    remote: '/v1/sellers/me/listing-analytics',
    payload: { days: 30, listings: [LISTING_PERFORMANCE] },
    paged: false,
  },
] as const;

describe('every surface, at the boundary', () => {
  it('makes one credentialled internal hop carrying the session, and forwards no cookie', async () => {
    for (const surface of SURFACES) {
      const seen: Seen[] = [];
      const response = await surface.handler(read(surface.local), {
        env: ENV,
        fetch: upstream(200, surface.payload, seen),
      });

      expect(response.status, surface.name).toBe(200);
      expect(seen, surface.name).toHaveLength(1);
      expect(seen[0]?.url.startsWith(`${ENV.API_BASE_URL}${surface.remote}`), surface.name).toBe(true);
      expect(seen[0]?.method, surface.name).toBe('GET');
      expect(seen[0]?.headers.get('x-session-token'), surface.name).toBe(ACCESS_TOKEN);
      expect(seen[0]?.headers.get('cookie'), surface.name).toBeNull();
      // A GET with no body: there is nothing for one to carry.
      expect(seen[0]?.body, surface.name).toBeUndefined();
      expect(await response.text(), surface.name).not.toContain(REFRESH_TOKEN);
    }
  });

  it('is never cached', async () => {
    for (const surface of SURFACES) {
      const response = await surface.handler(read(surface.local), {
        env: ENV,
        fetch: upstream(200, surface.payload, []),
      });
      expect(response.headers.get('cache-control'), surface.name).toBe('no-store');
    }
  });

  it('refuses without a session and never asks upstream', async () => {
    for (const surface of SURFACES) {
      const seen: Seen[] = [];
      const response = await surface.handler(
        new Request(`https://web.test${surface.local}`, { method: 'GET' }),
        { env: ENV, fetch: upstream(200, surface.payload, seen) },
      );
      expect(response.status, surface.name).toBe(401);
      expect(seen, surface.name).toEqual([]);
    }
  });

  it('forwards a declared refusal and turns anything else into a 503', async () => {
    for (const surface of SURFACES) {
      for (const status of [400, 401, 403, 404]) {
        const response = await surface.handler(read(surface.local), {
          env: ENV,
          fetch: upstream(status, problem('NOT_FOUND', status), []),
        });
        expect(response.status, `${surface.name} ${status}`).toBe(status);
      }
      for (const status of [418, 429, 500, 503]) {
        const response = await surface.handler(read(surface.local), {
          env: ENV,
          fetch: upstream(status, problem('NOT_FOUND', status), []),
        });
        expect(response.status, `${surface.name} ${status}`).toBe(503);
      }
    }
  });

  it('rebuilds from the validated fields, so a drifted upstream cannot leak', async () => {
    const leaks = {
      sellerUserId: 'LEAK-SELLER',
      buyerUserId: 'LEAK-BUYER',
      commissionSnapshot: 'LEAK-COMMISSION-SNAPSHOT',
      moderationReason: 'LEAK-MODERATION',
      ledgerAccountId: 'LEAK-LEDGER',
      providerPayoutRef: 'LEAK-PAYOUT',
    };
    for (const surface of SURFACES) {
      // The rows are handed extra fields the contract does not name. The strict schemas refuse the body
      // outright rather than trimming it, so the answer is a 503 — and either way nothing leaks.
      const polluted = JSON.parse(JSON.stringify(surface.payload)) as Record<string, unknown>;
      for (const key of Object.keys(polluted)) {
        const value = polluted[key];
        if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object') {
          polluted[key] = [{ ...(value[0] as object), ...leaks }];
        }
      }
      const response = await surface.handler(read(surface.local), {
        env: ENV,
        fetch: upstream(200, polluted, []),
      });
      const text = await response.text();
      for (const value of Object.values(leaks)) {
        expect(text, `${surface.name} ${value}`).not.toContain(value);
      }
    }
  });
});

describe('the page-side readers', () => {
  it('distinguish ok, not_a_seller, unauthenticated and unavailable', async () => {
    for (const surface of SURFACES) {
      const cases = [
        [200, surface.payload, 'ok'],
        [401, problem('AUTHENTICATION_REQUIRED', 401), 'unauthenticated'],
        [404, problem('NOT_FOUND', 404), 'not_a_seller'],
        [503, problem('SERVICE_UNAVAILABLE', 503), 'unavailable'],
        [200, { nonsense: true }, 'unavailable'],
      ] as const;
      for (const [status, payload, kind] of cases) {
        const lookup = await surface.reader({
          env: ENV,
          cookieHeader: COOKIE,
          fetch: upstream(status, payload, []),
        });
        expect(lookup.kind, `${surface.name} ${status}`).toBe(kind);
      }
    }
  });

  it('report an empty result as ok, never as unavailable', async () => {
    // The distinction the surfaces depend on: having nothing is a successful read.
    const empties = [
      [readSellerOrders, { orders: [], nextCursor: null }],
      [readSellerReviews, { summary: null, reviews: [], nextCursor: null }],
      [readSellerEarnings, { balances: [] }],
      [readSellerPromotions, { promotions: [], nextCursor: null }],
      [readSellerAnalytics, { days: 30, promotions: [] }],
    ] as const;
    for (const [reader, payload] of empties) {
      const lookup = await reader({ env: ENV, cookieHeader: COOKIE, fetch: upstream(200, payload, []) });
      expect(lookup.kind).toBe('ok');
    }
  });

  it('ask nothing at all without a session cookie', async () => {
    for (const surface of SURFACES) {
      const seen: Seen[] = [];
      const lookup = await surface.reader({
        env: ENV,
        cookieHeader: null,
        fetch: upstream(200, surface.payload, seen),
      });
      expect(lookup.kind, surface.name).toBe('unauthenticated');
      expect(seen, surface.name).toEqual([]);
    }
  });
});

describe('the page size and the window are clamped here too', () => {
  it('clamps an absurd limit on every paginated surface', async () => {
    for (const surface of SURFACES.filter((one) => one.paged)) {
      const seen: Seen[] = [];
      await surface.handler(read(`${surface.local}?limit=9999`), {
        env: ENV,
        fetch: upstream(200, surface.payload, seen),
      });
      expect(seen[0]?.url, surface.name).toContain('limit=50');

      const low: Seen[] = [];
      await surface.handler(read(`${surface.local}?limit=0`), {
        env: ENV,
        fetch: upstream(200, surface.payload, low),
      });
      expect(low[0]?.url, surface.name).toContain('limit=1');

      const bad: Seen[] = [];
      await surface.handler(read(`${surface.local}?limit=nonsense`), {
        env: ENV,
        fetch: upstream(200, surface.payload, bad),
      });
      expect(bad[0]?.url, surface.name).toContain('limit=20');
    }
  });

  it('passes the cursor through untouched and drops an empty one', async () => {
    const seen: Seen[] = [];
    await handleSellerOrders(read('/api/sellers/me/orders?cursor=abc123'), {
      env: ENV,
      fetch: upstream(200, { orders: [], nextCursor: null }, seen),
    });
    expect(seen[0]?.url).toContain('cursor=abc123');

    const empty: Seen[] = [];
    await handleSellerOrders(read('/api/sellers/me/orders?cursor='), {
      env: ENV,
      fetch: upstream(200, { orders: [], nextCursor: null }, empty),
    });
    expect(empty[0]?.url).not.toContain('cursor=');
  });

  it('clamps the analytics window', async () => {
    for (const [asked, expected] of [
      ['days=7', 'days=7'],
      ['days=99999', 'days=365'],
      ['days=0', 'days=1'],
      ['days=nonsense', 'days=30'],
      ['', 'days=30'],
    ] as const) {
      const seen: Seen[] = [];
      await handleSellerAnalytics(read(`/api/sellers/me/analytics?${asked}`), {
        env: ENV,
        fetch: upstream(200, { days: 30, promotions: [] }, seen),
      });
      expect(seen[0]?.url, asked).toContain(expected);
    }
  });

  it('never sends a pagination parameter to earnings', async () => {
    const seen: Seen[] = [];
    await handleSellerEarnings(read('/api/sellers/me/earnings?limit=5&cursor=abc'), {
      env: ENV,
      fetch: upstream(200, { balances: [] }, seen),
    });
    expect(seen[0]?.url).toBe(`${ENV.API_BASE_URL}/v1/sellers/me/earnings`);
  });
});

describe('the module exports no write path', () => {
  // Six and six since 0102 added the listing analytics pair. The invariant is the one that matters and is
  // unchanged: the module is a closed list of reads, and nothing in it is named for a write.
  it('exports exactly six handlers and six readers, and nothing that mutates', async () => {
    const surface = (await import('../src/server/bff/seller-read')) as Record<string, unknown>;
    const exported = Object.keys(surface).sort();
    expect(exported).toEqual([
      'handleSellerAnalytics',
      'handleSellerEarnings',
      'handleSellerListingAnalytics',
      'handleSellerOrders',
      'handleSellerPromotions',
      'handleSellerReviews',
      'readSellerAnalytics',
      'readSellerEarnings',
      'readSellerListingAnalytics',
      'readSellerOrders',
      'readSellerPromotions',
      'readSellerReviews',
    ]);
    // Nothing named for a write, a withdrawal or a moderation action exists to be called.
    for (const name of exported) {
      expect(name).not.toMatch(/create|update|delete|cancel|refund|withdraw|payout|moderate|reply/i);
    }
  });
});

describe('the listing analytics surface (0102)', () => {
  const local = '/api/sellers/me/listing-analytics';
  const remote = '/v1/sellers/me/listing-analytics';
  const payload = { days: 30, listings: [LISTING_PERFORMANCE] };

  it('is its own path, and does not reach 6-J’s operation', async () => {
    const seen: Seen[] = [];
    await handleSellerListingAnalytics(read(local), { env: ENV, fetch: upstream(200, payload, seen) });
    expect(seen[0]?.url.startsWith(`${ENV.API_BASE_URL}${remote}`)).toBe(true);
    expect(seen[0]?.url).not.toContain('/v1/sellers/me/analytics?');
  });

  it('clamps the window before it leaves, so a page cannot ask for more than the contract allows', async () => {
    for (const [asked, expected] of [
      ['', 'days=30'],
      ['?days=7', 'days=7'],
      ['?days=0', 'days=1'],
      ['?days=-5', 'days=1'],
      ['?days=100000', 'days=365'],
      ['?days=soon', 'days=30'],
    ] as const) {
      const seen: Seen[] = [];
      await handleSellerListingAnalytics(read(`${local}${asked}`), {
        env: ENV,
        fetch: upstream(200, payload, seen),
      });
      expect(seen[0]?.url, asked).toContain(expected);
    }
  });

  it('never sends a pagination parameter: a seller reads their own listings whole', async () => {
    const seen: Seen[] = [];
    await handleSellerListingAnalytics(read(`${local}?limit=5&cursor=abc`), {
      env: ENV,
      fetch: upstream(200, payload, seen),
    });
    expect(seen[0]?.url).not.toContain('limit');
    expect(seen[0]?.url).not.toContain('cursor');
  });

  /** Owner correction: a count is not money, and nothing on this path says otherwise. */
  it('carries the counts through with no currency anywhere', async () => {
    const response = await handleSellerListingAnalytics(read(local), {
      env: ENV,
      fetch: upstream(200, payload, []),
    });
    const body = await response.text();
    expect(JSON.parse(body)).toEqual(payload);
    for (const forbidden of ['currency', 'Minor', 'minor', 'amount', 'price']) {
      expect(body, forbidden).not.toContain(forbidden);
    }
  });

  it('drops a field the contract does not name, however the upstream drifts', async () => {
    const response = await handleSellerListingAnalytics(read(local), {
      env: ENV,
      fetch: upstream(
        200,
        { days: 30, listings: [{ ...LISTING_PERFORMANCE, sellerUserId: 'x', impressions: '9', listingId: 'y' }] },
        [],
      ),
    });
    const body = await response.text();
    // The contract is strict, so a drifted upstream fails the parse rather than leaking: the handler reports
    // the failure instead of passing an unknown field along.
    expect(body).not.toContain('sellerUserId');
    expect(body).not.toContain('impressions');
    expect(body).not.toContain('listingId');
  });
});
