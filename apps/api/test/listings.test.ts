import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ListingDetailResponseSchema, ListingsResponseSchema } from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import {
  LISTING_STORE,
  decodeCursor,
  encodeCursor,
  type ListingDetailRow,
  type ListingRow,
} from '../src/catalog/listings.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * `GET /v1/listings` and `GET /v1/listings/:slug` (Phase 4-B).
 *
 * The database decides visibility; these tests are about the boundary above it — the page the cursor
 * describes, the statuses each outcome becomes, and the fact that nothing outside the approved
 * projection can reach a response.
 */

const BASE = {
  title: 'A listing title',
  city: 'Cairo',
  priceMinor: '250000',
  currencyCode: 'EGP',
  currencyMinorUnit: 2,
  isNegotiable: false,
  listingTypeCode: 'product',
} as const;

function row(n: number, minutesAgo: number): ListingRow {
  return {
    ...BASE,
    id: `1111${String(n).padStart(4, '0')}-0000-4000-8000-000000000001`,
    slug: `listing-${n}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 12, 0, 0) - minutesAgo * 60_000),
  };
}

const ROWS: readonly ListingRow[] = [row(1, 0), row(2, 10), row(3, 20), row(4, 30), row(5, 40)];

const DETAIL: Partial<ListingDetailRow> & Pick<ListingDetailRow, 'outcome' | 'canonicalSlug'> = {
  outcome: 'found',
  canonicalSlug: 'listing-1',
  ...ROWS[0]!,
  description: 'A description long enough to be real.',
  contentLanguage: 'en',
  availability: 'available',
  category: { slug: 'furniture', name: 'Furniture' },
  seller: { slug: 'good-shop', displayName: 'Good Shop' },
  attributes: [
    { key: 'width', label: 'Width', unit: 'cm', kind: 'number', text: '180', boolean: null, options: [] },
  ],
  tags: [{ slug: 'handmade', name: 'Handmade' }],
};

interface Doubles {
  readonly listThrows?: boolean;
  readonly detail?: Partial<ListingDetailRow> & Pick<ListingDetailRow, 'outcome' | 'canonicalSlug'>;
  readonly detailThrows?: boolean;
}

interface Recorded {
  readonly calls: Array<{ limit: number; cursorCreatedAt: Date | null; cursorId: string | null }>;
  readonly slugs: Array<{ slug: string; locale: string }>;
}

let app: NestFastifyApplication | undefined;

async function start(doubles: Doubles = {}): Promise<Recorded> {
  const recorded: Recorded = { calls: [], slugs: [] };
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(TEST_ENV)] })
    .overrideProvider(LISTING_STORE)
    .useValue({
      publicListings: async (input: { limit: number; cursorCreatedAt: Date | null; cursorId: string | null }) => {
        recorded.calls.push(input);
        if (doubles.listThrows === true) throw new Error('the catalogue is unreachable');
        const start = input.cursorCreatedAt === null ? 0 : ROWS.findIndex((r) => r.id === input.cursorId) + 1;
        return ROWS.slice(start, start + input.limit);
      },
      publicListingBySlug: async (input: { slug: string; locale: string }) => {
        recorded.slugs.push(input);
        if (doubles.detailThrows === true) throw new Error('the catalogue is unreachable');
        return doubles.detail ?? DETAIL;
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

async function get(path: string): Promise<{ status: number; body: Record<string, unknown>; raw: string; headers: Record<string, unknown> }> {
  const response = await app!.inject({
    method: 'GET',
    url: path,
    headers: { [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL },
  });
  return {
    status: response.statusCode,
    body: response.payload === '' ? {} : (JSON.parse(response.payload) as Record<string, unknown>),
    raw: response.payload,
    headers: response.headers as Record<string, unknown>,
  };
}

describe('GET /v1/listings', () => {
  it('answers 200 with a page that matches the contract', async () => {
    await start();
    const result = await get('/v1/listings');
    expect(result.status).toBe(200);
    expect(ListingsResponseSchema.safeParse(result.body).success).toBe(true);
  });

  it('uses the approved default page size and asks for one row more', async () => {
    const recorded = await start();
    await get('/v1/listings');
    expect(recorded.calls[0]?.limit).toBe(21);
  });

  it('honours an explicit limit up to the maximum', async () => {
    const recorded = await start();
    expect((await get('/v1/listings?limit=2')).status).toBe(200);
    expect((await get('/v1/listings?limit=50')).status).toBe(200);
    expect(recorded.calls.map((c) => c.limit)).toEqual([3, 51]);
  });

  it('refuses a limit outside the contract rather than clamping it', async () => {
    await start();
    for (const bad of ['0', '51', '500', 'ten', '-1', '1.5']) {
      const result = await get(`/v1/listings?limit=${bad}`);
      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    }
  });

  it('returns a cursor only while there is another page', async () => {
    await start();
    const first = ListingsResponseSchema.parse((await get('/v1/listings?limit=2')).body);
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const last = ListingsResponseSchema.parse((await get('/v1/listings?limit=50')).body);
    expect(last.items).toHaveLength(5);
    expect(last.nextCursor).toBeNull();
  });

  it('pages without repeating or skipping a listing', async () => {
    await start();
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const query: string = cursor === null ? '?limit=2' : `?limit=2&cursor=${encodeURIComponent(cursor)}`;
      const body: unknown = (await get(`/v1/listings${query}`)).body;
      const parsed = ListingsResponseSchema.parse(body);
      seen.push(...parsed.items.map((item) => item.slug));
      cursor = parsed.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toEqual(['listing-1', 'listing-2', 'listing-3', 'listing-4', 'listing-5']);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('refuses a cursor it did not issue', async () => {
    await start();
    for (const bad of ['not-a-cursor', Buffer.from('nonsense', 'utf8').toString('base64url')]) {
      const result = await get(`/v1/listings?cursor=${encodeURIComponent(bad)}`);
      expect(result.status).toBe(400);
    }
  });

  it('carries no field outside the approved card', async () => {
    await start();
    const { items } = ListingsResponseSchema.parse((await get('/v1/listings')).body);
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual([
        'city',
        'currencyCode',
        'currencyMinorUnit',
        'id',
        'isNegotiable',
        'listingTypeCode',
        'priceMinor',
        'slug',
        'title',
      ]);
    }
  });

  it('answers 503 when the catalogue cannot be read', async () => {
    await start({ listThrows: true });
    const result = await get('/v1/listings');
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ status: 503, code: 'SERVICE_UNAVAILABLE' });
    expect(result.raw).not.toContain('unreachable');
  });
});

describe('GET /v1/listings/:slug', () => {
  it('answers 200 with a listing that matches the contract', async () => {
    await start();
    const result = await get('/v1/listings/listing-1');
    expect(result.status).toBe(200);
    expect(ListingDetailResponseSchema.safeParse(result.body).success).toBe(true);
  });

  it('passes the locale through and defaults it when unknown', async () => {
    const recorded = await start();
    await get('/v1/listings/listing-1?locale=ar');
    await get('/v1/listings/listing-1?locale=de');
    await get('/v1/listings/listing-1');
    expect(recorded.slugs.map((s) => s.locale)).toEqual(['ar', 'en', 'en']);
  });

  it('marks a sold listing as no longer available, still with 200', async () => {
    await start({ detail: { ...DETAIL, availability: 'no_longer_available' } });
    const result = await get('/v1/listings/listing-1');
    expect(result.status).toBe(200);
    expect(ListingDetailResponseSchema.parse(result.body).listing.availability).toBe('no_longer_available');
  });

  it('redirects a previous slug to the current one with 301', async () => {
    await start({ detail: { outcome: 'moved', canonicalSlug: 'listing-1', canonicalType: 'product' } });
    const result = await get('/v1/listings/old-slug');
    expect(result.status).toBe(301);
    expect(result.headers['location']).toBe('/v1/listings/listing-1');
    expect(result.headers['x-canonical-slug']).toBe('listing-1');
    expect(result.headers['x-canonical-type']).toBe('product');
  });

  it('redirects a service slug off the listing surface entirely', async () => {
    // One listing, one canonical URL. A service asked for here belongs to /v1/services, and answering
    // it would give the same thing two public addresses.
    await start({ detail: { outcome: 'moved', canonicalSlug: 'logo-design', canonicalType: 'service' } });
    const result = await get('/v1/listings/logo-design');
    expect(result.status).toBe(301);
    expect(result.headers['location']).toBe('/v1/services/logo-design');
    expect(result.headers['x-canonical-type']).toBe('service');
  });

  it('answers 404 for anything the public may not see', async () => {
    await start({ detail: { outcome: 'not_found', canonicalSlug: null } });
    const result = await get('/v1/listings/whatever');
    expect(result.status).toBe(404);
    expect(result.body).toMatchObject({ status: 404 });
    // The same answer for a draft, a rejected listing, a suspended seller and a slug that names nothing.
    expect(result.raw).not.toContain('draft');
    expect(result.raw).not.toContain('suspended');
  });

  it('answers 503 when the catalogue cannot be read', async () => {
    await start({ detailThrows: true });
    expect((await get('/v1/listings/listing-1')).status).toBe(503);
  });

  it('carries no field outside the approved detail projection', async () => {
    await start();
    const { listing } = ListingDetailResponseSchema.parse((await get('/v1/listings/listing-1')).body);
    expect(Object.keys(listing).sort()).toEqual([
      'attributes',
      'availability',
      'category',
      'city',
      'contentLanguage',
      'createdAt',
      'currencyCode',
      'currencyMinorUnit',
      'description',
      'id',
      'isNegotiable',
      'listingTypeCode',
      'priceMinor',
      'seller',
      'slug',
      'tags',
      'title',
    ]);
    expect(Object.keys(listing.seller).sort()).toEqual(['displayName', 'slug']);
  });
});

describe('the pagination cursor', () => {
  it('round-trips a position', () => {
    const when = new Date('2026-01-01T12:00:00.000Z');
    const id = '11110001-0000-4000-8000-000000000001';
    const decoded = decodeCursor(encodeCursor(when, id));
    expect(decoded?.id).toBe(id);
    expect(decoded?.createdAt.toISOString()).toBe(when.toISOString());
  });

  it('is opaque: it reveals no readable position', () => {
    const cursor = encodeCursor(new Date('2026-01-01T12:00:00.000Z'), '11110001-0000-4000-8000-000000000001');
    expect(cursor).not.toContain('2026');
    expect(cursor).not.toContain('11110001');
  });

  it('rejects anything it did not produce', () => {
    for (const bad of ['', 'abc', Buffer.from('2026|nope', 'utf8').toString('base64url')]) {
      expect(decodeCursor(bad)).toBeNull();
    }
  });
});
