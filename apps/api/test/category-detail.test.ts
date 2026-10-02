import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { CategoryDetailResponseSchema } from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { CATEGORY_STORE, type CategoryDetailRow } from '../src/catalog/categories.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * `GET /v1/categories/:slug` (Phase 4-D).
 *
 * The database decides which categories are public; these tests are about the boundary above it — the
 * three statuses, the locale passed through, and the fact that nothing outside the approved projection
 * can reach a response. There is no 301 to test: categories keep no slug history.
 */

const FOUND: CategoryDetailRow = {
  outcome: 'found',
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'furniture',
  name: 'Furniture',
  description: 'Everything for the home.',
  metaTitle: 'Furniture | Marketplace',
  metaDescription: 'Browse furniture on the marketplace.',
  parent: null,
  children: [{ id: '22222222-2222-4222-8222-222222222222', slug: 'seating', name: 'Seating' }],
};

type Double = Pick<CategoryDetailRow, 'outcome'> & Partial<CategoryDetailRow>;

interface Recorded {
  readonly calls: Array<{ slug: string; locale: string }>;
}

let app: NestFastifyApplication | undefined;

async function start(row: Double | 'throws' = FOUND): Promise<Recorded> {
  const recorded: Recorded = { calls: [] };
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(TEST_ENV)] })
    .overrideProvider(CATEGORY_STORE)
    .useValue({
      publicCategories: async () => [],
      publicCategoryBySlug: async (input: { slug: string; locale: string }) => {
        recorded.calls.push(input);
        if (row === 'throws') throw new Error('the catalogue is unreachable');
        return row;
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

describe('GET /v1/categories/:slug', () => {
  it('answers 200 with a category that matches the contract', async () => {
    await start();
    const result = await get('/v1/categories/furniture');
    expect(result.status).toBe(200);
    expect(CategoryDetailResponseSchema.safeParse(result.body).success).toBe(true);
  });

  it('carries the parent, the children and the description', async () => {
    await start({ ...FOUND, parent: { id: '33333333-3333-4333-8333-333333333333', slug: 'home', name: 'Home' } });
    const { category } = CategoryDetailResponseSchema.parse((await get('/v1/categories/furniture')).body);
    expect(category.parent?.slug).toBe('home');
    expect(category.children.map((c) => c.slug)).toEqual(['seating']);
    expect(category.description).toBe('Everything for the home.');
  });

  it('keeps the document-head fields out of the category itself', async () => {
    await start();
    const parsed = CategoryDetailResponseSchema.parse((await get('/v1/categories/furniture')).body);
    expect(parsed.seo.metaTitle).toBe('Furniture | Marketplace');
    expect(Object.keys(parsed.category)).not.toContain('metaTitle');
    expect(Object.keys(parsed.category)).not.toContain('metaDescription');
  });

  it('answers 200 for a valid category with no children', async () => {
    await start({ ...FOUND, children: [] });
    const result = await get('/v1/categories/furniture');
    expect(result.status).toBe(200);
    expect(CategoryDetailResponseSchema.parse(result.body).category.children).toEqual([]);
  });

  it('passes the locale through and defaults it when unknown', async () => {
    const recorded = await start();
    await get('/v1/categories/furniture?locale=ar');
    await get('/v1/categories/furniture?locale=de');
    await get('/v1/categories/furniture');
    expect(recorded.calls.map((c) => c.locale)).toEqual(['ar', 'en', 'en']);
  });

  it('answers 404 for anything the public may not see, saying nothing about why', async () => {
    await start({ outcome: 'not_found' });
    const result = await get('/v1/categories/retired');
    expect(result.status).toBe(404);
    expect(result.body).toMatchObject({ status: 404 });
    // An inactive category and one that never existed must be indistinguishable here.
    expect(result.raw).not.toContain('inactive');
    expect(result.raw).not.toContain('is_active');
  });

  it('answers 503 when the catalogue cannot be read', async () => {
    await start('throws');
    const result = await get('/v1/categories/furniture');
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ status: 503, code: 'SERVICE_UNAVAILABLE' });
    expect(result.raw).not.toContain('unreachable');
  });

  it('carries no field outside the approved projection', async () => {
    await start();
    const { category } = CategoryDetailResponseSchema.parse((await get('/v1/categories/furniture')).body);
    expect(Object.keys(category).sort()).toEqual([
      'children',
      'description',
      'id',
      'name',
      'parent',
      'slug',
    ]);
  });

  it('never carries a type, a count or an active flag', async () => {
    await start();
    const raw = (await get('/v1/categories/furniture')).raw;
    for (const absent of ['listingTypeCode', 'listingCount', 'isActive', 'sortOrder', 'depth', 'icon']) {
      expect(raw, absent).not.toContain(absent);
    }
  });

  it('does not answer 301: categories keep no slug history', async () => {
    await start({ outcome: 'not_found' });
    expect((await get('/v1/categories/old-name')).status).toBe(404);
  });
});
