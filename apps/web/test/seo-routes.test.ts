import type { ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startBuiltApp, type RunningApp } from './support/next-server.js';
import { startStubApi, type StubApi } from './support/stub-api.js';

/**
 * `robots.txt` and the sitemaps, over real HTTP against the built app.
 *
 * What only a test over real HTTP can prove, and what this suite exists for:
 *
 * **These three addresses are not locale-routed.** next-intl rewrites an unprefixed path to `/en/…`, which would
 * send `/robots.txt` to a handler that does not exist. The middleware exempts them, and that exemption is what
 * these assertions hold in place.
 *
 * **The URLs are absolute and built from `PUBLIC_WEB_ORIGIN`** — the configured origin, not the host the request
 * arrived on. The app under test is reached at `127.0.0.1` while the configured origin is something else
 * entirely, so every assertion about a `<loc>` is also an assertion that the `Host` header was ignored.
 *
 * **A failure is a 503 and never an empty document.** An empty sitemap under a 200 tells a crawler the site has
 * no pages, which it may act on.
 *
 * **Nothing here is indexable itself**, and the deny-by-default robots header still covers these paths.
 *
 * No browser, no Playwright, no live provider, no deployment.
 */

const CANARY_CREDENTIAL = 'test-web-seo-canary-credential-not-real-xyz';
/** Deliberately not the address the app is served on: `.test` is reserved and resolves nowhere. */
const ORIGIN = 'https://seo.test';

let api: StubApi;
let app: RunningApp;

beforeAll(async () => {
  api = await startStubApi();
  app = await startBuiltApp({
    API_BASE_URL: api.baseUrl,
    INTERNAL_BFF_CREDENTIAL: CANARY_CREDENTIAL,
    PUBLIC_WEB_ORIGIN: ORIGIN,
  });
}, 120_000);

afterAll(async () => {
  await app.stop();
  await api.stop();
});

function json(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function problem(response: ServerResponse, status: number): void {
  response.writeHead(status, { 'content-type': 'application/problem+json' });
  response.end(JSON.stringify({ status, code: 'SERVICE_UNAVAILABLE' }));
}

interface Serve {
  readonly robots?: { locale: string | null; body: string | null };
  readonly counts?: { pageSize: number; counts: { type: string; entries: number }[] };
  readonly entries?: Record<string, { slug: string; updatedAt: string; locales?: string[] }[]>;
  readonly fails?: boolean;
}

const DEFAULT_COUNTS = {
  pageSize: 5000,
  counts: [
    { type: 'page', entries: 2 },
    { type: 'listing', entries: 1 },
    { type: 'service', entries: 0 },
    { type: 'category', entries: 1 },
    { type: 'seller', entries: 0 },
  ],
};

function apiServes(serve: Serve = {}): void {
  api.seen.length = 0;
  api.reply((request, response) => {
    const path = request.url.split('?')[0] ?? '';
    if (serve.fails === true) return problem(response, 503);

    if (path === '/v1/seo/robots') {
      return json(response, serve.robots ?? { locale: null, body: null });
    }
    if (path === '/v1/seo/sitemap') {
      return json(response, serve.counts ?? DEFAULT_COUNTS);
    }
    const child = /^\/v1\/seo\/sitemap\/([a-z]+)\/([0-9]+)$/.exec(path);
    if (child !== null) {
      const type = child[1] ?? '';
      const page = Number(child[2] ?? '1');
      return json(response, {
        type,
        page,
        pageSize: 5000,
        entries: serve.entries?.[type] ?? [],
      });
    }
    return problem(response, 404);
  });
}

beforeEach(() => {
  apiServes();
});

async function get(path: string): Promise<{ status: number; type: string | null; robots: string | null; text: string }> {
  const response = await fetch(`${app.baseUrl}${path}`, { redirect: 'manual' });
  return {
    status: response.status,
    type: response.headers.get('content-type'),
    robots: response.headers.get('x-robots-tag'),
    text: await response.text(),
  };
}

describe('robots.txt', () => {
  it('is served as plain text at its own address, unrewritten by locale routing', async () => {
    const response = await get('/robots.txt');
    expect(response.status).toBe(200);
    expect(response.type).toContain('text/plain');
    // Not locale-routed: a rewrite to `/en/robots.txt` would have been a 404 here.
    expect(response.text).not.toContain('<html');
  });

  it('names the sitemap on the configured origin, not on the host the request arrived at', async () => {
    const response = await get('/robots.txt');
    expect(response.text).toBe('Sitemap: https://seo.test/sitemap.xml\n');
    expect(response.text).not.toContain('127.0.0.1');
  });

  it('serves an authored body verbatim with the sitemap appended', async () => {
    apiServes({ robots: { locale: 'en', body: 'User-agent: *\nDisallow: /dashboard' } });
    const response = await get('/robots.txt');
    expect(response.text).toBe('User-agent: *\nDisallow: /dashboard\n\nSitemap: https://seo.test/sitemap.xml\n');
  });

  it('answers 503 rather than an empty policy when the API cannot be read', async () => {
    apiServes({ fails: true });
    const response = await get('/robots.txt');
    expect(response.status).toBe(503);
    expect(response.text).not.toContain('Sitemap:');
  });

  it('is not itself indexable', async () => {
    expect((await get('/robots.txt')).robots).toBe('noindex');
  });

  it('has no /ar twin, because it is one document for the origin', async () => {
    expect((await get('/ar/robots.txt')).status).toBe(404);
  });
});

describe('the sitemap index', () => {
  it('is a sitemapindex at /sitemap.xml, naming only the children that exist', async () => {
    const response = await get('/sitemap.xml');
    expect(response.status).toBe(200);
    expect(response.type).toContain('application/xml');
    expect(response.text).toContain('<sitemapindex');
    expect(response.text).toContain('https://seo.test/sitemaps/route/1');
    expect(response.text).toContain('https://seo.test/sitemaps/page/1');
    expect(response.text).toContain('https://seo.test/sitemaps/listing/1');
    expect(response.text).toContain('https://seo.test/sitemaps/category/1');
    // Two kinds have nothing in them, so the index names no child for either.
    expect(response.text).not.toContain('/sitemaps/service/');
    expect(response.text).not.toContain('/sitemaps/seller/');
  });

  it('is a urlset nowhere: an index names documents, not addresses', async () => {
    expect((await get('/sitemap.xml')).text).not.toContain('<urlset');
  });

  it('answers 503 rather than an empty index when the API cannot be read', async () => {
    apiServes({ fails: true });
    const response = await get('/sitemap.xml');
    expect(response.status).toBe(503);
    expect(response.text).not.toContain('sitemapindex');
  });

  it('is not itself indexable, and is not locale-routed', async () => {
    expect((await get('/sitemap.xml')).robots).toBe('noindex');
    expect((await get('/ar/sitemap.xml')).status).toBe(404);
  });
});

describe('a child sitemap', () => {
  it('lists entries as absolute URLs in both locales, with hreflang alternates', async () => {
    apiServes({
      entries: { listing: [{ slug: 'walnut-table', updatedAt: '2026-05-02T09:00:00.000Z' }] },
    });
    const response = await get('/sitemaps/listing/1');
    expect(response.status).toBe(200);
    expect(response.type).toContain('application/xml');
    expect(response.text).toContain('<loc>https://seo.test/listing/walnut-table</loc>');
    expect(response.text).toContain('<loc>https://seo.test/ar/listing/walnut-table</loc>');
    expect(response.text).toContain('hreflang="en"');
    expect(response.text).toContain('hreflang="ar"');
    expect(response.text).toContain('<lastmod>2026-05-02T09:00:00.000Z</lastmod>');
  });

  it('lists a CMS page only in the languages it answers in', async () => {
    apiServes({
      entries: { page: [{ slug: 'cookies', updatedAt: '2026-05-02T09:00:00.000Z', locales: ['ar'] }] },
    });
    const response = await get('/sitemaps/page/1');
    expect(response.text).toContain('<loc>https://seo.test/ar/cookies</loc>');
    expect(response.text).not.toContain('<loc>https://seo.test/cookies</loc>');
  });

  it('serves the fixed landing routes without asking the API at all', async () => {
    apiServes();
    const response = await get('/sitemaps/route/1');
    expect(response.status).toBe(200);
    expect(response.text).toContain('<loc>https://seo.test/listings</loc>');
    expect(response.text).toContain('<loc>https://seo.test/ar/services</loc>');
    // The home page keeps its blanket noindex, so it is advertised nowhere.
    expect(response.text).not.toContain('<loc>https://seo.test/</loc>');
    expect(api.seen.filter((entry) => entry.url.startsWith('/v1/seo/sitemap/'))).toHaveLength(0);
  });

  it('answers an empty urlset for a page past the end', async () => {
    apiServes({ entries: { listing: [] } });
    const response = await get('/sitemaps/listing/9999');
    expect(response.status).toBe(200);
    expect(response.text).toContain('<urlset');
    expect(response.text).not.toContain('<url>');
  });

  it('is a 404 for a kind of address there is no sitemap for', async () => {
    for (const path of ['/sitemaps/blog/1', '/sitemaps/routes/1', '/sitemaps/LISTING/1', '/sitemaps/listings/1']) {
      expect((await get(path)).status, path).toBe(404);
    }
  });

  it('is a 404 for anything that is not a page number', async () => {
    for (const path of ['/sitemaps/listing/0', '/sitemaps/listing/-1', '/sitemaps/listing/1.5', '/sitemaps/listing/x']) {
      expect((await get(path)).status, path).toBe(404);
    }
  });

  it('answers 503 rather than an empty document when the API cannot be read', async () => {
    apiServes({ fails: true });
    const response = await get('/sitemaps/listing/1');
    expect(response.status).toBe(503);
    expect(response.text).not.toContain('<urlset');
  });

  it('is not indexable, and is not locale-routed', async () => {
    expect((await get('/sitemaps/route/1')).robots).toBe('noindex');
    expect((await get('/ar/sitemaps/route/1')).status).toBe(404);
  });

  it('never reveals anything the API said about a failure', async () => {
    apiServes({ fails: true });
    const response = await get('/sitemaps/listing/1');
    expect(response.text).not.toContain('SERVICE_UNAVAILABLE');
    expect(response.text).not.toContain('app_private');
  });
});

/**
 * The same app, booted the way it runs today: with no production domain configured.
 *
 * This is the state the owner deferred to, and the assertions that matter are about what does **not** happen. No
 * origin is guessed from the request — not from `Host`, not from `X-Forwarded-Host`, not from localhost — so the
 * sitemaps stand down rather than publishing a document pointing at whatever host the request arrived on. A
 * forged `Host` header is sent on purpose to prove it, because that is exactly the attack a host fallback opens.
 */
describe('while no production domain is configured', () => {
  let deferred: RunningApp;

  beforeAll(async () => {
    deferred = await startBuiltApp({
      API_BASE_URL: api.baseUrl,
      INTERNAL_BFF_CREDENTIAL: CANARY_CREDENTIAL,
      // PUBLIC_WEB_ORIGIN is deliberately absent.
    });
  }, 120_000);

  afterAll(async () => {
    await deferred.stop();
  });

  async function fromDeferred(path: string, headers: Record<string, string> = {}) {
    const response = await fetch(`${deferred.baseUrl}${path}`, { redirect: 'manual', headers });
    return { status: response.status, type: response.headers.get('content-type'), text: await response.text() };
  }

  it('starts and serves the site normally', async () => {
    apiServes();
    expect((await fromDeferred('/listings')).status).toBe(200);
    expect((await fromDeferred('/nope')).status).toBe(404);
  });

  it('still serves robots.txt, because that document needs no absolute URL of its own', async () => {
    apiServes({ robots: { locale: 'en', body: 'User-agent: *\nDisallow: /dashboard' } });
    const response = await fromDeferred('/robots.txt');
    expect(response.status).toBe(200);
    expect(response.type).toContain('text/plain');
    // Everything the administrator authored, and no Sitemap line, because there is no sitemap to announce.
    expect(response.text).toBe('User-agent: *\nDisallow: /dashboard\n');
  });

  it('serves a comment rather than a directive when nothing is authored', async () => {
    apiServes();
    expect((await fromDeferred('/robots.txt')).text).toBe('# No crawl directives are configured.\n');
  });

  it('answers 404 for the sitemap index and every child', async () => {
    apiServes();
    for (const path of ['/sitemap.xml', '/sitemaps/route/1', '/sitemaps/listing/1', '/sitemaps/page/1']) {
      const response = await fromDeferred(path);
      expect(response.status, path).toBe(404);
      expect(response.text, path).not.toContain('<urlset');
      expect(response.text, path).not.toContain('<sitemapindex');
    }
  });

  it('never reads the API for a document it cannot build', async () => {
    apiServes();
    api.seen.length = 0;
    await fromDeferred('/sitemap.xml');
    await fromDeferred('/sitemaps/listing/1');
    expect(api.seen.filter((entry) => entry.url.startsWith('/v1/seo/sitemap'))).toHaveLength(0);
  });

  it('names no host anywhere, however the request asks', async () => {
    apiServes();
    // A forged Host and X-Forwarded-Host: the exact input a host fallback would turn into a published origin.
    const headers = { host: 'evil.example', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' };
    const robots = await fromDeferred('/robots.txt', headers);
    expect(robots.status).toBe(200);
    expect(robots.text).not.toContain('evil.example');
    expect(robots.text).not.toContain('Sitemap:');
    expect(robots.text).not.toContain('127.0.0.1');
    expect(robots.text).not.toContain('localhost');

    const sitemap = await fromDeferred('/sitemap.xml', headers);
    expect(sitemap.status).toBe(404);
    expect(sitemap.text).not.toContain('evil.example');
  });

  it('turns on with nothing but the variable set', async () => {
    // The same build, the same code path, one variable added: the configured app in the suites above is this
    // app with PUBLIC_WEB_ORIGIN present, and it serves the full index and children.
    apiServes();
    expect((await get('/sitemap.xml')).status).toBe(200);
    expect((await get('/sitemap.xml')).text).toContain('<sitemapindex');
    expect((await get('/robots.txt')).text).toContain('Sitemap: https://seo.test/sitemap.xml');
  });
});

describe('the catalogue pages are unaffected', () => {
  it('still answers on a public catalogue route', async () => {
    // The middleware gained a branch; this is the assertion that it gained nothing else.
    apiServes();
    const response = await fetch(`${app.baseUrl}/listings`, { redirect: 'manual' });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-robots-tag')).toBeNull();
  });

  it('still serves the localized 404 for an unknown address', async () => {
    const response = await get('/nope');
    expect(response.status).toBe(404);
    expect(response.text).toContain('Page not found');
  });
});
