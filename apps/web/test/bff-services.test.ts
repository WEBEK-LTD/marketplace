import { describe, expect, it } from 'vitest';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/server/bff/internal-credential';
import { handleService, handleServices, readService, readServices } from '../src/server/bff/services';

/**
 * The BFF half of the public services (Phase 4-C).
 *
 * The browser's request must leave this origin as exactly one credentialled internal call, and whatever
 * comes back must be checked against the shared contract before a page is allowed to render it.
 *
 * The redirect is the part that is new here. A slug names one listing out of a namespace shared with
 * products, so a `301` may point off this surface entirely — and the surface it points at arrives as an
 * internal header, which this module has to read rather than guess.
 */

const ENV = {
  API_BASE_URL: 'https://api.test',
  PUBLIC_WEB_ORIGIN: 'https://web.test',
  INTERNAL_BFF_CREDENTIAL: 'test-current-credential-value-not-a-real-se',
} as const;

const SUMMARY = {
  id: '22220000-0000-4000-8000-000000000001',
  slug: 'logo-design',
  title: 'Logo design',
  city: 'Cairo',
  priceMinor: '150000',
  currencyCode: 'EGP',
  currencyMinorUnit: 2,
  pricingModel: 'fixed',
  deliveryDays: 5,
  revisionsIncluded: 2,
} as const;

const PAGE = { items: [SUMMARY], nextCursor: 'Y3Vyc29y' };

const DETAIL = {
  service: {
    ...SUMMARY,
    description: 'A description long enough to be real.',
    contentLanguage: 'en',
    requiresBrief: true,
    scope: 'Three concepts, two rounds of revision.',
    availability: 'available',
    category: { slug: 'design', name: 'Design' },
    seller: { slug: 'good-shop', displayName: 'Good Shop' },
    attributes: [],
    tags: [{ slug: 'remote', name: 'Remote' }],
  },
};

interface Seen {
  url: string;
  credential: string | null;
  method: string;
  redirect: RequestRedirect | undefined;
}

function apiReturns(
  status: number,
  body: unknown,
  seen: { value?: Seen } = {},
  headers: Record<string, string> = {},
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const sent = new Headers(init?.headers);
    seen.value = {
      url: String(input),
      credential: sent.get(INTERNAL_CREDENTIAL_HEADER),
      method: init?.method ?? 'GET',
      redirect: init?.redirect,
    };
    return new Response(body === null ? null : typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: {
        'content-type': status === 200 ? 'application/json' : 'application/problem+json',
        ...headers,
      },
    });
  }) as unknown as typeof fetch;
}

function apiUnreachable(): typeof fetch {
  return (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
}

describe('reading a page of services', () => {
  it('makes exactly one credentialled GET to the API', async () => {
    const seen: { value?: Seen } = {};
    await readServices({}, { env: ENV, fetch: apiReturns(200, PAGE, seen) });
    expect(seen.value?.method).toBe('GET');
    expect(seen.value?.url).toBe('https://api.test/v1/services');
    expect(seen.value?.credential).toBe(ENV.INTERNAL_BFF_CREDENTIAL);
  });

  it('passes a limit and a cursor through, and omits them when absent', async () => {
    const seen: { value?: Seen } = {};
    await readServices({ limit: '10', cursor: 'abc' }, { env: ENV, fetch: apiReturns(200, PAGE, seen) });
    expect(seen.value?.url).toBe('https://api.test/v1/services?limit=10&cursor=abc');

    await readServices({ limit: '', cursor: null }, { env: ENV, fetch: apiReturns(200, PAGE, seen) });
    expect(seen.value?.url).toBe('https://api.test/v1/services');
  });

  it('refuses a body that does not match the contract', async () => {
    for (const bad of [
      { items: [{ ...SUMMARY, sellerUserId: '11111111-1111-4111-8111-111111111111' }], nextCursor: null },
      { items: [{ ...SUMMARY, priceMinor: 150000 }], nextCursor: null },
      { items: [{ ...SUMMARY, pricingModel: 'hourly' }], nextCursor: null },
      { items: {}, nextCursor: null },
      'not json at all',
    ]) {
      expect(await readServices({}, { env: ENV, fetch: apiReturns(200, bad) })).toBeNull();
    }
  });

  it('returns nothing when the API refuses or cannot be reached', async () => {
    expect(await readServices({}, { env: ENV, fetch: apiReturns(503, {}) })).toBeNull();
    expect(await readServices({}, { env: ENV, fetch: apiUnreachable() })).toBeNull();
  });
});

describe('GET /api/services', () => {
  it('answers 200 with the page and never caches it', async () => {
    const response = await handleServices(new Request('https://web.test/api/services'), {
      env: ENV,
      fetch: apiReturns(200, PAGE),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(PAGE);
  });

  it('answers 503 rather than passing an upstream failure through', async () => {
    const response = await handleServices(new Request('https://web.test/api/services'), {
      env: ENV,
      fetch: apiReturns(500, { detail: 'relation "listing_service_details" does not exist' }),
    });
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ status: 503, code: 'SERVICE_UNAVAILABLE' });
    expect(body).not.toContain('relation');
  });
});

describe('reading one service', () => {
  it('asks for the slug and the locale, and does not follow the redirect itself', async () => {
    const seen: { value?: Seen } = {};
    await readService('logo-design', 'ar', { env: ENV, fetch: apiReturns(200, DETAIL, seen) });
    expect(seen.value?.url).toBe('https://api.test/v1/services/logo-design?locale=ar');
    expect(seen.value?.redirect).toBe('manual');
  });

  it('normalises a locale it does not serve', async () => {
    const seen: { value?: Seen } = {};
    await readService('logo-design', 'de', { env: ENV, fetch: apiReturns(200, DETAIL, seen) });
    expect(seen.value?.url).toBe('https://api.test/v1/services/logo-design?locale=en');
  });

  it('encodes a slug rather than pasting it into the path', async () => {
    const seen: { value?: Seen } = {};
    await readService('a service/../../admin', 'en', { env: ENV, fetch: apiReturns(404, {}, seen) });
    expect(seen.value?.url).toBe('https://api.test/v1/services/a%20service%2F..%2F..%2Fadmin?locale=en');
  });

  it('reports the four outcomes a page has to render', async () => {
    expect((await readService('logo-design', 'en', { env: ENV, fetch: apiReturns(200, DETAIL) })).kind).toBe('found');

    const moved = await readService('old-logo', 'en', {
      env: ENV,
      fetch: apiReturns(301, null, {}, { 'x-canonical-slug': 'logo-design', 'x-canonical-type': 'service' }),
    });
    expect(moved).toEqual({ kind: 'moved', canonicalSlug: 'logo-design', canonicalType: 'service' });

    expect((await readService('nothing', 'en', { env: ENV, fetch: apiReturns(404, {}) })).kind).toBe('not_found');
    expect((await readService('logo-design', 'en', { env: ENV, fetch: apiUnreachable() })).kind).toBe('unavailable');
  });

  it('carries the surface a redirect points at, so a product leaves this surface', async () => {
    const moved = await readService('a-sofa', 'en', {
      env: ENV,
      fetch: apiReturns(301, null, {}, { 'x-canonical-slug': 'a-sofa', 'x-canonical-type': 'product' }),
    });
    expect(moved).toEqual({ kind: 'moved', canonicalSlug: 'a-sofa', canonicalType: 'product' });
  });

  it('treats a redirect with no canonical slug or an unknown surface as a failure, not a move', async () => {
    expect((await readService('old', 'en', { env: ENV, fetch: apiReturns(301, null) })).kind).toBe('unavailable');
    expect(
      (
        await readService('old', 'en', {
          env: ENV,
          fetch: apiReturns(301, null, {}, { 'x-canonical-slug': 'x', 'x-canonical-type': 'something-else' }),
        })
      ).kind,
    ).toBe('unavailable');
  });

  it('refuses a service body that does not match the contract', async () => {
    for (const bad of [
      { service: { ...DETAIL.service, contactPhoneE164: '+201000000000' } },
      { service: { ...DETAIL.service, seller: { slug: 's', displayName: 'S', legalName: 'S LLC' } } },
      { service: { ...DETAIL.service, pricingModel: 'hourly' } },
      { service: {} },
      { listing: DETAIL.service },
    ]) {
      expect((await readService('logo-design', 'en', { env: ENV, fetch: apiReturns(200, bad) })).kind).toBe('unavailable');
    }
  });
});

describe('GET /api/services/:slug', () => {
  it('answers 200 with the service and never caches it', async () => {
    const response = await handleService(
      new Request('https://web.test/api/services/logo-design'),
      'logo-design',
      { env: ENV, fetch: apiReturns(200, DETAIL) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(DETAIL);
  });

  it('answers 301 to this origin, on the surface that owns the slug', async () => {
    const sameSurface = await handleService(
      new Request('https://web.test/api/services/old-logo'),
      'old-logo',
      {
        env: ENV,
        fetch: apiReturns(301, null, {}, { 'x-canonical-slug': 'logo-design', 'x-canonical-type': 'service' }),
      },
    );
    expect(sameSurface.status).toBe(301);
    expect(sameSurface.headers.get('location')).toBe('/api/services/logo-design');

    const crossSurface = await handleService(
      new Request('https://web.test/api/services/a-sofa'),
      'a-sofa',
      {
        env: ENV,
        fetch: apiReturns(301, null, {}, { 'x-canonical-slug': 'a-sofa', 'x-canonical-type': 'product' }),
      },
    );
    expect(crossSurface.status).toBe(301);
    expect(crossSurface.headers.get('location')).toBe('/api/listings/a-sofa');
  });

  it('answers 404 with nothing that says why', async () => {
    const response = await handleService(
      new Request('https://web.test/api/services/secret'),
      'secret',
      { env: ENV, fetch: apiReturns(404, { detail: 'service is in draft for a suspended seller' }) },
    );
    expect(response.status).toBe(404);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(body).not.toContain('draft');
    expect(body).not.toContain('suspended');
  });

  it('answers 503 when the API cannot be reached', async () => {
    const response = await handleService(
      new Request('https://web.test/api/services/logo-design'),
      'logo-design',
      { env: ENV, fetch: apiUnreachable() },
    );
    expect(response.status).toBe(503);
  });
});
