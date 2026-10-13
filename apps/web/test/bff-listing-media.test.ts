import { describe, expect, it } from 'vitest';
import {
  handleListingMediaAttach,
  handleListingMediaList,
  handleListingMediaPrimary,
  handleListingMediaUpload,
  handleListingMediaWithdraw,
  readListingMedia,
} from '../src/server/bff/listing-media';
import { SESSION_COOKIES } from '../src/server/bff/session-cookies';

/**
 * The five listing-photograph routes at the BFF boundary (increment 0116).
 *
 * The properties this boundary owes the browser:
 *
 *   * the Origin check runs **first**, before the session cookie is read, and it runs on the read too — these
 *     responses include a draft's unpublished photographs;
 *   * the session leaves as one header on one internal hop, and the browser's `Cookie` is never forwarded;
 *   * the strict contracts are applied here as well, and the **validated** value is forwarded, so an
 *     `objectPath` or a `bucket` sent to the authorization has no route through this handler at all;
 *   * the slug and the photograph identifier are checked here, so a malformed one never reaches a path;
 *   * success is one exact status per operation — 201 for the authorization, 200 for the other four;
 *   * the four signed upload URLs reach the browser exactly as the API issued them, and appear in no refusal;
 *   * an undeclared upstream status becomes a 503 rather than being passed through.
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
const SLUG = 'a-flat-in-maadi';
const LISTING = '22222222-2222-4222-8222-222222222222';
const MEDIA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SIGNED = 'https://provider.invalid/storage/v1/object/upload/sign/listing-variants/x?token=signed-token';

function variantsOf(mediaId: string) {
  return [
    { key: 'thumb', url: `https://cdn.invalid/${mediaId}/thumb.webp`, width: 320, height: 240 },
    { key: 'card', url: `https://cdn.invalid/${mediaId}/card.webp`, width: 800, height: 600 },
    { key: 'full', url: `https://cdn.invalid/${mediaId}/full.webp`, width: 1600, height: 1200 },
  ];
}

const ITEM = {
  id: MEDIA,
  position: 0,
  isPrimary: true,
  status: 'ready',
  isPublished: true,
  variants: variantsOf(MEDIA),
};

const UPLOADS_BODY = {
  variants: [
    { variantKey: 'original', contentType: 'image/jpeg', byteSize: 4_000_000 },
    { variantKey: 'thumb', contentType: 'image/webp', byteSize: 20_000 },
    { variantKey: 'card', contentType: 'image/webp', byteSize: 90_000 },
    { variantKey: 'full', contentType: 'image/webp', byteSize: 300_000 },
  ],
};

function pathFor(key: string): string {
  const bucket = key === 'original' ? 'listing-originals' : 'listing-variants';
  return `${bucket}/${LISTING}/${key}/33333333-3333-4333-8333-333333333333.webp`;
}

const TARGETS = UPLOADS_BODY.variants.map((variant) => ({
  variantKey: variant.variantKey,
  uploadUrl: SIGNED,
  objectPath: pathFor(variant.variantKey),
  expiresAt: '2026-10-10T22:00:00.000Z',
  maxByteSize: variant.variantKey === 'original' ? 26_214_400 : 10_485_760,
}));

const ATTACH_BODY = {
  variants: UPLOADS_BODY.variants.map((variant, index) => ({
    variantKey: variant.variantKey,
    objectPath: pathFor(variant.variantKey),
    width: [4000, 320, 800, 1600][index]!,
    height: [3000, 240, 600, 1200][index]!,
    byteSize: variant.byteSize,
  })),
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

function request(
  path: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  payload?: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(`https://web.test${path}`, {
    method,
    headers: {
      origin: 'https://web.test',
      cookie: COOKIE,
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(payload === undefined
      ? {}
      : { body: typeof payload === 'string' ? payload : JSON.stringify(payload) }),
  });
}

const problem = (status: number, code: string) =>
  JSON.stringify({ type: 'about:blank', title: 'Refused', status, detail: 'No.', code, instance: '/x' });

/* ------------------------------------------------------------------------------------------------ */

describe('the photographs read', () => {
  it('answers 200 with the items and makes exactly one credentialled hop', async () => {
    const seen: Seen[] = [];
    const response = await handleListingMediaList(request(`/api/listings/${SLUG}/media`, 'GET'), SLUG, {
      env: ENV,
      fetch: upstream(200, { items: [ITEM] }, seen),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ items: [ITEM] });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(`https://api.internal.test/v1/listings/${SLUG}/media`);
    expect(seen[0]?.method).toBe('GET');
    expect(seen[0]?.headers.get('x-session-token')).toBe(ACCESS_TOKEN);
    expect(seen[0]?.headers.get('x-internal-credential')).toBe(ENV.INTERNAL_BFF_CREDENTIAL);
    // The browser's own cookie never goes upstream.
    expect(seen[0]?.headers.get('cookie')).toBeNull();
  });

  it('refuses a cross-origin write and asks nothing upstream, while a read passes the same check', async () => {
    // `checkSameOrigin` is the project's CSRF rule: it holds the state-changing methods and passes a read,
    // because a cross-site page can cause a read but cannot see its answer — no response here carries a
    // CORS header. So the assertion is about the four writes, and about the read *not* being refused.
    const writes: Seen[] = [];
    const foreign = { origin: 'https://evil.test' };
    const refusals = await Promise.all([
      handleListingMediaUpload(
        request(`/api/listings/${SLUG}/media/uploads`, 'POST', UPLOADS_BODY, foreign),
        SLUG,
        { env: ENV, fetch: upstream(201, { targets: TARGETS }, writes) },
      ),
      handleListingMediaAttach(request(`/api/listings/${SLUG}/media`, 'POST', ATTACH_BODY, foreign), SLUG, {
        env: ENV,
        fetch: upstream(200, { attachedId: MEDIA, items: [ITEM] }, writes),
      }),
      handleListingMediaPrimary(
        request(`/api/listings/${SLUG}/media/${MEDIA}/primary`, 'PUT', undefined, foreign),
        SLUG,
        MEDIA,
        { env: ENV, fetch: upstream(200, { items: [ITEM] }, writes) },
      ),
      handleListingMediaWithdraw(
        request(`/api/listings/${SLUG}/media/${MEDIA}`, 'DELETE', undefined, foreign),
        SLUG,
        MEDIA,
        { env: ENV, fetch: upstream(200, { items: [] }, writes) },
      ),
    ]);
    for (const response of refusals) expect(response.status).toBe(403);
    expect(writes).toEqual([]);

    const reads: Seen[] = [];
    const read = await handleListingMediaList(
      request(`/api/listings/${SLUG}/media`, 'GET', undefined, foreign),
      SLUG,
      { env: ENV, fetch: upstream(200, { items: [ITEM] }, reads) },
    );
    expect(read.status).toBe(200);
    expect(reads).toHaveLength(1);
  });

  it('answers 401 without a session, and asks nothing upstream', async () => {
    const seen: Seen[] = [];
    const response = await handleListingMediaList(
      new Request(`https://web.test/api/listings/${SLUG}/media`, {
        method: 'GET',
        headers: { origin: 'https://web.test' },
      }),
      SLUG,
      { env: ENV, fetch: upstream(200, { items: [] }, seen) },
    );
    expect(response.status).toBe(401);
    expect(seen).toEqual([]);
  });

  it('answers 404 for a slug that is not a slug, and asks nothing upstream', async () => {
    const seen: Seen[] = [];
    for (const bad of ['-leading', 'trailing-', 'Upper', 'a', 'has space', '../etc']) {
      const response = await handleListingMediaList(request(`/api/listings/x/media`, 'GET'), bad, {
        env: ENV,
        fetch: upstream(200, { items: [] }, seen),
      });
      expect(response.status, bad).toBe(404);
    }
    expect(seen).toEqual([]);
  });

  it('forwards a declared refusal and turns an undeclared status into a 503', async () => {
    for (const status of [401, 403, 404]) {
      const response = await handleListingMediaList(request(`/api/listings/${SLUG}/media`, 'GET'), SLUG, {
        env: ENV,
        fetch: upstream(status, problem(status, 'NOT_FOUND'), []),
      });
      expect(response.status).toBe(status);
    }
    for (const status of [201, 302, 418, 500, 502]) {
      const response = await handleListingMediaList(request(`/api/listings/${SLUG}/media`, 'GET'), SLUG, {
        env: ENV,
        fetch: upstream(status, problem(status, 'HTTP_ERROR'), []),
      });
      expect(response.status, String(status)).toBe(503);
    }
  });

  it('turns a body the contract does not accept into a 503 rather than passing it on', async () => {
    const response = await handleListingMediaList(request(`/api/listings/${SLUG}/media`, 'GET'), SLUG, {
      env: ENV,
      fetch: upstream(200, { items: [{ ...ITEM, surprise: 'extra' }] }, []),
    });
    expect(response.status).toBe(503);
  });
});

describe('the authorization', () => {
  it('answers 201 and passes the four signed URLs through untouched', async () => {
    const seen: Seen[] = [];
    const response = await handleListingMediaUpload(
      request(`/api/listings/${SLUG}/media/uploads`, 'POST', UPLOADS_BODY),
      SLUG,
      { env: ENV, fetch: upstream(201, { targets: TARGETS }, seen) },
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ targets: TARGETS });
    expect(seen[0]?.url).toBe(`https://api.internal.test/v1/listings/${SLUG}/media/uploads`);
    // The validated request, which is the one the strict contract accepted.
    expect(JSON.parse(seen[0]?.body ?? 'null')).toEqual(UPLOADS_BODY);
  });

  it('gives a request that names a destination no route through this handler at all', async () => {
    const seen: Seen[] = [];
    for (const extra of [
      { objectPath: 'listing-variants/elsewhere/x.webp' },
      { bucket: 'listing-originals' },
      { fileName: 'holiday.jpg' },
      { listingId: LISTING },
    ]) {
      const response = await handleListingMediaUpload(
        request(`/api/listings/${SLUG}/media/uploads`, 'POST', { ...UPLOADS_BODY, ...extra }),
        SLUG,
        { env: ENV, fetch: upstream(201, { targets: TARGETS }, seen) },
      );
      expect(response.status, JSON.stringify(extra)).toBe(400);
    }
    expect(seen).toEqual([]);
  });

  it('refuses anything that is not exactly the four keys, before the hop', async () => {
    const seen: Seen[] = [];
    for (const body of [
      { variants: UPLOADS_BODY.variants.slice(0, 3) },
      { variants: [...UPLOADS_BODY.variants, UPLOADS_BODY.variants[0]] },
      { variants: [...UPLOADS_BODY.variants.slice(0, 3), UPLOADS_BODY.variants[2]] },
      { variants: [] },
      {},
      'not json at all',
    ]) {
      const response = await handleListingMediaUpload(
        request(`/api/listings/${SLUG}/media/uploads`, 'POST', body),
        SLUG,
        { env: ENV, fetch: upstream(201, { targets: TARGETS }, seen) },
      );
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(seen).toEqual([]);
  });

  it('puts no signed URL in a refusal', async () => {
    const response = await handleListingMediaUpload(
      request(`/api/listings/${SLUG}/media/uploads`, 'POST', UPLOADS_BODY),
      SLUG,
      { env: ENV, fetch: upstream(503, problem(503, 'SERVICE_UNAVAILABLE'), []) },
    );
    expect(response.status).toBe(503);
    const raw = await response.text();
    expect(raw).not.toContain('token=');
    expect(raw).not.toContain(ACCESS_TOKEN);
    expect(raw).not.toContain(ENV.INTERNAL_BFF_CREDENTIAL);
  });
});

describe('the confirmation, the primary and the withdrawal', () => {
  it('confirms with the validated body and answers 200 with the list as it now stands', async () => {
    const seen: Seen[] = [];
    const response = await handleListingMediaAttach(
      request(`/api/listings/${SLUG}/media`, 'POST', ATTACH_BODY),
      SLUG,
      { env: ENV, fetch: upstream(200, { attachedId: MEDIA, items: [ITEM] }, seen) },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ attachedId: MEDIA, items: [ITEM] });
    expect(seen[0]?.method).toBe('POST');
    expect(JSON.parse(seen[0]?.body ?? 'null')).toEqual(ATTACH_BODY);
  });

  it('forwards the object-missing conflict rather than calling it an outage', async () => {
    const response = await handleListingMediaAttach(
      request(`/api/listings/${SLUG}/media`, 'POST', ATTACH_BODY),
      SLUG,
      { env: ENV, fetch: upstream(409, problem(409, 'LISTING_MEDIA_OBJECT_MISSING'), []) },
    );
    expect(response.status).toBe(409);
    expect(await response.text()).toContain('LISTING_MEDIA_OBJECT_MISSING');
  });

  it('makes one primary with a PUT and no body', async () => {
    const seen: Seen[] = [];
    const response = await handleListingMediaPrimary(
      request(`/api/listings/${SLUG}/media/${MEDIA}/primary`, 'PUT'),
      SLUG,
      MEDIA,
      { env: ENV, fetch: upstream(200, { items: [ITEM] }, seen) },
    );
    expect(response.status).toBe(200);
    expect(seen[0]?.url).toBe(`https://api.internal.test/v1/listings/${SLUG}/media/${MEDIA}/primary`);
    expect(seen[0]?.method).toBe('PUT');
    expect(seen[0]?.body).toBeUndefined();
    expect(seen[0]?.headers.get('content-type')).toBeNull();
  });

  it('withdraws one with a DELETE', async () => {
    const seen: Seen[] = [];
    const response = await handleListingMediaWithdraw(
      request(`/api/listings/${SLUG}/media/${MEDIA}`, 'DELETE'),
      SLUG,
      MEDIA,
      { env: ENV, fetch: upstream(200, { items: [] }, seen) },
    );
    expect(response.status).toBe(200);
    expect(seen[0]?.url).toBe(`https://api.internal.test/v1/listings/${SLUG}/media/${MEDIA}`);
    expect(seen[0]?.method).toBe('DELETE');
  });

  it('answers 404 for a photograph identifier that is not a uuid, and asks nothing upstream', async () => {
    const seen: Seen[] = [];
    for (const bad of ['not-a-uuid', '../../etc', MEDIA.toUpperCase(), `${MEDIA}/primary`, '']) {
      const withdraw = await handleListingMediaWithdraw(
        request(`/api/listings/${SLUG}/media/x`, 'DELETE'),
        SLUG,
        bad,
        { env: ENV, fetch: upstream(200, { items: [] }, seen) },
      );
      const primary = await handleListingMediaPrimary(
        request(`/api/listings/${SLUG}/media/x/primary`, 'PUT'),
        SLUG,
        bad,
        { env: ENV, fetch: upstream(200, { items: [] }, seen) },
      );
      expect(withdraw.status, bad).toBe(404);
      expect(primary.status, bad).toBe(404);
    }
    expect(seen).toEqual([]);
  });
});

describe('the server-side read', () => {
  it('keeps its three refusals apart, because they are three different sentences on a screen', async () => {
    expect(
      await readListingMedia(SLUG, { env: ENV, cookieHeader: COOKIE, fetch: upstream(200, { items: [ITEM] }, []) }),
    ).toEqual({ kind: 'ok', items: [ITEM] });

    // No cookie is no session, and nothing is asked upstream.
    const seen: Seen[] = [];
    expect(await readListingMedia(SLUG, { env: ENV, cookieHeader: null, fetch: upstream(200, {}, seen) })).toEqual({
      kind: 'unauthenticated',
    });
    expect(seen).toEqual([]);

    expect(
      await readListingMedia(SLUG, { env: ENV, cookieHeader: COOKIE, fetch: upstream(404, problem(404, 'NOT_FOUND'), []) }),
    ).toEqual({ kind: 'not_found' });

    expect(
      await readListingMedia(SLUG, { env: ENV, cookieHeader: COOKIE, fetch: upstream(503, problem(503, 'X'), []) }),
    ).toEqual({ kind: 'unavailable' });

    // A malformed slug is "not there", not "we could not ask": there is no listing behind it.
    expect(await readListingMedia('-bad-', { env: ENV, cookieHeader: COOKIE, fetch: upstream(200, {}, []) })).toEqual({
      kind: 'not_found',
    });
  });

  it('calls a body it cannot validate unavailable, rather than reporting no photographs', async () => {
    // "No photographs" and "we could not read them" are different screens, and the second must not be
    // rendered as the first.
    expect(
      await readListingMedia(SLUG, {
        env: ENV,
        cookieHeader: COOKIE,
        fetch: upstream(200, { items: [{ id: MEDIA }] }, []),
      }),
    ).toEqual({ kind: 'unavailable' });
  });
});
