import { describe, expect, it } from 'vitest';
import {
  handleSellerServiceCreate,
  handleSellerServiceUpdate,
  handleSellerServices,
  readSellerServices,
} from '../src/server/bff/seller-services';
import { SESSION_COOKIES } from '../src/server/bff/session-cookies';

/**
 * The three seller service routes at the BFF boundary (Phase 6-G).
 *
 * The properties this boundary owes the browser:
 *
 *   * the Origin check runs **first** on every write, before the session cookie is read;
 *   * the session leaves as one header on one internal hop, and the browser's `Cookie` is never forwarded;
 *   * the strict contracts are applied here too, and the **validated** value is forwarded, so a
 *     `listingTypeCode`, `status` or `sellerUserId` a client invented has no route through this layer;
 *   * success is one exact status per operation, compared rather than assumed from the 2xx range;
 *   * absent, null and a value survive the round trip as three different things — four, counting the pricing
 *     model's withdrawal;
 *   * the slug is checked for shape, percent-encoded, and authorizes nothing: a well-formed slug belonging to
 *     another seller, or to one of the caller's own products, is refused by the database;
 *   * there are only three handlers, because a service is submitted and archived through the listing routes.
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

const SERVICE = {
  slug: 'logo-design',
  title: 'Logo Design',
  description: 'I will design a logo for you.',
  categorySlug: 'design',
  status: 'draft',
  currencyCode: 'EGP',
  currencyMinorUnit: 2,
  priceMinor: '9900',
  isNegotiable: false,
  contentLanguage: 'en',
  countryCode: 'EG',
  governorate: null,
  city: 'Cairo',
  pricingModel: 'fixed',
  deliveryDays: 5,
  revisionsIncluded: 2,
  requiresBrief: true,
  scope: 'Two concepts.',
  mediaCount: 0,
  createdAt: '2026-05-01T10:00:00.000Z',
  updatedAt: '2026-05-02T10:00:00.000Z',
  submittedAt: null,
  archivedAt: null,
};

const PAGE = { services: [SERVICE], nextCursor: null };
const WRITTEN = { listing: { slug: 'logo-design', status: 'draft' } };

const VALID_CREATE = {
  slug: 'logo-design',
  title: 'Logo Design',
  description: 'I will design a logo for you.',
  categorySlug: 'design',
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

function read(path = '/api/sellers/me/services', headers: Record<string, string> = {}): Request {
  return new Request(`https://web.test${path}`, {
    method: 'GET',
    headers: { origin: 'https://web.test', cookie: COOKIE, ...headers },
  });
}

describe('reading the caller’s own services', () => {
  it('makes one credentialled internal hop carrying the session, and forwards no cookie', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerServices(read(), { env: ENV, fetch: upstream(200, PAGE, seen) });

    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url.startsWith(`${ENV.API_BASE_URL}/v1/sellers/me/services?`)).toBe(true);
    expect(seen[0]?.headers.get('x-session-token')).toBe(ACCESS_TOKEN);
    expect(seen[0]?.headers.get('cookie')).toBeNull();
    expect(await response.text()).not.toContain(REFRESH_TOKEN);
  });

  it('rebuilds the page from the validated fields, so a drifted field cannot travel', async () => {
    const response = await handleSellerServices(read(), {
      env: ENV,
      fetch: upstream(200, { services: [{ ...SERVICE, sellerUserId: 'leak' }], nextCursor: null }, []),
    });

    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('leak');
  });

  it('clamps the page size rather than forwarding what a browser asked for', async () => {
    const seen: Seen[] = [];
    await handleSellerServices(read('/api/sellers/me/services?limit=9999'), {
      env: ENV,
      fetch: upstream(200, PAGE, seen),
    });
    expect(new URL(seen[0]!.url).searchParams.get('limit')).toBe('50');

    const second: Seen[] = [];
    await handleSellerServices(read('/api/sellers/me/services?limit=abc'), {
      env: ENV,
      fetch: upstream(200, PAGE, second),
    });
    expect(new URL(second[0]!.url).searchParams.get('limit')).toBe('20');
  });

  it('forwards a cursor without interpreting it', async () => {
    const seen: Seen[] = [];
    await handleSellerServices(read('/api/sellers/me/services?cursor=abc123'), {
      env: ENV,
      fetch: upstream(200, PAGE, seen),
    });
    expect(new URL(seen[0]!.url).searchParams.get('cursor')).toBe('abc123');
  });

  it('answers 401 with no session, and asks the API nothing', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerServices(
      new Request('https://web.test/api/sellers/me/services', { method: 'GET' }),
      { env: ENV, fetch: upstream(200, PAGE, seen) },
    );

    expect(response.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('forwards a declared refusal with the API’s own body, and makes anything else a 503', async () => {
    const forwarded = await handleSellerServices(read(), {
      env: ENV,
      fetch: upstream(404, { code: 'NOT_FOUND', detail: 'The requested resource was not found.' }, []),
    });
    expect(forwarded.status).toBe(404);
    expect(await forwarded.json()).toMatchObject({ code: 'NOT_FOUND' });

    const generic = await handleSellerServices(read(), {
      env: ENV,
      fetch: upstream(418, { code: 'TEAPOT' }, []),
    });
    expect(generic.status).toBe(503);
    expect(await generic.text()).not.toContain('TEAPOT');
  });

  it('caches nothing for the next visitor of a shared machine', async () => {
    const response = await handleSellerServices(read(), { env: ENV, fetch: upstream(200, PAGE, []) });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('the page-side reader', () => {
  it('reports four outcomes, and never confuses a failure with an empty shop', async () => {
    const ok = await readSellerServices({ cookieHeader: COOKIE, env: ENV, fetch: upstream(200, PAGE, []) });
    expect(ok.kind).toBe('ok');

    const none = await readSellerServices({
      cookieHeader: COOKIE,
      env: ENV,
      fetch: upstream(404, { code: 'NOT_FOUND' }, []),
    });
    expect(none.kind).toBe('not_a_seller');

    const expired = await readSellerServices({
      cookieHeader: COOKIE,
      env: ENV,
      fetch: upstream(401, { code: 'AUTHENTICATION_REQUIRED' }, []),
    });
    expect(expired.kind).toBe('unauthenticated');

    const broken = await readSellerServices({
      cookieHeader: COOKIE,
      env: ENV,
      fetch: upstream(503, { code: 'SERVICE_UNAVAILABLE' }, []),
    });
    expect(broken.kind).toBe('unavailable');
  });

  it('asks nothing upstream without an access cookie', async () => {
    const seen: Seen[] = [];
    const result = await readSellerServices({
      cookieHeader: null,
      env: ENV,
      fetch: upstream(200, PAGE, seen),
    });
    expect(result.kind).toBe('unauthenticated');
    expect(seen).toHaveLength(0);
  });
});

describe('creating a service draft', () => {
  it('checks the Origin before it reads a cookie, and refuses a cross-site post', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerServiceCreate(
      write('/api/sellers/me/services', VALID_CREATE, { origin: 'https://evil.test' }),
      { env: ENV, fetch: upstream(201, WRITTEN, seen) },
    );

    expect(response.status).toBe(403);
    expect(seen).toHaveLength(0);
    expect(await response.text()).not.toContain(ACCESS_TOKEN);
  });

  it('forwards the validated body, so an invented field has no route through', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerServiceCreate(
      write('/api/sellers/me/services', {
        ...VALID_CREATE,
        listingTypeCode: 'product',
        status: 'active',
      }),
      { env: ENV, fetch: upstream(201, WRITTEN, seen) },
    );

    expect(response.status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it('answers 201 exactly, and 503 for a success status the contract does not declare', async () => {
    const created = await handleSellerServiceCreate(write('/api/sellers/me/services', VALID_CREATE), {
      env: ENV,
      fetch: upstream(201, WRITTEN, []),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual(WRITTEN);

    const drifted = await handleSellerServiceCreate(write('/api/sellers/me/services', VALID_CREATE), {
      env: ENV,
      fetch: upstream(200, WRITTEN, []),
    });
    expect(drifted.status).toBe(503);
  });

  it('forwards the five detail fields when they are stated', async () => {
    const seen: Seen[] = [];
    await handleSellerServiceCreate(
      write('/api/sellers/me/services', {
        ...VALID_CREATE,
        pricingModel: 'fixed',
        deliveryDays: 7,
        revisionsIncluded: 3,
        requiresBrief: true,
        scope: 'Two concepts.',
      }),
      { env: ENV, fetch: upstream(201, WRITTEN, seen) },
    );

    const sent = JSON.parse(seen[0]!.body!) as Record<string, unknown>;
    expect(sent['pricingModel']).toBe('fixed');
    expect(sent['deliveryDays']).toBe(7);
    expect(sent['revisionsIncluded']).toBe(3);
    expect(sent['requiresBrief']).toBe(true);
    expect(sent['scope']).toBe('Two concepts.');
  });

  it.each([400, 401, 403, 404, 409, 429])('forwards the declared refusal %i with its own body', async (status) => {
    const response = await handleSellerServiceCreate(write('/api/sellers/me/services', VALID_CREATE), {
      env: ENV,
      fetch: upstream(status, { code: 'SELLER_LISTING_SLUG_TAKEN', detail: 'unavailable' }, []),
    });
    expect(response.status).toBe(status);
    expect(response.headers.get('content-type')).toBe('application/problem+json');
  });

  it('refuses a body that is not JSON without asking the API', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerServiceCreate(
      new Request('https://web.test/api/sellers/me/services', {
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

describe('editing a service draft', () => {
  it('sends the slug percent-encoded and keeps absent, null and a value apart', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerServiceUpdate(
      write('/api/sellers/me/services/logo-design', {
        title: 'Logo Design Pro',
        deliveryDays: null,
        revisionsIncluded: 4,
      }),
      'logo-design',
      { env: ENV, fetch: upstream(200, WRITTEN, seen) },
    );

    expect(response.status).toBe(200);
    expect(seen[0]?.method).toBe('PATCH');
    expect(seen[0]?.url).toBe(`${ENV.API_BASE_URL}/v1/sellers/me/services/logo-design`);
    const sent = JSON.parse(seen[0]!.body!) as Record<string, unknown>;
    expect(Object.hasOwn(sent, 'deliveryDays')).toBe(true);
    expect(sent['deliveryDays']).toBeNull();
    expect(sent['revisionsIncluded']).toBe(4);
    expect(Object.hasOwn(sent, 'scope')).toBe(false);
    expect(Object.hasOwn(sent, 'pricingModel')).toBe(false);
  });

  it('carries a withdrawn pricing model as an explicit null', async () => {
    const seen: Seen[] = [];
    await handleSellerServiceUpdate(
      write('/api/sellers/me/services/logo-design', { pricingModel: null }),
      'logo-design',
      { env: ENV, fetch: upstream(200, WRITTEN, seen) },
    );

    const sent = JSON.parse(seen[0]!.body!) as Record<string, unknown>;
    expect(Object.hasOwn(sent, 'pricingModel')).toBe(true);
    expect(sent['pricingModel']).toBeNull();
  });

  it.each(['../../../etc/passwd', 'Logo-Design', 'a', 'logo design', 'logo?x=1', ''])(
    'refuses the malformed slug %j without asking the API',
    async (slug) => {
      const seen: Seen[] = [];
      const response = await handleSellerServiceUpdate(
        write('/api/sellers/me/services/x', { title: 'Renamed Svc' }),
        slug,
        { env: ENV, fetch: upstream(200, WRITTEN, seen) },
      );

      expect(response.status).toBe(404);
      expect(seen).toHaveLength(0);
    },
  );

  it('passes a well-formed slug that is not a service of the caller’s to the API, which decides', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerServiceUpdate(
      write('/api/sellers/me/services/a-product-of-mine', { title: 'Renamed Svc' }),
      'a-product-of-mine',
      { env: ENV, fetch: upstream(404, { code: 'NOT_FOUND' }, seen) },
    );

    // This layer does not, and could not, decide whether the listing at that address is a service.
    expect(seen).toHaveLength(1);
    expect(response.status).toBe(404);
  });

  it('checks the Origin before it reads a cookie', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerServiceUpdate(
      write('/api/sellers/me/services/logo-design', { title: 'X Y Z' }, { origin: 'https://evil.test' }),
      'logo-design',
      { env: ENV, fetch: upstream(200, WRITTEN, seen) },
    );
    expect(response.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it('forwards the API’s 409 with its own code', async () => {
    const response = await handleSellerServiceUpdate(
      write('/api/sellers/me/services/logo-design', { title: 'X Y Z' }),
      'logo-design',
      {
        env: ENV,
        fetch: upstream(409, { code: 'SELLER_LISTING_NOT_EDITABLE', detail: 'not in this state' }, []),
      },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'SELLER_LISTING_NOT_EDITABLE' });
  });

  it('answers 401 without a session, and asks the API nothing', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerServiceUpdate(
      new Request('https://web.test/api/sellers/me/services/logo-design', {
        method: 'PATCH',
        headers: { origin: 'https://web.test', 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'X Y Z' }),
      }),
      'logo-design',
      { env: ENV, fetch: upstream(200, WRITTEN, seen) },
    );

    expect(response.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('never returns a token or the internal credential, whatever happened', async () => {
    const responses = [
      await handleSellerServices(read(), { env: ENV, fetch: upstream(200, PAGE, []) }),
      await handleSellerServiceCreate(write('/api/sellers/me/services', VALID_CREATE), {
        env: ENV,
        fetch: upstream(201, WRITTEN, []),
      }),
      await handleSellerServiceUpdate(
        write('/api/sellers/me/services/logo-design', { title: 'X Y Z' }),
        'logo-design',
        { env: ENV, fetch: upstream(409, { code: 'SELLER_LISTING_NOT_EDITABLE' }, []) },
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
