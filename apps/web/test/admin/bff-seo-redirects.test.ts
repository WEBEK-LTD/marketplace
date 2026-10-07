import { describe, expect, it } from 'vitest';
import {
  handleSeoRedirectCreate,
  handleSeoRedirectRemove,
  handleSeoRedirectState,
  handleSeoRedirectUpdate,
  readSeoRedirectDetail,
  readSeoRedirectList,
} from '../../src/admin/server/bff/seo-redirects';

/**
 * The redirect-map BFF, on the admin origin.
 *
 * What matters at this boundary:
 *
 *   * the caller's token comes from `__Host-mp_admin_access` and never from a body, and the browser's own `Cookie`
 *     header is never forwarded upstream;
 *   * **the body is rebuilt, never forwarded** — an `isActive` sent to the edit route never crosses, so correcting a
 *     destination cannot switch a redirect on, and a `priority` or a `pattern` has nowhere to go because this map
 *     has neither;
 *   * an entry is named by its id in the **route**, from a value checked for shape here;
 *   * responses are validated against the contract before a byte reaches a browser, so a destination the table
 *     could not have stored never reaches a screen;
 *   * the two refusals a screen must act on are forwarded with the API's own problem body, and anything else
 *     becomes one 503;
 *   * every write is same-origin, and a cross-origin submission is refused before its body is read.
 *
 * Everything is stubbed at the `fetch` boundary: no API, no database, no network.
 */

const ENV = {
  API_BASE_URL: 'https://api.internal.test',
  INTERNAL_BFF_CREDENTIAL: 'test-redirects-canary-credential-abcdefghij',
} as const;

const SESSION_TOKEN = 'canary-admin-access-token-not-a-real-token';
const COOKIE = `__Host-mp_admin_access=${SESSION_TOKEN}; __Host-mp_admin_refresh=canary-refresh-not-real`;
const ORIGIN = 'https://admin.test';

const ENTRY = 'a9000000-0000-4000-8000-00000000d1c7';

const SUMMARY = {
  id: ENTRY,
  fromPath: '/old-offer',
  toPath: '/new-offer',
  statusCode: 301,
  isActive: true,
  note: 'campaign ended',
  createdAt: '2026-05-01T09:00:00.000Z',
  updatedAt: '2026-05-02T09:00:00.000Z',
};

const DETAIL = {
  ...SUMMARY,
  createdBy: '11111111-1111-4111-8111-111111111111',
  canManage: true,
  resolvedToPath: '/new-offer',
  resolvedStatusCode: 301,
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

describe('readSeoRedirectList', () => {
  it('presents the session token upstream and never the browser cookie', async () => {
    const seen: { value?: Seen } = {};
    await readSeoRedirectList({}, {
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
    const result = await readSeoRedirectList({}, { env: ENV, cookieHeader: null, fetch: apiReturns(200, {}, seen) });
    expect(result.kind).toBe('unauthenticated');
    expect(seen.value).toBeUndefined();
  });

  it('forwards only a well-formed cursor, limit and state filter', async () => {
    const seen: { value?: Seen } = {};
    const fetcher = apiReturns(200, { items: [], nextCursor: null }, seen);
    await readSeoRedirectList(
      { cursor: 'not a cursor!', limit: 'ten', active: 'maybe' },
      { env: ENV, cookieHeader: COOKIE, fetch: fetcher },
    );
    expect(seen.value?.url).toBe('https://api.internal.test/v1/admin/seo/redirects');

    await readSeoRedirectList(
      { cursor: 'cmQxfDIwMjY', limit: '10', active: 'false' },
      { env: ENV, cookieHeader: COOKIE, fetch: fetcher },
    );
    expect(seen.value?.url).toContain('limit=10');
    expect(seen.value?.url).toContain('active=false');
    expect(seen.value?.url).toContain('cursor=cmQxfDIwMjY');
  });

  it('passes the search through as text, because the database matches it literally', async () => {
    const seen: { value?: Seen } = {};
    await readSeoRedirectList(
      { search: '%_offer' },
      { env: ENV, cookieHeader: COOKIE, fetch: apiReturns(200, { items: [], nextCursor: null }, seen) },
    );
    // Nothing is escaped and nothing is stripped: there is no pattern syntax on this map to defend against.
    expect(seen.value?.url).toContain(`search=${encodeURIComponent('%_offer')}`);
  });

  it('returns the page it was given', async () => {
    const result = await readSeoRedirectList({}, {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReturns(200, { items: [SUMMARY], nextCursor: null }),
    });
    expect(result.kind).toBe('ok');
    expect(result.kind === 'ok' && result.data.items[0]?.fromPath).toBe('/old-offer');
  });

  it('sorts an absence, a bad cursor and an outage into three answers', async () => {
    for (const [status, kind] of [
      [401, 'unauthenticated'],
      [404, 'notFound'],
      [400, 'invalid'],
      [503, 'unavailable'],
      [500, 'unavailable'],
    ] as const) {
      const result = await readSeoRedirectList({}, {
        env: ENV,
        cookieHeader: COOKIE,
        fetch: apiReturns(status, { status, code: 'X' }),
      });
      expect(result.kind, String(status)).toBe(kind);
    }
  });

  it('is an outage when the API cannot be reached', async () => {
    const result = await readSeoRedirectList({}, { env: ENV, cookieHeader: COOKIE, fetch: apiUnreachable() });
    expect(result.kind).toBe('unavailable');
  });

  it('refuses a body the contract does not recognise rather than rendering part of it', async () => {
    for (const body of [
      { items: [{ ...SUMMARY, statusCode: 303 }], nextCursor: null },
      { items: [{ ...SUMMARY, toPath: 'https://evil.test/' }], nextCursor: null },
      { items: [{ ...SUMMARY, priority: 10 }], nextCursor: null },
      { items: [SUMMARY] },
      'not json at all',
    ]) {
      const result = await readSeoRedirectList({}, {
        env: ENV,
        cookieHeader: COOKIE,
        fetch: apiReturns(200, body),
      });
      expect(result.kind, JSON.stringify(body).slice(0, 50)).toBe('unavailable');
    }
  });
});

describe('readSeoRedirectDetail', () => {
  it('names the entry in the route, from a value checked for shape', async () => {
    const seen: { value?: Seen } = {};
    await readSeoRedirectDetail(ENTRY.toUpperCase(), {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReturns(200, { redirect: DETAIL }, seen),
    });
    expect(seen.value?.url).toBe(`https://api.internal.test/v1/admin/seo/redirects/${ENTRY}`);
  });

  it('is notFound for an identifier that is not one, without calling upstream', async () => {
    const seen: { value?: Seen } = {};
    for (const id of [undefined, '', 'not-a-uuid', '../../v1/admin/session']) {
      const result = await readSeoRedirectDetail(id, {
        env: ENV,
        cookieHeader: COOKIE,
        fetch: apiReturns(200, { redirect: DETAIL }, seen),
      });
      expect(result.kind, String(id)).toBe('notFound');
    }
    expect(seen.value).toBeUndefined();
  });

  it('unwraps the entry and keeps the manage capability', async () => {
    const result = await readSeoRedirectDetail(ENTRY, {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReturns(200, { redirect: { ...DETAIL, canManage: false } }),
    });
    expect(result.kind === 'ok' && result.data.canManage).toBe(false);
  });

  it('refuses a detail with no manage capability on it', async () => {
    const { canManage: _dropped, ...withoutCapability } = DETAIL;
    const result = await readSeoRedirectDetail(ENTRY, {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReturns(200, { redirect: withoutCapability }),
    });
    // A screen renders its controls from that field, so its absence must be a failure rather than a falsy default.
    expect(result.kind).toBe('unavailable');
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* Writes                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

describe('handleSeoRedirectCreate', () => {
  it('rebuilds the body and never forwards a field nobody declared', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleSeoRedirectCreate(
      writeRequest('/api/seo/redirects', 'POST', {
        fromPath: '/old-offer',
        toPath: '/new-offer',
        statusCode: 308,
        note: 'campaign ended',
        isActive: false,
        priority: 10,
        pattern: '/old/*',
        createdBy: 'somebody-else',
      }),
      { env: ENV, fetch: apiReturns(201, { id: ENTRY }, seen) },
    );
    expect(response.status).toBe(201);
    const body = JSON.parse(seen.value?.body ?? '{}') as Record<string, unknown>;
    expect(body).toEqual({
      fromPath: '/old-offer',
      toPath: '/new-offer',
      statusCode: 308,
      note: 'campaign ended',
      isActive: false,
    });
  });

  it('refuses a request the table could not store, without an upstream hop', async () => {
    const seen: { value?: Seen } = {};
    for (const payload of [
      { fromPath: 'old-offer', toPath: '/new' },
      { fromPath: '/old', toPath: 'https://evil.test/' },
      { fromPath: '/old', toPath: '//evil.test' },
      { fromPath: '/same', toPath: '/same' },
      { fromPath: '/old', toPath: '/new', statusCode: 303 },
      { fromPath: '/old' },
      {},
    ]) {
      const response = await handleSeoRedirectCreate(
        writeRequest('/api/seo/redirects', 'POST', payload),
        { env: ENV, fetch: apiReturns(201, { id: ENTRY }, seen) },
      );
      expect(response.status, JSON.stringify(payload)).toBe(400);
    }
    expect(seen.value).toBeUndefined();
  });

  it('forwards the two refusals a screen must act on, with the API’s own code', async () => {
    for (const [status, code] of [
      [409, 'SEO_REDIRECT_PATH_TAKEN'],
      [409, 'SEO_REDIRECT_NOT_ALLOWED'],
      [404, 'NOT_FOUND'],
      [401, 'AUTHENTICATION_REQUIRED'],
    ] as const) {
      const response = await handleSeoRedirectCreate(
        writeRequest('/api/seo/redirects', 'POST', { fromPath: '/old', toPath: '/new' }),
        { env: ENV, fetch: apiReturns(status, { status, code }) },
      );
      expect(response.status, code).toBe(status);
      expect(((await response.json()) as { code: string }).code, code).toBe(code);
    }
  });

  it('collapses a status nobody expected into one outage', async () => {
    for (const status of [418, 500, 502]) {
      const response = await handleSeoRedirectCreate(
        writeRequest('/api/seo/redirects', 'POST', { fromPath: '/old', toPath: '/new' }),
        { env: ENV, fetch: apiReturns(status, { status, code: 'SOMETHING_ELSE' }) },
      );
      // A screen can act on a refusal it understands; anything else is not a refusal it can do anything about.
      expect(response.status, String(status)).toBe(503);
    }
  });

  it('refuses a cross-origin submission before reading its body', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleSeoRedirectCreate(
      writeRequest('/api/seo/redirects', 'POST', { fromPath: '/old', toPath: '/new' }, {
        origin: 'https://not-the-admin.test',
      }),
      { env: ENV, fetch: apiReturns(201, { id: ENTRY }, seen) },
    );
    expect(response.status).toBe(403);
    expect(seen.value).toBeUndefined();
  });

  it('needs a session cookie', async () => {
    const response = await handleSeoRedirectCreate(
      new Request(`${ORIGIN}/api/seo/redirects`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ fromPath: '/old', toPath: '/new' }),
      }),
      { env: ENV, fetch: apiReturns(201, { id: ENTRY }) },
    );
    expect(response.status).toBe(401);
  });
});

describe('handleSeoRedirectUpdate', () => {
  it('names the entry in the route and sends only the fields the contract declares', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleSeoRedirectUpdate(
      writeRequest('/api/seo/redirects', 'PATCH', {
        redirectId: ENTRY,
        toPath: '/newer-offer',
        note: '',
      }),
      { env: ENV, fetch: apiReturns(200, { ok: true }, seen) },
    );
    expect(response.status).toBe(200);
    expect(seen.value?.url).toBe(`https://api.internal.test/v1/admin/seo/redirects/${ENTRY}`);
    expect(seen.value?.method).toBe('PATCH');
    expect(JSON.parse(seen.value?.body ?? '{}')).toEqual({ toPath: '/newer-offer', note: '' });
  });

  it('never lets an edit switch a redirect on', async () => {
    const seen: { value?: Seen } = {};
    await handleSeoRedirectUpdate(
      writeRequest('/api/seo/redirects', 'PATCH', { redirectId: ENTRY, toPath: '/newer', isActive: true }),
      { env: ENV, fetch: apiReturns(200, { ok: true }, seen) },
    );
    const body = JSON.parse(seen.value?.body ?? '{}') as Record<string, unknown>;
    // Dropped here, so the API is never even asked. This is the assertion that keeps a rename from starting a
    // redirect nobody meant to start.
    expect('isActive' in body).toBe(false);
  });

  it('refuses an edit that names no entry, or changes nothing', async () => {
    const seen: { value?: Seen } = {};
    for (const payload of [
      { toPath: '/newer' },
      { redirectId: 'not-a-uuid', toPath: '/newer' },
      { redirectId: ENTRY },
      { redirectId: ENTRY, isActive: true },
    ]) {
      const response = await handleSeoRedirectUpdate(
        writeRequest('/api/seo/redirects', 'PATCH', payload),
        { env: ENV, fetch: apiReturns(200, { ok: true }, seen) },
      );
      expect(response.status, JSON.stringify(payload)).toBe(400);
    }
    expect(seen.value).toBeUndefined();
  });
});

describe('handleSeoRedirectState', () => {
  it('sends the state to its own route and nothing else with it', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleSeoRedirectState(
      writeRequest('/api/seo/redirects/state', 'PUT', {
        redirectId: ENTRY,
        isActive: true,
        toPath: '/somewhere-else',
      }),
      { env: ENV, fetch: apiReturns(200, { ok: true }, seen) },
    );
    expect(response.status).toBe(200);
    expect(seen.value?.url).toBe(`https://api.internal.test/v1/admin/seo/redirects/${ENTRY}/state`);
    expect(seen.value?.method).toBe('PUT');
    expect(JSON.parse(seen.value?.body ?? '{}')).toEqual({ isActive: true });
  });

  it('refuses a request that does not say which state', async () => {
    const seen: { value?: Seen } = {};
    for (const payload of [{ redirectId: ENTRY }, { redirectId: ENTRY, isActive: 'true' }, { isActive: true }]) {
      const response = await handleSeoRedirectState(
        writeRequest('/api/seo/redirects/state', 'PUT', payload),
        { env: ENV, fetch: apiReturns(200, { ok: true }, seen) },
      );
      expect(response.status, JSON.stringify(payload)).toBe(400);
    }
    expect(seen.value).toBeUndefined();
  });
});

describe('handleSeoRedirectRemove', () => {
  it('is a POST here and a DELETE upstream, carrying no body', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleSeoRedirectRemove(
      writeRequest('/api/seo/redirects/remove', 'POST', { redirectId: ENTRY }),
      { env: ENV, fetch: apiReturns(200, { ok: true }, seen) },
    );
    expect(response.status).toBe(200);
    expect(seen.value?.method).toBe('DELETE');
    expect(seen.value?.url).toBe(`https://api.internal.test/v1/admin/seo/redirects/${ENTRY}`);
    expect(seen.value?.body).toBeNull();
  });

  it('refuses a removal that names no entry', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleSeoRedirectRemove(
      writeRequest('/api/seo/redirects/remove', 'POST', {}),
      { env: ENV, fetch: apiReturns(200, { ok: true }, seen) },
    );
    expect(response.status).toBe(400);
    expect(seen.value).toBeUndefined();
  });

  it('is an absence when the entry is gone, and an outage when the API is', async () => {
    const absent = await handleSeoRedirectRemove(
      writeRequest('/api/seo/redirects/remove', 'POST', { redirectId: ENTRY }),
      { env: ENV, fetch: apiReturns(404, { status: 404, code: 'NOT_FOUND' }) },
    );
    expect(absent.status).toBe(404);

    const down = await handleSeoRedirectRemove(
      writeRequest('/api/seo/redirects/remove', 'POST', { redirectId: ENTRY }),
      { env: ENV, fetch: apiUnreachable() },
    );
    expect(down.status).toBe(503);
  });

  it('caches nothing it answers', async () => {
    const response = await handleSeoRedirectRemove(
      writeRequest('/api/seo/redirects/remove', 'POST', { redirectId: ENTRY }),
      { env: ENV, fetch: apiReturns(200, { ok: true }) },
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
