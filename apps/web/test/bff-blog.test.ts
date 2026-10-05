import { describe, expect, it } from 'vitest';
import { readBlogIndex, readBlogPost, readBlogTaxonomy } from '../src/server/bff/blog';

/**
 * The public blog at the BFF boundary (0092).
 *
 * What matters here:
 *
 *   * **no session and no cookie** — a post is as public as the site it is on;
 *   * **the redirect arrives as data.** A renamed post comes back as `moved` with the current slug, never as a status
 *     line, because `fetch` would follow a 301 transparently and the browser would never be redirected;
 *   * **a failure is distinguishable from an absence.** A post that does not exist is `not_found` and an outage is
 *     `unavailable`, because telling a visitor a post does not exist when the truth is that we could not read it is a
 *     worse answer than admitting the failure;
 *   * **a value the database could not have emitted is refused**, because the response contract is strict;
 *   * **a slug that could name nothing costs no round trip.**
 *
 * Everything is stubbed at the `fetch` boundary: no API, no database, no network.
 */

const ENV = {
  API_BASE_URL: 'https://api.internal.test',
  INTERNAL_BFF_CREDENTIAL: 'test-web-blog-canary-not-realabcdefghijklmn',
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

const POST = {
  slug: 'a-lovely-post',
  isIndexable: true,
  isFeatured: false,
  categorySlug: 'news',
  categoryName: 'News',
  resolvedLocale: 'en',
  title: 'A Lovely Post',
  excerpt: 'Worth reading.',
  body: 'The body.',
  metaTitle: 'A Lovely Post | Meta',
  metaDescription: 'What it is about.',
  coverObjectPath: null,
  tags: [{ slug: 'shipping', name: 'Shipping' }],
  publishedAt: '2026-05-01T09:00:00.000Z',
  updatedAt: '2026-05-02T09:00:00.000Z',
};

const SUMMARY = {
  slug: 'a-lovely-post',
  isFeatured: false,
  categorySlug: 'news',
  categoryName: 'News',
  resolvedLocale: 'en',
  title: 'A Lovely Post',
  excerpt: 'Worth reading.',
  coverObjectPath: null,
  publishedAt: '2026-05-01T09:00:00.000Z',
  updatedAt: '2026-05-02T09:00:00.000Z',
};

describe('readBlogPost', () => {
  it('asks by slug with the credential and no cookie', async () => {
    const seen: { value?: Seen } = {};
    const found = await readBlogPost('a-lovely-post', 'en', {
      env: ENV,
      fetch: apiReturns(200, { outcome: 'post', post: POST }, seen),
    });
    expect(found.kind).toBe('found');
    expect(found.kind === 'found' && found.post.title).toBe('A Lovely Post');
    expect(seen.value?.url).toContain('/v1/blog/a-lovely-post');
    expect(seen.value?.url).toContain('locale=en');
    expect(seen.value?.cookie).toBeNull();
    expect(seen.value?.credential).toBe(ENV.INTERNAL_BFF_CREDENTIAL);
  });

  it('carries the posts own meta fields, which are the only source of its head', async () => {
    const found = await readBlogPost('a-lovely-post', 'en', {
      env: ENV,
      fetch: apiReturns(200, { outcome: 'post', post: POST }),
    });
    expect(found.kind === 'found' && found.post.metaTitle).toBe('A Lovely Post | Meta');
    expect(found.kind === 'found' && found.post.metaDescription).toBe('What it is about.');
  });

  it('turns a renamed post into data rather than a status line', async () => {
    const found = await readBlogPost('an-older-address', 'en', {
      env: ENV,
      fetch: apiReturns(200, { outcome: 'moved', movedTo: 'a-lovely-post' }),
    });
    expect(found).toEqual({ kind: 'moved', movedTo: 'a-lovely-post' });
  });

  it('defaults an unrecognised locale rather than sending it on', async () => {
    const seen: { value?: Seen } = {};
    await readBlogPost('a-lovely-post', 'xx', {
      env: ENV,
      fetch: apiReturns(200, { outcome: 'post', post: POST }, seen),
    });
    expect(seen.value?.url).toContain('locale=en');
  });

  it('is not_found for a slug that could name nothing, without an upstream hop', async () => {
    const seen: { value?: Seen } = {};
    for (const slug of ['Not A Slug', '', '../../etc', 'UPPER', 'a'.repeat(200)]) {
      const found = await readBlogPost(slug, 'en', {
        env: ENV,
        fetch: apiReturns(200, { outcome: 'post', post: POST }, seen),
      });
      expect(found.kind, slug).toBe('not_found');
    }
    expect(seen.value).toBeUndefined();
  });

  it('tells an absent post from a blog it could not read', async () => {
    const absent = await readBlogPost('a-lovely-post', 'en', {
      env: ENV,
      fetch: apiReturns(404, { status: 404, code: 'NOT_FOUND' }),
    });
    expect(absent.kind).toBe('not_found');

    for (const fetcher of [
      apiUnreachable(),
      apiReturns(503, { status: 503, code: 'SERVICE_UNAVAILABLE' }),
      apiReturns(500, { status: 500, code: 'INTERNAL_ERROR' }),
      apiReturns(403, { status: 403, code: 'BAD_REQUEST' }),
      apiReturns(200, 'not json at all'),
      apiReturns(200, {}),
    ]) {
      const failed = await readBlogPost('a-lovely-post', 'en', { env: ENV, fetch: fetcher });
      // Never `not_found`: claiming a post does not exist when we could not read it is the one wrong answer.
      expect(failed.kind).toBe('unavailable');
    }
  });

  it('refuses an answer the database could not have emitted', async () => {
    for (const body of [
      // A field nobody declared, including the two the override section would have carried.
      { outcome: 'post', post: { ...POST, canonicalPath: '/elsewhere' } },
      { outcome: 'post', post: { ...POST, robotsDirectives: ['noindex'] } },
      { outcome: 'post', post: { ...POST, structuredData: {} } },
      // A locale the site does not serve.
      { outcome: 'post', post: { ...POST, resolvedLocale: 'fr' } },
      // A moved answer carrying a post, which would let a renderer show one instead of redirecting.
      { outcome: 'moved', movedTo: 'a-lovely-post', post: POST },
      // An outcome that does not exist: absence is a 404, not a body.
      { outcome: 'not_found' },
    ]) {
      const found = await readBlogPost('a-lovely-post', 'en', { env: ENV, fetch: apiReturns(200, body) });
      expect(found.kind, JSON.stringify(body).slice(0, 60)).toBe('unavailable');
    }
  });
});

describe('readBlogIndex', () => {
  it('forwards only a filter that could name something', async () => {
    const seen: { value?: Seen } = {};
    await readBlogIndex(
      { locale: 'en', category: 'Not A Slug', tag: '../etc', cursor: 'not a cursor!' },
      { env: ENV, fetch: apiReturns(200, { items: [], nextCursor: null }, seen) },
    );
    const url = seen.value?.url ?? '';
    // Dropped rather than refused: the honest answer to a mangled link is the unfiltered index, not an error.
    expect(url).not.toContain('category=');
    expect(url).not.toContain('tag=');
    expect(url).not.toContain('cursor=');
  });

  it('forwards a filter and a cursor that could', async () => {
    const seen: { value?: Seen } = {};
    await readBlogIndex(
      { locale: 'ar', category: 'news', tag: 'shipping', cursor: 'YmkxfDIwMjYtMDUtMDE' },
      { env: ENV, fetch: apiReturns(200, { items: [SUMMARY], nextCursor: null }, seen) },
    );
    const url = seen.value?.url ?? '';
    expect(url).toContain('locale=ar');
    expect(url).toContain('category=news');
    expect(url).toContain('tag=shipping');
    expect(url).toContain('cursor=YmkxfDIwMjYtMDUtMDE');
  });

  it('is null when the index could not be read, so the page says so rather than showing an empty blog', async () => {
    for (const fetcher of [apiUnreachable(), apiReturns(503, {}), apiReturns(200, 'nope'), apiReturns(200, {})]) {
      expect(await readBlogIndex({ locale: 'en' }, { env: ENV, fetch: fetcher })).toBeNull();
    }
  });

  it('refuses a page carrying a field nobody declared', async () => {
    const page = await readBlogIndex(
      { locale: 'en' },
      { env: ENV, fetch: apiReturns(200, { items: [{ ...SUMMARY, isIndexable: true }], nextCursor: null }) },
    );
    // `isIndexable` is on the post, not on a summary: a value the index contract does not carry means drift.
    expect(page).toBeNull();
  });
});

describe('readBlogTaxonomy', () => {
  it('returns the filters with their public counts', async () => {
    const taxonomy = await readBlogTaxonomy('en', {
      env: ENV,
      fetch: apiReturns(200, {
        categories: [{ slug: 'news', name: 'News', postCount: 2 }],
        tags: [{ slug: 'shipping', name: 'Shipping', postCount: 0 }],
      }),
    });
    expect(taxonomy?.categories[0]?.postCount).toBe(2);
    // Zero is a real answer, so the page can decide for itself whether to offer an empty filter.
    expect(taxonomy?.tags[0]?.postCount).toBe(0);
  });

  it('is null on a failure, and the index renders without filters', async () => {
    expect(await readBlogTaxonomy('en', { env: ENV, fetch: apiUnreachable() })).toBeNull();
    expect(await readBlogTaxonomy('en', { env: ENV, fetch: apiReturns(503, {}) })).toBeNull();
  });
});
