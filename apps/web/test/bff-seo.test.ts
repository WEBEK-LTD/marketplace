import { describe, expect, it } from 'vitest';
import { readRobotsSettings, readSitemapCounts, readSitemapPage } from '../src/server/bff/seo';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/server/bff/internal-credential';

/**
 * The BFF half of public SEO delivery.
 *
 * One credentialled internal call per read, with the answer checked against the shared contract before any
 * document is built from it. What matters:
 *
 * **A failure is `null`, never an empty answer.** An empty sitemap served under a 200 tells a crawler the site
 * has no pages; "nothing authored" is a different thing and arrives as nulls inside a valid body. The two must
 * not collapse into each other, which is why this suite drives both.
 *
 * **A drifted body is refused.** It would otherwise become malformed XML in a document crawlers parse strictly,
 * or a URL built from a slug that is not slug-shaped.
 *
 * **The echoed type and page are checked.** If the API answers for a different document than the one asked for,
 * something is serving the wrong contents, and a wrong sitemap is worse than none.
 */

const ENV = {
  API_BASE_URL: 'https://api.test',
  INTERNAL_BFF_CREDENTIAL: 'test-current-credential-value-not-a-real-se',
  PUBLIC_WEB_ORIGIN: 'https://web.test',
} as const;

interface Seen {
  url: string;
  method: string;
  credential: string | null;
}

function apiReturns(status: number, body: unknown, seen: { value?: Seen } = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const sent = new Headers(init?.headers);
    seen.value = {
      url: String(input),
      method: init?.method ?? 'GET',
      credential: sent.get(INTERNAL_CREDENTIAL_HEADER),
    };
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': status === 200 ? 'application/json' : 'application/problem+json' },
    });
  }) as unknown as typeof fetch;
}

function apiUnreachable(): typeof fetch {
  return (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
}

const COUNTS = {
  pageSize: 5000,
  counts: [
    { type: 'page', entries: 3 },
    { type: 'listing', entries: 2 },
    { type: 'service', entries: 0 },
    { type: 'category', entries: 4 },
    { type: 'seller', entries: 1 },
  ],
};

describe('readRobotsSettings', () => {
  it('carries the internal credential on one GET', async () => {
    const seen: { value?: Seen } = {};
    await readRobotsSettings({ env: ENV, fetch: apiReturns(200, { locale: 'en', body: 'User-agent: *' }, seen) });
    expect(seen.value?.method).toBe('GET');
    expect(seen.value?.url).toBe('https://api.test/v1/seo/robots');
    expect(seen.value?.credential).toBe(ENV.INTERNAL_BFF_CREDENTIAL);
  });

  it('returns the authored body', async () => {
    const found = await readRobotsSettings({
      env: ENV,
      fetch: apiReturns(200, { locale: 'en', body: 'User-agent: *\nDisallow: /dashboard' }),
    });
    expect(found?.body).toBe('User-agent: *\nDisallow: /dashboard');
  });

  it('returns nothing-authored as a value, not as a failure', async () => {
    const found = await readRobotsSettings({ env: ENV, fetch: apiReturns(200, { locale: null, body: null }) });
    expect(found).toEqual({ locale: null, body: null });
  });

  it('returns null when it could not be read at all', async () => {
    for (const status of [403, 404, 500, 503]) {
      expect(await readRobotsSettings({ env: ENV, fetch: apiReturns(status, { status }) }), String(status)).toBeNull();
    }
    expect(await readRobotsSettings({ env: ENV, fetch: apiUnreachable() })).toBeNull();
  });

  it('refuses a drifted body', async () => {
    for (const body of [{ locale: 'fr', body: null }, { body: null }, { locale: 'en' }, 'not json', []]) {
      expect(await readRobotsSettings({ env: ENV, fetch: apiReturns(200, body) }), JSON.stringify(body)).toBeNull();
    }
  });
});

describe('readSitemapCounts', () => {
  it('reads the counts and the page size', async () => {
    const seen: { value?: Seen } = {};
    const found = await readSitemapCounts({ env: ENV, fetch: apiReturns(200, COUNTS, seen) });
    expect(seen.value?.url).toBe('https://api.test/v1/seo/sitemap');
    expect(found?.pageSize).toBe(5000);
    expect(found?.counts).toHaveLength(5);
  });

  it('keeps a zero count, because an empty kind must stay tellable from an unknown one', async () => {
    const found = await readSitemapCounts({ env: ENV, fetch: apiReturns(200, COUNTS) });
    expect(found?.counts.find((count) => count.type === 'service')?.entries).toBe(0);
  });

  it('returns null on a failure or a drifted body', async () => {
    expect(await readSitemapCounts({ env: ENV, fetch: apiReturns(503, {}) })).toBeNull();
    expect(await readSitemapCounts({ env: ENV, fetch: apiUnreachable() })).toBeNull();
    expect(await readSitemapCounts({ env: ENV, fetch: apiReturns(200, { counts: [] }) })).toBeNull();
    expect(
      await readSitemapCounts({ env: ENV, fetch: apiReturns(200, { pageSize: 5000, counts: [{ type: 'route', entries: 1 }] }) }),
    ).toBeNull();
  });
});

describe('readSitemapPage', () => {
  const page = (entries: unknown[], overrides: Record<string, unknown> = {}) => ({
    type: 'listing',
    page: 1,
    pageSize: 5000,
    entries,
    ...overrides,
  });

  it('asks for the type and page it was given', async () => {
    const seen: { value?: Seen } = {};
    await readSitemapPage('category', 3, {
      env: ENV,
      fetch: apiReturns(200, page([], { type: 'category', page: 3 }), seen),
    });
    expect(seen.value?.url).toBe('https://api.test/v1/seo/sitemap/category/3');
  });

  it('returns the entries', async () => {
    const found = await readSitemapPage('listing', 1, {
      env: ENV,
      fetch: apiReturns(200, page([{ slug: 'walnut-table', updatedAt: '2026-05-02T09:00:00.000Z' }])),
    });
    expect(found?.entries).toHaveLength(1);
    expect(found?.entries[0]?.slug).toBe('walnut-table');
  });

  it('treats an empty page as a state rather than a failure', async () => {
    const found = await readSitemapPage('listing', 9, { env: ENV, fetch: apiReturns(200, page([], { page: 9 })) });
    expect(found?.entries).toEqual([]);
  });

  it('refuses an answer about a different document than the one asked for', async () => {
    // A wrong sitemap is worse than no sitemap: it advertises addresses under the wrong heading.
    expect(
      await readSitemapPage('listing', 1, { env: ENV, fetch: apiReturns(200, page([], { type: 'service' })) }),
    ).toBeNull();
    expect(await readSitemapPage('listing', 1, { env: ENV, fetch: apiReturns(200, page([], { page: 2 })) })).toBeNull();
  });

  it('refuses a slug that is not slug-shaped, rather than building a URL from it', async () => {
    for (const slug of ['https://evil.example', '../dashboard', '/listing/x', 'Walnut', '']) {
      const found = await readSitemapPage('listing', 1, {
        env: ENV,
        fetch: apiReturns(200, page([{ slug, updatedAt: '2026-05-02T09:00:00.000Z' }])),
      });
      expect(found, slug).toBeNull();
    }
  });

  it('refuses an entry with no usable timestamp', async () => {
    const found = await readSitemapPage('listing', 1, {
      env: ENV,
      fetch: apiReturns(200, page([{ slug: 'thing', updatedAt: 'yesterday' }])),
    });
    expect(found).toBeNull();
  });

  it('returns null on a failure', async () => {
    expect(await readSitemapPage('listing', 1, { env: ENV, fetch: apiReturns(503, {}) })).toBeNull();
    expect(await readSitemapPage('listing', 1, { env: ENV, fetch: apiUnreachable() })).toBeNull();
  });
});
