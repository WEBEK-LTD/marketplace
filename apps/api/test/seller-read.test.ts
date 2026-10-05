import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  SellerAnalyticsResponseSchema,
  SellerEarningsResponseSchema,
  SellerOrdersResponseSchema,
  SellerPromotionsResponseSchema,
  SellerReviewsResponseSchema,
  SESSION_TOKEN_HEADER,
} from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { AuthenticationRequiredError } from '../src/auth/auth-errors.js';
import {
  DURABLE_THROTTLE_COUNTER,
  REDIS_THROTTLE_COUNTER,
} from '../src/auth/login-throttle.service.js';
import { SUPABASE_AUTH_CLIENT } from '../src/auth/login.service.js';
import { SELLER_STORE } from '../src/catalog/sellers.service.js';
import { SELLER_IDENTITY_STORE } from '../src/sellers/seller-identity.service.js';
import {
  encodeSellerIdCursor,
  encodeSellerReferenceCursor,
} from '../src/sellers/seller-read-cursor.js';
import {
  SELLER_READ_STORE,
  type SellerOrdersQuery,
  type SellerPromotionsQuery,
  type SellerReviewsQuery,
} from '../src/sellers/seller-read.service.js';
import { CURRENT_USER_STORE } from '../src/users/current-user.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * The read-only seller surfaces at the API boundary (Phase 6-J).
 *
 * Six properties carry this suite.
 *
 * **Nothing writes.** Every route is a GET, no route accepts a body, and the store double is asserted to
 * receive nothing but the caller's own id, a clamped limit and a keyset position. There is no write method on
 * the store interface for a route to reach.
 *
 * **No route consumes a rate limit.** The throttle counters are doubles that record every bucket they are
 * asked about, and they are asserted to record nothing at all across all five routes.
 *
 * **Nothing private travels.** The store deliberately hands back extra fields — a seller id, a buyer id, a
 * commission snapshot, a moderation reason, a ledger account, a payout reference — and every response is
 * asserted to contain none of them. This is the projection's whole purpose, so it is tested against a store
 * that is trying to leak.
 *
 * **Money is never a number.** Every amount that comes back is asserted to be a string, and the responses
 * are validated against the strict contracts, which refuse a number.
 *
 * **No metric is invented.** The summary's average is asserted to arrive in the basis points the view
 * produces, unconverted, and the analytics totals to be exactly what the store returned.
 *
 * **An empty storefront and an absent one are different answers**: an empty list versus a 404.
 */

const ACCESS_TOKEN = 'caller-access-token-value-not-a-real-token';
const CALLER = '11111111-1111-4111-8111-111111111111';
const OTHER_SELLER = '99999999-9999-4999-8999-999999999999';
const BUYER = '88888888-8888-4888-8888-888888888888';
const ORDER_NUMBER = 'MP-26-001001';

const IDENTITY = {
  slug: 'read-shop',
  displayName: 'Read Shop',
  status: 'active',
  verificationStatus: 'verified',
  city: 'Cairo',
  countryCode: 'EG',
};

/** Values no 6-J contract carries, offered by the store anyway. */
const LEAKS = {
  sellerUserId: OTHER_SELLER,
  buyerUserId: BUYER,
  commissionSnapshot: 'COMMISSION-SNAPSHOT-SECRET',
  moderationReason: 'MODERATION-REASON-SECRET',
  ledgerAccountId: 'LEDGER-ACCOUNT-SECRET',
  providerPayoutRef: 'PROVIDER-PAYOUT-SECRET',
  idempotencyKey: 'IDEMPOTENCY-SECRET',
  objectPath: 'OBJECT-PATH-SECRET',
} as const;

type Outcome = 'found' | 'none' | 'not_found' | 'something_else';

interface Recorded {
  readonly orders: SellerOrdersQuery[];
  readonly reviews: SellerReviewsQuery[];
  readonly summaries: string[];
  readonly earnings: string[];
  readonly promotions: SellerPromotionsQuery[];
  readonly analytics: { userId: string; days: number }[];
  readonly buckets: string[];
  readonly durableBuckets: string[];
}

interface Doubles {
  readonly outcome?: Outcome;
  readonly empty?: boolean;
  readonly leaky?: boolean;
  readonly rows?: number;
  readonly storeThrows?: boolean;
  readonly unauthenticated?: boolean;
  readonly summaryOutcome?: Outcome;
}

let app: NestFastifyApplication | undefined;

async function start(doubles: Doubles = {}): Promise<Recorded> {
  const recorded: Recorded = {
    orders: [],
    reviews: [],
    summaries: [],
    earnings: [],
    promotions: [],
    analytics: [],
    buckets: [],
    durableBuckets: [],
  };

  const counter = (into: string[]) => ({
    hit: async (bucket: string) => {
      into.push(bucket);
      return true;
    },
  });

  const leak = doubles.leaky === true ? LEAKS : {};
  const outcome = doubles.outcome ?? 'found';
  const rowCount = doubles.rows ?? 1;

  const orderRow = (index: number) => ({
    outcome: 'found',
    orderNumber: index === 0 ? ORDER_NUMBER : `MP-26-00100${index + 1}`,
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
        ...(doubles.leaky === true ? { listingId: 'LISTING-ID-SECRET', commissionMinor: '8000' } : {}),
      },
    ],
    ...leak,
  });

  const notFoundRow = { outcome: 'not_found' as const };

  const store = {
    sellerOrders: async (query: SellerOrdersQuery) => {
      recorded.orders.push(query);
      if (doubles.storeThrows === true) throw new Error('database unavailable');
      if (outcome === 'not_found') return [notFoundRow];
      if (outcome === 'something_else') return [{ outcome: 'something_else' }];
      if (doubles.empty === true) return [];
      return Array.from({ length: rowCount }, (_unused, index) => orderRow(index));
    },
    sellerReviews: async (query: SellerReviewsQuery) => {
      recorded.reviews.push(query);
      if (doubles.storeThrows === true) throw new Error('database unavailable');
      if (outcome === 'not_found') return [notFoundRow];
      if (doubles.empty === true) return [];
      return Array.from({ length: rowCount }, (_unused, index) => ({
        outcome: 'found',
        orderNumber: index === 0 ? ORDER_NUMBER : `MP-26-00100${index + 1}`,
        rating: 5,
        title: 'Great',
        body: 'Very good seller.',
        status: 'published',
        publishedAt: '2026-05-10T10:00:00.000Z',
        createdAt: '2026-05-09T10:00:00.000Z',
        replyBody: 'Thank you.',
        replyStatus: 'published',
        replyCreatedAt: '2026-05-11T10:00:00.000Z',
        ...leak,
      }));
    },
    sellerReviewsSummary: async (userId: string) => {
      recorded.summaries.push(userId);
      if (doubles.storeThrows === true) throw new Error('database unavailable');
      const summaryOutcome = doubles.summaryOutcome ?? (outcome === 'not_found' ? 'not_found' : 'found');
      if (summaryOutcome !== 'found') {
        return {
          outcome: summaryOutcome,
          reviewCount: null,
          averageRatingBasisPoints: null,
          fiveStarCount: null,
          fourStarCount: null,
          threeStarCount: null,
          twoStarCount: null,
          oneStarCount: null,
          latestReviewAt: null,
        };
      }
      return {
        outcome: 'found',
        reviewCount: 3,
        // Basis points, exactly as the view produces them: 4.6667 stars.
        averageRatingBasisPoints: 46_667,
        fiveStarCount: 2,
        fourStarCount: 1,
        threeStarCount: 0,
        twoStarCount: 0,
        oneStarCount: 0,
        latestReviewAt: '2026-05-10T10:00:00.000Z',
        ...leak,
      };
    },
    sellerEarnings: async (userId: string) => {
      recorded.earnings.push(userId);
      if (doubles.storeThrows === true) throw new Error('database unavailable');
      if (outcome === 'not_found') return [notFoundRow];
      if (doubles.empty === true) return [];
      return [
        {
          outcome: 'found',
          currencyCode: 'EGP',
          currencyDecimalPlaces: 2,
          pendingMinor: '12000',
          availableMinor: '98000',
          reservedMinor: '3000',
          updatedAt: '2026-05-01T10:00:00.000Z',
          ...leak,
        },
      ];
    },
    sellerPromotions: async (query: SellerPromotionsQuery) => {
      recorded.promotions.push(query);
      if (doubles.storeThrows === true) throw new Error('database unavailable');
      if (outcome === 'not_found') return [notFoundRow];
      if (doubles.empty === true) return [];
      return Array.from({ length: rowCount }, (_unused, index) => ({
        outcome: 'found',
        listingSlug: `a-listing-${index}`,
        listingTitle: 'A Listing',
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
        cursorId: '22222222-2222-4222-8222-222222222222',
        ...leak,
      }));
    },
    sellerPromotionAnalytics: async (userId: string, days: number) => {
      recorded.analytics.push({ userId, days });
      if (doubles.storeThrows === true) throw new Error('database unavailable');
      if (outcome === 'not_found') return [notFoundRow];
      if (doubles.empty === true) return [];
      return [
        {
          outcome: 'found',
          listingSlug: 'a-listing',
          listingTitle: 'A Listing',
          status: 'active',
          firstDay: '2026-05-01',
          lastDay: '2026-05-02',
          impressions: '2500',
          views: '450',
          clicks: '75',
          ...leak,
        },
      ];
    },
  };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(TEST_ENV)] })
    .overrideProvider(SUPABASE_AUTH_CLIENT)
    .useValue({
      getUser: async () => {
        if (doubles.unauthenticated === true) throw new AuthenticationRequiredError();
        return { id: CALLER, phone: null };
      },
      signInWithPassword: async () => {
        throw new Error('a read must never sign anyone in');
      },
      revokeAllSessions: async () => {
        throw new Error('a read must never revoke a session');
      },
    })
    .overrideProvider(CURRENT_USER_STORE)
    .useValue({ userIdentity: async (userId: string) => ({ id: userId, displayName: 'Nadia' }) })
    .overrideProvider(REDIS_THROTTLE_COUNTER)
    .useValue(counter(recorded.buckets))
    .overrideProvider(DURABLE_THROTTLE_COUNTER)
    .useValue(counter(recorded.durableBuckets))
    .overrideProvider(SELLER_READ_STORE)
    .useValue(store)
    .overrideProvider(SELLER_IDENTITY_STORE)
    .useValue({ sellerIdentity: async () => IDENTITY })
    .overrideProvider(SELLER_STORE)
    .useValue({ publicSellerBySlug: async () => ({ outcome: 'not_found' as const }) })
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

async function get(url: string, headers: Record<string, string> = {}): Promise<Result> {
  const response = await app!.inject({
    method: 'GET',
    url,
    headers: {
      [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL,
      [SESSION_TOKEN_HEADER]: ACCESS_TOKEN,
      ...headers,
    },
  });
  return {
    status: response.statusCode,
    body: response.body.length > 0 ? (JSON.parse(response.body) as Record<string, unknown>) : {},
    raw: response.body,
  };
}

const PATHS = [
  '/v1/sellers/me/orders',
  '/v1/sellers/me/reviews',
  '/v1/sellers/me/earnings',
  '/v1/sellers/me/promotions',
  '/v1/sellers/me/analytics',
] as const;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('authentication, and the caller’s own storefront', () => {
  it('serves every surface to the authenticated caller', async () => {
    const recorded = await start();
    for (const path of PATHS) {
      expect((await get(path)).status, path).toBe(200);
    }
    // The caller's own id, from their own token, on every one.
    expect(recorded.orders.map((q) => q.userId)).toEqual([CALLER]);
    expect(recorded.reviews.map((q) => q.userId)).toEqual([CALLER]);
    expect(recorded.summaries).toEqual([CALLER]);
    expect(recorded.earnings).toEqual([CALLER]);
    expect(recorded.promotions.map((q) => q.userId)).toEqual([CALLER]);
    expect(recorded.analytics.map((a) => a.userId)).toEqual([CALLER]);
  });

  it('refuses every surface without a session', async () => {
    await start();
    for (const path of PATHS) {
      expect((await get(path, { [SESSION_TOKEN_HEADER]: '' })).status, path).toBe(401);
    }
  });

  it('refuses every surface without the internal credential', async () => {
    await start();
    for (const path of PATHS) {
      expect((await get(path, { [INTERNAL_CREDENTIAL_HEADER]: 'wrong' })).status, path).toBe(403);
    }
  });

  it('never reads a seller from the query string', async () => {
    const recorded = await start();
    await get(`/v1/sellers/me/orders?sellerUserId=${OTHER_SELLER}&userId=${OTHER_SELLER}`);
    await get(`/v1/sellers/me/earnings?sellerUserId=${OTHER_SELLER}`);
    expect(recorded.orders.map((q) => q.userId)).toEqual([CALLER]);
    expect(recorded.earnings).toEqual([CALLER]);
  });

  it('answers 404 for an account with no storefront, on every surface', async () => {
    await start({ outcome: 'not_found' });
    for (const path of PATHS) {
      const result = await get(path);
      expect(result.status, path).toBe(404);
      expect((result.body as { code?: string }).code, path).toBe('NOT_FOUND');
    }
  });

  it('answers 200 with an empty list for a storefront that has nothing yet', async () => {
    // The distinction that matters: nothing yet is not the same as no storefront.
    await start({ empty: true, summaryOutcome: 'none' });
    expect(((await get('/v1/sellers/me/orders')).body as { orders: unknown[] }).orders).toEqual([]);
    expect(((await get('/v1/sellers/me/reviews')).body as { reviews: unknown[] }).reviews).toEqual([]);
    expect(((await get('/v1/sellers/me/reviews')).body as { summary: unknown }).summary).toBeNull();
    expect(
      ((await get('/v1/sellers/me/earnings')).body as { balances: unknown[] }).balances,
    ).toEqual([]);
    expect(
      ((await get('/v1/sellers/me/promotions')).body as { promotions: unknown[] }).promotions,
    ).toEqual([]);
    expect(
      ((await get('/v1/sellers/me/analytics')).body as { promotions: unknown[] }).promotions,
    ).toEqual([]);
  });

  it('is a 503 when the store cannot be asked', async () => {
    await start({ storeThrows: true });
    for (const path of PATHS) {
      expect((await get(path)).status, path).toBe(503);
    }
  });

  it('is a 503 for an outcome it does not understand', async () => {
    await start({ outcome: 'something_else' });
    expect((await get('/v1/sellers/me/orders')).status).toBe(503);
  });
});

describe('no route consumes a rate limit', () => {
  it('records no throttle bucket across all five surfaces', async () => {
    const recorded = await start();
    for (const path of PATHS) await get(path);
    // A read spends none of the approved Phase 6 numbers: the counters were never asked anything.
    expect(recorded.buckets).toEqual([]);
    expect(recorded.durableBuckets).toEqual([]);
  });

  it('serves the same surface many times over without being refused', async () => {
    await start();
    for (let attempt = 0; attempt < 30; attempt += 1) {
      expect((await get('/v1/sellers/me/earnings')).status, `attempt ${attempt}`).toBe(200);
    }
  });
});

describe('no write reaches these routes', () => {
  it('rejects every method but GET', async () => {
    await start();
    for (const path of PATHS) {
      for (const method of ['POST', 'PATCH', 'PUT', 'DELETE'] as const) {
        const response = await app!.inject({
          method,
          url: path,
          headers: {
            [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL,
            [SESSION_TOKEN_HEADER]: ACCESS_TOKEN,
            'content-type': 'application/json',
          },
          payload: '{"status":"refunded"}',
        });
        expect([404, 405], `${method} ${path}`).toContain(response.statusCode);
      }
    }
  });

  it('exposes no route that acts on an order, a review, a balance or a promotion', async () => {
    await start();
    for (const [method, url] of [
      ['POST', '/v1/sellers/me/orders'],
      ['POST', `/v1/sellers/me/orders/${ORDER_NUMBER}/refund`],
      ['PATCH', `/v1/sellers/me/orders/${ORDER_NUMBER}`],
      ['POST', `/v1/sellers/me/reviews/${ORDER_NUMBER}/reply`],
      ['DELETE', `/v1/sellers/me/reviews/${ORDER_NUMBER}`],
      ['POST', '/v1/sellers/me/earnings/withdrawals'],
      ['POST', '/v1/sellers/me/withdrawals'],
      ['POST', '/v1/sellers/me/payouts'],
      ['POST', '/v1/sellers/me/promotions'],
      ['DELETE', '/v1/sellers/me/promotions/a-listing'],
    ] as const) {
      const response = await app!.inject({
        method,
        url,
        headers: {
          [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL,
          [SESSION_TOKEN_HEADER]: ACCESS_TOKEN,
          'content-type': 'application/json',
        },
        payload: '{}',
      });
      expect([404, 405], `${method} ${url}`).toContain(response.statusCode);
    }
  });
});

describe('orders', () => {
  it('matches the contract and carries money as strings', async () => {
    await start();
    const result = await get('/v1/sellers/me/orders');
    expect(SellerOrdersResponseSchema.safeParse(result.body).success).toBe(true);
    const order = (result.body as { orders: Record<string, unknown>[] }).orders[0]!;
    expect(order['orderNumber']).toBe(ORDER_NUMBER);
    expect(order['grandTotalMinor']).toBe('106000');
    expect(order['sellerNetMinor']).toBe('98000');
    expect(order['commissionTotalMinor']).toBe('8000');
    expect(typeof order['grandTotalMinor']).toBe('string');
    expect(order['currencyDecimalPlaces']).toBe(2);
  });

  it('projects an item to exactly the seven contract fields', async () => {
    await start({ leaky: true });
    const result = await get('/v1/sellers/me/orders');
    const order = (result.body as { orders: { items: Record<string, unknown>[] }[] }).orders[0]!;
    expect(Object.keys(order.items[0]!).sort()).toEqual([
      'cancelledQuantity',
      'lineTotalMinor',
      'listingTypeCode',
      'quantity',
      'slug',
      'title',
      'unitPriceMinor',
    ]);
    // The store offered a listing id and a per-item commission. Neither survived the projection.
    expect(result.raw).not.toContain('LISTING-ID-SECRET');
    expect(result.raw).not.toContain('commissionMinor');
  });

  it('shows the title as purchased, not a live listing title', async () => {
    await start();
    const result = await get('/v1/sellers/me/orders');
    expect(result.raw).toContain('Title As Purchased');
  });

  it('clamps the limit and passes a keyset position, or none', async () => {
    const recorded = await start();
    await get('/v1/sellers/me/orders');
    expect(recorded.orders[0]?.limit).toBe(20);
    expect(recorded.orders[0]?.cursorPlacedAt).toBeNull();
    expect(recorded.orders[0]?.cursorOrderNumber).toBeNull();
    await get('/v1/sellers/me/orders?limit=9999');
    expect(recorded.orders[1]?.limit).toBe(50);
    await get('/v1/sellers/me/orders?limit=0');
    expect(recorded.orders[2]?.limit).toBe(1);
    await get('/v1/sellers/me/orders?limit=not-a-number');
    expect(recorded.orders[3]?.limit).toBe(20);
  });

  it('accepts its own cursor and refuses anything else with a 400', async () => {
    const recorded = await start();
    const cursor = encodeSellerReferenceCursor(new Date('2026-05-01T10:00:00.000Z'), ORDER_NUMBER);
    expect((await get(`/v1/sellers/me/orders?cursor=${encodeURIComponent(cursor)}`)).status).toBe(200);
    expect(recorded.orders.at(-1)?.cursorOrderNumber).toBe(ORDER_NUMBER);

    for (const bad of [
      'not-a-cursor',
      Buffer.from('2026-05-01T10:00:00.000Z|../etc/passwd', 'utf8').toString('base64url'),
      Buffer.from('not-a-date|MP-26-001001', 'utf8').toString('base64url'),
      // A promotion cursor, which carries a uuid: the orders decoder must refuse it.
      encodeSellerIdCursor(new Date('2026-05-01T10:00:00.000Z'), '22222222-2222-4222-8222-222222222222'),
    ]) {
      const result = await get(`/v1/sellers/me/orders?cursor=${encodeURIComponent(bad)}`);
      expect(result.status, bad).toBe(400);
      expect((result.body as { code?: string }).code).toBe('SELLER_LISTING_CURSOR_INVALID');
    }
  });

  it('offers a next cursor only when the page was full', async () => {
    await start({ rows: 1 });
    // One row against a default limit of 20: there is no next page to point at.
    expect(((await get('/v1/sellers/me/orders')).body as { nextCursor: unknown }).nextCursor).toBeNull();
    await app?.close();
    app = undefined;
    await start({ rows: 2 });
    const full = await get('/v1/sellers/me/orders?limit=2');
    expect(((full.body as { nextCursor: unknown }).nextCursor)).toEqual(expect.any(String));
    // And the cursor it offers is opaque: no order number readable in the URL-safe text.
    expect(String((full.body as { nextCursor: string }).nextCursor)).not.toContain('MP-26');
  });
});

describe('reviews and the rating summary', () => {
  it('matches the contract and answers both in one request', async () => {
    const recorded = await start();
    const result = await get('/v1/sellers/me/reviews');
    expect(SellerReviewsResponseSchema.safeParse(result.body).success).toBe(true);
    // One request, two readers: the page needs both, so it asks once.
    expect(recorded.reviews).toHaveLength(1);
    expect(recorded.summaries).toHaveLength(1);
  });

  it('passes the average through in basis points, unconverted', async () => {
    await start();
    const summary = ((await get('/v1/sellers/me/reviews')).body as {
      summary: Record<string, unknown>;
    }).summary;
    // 46667 is the view's own number. A service that divided by 10000 would show 4.6667 and fail here.
    expect(summary['averageRatingBasisPoints']).toBe(46_667);
    expect(summary['reviewCount']).toBe(3);
  });

  it('is null rather than zeros when nothing is published', async () => {
    await start({ summaryOutcome: 'none' });
    const body = (await get('/v1/sellers/me/reviews')).body as { summary: unknown };
    expect(body.summary).toBeNull();
  });

  it('404s when the summary reader says there is no storefront', async () => {
    await start({ empty: true, summaryOutcome: 'not_found' });
    expect((await get('/v1/sellers/me/reviews')).status).toBe(404);
  });
});

describe('earnings', () => {
  it('matches the contract and carries the three amounts as strings', async () => {
    await start();
    const result = await get('/v1/sellers/me/earnings');
    expect(SellerEarningsResponseSchema.safeParse(result.body).success).toBe(true);
    const balance = (result.body as { balances: Record<string, unknown>[] }).balances[0]!;
    expect(balance['pendingMinor']).toBe('12000');
    expect(balance['availableMinor']).toBe('98000');
    expect(balance['reservedMinor']).toBe('3000');
    expect(balance['currencyCode']).toBe('EGP');
    expect(balance['currencyDecimalPlaces']).toBe(2);
  });

  it('computes no total and exposes exactly six fields', async () => {
    await start({ leaky: true });
    const result = await get('/v1/sellers/me/earnings');
    const balance = (result.body as { balances: Record<string, unknown>[] }).balances[0]!;
    expect(Object.keys(balance).sort()).toEqual([
      'availableMinor',
      'currencyCode',
      'currencyDecimalPlaces',
      'pendingMinor',
      'reservedMinor',
      'updatedAt',
    ]);
    // The store offered a ledger account and a provider payout reference. Neither is in the response.
    expect(result.raw).not.toContain('LEDGER-ACCOUNT-SECRET');
    expect(result.raw).not.toContain('PROVIDER-PAYOUT-SECRET');
  });

  it('takes no pagination parameters at all', async () => {
    const recorded = await start();
    await get('/v1/sellers/me/earnings?limit=5&cursor=anything');
    // The store method takes a user id and nothing else: there is nowhere for either to go.
    expect(recorded.earnings).toEqual([CALLER]);
  });
});

describe('promotions', () => {
  it('matches the contract and never returns the cursor tie-breaker as a field', async () => {
    await start({ leaky: true });
    const result = await get('/v1/sellers/me/promotions');
    expect(SellerPromotionsResponseSchema.safeParse(result.body).success).toBe(true);
    const promotion = (result.body as { promotions: Record<string, unknown>[] }).promotions[0]!;
    expect(promotion['cursorId']).toBeUndefined();
    expect(result.raw).not.toContain('22222222-2222-4222-8222-222222222222');
    expect(result.raw).not.toContain('IDEMPOTENCY-SECRET');
    expect(promotion['listingSlug']).toBe('a-listing-0');
    expect(promotion['priceMinor']).toBe('25000');
  });

  it('accepts its own id cursor and refuses a reference cursor', async () => {
    const recorded = await start();
    const good = encodeSellerIdCursor(
      new Date('2026-04-30T00:00:00.000Z'),
      '22222222-2222-4222-8222-222222222222',
    );
    expect((await get(`/v1/sellers/me/promotions?cursor=${encodeURIComponent(good)}`)).status).toBe(200);
    expect(recorded.promotions.at(-1)?.cursorId).toBe('22222222-2222-4222-8222-222222222222');

    const wrongKind = encodeSellerReferenceCursor(new Date('2026-05-01T10:00:00.000Z'), ORDER_NUMBER);
    expect(
      (await get(`/v1/sellers/me/promotions?cursor=${encodeURIComponent(wrongKind)}`)).status,
    ).toBe(400);
  });
});

describe('analytics', () => {
  it('matches the contract and returns the rollup’s totals unchanged', async () => {
    await start();
    const result = await get('/v1/sellers/me/analytics');
    expect(SellerAnalyticsResponseSchema.safeParse(result.body).success).toBe(true);
    const row = (result.body as { promotions: Record<string, unknown>[] }).promotions[0]!;
    expect(row['impressions']).toBe('2500');
    expect(row['views']).toBe('450');
    expect(row['clicks']).toBe('75');
    // Bigint sums stay strings, and no rate is added.
    expect(typeof row['impressions']).toBe('string');
    expect(Object.keys(row).sort()).toEqual([
      'clicks',
      'firstDay',
      'impressions',
      'lastDay',
      'listingSlug',
      'listingTitle',
      'status',
      'views',
    ]);
  });

  it('resolves and reports the window, clamping an absurd one', async () => {
    const recorded = await start();
    expect(((await get('/v1/sellers/me/analytics')).body as { days: number }).days).toBe(30);
    expect(recorded.analytics[0]?.days).toBe(30);
    expect(((await get('/v1/sellers/me/analytics?days=7')).body as { days: number }).days).toBe(7);
    expect(((await get('/v1/sellers/me/analytics?days=99999')).body as { days: number }).days).toBe(365);
    expect(((await get('/v1/sellers/me/analytics?days=0')).body as { days: number }).days).toBe(1);
    expect(((await get('/v1/sellers/me/analytics?days=nonsense')).body as { days: number }).days).toBe(30);
  });

  it('serves the days as a date string, not a timestamp', async () => {
    await start();
    const row = ((await get('/v1/sellers/me/analytics')).body as {
      promotions: Record<string, unknown>[];
    }).promotions[0]!;
    expect(row['firstDay']).toBe('2026-05-01');
    expect(row['lastDay']).toBe('2026-05-02');
  });
});

describe('what never appears in a response', () => {
  it('leaks no identifier, token, credential, snapshot or staff field on any surface', async () => {
    await start({ leaky: true });
    for (const path of PATHS) {
      const result = await get(path);
      expect(result.status, path).toBe(200);
      for (const [name, value] of Object.entries(LEAKS)) {
        expect(result.raw, `${path} ${name}`).not.toContain(value);
      }
      expect(result.raw, path).not.toContain(ACCESS_TOKEN);
      expect(result.raw, path).not.toContain(TEST_INTERNAL_CREDENTIAL);
      expect(result.raw, path).not.toContain(CALLER);
      for (const key of [
        'sellerUserId',
        'buyerUserId',
        'moderationReason',
        'commissionSnapshot',
        'ledgerAccountId',
        'idempotencyKey',
      ]) {
        expect(result.raw, `${path} ${key}`).not.toContain(key);
      }
    }
  });
});
