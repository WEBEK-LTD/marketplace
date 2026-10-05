import { describe, expect, it } from 'vitest';
import {
  handleCmsMediaAltText,
  handleCmsMediaConfirm,
  handleCmsMediaPreview,
  handleCmsMediaRemove,
  handleCmsMediaUploadAuthorize,
  handleCmsMediaUsage,
  readCmsMediaList,
} from '../src/server/bff/cms-media';

/**
 * The CMS media library BFF, on the admin origin (0098).
 *
 * What matters at this boundary:
 *
 *   * the caller's token comes from `__Host-mp_admin_access` and never from a body, and the browser's own `Cookie`
 *     header is never forwarded upstream;
 *   * **the body is rebuilt, never forwarded.** An `objectPath` in an upload authorization has nowhere to go, because
 *     the path is the server's to compose and that request has no such field;
 *   * **a confirmation's path is checked against the exact shape the authorizer issues** before it leaves this
 *     origin — an early no, with the API and the database both checking again;
 *   * responses are validated before a byte reaches a browser, so a field the contract does not name cannot reach a
 *     screen even if the API sent one;
 *   * the refusals a screen must act on are forwarded with the API's own problem body, and anything else becomes one
 *     503 — including an upstream success whose body is not the contract's;
 *   * every write is same-origin, and a cross-origin submission is refused before its body is read;
 *   * **a signed URL is passed through and never stored**, and nothing on this origin proxies an object.
 *
 * Everything is stubbed at the `fetch` boundary: no API, no provider, no network.
 */

const ENV = {
  API_BASE_URL: 'https://api.internal.test',
  INTERNAL_BFF_CREDENTIAL: 'test-cms-media-canary-credential-abcdefghij',
} as const;

const SESSION_TOKEN = 'canary-admin-access-token-not-a-real-token';
const COOKIE = `__Host-mp_admin_access=${SESSION_TOKEN}; __Host-mp_admin_refresh=canary-refresh-not-real`;
const ORIGIN = 'https://admin.test';

const MEDIA = 'ce000000-0000-4000-8000-0000000000a1';
const OBJECT_PATH = 'cms-media/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png';

const ENTRY = {
  id: MEDIA,
  objectPath: OBJECT_PATH,
  contentType: 'image/png',
  width: 800,
  height: 600,
  byteSize: 4096,
  altTextEn: 'A photo',
  altTextAr: null,
  usageCount: 1,
  createdAt: '2026-05-02T09:00:00.000Z',
  updatedAt: '2026-05-02T09:00:00.000Z',
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

function readRequest(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, { method: 'GET', headers: { cookie: COOKIE, ...headers } });
}

const CONFIRM = { objectPath: OBJECT_PATH, contentType: 'image/png', byteSize: 4096 } as const;

/* ------------------------------------------------------------------------------------------------ */
/* Reading the library                                                                              */
/* ------------------------------------------------------------------------------------------------ */

describe('readCmsMediaList', () => {
  it('presents the session token upstream and never the browser cookie', async () => {
    const seen: { value?: Seen } = {};
    await readCmsMediaList({}, {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReturns(200, { items: [ENTRY], nextCursor: null, canManage: true }, seen),
    });
    expect(seen.value?.sessionToken).toBe(SESSION_TOKEN);
    expect(seen.value?.cookie).toBeNull();
    expect(seen.value?.url).toBe('https://api.internal.test/v1/admin/cms/media');
  });

  it('is unauthenticated with no session cookie, without calling upstream', async () => {
    const seen: { value?: Seen } = {};
    const result = await readCmsMediaList({}, { env: ENV, cookieHeader: null, fetch: apiReturns(200, {}, seen) });
    expect(result.kind).toBe('unauthenticated');
    expect(seen.value).toBeUndefined();
  });

  it('forwards only a sane limit and a well-formed cursor', async () => {
    const seen: { value?: Seen } = {};
    const fetcher = apiReturns(200, { items: [], nextCursor: null, canManage: true }, seen);
    await readCmsMediaList({ limit: 'ten', cursor: 'not a cursor!' }, { env: ENV, cookieHeader: COOKIE, fetch: fetcher });
    expect(seen.value?.url).toBe('https://api.internal.test/v1/admin/cms/media');

    await readCmsMediaList({ limit: '12', cursor: 'Y20xfDIwMjY' }, { env: ENV, cookieHeader: COOKIE, fetch: fetcher });
    expect(seen.value?.url).toContain('limit=12');
    expect(seen.value?.url).toContain('cursor=Y20xfDIwMjY');
  });

  it('returns the entries a screen renders', async () => {
    const result = await readCmsMediaList({}, {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReturns(200, { items: [ENTRY], nextCursor: null, canManage: true }),
    });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.data.items[0]?.objectPath).toBe(OBJECT_PATH);
    expect(result.data.items[0]?.usageCount).toBe(1);
  });

  it('refuses a body the contract does not describe rather than passing it on', async () => {
    const result = await readCmsMediaList({}, {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReturns(200, { items: [{ ...ENTRY, surprise: 'x' }], nextCursor: null, canManage: true }),
    });
    expect(result.kind).toBe('unavailable');
  });

  it('maps an absence, a session failure and an outage each to their own kind', async () => {
    for (const [status, kind] of [
      [404, 'notFound'],
      [401, 'unauthenticated'],
      [500, 'unavailable'],
    ] as const) {
      const result = await readCmsMediaList({}, {
        env: ENV,
        cookieHeader: COOKIE,
        fetch: apiReturns(status, { code: 'X' }),
      });
      expect(result.kind, String(status)).toBe(kind);
    }
    expect((await readCmsMediaList({}, { env: ENV, cookieHeader: COOKIE, fetch: apiUnreachable() })).kind).toBe(
      'unavailable',
    );
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* The two reads a browser performs                                                                  */
/* ------------------------------------------------------------------------------------------------ */

describe('handleCmsMediaPreview', () => {
  it('passes the signed URL through untouched', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleCmsMediaPreview(readRequest(`/api/cms/media/${MEDIA}/preview`), MEDIA, {
      env: ENV,
      fetch: apiReturns(
        200,
        { id: MEDIA, url: 'https://storage.test/read/opaque', expiresAt: '2026-05-02T09:05:00.000Z' },
        seen,
      ),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).url).toBe('https://storage.test/read/opaque');
    expect(seen.value?.url).toBe(`https://api.internal.test/v1/admin/cms/media/${MEDIA}/preview`);
    // Never cached: it is a credential for a few minutes.
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('refuses an identifier that is not one, without calling upstream', async () => {
    const seen: { value?: Seen } = {};
    for (const id of ['not-a-uuid', '../other', '']) {
      const response = await handleCmsMediaPreview(readRequest('/api/cms/media/x/preview'), id, {
        env: ENV,
        fetch: apiReturns(200, {}, seen),
      });
      expect(response.status, id).toBe(404);
    }
    expect(seen.value).toBeUndefined();
  });

  it('refuses an upstream body that is not a preview', async () => {
    const response = await handleCmsMediaPreview(readRequest(`/api/cms/media/${MEDIA}/preview`), MEDIA, {
      env: ENV,
      fetch: apiReturns(200, { id: MEDIA, url: 'not-a-url', expiresAt: 'soon' }),
    });
    expect(response.status).toBe(503);
  });

  it('is a 401 with no session and a 503 when the API is unreachable', async () => {
    const noCookie = new Request(`${ORIGIN}/api/cms/media/${MEDIA}/preview`, { method: 'GET' });
    expect((await handleCmsMediaPreview(noCookie, MEDIA, { env: ENV, fetch: apiReturns(200, {}) })).status).toBe(401);
    expect(
      (await handleCmsMediaPreview(readRequest(`/api/cms/media/${MEDIA}/preview`), MEDIA, {
        env: ENV,
        fetch: apiUnreachable(),
      })).status,
    ).toBe(503);
  });
});

describe('handleCmsMediaUsage', () => {
  it('returns every reference a screen shows before offering a delete', async () => {
    const response = await handleCmsMediaUsage(readRequest(`/api/cms/media/${MEDIA}/usage`), MEDIA, {
      env: ENV,
      fetch: apiReturns(200, {
        id: MEDIA,
        references: [
          { entityType: 'page', entityId: 'ce100000-0000-4000-8000-000000000001', label: 'about', column: 'cover_media_id' },
          { entityType: 'seo_settings', entityId: null, label: 'en', column: 'default_share_media_id' },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { references: unknown[] };
    expect(body.references).toHaveLength(2);
  });

  it('refuses a body whose reference kind the contract does not name', async () => {
    const response = await handleCmsMediaUsage(readRequest(`/api/cms/media/${MEDIA}/usage`), MEDIA, {
      env: ENV,
      fetch: apiReturns(200, {
        id: MEDIA,
        references: [{ entityType: 'listing', entityId: null, label: 'x', column: 'media_id' }],
      }),
    });
    expect(response.status).toBe(503);
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* Authorizing and confirming                                                                        */
/* ------------------------------------------------------------------------------------------------ */

describe('handleCmsMediaUploadAuthorize', () => {
  it('forwards only the type and the size', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleCmsMediaUploadAuthorize(
      writeRequest('/api/cms/media/uploads', 'POST', { contentType: 'image/png', byteSize: 4096 }),
      {
        env: ENV,
        fetch: apiReturns(
          201,
          {
            upload: {
              uploadUrl: 'https://storage.test/upload/opaque',
              objectPath: OBJECT_PATH,
              expiresAt: '2026-05-02T09:05:00.000Z',
              maxByteSize: 10_485_760,
            },
          },
          seen,
        ),
      },
    );
    expect(response.status).toBe(201);
    expect(seen.value?.method).toBe('POST');
    expect(JSON.parse(seen.value?.body ?? '{}')).toEqual({ contentType: 'image/png', byteSize: 4096 });
  });

  it('drops an objectPath a browser invents, because the path is the server’s', async () => {
    const seen: { value?: Seen } = {};
    await handleCmsMediaUploadAuthorize(
      writeRequest('/api/cms/media/uploads', 'POST', {
        contentType: 'image/png',
        byteSize: 4096,
        objectPath: 'cms-media/mine.png',
      }),
      {
        env: ENV,
        fetch: apiReturns(
          201,
          {
            upload: {
              uploadUrl: 'https://storage.test/upload/opaque',
              objectPath: OBJECT_PATH,
              expiresAt: '2026-05-02T09:05:00.000Z',
              maxByteSize: 10_485_760,
            },
          },
          seen,
        ),
      },
    );
    expect(JSON.parse(seen.value?.body ?? '{}')).not.toHaveProperty('objectPath');
  });

  it('refuses a type the bucket does not allow and a size outside it, without calling upstream', async () => {
    const seen: { value?: Seen } = {};
    for (const body of [
      { contentType: 'image/svg+xml', byteSize: 10 },
      { contentType: 'text/html', byteSize: 10 },
      { contentType: 'image/png', byteSize: 0 },
      { contentType: 'image/png', byteSize: 10_485_761 },
      { byteSize: 10 },
    ]) {
      const response = await handleCmsMediaUploadAuthorize(
        writeRequest('/api/cms/media/uploads', 'POST', body),
        { env: ENV, fetch: apiReturns(201, {}, seen) },
      );
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(seen.value).toBeUndefined();
  });

  it('refuses a cross-origin submission before reading its body, and needs a session', async () => {
    const seen: { value?: Seen } = {};
    expect(
      (
        await handleCmsMediaUploadAuthorize(
          writeRequest('/api/cms/media/uploads', 'POST', { contentType: 'image/png', byteSize: 10 }, {
            origin: 'https://evil.test',
          }),
          { env: ENV, fetch: apiReturns(201, {}, seen) },
        )
      ).status,
    ).toBe(403);

    const noCookie = new Request(`${ORIGIN}/api/cms/media/uploads`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ contentType: 'image/png', byteSize: 10 }),
    });
    expect((await handleCmsMediaUploadAuthorize(noCookie, { env: ENV, fetch: apiReturns(201, {}, seen) })).status).toBe(
      401,
    );
    expect(seen.value).toBeUndefined();
  });

  it('forwards the API’s own refusal and turns anything else into one 503', async () => {
    const refused = await handleCmsMediaUploadAuthorize(
      writeRequest('/api/cms/media/uploads', 'POST', { contentType: 'image/png', byteSize: 10 }),
      { env: ENV, fetch: apiReturns(409, { code: 'CMS_MEDIA_NOT_ALLOWED', status: 409 }) },
    );
    expect(refused.status).toBe(409);
    expect((await refused.json()).code).toBe('CMS_MEDIA_NOT_ALLOWED');

    for (const status of [418, 500, 502]) {
      const response = await handleCmsMediaUploadAuthorize(
        writeRequest('/api/cms/media/uploads', 'POST', { contentType: 'image/png', byteSize: 10 }),
        { env: ENV, fetch: apiReturns(status, { code: 'X' }) },
      );
      expect(response.status, String(status)).toBe(503);
    }
  });
});

describe('handleCmsMediaConfirm', () => {
  it('forwards the path and what was stored at it', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleCmsMediaConfirm(
      writeRequest('/api/cms/media', 'POST', { ...CONFIRM, width: 800, height: 600, altTextEn: 'A photo' }),
      { env: ENV, fetch: apiReturns(201, { id: MEDIA }, seen) },
    );
    expect(response.status).toBe(201);
    const body = JSON.parse(seen.value?.body ?? '{}');
    expect(body.objectPath).toBe(OBJECT_PATH);
    expect(body.width).toBe(800);
    expect(body.altTextEn).toBe('A photo');
  });

  it('keeps an absent optional field absent', async () => {
    const seen: { value?: Seen } = {};
    await handleCmsMediaConfirm(writeRequest('/api/cms/media', 'POST', CONFIRM), {
      env: ENV,
      fetch: apiReturns(201, { id: MEDIA }, seen),
    });
    expect(Object.keys(JSON.parse(seen.value?.body ?? '{}')).sort()).toEqual([
      'byteSize',
      'contentType',
      'objectPath',
    ]);
  });

  it('refuses a path that is not the shape the authorizer issues, without calling upstream', async () => {
    const seen: { value?: Seen } = {};
    for (const objectPath of [
      'cms-media/../secret.png',
      'cms-media/a/b.png',
      'seller-media/x.png',
      'listing-variants/x.png',
      'cms-media/photo.png',
      'cms-media/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.svg',
      'x/cms-media/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png',
      '',
    ]) {
      const response = await handleCmsMediaConfirm(
        writeRequest('/api/cms/media', 'POST', { ...CONFIRM, objectPath }),
        { env: ENV, fetch: apiReturns(201, { id: MEDIA }, seen) },
      );
      expect(response.status, objectPath).toBe(400);
    }
    expect(seen.value).toBeUndefined();
  });

  it('drops a field the contract does not name', async () => {
    const seen: { value?: Seen } = {};
    await handleCmsMediaConfirm(
      writeRequest('/api/cms/media', 'POST', { ...CONFIRM, uploadedBy: 'somebody', usageCount: 9 }),
      { env: ENV, fetch: apiReturns(201, { id: MEDIA }, seen) },
    );
    const body = JSON.parse(seen.value?.body ?? '{}');
    expect(body).not.toHaveProperty('uploadedBy');
    expect(body).not.toHaveProperty('usageCount');
  });

  it('forwards the object-missing and path-taken refusals with the API’s own body', async () => {
    for (const code of ['CMS_MEDIA_OBJECT_MISSING', 'CMS_MEDIA_PATH_TAKEN']) {
      const response = await handleCmsMediaConfirm(writeRequest('/api/cms/media', 'POST', CONFIRM), {
        env: ENV,
        fetch: apiReturns(409, { code, status: 409 }),
      });
      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe(code);
    }
  });

  it('refuses an upstream success whose body is not the contract’s', async () => {
    const response = await handleCmsMediaConfirm(writeRequest('/api/cms/media', 'POST', CONFIRM), {
      env: ENV,
      fetch: apiReturns(201, { id: 'not-a-uuid' }),
    });
    expect(response.status).toBe(503);
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* Alt text and removal                                                                              */
/* ------------------------------------------------------------------------------------------------ */

describe('handleCmsMediaAltText', () => {
  it('sends the identifier in the address and the two fields in the body', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleCmsMediaAltText(
      writeRequest('/api/cms/media/alt-text', 'PUT', { mediaId: MEDIA, altTextEn: 'A photo', altTextAr: null }),
      { env: ENV, fetch: apiReturns(200, { ok: true }, seen) },
    );
    expect(response.status).toBe(200);
    expect(seen.value?.method).toBe('PUT');
    expect(seen.value?.url).toBe(`https://api.internal.test/v1/admin/cms/media/${MEDIA}/alt-text`);
    const body = JSON.parse(seen.value?.body ?? '{}');
    expect(body.altTextEn).toBe('A photo');
    expect(body.altTextAr).toBeNull();
    expect(body).not.toHaveProperty('mediaId');
  });

  it('refuses an identifier that is not one and a value past the bound', async () => {
    const seen: { value?: Seen } = {};
    expect(
      (
        await handleCmsMediaAltText(
          writeRequest('/api/cms/media/alt-text', 'PUT', { mediaId: 'nope', altTextEn: 'x' }),
          { env: ENV, fetch: apiReturns(200, { ok: true }, seen) },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handleCmsMediaAltText(
          writeRequest('/api/cms/media/alt-text', 'PUT', { mediaId: MEDIA, altTextEn: 'a'.repeat(301) }),
          { env: ENV, fetch: apiReturns(200, { ok: true }, seen) },
        )
      ).status,
    ).toBe(400);
    expect(seen.value).toBeUndefined();
  });
});

describe('handleCmsMediaRemove', () => {
  it('sends a DELETE to the entry’s address with no body', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleCmsMediaRemove(
      writeRequest('/api/cms/media/remove', 'POST', { mediaId: MEDIA }),
      { env: ENV, fetch: apiReturns(200, { ok: true }, seen) },
    );
    expect(response.status).toBe(200);
    expect(seen.value?.method).toBe('DELETE');
    expect(seen.value?.url).toBe(`https://api.internal.test/v1/admin/cms/media/${MEDIA}`);
    expect(seen.value?.body).toBeNull();
  });

  it('refuses a missing or malformed identifier, and a cross-origin submission', async () => {
    const seen: { value?: Seen } = {};
    for (const body of [{}, { mediaId: 'nope' }, { mediaId: '../other' }]) {
      const response = await handleCmsMediaRemove(writeRequest('/api/cms/media/remove', 'POST', body), {
        env: ENV,
        fetch: apiReturns(200, { ok: true }, seen),
      });
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(
      (
        await handleCmsMediaRemove(
          writeRequest('/api/cms/media/remove', 'POST', { mediaId: MEDIA }, { origin: 'https://evil.test' }),
          { env: ENV, fetch: apiReturns(200, { ok: true }, seen) },
        )
      ).status,
    ).toBe(403);
    expect(seen.value).toBeUndefined();
  });

  it('forwards an absence and is a 503 when the API is unreachable', async () => {
    expect(
      (
        await handleCmsMediaRemove(writeRequest('/api/cms/media/remove', 'POST', { mediaId: MEDIA }), {
          env: ENV,
          fetch: apiReturns(404, { code: 'NOT_FOUND', status: 404 }),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await handleCmsMediaRemove(writeRequest('/api/cms/media/remove', 'POST', { mediaId: MEDIA }), {
          env: ENV,
          fetch: apiUnreachable(),
        })
      ).status,
    ).toBe(503);
  });
});
