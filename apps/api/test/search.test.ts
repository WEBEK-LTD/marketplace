import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { SearchResponseSchema } from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { SEARCH_PORT, type SearchRow } from '../src/catalog/search.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * `GET /v1/search` (Phase 4-F, V1).
 *
 * The database decides what is findable; these tests are about the boundary above it — the query rule,
 * the page the cursor describes, and the mixed result set keeping each surface's card fields intact.
 */

function listingRow(n: number, minutesAgo: number): SearchRow {
  return {
    resultType: 'listing',
    id: `1111${String(n).padStart(4, '0')}-0000-4000-8000-000000000001`,
    slug: `listing-${n}`,
    title: 'Walnut dining table',
    city: 'Cairo',
    priceMinor: '250000',
    currencyCode: 'EGP',
    currencyMinorUnit: 2,
    isNegotiable: false,
    listingTypeCode: 'product',
    pricingModel: null,
    deliveryDays: null,
    revisionsIncluded: null,
    createdAt: new Date(Date.UTC(2026, 0, 1, 12, 0, 0) - minutesAgo * 60_000),
  };
}

function serviceRow(n: number, minutesAgo: number): SearchRow {
  return {
    resultType: 'service',
    id: `2222${String(n).padStart(4, '0')}-0000-4000-8000-000000000001`,
    slug: `service-${n}`,
    title: 'Walnut furniture restoration',
    city: 'Cairo',
    priceMinor: '150000',
    currencyCode: 'EGP',
    currencyMinorUnit: 2,
    isNegotiable: null,
    listingTypeCode: null,
    pricingModel: 'fixed',
    deliveryDays: 14,
    revisionsIncluded: 1,
    createdAt: new Date(Date.UTC(2026, 0, 1, 12, 0, 0) - minutesAgo * 60_000),
  };
}

const ROWS: readonly SearchRow[] = [
  listingRow(1, 0),
  serviceRow(1, 10),
  listingRow(2, 20),
  serviceRow(2, 30),
  listingRow(3, 40),
];

interface Doubles {
  readonly throws?: boolean;
  readonly rows?: readonly SearchRow[];
}

interface Recorded {
  readonly calls: Array<{ query: string; locale: string; limit: number; cursorId: string | null }>;
}

let app: NestFastifyApplication | undefined;

async function start(doubles: Doubles = {}): Promise<Recorded> {
  const recorded: Recorded = { calls: [] };
  const rows = doubles.rows ?? ROWS;
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(TEST_ENV)] })
    .overrideProvider(SEARCH_PORT)
    .useValue({
      publicSearch: async (input: {
        query: string;
        locale: string;
        limit: number;
        cursorCreatedAt: Date | null;
        cursorId: string | null;
      }) => {
        recorded.calls.push({
          query: input.query,
          locale: input.locale,
          limit: input.limit,
          cursorId: input.cursorId,
        });
        if (doubles.throws === true) throw new Error('the search index is unreachable');
        const from = input.cursorCreatedAt === null ? 0 : rows.findIndex((r) => r.id === input.cursorId) + 1;
        return rows.slice(from, from + input.limit);
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

async function get(path: string): Promise<{ status: number; body: Record<string, unknown>; raw: string }> {
  const response = await app!.inject({
    method: 'GET',
    url: path,
    headers: { [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL },
  });
  return {
    status: response.statusCode,
    body: response.payload === '' ? {} : (JSON.parse(response.payload) as Record<string, unknown>),
    raw: response.payload,
  };
}

describe('GET /v1/search', () => {
  it('answers 200 with a page that matches the contract', async () => {
    await start();
    const result = await get('/v1/search?q=walnut');
    expect(result.status).toBe(200);
    expect(SearchResponseSchema.safeParse(result.body).success).toBe(true);
  });

  it('returns a mixed result set, each item keeping its own card fields', async () => {
    await start();
    const { items } = SearchResponseSchema.parse((await get('/v1/search?q=walnut')).body);
    const listing = items.find((item) => item.type === 'listing');
    const service = items.find((item) => item.type === 'service');

    expect(listing).toBeDefined();
    expect(service).toBeDefined();
    if (listing?.type === 'listing') {
      expect(listing.isNegotiable).toBe(false);
      expect(listing.listingTypeCode).toBe('product');
      expect(Object.keys(listing)).not.toContain('pricingModel');
    }
    if (service?.type === 'service') {
      expect(service.pricingModel).toBe('fixed');
      expect(service.deliveryDays).toBe(14);
      expect(service.revisionsIncluded).toBe(1);
      expect(Object.keys(service)).not.toContain('isNegotiable');
    }
  });

  it('trims the query before running it', async () => {
    const recorded = await start();
    await get(`/v1/search?q=${encodeURIComponent('   walnut   ')}`);
    expect(recorded.calls[0]?.query).toBe('walnut');
  });

  it('runs a two-character query', async () => {
    const recorded = await start();
    expect((await get('/v1/search?q=ab')).status).toBe(200);
    expect(recorded.calls[0]?.query).toBe('ab');
  });

  it('refuses an empty or one-character query, and never calls the search port', async () => {
    const recorded = await start();
    for (const q of ['', '%20', 'a', '%20a%20', '%20%20']) {
      const result = await get(`/v1/search?q=${q}`);
      expect(result.status, q).toBe(400);
      expect(result.body).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    }
    // A refused query must not reach the database: an empty search is not a browse feed.
    expect(recorded.calls).toHaveLength(0);
  });

  it('refuses a missing q entirely', async () => {
    const recorded = await start();
    expect((await get('/v1/search')).status).toBe(400);
    expect(recorded.calls).toHaveLength(0);
  });

  it('passes the locale through and defaults it when unknown', async () => {
    const recorded = await start();
    await get('/v1/search?q=walnut&locale=ar');
    await get('/v1/search?q=walnut&locale=de');
    await get('/v1/search?q=walnut');
    expect(recorded.calls.map((c) => c.locale)).toEqual(['ar', 'en', 'en']);
  });

  it('uses the approved default page size and asks for one row more', async () => {
    const recorded = await start();
    await get('/v1/search?q=walnut');
    expect(recorded.calls[0]?.limit).toBe(21);
  });

  it('refuses a limit outside the contract rather than clamping it', async () => {
    await start();
    for (const bad of ['0', '51', '500', 'ten', '-1', '1.5']) {
      expect((await get(`/v1/search?q=walnut&limit=${bad}`)).status, bad).toBe(400);
    }
  });

  it('returns a cursor only while there is another page', async () => {
    await start();
    const first = SearchResponseSchema.parse((await get('/v1/search?q=walnut&limit=2')).body);
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const last = SearchResponseSchema.parse((await get('/v1/search?q=walnut&limit=50')).body);
    expect(last.items).toHaveLength(5);
    expect(last.nextCursor).toBeNull();
  });

  it('pages without repeating or skipping a result', async () => {
    await start();
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const query: string =
        cursor === null ? '?q=walnut&limit=2' : `?q=walnut&limit=2&cursor=${encodeURIComponent(cursor)}`;
      const parsed = SearchResponseSchema.parse((await get(`/v1/search${query}`)).body);
      seen.push(...parsed.items.map((item) => `${item.type}:${item.slug}`));
      cursor = parsed.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toEqual([
      'listing:listing-1',
      'service:service-1',
      'listing:listing-2',
      'service:service-2',
      'listing:listing-3',
    ]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('refuses a cursor it did not issue', async () => {
    await start();
    for (const bad of ['not-a-cursor', Buffer.from('nonsense', 'utf8').toString('base64url')]) {
      expect((await get(`/v1/search?q=walnut&cursor=${encodeURIComponent(bad)}`)).status).toBe(400);
    }
  });

  it('answers 503 when the search cannot be run', async () => {
    await start({ throws: true });
    const result = await get('/v1/search?q=walnut');
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ status: 503, code: 'SERVICE_UNAVAILABLE' });
    expect(result.raw).not.toContain('unreachable');
  });

  it('carries no field outside the two approved card shapes', async () => {
    await start();
    const { items } = SearchResponseSchema.parse((await get('/v1/search?q=walnut')).body);
    for (const item of items) {
      const keys = Object.keys(item).sort();
      if (item.type === 'listing') {
        expect(keys).toEqual(
          ['type', 'id', 'slug', 'title', 'city', 'priceMinor', 'currencyCode', 'currencyMinorUnit', 'isNegotiable', 'listingTypeCode'].sort(),
        );
      } else {
        expect(keys).toEqual(
          ['type', 'id', 'slug', 'title', 'city', 'priceMinor', 'currencyCode', 'currencyMinorUnit', 'pricingModel', 'deliveryDays', 'revisionsIncluded'].sort(),
        );
      }
    }
  });

  it('never carries a description, a rank, a distance or a promotion flag', async () => {
    await start();
    const raw = (await get('/v1/search?q=walnut')).raw;
    for (const absent of ['description', 'rank', 'score', 'distance', 'promoted', 'sellerUserId', 'createdAt']) {
      expect(raw, absent).not.toContain(absent);
    }
  });
});
