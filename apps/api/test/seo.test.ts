import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  RobotsSettingsResponseSchema,
  SITEMAP_PAGE_SIZE,
  SitemapCountsResponseSchema,
  SitemapPageResponseSchema,
} from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { SEO_STORE } from '../src/seo/seo.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * Public SEO delivery at the API boundary.
 *
 * The properties this suite exists for:
 *
 * **No session, ever.** All three reads are driven with no session at all and answer, because a crawler-facing
 * document is the same for everybody. The internal BFF credential is still required, like everywhere under
 * `/v1`, and that is asserted too.
 *
 * **Nothing authored is a 200 with nulls, not a 404.** `seo_settings` ships with no rows, so this is the common
 * answer today and a caller has to be able to tell it apart from a failure.
 *
 * **An entry is a slug, never a URL.** Asserted on the body: only the web app knows the public origin, and an
 * API that built URLs would be the place a misconfigured origin leaked into an authoritative-looking answer.
 *
 * **A page past the end is empty; a path that is not a page is a 400.** The first is a stale index, which is
 * ordinary; the second cannot name anything at all.
 *
 * **A failure is a 503 that quotes nothing.** The store double throws and the body is checked for the absence
 * of the database's own words.
 *
 * **Every kind is reported even when it is empty.** A missing kind and an empty kind must not look the same.
 *
 * Everything is stubbed at the store boundary: no database, no Redis, no network.
 */

let app: NestFastifyApplication | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

interface Call {
  readonly name: string;
  readonly limit?: number;
  readonly offset?: number;
}

interface Doubles {
  readonly robots?: { localeCode: string; body: string | null } | null;
  readonly counts?: readonly { entryType: string; entryCount: number }[];
  readonly entries?: readonly { slug: string; updatedAt: Date; locales?: readonly string[] }[];
  readonly fails?: boolean;
}

const UPDATED = new Date('2026-05-02T09:00:00.000Z');

async function start(doubles: Doubles = {}): Promise<Call[]> {
  const seen: Call[] = [];
  const fail = (): never => {
    throw new Error('relation "app_private.public_sitemap_pages" does not exist');
  };
  const page = (name: string) => async (limit: number, offset: number) => {
    seen.push({ name, limit, offset });
    if (doubles.fails === true) fail();
    return doubles.entries ?? [];
  };

  const store = {
    publicRobotsBody: async () => {
      seen.push({ name: 'publicRobotsBody' });
      if (doubles.fails === true) fail();
      return doubles.robots === undefined ? null : doubles.robots;
    },
    publicSitemapCounts: async () => {
      seen.push({ name: 'publicSitemapCounts' });
      if (doubles.fails === true) fail();
      return (
        doubles.counts ?? [
          { entryType: 'page', entryCount: 3 },
          { entryType: 'listing', entryCount: 2 },
          { entryType: 'service', entryCount: 1 },
          { entryType: 'category', entryCount: 4 },
          { entryType: 'seller', entryCount: 0 },
        ]
      );
    },
    publicSitemapPages: page('publicSitemapPages'),
    publicSitemapListings: page('publicSitemapListings'),
    publicSitemapServices: page('publicSitemapServices'),
    publicSitemapCategories: page('publicSitemapCategories'),
    publicSitemapSellers: page('publicSitemapSellers'),
  };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(TEST_ENV)] })
    .overrideProvider(SEO_STORE)
    .useValue(store)
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

function request(url: string, credential?: string) {
  return app!.inject({
    method: 'GET',
    url,
    headers: { [INTERNAL_CREDENTIAL_HEADER]: credential ?? TEST_INTERNAL_CREDENTIAL },
  });
}

describe('the robots body', () => {
  it('answers with no session at all', async () => {
    await start({ robots: { localeCode: 'en', body: 'User-agent: *\nDisallow: /dashboard' } });
    const response = await request('/v1/seo/robots');
    expect(response.statusCode).toBe(200);
    const body = RobotsSettingsResponseSchema.parse(response.json());
    expect(body).toEqual({ locale: 'en', body: 'User-agent: *\nDisallow: /dashboard' });
  });

  it('says nothing is authored with nulls under a 200, not with a 404', async () => {
    await start({ robots: null });
    const response = await request('/v1/seo/robots');
    expect(response.statusCode).toBe(200);
    expect(RobotsSettingsResponseSchema.parse(response.json())).toEqual({ locale: null, body: null });
  });

  it('treats a blank authored body as nothing authored', async () => {
    await start({ robots: { localeCode: 'en', body: '   \n  ' } });
    expect(RobotsSettingsResponseSchema.parse((await request('/v1/seo/robots')).json()).body).toBeNull();
  });

  it('keeps the body verbatim rather than reformatting it', async () => {
    const authored = 'User-agent: *\nDisallow: /dashboard\n\nUser-agent: BadBot\nDisallow: /';
    await start({ robots: { localeCode: 'en', body: authored } });
    expect(RobotsSettingsResponseSchema.parse((await request('/v1/seo/robots')).json()).body).toBe(authored);
  });

  it('reports no locale it cannot express rather than inventing one', async () => {
    // A third activated language is a code the shared contract has no value for. Null is the honest answer.
    await start({ robots: { localeCode: 'fr', body: 'User-agent: *' } });
    expect(RobotsSettingsResponseSchema.parse((await request('/v1/seo/robots')).json()).locale).toBeNull();
  });

  it('needs the internal credential like every other /v1 route', async () => {
    const seen = await start();
    const response = await request('/v1/seo/robots', 'wrong-credential-value-not-a-real-secret');
    expect(response.statusCode).toBe(403);
    expect(seen).toHaveLength(0);
  });
});

describe('the sitemap index counts', () => {
  it('answers with no session and names every kind', async () => {
    await start();
    const response = await request('/v1/seo/sitemap');
    expect(response.statusCode).toBe(200);
    const body = SitemapCountsResponseSchema.parse(response.json());
    expect(body.pageSize).toBe(SITEMAP_PAGE_SIZE);
    expect(body.counts.map((count) => count.type)).toEqual(['page', 'listing', 'service', 'category', 'seller']);
    expect(body.counts.find((count) => count.type === 'category')?.entries).toBe(4);
  });

  it('reports an empty kind as zero rather than leaving it out', async () => {
    // A kind that disappeared would be indistinguishable from a kind that is empty, and a caller building an
    // index has no way to tell which it is looking at.
    await start({ counts: [{ entryType: 'page', entryCount: 1 }] });
    const body = SitemapCountsResponseSchema.parse((await request('/v1/seo/sitemap')).json());
    expect(body.counts).toHaveLength(5);
    expect(body.counts.filter((count) => count.entries === 0).map((count) => count.type)).toEqual([
      'listing',
      'service',
      'category',
      'seller',
    ]);
  });

  it('ignores a kind it does not answer for', async () => {
    await start({ counts: [{ entryType: 'route', entryCount: 99 }, { entryType: 'page', entryCount: 1 }] });
    const body = SitemapCountsResponseSchema.parse((await request('/v1/seo/sitemap')).json());
    expect(body.counts.map((count) => count.type)).not.toContain('route');
    expect(body.counts.reduce((total, count) => total + count.entries, 0)).toBe(1);
  });

  it('never reports a negative or fractional count', async () => {
    await start({ counts: [{ entryType: 'page', entryCount: -4 }, { entryType: 'listing', entryCount: 2.7 }] });
    const body = SitemapCountsResponseSchema.parse((await request('/v1/seo/sitemap')).json());
    expect(body.counts.find((count) => count.type === 'page')?.entries).toBe(0);
    expect(body.counts.find((count) => count.type === 'listing')?.entries).toBe(2);
  });
});

describe('a page of entries', () => {
  it('serves each kind from its own reader', async () => {
    const seen = await start({ entries: [{ slug: 'walnut-table', updatedAt: UPDATED }] });
    for (const [type, reader] of [
      ['page', 'publicSitemapPages'],
      ['listing', 'publicSitemapListings'],
      ['service', 'publicSitemapServices'],
      ['category', 'publicSitemapCategories'],
      ['seller', 'publicSitemapSellers'],
    ] as const) {
      const response = await request(`/v1/seo/sitemap/${type}/1`);
      expect(response.statusCode, type).toBe(200);
      expect(SitemapPageResponseSchema.parse(response.json()).type, type).toBe(type);
      expect(seen.at(-1)?.name, type).toBe(reader);
    }
  });

  it('is a slug and a time, and never a URL', async () => {
    await start({ entries: [{ slug: 'walnut-table', updatedAt: UPDATED }] });
    const body = SitemapPageResponseSchema.parse((await request('/v1/seo/sitemap/listing/1')).json());
    expect(body.entries).toEqual([{ slug: 'walnut-table', updatedAt: '2026-05-02T09:00:00.000Z' }]);
    // Only the web app knows the origin and the path each surface owns.
    expect(JSON.stringify(body)).not.toContain('http');
    expect(JSON.stringify(body)).not.toContain('/listing/');
  });

  it('turns a page number into the offset the reader is asked for', async () => {
    const seen = await start();
    await request('/v1/seo/sitemap/category/1');
    expect(seen.at(-1)).toEqual({ name: 'publicSitemapCategories', limit: SITEMAP_PAGE_SIZE, offset: 0 });
    await request('/v1/seo/sitemap/category/3');
    expect(seen.at(-1)).toEqual({
      name: 'publicSitemapCategories',
      limit: SITEMAP_PAGE_SIZE,
      offset: SITEMAP_PAGE_SIZE * 2,
    });
  });

  it('echoes the page number back, so a document cannot be mistaken for another', async () => {
    await start();
    expect(SitemapPageResponseSchema.parse((await request('/v1/seo/sitemap/seller/7')).json()).page).toBe(7);
  });

  it('answers a page past the end with an empty page rather than a 404', async () => {
    // The index a crawler is following may be minutes old and the set may have shrunk since.
    await start({ entries: [] });
    const response = await request('/v1/seo/sitemap/listing/9999');
    expect(response.statusCode).toBe(200);
    expect(SitemapPageResponseSchema.parse(response.json()).entries).toEqual([]);
  });

  it('carries the locales of a page, and nothing for the other kinds', async () => {
    await start({ entries: [{ slug: 'cookies', updatedAt: UPDATED, locales: ['ar'] }] });
    const pages = SitemapPageResponseSchema.parse((await request('/v1/seo/sitemap/page/1')).json());
    expect(pages.entries[0]?.locales).toEqual(['ar']);
  });

  it('drops a locale the public surfaces do not exist for', async () => {
    await start({ entries: [{ slug: 'terms', updatedAt: UPDATED, locales: ['en', 'fr', 'ar'] }] });
    const pages = SitemapPageResponseSchema.parse((await request('/v1/seo/sitemap/page/1')).json());
    expect(pages.entries[0]?.locales).toEqual(['en', 'ar']);
  });

  it('refuses a kind of address there is no sitemap for', async () => {
    const seen = await start();
    for (const type of ['route', 'blog', 'listings', 'LISTING', '..', '']) {
      const response = await request(`/v1/seo/sitemap/${type}/1`);
      expect(response.statusCode, type).toBeGreaterThanOrEqual(400);
      expect(response.statusCode, type).toBeLessThan(500);
    }
    expect(seen.filter((call) => call.name.startsWith('publicSitemap'))).toHaveLength(0);
  });

  it('refuses anything that is not a page number, rather than coercing it', async () => {
    // `Number('')` is zero and `parseInt('3x')` is three: either would quietly serve the wrong page of a
    // document a crawler then treats as the whole truth.
    const seen = await start();
    for (const page of ['0', '-1', '1.5', '3x', 'one', '', '01', '99999999']) {
      const response = await request(`/v1/seo/sitemap/listing/${page}`);
      expect(response.statusCode, page).toBeGreaterThanOrEqual(400);
      expect(response.statusCode, page).toBeLessThan(500);
    }
    expect(seen.filter((call) => call.name.startsWith('publicSitemap'))).toHaveLength(0);
  });

  it('needs the internal credential', async () => {
    const seen = await start();
    const response = await request('/v1/seo/sitemap/listing/1', 'wrong-credential-value-not-a-real-secret');
    expect(response.statusCode).toBe(403);
    expect(seen).toHaveLength(0);
  });
});

describe('when the database cannot be read', () => {
  it('answers 503 on every one of the three reads', async () => {
    await start({ fails: true });
    for (const url of ['/v1/seo/robots', '/v1/seo/sitemap', '/v1/seo/sitemap/listing/1']) {
      expect((await request(url)).statusCode, url).toBe(503);
    }
  });

  it('never answers an empty document instead, which a crawler would believe', async () => {
    await start({ fails: true });
    const response = await request('/v1/seo/sitemap/listing/1');
    expect(response.statusCode).not.toBe(200);
  });

  it('quotes nothing the database said', async () => {
    await start({ fails: true });
    const text = (await request('/v1/seo/sitemap')).body;
    expect(text).not.toContain('app_private');
    expect(text).not.toContain('does not exist');
    expect(text).not.toContain('relation');
    expect(JSON.parse(text)).toMatchObject({ status: 503, code: 'SERVICE_UNAVAILABLE' });
  });
});

describe('the surface has no other verbs', () => {
  it('accepts no write on any of the three paths', async () => {
    await start();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      for (const url of ['/v1/seo/robots', '/v1/seo/sitemap', '/v1/seo/sitemap/listing/1']) {
        const response = await app!.inject({
          method,
          url,
          headers: { [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL },
        });
        expect(response.statusCode, `${method} ${url}`).toBe(404);
      }
    }
  });
});
