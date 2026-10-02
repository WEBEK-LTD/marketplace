import { describe, expect, it } from 'vitest';
import {
  handleCategoryCreate,
  handleCategoryState,
  handleCategoryTranslationRemove,
  handleCategoryTranslationSave,
  handleCategoryUpdate,
  readCategoryDetail,
  readCategoryTree,
} from '../src/server/bff/categories';

/**
 * The category BFF, on the admin origin.
 *
 * What matters at this boundary:
 *
 *   * the caller's token comes from `__Host-mp_admin_access` and never from a body, and the browser's own
 *     `Cookie` header is never forwarded upstream;
 *   * **the body is rebuilt, never forwarded** — a `slug` sent to the edit route never crosses, so a rename is
 *     unexpressible from a browser, and an `isActive` sent there never crosses either, so a reordering cannot
 *     publish a category;
 *   * a category is named by its id in the **route**, from a value checked for shape here;
 *   * responses are validated against the contract before a byte reaches a browser;
 *   * the four refusals a screen must act on are forwarded with the API's own problem body, and anything else
 *     becomes one 503;
 *   * every write is same-origin, and a cross-origin submission is refused before its body is read.
 *
 * Everything is stubbed at the `fetch` boundary: no API, no database, no network.
 */

const ENV = {
  API_BASE_URL: 'https://api.internal.test',
  INTERNAL_BFF_CREDENTIAL: 'test-categories-canary-credential-abcdefghi',
} as const;

const SESSION_TOKEN = 'canary-admin-access-token-not-a-real-token';
const COOKIE = `__Host-mp_admin_access=${SESSION_TOKEN}; __Host-mp_admin_refresh=canary-refresh-not-real`;
const ORIGIN = 'https://admin.test';

const CATEGORY = 'cc000000-0000-4000-8000-0000000000c1';

const NODE = {
  categoryId: CATEGORY,
  parentId: null,
  slug: 'furniture',
  depth: 0,
  sortOrder: 1,
  listingTypeCode: 'product',
  isActive: true,
  isVisible: true,
  childCount: 1,
  listingCount: 4,
  translatedLocales: ['en', 'ar'],
  name: 'Furniture',
  updatedAt: '2026-05-02T09:00:00.000Z',
};

const DETAIL = {
  category: {
    ...NODE,
    parentSlug: null,
    createdAt: '2026-04-01T09:00:00.000Z',
    canManage: true,
  },
  translations: [
    {
      localeCode: 'en',
      name: 'Furniture',
      description: null,
      metaTitle: 'Furniture',
      metaDescription: null,
      updatedAt: '2026-05-02T09:00:00.000Z',
    },
  ],
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

function writeRequest(path: string, method: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { origin: ORIGIN, 'content-type': 'application/json', cookie: COOKIE, ...headers },
    body: JSON.stringify(body),
  });
}

/* ------------------------------------------------------------------------------------------------ */
/* Reads                                                                                            */
/* ------------------------------------------------------------------------------------------------ */

describe('readCategoryTree', () => {
  it('presents the session token upstream and never the browser cookie', async () => {
    const seen: { value?: Seen } = {};
    await readCategoryTree({
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReturns(200, { categories: [NODE] }, seen),
    });
    expect(seen.value?.url).toBe('https://api.internal.test/v1/admin/categories');
    expect(seen.value?.method).toBe('GET');
    expect(seen.value?.sessionToken).toBe(SESSION_TOKEN);
    expect(seen.value?.cookie).toBeNull();
  });

  it('returns the tree', async () => {
    const result = await readCategoryTree({
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReturns(200, { categories: [NODE] }),
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.data.categories[0]?.slug).toBe('furniture');
  });

  it('treats an empty tree as a state rather than a failure', async () => {
    const result = await readCategoryTree({ env: ENV, cookieHeader: COOKIE, fetch: apiReturns(200, { categories: [] }) });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.data.categories).toEqual([]);
  });

  it('needs a session cookie before it calls anything', async () => {
    const seen: { value?: Seen } = {};
    const result = await readCategoryTree({
      env: ENV,
      cookieHeader: null,
      fetch: apiReturns(200, { categories: [] }, seen),
    });
    expect(result.kind).toBe('unauthenticated');
    expect(seen.value).toBeUndefined();
  });

  it('maps each upstream answer to its own outcome', async () => {
    for (const [status, kind] of [
      [401, 'unauthenticated'],
      [404, 'notFound'],
      [400, 'invalid'],
      [403, 'unavailable'],
      [500, 'unavailable'],
      [503, 'unavailable'],
    ] as const) {
      const result = await readCategoryTree({ env: ENV, cookieHeader: COOKIE, fetch: apiReturns(status, {}) });
      expect(result.kind, String(status)).toBe(kind);
    }
    expect((await readCategoryTree({ env: ENV, cookieHeader: COOKIE, fetch: apiUnreachable() })).kind).toBe(
      'unavailable',
    );
  });

  it('refuses a drifted body rather than rendering it', async () => {
    for (const body of [
      { categories: [{ ...NODE, depth: 9 }] },
      { categories: [{ ...NODE, slug: 'Not A Slug' }] },
      { categories: [{ ...NODE, translatedLocales: ['fr'] }] },
      { categories: {} },
      'not json',
    ]) {
      const result = await readCategoryTree({ env: ENV, cookieHeader: COOKIE, fetch: apiReturns(200, body) });
      expect(result.kind, JSON.stringify(body)).toBe('unavailable');
    }
  });
});

describe('readCategoryDetail', () => {
  it('names the category in the route and returns it with its translations', async () => {
    const seen: { value?: Seen } = {};
    const result = await readCategoryDetail(CATEGORY, {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReturns(200, DETAIL, seen),
    });
    expect(seen.value?.url).toBe(`https://api.internal.test/v1/admin/categories/${CATEGORY}`);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.data.category.canManage).toBe(true);
      expect(result.data.translations).toHaveLength(1);
    }
  });

  it('answers notFound for an address that cannot name a category, without calling anything', async () => {
    const seen: { value?: Seen } = {};
    for (const id of [undefined, '', 'not-a-uuid', '../../admin']) {
      const result = await readCategoryDetail(id, {
        env: ENV,
        cookieHeader: COOKIE,
        fetch: apiReturns(200, DETAIL, seen),
      });
      expect(result.kind, String(id)).toBe('notFound');
    }
    expect(seen.value).toBeUndefined();
  });

  it('carries canManage false through unchanged', async () => {
    const result = await readCategoryDetail(CATEGORY, {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReturns(200, { ...DETAIL, category: { ...DETAIL.category, canManage: false } }),
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.data.category.canManage).toBe(false);
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* Writes                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

describe('creating a category', () => {
  it('sends only the contract fields and answers 201', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleCategoryCreate(
      writeRequest('/api/categories', 'POST', {
        slug: 'garden',
        listingTypeCode: 'product',
        sortOrder: 2,
        isActive: true,
        depth: 1,
        createdBy: 'somebody-else',
      }),
      { env: ENV, fetch: apiReturns(201, { categoryId: CATEGORY }, seen) },
    );
    // The body carried three fields nobody declared. None of them crossed — and `isActive` in particular, because
    // a new category is always hidden.
    expect(response.status).toBe(400);
    expect(seen.value).toBeUndefined();
  });

  it('crosses with exactly what the contract names', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleCategoryCreate(
      writeRequest('/api/categories', 'POST', { slug: 'garden', listingTypeCode: 'product', sortOrder: 2 }),
      { env: ENV, fetch: apiReturns(201, { categoryId: CATEGORY }, seen) },
    );
    expect(response.status).toBe(201);
    expect(JSON.parse(seen.value?.body ?? '{}')).toEqual({
      slug: 'garden',
      listingTypeCode: 'product',
      sortOrder: 2,
    });
    expect(seen.value?.method).toBe('POST');
  });

  it('refuses a cross-origin submission before reading its body', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleCategoryCreate(
      writeRequest('/api/categories', 'POST', { slug: 'garden' }, { origin: 'https://evil.test' }),
      { env: ENV, fetch: apiReturns(201, { categoryId: CATEGORY }, seen) },
    );
    expect(response.status).toBe(403);
    expect(seen.value).toBeUndefined();
  });

  it('needs a session', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleCategoryCreate(
      writeRequest('/api/categories', 'POST', { slug: 'garden' }, { cookie: '' }),
      { env: ENV, cookieHeader: null, fetch: apiReturns(201, {}, seen) },
    );
    expect(response.status).toBe(401);
    expect(seen.value).toBeUndefined();
  });
});

describe('editing a category', () => {
  it('cannot be asked to rename one', async () => {
    // The decisive assertion of this file. There is no rename route, and the edit route refuses the field.
    const seen: { value?: Seen } = {};
    const response = await handleCategoryUpdate(
      writeRequest('/api/categories', 'PATCH', { categoryId: CATEGORY, setParent: false, slug: 'renamed' }),
      { env: ENV, fetch: apiReturns(200, { changed: true }, seen) },
    );
    expect(response.status).toBe(400);
    expect(seen.value).toBeUndefined();
  });

  it('cannot be asked to change the visible state', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleCategoryUpdate(
      writeRequest('/api/categories', 'PATCH', { categoryId: CATEGORY, setParent: false, isActive: false }),
      { env: ENV, fetch: apiReturns(200, { changed: true }, seen) },
    );
    expect(response.status).toBe(400);
    expect(seen.value).toBeUndefined();
  });

  it('names the category in the route and keeps it out of the body', async () => {
    const seen: { value?: Seen } = {};
    await handleCategoryUpdate(
      writeRequest('/api/categories', 'PATCH', { categoryId: CATEGORY, setParent: true, parentId: null, sortOrder: 5 }),
      { env: ENV, fetch: apiReturns(200, { changed: true }, seen) },
    );
    expect(seen.value?.url).toBe(`https://api.internal.test/v1/admin/categories/${CATEGORY}`);
    expect(seen.value?.method).toBe('PATCH');
    const sent = JSON.parse(seen.value?.body ?? '{}') as Record<string, unknown>;
    expect(sent).toEqual({ setParent: true, parentId: null, sortOrder: 5 });
    expect(sent.categoryId).toBeUndefined();
  });

  it('refuses an identifier that cannot name a category', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleCategoryUpdate(
      writeRequest('/api/categories', 'PATCH', { categoryId: 'not-a-uuid', setParent: false }),
      { env: ENV, fetch: apiReturns(200, { changed: true }, seen) },
    );
    expect(response.status).toBe(400);
    expect(seen.value).toBeUndefined();
  });
});

describe('showing and hiding', () => {
  it('sends the state on its own route', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleCategoryState(
      writeRequest('/api/categories/state', 'PUT', { categoryId: CATEGORY, isActive: false }),
      { env: ENV, fetch: apiReturns(200, { changed: true }, seen) },
    );
    expect(response.status).toBe(200);
    expect(seen.value?.url).toBe(`https://api.internal.test/v1/admin/categories/${CATEGORY}/state`);
    expect(seen.value?.method).toBe('PUT');
    expect(JSON.parse(seen.value?.body ?? '{}')).toEqual({ isActive: false });
  });

  it('refuses a body with no state in it', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleCategoryState(
      writeRequest('/api/categories/state', 'PUT', { categoryId: CATEGORY }),
      { env: ENV, fetch: apiReturns(200, { changed: true }, seen) },
    );
    expect(response.status).toBe(400);
    expect(seen.value).toBeUndefined();
  });
});

describe('translations', () => {
  it('writes one locale, naming the category and the locale in the route', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleCategoryTranslationSave(
      writeRequest('/api/categories/translations', 'PUT', {
        categoryId: CATEGORY,
        localeCode: 'ar',
        name: 'أثاث',
        description: '',
      }),
      { env: ENV, fetch: apiReturns(200, { changed: true }, seen) },
    );
    expect(response.status).toBe(200);
    expect(seen.value?.url).toBe(`https://api.internal.test/v1/admin/categories/${CATEGORY}/translations/ar`);
    // The empty description crosses as an empty string, which is how a stored value is cleared.
    expect(JSON.parse(seen.value?.body ?? '{}')).toEqual({ name: 'أثاث', description: '' });
  });

  it('refuses a locale code that cannot be one', async () => {
    const seen: { value?: Seen } = {};
    for (const localeCode of ['english', 'EN', '', 'e', '../en']) {
      const response = await handleCategoryTranslationSave(
        writeRequest('/api/categories/translations', 'PUT', { categoryId: CATEGORY, localeCode, name: 'x' }),
        { env: ENV, fetch: apiReturns(200, { changed: true }, seen) },
      );
      expect(response.status, localeCode).toBe(400);
    }
    expect(seen.value).toBeUndefined();
  });

  it('removes one locale through the API’s own DELETE, with no body', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleCategoryTranslationRemove(
      writeRequest('/api/categories/translations/remove', 'POST', { categoryId: CATEGORY, localeCode: 'ar' }),
      { env: ENV, fetch: apiReturns(200, { changed: true }, seen) },
    );
    expect(response.status).toBe(200);
    expect(seen.value?.method).toBe('DELETE');
    expect(seen.value?.url).toBe(`https://api.internal.test/v1/admin/categories/${CATEGORY}/translations/ar`);
    expect(seen.value?.body).toBeNull();
  });
});

describe('what a browser is told about a refusal', () => {
  it('forwards each of the four refusals with the API’s own body', async () => {
    for (const code of [
      'CATEGORY_TREE_NOT_ALLOWED',
      'CATEGORY_SLUG_TAKEN',
      'CATEGORY_NAME_REQUIRED',
      'CATEGORY_VALUE_NOT_ALLOWED',
    ]) {
      const response = await handleCategoryCreate(
        writeRequest('/api/categories', 'POST', { slug: 'garden' }),
        { env: ENV, fetch: apiReturns(409, { status: 409, code, detail: 'A sentence a person can read.' }) },
      );
      expect(response.status, code).toBe(409);
      expect((await response.json()) as { code: string }, code).toMatchObject({ code });
    }
  });

  it('forwards a 404, so a reader who may not write is told the same thing as for an absence', async () => {
    const response = await handleCategoryUpdate(
      writeRequest('/api/categories', 'PATCH', { categoryId: CATEGORY, setParent: false }),
      { env: ENV, fetch: apiReturns(404, { status: 404, code: 'NOT_FOUND' }) },
    );
    expect(response.status).toBe(404);
  });

  it('turns anything unrecognised into one 503', async () => {
    for (const status of [418, 500, 502]) {
      const response = await handleCategoryCreate(
        writeRequest('/api/categories', 'POST', { slug: 'garden' }),
        { env: ENV, fetch: apiReturns(status, { status, code: 'SOMETHING_ELSE' }) },
      );
      expect(response.status, String(status)).toBe(503);
      expect(((await response.json()) as { code: string }).code).toBe('SERVICE_UNAVAILABLE');
    }
  });

  it('turns an unreachable API into a 503 too', async () => {
    const response = await handleCategoryCreate(writeRequest('/api/categories', 'POST', { slug: 'garden' }), {
      env: ENV,
      fetch: apiUnreachable(),
    });
    expect(response.status).toBe(503);
  });

  it('refuses a success body that does not match the contract', async () => {
    const response = await handleCategoryCreate(writeRequest('/api/categories', 'POST', { slug: 'garden' }), {
      env: ENV,
      fetch: apiReturns(201, { categoryId: 'not-a-uuid' }),
    });
    expect(response.status).toBe(503);
  });
});
