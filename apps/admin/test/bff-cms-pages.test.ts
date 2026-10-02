import { describe, expect, it } from 'vitest';
import {
  handleCmsPageCreate,
  handleCmsPageStatus,
  handleCmsPageTranslationRemove,
  handleCmsPageTranslationSave,
  handleCmsPageUpdate,
  readCmsPageDetail,
  readCmsPageList,
} from '../src/server/bff/cms-pages';

/**
 * The CMS pages BFF, on the admin origin.
 *
 * What matters at this boundary:
 *
 *   * the caller's token comes from `__Host-mp_admin_access` and never from a body, and the browser's own
 *     `Cookie` header is never forwarded upstream;
 *   * **the body is rebuilt, never forwarded** — a `createdBy`, an `updatedBy`, a `publishedAt` or a `status`
 *     sent to the settings route never crosses, so a rename cannot publish a page;
 *   * a page is named by its id in the **route**, from a value checked for shape here;
 *   * responses are validated against the contract before a byte reaches a browser;
 *   * the three refusals a screen must act on are forwarded with the API's own problem body, and anything
 *     else becomes one 503;
 *   * every write is same-origin, and a cross-origin submission is refused before its body is read.
 *
 * Everything is stubbed at the `fetch` boundary: no API, no database, no network.
 */

const ENV = {
  API_BASE_URL: 'https://api.internal.test',
  INTERNAL_BFF_CREDENTIAL: 'test-cms-pages-canary-credential-abcdefghij',
} as const;

const SESSION_TOKEN = 'canary-admin-access-token-not-a-real-token';
const COOKIE = `__Host-mp_admin_access=${SESSION_TOKEN}; __Host-mp_admin_refresh=canary-refresh-not-real`;
const ORIGIN = 'https://admin.test';

const PAGE = 'a9000000-0000-4000-8000-00000000c115';

const SUMMARY = {
  id: PAGE,
  slug: 'terms',
  pageKey: 'terms',
  status: 'published',
  template: 'legal',
  isIndexable: true,
  sortOrder: 10,
  scheduledFor: null,
  publishedAt: '2026-05-01T09:00:00.000Z',
  archivedAt: null,
  updatedAt: '2026-05-02T09:00:00.000Z',
  translatedLocales: ['en'],
  title: 'Terms of Service',
};

const DETAIL = {
  ...SUMMARY,
  createdAt: '2026-04-01T09:00:00.000Z',
  canManage: true,
  previousSlugs: ['terms-old'],
  translations: [
    {
      localeCode: 'en',
      title: 'Terms of Service',
      excerpt: null,
      body: 'The body.',
      metaTitle: 'Terms',
      metaDescription: 'Our terms.',
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

describe('readCmsPageList', () => {
  it('presents the session token upstream and never the browser cookie', async () => {
    const seen: { value?: Seen } = {};
    await readCmsPageList({}, {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReturns(200, { items: [SUMMARY], nextCursor: null }, seen),
    });
    expect(seen.value?.sessionToken).toBe(SESSION_TOKEN);
    expect(seen.value?.cookie).toBeNull();
    expect(seen.value?.method).toBe('GET');
  });

  it('is unauthenticated with no session cookie, without calling upstream', async () => {
    const seen: { value?: Seen } = {};
    const result = await readCmsPageList({}, { env: ENV, cookieHeader: null, fetch: apiReturns(200, {}, seen) });
    expect(result.kind).toBe('unauthenticated');
    expect(seen.value).toBeUndefined();
  });

  it('forwards only a well-formed cursor, status and limit', async () => {
    const seen: { value?: Seen } = {};
    const fetcher = apiReturns(200, { items: [], nextCursor: null }, seen);
    await readCmsPageList(
      { cursor: 'not a cursor!', status: 'not-a-status', limit: 'ten' },
      { env: ENV, cookieHeader: COOKIE, fetch: fetcher },
    );
    expect(seen.value?.url).toBe('https://api.internal.test/v1/admin/cms/pages');

    await readCmsPageList(
      { cursor: 'Y3AxfDIwMjY', status: 'draft', limit: '10' },
      { env: ENV, cookieHeader: COOKIE, fetch: fetcher },
    );
    expect(seen.value?.url).toContain('status=draft');
    expect(seen.value?.url).toContain('limit=10');
    expect(seen.value?.url).toContain('cursor=Y3AxfDIwMjY');
  });

  it('maps the API’s statuses onto its own outcomes', async () => {
    for (const [status, kind] of [
      [401, 'unauthenticated'],
      [404, 'notFound'],
      [400, 'invalid'],
      [503, 'unavailable'],
      [500, 'unavailable'],
    ] as const) {
      const result = await readCmsPageList({}, { env: ENV, cookieHeader: COOKIE, fetch: apiReturns(status, {}) });
      expect(result.kind, String(status)).toBe(kind);
    }
    expect(
      (await readCmsPageList({}, { env: ENV, cookieHeader: COOKIE, fetch: apiUnreachable() })).kind,
    ).toBe('unavailable');
  });

  it('refuses a drifted body instead of rendering it', async () => {
    const result = await readCmsPageList({}, {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReturns(200, { items: [{ id: PAGE }], nextCursor: null }),
    });
    expect(result.kind).toBe('unavailable');
  });
});

describe('readCmsPageDetail', () => {
  it('names the page in the route, from a value checked for shape', async () => {
    const seen: { value?: Seen } = {};
    await readCmsPageDetail(PAGE, {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReturns(200, { page: DETAIL }, seen),
    });
    expect(seen.value?.url).toBe(`https://api.internal.test/v1/admin/cms/pages/${PAGE}`);
  });

  it('treats a made-up address as notFound without calling upstream', async () => {
    const seen: { value?: Seen } = {};
    for (const id of ['not-a-uuid', '', undefined]) {
      const result = await readCmsPageDetail(id, { env: ENV, cookieHeader: COOKIE, fetch: apiReturns(200, {}, seen) });
      expect(result.kind, String(id)).toBe('notFound');
    }
    expect(seen.value).toBeUndefined();
  });

  it('unwraps the page and carries the manage capability through', async () => {
    const result = await readCmsPageDetail(PAGE, {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReturns(200, { page: { ...DETAIL, canManage: false } }),
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.data.canManage).toBe(false);
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* Writes                                                                                            */
/* ------------------------------------------------------------------------------------------------ */

describe('handleCmsPageCreate', () => {
  it('rebuilds the body from the contract’s fields and nothing else', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleCmsPageCreate(
      writeRequest('/api/cms/pages', 'POST', {
        slug: 'privacy',
        template: 'legal',
        // None of these may travel: the first two are the database's to write, the third belongs to the
        // lifecycle route, and the fourth is not a field at all.
        createdBy: 'somebody-else',
        publishedAt: '2026-01-01T00:00:00.000Z',
        status: 'published',
        smuggled: 'nope',
      }),
      { env: ENV, fetch: apiReturns(201, { id: PAGE }, seen) },
    );
    expect(response.status).toBe(201);
    const sent = JSON.parse(seen.value?.body ?? '{}') as Record<string, unknown>;
    expect(sent).toEqual({ slug: 'privacy', template: 'legal' });
  });

  it('refuses a cross-origin submission before reading the body', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleCmsPageCreate(
      writeRequest('/api/cms/pages', 'POST', { slug: 'privacy' }, { origin: 'https://evil.test' }),
      { env: ENV, fetch: apiReturns(201, { id: PAGE }, seen) },
    );
    expect(response.status).toBe(403);
    expect(seen.value).toBeUndefined();
  });

  it('refuses a submission with no session', async () => {
    const request = new Request(`${ORIGIN}/api/cms/pages`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'privacy' }),
    });
    const response = await handleCmsPageCreate(request, { env: ENV, fetch: apiReturns(201, { id: PAGE }) });
    expect(response.status).toBe(401);
  });

  it('refuses a slug the contract refuses, without calling upstream', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleCmsPageCreate(
      writeRequest('/api/cms/pages', 'POST', { slug: 'Privacy Policy' }),
      { env: ENV, fetch: apiReturns(201, { id: PAGE }, seen) },
    );
    expect(response.status).toBe(400);
    expect(seen.value).toBeUndefined();
  });
});

describe('handleCmsPageUpdate', () => {
  it('names the page in the route and drops a status field', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleCmsPageUpdate(
      writeRequest('/api/cms/pages', 'PATCH', { pageId: PAGE, slug: 'terms-of-service', status: 'published' }),
      { env: ENV, fetch: apiReturns(200, { ok: true }, seen) },
    );
    expect(response.status).toBe(200);
    expect(seen.value?.method).toBe('PATCH');
    expect(seen.value?.url).toBe(`https://api.internal.test/v1/admin/cms/pages/${PAGE}`);
    const sent = JSON.parse(seen.value?.body ?? '{}') as Record<string, unknown>;
    // A rename cannot publish a page: the field is not in the contract, so it cannot cross.
    expect('status' in sent).toBe(false);
    expect(sent['slug']).toBe('terms-of-service');
  });

  it('keeps an empty page key, because that is how a key is cleared', async () => {
    const seen: { value?: Seen } = {};
    await handleCmsPageUpdate(writeRequest('/api/cms/pages', 'PATCH', { pageId: PAGE, pageKey: '' }), {
      env: ENV,
      fetch: apiReturns(200, { ok: true }, seen),
    });
    expect(JSON.parse(seen.value?.body ?? '{}')).toEqual({ pageKey: '' });
  });

  it('refuses an empty change and a malformed page id', async () => {
    const seen: { value?: Seen } = {};
    const empty = await handleCmsPageUpdate(writeRequest('/api/cms/pages', 'PATCH', { pageId: PAGE }), {
      env: ENV,
      fetch: apiReturns(200, { ok: true }, seen),
    });
    const bad = await handleCmsPageUpdate(
      writeRequest('/api/cms/pages', 'PATCH', { pageId: 'nope', slug: 'x' }),
      { env: ENV, fetch: apiReturns(200, { ok: true }, seen) },
    );
    expect(empty.status).toBe(400);
    expect(bad.status).toBe(400);
    expect(seen.value).toBeUndefined();
  });
});

describe('handleCmsPageStatus', () => {
  it('puts the lifecycle change at its own address', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleCmsPageStatus(
      writeRequest('/api/cms/pages/status', 'PUT', { pageId: PAGE, status: 'published' }),
      { env: ENV, fetch: apiReturns(200, { ok: true }, seen) },
    );
    expect(response.status).toBe(200);
    expect(seen.value?.method).toBe('PUT');
    expect(seen.value?.url).toBe(`https://api.internal.test/v1/admin/cms/pages/${PAGE}/status`);
    expect(JSON.parse(seen.value?.body ?? '{}')).toEqual({ status: 'published' });
  });

  it('requires a moment for a scheduled page and refuses one otherwise', async () => {
    const seen: { value?: Seen } = {};
    const missing = await handleCmsPageStatus(
      writeRequest('/api/cms/pages/status', 'PUT', { pageId: PAGE, status: 'scheduled' }),
      { env: ENV, fetch: apiReturns(200, { ok: true }, seen) },
    );
    const extra = await handleCmsPageStatus(
      writeRequest('/api/cms/pages/status', 'PUT', {
        pageId: PAGE,
        status: 'draft',
        scheduledFor: '2026-12-01T00:00:00.000Z',
      }),
      { env: ENV, fetch: apiReturns(200, { ok: true }, seen) },
    );
    expect(missing.status).toBe(400);
    expect(extra.status).toBe(400);
    expect(seen.value).toBeUndefined();
  });

  it('forwards each of the three refusals with the API’s own code', async () => {
    for (const code of ['CMS_PAGE_LOCALE_REQUIRED', 'CMS_PAGE_TRANSITION_NOT_ALLOWED', 'CMS_PAGE_SLUG_TAKEN']) {
      const response = await handleCmsPageStatus(
        writeRequest('/api/cms/pages/status', 'PUT', { pageId: PAGE, status: 'published' }),
        { env: ENV, fetch: apiReturns(409, { status: 409, code, detail: 'because' }) },
      );
      expect(response.status, code).toBe(409);
      expect(((await response.json()) as { code: string }).code, code).toBe(code);
    }
  });

  it('turns an unexpected upstream status into one 503', async () => {
    for (const status of [418, 500, 502]) {
      const response = await handleCmsPageStatus(
        writeRequest('/api/cms/pages/status', 'PUT', { pageId: PAGE, status: 'published' }),
        { env: ENV, fetch: apiReturns(status, { status }) },
      );
      expect(response.status, String(status)).toBe(503);
    }
  });

  it('refuses a drifted success body rather than reporting success', async () => {
    const response = await handleCmsPageStatus(
      writeRequest('/api/cms/pages/status', 'PUT', { pageId: PAGE, status: 'published' }),
      { env: ENV, fetch: apiReturns(200, { ok: 'yes' }) },
    );
    expect(response.status).toBe(503);
  });
});

describe('handleCmsPageTranslationSave', () => {
  it('puts the locale in the route and the text in the body', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleCmsPageTranslationSave(
      writeRequest('/api/cms/pages/translations', 'PUT', {
        pageId: PAGE,
        localeCode: 'ar',
        title: 'شروط الخدمة',
        body: 'النص.',
        metaTitle: null,
      }),
      { env: ENV, fetch: apiReturns(200, { ok: true }, seen) },
    );
    expect(response.status).toBe(200);
    expect(seen.value?.url).toBe(`https://api.internal.test/v1/admin/cms/pages/${PAGE}/translations/ar`);
    const sent = JSON.parse(seen.value?.body ?? '{}') as Record<string, unknown>;
    expect(sent['title']).toBe('شروط الخدمة');
    expect(sent['metaTitle']).toBeNull();
    expect('pageId' in sent).toBe(false);
    expect('localeCode' in sent).toBe(false);
  });

  it('refuses a locale that cannot be one, without calling upstream', async () => {
    const seen: { value?: Seen } = {};
    for (const locale of ['eng', 'E', '', '../en']) {
      const response = await handleCmsPageTranslationSave(
        writeRequest('/api/cms/pages/translations', 'PUT', {
          pageId: PAGE,
          localeCode: locale,
          title: 'T',
          body: 'B',
        }),
        { env: ENV, fetch: apiReturns(200, { ok: true }, seen) },
      );
      expect(response.status, locale).toBe(400);
    }
    expect(seen.value).toBeUndefined();
  });

  it('refuses text the contract refuses', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleCmsPageTranslationSave(
      writeRequest('/api/cms/pages/translations', 'PUT', {
        pageId: PAGE,
        localeCode: 'en',
        title: 'a'.repeat(201),
        body: 'B',
      }),
      { env: ENV, fetch: apiReturns(200, { ok: true }, seen) },
    );
    expect(response.status).toBe(400);
    expect(seen.value).toBeUndefined();
  });
});

describe('handleCmsPageTranslationRemove', () => {
  it('calls the API’s DELETE with no body', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleCmsPageTranslationRemove(
      writeRequest('/api/cms/pages/translations/remove', 'POST', { pageId: PAGE, localeCode: 'ar' }),
      { env: ENV, fetch: apiReturns(200, { ok: true }, seen) },
    );
    expect(response.status).toBe(200);
    expect(seen.value?.method).toBe('DELETE');
    expect(seen.value?.url).toBe(`https://api.internal.test/v1/admin/cms/pages/${PAGE}/translations/ar`);
    expect(seen.value?.body).toBeNull();
  });

  it('forwards the refusal that a live page keeps a locale', async () => {
    const response = await handleCmsPageTranslationRemove(
      writeRequest('/api/cms/pages/translations/remove', 'POST', { pageId: PAGE, localeCode: 'en' }),
      {
        env: ENV,
        fetch: apiReturns(409, { status: 409, code: 'CMS_PAGE_LOCALE_REQUIRED', detail: 'because' }),
      },
    );
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe('CMS_PAGE_LOCALE_REQUIRED');
  });

  it('refuses a cross-origin submission', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleCmsPageTranslationRemove(
      writeRequest(
        '/api/cms/pages/translations/remove',
        'POST',
        { pageId: PAGE, localeCode: 'en' },
        { origin: 'https://evil.test' },
      ),
      { env: ENV, fetch: apiReturns(200, { ok: true }, seen) },
    );
    expect(response.status).toBe(403);
    expect(seen.value).toBeUndefined();
  });
});
