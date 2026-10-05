import { describe, expect, it } from 'vitest';
import { readSeoMetadata } from '../src/server/bff/seo-metadata';

/**
 * The public half of per-entity metadata, at the BFF boundary.
 *
 * What matters here:
 *
 *   * **no session and no cookie** — an override is as public as the thing it describes;
 *   * **addressed by slug or by route path**, never by an identifier, which is the reason two public contracts did not
 *     have to widen;
 *   * **a failure is never an override.** An outage, a refusal and a drifted body all answer null, so a surface whose
 *     override could not be read renders the head it rendered before this existed;
 *   * **a value the database could not have emitted is refused**, because the response contract is strict: a
 *     permissive directive and an external canonical both mean something upstream is wrong.
 *
 * Everything is stubbed at the `fetch` boundary: no API, no database, no network.
 */

const ENV = {
  API_BASE_URL: 'https://api.internal.test',
  INTERNAL_BFF_CREDENTIAL: 'test-web-metadata-canary-not-real-abcdefghi',
} as const;

interface Seen {
  url: string;
  method: string;
  cookie: string | null;
  credential: string | null;
}

function apiReturns(status: number, body: unknown, seen: { value?: Seen } = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const sent = new Headers(init?.headers);
    seen.value = {
      url: String(input),
      method: init?.method ?? 'GET',
      cookie: sent.get('cookie'),
      credential: sent.get('x-internal-credential'),
    };
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': status < 400 ? 'application/json' : 'application/problem+json' },
    });
  }) as unknown as typeof fetch;
}

function apiUnreachable(): typeof fetch {
  return (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
}

const OVERRIDE = {
  metaTitle: 'A lovely chair',
  metaDescription: 'A chair worth having.',
  canonicalPath: null,
  robotsDirectives: ['nosnippet'],
  ogTitle: 'A lovely chair',
  ogDescription: 'A chair worth having.',
  shareObjectPath: 'cms-media/share/card.png',
};

describe('readSeoMetadata', () => {
  it('asks by kind and slug, with the credential and no cookie', async () => {
    const seen: { value?: Seen } = {};
    const override = await readSeoMetadata(
      { entityType: 'listing', slug: 'a-chair', locale: 'en' },
      { env: ENV, fetch: apiReturns(200, { override: OVERRIDE }, seen) },
    );
    expect(override?.metaTitle).toBe('A lovely chair');
    expect(seen.value?.url).toContain('entityType=listing');
    expect(seen.value?.url).toContain('slug=a-chair');
    expect(seen.value?.url).toContain('locale=en');
    expect(seen.value?.method).toBe('GET');
    expect(seen.value?.cookie).toBeNull();
    expect(seen.value?.credential).toBe(ENV.INTERNAL_BFF_CREDENTIAL);
  });

  it('asks by route path for a landing address, and sends no kind with it', async () => {
    const seen: { value?: Seen } = {};
    await readSeoMetadata(
      { routePath: '/listings', locale: 'ar' },
      { env: ENV, fetch: apiReturns(200, { override: null }, seen) },
    );
    expect(seen.value?.url).toContain(`routePath=${encodeURIComponent('/listings')}`);
    expect(seen.value?.url).toContain('locale=ar');
    expect(seen.value?.url).not.toContain('entityType=');
    expect(seen.value?.url).not.toContain('slug=');
  });

  it('defaults an unrecognised locale rather than sending it on', async () => {
    const seen: { value?: Seen } = {};
    await readSeoMetadata(
      { entityType: 'page', slug: 'about', locale: 'xx' },
      { env: ENV, fetch: apiReturns(200, { override: null }, seen) },
    );
    expect(seen.value?.url).toContain('locale=en');
  });

  it('is null when nothing is stored', async () => {
    const override = await readSeoMetadata(
      { entityType: 'category', slug: 'furniture', locale: 'en' },
      { env: ENV, fetch: apiReturns(200, { override: null }) },
    );
    expect(override).toBeNull();
  });

  it('is null for a target that could not name anything, without an upstream hop', async () => {
    const seen: { value?: Seen } = {};
    for (const target of [
      { entityType: 'listing', slug: 'Not A Slug', locale: 'en' },
      { entityType: 'listing', slug: '', locale: 'en' },
      { entityType: 'listing', slug: '../../etc', locale: 'en' },
      { routePath: 'not-a-path', locale: 'en' },
      { routePath: '//evil.test', locale: 'en' },
      { routePath: `/${'a'.repeat(3000)}`, locale: 'en' },
    ] as const) {
      const override = await readSeoMetadata(target, { env: ENV, fetch: apiReturns(200, { override: OVERRIDE }, seen) });
      expect(override, JSON.stringify(target)).toBeNull();
    }
    expect(seen.value).toBeUndefined();
  });

  it('turns every failure into no override rather than into an error', async () => {
    for (const fetcher of [
      apiUnreachable(),
      apiReturns(503, { status: 503, code: 'SERVICE_UNAVAILABLE' }),
      apiReturns(400, { status: 400, code: 'VALIDATION_FAILED' }),
      apiReturns(403, { status: 403, code: 'BAD_REQUEST' }),
      apiReturns(200, 'not json at all'),
      apiReturns(200, {}),
    ]) {
      const override = await readSeoMetadata(
        { entityType: 'listing', slug: 'a-chair', locale: 'en' },
        { env: ENV, fetch: fetcher },
      );
      // A page must render. An override that could not be read is simply no override.
      expect(override).toBeNull();
    }
  });

  it('refuses an answer the database could not have emitted', async () => {
    for (const body of [
      // A permissive directive. The reader drops those, so receiving one means something upstream is wrong.
      { override: { ...OVERRIDE, robotsDirectives: ['index'] } },
      { override: { ...OVERRIDE, robotsDirectives: ['max-snippet:-1'] } },
      // A canonical that would leave the site. The table cannot store one.
      { override: { ...OVERRIDE, canonicalPath: 'https://evil.test/' } },
      { override: { ...OVERRIDE, canonicalPath: '//evil.test' } },
      // A field nobody declared, including the one column this increment deliberately does not serve.
      { override: { ...OVERRIDE, structuredData: {} } },
    ]) {
      const override = await readSeoMetadata(
        { entityType: 'page', slug: 'about', locale: 'en' },
        { env: ENV, fetch: apiReturns(200, body) },
      );
      expect(override, JSON.stringify(body).slice(0, 60)).toBeNull();
    }
  });

  it('accepts every restrictive directive, because each is one the database may emit', async () => {
    for (const directive of ['noindex', 'nofollow', 'noarchive', 'nosnippet', 'noimageindex']) {
      const override = await readSeoMetadata(
        { entityType: 'page', slug: 'about', locale: 'en' },
        { env: ENV, fetch: apiReturns(200, { override: { ...OVERRIDE, robotsDirectives: [directive] } }) },
      );
      expect(override?.robotsDirectives, directive).toEqual([directive]);
    }
  });

  it('accepts a canonical on a route, which is the kind that honours one', async () => {
    const override = await readSeoMetadata(
      { routePath: '/listings', locale: 'en' },
      { env: ENV, fetch: apiReturns(200, { override: { ...OVERRIDE, canonicalPath: '/listings' } }) },
    );
    expect(override?.canonicalPath).toBe('/listings');
  });
});
