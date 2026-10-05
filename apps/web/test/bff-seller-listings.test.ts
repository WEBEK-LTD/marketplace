import { describe, expect, it } from 'vitest';
import {
  handleSellerListingArchive,
  handleSellerListingCreate,
  handleSellerListingSubmit,
  handleSellerListingUpdate,
  handleSellerListings,
  readSellerListings,
} from '../src/server/bff/seller-listings';
import { SESSION_COOKIES } from '../src/server/bff/session-cookies';

/**
 * The five seller listing routes at the BFF boundary (Phase 6-F).
 *
 * The properties this boundary owes the browser:
 *
 *   * the Origin check runs **first** on every write, before the session cookie is read;
 *   * the session leaves as one header on one internal hop, and the browser's `Cookie` is never forwarded;
 *   * the strict contracts are applied here too, and the **validated** value is forwarded, so a `status`,
 *     `sellerUserId` or `listingId` a client invented has no route through this layer at all;
 *   * success is one exact status per operation, compared rather than assumed from the 2xx range;
 *   * the slug in the path is checked for shape, percent-encoded, and authorizes nothing — a well-formed
 *     slug belonging to somebody else is refused by the database, which is the only layer that can tell;
 *   * submission and archival send no body upstream, so there is nothing a request could steer them with;
 *   * a refusal the operation declares is forwarded with the API's own problem body; anything else is a 503.
 *
 * No browser, no live API: the upstream is a function.
 */

const ENV = Object.freeze({
  API_BASE_URL: 'https://api.internal.test',
  PUBLIC_WEB_ORIGIN: 'https://web.test',
  INTERNAL_BFF_CREDENTIAL: 'test-current-credential-value-not-a-real-se',
});

const ACCESS_TOKEN = 'browser-access-token-value-not-a-real-token';
const REFRESH_TOKEN = 'browser-refresh-token-value-not-a-real-toke';
const COOKIE = `${SESSION_COOKIES.access.name}=${ACCESS_TOKEN}; ${SESSION_COOKIES.refresh.name}=${REFRESH_TOKEN}`;

const LISTING = {
  slug: 'a-chair',
  title: 'A Chair',
  description: 'A very fine chair indeed.',
  listingTypeCode: 'product',
  categorySlug: 'widgets',
  status: 'draft',
  currencyCode: 'EGP',
  priceMinor: 9900,
  isNegotiable: false,
  contentLanguage: 'en',
  countryCode: 'EG',
  governorate: null,
  city: 'Cairo',
  mediaCount: 2,
  createdAt: '2026-05-01T10:00:00.000Z',
  updatedAt: '2026-05-02T10:00:00.000Z',
  submittedAt: null,
  archivedAt: null,
};

const PAGE = { listings: [LISTING], nextCursor: null };
const WRITTEN = { listing: { slug: 'a-chair', status: 'draft' } };

const VALID_CREATE = {
  slug: 'a-chair',
  title: 'A Chair',
  description: 'A very fine chair indeed.',
  listingTypeCode: 'product',
  categorySlug: 'widgets',
  contentLanguage: 'en',
  currencyCode: 'EGP',
  countryCode: 'EG',
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

function write(path: string, payload: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://web.test${path}`, {
    method: 'POST',
    headers: {
      origin: 'https://web.test',
      cookie: COOKIE,
      'content-type': 'application/json',
      ...headers,
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
}

function read(path = '/api/sellers/me/listings', headers: Record<string, string> = {}): Request {
  return new Request(`https://web.test${path}`, {
    method: 'GET',
    headers: { origin: 'https://web.test', cookie: COOKIE, ...headers },
  });
}

describe('reading the caller’s own listings', () => {
  it('makes one credentialled internal hop carrying the session, and forwards no cookie', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerListings(read(), {
      env: ENV,
      fetch: upstream(200, PAGE, seen),
    });

    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url.startsWith(`${ENV.API_BASE_URL}/v1/sellers/me/listings?`)).toBe(true);
    expect(seen[0]?.headers.get('x-session-token')).toBe(ACCESS_TOKEN);
    expect(seen[0]?.headers.get('cookie')).toBeNull();
    expect(await response.text()).not.toContain(REFRESH_TOKEN);
  });

  it('rebuilds the page from the validated fields, so a drifted field cannot travel', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerListings(read(), {
      env: ENV,
      fetch: upstream(200, { listings: [{ ...LISTING, sellerUserId: 'leak' }], nextCursor: null }, seen),
    });

    // The strict contract refuses the extra field, so the whole body is refused rather than trimmed.
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('leak');
  });

  it('clamps the page size rather than forwarding what a browser asked for', async () => {
    const seen: Seen[] = [];
    await handleSellerListings(read('/api/sellers/me/listings?limit=9999'), {
      env: ENV,
      fetch: upstream(200, PAGE, seen),
    });
    expect(new URL(seen[0]!.url).searchParams.get('limit')).toBe('50');

    const second: Seen[] = [];
    await handleSellerListings(read('/api/sellers/me/listings?limit=abc'), {
      env: ENV,
      fetch: upstream(200, PAGE, second),
    });
    expect(new URL(second[0]!.url).searchParams.get('limit')).toBe('20');
  });

  it('forwards a cursor without interpreting it', async () => {
    const seen: Seen[] = [];
    await handleSellerListings(read('/api/sellers/me/listings?cursor=abc123'), {
      env: ENV,
      fetch: upstream(200, PAGE, seen),
    });
    expect(new URL(seen[0]!.url).searchParams.get('cursor')).toBe('abc123');
  });

  it('answers 401 with no session, and asks the API nothing', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerListings(
      new Request('https://web.test/api/sellers/me/listings', { method: 'GET' }),
      { env: ENV, fetch: upstream(200, PAGE, seen) },
    );

    expect(response.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('forwards a declared refusal with the API’s own body, and makes anything else a 503', async () => {
    const forwarded = await handleSellerListings(read(), {
      env: ENV,
      fetch: upstream(404, { code: 'NOT_FOUND', detail: 'The requested resource was not found.' }, []),
    });
    expect(forwarded.status).toBe(404);
    expect(await forwarded.json()).toMatchObject({ code: 'NOT_FOUND' });

    const generic = await handleSellerListings(read(), {
      env: ENV,
      fetch: upstream(418, { code: 'TEAPOT' }, []),
    });
    expect(generic.status).toBe(503);
    expect(await generic.text()).not.toContain('TEAPOT');
  });

  it('caches nothing for the next visitor of a shared machine', async () => {
    const response = await handleSellerListings(read(), { env: ENV, fetch: upstream(200, PAGE, []) });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('the page-side reader', () => {
  it('reports four outcomes, and never confuses a failure with an empty shop', async () => {
    const ok = await readSellerListings({ cookieHeader: COOKIE, env: ENV, fetch: upstream(200, PAGE, []) });
    expect(ok.kind).toBe('ok');

    const none = await readSellerListings({
      cookieHeader: COOKIE,
      env: ENV,
      fetch: upstream(404, { code: 'NOT_FOUND' }, []),
    });
    expect(none.kind).toBe('not_a_seller');

    const expired = await readSellerListings({
      cookieHeader: COOKIE,
      env: ENV,
      fetch: upstream(401, { code: 'AUTHENTICATION_REQUIRED' }, []),
    });
    expect(expired.kind).toBe('unauthenticated');

    const broken = await readSellerListings({
      cookieHeader: COOKIE,
      env: ENV,
      fetch: upstream(503, { code: 'SERVICE_UNAVAILABLE' }, []),
    });
    // Emphatically not `not_a_seller`: a failing service must never read as "you have no listings".
    expect(broken.kind).toBe('unavailable');
  });

  it('asks nothing upstream without an access cookie', async () => {
    const seen: Seen[] = [];
    const result = await readSellerListings({ cookieHeader: null, env: ENV, fetch: upstream(200, PAGE, seen) });
    expect(result.kind).toBe('unauthenticated');
    expect(seen).toHaveLength(0);
  });
});

describe('creating a draft', () => {
  it('checks the Origin before it reads a cookie, and refuses a cross-site post', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerListingCreate(
      write('/api/sellers/me/listings', VALID_CREATE, { origin: 'https://evil.test' }),
      { env: ENV, fetch: upstream(201, WRITTEN, seen) },
    );

    expect(response.status).toBe(403);
    expect(seen).toHaveLength(0);
    expect(await response.text()).not.toContain(ACCESS_TOKEN);
  });

  it('forwards the validated body, so an invented field has no route through', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerListingCreate(
      write('/api/sellers/me/listings', { ...VALID_CREATE, status: 'active', sellerUserId: 'someone' }),
      { env: ENV, fetch: upstream(201, WRITTEN, seen) },
    );

    // Refused rather than trimmed: a quietly dropped status looks like success to whoever sent it.
    expect(response.status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it('answers 201 exactly, and 503 for a success status the contract does not declare', async () => {
    const created = await handleSellerListingCreate(write('/api/sellers/me/listings', VALID_CREATE), {
      env: ENV,
      fetch: upstream(201, WRITTEN, []),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual(WRITTEN);

    const drifted = await handleSellerListingCreate(write('/api/sellers/me/listings', VALID_CREATE), {
      env: ENV,
      fetch: upstream(200, WRITTEN, []),
    });
    expect(drifted.status).toBe(503);
  });

  it.each([400, 401, 403, 404, 409, 429])('forwards the declared refusal %i with its own body', async (status) => {
    const response = await handleSellerListingCreate(write('/api/sellers/me/listings', VALID_CREATE), {
      env: ENV,
      fetch: upstream(status, { code: 'SELLER_LISTING_SLUG_TAKEN', detail: 'unavailable' }, []),
    });
    expect(response.status).toBe(status);
    expect(response.headers.get('content-type')).toBe('application/problem+json');
  });

  it('refuses a body that is not JSON without asking the API', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerListingCreate(
      new Request('https://web.test/api/sellers/me/listings', {
        method: 'POST',
        headers: { origin: 'https://web.test', cookie: COOKIE, 'content-type': 'application/json' },
        body: '{not json',
      }),
      { env: ENV, fetch: upstream(201, WRITTEN, seen) },
    );

    expect(response.status).toBe(400);
    expect(seen).toHaveLength(0);
  });
});

describe('editing a draft', () => {
  it('sends the slug percent-encoded and keeps absent and null apart', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerListingUpdate(
      write('/api/sellers/me/listings/a-chair', { title: 'Renamed Chair', priceMinor: null }),
      'a-chair',
      { env: ENV, fetch: upstream(200, WRITTEN, seen) },
    );

    expect(response.status).toBe(200);
    expect(seen[0]?.method).toBe('PATCH');
    expect(seen[0]?.url).toBe(`${ENV.API_BASE_URL}/v1/sellers/me/listings/a-chair`);
    const sent = JSON.parse(seen[0]!.body!) as Record<string, unknown>;
    // A key sent as null survives; a key that was absent stays absent.
    expect(Object.hasOwn(sent, 'priceMinor')).toBe(true);
    expect(sent['priceMinor']).toBeNull();
    expect(Object.hasOwn(sent, 'city')).toBe(false);
    expect(Object.hasOwn(sent, 'description')).toBe(false);
  });

  it.each(['../../../etc/passwd', 'A-Chair', 'a', 'a chair', 'a-chair?x=1', ''])(
    'refuses the malformed slug %j without asking the API',
    async (slug) => {
      const seen: Seen[] = [];
      const response = await handleSellerListingUpdate(
        write('/api/sellers/me/listings/x', { title: 'Renamed Chair' }),
        slug,
        { env: ENV, fetch: upstream(200, WRITTEN, seen) },
      );

      // Not-found, identically to a listing that does not exist: the shape check reveals nothing.
      expect(response.status).toBe(404);
      expect(seen).toHaveLength(0);
    },
  );

  it('passes a well-formed slug that is not the caller’s straight to the API, which decides', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerListingUpdate(
      write('/api/sellers/me/listings/someone-elses-listing', { title: 'Renamed Chair' }),
      'someone-elses-listing',
      { env: ENV, fetch: upstream(404, { code: 'NOT_FOUND' }, seen) },
    );

    // This layer does not, and could not, decide ownership: it asks, and forwards the refusal.
    expect(seen).toHaveLength(1);
    expect(response.status).toBe(404);
  });

  it('checks the Origin before it reads a cookie', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerListingUpdate(
      write('/api/sellers/me/listings/a-chair', { title: 'X' }, { origin: 'https://evil.test' }),
      'a-chair',
      { env: ENV, fetch: upstream(200, WRITTEN, seen) },
    );
    expect(response.status).toBe(403);
    expect(seen).toHaveLength(0);
  });
});

describe('submitting and archiving', () => {
  it.each([
    ['submission', handleSellerListingSubmit],
    ['archive', handleSellerListingArchive],
  ])('sends no body at all to %s', async (segment, handler) => {
    const seen: Seen[] = [];
    const response = await handler(
      write(`/api/sellers/me/listings/a-chair/${segment}`, { status: 'approved' }),
      'a-chair',
      { env: ENV, fetch: upstream(200, WRITTEN, seen) },
    );

    expect(response.status).toBe(200);
    expect(seen[0]?.url).toBe(`${ENV.API_BASE_URL}/v1/sellers/me/listings/a-chair/${segment}`);
    expect(seen[0]?.method).toBe('POST');
    // Nothing a browser sent was read, so nothing it sent could steer the operation.
    expect(seen[0]?.body).toBeUndefined();
    expect(seen[0]?.headers.get('content-type')).toBeNull();
  });

  it.each([
    ['submission', handleSellerListingSubmit],
    ['archive', handleSellerListingArchive],
  ])('checks the Origin on %s before reading a cookie', async (segment, handler) => {
    const seen: Seen[] = [];
    const response = await handler(
      write(`/api/sellers/me/listings/a-chair/${segment}`, undefined, { origin: 'https://evil.test' }),
      'a-chair',
      { env: ENV, fetch: upstream(200, WRITTEN, seen) },
    );
    expect(response.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it.each([
    ['submission', handleSellerListingSubmit],
    ['archive', handleSellerListingArchive],
  ])('forwards the API’s 409 on %s with its own code', async (segment, handler) => {
    const response = await handler(
      write(`/api/sellers/me/listings/a-chair/${segment}`, undefined),
      'a-chair',
      {
        env: ENV,
        fetch: upstream(409, { code: 'SELLER_LISTING_NOT_EDITABLE', detail: 'not in this state' }, []),
      },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'SELLER_LISTING_NOT_EDITABLE' });
  });

  it('answers 401 without a session on every write, and asks the API nothing', async () => {
    const seen: Seen[] = [];
    const bare = (path: string) =>
      new Request(`https://web.test${path}`, {
        method: 'POST',
        headers: { origin: 'https://web.test' },
      });

    expect(
      (await handleSellerListingSubmit(bare('/api/sellers/me/listings/a-chair/submission'), 'a-chair', {
        env: ENV,
        fetch: upstream(200, WRITTEN, seen),
      })).status,
    ).toBe(401);
    expect(
      (await handleSellerListingArchive(bare('/api/sellers/me/listings/a-chair/archive'), 'a-chair', {
        env: ENV,
        fetch: upstream(200, WRITTEN, seen),
      })).status,
    ).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('never returns a token or the internal credential, whatever happened', async () => {
    const responses = [
      await handleSellerListings(read(), { env: ENV, fetch: upstream(200, PAGE, []) }),
      await handleSellerListingCreate(write('/api/sellers/me/listings', VALID_CREATE), {
        env: ENV,
        fetch: upstream(201, WRITTEN, []),
      }),
      await handleSellerListingSubmit(
        write('/api/sellers/me/listings/a-chair/submission', undefined),
        'a-chair',
        { env: ENV, fetch: upstream(409, { code: 'SELLER_LISTING_INCOMPLETE' }, []) },
      ),
    ];
    for (const response of responses) {
      const text = await response.text();
      expect(text).not.toContain(ACCESS_TOKEN);
      expect(text).not.toContain(REFRESH_TOKEN);
      expect(text).not.toContain(ENV.INTERNAL_BFF_CREDENTIAL);
    }
  });
});
