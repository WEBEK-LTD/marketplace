import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { CategoryFeedResponseSchema, SearchResponseSchema } from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import {
  CATEGORY_FEED_PORT,
  type CategoryFacetRow,
  type CategoryFeedPort,
} from '../src/catalog/category-feed.service.js';
import { SEARCH_PORT, type SearchRow } from '../src/catalog/search.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * `GET /v1/categories/:slug/listings`, and the filters search now shares with it (Phase 8-D).
 *
 * The database decides what is findable, what a filter means and what a count counts; 0089's own suite
 * proves all of that. These tests are about the boundary above it:
 *
 * **The filter document that reaches the port is the one the query string said**, including the parts no
 * decorator can name — a repeated dimension (`tag=a&tag=b`) and an attribute under a key only the
 * vocabulary knows (`attr.material=oak`).
 *
 * **A malformed filter is a 400; a well-formed one naming nothing real is not.** The second travels to the
 * database, because dropping it here would answer a wider question than the visitor asked.
 *
 * **Search and the feed send the same document**, asserted by driving both with the same query string.
 *
 * **Facet rows become dimensions**, with a number carrying a span and no values, a currency carrying its
 * own decimal places, and a row in a shape this API does not know dropped rather than forwarded.
 *
 * **An empty page is not a 404**, and the two empties stay distinguishable: no items with facets is a
 * category whose filters match nothing, no items without facets is a category with nothing in it.
 *
 * Everything is stubbed at the port boundary: no database, no Redis, no network.
 */

function listingRow(n: number, minutesAgo: number): SearchRow {
  return {
    resultType: 'listing',
    id: `2222${String(n).padStart(4, '0')}-0000-4000-8000-000000000001`,
    slug: `feed-listing-${n}`,
    title: 'Oak dining table',
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
    id: `3333${String(n).padStart(4, '0')}-0000-4000-8000-000000000001`,
    slug: `feed-service-${n}`,
    title: 'Table restoration',
    city: 'Cairo',
    priceMinor: '400000',
    currencyCode: 'EGP',
    currencyMinorUnit: 2,
    isNegotiable: null,
    listingTypeCode: null,
    pricingModel: 'fixed',
    deliveryDays: 7,
    revisionsIncluded: 2,
    createdAt: new Date(Date.UTC(2026, 0, 1, 12, 0, 0) - minutesAgo * 60_000),
  };
}

function facet(row: Partial<CategoryFacetRow>): CategoryFacetRow {
  return {
    facetKind: 'tag',
    attributeKey: null,
    attributeLabel: null,
    dataType: null,
    unit: null,
    attributeSortOrder: 0,
    value: null,
    label: null,
    valueSortOrder: 0,
    matchCount: 0,
    numberMin: null,
    numberMax: null,
    ...row,
  };
}

/** The panel 0089 would return for a category asking about a select, a boolean, a number, tags and prices. */
const FACET_ROWS: CategoryFacetRow[] = [
  facet({ facetKind: 'attribute', attributeKey: 'material', attributeLabel: 'Material', dataType: 'single_select', attributeSortOrder: 1, value: 'oak', label: 'Oak', valueSortOrder: 1, matchCount: 3 }),
  facet({ facetKind: 'attribute', attributeKey: 'material', attributeLabel: 'Material', dataType: 'single_select', attributeSortOrder: 1, value: 'pine', label: 'Pine', valueSortOrder: 2, matchCount: 0 }),
  facet({ facetKind: 'attribute', attributeKey: 'boxed', attributeLabel: 'Boxed', dataType: 'boolean', attributeSortOrder: 2, value: 'true', label: 'true', valueSortOrder: 0, matchCount: 2 }),
  facet({ facetKind: 'attribute', attributeKey: 'boxed', attributeLabel: 'Boxed', dataType: 'boolean', attributeSortOrder: 2, value: 'false', label: 'false', valueSortOrder: 1, matchCount: 1 }),
  facet({ facetKind: 'attribute', attributeKey: 'width', attributeLabel: 'Width', dataType: 'number', unit: 'cm', attributeSortOrder: 3, value: null, label: null, matchCount: 3, numberMin: '120', numberMax: '200' }),
  facet({ facetKind: 'tag', value: 'handmade', label: 'Handmade', matchCount: 2 }),
  facet({ facetKind: 'tag', value: 'vintage', label: 'Vintage', matchCount: 1 }),
  facet({ facetKind: 'listing_type', value: 'product', label: 'product', matchCount: 3 }),
  facet({ facetKind: 'listing_type', value: 'service', label: 'service', matchCount: 1 }),
  facet({ facetKind: 'currency', value: 'EGP', label: 'EGP', valueSortOrder: 2, matchCount: 4, numberMin: '10000', numberMax: '400000' }),
];

interface Seen {
  readonly name: string;
  readonly input: unknown;
}

interface Doubles {
  readonly rows?: readonly SearchRow[];
  readonly facets?: readonly CategoryFacetRow[];
  readonly fails?: boolean;
}

let app: NestFastifyApplication | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(doubles: Doubles = {}): Promise<Seen[]> {
  const seen: Seen[] = [];

  const feedPort: CategoryFeedPort = {
    publicCategoryFeed: async (input) => {
      seen.push({ name: 'publicCategoryFeed', input });
      if (doubles.fails === true) throw new Error('the database could not be reached');
      return doubles.rows ?? [listingRow(1, 10), serviceRow(1, 20)];
    },
    publicCategoryFacets: async (input) => {
      seen.push({ name: 'publicCategoryFacets', input });
      if (doubles.fails === true) throw new Error('the database could not be reached');
      return doubles.facets ?? FACET_ROWS;
    },
  };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(TEST_ENV)] })
    .overrideProvider(CATEGORY_FEED_PORT)
    .useValue(feedPort)
    .overrideProvider(SEARCH_PORT)
    .useValue({
      publicSearch: async (input: unknown) => {
        seen.push({ name: 'publicSearch', input });
        return doubles.rows ?? [listingRow(1, 10)];
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
  return seen;
}

function get(url: string, credential: string = TEST_INTERNAL_CREDENTIAL) {
  return app!.inject({ method: 'GET', url, headers: { [INTERNAL_CREDENTIAL_HEADER]: credential } });
}

describe('who may read a category feed', () => {
  it('serves it to anybody behind the internal credential: there is no session here', async () => {
    await start();
    const response = await get('/v1/categories/furniture/listings');
    expect(response.statusCode).toBe(200);
    expect(CategoryFeedResponseSchema.parse(response.json()).items).toHaveLength(2);
  });

  it('refuses a request without the internal credential', async () => {
    await start();
    const response = await get('/v1/categories/furniture/listings', 'wrong');
    expect(response.statusCode).toBe(403);
  });

  it('asks nothing about a caller, because the answer is the same for everyone', async () => {
    const seen = await start();
    await get('/v1/categories/furniture/listings');
    for (const entry of seen) {
      expect(JSON.stringify(entry.input)).not.toContain('user');
      expect(JSON.stringify(entry.input)).not.toContain('aal');
    }
  });
});

describe('the page', () => {
  it('returns the mixed result set with each surface’s own card fields', async () => {
    await start();
    const body = CategoryFeedResponseSchema.parse((await get('/v1/categories/furniture/listings')).json());
    const listing = body.items.find((item) => item.type === 'listing');
    const service = body.items.find((item) => item.type === 'service');
    expect(listing).toMatchObject({ isNegotiable: false, listingTypeCode: 'product' });
    expect(service).toMatchObject({ pricingModel: 'fixed', deliveryDays: 7, revisionsIncluded: 2 });
  });

  it('reads one row more than the page size, so the last page says it is the last', async () => {
    const seen = await start({ rows: [listingRow(1, 10), listingRow(2, 20)] });
    const body = CategoryFeedResponseSchema.parse(
      (await get('/v1/categories/furniture/listings?limit=2')).json(),
    );
    expect(seen.find((entry) => entry.name === 'publicCategoryFeed')?.input).toMatchObject({ limit: 3 });
    expect(body.nextCursor).toBeNull();
  });

  it('offers a cursor when there is another page, and takes it back', async () => {
    const seen = await start({ rows: [listingRow(1, 10), listingRow(2, 20), listingRow(3, 30)] });
    const first = CategoryFeedResponseSchema.parse(
      (await get('/v1/categories/furniture/listings?limit=2')).json(),
    );
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await get(
      `/v1/categories/furniture/listings?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
    );
    expect(second.statusCode).toBe(200);
    const sent = seen.filter((entry) => entry.name === 'publicCategoryFeed').at(-1)?.input as {
      cursorCreatedAt: Date | null;
      cursorId: string | null;
    };
    expect(sent.cursorCreatedAt).toBeInstanceOf(Date);
    expect(sent.cursorId).not.toBeNull();
  });

  it('refuses a cursor that is not one of ours', async () => {
    await start();
    const response = await get('/v1/categories/furniture/listings?cursor=not-a-cursor');
    expect(response.statusCode).toBe(400);
  });

  it('refuses a page size outside the contract', async () => {
    await start();
    for (const limit of ['0', '-1', '51', 'many', '1.5']) {
      const response = await get(`/v1/categories/furniture/listings?limit=${limit}`);
      expect(response.statusCode, limit).toBe(400);
    }
  });

  it('is 200 with no items and no facets for a category with nothing in it', async () => {
    await start({ rows: [], facets: [] });
    const response = await get('/v1/categories/empty-shelf/listings');
    expect(response.statusCode).toBe(200);
    const body = CategoryFeedResponseSchema.parse(response.json());
    expect(body.items).toEqual([]);
    expect(body.facets).toEqual([]);
  });

  it('is 200 with no items but a panel when the filters match nothing', async () => {
    await start({ rows: [] });
    const body = CategoryFeedResponseSchema.parse(
      (await get('/v1/categories/furniture/listings?tag=handmade')).json(),
    );
    expect(body.items).toEqual([]);
    expect(body.facets.length).toBeGreaterThan(0);
  });

  it('answers 503 when the catalogue cannot be read, rather than an empty shelf', async () => {
    await start({ fails: true });
    const response = await get('/v1/categories/furniture/listings');
    expect(response.statusCode).toBe(503);
  });

  it('passes the slug through untouched, and resolves visibility nowhere but the database', async () => {
    const seen = await start();
    await get('/v1/categories/winter-coats/listings');
    expect(seen.find((entry) => entry.name === 'publicCategoryFeed')?.input).toMatchObject({
      slug: 'winter-coats',
    });
  });
});

describe('the filter document that reaches the database', () => {
  const sentTo = (seen: Seen[], name: string): Record<string, unknown> =>
    (seen.find((entry) => entry.name === name)?.input ?? {}) as Record<string, unknown>;

  it('is empty when nothing was asked', async () => {
    const seen = await start();
    await get('/v1/categories/furniture/listings');
    expect(sentTo(seen, 'publicCategoryFeed').filters).toEqual({});
  });

  it('carries the listing type', async () => {
    const seen = await start();
    await get('/v1/categories/furniture/listings?type=service');
    expect(sentTo(seen, 'publicCategoryFeed').filters).toEqual({ listingType: 'service' });
  });

  it('carries a repeated dimension as the alternatives it is', async () => {
    const seen = await start();
    await get('/v1/categories/furniture/listings?tag=handmade&tag=vintage');
    expect(sentTo(seen, 'publicCategoryFeed').filters).toEqual({ tags: ['handmade', 'vintage'] });
  });

  it('carries an attribute named under a key only the vocabulary knows', async () => {
    const seen = await start();
    await get('/v1/categories/furniture/listings?attr.material=oak&attr.material=pine');
    expect(sentTo(seen, 'publicCategoryFeed').filters).toEqual({
      attributes: [{ key: 'material', options: ['oak', 'pine'] }],
    });
  });

  it('carries a boolean, a range and a price together', async () => {
    const seen = await start();
    await get(
      '/v1/categories/furniture/listings?attr.boxed=true&attr.width.min=120&attr.width.max=200' +
        '&price.currency=EGP&price.min=1000&price.max=500000',
    );
    const filters = sentTo(seen, 'publicCategoryFeed').filters as Record<string, unknown>;
    expect(filters.attributes).toEqual([
      { key: 'boxed', boolean: true },
      { key: 'width', min: 120, max: 200 },
    ]);
    expect(filters.price).toEqual({ currency: 'EGP', min: '1000', max: '500000' });
  });

  it('sends the same document to the facets as to the feed, so the counts match the page', async () => {
    const seen = await start();
    await get('/v1/categories/furniture/listings?tag=handmade&attr.boxed=true');
    expect(sentTo(seen, 'publicCategoryFacets').filters).toEqual(
      sentTo(seen, 'publicCategoryFeed').filters,
    );
  });

  it('sends a well-formed value that names nothing real, rather than dropping it', async () => {
    const seen = await start({ rows: [] });
    await get('/v1/categories/furniture/listings?tag=no-such-tag-at-all');
    expect(sentTo(seen, 'publicCategoryFeed').filters).toEqual({ tags: ['no-such-tag-at-all'] });
  });

  it('refuses a malformed filter before the database is asked', async () => {
    const malformed = [
      'type=vehicle',
      'type=product&type=service',
      'tag=Handmade',
      'attr.Material=oak',
      'attr.=oak',
      'attr.width.min=cheap',
      'attr.width.min=200&attr.width.max=100',
      'attr.width=oak&attr.width.min=10',
      'price.min=1000',
      'price.currency=EGP&price.min=10.5',
      'price.currency=egp',
      'price.currency=EGP&price.min=500&price.max=100',
    ];
    for (const query of malformed) {
      const seen = await start();
      const response = await get(`/v1/categories/furniture/listings?${query}`);
      expect(response.statusCode, query).toBe(400);
      expect(seen.filter((entry) => entry.name === 'publicCategoryFeed'), query).toHaveLength(0);
      await app?.close();
      app = undefined;
    }
  });

  it('ignores the parameters that belong to the page rather than to the filters', async () => {
    const seen = await start();
    await get('/v1/categories/furniture/listings?limit=10&locale=ar&utm_source=newsletter');
    expect(sentTo(seen, 'publicCategoryFeed').filters).toEqual({});
    expect(sentTo(seen, 'publicCategoryFacets').locale).toBe('ar');
  });

  it('resolves an unknown locale to the default rather than failing', async () => {
    const seen = await start();
    const response = await get('/v1/categories/furniture/listings?locale=zz');
    expect(response.statusCode).toBe(200);
    expect(sentTo(seen, 'publicCategoryFacets').locale).toBe('en');
  });
});

describe('search takes the identical document', () => {
  it('sends the filters a query string named', async () => {
    const seen = await start();
    const response = await get('/v1/search?q=table&tag=handmade&attr.material=oak&type=product');
    expect(response.statusCode).toBe(200);
    expect(SearchResponseSchema.parse(response.json()).items).toHaveLength(1);
    expect((seen.find((entry) => entry.name === 'publicSearch')?.input as Record<string, unknown>).filters).toEqual({
      listingType: 'product',
      tags: ['handmade'],
      attributes: [{ key: 'material', options: ['oak'] }],
    });
  });

  it('refuses a malformed filter on search too', async () => {
    const seen = await start();
    const response = await get('/v1/search?q=table&price.min=1000');
    expect(response.statusCode).toBe(400);
    expect(seen.filter((entry) => entry.name === 'publicSearch')).toHaveLength(0);
  });

  it('still refuses a query too short to run, filters or not', async () => {
    await start();
    expect((await get('/v1/search?q=a&tag=handmade')).statusCode).toBe(400);
  });
});

describe('the facet panel', () => {
  const panel = async () =>
    CategoryFeedResponseSchema.parse((await get('/v1/categories/furniture/listings')).json()).facets;

  it('groups an attribute’s values into one dimension, in the order the database gave them', async () => {
    await start();
    const facets = await panel();
    const material = facets.find((candidate) => candidate.key === 'material');
    expect(material).toMatchObject({ kind: 'attribute', label: 'Material', dataType: 'single_select' });
    expect(material?.values.map((value) => value.value)).toEqual(['oak', 'pine']);
  });

  it('keeps a value whose count is zero, so a visitor can always undo their own filter', async () => {
    await start();
    const material = (await panel()).find((candidate) => candidate.key === 'material');
    expect(material?.values.find((value) => value.value === 'pine')?.matchCount).toBe(0);
  });

  it('gives a number a span and no values, because bounds are not buckets', async () => {
    await start();
    const width = (await panel()).find((candidate) => candidate.key === 'width');
    expect(width).toMatchObject({ dataType: 'number', unit: 'cm', rangeMin: '120', rangeMax: '200' });
    expect(width?.values).toEqual([]);
  });

  it('gives a boolean both of its answers', async () => {
    await start();
    const boxed = (await panel()).find((candidate) => candidate.key === 'boxed');
    expect(boxed?.values.map((value) => value.value)).toEqual(['true', 'false']);
  });

  it('puts every tag in one dimension and every listing type in another', async () => {
    await start();
    const facets = await panel();
    expect(facets.find((candidate) => candidate.kind === 'tag')?.values).toHaveLength(2);
    expect(facets.find((candidate) => candidate.kind === 'listing_type')?.values).toHaveLength(2);
  });

  it('gives a currency its own dimension, with its decimal places and its price span', async () => {
    await start();
    const currency = (await panel()).find((candidate) => candidate.kind === 'currency');
    expect(currency).toMatchObject({ minorUnit: 2, rangeMin: '10000', rangeMax: '400000' });
    expect(currency?.values[0]?.value).toBe('EGP');
  });

  it('drops a row in a shape this API does not know, rather than forwarding it', async () => {
    await start({
      facets: [
        ...FACET_ROWS,
        facet({ facetKind: 'distance', value: '5km', label: '5km', matchCount: 1 }),
        facet({ facetKind: 'attribute', attributeKey: 'mystery', dataType: 'colour', value: 'red', label: 'Red' }),
      ],
    });
    const facets = await panel();
    expect(JSON.stringify(facets)).not.toContain('distance');
    expect(JSON.stringify(facets)).not.toContain('mystery');
  });

  it('carries no identifier of an attribute, an option or a listing anywhere in the panel', async () => {
    await start();
    const body = (await get('/v1/categories/furniture/listings')).json();
    expect(JSON.stringify(body.facets)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/);
  });
});
