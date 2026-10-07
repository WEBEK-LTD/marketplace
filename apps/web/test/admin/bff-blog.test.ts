import { describe, expect, it } from 'vitest';
import {
  handleBlogPostCreate,
  handleBlogPostStatus,
  handleBlogPostTags,
  handleBlogPostUpdate,
  handleBlogTaxonomySave,
  handleBlogTranslationRemove,
  handleBlogTranslationSave,
  readBlogPost,
  readBlogPosts,
  readBlogTaxonomy,
} from '../../src/admin/server/bff/blog';

/**
 * The blog BFF, on the admin origin (0092).
 *
 * What matters at this boundary:
 *
 *   * the caller's token comes from `__Host-mp_admin_access` and never from a body, and the browser's own `Cookie`
 *     header is never forwarded upstream;
 *   * **the body is rebuilt, never forwarded** — a `status` on a rename, an `authorUserId` or a `publishedAt` has
 *     nowhere to go, because none is a field of the request contract;
 *   * **absence is preserved on the update route.** An absent reference means "leave it alone" and an explicit null
 *     means "clear it", so flattening the two would make a category impossible to remove;
 *   * responses are validated before a byte reaches a browser;
 *   * the refusals a screen must act on are forwarded with the API's own problem body, and anything else becomes one
 *     503;
 *   * every write is same-origin, and a cross-origin submission is refused before its body is read.
 *
 * Everything is stubbed at the `fetch` boundary: no API, no database, no network.
 */

const ENV = {
  API_BASE_URL: 'https://api.internal.test',
  INTERNAL_BFF_CREDENTIAL: 'test-blog-canary-credential-not-realabcdefg',
} as const;

const SESSION_TOKEN = 'canary-admin-access-token-not-a-real-token';
const COOKIE = `__Host-mp_admin_access=${SESSION_TOKEN}; __Host-mp_admin_refresh=canary-refresh-not-real`;
const ORIGIN = 'https://admin.test';

const POST = 'fb000000-0000-4000-8000-0000000000b1';
const CATEGORY = 'fb000000-0000-4000-8000-0000000000c1';
const TAG = 'fb000000-0000-4000-8000-0000000000a1';

const LIST_POST = {
  id: POST,
  slug: 'a-post',
  status: 'published',
  categoryId: CATEGORY,
  categorySlug: 'news',
  isIndexable: true,
  isFeatured: false,
  scheduledFor: null,
  publishedAt: '2026-05-01T09:00:00.000Z',
  archivedAt: null,
  updatedAt: '2026-05-02T09:00:00.000Z',
  translatedLocales: ['en'],
  tagCount: 1,
  title: 'A Post',
};

// Written out rather than spread from the list row, because the two contracts genuinely differ and both are
// strict: the list summarises with `title`, `translatedLocales` and `tagCount`, while the detail carries the
// translations and tag identifiers themselves and declares none of those three.
const DETAIL_POST = {
  id: POST,
  slug: 'a-post',
  status: 'published',
  categoryId: CATEGORY,
  categorySlug: 'news',
  isIndexable: true,
  isFeatured: false,
  scheduledFor: null,
  publishedAt: '2026-05-01T09:00:00.000Z',
  archivedAt: null,
  updatedAt: '2026-05-02T09:00:00.000Z',
  coverMediaId: null,
  coverObjectPath: null,
  coverAltTextEn: null,
  coverAltTextAr: null,
  authorUserId: '11111111-1111-4111-8111-111111111111',
  createdAt: '2026-04-01T09:00:00.000Z',
  canManage: true,
  previousSlugs: ['an-older-slug'],
  tagIds: [TAG],
  translations: [
    {
      localeCode: 'en',
      title: 'A Post',
      excerpt: null,
      body: 'The body.',
      metaTitle: 'A Post | Meta',
      metaDescription: null,
      updatedAt: '2026-05-02T09:00:00.000Z',
    },
  ],
};

const TAXONOMY = {
  categories: [
    {
      id: CATEGORY,
      slug: 'news',
      nameEn: 'News',
      nameAr: 'أخبار',
      descriptionEn: null,
      descriptionAr: null,
      sortOrder: 10,
      isActive: true,
      postCount: 2,
      updatedAt: '2026-05-02T09:00:00.000Z',
    },
  ],
  tags: [
    {
      id: TAG,
      slug: 'shipping',
      nameEn: 'Shipping',
      nameAr: null,
      isActive: true,
      postCount: 1,
      updatedAt: '2026-05-02T09:00:00.000Z',
    },
  ],
  canManage: true,
};

interface Seen {
  url: string;
  method: string;
  cookie: string | null;
  sessionToken: string | null;
  body: string | null;
}

function apiReturns(status: number, body: unknown, seen: { value?: Seen } = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const sent = new Headers(init?.headers);
    seen.value = {
      url: String(input),
      method: init?.method ?? 'GET',
      cookie: sent.get('cookie'),
      sessionToken: sent.get('x-session-token') ?? sent.get('X-Session-Token'),
      body: typeof init?.body === 'string' ? init.body : null,
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

function writeRequest(
  path: string,
  method: string,
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { origin: ORIGIN, 'content-type': 'application/json', cookie: COOKIE, ...headers },
    body: JSON.stringify(body),
  });
}

/* ------------------------------------------------------------------------------------------------ */
/* Reads                                                                                             */
/* ------------------------------------------------------------------------------------------------ */

describe('readBlogPosts', () => {
  it('presents the session token upstream and never the browser cookie', async () => {
    const seen: { value?: Seen } = {};
    await readBlogPosts({}, {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReturns(200, { items: [LIST_POST], nextCursor: null }, seen),
    });
    expect(seen.value?.sessionToken).toBe(SESSION_TOKEN);
    expect(seen.value?.cookie).toBeNull();
  });

  it('is unauthenticated with no session cookie, without calling upstream', async () => {
    const seen: { value?: Seen } = {};
    const result = await readBlogPosts({}, { env: ENV, cookieHeader: null, fetch: apiReturns(200, {}, seen) });
    expect(result.kind).toBe('unauthenticated');
    expect(seen.value).toBeUndefined();
  });

  it('forwards only a state the contract names, a sane limit, a real id and a well-formed cursor', async () => {
    const seen: { value?: Seen } = {};
    await readBlogPosts(
      { status: 'live', limit: 'ten', categoryId: 'not-a-uuid', cursor: 'not a cursor!' },
      { env: ENV, cookieHeader: COOKIE, fetch: apiReturns(200, { items: [], nextCursor: null }, seen) },
    );
    const url = seen.value?.url ?? '';
    expect(url).not.toContain('status=');
    expect(url).not.toContain('limit=');
    expect(url).not.toContain('categoryId=');
    expect(url).not.toContain('cursor=');
  });

  it('forwards a search term as it was typed, because the database matches it literally', async () => {
    const seen: { value?: Seen } = {};
    await readBlogPosts(
      { search: '100% cotton_or-not' },
      { env: ENV, cookieHeader: COOKIE, fetch: apiReturns(200, { items: [], nextCursor: null }, seen) },
    );
    // Stripping a % here would silently change what somebody searched for; there is no pattern syntax to escape.
    // Read back through the parser rather than compared as text, because which escape a space got is not the point.
    expect(new URL(seen.value?.url ?? '').searchParams.get('search')).toBe('100% cotton_or-not');
  });

  it('drops a search term longer than the column anyone could store', async () => {
    const seen: { value?: Seen } = {};
    await readBlogPosts(
      { search: 'x'.repeat(5000) },
      { env: ENV, cookieHeader: COOKIE, fetch: apiReturns(200, { items: [], nextCursor: null }, seen) },
    );
    expect(seen.value?.url).not.toContain('search=');
  });

  it('turns each upstream status into its own answer', async () => {
    for (const [status, kind] of [
      [401, 'unauthenticated'],
      [404, 'notFound'],
      [400, 'invalid'],
      [403, 'unavailable'],
      [500, 'unavailable'],
      [503, 'unavailable'],
    ] as const) {
      const result = await readBlogPosts(
        {},
        { env: ENV, cookieHeader: COOKIE, fetch: apiReturns(status, { status, code: 'X' }) },
      );
      expect(result.kind, String(status)).toBe(kind);
    }
  });

  it('is unavailable when the API cannot be reached, and when its body drifted', async () => {
    const unreachable = await readBlogPosts({}, { env: ENV, cookieHeader: COOKIE, fetch: apiUnreachable() });
    expect(unreachable.kind).toBe('unavailable');

    const drifted = await readBlogPosts(
      {},
      { env: ENV, cookieHeader: COOKIE, fetch: apiReturns(200, { items: [{ ...LIST_POST, extra: 1 }] }) },
    );
    expect(drifted.kind).toBe('unavailable');
  });
});

describe('readBlogPost', () => {
  it('unwraps the post and keeps its capability flag', async () => {
    const result = await readBlogPost(POST, {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReturns(200, { post: DETAIL_POST }),
    });
    expect(result.kind).toBe('ok');
    expect(result.kind === 'ok' && result.data.canManage).toBe(true);
    expect(result.kind === 'ok' && result.data.previousSlugs).toEqual(['an-older-slug']);
  });

  it('is notFound for an identifier that could not be one, without calling upstream', async () => {
    const seen: { value?: Seen } = {};
    const result = await readBlogPost('not-a-uuid', {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReturns(200, { post: DETAIL_POST }, seen),
    });
    expect(result.kind).toBe('notFound');
    expect(seen.value).toBeUndefined();
  });
});

describe('readBlogTaxonomy', () => {
  it('carries both names and the capability flag', async () => {
    const result = await readBlogTaxonomy({ env: ENV, cookieHeader: COOKIE, fetch: apiReturns(200, TAXONOMY) });
    expect(result.kind === 'ok' && result.data.categories[0]?.nameAr).toBe('أخبار');
    expect(result.kind === 'ok' && result.data.canManage).toBe(true);
  });

  it('refuses a body carrying a field nobody declared', async () => {
    const result = await readBlogTaxonomy({
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReturns(200, { ...TAXONOMY, extra: true }),
    });
    expect(result.kind).toBe('unavailable');
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* Writes                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

describe('handleBlogPostCreate', () => {
  it('forwards only the contracts own fields', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleBlogPostCreate(
      writeRequest('/api/blog', 'POST', {
        slug: 'a-new-post',
        status: 'published',
        isFeatured: true,
        authorUserId: 'somebody-else',
      }),
      { env: ENV, fetch: apiReturns(201, { id: POST }, seen) },
    );
    expect(response.status).toBe(201);
    const sent = JSON.parse(seen.value?.body ?? '{}') as Record<string, unknown>;
    // Only what was sent: the three invented fields are gone, and `isIndexable` is absent because the request
    // carried none — the API applies the column default rather than this layer guessing it.
    expect(Object.keys(sent).sort()).toEqual(['slug']);
  });

  it('refuses a cross-origin submission before reading its body', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleBlogPostCreate(
      writeRequest('/api/blog', 'POST', { slug: 'a-new-post' }, { origin: 'https://evil.test' }),
      { env: ENV, fetch: apiReturns(201, { id: POST }, seen) },
    );
    expect(response.status).toBe(403);
    expect(seen.value).toBeUndefined();
  });

  it('is a 401 with no session cookie', async () => {
    const response = await handleBlogPostCreate(
      new Request(`${ORIGIN}/api/blog`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'a-new-post' }),
      }),
      { env: ENV, fetch: apiReturns(201, { id: POST }) },
    );
    expect(response.status).toBe(401);
  });
});

describe('handleBlogPostUpdate', () => {
  it('keeps an absent reference absent and an explicit null null', async () => {
    const seen: { value?: Seen } = {};
    await handleBlogPostUpdate(writeRequest('/api/blog', 'PATCH', { postId: POST, slug: 'renamed' }), {
      env: ENV,
      fetch: apiReturns(200, { ok: true }, seen),
    });
    // Absent means "leave the category alone". Rebuilding it as null here would clear it on every rename.
    expect(JSON.parse(seen.value?.body ?? '{}')).toEqual({ slug: 'renamed' });

    await handleBlogPostUpdate(
      writeRequest('/api/blog', 'PATCH', { postId: POST, categoryId: null, coverMediaId: null }),
      { env: ENV, fetch: apiReturns(200, { ok: true }, seen) },
    );
    expect(JSON.parse(seen.value?.body ?? '{}')).toEqual({ categoryId: null, coverMediaId: null });
  });

  it('never forwards a status, so a rename cannot publish a post', async () => {
    const seen: { value?: Seen } = {};
    await handleBlogPostUpdate(
      writeRequest('/api/blog', 'PATCH', { postId: POST, slug: 'renamed', status: 'published' }),
      { env: ENV, fetch: apiReturns(200, { ok: true }, seen) },
    );
    const sent = JSON.parse(seen.value?.body ?? '{}') as Record<string, unknown>;
    expect('status' in sent).toBe(false);
    expect(seen.value?.url).toContain(`/v1/admin/blog/${POST}`);
    expect(seen.value?.url).not.toContain('/status');
  });

  it('is a 400 for a missing or malformed post identifier', async () => {
    for (const body of [{ slug: 'renamed' }, { postId: 'not-a-uuid', slug: 'renamed' }]) {
      const response = await handleBlogPostUpdate(writeRequest('/api/blog', 'PATCH', body), {
        env: ENV,
        fetch: apiReturns(200, { ok: true }),
      });
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('is a 400 for an update with nothing in it', async () => {
    const response = await handleBlogPostUpdate(writeRequest('/api/blog', 'PATCH', { postId: POST }), {
      env: ENV,
      fetch: apiReturns(200, { ok: true }),
    });
    expect(response.status).toBe(400);
  });
});

describe('handleBlogPostStatus', () => {
  it('calls the one upstream route that can publish a post', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleBlogPostStatus(
      writeRequest('/api/blog/status', 'POST', { postId: POST, status: 'published' }),
      { env: ENV, fetch: apiReturns(200, { ok: true }, seen) },
    );
    expect(response.status).toBe(200);
    expect(seen.value?.method).toBe('PUT');
    expect(seen.value?.url).toContain(`/v1/admin/blog/${POST}/status`);
  });

  it('refuses a schedule with no moment, and a moment on anything else', async () => {
    for (const body of [
      { postId: POST, status: 'scheduled' },
      { postId: POST, status: 'published', scheduledFor: '2026-06-01T09:00:00.000Z' },
    ]) {
      const response = await handleBlogPostStatus(writeRequest('/api/blog/status', 'POST', body), {
        env: ENV,
        fetch: apiReturns(200, { ok: true }),
      });
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('forwards the refusals a screen must act on, with the APIs own body', async () => {
    for (const [status, code] of [
      [409, 'BLOG_LOCALE_REQUIRED'],
      [409, 'BLOG_CHANGE_NOT_ALLOWED'],
      [404, 'NOT_FOUND'],
    ] as const) {
      const response = await handleBlogPostStatus(
        writeRequest('/api/blog/status', 'POST', { postId: POST, status: 'published' }),
        { env: ENV, fetch: apiReturns(status, { status, code, detail: 'Upstream said so.' }) },
      );
      expect(response.status, code).toBe(status);
      expect(((await response.json()) as { code: string }).code, code).toBe(code);
    }
  });

  it('collapses a status nobody expected into one outage', async () => {
    const response = await handleBlogPostStatus(
      writeRequest('/api/blog/status', 'POST', { postId: POST, status: 'published' }),
      { env: ENV, fetch: apiReturns(418, { status: 418, code: 'TEAPOT' }) },
    );
    expect(response.status).toBe(503);
  });
});

describe('handleBlogTranslationSave and remove', () => {
  it('addresses the locale in the path and rebuilds the body', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleBlogTranslationSave(
      writeRequest('/api/blog/translations', 'PUT', {
        postId: POST,
        localeCode: 'ar',
        title: 'مقال',
        body: 'نص.',
        metaTitle: 'عنوان',
        updatedBy: 'somebody',
      }),
      { env: ENV, fetch: apiReturns(200, { ok: true }, seen) },
    );
    expect(response.status).toBe(200);
    expect(seen.value?.url).toContain(`/v1/admin/blog/${POST}/translations/ar`);
    const sent = JSON.parse(seen.value?.body ?? '{}') as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(['body', 'metaTitle', 'title']);
  });

  it('refuses a locale that could not be one', async () => {
    for (const locale of ['english', 'E N', '', 'eng']) {
      const response = await handleBlogTranslationSave(
        writeRequest('/api/blog/translations', 'PUT', {
          postId: POST,
          localeCode: locale,
          title: 'A',
          body: 'B',
        }),
        { env: ENV, fetch: apiReturns(200, { ok: true }) },
      );
      expect(response.status, locale).toBe(400);
    }
  });

  it('removes with a POST here and a DELETE upstream', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleBlogTranslationRemove(
      writeRequest('/api/blog/translations/remove', 'POST', { postId: POST, localeCode: 'ar' }),
      { env: ENV, fetch: apiReturns(200, { ok: true }, seen) },
    );
    expect(response.status).toBe(200);
    expect(seen.value?.method).toBe('DELETE');
    expect(seen.value?.body).toBeNull();
  });
});

describe('handleBlogPostTags', () => {
  it('sends the whole set, including an empty one', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleBlogPostTags(
      writeRequest('/api/blog/tags', 'PUT', { postId: POST, tagIds: [] }),
      { env: ENV, fetch: apiReturns(200, { ok: true }, seen) },
    );
    expect(response.status).toBe(200);
    expect(JSON.parse(seen.value?.body ?? '{}')).toEqual({ tagIds: [] });
  });

  it('refuses a tag that could not be an identifier', async () => {
    const response = await handleBlogPostTags(
      writeRequest('/api/blog/tags', 'PUT', { postId: POST, tagIds: ['not-a-uuid'] }),
      { env: ENV, fetch: apiReturns(200, { ok: true }) },
    );
    expect(response.status).toBe(400);
  });

  it('forwards the unknown-reference refusal, because a console has to show it', async () => {
    const response = await handleBlogPostTags(
      writeRequest('/api/blog/tags', 'PUT', { postId: POST, tagIds: [TAG] }),
      {
        env: ENV,
        fetch: apiReturns(409, { status: 409, code: 'BLOG_REFERENCE_UNKNOWN', detail: 'No such tag.' }),
      },
    );
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe('BLOG_REFERENCE_UNKNOWN');
  });
});

describe('handleBlogTaxonomySave', () => {
  it('creates with a POST and the collection route', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleBlogTaxonomySave(
      writeRequest('/api/blog/taxonomy', 'POST', { kind: 'category', slug: 'news', nameEn: 'News' }),
      { env: ENV, fetch: apiReturns(201, { id: CATEGORY }, seen) },
    );
    expect(response.status).toBe(201);
    expect(seen.value?.method).toBe('POST');
    expect(seen.value?.url).toContain('/v1/admin/blog/categories');
  });

  it('replaces with a PATCH and the identified route', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleBlogTaxonomySave(
      writeRequest('/api/blog/taxonomy', 'POST', {
        kind: 'tag',
        entryId: TAG,
        nameEn: 'Shipping and handling',
      }),
      { env: ENV, fetch: apiReturns(200, { id: TAG }, seen) },
    );
    expect(response.status).toBe(200);
    expect(seen.value?.method).toBe('PATCH');
    expect(seen.value?.url).toContain(`/v1/admin/blog/tags/${TAG}`);
  });

  it('refuses a kind it does not have, and an identifier that could not be one', async () => {
    for (const body of [
      { kind: 'widget', slug: 'x', nameEn: 'X' },
      { kind: 'category', entryId: 'not-a-uuid', nameEn: 'X' },
    ]) {
      const response = await handleBlogTaxonomySave(writeRequest('/api/blog/taxonomy', 'POST', body), {
        env: ENV,
        fetch: apiReturns(200, { id: CATEGORY }),
      });
      // An id that was sent but is not one must not silently create a second category.
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('sends a tag no sort order, because a tag has none', async () => {
    const seen: { value?: Seen } = {};
    await handleBlogTaxonomySave(
      writeRequest('/api/blog/taxonomy', 'POST', {
        kind: 'tag',
        slug: 'tips',
        nameEn: 'Tips',
        sortOrder: 5,
      }),
      { env: ENV, fetch: apiReturns(201, { id: TAG }, seen) },
    );
    const sent = JSON.parse(seen.value?.body ?? '{}') as Record<string, unknown>;
    expect('sortOrder' in sent).toBe(false);
  });

  it('keeps an absent order and activity absent, so replacing a name changes neither', async () => {
    const seen: { value?: Seen } = {};
    await handleBlogTaxonomySave(
      writeRequest('/api/blog/taxonomy', 'POST', { kind: 'category', entryId: CATEGORY, nameEn: 'Renamed' }),
      { env: ENV, fetch: apiReturns(200, { id: CATEGORY }, seen) },
    );
    const sent = JSON.parse(seen.value?.body ?? '{}') as Record<string, unknown>;
    expect(sent).toEqual({ nameEn: 'Renamed' });
  });
});
