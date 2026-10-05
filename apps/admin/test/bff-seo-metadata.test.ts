import { describe, expect, it } from 'vitest';
import {
  handleSeoMetadataRemove,
  handleSeoMetadataSave,
  readSeoMetadataEntry,
  readSeoMetadataList,
} from '../src/server/bff/seo-metadata';

/**
 * The metadata-override BFF, on the admin origin.
 *
 * What matters at this boundary:
 *
 *   * the caller's token comes from `__Host-mp_admin_access` and never from a body, and the browser's own `Cookie`
 *     header is never forwarded upstream;
 *   * **the body is rebuilt, never forwarded** — a `structuredData`, an `updatedBy` or a `twitterSite` has nowhere to
 *     go, because none is a field of the contract;
 *   * **absent stays absent.** A save is a replace and the API clears what it is not given, so turning an absent
 *     field into null here would be making the same decision twice in two places;
 *   * responses are validated before a byte reaches a browser, so a permissive directive or an external canonical the
 *     API should never send cannot reach a screen;
 *   * the two refusals a screen must act on are forwarded with the API's own problem body, and anything else becomes
 *     one 503;
 *   * every write is same-origin, and a cross-origin submission is refused before its body is read.
 *
 * Everything is stubbed at the `fetch` boundary: no API, no database, no network.
 */

const ENV = {
  API_BASE_URL: 'https://api.internal.test',
  INTERNAL_BFF_CREDENTIAL: 'test-metadata-canary-credential-abcdefghijk',
} as const;

const SESSION_TOKEN = 'canary-admin-access-token-not-a-real-token';
const COOKIE = `__Host-mp_admin_access=${SESSION_TOKEN}; __Host-mp_admin_refresh=canary-refresh-not-real`;
const ORIGIN = 'https://admin.test';

const ENTRY = 'a9000000-0000-4000-8000-00000000d7a1';
const CATEGORY = '22222222-2222-4222-8222-222222222222';

const LIST_ENTRY = {
  id: ENTRY,
  entityType: 'category',
  entityId: CATEGORY,
  routePath: null,
  targetSlug: 'furniture',
  localeCode: 'en',
  metaTitle: 'Lovely furniture',
  metaDescription: null,
  canonicalPath: '/elsewhere',
  robotsDirectives: ['index', 'follow'],
  ogTitle: null,
  ogDescription: null,
  shareMediaId: null,
  canonicalIsHonoured: false,
  updatedAt: '2026-05-02T09:00:00.000Z',
};

const DETAIL_ENTRY = {
  ...LIST_ENTRY,
  shareObjectPath: null,
  effectiveCanonicalPath: null,
  effectiveRobotsDirectives: [],
  createdAt: '2026-05-01T09:00:00.000Z',
  updatedBy: '11111111-1111-4111-8111-111111111111',
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

describe('readSeoMetadataList', () => {
  it('presents the session token upstream and never the browser cookie', async () => {
    const seen: { value?: Seen } = {};
    await readSeoMetadataList({}, {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReturns(200, { items: [LIST_ENTRY], nextCursor: null }, seen),
    });
    expect(seen.value?.sessionToken).toBe(SESSION_TOKEN);
    expect(seen.value?.cookie).toBeNull();
  });

  it('is unauthenticated with no session cookie, without calling upstream', async () => {
    const seen: { value?: Seen } = {};
    const result = await readSeoMetadataList({}, { env: ENV, cookieHeader: null, fetch: apiReturns(200, {}, seen) });
    expect(result.kind).toBe('unauthenticated');
    expect(seen.value).toBeUndefined();
  });

  it('forwards only a kind the table allows, a real locale, a sane limit and a well-formed cursor', async () => {
    const seen: { value?: Seen } = {};
    const fetcher = apiReturns(200, { items: [], nextCursor: null }, seen);
    await readSeoMetadataList(
      { entityType: 'widget', locale: 'eng', limit: 'ten', cursor: 'not a cursor!' },
      { env: ENV, cookieHeader: COOKIE, fetch: fetcher },
    );
    expect(seen.value?.url).toBe('https://api.internal.test/v1/admin/seo/metadata');

    await readSeoMetadataList(
      { entityType: 'listing', locale: 'ar', limit: '10', cursor: 'bXQxfDIwMjY' },
      { env: ENV, cookieHeader: COOKIE, fetch: fetcher },
    );
    expect(seen.value?.url).toContain('entityType=listing');
    expect(seen.value?.url).toContain('locale=ar');
    expect(seen.value?.url).toContain('limit=10');
    expect(seen.value?.url).toContain('cursor=bXQxfDIwMjY');
  });

  it('forwards a kind the console cannot write but the table can hold', async () => {
    // A stored blog entry has to be listable, or the screen that lists it would hide a row that exists.
    const seen: { value?: Seen } = {};
    await readSeoMetadataList(
      { entityType: 'blog_post' },
      { env: ENV, cookieHeader: COOKIE, fetch: apiReturns(200, { items: [], nextCursor: null }, seen) },
    );
    expect(seen.value?.url).toContain('entityType=blog_post');
  });

  it('sorts an absence, a bad cursor and an outage into three answers', async () => {
    for (const [status, kind] of [
      [401, 'unauthenticated'],
      [404, 'notFound'],
      [400, 'invalid'],
      [503, 'unavailable'],
      [500, 'unavailable'],
    ] as const) {
      const result = await readSeoMetadataList({}, {
        env: ENV,
        cookieHeader: COOKIE,
        fetch: apiReturns(status, { status, code: 'X' }),
      });
      expect(result.kind, String(status)).toBe(kind);
    }
    const down = await readSeoMetadataList({}, { env: ENV, cookieHeader: COOKIE, fetch: apiUnreachable() });
    expect(down.kind).toBe('unavailable');
  });

  it('refuses a body the contract does not recognise rather than rendering part of it', async () => {
    for (const body of [
      { items: [{ ...LIST_ENTRY, entityType: 'service' }], nextCursor: null },
      { items: [{ ...LIST_ENTRY, robotsDirectives: ['sometimes'] }], nextCursor: null },
      { items: [{ ...LIST_ENTRY, canonicalPath: 'https://evil.test/' }], nextCursor: null },
      { items: [{ ...LIST_ENTRY, structuredData: {} }], nextCursor: null },
      { items: [LIST_ENTRY] },
      'not json at all',
    ]) {
      const result = await readSeoMetadataList({}, { env: ENV, cookieHeader: COOKIE, fetch: apiReturns(200, body) });
      expect(result.kind, JSON.stringify(body).slice(0, 50)).toBe('unavailable');
    }
  });
});

describe('readSeoMetadataEntry', () => {
  it('names the entry in the route, from a value checked for shape', async () => {
    const seen: { value?: Seen } = {};
    await readSeoMetadataEntry(ENTRY.toUpperCase(), {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReturns(200, { entry: DETAIL_ENTRY }, seen),
    });
    expect(seen.value?.url).toBe(`https://api.internal.test/v1/admin/seo/metadata/${ENTRY}`);
  });

  it('is notFound for an identifier that is not one, without calling upstream', async () => {
    const seen: { value?: Seen } = {};
    for (const id of [undefined, '', 'not-a-uuid', '../../v1/admin/session']) {
      const result = await readSeoMetadataEntry(id, {
        env: ENV,
        cookieHeader: COOKIE,
        fetch: apiReturns(200, { entry: DETAIL_ENTRY }, seen),
      });
      expect(result.kind, String(id)).toBe('notFound');
    }
    expect(seen.value).toBeUndefined();
  });

  it('keeps the stored value and the effective value apart', async () => {
    const result = await readSeoMetadataEntry(ENTRY, {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReturns(200, { entry: DETAIL_ENTRY }),
    });
    expect(result.kind === 'ok' && result.data.canonicalPath).toBe('/elsewhere');
    expect(result.kind === 'ok' && result.data.effectiveCanonicalPath).toBeNull();
  });

  it('refuses a detail that claims a permissive directive will take effect', async () => {
    const result = await readSeoMetadataEntry(ENTRY, {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReturns(200, { entry: { ...DETAIL_ENTRY, effectiveRobotsDirectives: ['index'] } }),
    });
    // The database cannot emit that, so receiving it means something upstream is wrong and a screen must not say it.
    expect(result.kind).toBe('unavailable');
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* Writes                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

describe('handleSeoMetadataSave', () => {
  it('is a PUT upstream, carrying only the fields the contract declares', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleSeoMetadataSave(
      writeRequest('/api/seo/metadata', 'PUT', {
        entityType: 'category',
        entityId: CATEGORY,
        localeCode: 'en',
        metaTitle: 'Lovely furniture',
        robotsDirectives: ['noindex'],
        structuredData: { '@type': 'Product' },
        updatedBy: 'somebody-else',
        twitterSite: '@x',
      }),
      { env: ENV, fetch: apiReturns(200, { id: ENTRY }, seen) },
    );
    expect(response.status).toBe(200);
    expect(seen.value?.method).toBe('PUT');
    expect(seen.value?.url).toBe('https://api.internal.test/v1/admin/seo/metadata');
    const body = JSON.parse(seen.value?.body ?? '{}') as Record<string, unknown>;
    expect(body).toEqual({
      entityType: 'category',
      entityId: CATEGORY,
      localeCode: 'en',
      metaTitle: 'Lovely furniture',
      robotsDirectives: ['noindex'],
    });
  });

  it('leaves an absent field absent, because the API clears what it is not given', async () => {
    const seen: { value?: Seen } = {};
    await handleSeoMetadataSave(
      writeRequest('/api/seo/metadata', 'PUT', { entityType: 'route', routePath: '/listings', localeCode: 'en' }),
      { env: ENV, fetch: apiReturns(200, { id: ENTRY }, seen) },
    );
    const body = JSON.parse(seen.value?.body ?? '{}') as Record<string, unknown>;
    // Not `metaTitle: null`. One decision, made in one place.
    expect('metaTitle' in body).toBe(false);
    expect('canonicalPath' in body).toBe(false);
  });

  it('refuses a request the table could not store, without an upstream hop', async () => {
    const seen: { value?: Seen } = {};
    for (const payload of [
      {},
      { entityType: 'category', localeCode: 'en' },
      { entityType: 'route', localeCode: 'en' },
      { entityType: 'blog_post', entityId: CATEGORY, localeCode: 'en' },
      { entityType: 'service', entityId: CATEGORY, localeCode: 'en' },
      { entityType: 'category', entityId: CATEGORY, localeCode: 'en', canonicalPath: '//evil.test' },
      { entityType: 'category', entityId: CATEGORY, localeCode: 'en', robotsDirectives: ['index', 'noindex'] },
    ]) {
      const response = await handleSeoMetadataSave(writeRequest('/api/seo/metadata', 'PUT', payload), {
        env: ENV,
        fetch: apiReturns(200, { id: ENTRY }, seen),
      });
      expect(response.status, JSON.stringify(payload)).toBe(400);
    }
    expect(seen.value).toBeUndefined();
  });

  it('forwards the two refusals a screen must act on, with the API’s own code', async () => {
    for (const [status, code] of [
      [409, 'SEO_METADATA_NOT_ALLOWED'],
      [409, 'SEO_METADATA_TARGET_UNKNOWN'],
      [404, 'NOT_FOUND'],
      [401, 'AUTHENTICATION_REQUIRED'],
    ] as const) {
      const response = await handleSeoMetadataSave(
        writeRequest('/api/seo/metadata', 'PUT', { entityType: 'route', routePath: '/x', localeCode: 'en' }),
        { env: ENV, fetch: apiReturns(status, { status, code }) },
      );
      expect(response.status, code).toBe(status);
      expect(((await response.json()) as { code: string }).code, code).toBe(code);
    }
  });

  it('collapses a status nobody expected into one outage', async () => {
    for (const status of [418, 500, 502]) {
      const response = await handleSeoMetadataSave(
        writeRequest('/api/seo/metadata', 'PUT', { entityType: 'route', routePath: '/x', localeCode: 'en' }),
        { env: ENV, fetch: apiReturns(status, { status, code: 'SOMETHING_ELSE' }) },
      );
      expect(response.status, String(status)).toBe(503);
    }
  });

  it('refuses a cross-origin submission before reading its body, and needs a session', async () => {
    const seen: { value?: Seen } = {};
    const crossOrigin = await handleSeoMetadataSave(
      writeRequest('/api/seo/metadata', 'PUT', { entityType: 'route', routePath: '/x', localeCode: 'en' }, {
        origin: 'https://not-the-admin.test',
      }),
      { env: ENV, fetch: apiReturns(200, { id: ENTRY }, seen) },
    );
    expect(crossOrigin.status).toBe(403);
    expect(seen.value).toBeUndefined();

    const noSession = await handleSeoMetadataSave(
      new Request(`${ORIGIN}/api/seo/metadata`, {
        method: 'PUT',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ entityType: 'route', routePath: '/x', localeCode: 'en' }),
      }),
      { env: ENV, fetch: apiReturns(200, { id: ENTRY }) },
    );
    expect(noSession.status).toBe(401);
  });
});

describe('handleSeoMetadataRemove', () => {
  it('is a POST here and a DELETE upstream, carrying no body', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleSeoMetadataRemove(
      writeRequest('/api/seo/metadata/remove', 'POST', { entryId: ENTRY }),
      { env: ENV, fetch: apiReturns(200, { ok: true }, seen) },
    );
    expect(response.status).toBe(200);
    expect(seen.value?.method).toBe('DELETE');
    expect(seen.value?.url).toBe(`https://api.internal.test/v1/admin/seo/metadata/${ENTRY}`);
    expect(seen.value?.body).toBeNull();
  });

  it('refuses a removal that names no entry', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleSeoMetadataRemove(writeRequest('/api/seo/metadata/remove', 'POST', {}), {
      env: ENV,
      fetch: apiReturns(200, { ok: true }, seen),
    });
    expect(response.status).toBe(400);
    expect(seen.value).toBeUndefined();
  });

  it('is an absence when the override is gone, and an outage when the API is', async () => {
    const absent = await handleSeoMetadataRemove(
      writeRequest('/api/seo/metadata/remove', 'POST', { entryId: ENTRY }),
      { env: ENV, fetch: apiReturns(404, { status: 404, code: 'NOT_FOUND' }) },
    );
    expect(absent.status).toBe(404);

    const down = await handleSeoMetadataRemove(
      writeRequest('/api/seo/metadata/remove', 'POST', { entryId: ENTRY }),
      { env: ENV, fetch: apiUnreachable() },
    );
    expect(down.status).toBe(503);
  });

  it('caches nothing it answers', async () => {
    const response = await handleSeoMetadataRemove(
      writeRequest('/api/seo/metadata/remove', 'POST', { entryId: ENTRY }),
      { env: ENV, fetch: apiReturns(200, { ok: true }) },
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
