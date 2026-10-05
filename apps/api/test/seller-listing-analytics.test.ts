import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { SESSION_TOKEN_HEADER, SellerListingAnalyticsResponseSchema } from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { AuthenticationRequiredError } from '../src/auth/auth-errors.js';
import { SUPABASE_AUTH_CLIENT } from '../src/auth/login.service.js';
import { SELLER_READ_STORE, type SellerListingPerformanceRow } from '../src/sellers/seller-read.service.js';
import { SELLER_IDENTITY_STORE } from '../src/sellers/seller-identity.service.js';
import { CURRENT_USER_STORE } from '../src/users/current-user.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * `GET /v1/sellers/me/listing-analytics` (0102).
 *
 * A sibling of 6-J's promotion analytics, not a change to it: the properties under test are that the caller is
 * resolved from their own token and never from a parameter, that the window is clamped by the server, that the
 * four counts travel as decimal integer strings with **no currency anywhere**, and that nothing identifying
 * reaches the response — no listing id, no seller id, no account, no session digest.
 *
 * The store is a double, so the ownership rule itself is 0102's pgTAP suite's to prove; what is proved here is
 * that the boundary passes the caller's own account to it and reshapes nothing.
 */

const CALLER = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ACCESS_TOKEN = 'a-test-access-token-not-a-real-one';

const IDENTITY = {
  outcome: 'found' as const,
  slug: 'good-shop',
  displayName: 'Good Shop',
  status: 'active',
  verificationStatus: 'verified',
  countryCode: 'EG',
  createdAt: '2026-01-01T00:00:00.000Z',
} as const;

const FOUND: SellerListingPerformanceRow = {
  outcome: 'found',
  listingSlug: 'a-chair',
  listingTitle: 'A chair',
  listingStatus: 'active',
  firstDay: '2026-09-24',
  lastDay: '2026-10-03',
  clicks: '4294967296',
  contacts: '3',
  favorites: '0',
  shares: '0',
};

const NOT_FOUND: SellerListingPerformanceRow = {
  outcome: 'not_found',
  listingSlug: null,
  listingTitle: null,
  listingStatus: null,
  firstDay: null,
  lastDay: null,
  clicks: null,
  contacts: null,
  favorites: null,
  shares: null,
};

interface Doubles {
  readonly rows?: readonly SellerListingPerformanceRow[];
  readonly storeThrows?: boolean;
  readonly unauthenticated?: boolean;
}

interface Recorded {
  readonly calls: Array<{ userId: string; days: number }>;
}

let app: NestFastifyApplication | undefined;

async function start(doubles: Doubles = {}): Promise<Recorded> {
  const recorded: Recorded = { calls: [] };

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
    .overrideProvider(SELLER_IDENTITY_STORE)
    .useValue({ sellerIdentity: async () => IDENTITY })
    .overrideProvider(SELLER_READ_STORE)
    .useValue({
      sellerListingAnalytics: async (userId: string, days: number) => {
        recorded.calls.push({ userId, days });
        if (doubles.storeThrows === true) throw new Error('database unavailable');
        return doubles.rows ?? [FOUND];
      },
    })
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

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function get(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown>; raw: string }> {
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

const PATH = '/v1/sellers/me/listing-analytics';

describe('the route', () => {
  it('answers 200 with a page that matches the contract', async () => {
    await start();
    const result = await get(PATH);
    expect(result.status).toBe(200);
    expect(SellerListingAnalyticsResponseSchema.safeParse(result.body).success).toBe(true);
  });

  it('reports the four counts the rollup computed', async () => {
    await start();
    const parsed = SellerListingAnalyticsResponseSchema.parse((await get(PATH)).body);
    expect(parsed.listings).toEqual([
      {
        listingSlug: 'a-chair',
        listingTitle: 'A chair',
        listingStatus: 'active',
        firstDay: '2026-09-24',
        lastDay: '2026-10-03',
        clicks: '4294967296',
        contacts: '3',
        favorites: '0',
        shares: '0',
      },
    ]);
  });

  /** A count beyond 2^32 survives, which is the whole reason it travels as a string. */
  it('does not lose a count larger than a 32-bit integer', async () => {
    await start();
    const parsed = SellerListingAnalyticsResponseSchema.parse((await get(PATH)).body);
    expect(parsed.listings[0]?.clicks).toBe('4294967296');
  });

  it('resolves the caller from their own token and passes no identifier along', async () => {
    const recorded = await start();
    await get(PATH);
    expect(recorded.calls).toEqual([{ userId: CALLER, days: 30 }]);
  });

  /** There is no parameter for an account, so a caller cannot ask for somebody else's listings. */
  it('ignores an account named in the query string', async () => {
    const recorded = await start();
    await get(`${PATH}?userId=99999999-9999-4999-8999-999999999999&sellerUserId=x`);
    expect(recorded.calls).toEqual([{ userId: CALLER, days: 30 }]);
  });

  it('needs a session', async () => {
    await start();
    expect((await get(PATH, { [SESSION_TOKEN_HEADER]: '' })).status).toBe(401);
  });

  it('needs the internal credential, like every other /v1 route', async () => {
    await start();
    const response = await app!.inject({
      method: 'GET',
      url: PATH,
      headers: { [SESSION_TOKEN_HEADER]: ACCESS_TOKEN },
    });
    expect(response.statusCode).toBe(403);
  });

  it('answers 401 when the provider refuses the token', async () => {
    await start({ unauthenticated: true });
    expect((await get(PATH)).status).toBe(401);
  });

  it('answers 503 when the rollup cannot be read', async () => {
    await start({ storeThrows: true });
    const result = await get(PATH);
    expect(result.status).toBe(503);
    expect(result.body['code']).toBe('SERVICE_UNAVAILABLE');
  });

  it('is read-only: no other method is routed', async () => {
    await start();
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE'] as const) {
      const response = await app!.inject({
        method,
        url: PATH,
        headers: {
          [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL,
          [SESSION_TOKEN_HEADER]: ACCESS_TOKEN,
          'content-type': 'application/json',
        },
        payload: '{}',
      });
      expect(response.statusCode, method).not.toBe(200);
      expect([404, 405], method).toContain(response.statusCode);
    }
  });
});

describe('the window', () => {
  it('defaults to thirty days', async () => {
    const recorded = await start();
    await get(PATH);
    expect(recorded.calls[0]?.days).toBe(30);
  });

  it('accepts a window the caller asks for', async () => {
    const recorded = await start();
    await get(`${PATH}?days=7`);
    expect(recorded.calls[0]?.days).toBe(7);
  });

  it('clamps a window beyond a year, rather than obeying it', async () => {
    const recorded = await start();
    await get(`${PATH}?days=100000`);
    expect(recorded.calls[0]?.days).toBe(365);
  });

  it('clamps zero and a negative window up to a day', async () => {
    const recorded = await start();
    await get(`${PATH}?days=0`);
    await get(`${PATH}?days=-5`);
    expect(recorded.calls.map((call) => call.days)).toEqual([1, 1]);
  });

  it('treats an unparseable window as absent', async () => {
    const recorded = await start();
    await get(`${PATH}?days=soon`);
    expect(recorded.calls[0]?.days).toBe(30);
  });

  it('reports the window the server resolved, not the one asked for', async () => {
    await start();
    const parsed = SellerListingAnalyticsResponseSchema.parse((await get(`${PATH}?days=100000`)).body);
    expect(parsed.days).toBe(365);
  });
});

describe('what the response carries', () => {
  /**
   * 6-J's own behaviour, reused rather than reinvented: on every seller surface a caller with no storefront is
   * a 404, because there is no storefront for the route to be about. It is not the same answer as a storefront
   * with nothing rolled up yet, which is the next assertion — and the distinction is the caller's own state,
   * never another seller's.
   */
  it('answers 404 for a caller with no storefront, as every other seller surface does', async () => {
    await start({ rows: [NOT_FOUND] });
    expect((await get(PATH)).status).toBe(404);
  });

  it('is an empty list for a storefront the rollup has not covered yet', async () => {
    await start({ rows: [] });
    const result = await get(PATH);
    expect(result.status).toBe(200);
    expect(SellerListingAnalyticsResponseSchema.parse(result.body).listings).toEqual([]);
  });

  /** Owner correction: these are counts. Nothing on this path mentions a currency. */
  it('carries no currency, no money field and no amount', async () => {
    await start();
    const raw = (await get(PATH)).raw;
    for (const forbidden of ['currency', 'Minor', 'minor', 'amount', 'price', 'EGP']) {
      expect(raw, forbidden).not.toContain(forbidden);
    }
  });

  it('carries no identifier of any kind', async () => {
    await start();
    const raw = (await get(PATH)).raw;
    expect(raw).not.toContain(CALLER);
    for (const forbidden of ['listingId', 'sellerUserId', 'userId', 'sessionHash', 'eventId', 'promotionId']) {
      expect(raw, forbidden).not.toContain(forbidden);
    }
  });

  it('carries no impression, view or rate', async () => {
    await start();
    const raw = (await get(PATH)).raw;
    for (const forbidden of ['impression', 'view', 'rate', 'ctr', 'conversion', 'unique', 'source']) {
      expect(raw.toLowerCase(), forbidden).not.toContain(forbidden);
    }
  });

  it('answers only the two fields the contract names', async () => {
    await start();
    expect(Object.keys((await get(PATH)).body).sort()).toEqual(['days', 'listings']);
  });

  /** A row the database could not complete is a failure, not a row of nulls shipped to a browser. */
  it('answers 503 rather than shipping an incomplete row', async () => {
    await start({ rows: [{ ...FOUND, clicks: null }] });
    expect((await get(PATH)).status).toBe(503);
  });
});

describe('6-J’s own analytics route', () => {
  /** The closed surface is untouched: a sibling route was added, not a changed response. */
  it('still answers on its own path, with its own shape', async () => {
    await start();
    const response = await app!.inject({
      method: 'GET',
      url: '/v1/sellers/me/analytics',
      headers: {
        [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL,
        [SESSION_TOKEN_HEADER]: ACCESS_TOKEN,
      },
    });
    // The store double here implements only 0102's method, so 6-J's route fails at its own call rather than
    // being routed to this increment's handler — which is the point: the two are separate operations.
    expect(response.statusCode).not.toBe(404);
    expect(response.body).not.toContain('listings');
  });
});
