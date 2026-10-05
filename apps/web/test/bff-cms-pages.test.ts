import { describe, expect, it } from 'vitest';
import { handleCmsPage, handleCmsPages, readCmsPage, readCmsPages } from '../src/server/bff/cms-pages';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/server/bff/internal-credential';

/**
 * The BFF half of the public CMS pages.
 *
 * One credentialled internal call, and whatever comes back checked against the shared contract before a page
 * may render it. The assertions that matter most:
 *
 * **A moved slug arrives as data and stays data.** No status line anywhere in this path is a redirect, because
 * `fetch` follows one transparently and the page would then render the renamed content at the old address
 * without ever knowing it should have redirected the browser.
 *
 * **The locale travels and is normalised at the edge.** An unrecognised tag resolves to the default rather than
 * becoming an error, which is the same rule the category tree follows.
 *
 * **A failure is a failure, never an absence.** An unreachable API, a non-200 and a drifted body are all
 * `unavailable`, so a visitor is never told the terms of service do not exist when we simply could not read
 * them.
 */

const ENV = {
  API_BASE_URL: 'https://api.test',
  PUBLIC_WEB_ORIGIN: 'https://web.test',
  INTERNAL_BFF_CREDENTIAL: 'test-current-credential-value-not-a-real-se',
} as const;

const PAGE = {
  slug: 'terms',
  pageKey: 'terms',
  template: 'legal',
  isIndexable: true,
  resolvedLocale: 'en',
  title: 'Terms of Service',
  excerpt: null,
  body: 'The body.',
  metaTitle: 'Terms',
  metaDescription: 'Our terms.',
  coverObjectPath: null,
  publishedAt: '2026-05-01T09:00:00.000Z',
  updatedAt: '2026-05-02T09:00:00.000Z',
};

const LINK = {
  slug: 'terms',
  pageKey: 'terms',
  template: 'legal',
  isIndexable: true,
  resolvedLocale: 'en',
  title: 'Terms of Service',
  updatedAt: '2026-05-02T09:00:00.000Z',
};

interface Seen {
  url: string;
  credential: string | null;
  method: string;
  redirect: string | undefined;
}

function apiReturns(status: number, body: unknown, seen: { value?: Seen } = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const sent = new Headers(init?.headers);
    seen.value = {
      url: String(input),
      credential: sent.get(INTERNAL_CREDENTIAL_HEADER),
      method: init?.method ?? 'GET',
      redirect: init?.redirect,
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

describe('readCmsPage', () => {
  it('carries the internal credential on one GET', async () => {
    const seen: { value?: Seen } = {};
    await readCmsPage('terms', 'en', { env: ENV, fetch: apiReturns(200, { outcome: 'page', page: PAGE }, seen) });
    expect(seen.value?.method).toBe('GET');
    expect(seen.value?.credential).toBe(ENV.INTERNAL_BFF_CREDENTIAL);
    expect(seen.value?.url).toBe('https://api.test/v1/cms/pages/terms?locale=en');
  });

  it('returns the page, with the locale the API actually resolved to', async () => {
    const found = await readCmsPage('terms', 'ar', {
      env: ENV,
      fetch: apiReturns(200, { outcome: 'page', page: { ...PAGE, resolvedLocale: 'en' } }),
    });
    expect(found.kind).toBe('found');
    if (found.kind === 'found') expect(found.page.resolvedLocale).toBe('en');
  });

  it('returns a moved slug as data, not as a redirect', async () => {
    const found = await readCmsPage('terms', 'en', {
      env: ENV,
      fetch: apiReturns(200, { outcome: 'moved', movedTo: 'terms-of-service' }),
    });
    expect(found.kind).toBe('moved');
    if (found.kind === 'moved') expect(found.movedTo).toBe('terms-of-service');
  });

  it('normalises the locale at the edge', async () => {
    const seen: { value?: Seen } = {};
    const fetcher = apiReturns(200, { outcome: 'page', page: PAGE }, seen);
    await readCmsPage('terms', 'ar', { env: ENV, fetch: fetcher });
    expect(seen.value?.url).toContain('locale=ar');
    await readCmsPage('terms', 'xx', { env: ENV, fetch: fetcher });
    expect(seen.value?.url).toContain('locale=en');
    await readCmsPage('terms', undefined, { env: ENV, fetch: fetcher });
    expect(seen.value?.url).toContain('locale=en');
  });

  it('encodes the slug rather than interpolating it', async () => {
    const seen: { value?: Seen } = {};
    await readCmsPage('a b/c', 'en', { env: ENV, fetch: apiReturns(404, {}, seen) });
    expect(seen.value?.url).toBe('https://api.test/v1/cms/pages/a%20b%2Fc?locale=en');
  });

  it('turns a 404 into not_found', async () => {
    const found = await readCmsPage('nothing', 'en', { env: ENV, fetch: apiReturns(404, { status: 404 }) });
    expect(found.kind).toBe('not_found');
  });

  it('turns every other failure into unavailable rather than absence', async () => {
    for (const status of [401, 403, 500, 503]) {
      const found = await readCmsPage('terms', 'en', { env: ENV, fetch: apiReturns(status, { status }) });
      expect(found.kind, String(status)).toBe('unavailable');
    }
    expect((await readCmsPage('terms', 'en', { env: ENV, fetch: apiUnreachable() })).kind).toBe('unavailable');
  });

  it('refuses a drifted body instead of rendering it', async () => {
    for (const body of [
      { outcome: 'page', page: { ...PAGE, resolvedLocale: 'fr' } },
      { outcome: 'page' },
      { outcome: 'elsewhere', movedTo: 'x' },
      { page: PAGE },
      'not json',
    ]) {
      const found = await readCmsPage('terms', 'en', { env: ENV, fetch: apiReturns(200, body) });
      expect(found.kind, JSON.stringify(body)).toBe('unavailable');
    }
  });
});

describe('readCmsPages', () => {
  it('returns the published index', async () => {
    const pages = await readCmsPages('en', { env: ENV, fetch: apiReturns(200, { pages: [LINK] }) });
    expect(pages).toHaveLength(1);
    expect(pages?.[0]?.slug).toBe('terms');
  });

  it('treats an empty index as a state rather than a failure', async () => {
    expect(await readCmsPages('en', { env: ENV, fetch: apiReturns(200, { pages: [] }) })).toEqual([]);
  });

  it('returns null when it could not be read', async () => {
    expect(await readCmsPages('en', { env: ENV, fetch: apiReturns(503, {}) })).toBeNull();
    expect(await readCmsPages('en', { env: ENV, fetch: apiUnreachable() })).toBeNull();
    expect(await readCmsPages('en', { env: ENV, fetch: apiReturns(200, { pages: [{ slug: 'x' }] }) })).toBeNull();
  });
});

describe('the route handlers', () => {
  const request = (url: string): Request => new Request(url);

  it('serves the index as json with no store', async () => {
    const response = await handleCmsPages(request('https://web.test/api/cms/pages?locale=en'), {
      env: ENV,
      fetch: apiReturns(200, { pages: [LINK] }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(((await response.json()) as { pages: unknown[] }).pages).toHaveLength(1);
  });

  it('rebuilds the body rather than forwarding it', async () => {
    const response = await handleCmsPage(request('https://web.test/api/cms/pages/terms'), 'terms', {
      env: ENV,
      fetch: apiReturns(200, { outcome: 'page', page: { ...PAGE, smuggled: 'should not travel' } }),
    });
    expect(await response.text()).not.toContain('smuggled');
  });

  it('answers a moved slug with a 200 and never a Location header', async () => {
    const response = await handleCmsPage(request('https://web.test/api/cms/pages/terms'), 'terms', {
      env: ENV,
      fetch: apiReturns(200, { outcome: 'moved', movedTo: 'terms-of-service' }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    expect((await response.json()) as unknown).toEqual({ outcome: 'moved', movedTo: 'terms-of-service' });
  });

  it('answers absence with an RFC 9457 problem', async () => {
    const response = await handleCmsPage(request('https://web.test/api/cms/pages/nothing'), 'nothing', {
      env: ENV,
      fetch: apiReturns(404, { status: 404 }),
    });
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    expect(((await response.json()) as { code: string }).code).toBe('NOT_FOUND');
  });

  it('answers a failure with a 503 problem', async () => {
    const response = await handleCmsPage(request('https://web.test/api/cms/pages/terms'), 'terms', {
      env: ENV,
      fetch: apiUnreachable(),
    });
    expect(response.status).toBe(503);
    expect(((await response.json()) as { code: string }).code).toBe('SERVICE_UNAVAILABLE');
  });
});
