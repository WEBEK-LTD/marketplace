import { describe, expect, it } from 'vitest';
import { handleSellerMediaAttach, handleSellerMediaUpload } from '../src/server/bff/sellers';
import { SESSION_COOKIES } from '../src/server/bff/session-cookies';

/**
 * The two seller media routes at the BFF boundary (Phase 6-E).
 *
 * The properties this boundary owes the browser, and the two specific to media:
 *
 *   * the Origin check runs **first**, before the session cookie is read;
 *   * the session leaves as one header on one internal hop, and the browser's `Cookie` is never forwarded;
 *   * the strict contracts are applied here too, and the **validated** value is forwarded, so an `objectPath`,
 *     `bucket` or `slug` sent to the authorization has no route through this handler at all;
 *   * success is one exact status per operation — 201 for the authorization, 200 for the confirmation;
 *   * the signed upload URL reaches the browser exactly as the API issued it, and appears in no refusal;
 *   * the confirmation's response carries booleans and no paths.
 *
 * No browser, no live API, no provider: the upstream is a function.
 */

const ENV = Object.freeze({
  API_BASE_URL: 'https://api.internal.test',
  PUBLIC_WEB_ORIGIN: 'https://web.test',
  INTERNAL_BFF_CREDENTIAL: 'test-current-credential-value-not-a-real-se',
});

const ACCESS_TOKEN = 'browser-access-token-value-not-a-real-token';
const REFRESH_TOKEN = 'browser-refresh-token-value-not-a-real-toke';
const COOKIE = `${SESSION_COOKIES.access.name}=${ACCESS_TOKEN}; ${SESSION_COOKIES.refresh.name}=${REFRESH_TOKEN}`;
const USER_ID = '11111111-1111-4111-8111-111111111111';
const OBJECT_PATH = 'seller-media/good-shop/logo/11111111-1111-1111-1111-111111111111.webp';
const SIGNED_URL = 'https://provider.invalid/storage/v1/object/upload/sign/seller-media/x?token=signed-token';

const UPLOAD = {
  mediaKind: 'logo',
  uploadUrl: SIGNED_URL,
  objectPath: OBJECT_PATH,
  expiresAt: '2026-09-25T22:00:00.000Z',
  maxByteSize: 5_242_880,
};

interface Seen {
  readonly url: string;
  readonly method: string | undefined;
  readonly headers: Headers;
  readonly body: string | undefined;
}

function upstream(
  status: number,
  payload: unknown,
  seen: Seen[],
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    seen.push({
      url: String(input),
      method: init?.method,
      headers: new Headers(init?.headers as HeadersInit),
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return new Response(text, {
      status,
      headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
    });
  };
}

function request(path: string, payload: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://web.test${path}`, {
    method: 'POST',
    headers: {
      origin: 'https://web.test',
      cookie: COOKIE,
      'content-type': 'application/json',
      ...headers,
    },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}

const authorizeRequest = (payload: unknown = { mediaKind: 'logo', contentType: 'image/webp', byteSize: 1024 }, headers = {}) =>
  request('/api/sellers/me/media/uploads', payload, headers);
const confirmRequest = (payload: unknown = { mediaKind: 'logo', objectPath: OBJECT_PATH }, headers = {}) =>
  request('/api/sellers/me/media', payload, headers);

const problem = (status: number, code: string) => ({
  type: 'about:blank',
  title: 'Refused',
  status,
  detail: 'A sentence the API owns.',
  instance: '/v1/sellers/me/media',
  code,
});

describe('the Origin check, and its order', () => {
  it('refuses an authorization from another origin without calling the API', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerMediaUpload(
      authorizeRequest(undefined, { origin: 'https://evil.test' }),
      { env: ENV, fetch: upstream(201, { upload: UPLOAD }, seen) },
    );

    expect(response.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it('refuses a confirmation from another origin without calling the API', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerMediaAttach(
      confirmRequest(undefined, { origin: 'https://evil.test' }),
      { env: ENV, fetch: upstream(200, { media: { hasLogo: true, hasBanner: false } }, seen) },
    );

    expect(response.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it('refuses a cross-origin request with no session as a 403, not a 401', async () => {
    const seen: Seen[] = [];
    const noCookie = new Request('https://web.test/api/sellers/me/media/uploads', {
      method: 'POST',
      headers: { origin: 'https://evil.test', 'content-type': 'application/json' },
      body: JSON.stringify({ mediaKind: 'logo', contentType: 'image/webp', byteSize: 1 }),
    });
    const response = await handleSellerMediaUpload(noCookie, {
      env: ENV,
      fetch: upstream(201, { upload: UPLOAD }, seen),
    });

    expect(response.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it('accepts a request with no Origin when the browser says the fetch is same-origin', async () => {
    const seen: Seen[] = [];
    const metadata = new Request('https://web.test/api/sellers/me/media/uploads', {
      method: 'POST',
      headers: { cookie: COOKIE, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ mediaKind: 'logo', contentType: 'image/webp', byteSize: 1024 }),
    });
    const response = await handleSellerMediaUpload(metadata, {
      env: ENV,
      fetch: upstream(201, { upload: UPLOAD }, seen),
    });

    expect(response.status).toBe(201);
    expect(seen).toHaveLength(1);
  });
});

describe('the session', () => {
  it.each([
    ['/api/sellers/me/media/uploads', handleSellerMediaUpload],
    ['/api/sellers/me/media', handleSellerMediaAttach],
  ])('refuses %s with no access cookie, without calling the API', async (path, handler) => {
    const seen: Seen[] = [];
    const noCookie = new Request(`https://web.test${path}`, {
      method: 'POST',
      headers: { origin: 'https://web.test', 'content-type': 'application/json' },
      body: JSON.stringify({ mediaKind: 'logo', contentType: 'image/webp', byteSize: 1 }),
    });
    const response = await handler(noCookie, { env: ENV, fetch: upstream(201, {}, seen) });

    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe('AUTHENTICATION_REQUIRED');
    expect(seen).toHaveLength(0);
  });

  it('refuses a request carrying only the refresh cookie', async () => {
    const seen: Seen[] = [];
    const refreshOnly = new Request('https://web.test/api/sellers/me/media/uploads', {
      method: 'POST',
      headers: {
        origin: 'https://web.test',
        cookie: `${SESSION_COOKIES.refresh.name}=${REFRESH_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ mediaKind: 'logo', contentType: 'image/webp', byteSize: 1 }),
    });
    const response = await handleSellerMediaUpload(refreshOnly, { env: ENV, fetch: upstream(201, {}, seen) });

    expect(response.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('presents the token with the credential, and forwards no cookie, on both routes', async () => {
    const seen: Seen[] = [];
    await handleSellerMediaUpload(authorizeRequest(), {
      env: ENV,
      fetch: upstream(201, { upload: UPLOAD }, seen),
    });
    await handleSellerMediaAttach(confirmRequest(), {
      env: ENV,
      fetch: upstream(200, { media: { hasLogo: true, hasBanner: false } }, seen),
    });

    expect(seen).toHaveLength(2);
    for (const call of seen) {
      expect(call.headers.get('x-session-token')).toBe(ACCESS_TOKEN);
      expect(call.headers.get('x-internal-credential')).toBe(ENV.INTERNAL_BFF_CREDENTIAL);
      expect(call.headers.get('cookie')).toBeNull();
      expect(call.body ?? '').not.toContain(ACCESS_TOKEN);
    }
  });

  it('posts to the two fixed upstream addresses', async () => {
    const seen: Seen[] = [];
    await handleSellerMediaUpload(authorizeRequest(), {
      env: ENV,
      fetch: upstream(201, { upload: UPLOAD }, seen),
    });
    await handleSellerMediaAttach(confirmRequest(), {
      env: ENV,
      fetch: upstream(200, { media: { hasLogo: true, hasBanner: false } }, seen),
    });

    expect(seen[0]?.url).toBe('https://api.internal.test/v1/sellers/me/media/uploads');
    expect(seen[1]?.url).toBe('https://api.internal.test/v1/sellers/me/media');
    expect(seen.every((call) => call.method === 'POST')).toBe(true);
  });

  it('cannot be pointed at another upstream by a header', async () => {
    const seen: Seen[] = [];
    await handleSellerMediaUpload(
      authorizeRequest(undefined, { 'x-api-base-url': 'https://evil.test' }),
      { env: ENV, fetch: upstream(201, { upload: UPLOAD }, seen) },
    );

    expect(seen[0]?.url).toBe('https://api.internal.test/v1/sellers/me/media/uploads');
  });
});

describe('the strict request contracts', () => {
  it.each([
    ['objectPath', OBJECT_PATH],
    ['bucket', 'seller-media'],
    ['slug', 'good-shop'],
    ['fileName', 'logo.webp'],
    ['userId', USER_ID],
    ['status', 'active'],
  ])('refuses an authorization carrying %s, before the API is called', async (field, value) => {
    const seen: Seen[] = [];
    const response = await handleSellerMediaUpload(
      authorizeRequest({ mediaKind: 'logo', contentType: 'image/webp', byteSize: 1024, [field]: value }),
      { env: ENV, fetch: upstream(201, { upload: UPLOAD }, seen) },
    );

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('VALIDATION_FAILED');
    expect(seen).toHaveLength(0);
  });

  it('forwards only the three values that describe the file', async () => {
    const seen: Seen[] = [];
    await handleSellerMediaUpload(
      authorizeRequest({ mediaKind: 'banner', contentType: 'image/png', byteSize: 2048 }),
      { env: ENV, fetch: upstream(201, { upload: UPLOAD }, seen) },
    );

    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({
      mediaKind: 'banner',
      contentType: 'image/png',
      byteSize: 2048,
    });
  });

  it('refuses a disallowed type or an oversize file without a round trip', async () => {
    const seen: Seen[] = [];
    const options = { env: ENV, fetch: upstream(201, { upload: UPLOAD }, seen) };

    for (const body of [
      { mediaKind: 'logo', contentType: 'image/svg+xml', byteSize: 1024 },
      { mediaKind: 'logo', contentType: 'application/pdf', byteSize: 1024 },
      { mediaKind: 'logo', contentType: 'image/webp', byteSize: 5_242_881 },
      { mediaKind: 'logo', contentType: 'image/webp', byteSize: 0 },
      { mediaKind: 'avatar', contentType: 'image/webp', byteSize: 1024 },
    ]) {
      expect((await handleSellerMediaUpload(authorizeRequest(body), options)).status, JSON.stringify(body)).toBe(
        400,
      );
    }
    expect(seen).toHaveLength(0);
  });

  it('refuses an unparsable or empty body on both routes', async () => {
    const seen: Seen[] = [];
    const options = { env: ENV, fetch: upstream(201, { upload: UPLOAD }, seen) };

    expect((await handleSellerMediaUpload(authorizeRequest('{not json'), options)).status).toBe(400);
    expect((await handleSellerMediaUpload(authorizeRequest(''), options)).status).toBe(400);
    expect((await handleSellerMediaAttach(confirmRequest('{not json'), options)).status).toBe(400);
    expect((await handleSellerMediaAttach(confirmRequest(''), options)).status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it('forwards a confirmation as the kind and the path, and nothing else', async () => {
    const seen: Seen[] = [];
    await handleSellerMediaAttach(confirmRequest({ mediaKind: 'logo', objectPath: OBJECT_PATH }), {
      env: ENV,
      fetch: upstream(200, { media: { hasLogo: true, hasBanner: false } }, seen),
    });

    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({ mediaKind: 'logo', objectPath: OBJECT_PATH });
  });
});

describe('the responses', () => {
  it('answers 201 with the upload target, rebuilt from the validated contract', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerMediaUpload(authorizeRequest(), {
      env: ENV,
      fetch: upstream(201, { upload: UPLOAD }, seen),
    });

    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ upload: UPLOAD });
  });

  it('answers 200 with the media state, and no paths', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerMediaAttach(confirmRequest(), {
      env: ENV,
      fetch: upstream(200, { media: { hasLogo: true, hasBanner: false } }, seen),
    });
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ media: { hasLogo: true, hasBanner: false } });
    expect(text).not.toContain('seller-media/');
  });

  it('refuses a 200 where the authorization contract says 201, and the reverse', async () => {
    const seen: Seen[] = [];
    expect(
      (
        await handleSellerMediaUpload(authorizeRequest(), {
          env: ENV,
          fetch: upstream(200, { upload: UPLOAD }, seen),
        })
      ).status,
    ).toBe(503);
    expect(
      (
        await handleSellerMediaAttach(confirmRequest(), {
          env: ENV,
          fetch: upstream(201, { media: { hasLogo: true, hasBanner: false } }, seen),
        })
      ).status,
    ).toBe(503);
  });

  it('turns a drifted body into a clean failure rather than rendering it', async () => {
    const seen: Seen[] = [];
    for (const drifted of [
      { upload: { ...UPLOAD, userId: USER_ID } },
      { upload: { ...UPLOAD, uploadUrl: 'not-a-url' } },
      { upload: { mediaKind: 'logo' } },
      { uploads: [UPLOAD] },
      'not json at all',
    ]) {
      const response = await handleSellerMediaUpload(authorizeRequest(), {
        env: ENV,
        fetch: upstream(201, drifted, seen),
      });
      expect(response.status, JSON.stringify(drifted)).toBe(503);
    }
    for (const drifted of [
      { media: { hasLogo: true } },
      { media: { hasLogo: 'yes', hasBanner: false } },
      { media: { hasLogo: true, hasBanner: false, logoPath: OBJECT_PATH } },
    ]) {
      const response = await handleSellerMediaAttach(confirmRequest(), {
        env: ENV,
        fetch: upstream(200, drifted, seen),
      });
      expect(response.status, JSON.stringify(drifted)).toBe(503);
    }
  });

  it.each([
    [400, 'VALIDATION_FAILED'],
    [401, 'AUTHENTICATION_REQUIRED'],
    [403, 'BAD_REQUEST'],
    [404, 'NOT_FOUND'],
    [404, 'SELLER_MEDIA_OBJECT_MISSING'],
    [409, 'SELLER_PROFILE_NOT_EDITABLE'],
    [429, 'THROTTLED'],
  ])('passes an upstream %i through with the API own code %s', async (status, code) => {
    const seen: Seen[] = [];
    const response = await handleSellerMediaAttach(confirmRequest(), {
      env: ENV,
      fetch: upstream(status, problem(status, code), seen),
    });

    expect(response.status).toBe(status);
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    expect((await response.json()).code).toBe(code);
  });

  it.each([418, 500, 502, 503])('turns an undeclared upstream %i into a 503', async (status) => {
    const seen: Seen[] = [];
    const response = await handleSellerMediaUpload(authorizeRequest(), {
      env: ENV,
      fetch: upstream(status, problem(status, 'INTERNAL_ERROR'), seen),
    });

    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe('SERVICE_UNAVAILABLE');
  });

  it('answers 503 when the API cannot be reached at all', async () => {
    const failing = async () => {
      throw new Error('connection refused');
    };
    expect((await handleSellerMediaUpload(authorizeRequest(), { env: ENV, fetch: failing })).status).toBe(503);
    expect((await handleSellerMediaAttach(confirmRequest(), { env: ENV, fetch: failing })).status).toBe(503);
  });
});

describe('the signed URL', () => {
  it('reaches the browser exactly as the API issued it', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerMediaUpload(authorizeRequest(), {
      env: ENV,
      fetch: upstream(201, { upload: UPLOAD }, seen),
    });
    const body = (await response.json()) as { upload: { uploadUrl: string } };

    expect(body.upload.uploadUrl).toBe(SIGNED_URL);
  });

  it('is not cached', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerMediaUpload(authorizeRequest(), {
      env: ENV,
      fetch: upstream(201, { upload: UPLOAD }, seen),
    });

    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('appears in no refusal', async () => {
    const seen: Seen[] = [];
    for (const [status, payload] of [
      [409, problem(409, 'SELLER_PROFILE_NOT_EDITABLE')],
      [400, problem(400, 'VALIDATION_FAILED')],
      [500, problem(500, 'INTERNAL_ERROR')],
    ] as const) {
      const response = await handleSellerMediaUpload(authorizeRequest(), {
        env: ENV,
        fetch: upstream(status, payload, seen),
      });
      const text = await response.text();
      expect(text).not.toContain('signed-token');
      expect(text).not.toContain(SIGNED_URL);
    }
  });

  it('and no response carries a token, a credential or the upstream address', async () => {
    const seen: Seen[] = [];
    for (const [status, payload] of [
      [201, { upload: UPLOAD }],
      [409, problem(409, 'SELLER_PROFILE_NOT_EDITABLE')],
    ] as const) {
      const response = await handleSellerMediaUpload(authorizeRequest(), {
        env: ENV,
        fetch: upstream(status, payload, seen),
      });
      const text = await response.text();
      expect(text).not.toContain(ACCESS_TOKEN);
      expect(text).not.toContain(REFRESH_TOKEN);
      expect(text).not.toContain(ENV.INTERNAL_BFF_CREDENTIAL);
      expect(text).not.toContain('api.internal.test');
      expect(text).not.toContain(USER_ID);
    }
  });
});
