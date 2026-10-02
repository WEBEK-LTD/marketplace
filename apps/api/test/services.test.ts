import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ServiceDetailResponseSchema, ServicesResponseSchema } from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import {
  SERVICE_STORE,
  type ServiceDetailRow,
  type ServiceRow,
} from '../src/catalog/services.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * `GET /v1/services` and `GET /v1/services/:slug` (Phase 4-C).
 *
 * The database decides which services are public; these tests are about the boundary above it — the page
 * the cursor describes, the statuses each outcome becomes, the cross-surface redirect that keeps one
 * listing from having two canonical URLs, and the fact that nothing outside the approved projection can
 * reach a response.
 */

const BASE = {
  title: 'Logo design',
  city: 'Cairo',
  priceMinor: '150000',
  currencyCode: 'EGP',
  currencyMinorUnit: 2,
  pricingModel: 'fixed',
  deliveryDays: 5,
  revisionsIncluded: 2,
} as const;

function row(n: number, minutesAgo: number): ServiceRow {
  return {
    ...BASE,
    id: `2222${String(n).padStart(4, '0')}-0000-4000-8000-000000000001`,
    slug: `service-${n}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 12, 0, 0) - minutesAgo * 60_000),
  };
}

const ROWS: readonly ServiceRow[] = [row(1, 0), row(2, 10), row(3, 20), row(4, 30), row(5, 40)];

type DetailDouble = Partial<ServiceDetailRow> & Pick<ServiceDetailRow, 'outcome' | 'canonicalSlug'>;

const DETAIL: DetailDouble = {
  outcome: 'found',
  canonicalSlug: 'service-1',
  canonicalType: 'service',
  ...ROWS[0]!,
  description: 'A description long enough to be real.',
  contentLanguage: 'en',
  requiresBrief: true,
  scope: 'Three concepts, two rounds of revision.',
  availability: 'available',
  category: { slug: 'design', name: 'Design' },
  seller: { slug: 'good-shop', displayName: 'Good Shop' },
  attributes: [],
  tags: [{ slug: 'remote', name: 'Remote' }],
};

interface Doubles {
  readonly listThrows?: boolean;
  readonly detail?: DetailDouble;
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
    .overrideProvider(SERVICE_STORE)
    .useValue({
      publicServices: async (input: { limit: number; cursorCreatedAt: Date | null; cursorId: string | null }) => {
        recorded.calls.push(input);
        if (doubles.listThrows === true) throw new Error('the catalogue is unreachable');
        const from = input.cursorCreatedAt === null ? 0 : ROWS.findIndex((r) => r.id === input.cursorId) + 1;
        return ROWS.slice(from, from + input.limit);
      },
      publicServiceBySlug: async (input: { slug: string; locale: string }) => {
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

async function get(path: string): Promise<{
  status: number;
  body: Record<string, unknown>;
  raw: string;
  headers: Record<string, unknown>;
}> {
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

describe('GET /v1/services', () => {
  it('answers 200 with a page that matches the contract', async () => {
    await start();
    const result = await get('/v1/services');
    expect(result.status).toBe(200);
    expect(ServicesResponseSchema.safeParse(result.body).success).toBe(true);
  });

  it('uses the approved default page size and asks for one row more', async () => {
    const recorded = await start();
    await get('/v1/services');
    expect(recorded.calls[0]?.limit).toBe(21);
  });

  it('honours an explicit limit up to the maximum', async () => {
    const recorded = await start();
    expect((await get('/v1/services?limit=2')).status).toBe(200);
    expect((await get('/v1/services?limit=50')).status).toBe(200);
    expect(recorded.calls.map((c) => c.limit)).toEqual([3, 51]);
  });

  it('refuses a limit outside the contract rather than clamping it', async () => {
    await start();
    for (const bad of ['0', '51', '500', 'ten', '-1', '1.5']) {
      const result = await get(`/v1/services?limit=${bad}`);
      expect(result.status, bad).toBe(400);
      expect(result.body).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    }
  });

  it('returns a cursor only while there is another page', async () => {
    await start();
    const first = ServicesResponseSchema.parse((await get('/v1/services?limit=2')).body);
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const last = ServicesResponseSchema.parse((await get('/v1/services?limit=50')).body);
    expect(last.items).toHaveLength(5);
    expect(last.nextCursor).toBeNull();
  });

  it('pages without repeating or skipping a service', async () => {
    await start();
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const query: string = cursor === null ? '?limit=2' : `?limit=2&cursor=${encodeURIComponent(cursor)}`;
      const parsed = ServicesResponseSchema.parse((await get(`/v1/services${query}`)).body);
      seen.push(...parsed.items.map((item) => item.slug));
      cursor = parsed.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toEqual(['service-1', 'service-2', 'service-3', 'service-4', 'service-5']);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('refuses a cursor it did not issue', async () => {
    await start();
    for (const bad of ['not-a-cursor', Buffer.from('nonsense', 'utf8').toString('base64url')]) {
      expect((await get(`/v1/services?cursor=${encodeURIComponent(bad)}`)).status).toBe(400);
    }
  });

  it('carries no field outside the approved service card', async () => {
    await start();
    const { items } = ServicesResponseSchema.parse((await get('/v1/services')).body);
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual([
        'city',
        'currencyCode',
        'currencyMinorUnit',
        'deliveryDays',
        'id',
        'pricingModel',
        'priceMinor',
        'revisionsIncluded',
        'slug',
        'title',
      ].sort());
    }
  });

  it('answers 503 when the catalogue cannot be read', async () => {
    await start({ listThrows: true });
    const result = await get('/v1/services');
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ status: 503, code: 'SERVICE_UNAVAILABLE' });
    expect(result.raw).not.toContain('unreachable');
  });
});

describe('GET /v1/services/:slug', () => {
  it('answers 200 with a service that matches the contract', async () => {
    await start();
    const result = await get('/v1/services/service-1');
    expect(result.status).toBe(200);
    expect(ServiceDetailResponseSchema.safeParse(result.body).success).toBe(true);
  });

  it('passes the locale through and defaults it when unknown', async () => {
    const recorded = await start();
    await get('/v1/services/service-1?locale=ar');
    await get('/v1/services/service-1?locale=de');
    await get('/v1/services/service-1');
    expect(recorded.slugs.map((s) => s.locale)).toEqual(['ar', 'en', 'en']);
  });

  it('carries the service-specific fields', async () => {
    await start();
    const { service } = ServiceDetailResponseSchema.parse((await get('/v1/services/service-1')).body);
    expect(service.pricingModel).toBe('fixed');
    expect(service.deliveryDays).toBe(5);
    expect(service.revisionsIncluded).toBe(2);
    expect(service.requiresBrief).toBe(true);
    expect(service.scope).toBe('Three concepts, two rounds of revision.');
  });

  it('carries a custom-priced service with no amount', async () => {
    await start({
      detail: { ...DETAIL, priceMinor: null, pricingModel: 'custom', deliveryDays: null },
    });
    const { service } = ServiceDetailResponseSchema.parse((await get('/v1/services/service-1')).body);
    expect(service.priceMinor).toBeNull();
    expect(service.pricingModel).toBe('custom');
    expect(service.deliveryDays).toBeNull();
  });

  it('carries a service with no details row at all', async () => {
    await start({
      detail: {
        ...DETAIL,
        pricingModel: null,
        deliveryDays: null,
        revisionsIncluded: null,
        requiresBrief: null,
        scope: null,
      },
    });
    const result = await get('/v1/services/service-1');
    expect(result.status).toBe(200);
    expect(ServiceDetailResponseSchema.safeParse(result.body).success).toBe(true);
  });

  it('marks a sold service as no longer available, still with 200', async () => {
    await start({ detail: { ...DETAIL, availability: 'no_longer_available' } });
    const result = await get('/v1/services/service-1');
    expect(result.status).toBe(200);
    expect(ServiceDetailResponseSchema.parse(result.body).service.availability).toBe('no_longer_available');
  });

  it('redirects a previous slug to the current one with 301, staying on this surface', async () => {
    await start({ detail: { outcome: 'moved', canonicalSlug: 'service-1', canonicalType: 'service' } });
    const result = await get('/v1/services/old-slug');
    expect(result.status).toBe(301);
    expect(result.headers['location']).toBe('/v1/services/service-1');
    expect(result.headers['x-canonical-slug']).toBe('service-1');
    expect(result.headers['x-canonical-type']).toBe('service');
  });

  it('redirects a product slug off this surface entirely', async () => {
    await start({ detail: { outcome: 'moved', canonicalSlug: 'a-sofa', canonicalType: 'product' } });
    const result = await get('/v1/services/a-sofa');
    expect(result.status).toBe(301);
    expect(result.headers['location']).toBe('/v1/listings/a-sofa');
    expect(result.headers['x-canonical-type']).toBe('product');
  });

  it('answers 404 for anything the public may not see', async () => {
    await start({ detail: { outcome: 'not_found', canonicalSlug: null, canonicalType: null } });
    const result = await get('/v1/services/whatever');
    expect(result.status).toBe(404);
    expect(result.raw).not.toContain('draft');
    expect(result.raw).not.toContain('suspended');
  });

  it('answers 503 when the catalogue cannot be read', async () => {
    await start({ detailThrows: true });
    expect((await get('/v1/services/service-1')).status).toBe(503);
  });

  it('carries no field outside the approved detail projection', async () => {
    await start();
    const { service } = ServiceDetailResponseSchema.parse((await get('/v1/services/service-1')).body);
    expect(Object.keys(service).sort()).toEqual([
      'attributes',
      'availability',
      'category',
      'city',
      'contentLanguage',
      'currencyCode',
      'currencyMinorUnit',
      'deliveryDays',
      'description',
      'id',
      'pricingModel',
      'priceMinor',
      'requiresBrief',
      'revisionsIncluded',
      'scope',
      'seller',
      'slug',
      'tags',
      'title',
    ].sort());
    expect(Object.keys(service.seller).sort()).toEqual(['displayName', 'slug']);
  });

  it('never carries a created-at, a seller id or a listing type', async () => {
    await start();
    const raw = (await get('/v1/services/service-1')).raw;
    for (const absent of ['createdAt', 'sellerUserId', 'listingTypeCode', 'viewCount', 'legalName']) {
      expect(raw, absent).not.toContain(absent);
    }
  });
});
