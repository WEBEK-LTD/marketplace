import { describe, expect, it } from 'vitest';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/server/bff/internal-credential';
import { handleSeller, readSeller } from '../src/server/bff/sellers';

/**
 * The BFF half of the public seller profile (Phase 4-E).
 *
 * One credentialled internal call, and the contract enforced on the way back. The assertion that earns
 * its place here is the last group: a private field cannot reach a browser even if the API sends one,
 * because the response is rebuilt from validated fields rather than forwarded.
 */

const ENV = {
  API_BASE_URL: 'https://api.test',
  PUBLIC_WEB_ORIGIN: 'https://web.test',
  INTERNAL_BFF_CREDENTIAL: 'test-current-credential-value-not-a-real-se',
} as const;

const SELLER = {
  slug: 'good-shop',
  displayName: 'Good Shop',
  bio: 'We restore mid-century furniture.',
  contentLanguage: 'en',
  city: 'Cairo',
};

const BODY = { seller: SELLER, availability: 'available' };

interface Seen {
  url: string;
  credential: string | null;
  method: string;
}

function apiReturns(status: number, body: unknown, seen: { value?: Seen } = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const sent = new Headers(init?.headers);
    seen.value = {
      url: String(input),
      credential: sent.get(INTERNAL_CREDENTIAL_HEADER),
      method: init?.method ?? 'GET',
    };
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': status === 200 ? 'application/json' : 'application/problem+json' },
    });
  }) as unknown as typeof fetch;
}

function apiUnreachable(): typeof fetch {
  return (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
}

describe('reading one seller', () => {
  it('makes exactly one credentialled GET, with the slug encoded', async () => {
    const seen: { value?: Seen } = {};
    await readSeller('good-shop', { env: ENV, fetch: apiReturns(200, BODY, seen) });
    expect(seen.value?.method).toBe('GET');
    expect(seen.value?.url).toBe('https://api.test/v1/sellers/good-shop');
    expect(seen.value?.credential).toBe(ENV.INTERNAL_BFF_CREDENTIAL);

    await readSeller('a seller/../../admin', { env: ENV, fetch: apiReturns(404, {}, seen) });
    expect(seen.value?.url).toBe('https://api.test/v1/sellers/a%20seller%2F..%2F..%2Fadmin');
  });

  it('reports the three outcomes a page has to render', async () => {
    const found = await readSeller('good-shop', { env: ENV, fetch: apiReturns(200, BODY) });
    expect(found).toMatchObject({ kind: 'found', availability: 'available' });

    expect((await readSeller('nobody', { env: ENV, fetch: apiReturns(404, {}) })).kind).toBe('not_found');
    expect((await readSeller('good-shop', { env: ENV, fetch: apiUnreachable() })).kind).toBe('unavailable');
    expect((await readSeller('good-shop', { env: ENV, fetch: apiReturns(503, {}) })).kind).toBe('unavailable');
  });

  it('keeps a suspended seller apart from an unreachable service', async () => {
    // Two things called "unavailable" that must never be confused: one is a 200 page, one is a 503.
    const suspended = await readSeller('gone-shop', {
      env: ENV,
      fetch: apiReturns(200, { seller: SELLER, availability: 'unavailable' }),
    });
    expect(suspended).toMatchObject({ kind: 'found', availability: 'unavailable' });
  });

  it('refuses a body that does not match the contract', async () => {
    for (const bad of [
      { seller: { ...SELLER, verificationStatus: 'verified' }, availability: 'available' },
      { seller: { ...SELLER, legalName: 'Good Shop LLC' }, availability: 'available' },
      { seller: { ...SELLER, contactEmail: 'good@example.com' }, availability: 'available' },
      { seller: SELLER, availability: 'suspended' },
      { seller: SELLER },
      { seller: {}, availability: 'available' },
      'not json at all',
    ]) {
      const result = await readSeller('good-shop', { env: ENV, fetch: apiReturns(200, bad) });
      expect(result.kind, JSON.stringify(bad).slice(0, 40)).toBe('unavailable');
    }
  });

  it('carries a seller with nothing optional filled in', async () => {
    const bare = { seller: { ...SELLER, bio: null, contentLanguage: null, city: null }, availability: 'available' };
    const result = await readSeller('bare-shop', { env: ENV, fetch: apiReturns(200, bare) });
    expect(result).toMatchObject({ kind: 'found', seller: { bio: null, city: null } });
  });
});

describe('GET /api/sellers/:slug', () => {
  it('answers 200 with the profile and never caches it', async () => {
    const response = await handleSeller(
      new Request('https://web.test/api/sellers/good-shop'),
      'good-shop',
      { env: ENV, fetch: apiReturns(200, BODY) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(BODY);
  });

  it('answers 200 with the marker for a suspended seller', async () => {
    const response = await handleSeller(
      new Request('https://web.test/api/sellers/gone-shop'),
      'gone-shop',
      { env: ENV, fetch: apiReturns(200, { seller: SELLER, availability: 'unavailable' }) },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ availability: 'unavailable' });
  });

  it('answers 404 with nothing that says why', async () => {
    const response = await handleSeller(
      new Request('https://web.test/api/sellers/waiting-shop'),
      'waiting-shop',
      { env: ENV, fetch: apiReturns(404, { detail: 'seller is pending approval' }) },
    );
    expect(response.status).toBe(404);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(body).not.toContain('pending');
  });

  it('answers 503 when the API cannot be reached', async () => {
    const response = await handleSeller(
      new Request('https://web.test/api/sellers/good-shop'),
      'good-shop',
      { env: ENV, fetch: apiUnreachable() },
    );
    expect(response.status).toBe(503);
  });

  it('never lets a private field reach the browser, even if the API sends one', async () => {
    // The API would have to be broken for this to happen; the response is rebuilt from validated fields
    // rather than forwarded, so a broken API becomes a 503 rather than a leak.
    const leaky = {
      seller: { ...SELLER, legalName: 'Good Shop LLC', contactPhoneE164: '+201000000001' },
      availability: 'available',
    };
    const response = await handleSeller(
      new Request('https://web.test/api/sellers/good-shop'),
      'good-shop',
      { env: ENV, fetch: apiReturns(200, leaky) },
    );
    const body = await response.text();
    expect(response.status).toBe(503);
    expect(body).not.toContain('Good Shop LLC');
    expect(body).not.toContain('+201000000001');
  });
});
