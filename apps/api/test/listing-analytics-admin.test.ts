import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ListingAnalyticsResponseSchema, SESSION_TOKEN_HEADER } from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { AuthenticationRequiredError } from '../src/auth/auth-errors.js';
import { SUPABASE_AUTH_CLIENT } from '../src/auth/login.service.js';
import { STAFF_CONSOLE_STORE, type StaffConsoleRow } from '../src/admin/staff-console.service.js';
import {
  LISTING_ANALYTICS_STORE,
  type ListingAnalyticsDbRow,
} from '../src/analytics/listing-analytics.service.js';
import { encodeListingAnalyticsCursor } from '../src/analytics/listing-analytics.cursor.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * `GET /v1/admin/analytics/listings` (0102).
 *
 * The first surface in this API that consumes `analytics.listing.read`, and the properties under test are the
 * ones that make it safe:
 *
 *   * **a refusal is an empty page.** The database applies the key and the assurance level; a caller without
 *     either reaches it and gets no rows, so this route cannot be used to find out whether any listing has
 *     traffic. There is no 403 and no 404 on it.
 *   * **the cursor is opaque and total.** A position this API did not issue is refused with one code, and the
 *     listing identifier reaches a browser only inside the cursor, never as a field.
 *   * **nothing identifying crosses.** No account, no session digest, no listing id, no raw event.
 *   * **it is read-only**, because nothing in 0102 writes: a day is corrected by re-running the job.
 *
 * The permission test itself belongs to 0102's pgTAP suite; what is proved here is that the account and the
 * assurance level are what the boundary passes, and that the shape of a refusal is an empty page.
 */

const STAFF = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ANALYTICS = 'analytics.listing.read';
const LISTING = '11111111-1111-4111-8111-111111111111';
const OTHER_LISTING = '22222222-2222-4222-8222-222222222222';

function token(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.c2lnbmF0dXJl`;
}

const ACCESS_TOKEN = token({ sub: STAFF, aal: 'aal2' });
const AAL1_TOKEN = token({ sub: STAFF, aal: 'aal1' });

const PATH = '/v1/admin/analytics/listings';

function row(overrides: Partial<ListingAnalyticsDbRow> = {}): ListingAnalyticsDbRow {
  return {
    day: '2026-10-03',
    listingSlug: 'a-chair',
    listingTitle: 'A chair',
    listingStatus: 'active',
    sellerSlug: 'good-shop',
    clicks: '4294967296',
    contacts: '3',
    favorites: '0',
    shares: '0',
    computedAt: new Date('2026-10-04T02:50:00.000Z'),
    cursorDay: '2026-10-03',
    cursorListingId: LISTING,
    ...overrides,
  };
}

interface Doubles {
  readonly permissions?: readonly string[];
  readonly rows?: readonly ListingAnalyticsDbRow[];
  readonly storeThrows?: boolean;
  readonly unauthenticated?: boolean;
  readonly noProfile?: boolean;
}

interface Recorded {
  readonly calls: Array<{
    userId: string;
    isAal2: boolean;
    days: number;
    limit: number;
    cursorDay: string | null;
    cursorListingId: string | null;
  }>;
}

let app: NestFastifyApplication | undefined;

async function start(doubles: Doubles = {}): Promise<Recorded> {
  const recorded: Recorded = { calls: [] };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(TEST_ENV)] })
    .overrideProvider(SUPABASE_AUTH_CLIENT)
    .useValue({
      getUser: async () => {
        if (doubles.unauthenticated === true) throw new AuthenticationRequiredError();
        return { id: STAFF, phone: null };
      },
      signInWithPassword: async () => {
        throw new Error('a read must never sign anyone in');
      },
      revokeAllSessions: async () => {
        throw new Error('a read must never revoke a session');
      },
    })
    .overrideProvider(STAFF_CONSOLE_STORE)
    .useValue({
      staffConsoleAccess: async (input: { userId: string; isAal2: boolean }): Promise<StaffConsoleRow> => ({
        hasConsoleRole: true,
        requiresStepUp: false,
        roles: ['admin'],
        // The platform's own behaviour, modelled rather than asserted around: a role that requires MFA counts
        // for nothing at aal1. The key here is held only by roles that require it.
        permissions: input.isAal2 ? [...(doubles.permissions ?? [ANALYTICS])] : [],
      }),
      buyerProfile: async (userId: string) =>
        doubles.noProfile === true ? null : { id: userId, displayName: 'Nadia', localeCode: 'en' },
    })
    .overrideProvider(LISTING_ANALYTICS_STORE)
    .useValue({
      listingAnalyticsPage: async (input: Recorded['calls'][number]) => {
        recorded.calls.push(input);
        if (doubles.storeThrows === true) throw new Error('database unavailable');
        // The database is what refuses: no key at aal2 means no rows, which is this surface's whole shape.
        if (!input.isAal2) return [];
        return doubles.rows ?? [row()];
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

describe('the route', () => {
  it('answers 200 with a page that matches the contract', async () => {
    await start();
    const result = await get(PATH);
    expect(result.status).toBe(200);
    expect(ListingAnalyticsResponseSchema.safeParse(result.body).success).toBe(true);
  });

  it('reports the day, the listing, the seller’s slug and the four counts', async () => {
    await start();
    const parsed = ListingAnalyticsResponseSchema.parse((await get(PATH)).body);
    expect(parsed.items).toEqual([
      {
        day: '2026-10-03',
        listingSlug: 'a-chair',
        listingTitle: 'A chair',
        listingStatus: 'active',
        sellerSlug: 'good-shop',
        clicks: '4294967296',
        contacts: '3',
        favorites: '0',
        shares: '0',
        computedAt: '2026-10-04T02:50:00.000Z',
      },
    ]);
  });

  it('passes the caller’s own account and assurance level to the database', async () => {
    const recorded = await start();
    await get(PATH);
    expect(recorded.calls[0]).toMatchObject({ userId: STAFF, isAal2: true });
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

  it('answers 401 when the provider refuses the token, and never asks the database', async () => {
    const recorded = await start({ unauthenticated: true });
    expect((await get(PATH)).status).toBe(401);
    expect(recorded.calls).toEqual([]);
  });

  it('answers 401 for a token whose account has no profile', async () => {
    await start({ noProfile: true });
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
      expect([404, 405], method).toContain(response.statusCode);
    }
  });
});

describe('a caller who may not read', () => {
  /** The shape of this whole surface: a refusal and an absence are the same answer. */
  it('gets an empty page without AAL2, not a refusal', async () => {
    await start();
    const result = await get(PATH, { [SESSION_TOKEN_HEADER]: AAL1_TOKEN });
    expect(result.status).toBe(200);
    expect(ListingAnalyticsResponseSchema.parse(result.body).items).toEqual([]);
    expect(ListingAnalyticsResponseSchema.parse(result.body).nextCursor).toBeNull();
  });

  it('is still asked of the database, with the assurance level it actually has', async () => {
    const recorded = await start();
    await get(PATH, { [SESSION_TOKEN_HEADER]: AAL1_TOKEN });
    expect(recorded.calls[0]).toMatchObject({ userId: STAFF, isAal2: false });
  });

  /** Nothing in the API decides this, so a caller holding another key reaches the reader and gets nothing. */
  it('reaches the reader even holding only other keys', async () => {
    const recorded = await start({ permissions: ['platform.job.read', 'audit.read', 'users.role.manage'] });
    const result = await get(PATH);
    expect(result.status).toBe(200);
    expect(recorded.calls).toHaveLength(1);
  });

  it('is never told which key it is missing', async () => {
    await start({ permissions: [] });
    const raw = (await get(PATH)).raw;
    expect(raw).not.toContain('analytics.listing.read');
    expect(raw).not.toContain('permission');
    expect(raw).not.toContain('aal');
  });
});

describe('the window and the page size', () => {
  it('defaults to thirty days and twenty-five rows', async () => {
    const recorded = await start();
    await get(PATH);
    expect(recorded.calls[0]).toMatchObject({ days: 30, limit: 26 });
  });

  it('clamps the window at a year and the page at a hundred', async () => {
    const recorded = await start();
    await get(`${PATH}?days=100000&limit=1000`);
    expect(recorded.calls[0]).toMatchObject({ days: 365, limit: 101 });
  });

  /**
   * The shared limit parser accepts at most four digits, so a wildly large page size is a malformed request
   * rather than a clamped one. That is every console surface's behaviour and it is not relaxed here.
   */
  it('refuses a page size with more digits than the parser accepts', async () => {
    const recorded = await start();
    expect((await get(`${PATH}?limit=100000`)).status).toBe(400);
    expect(recorded.calls).toEqual([]);
  });

  it('clamps a zero or negative window up to a day', async () => {
    const recorded = await start();
    await get(`${PATH}?days=0`);
    expect(recorded.calls[0]?.days).toBe(1);
  });

  /** A malformed limit is a malformed request; a malformed window is simply absent. */
  it('refuses a malformed limit and ignores a malformed window', async () => {
    const recorded = await start();
    expect((await get(`${PATH}?limit=lots`)).status).toBe(400);
    expect((await get(`${PATH}?days=soon`)).status).toBe(200);
    expect(recorded.calls.at(-1)?.days).toBe(30);
  });

  it('reports the window the server resolved', async () => {
    await start();
    expect(ListingAnalyticsResponseSchema.parse((await get(`${PATH}?days=99999`)).body).days).toBe(365);
  });

  it('asks for one row more than the page, which is how "there is more" is answered', async () => {
    const recorded = await start();
    await get(`${PATH}?limit=10`);
    expect(recorded.calls[0]?.limit).toBe(11);
  });
});

describe('the cursor', () => {
  it('is absent when the page is the last one', async () => {
    await start({ rows: [row()] });
    expect(ListingAnalyticsResponseSchema.parse((await get(`${PATH}?limit=10`)).body).nextCursor).toBeNull();
  });

  it('is present, and the extra row is dropped, when there is another page', async () => {
    const rows = [row(), row({ cursorListingId: OTHER_LISTING, listingSlug: 'a-table' })];
    await start({ rows });
    const parsed = ListingAnalyticsResponseSchema.parse((await get(`${PATH}?limit=1`)).body);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.nextCursor).not.toBeNull();
  });

  it('encodes the last row of the page it returned, not the row it dropped', async () => {
    const rows = [row(), row({ cursorListingId: OTHER_LISTING, listingSlug: 'a-table' })];
    await start({ rows });
    const parsed = ListingAnalyticsResponseSchema.parse((await get(`${PATH}?limit=1`)).body);
    const decoded = Buffer.from(parsed.nextCursor!, 'base64url').toString('utf8');
    expect(decoded).toContain(LISTING);
    expect(decoded).not.toContain(OTHER_LISTING);
  });

  it('is handed back to the database as a position', async () => {
    const recorded = await start();
    const cursor = encodeListingAnalyticsCursor({ day: '2026-09-30', listingId: OTHER_LISTING });
    await get(`${PATH}?cursor=${encodeURIComponent(cursor)}`);
    expect(recorded.calls[0]).toMatchObject({ cursorDay: '2026-09-30', cursorListingId: OTHER_LISTING });
  });

  it('is refused with one code when it is not a position this API issued', async () => {
    const recorded = await start();
    for (const cursor of ['nonsense', '!!!!', Buffer.from('ad1|x|y', 'utf8').toString('base64url')]) {
      const result = await get(`${PATH}?cursor=${encodeURIComponent(cursor)}`);
      expect(result.status, cursor).toBe(400);
      expect(result.body['code'], cursor).toBe('LISTING_ANALYTICS_CURSOR_INVALID');
    }
    // Refused before anything is read, so a bad cursor costs no query.
    expect(recorded.calls).toEqual([]);
  });

  it('treats an empty cursor as no cursor', async () => {
    const recorded = await start();
    expect((await get(`${PATH}?cursor=`)).status).toBe(200);
    expect(recorded.calls[0]).toMatchObject({ cursorDay: null, cursorListingId: null });
  });
});

describe('what the response carries', () => {
  /** Owner correction: these are counts. Nothing on this path mentions a currency. */
  it('carries no currency, no money field and no amount', async () => {
    await start();
    const raw = (await get(PATH)).raw;
    for (const forbidden of ['currency', 'Minor', 'minor', 'amount', 'price', 'EGP']) {
      expect(raw, forbidden).not.toContain(forbidden);
    }
  });

  it('carries no account identifier and no session digest', async () => {
    await start();
    const raw = (await get(PATH)).raw;
    expect(raw).not.toContain(STAFF);
    for (const forbidden of ['sellerUserId', 'userId', 'sessionHash', 'eventId', 'referrerHost', 'promotionId']) {
      expect(raw, forbidden).not.toContain(forbidden);
    }
  });

  /** The listing's identifier reaches a browser only inside the opaque cursor, never as a field. */
  it('carries no listing identifier as a field', async () => {
    const rows = [row(), row({ cursorListingId: OTHER_LISTING, listingSlug: 'a-table' })];
    await start({ rows });
    const result = await get(`${PATH}?limit=1`);
    expect(result.raw).not.toContain('listingId');
    const parsed = ListingAnalyticsResponseSchema.parse(result.body);
    expect(JSON.stringify(parsed.items)).not.toContain(LISTING);
  });

  it('carries no impression, view or rate', async () => {
    await start();
    const raw = (await get(PATH)).raw;
    for (const forbidden of ['impression', 'rate', 'ctr', 'conversion', 'unique', 'source']) {
      expect(raw.toLowerCase(), forbidden).not.toContain(forbidden);
    }
  });

  it('answers only the three fields the contract names', async () => {
    await start();
    expect(Object.keys((await get(PATH)).body).sort()).toEqual(['days', 'items', 'nextCursor']);
  });

  it('allows a listing whose owner has no storefront row', async () => {
    await start({ rows: [row({ sellerSlug: null })] });
    const result = await get(PATH);
    expect(result.status).toBe(200);
    expect(ListingAnalyticsResponseSchema.parse(result.body).items[0]?.sellerSlug).toBeNull();
  });
});
