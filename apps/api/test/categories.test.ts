import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { CategoriesResponseSchema } from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { CATEGORY_STORE, assembleTree, type CategoryRow } from '../src/catalog/categories.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * `GET /v1/categories` (Phase 4-A).
 *
 * The first `/v1` route with no user behind it, so the assertions are about shape and about restraint:
 * the flat rows the database returns become the nested contract; the locale reaches the database
 * unchanged when it is one we serve and falls back when it is not; an empty catalogue is a success; and
 * a database that cannot answer is a 503 that says nothing about the database.
 */

const ROOT = '11111111-1111-4111-8111-111111111111';
const CHILD = '22222222-2222-4222-8222-222222222222';
const GRANDCHILD = '33333333-3333-4333-8333-333333333333';
const SECOND_ROOT = '44444444-4444-4444-8444-444444444444';

const TREE: readonly CategoryRow[] = [
  { id: ROOT, parentId: null, slug: 'electronics', name: 'Electronics' },
  { id: SECOND_ROOT, parentId: null, slug: 'home', name: 'Home' },
  { id: CHILD, parentId: ROOT, slug: 'phones', name: 'Phones' },
  { id: GRANDCHILD, parentId: CHILD, slug: 'smartphones', name: 'Smartphones' },
];

interface Recorded {
  readonly locales: string[];
}

let app: NestFastifyApplication | undefined;

async function start(
  rows: readonly CategoryRow[] | 'throws',
): Promise<Recorded> {
  const recorded: Recorded = { locales: [] };
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(TEST_ENV)] })
    .overrideProvider(CATEGORY_STORE)
    .useValue({
      publicCategories: async (locale: string) => {
        recorded.locales.push(locale);
        if (rows === 'throws') throw new Error('the catalogue is unreachable');
        return rows;
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
  query = '',
  credential: string | null = TEST_INTERNAL_CREDENTIAL,
): Promise<{ status: number; body: Record<string, unknown>; raw: string }> {
  const response = await app!.inject({
    method: 'GET',
    url: `/v1/categories${query}`,
    headers: credential === null ? {} : { [INTERNAL_CREDENTIAL_HEADER]: credential },
  });
  return {
    status: response.statusCode,
    body: JSON.parse(response.payload) as Record<string, unknown>,
    raw: response.payload,
  };
}

describe('GET /v1/categories', () => {
  it('answers 200 with a tree that matches the contract', async () => {
    await start(TREE);
    const result = await get();
    expect(result.status).toBe(200);
    expect(CategoriesResponseSchema.safeParse(result.body).success).toBe(true);
  });

  it('nests children under their parents and keeps the database order', async () => {
    await start(TREE);
    const { categories } = CategoriesResponseSchema.parse((await get()).body);

    expect(categories.map((c) => c.slug)).toEqual(['electronics', 'home']);
    expect(categories[0]?.children.map((c) => c.slug)).toEqual(['phones']);
    expect(categories[0]?.children[0]?.children.map((c) => c.slug)).toEqual(['smartphones']);
    expect(categories[1]?.children).toEqual([]);
  });

  it('exposes only the four approved fields on every node', async () => {
    await start(TREE);
    const { categories } = CategoriesResponseSchema.parse((await get()).body);
    const seen: string[][] = [];
    const walk = (nodes: readonly { children: readonly unknown[] }[]): void => {
      for (const node of nodes) {
        seen.push(Object.keys(node).sort());
        walk(node.children as readonly { children: readonly unknown[] }[]);
      }
    };
    walk(categories);
    expect(seen).toHaveLength(4);
    for (const keys of seen) expect(keys).toEqual(['children', 'id', 'name', 'slug']);
  });

  it('passes a locale we serve straight through', async () => {
    const recorded = await start(TREE);
    await get('?locale=ar');
    expect(recorded.locales).toEqual(['ar']);
  });

  it('falls back to the default locale rather than refusing an unknown one', async () => {
    const recorded = await start(TREE);
    expect((await get('?locale=de')).status).toBe(200);
    expect((await get('?locale=')).status).toBe(200);
    expect((await get()).status).toBe(200);
    expect(recorded.locales).toEqual(['en', 'en', 'en']);
  });

  it('treats an empty catalogue as a successful, empty answer', async () => {
    await start([]);
    const result = await get();
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ categories: [] });
  });

  it('answers 503 when the catalogue cannot be read, and says nothing about why', async () => {
    await start('throws');
    const result = await get();
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ status: 503, code: 'SERVICE_UNAVAILABLE', instance: '/v1/categories' });
    expect(result.raw).not.toContain('unreachable');
    expect(result.raw).not.toContain('Error');
  });

  it('is still behind the internal BFF credential', async () => {
    await start(TREE);
    const result = await get('', null);
    expect(result.status).toBe(403);
  });
});

describe('assembling the tree', () => {
  it('returns nothing for no rows', () => {
    expect(assembleTree([])).toEqual([]);
  });

  it('drops a node whose parent is not in the set rather than promoting it to a root', () => {
    const orphan: CategoryRow = { id: CHILD, parentId: ROOT, slug: 'orphan', name: 'Orphan' };
    expect(assembleTree([orphan])).toEqual([]);
  });

  it('keeps siblings in the order the rows arrived', () => {
    const rows: readonly CategoryRow[] = [
      { id: ROOT, parentId: null, slug: 'b', name: 'B' },
      { id: SECOND_ROOT, parentId: null, slug: 'a', name: 'A' },
    ];
    expect(assembleTree(rows).map((node) => node.slug)).toEqual(['b', 'a']);
  });
});
