import { describe, expect, it } from 'vitest';
import {
  handleAddFavorite,
  handleCreateAddress,
  handleCreateSavedSearch,
  handleDeleteAddress,
  handleDeleteSavedSearch,
  handleRemoveFavorite,
  handleUpdateAddress,
  handleUpdateProfile,
  handleUpdateSavedSearch,
  handleUpdateSettings,
  readAddresses,
  readBuyerProfile,
  readBuyerSettings,
  readCountries,
  readFavorites,
  readSavedSearches,
} from '../src/server/bff/buyer-account';
import { SESSION_COOKIES } from '../src/server/bff/session-cookies';

/**
 * The BFF half of the buyer account surfaces (Phase 7-E).
 *
 * What matters at this boundary:
 *
 *   * the caller's token comes from the `__Host-mp_access` cookie and never from a request body, and the
 *     browser's own `Cookie` header is never forwarded upstream;
 *   * **request bodies are rebuilt**, so a `userId` a page added is dropped before the request leaves
 *     this origin — the API's strict schema would refuse it too, and neither wall relies on the other;
 *   * responses are validated against the shared contract rather than forwarded, so a drifted body
 *     becomes a clean failure instead of a half-rendered list;
 *   * a session that ended, a row that is not there and a service that could not answer stay distinct;
 *   * the Origin check refuses a cross-site write before anything else happens;
 *   * a path identifier is checked for shape here, so nothing but an identifier reaches a URL.
 */

const ENV = Object.freeze({
  API_BASE_URL: 'https://api.internal.test',
  PUBLIC_WEB_ORIGIN: 'https://web.test',
  INTERNAL_BFF_CREDENTIAL: 'test-current-credential-value-not-a-real-se',
});

const SESSION_TOKEN = 'session-token-canary-value-not-a-real-token';
const COOKIE = `${SESSION_COOKIES.access.name}=${SESSION_TOKEN}`;
const LISTING_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const SAVED_A = 'bbbbbbbb-0000-4000-8000-000000000001';
const ADDRESS_A = 'cccccccc-0000-4000-8000-000000000001';
const OTHER_USER = '99999999-9999-4999-8999-999999999999';

const LISTING = {
  id: LISTING_A,
  slug: 'sofa',
  title: 'A sofa',
  city: 'Cairo',
  priceMinor: '250000',
  currencyCode: 'EGP',
  currencyMinorUnit: 2,
  isNegotiable: false,
  listingTypeCode: 'product',
};

const FAVORITE = {
  listingId: LISTING_A,
  savedAt: '2026-09-01T10:00:00.000Z',
  isAvailable: true,
  listing: LISTING,
};

const SAVED_SEARCH = {
  id: SAVED_A,
  name: 'Sofas',
  query: { q: 'sofa' },
  notify: true,
  lastMatchedAt: null,
  lastNotifiedAt: null,
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T10:00:00.000Z',
};

const ADDRESS = {
  id: ADDRESS_A,
  label: 'Home',
  purpose: 'both',
  recipientName: 'Amina Hassan',
  phoneE164: '+201000000001',
  countryCode: 'EG',
  governorate: 'Cairo',
  city: 'Cairo',
  district: null,
  streetAddress: '12 Street',
  building: null,
  apartment: null,
  postalCode: null,
  landmark: null,
  isDefaultShipping: true,
  isDefaultBilling: true,
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T10:00:00.000Z',
};

const ADDRESS_BODY = {
  purpose: 'both',
  recipientName: 'Amina Hassan',
  phoneE164: '+201000000001',
  countryCode: 'EG',
  governorate: 'Cairo',
  city: 'Cairo',
  streetAddress: '12 Street',
};

const PROFILE = {
  id: '11111111-1111-4111-8111-111111111111',
  displayName: 'Amina',
  fullName: 'Amina Hassan',
  phoneE164: '+201000000001',
  localeCode: 'ar',
  timezone: 'Africa/Cairo',
  status: 'active',
  emailVerifiedAt: null,
  phoneVerifiedAt: '2026-09-01T10:00:00.000Z',
  createdAt: '2026-09-01T10:00:00.000Z',
};

const SETTINGS = {
  notifyEmail: true,
  notifySms: false,
  notifyWhatsapp: false,
  notifyInApp: true,
  marketingOptIn: false,
  digitStyle: null,
};

interface Seen {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string;
}

function api(status: number, payload: unknown, seen: Seen[] = []): typeof fetch {
  return (async (input: unknown, init: RequestInit) => {
    seen.push({
      url: String(input),
      method: String(init.method ?? 'GET'),
      headers: new Headers(init.headers),
      body: String(init.body ?? ''),
    });
    return new Response(JSON.stringify(payload), {
      status,
      headers: {
        'content-type': status < 400 ? 'application/json' : 'application/problem+json',
      },
    });
  }) as unknown as typeof fetch;
}

function write(
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(`https://web.test/api/account/${path}`, {
    method,
    headers: {
      origin: 'https://web.test',
      cookie: COOKIE,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/* ------------------------------------------------------------------------------------------------ */

describe('7-E reads', () => {
  it('presents the caller’s token and the internal credential, and never the browser cookie', async () => {
    const seen: Seen[] = [];
    await readFavorites({}, { env: ENV, cookieHeader: COOKIE, fetch: api(200, { items: [], nextCursor: null }, seen) });

    expect(seen[0]!.url).toBe('https://api.internal.test/v1/users/me/favorites');
    expect(seen[0]!.method).toBe('GET');
    expect(seen[0]!.headers.get('x-session-token')).toBe(SESSION_TOKEN);
    expect(seen[0]!.headers.get('x-internal-credential')).toBe(ENV.INTERNAL_BFF_CREDENTIAL);
    expect(seen[0]!.headers.get('cookie')).toBeNull();
  });

  it('asks for the right upstream path on every read', async () => {
    const reads: Array<[(fetcher: typeof fetch) => Promise<unknown>, string]> = [
      [(f) => readFavorites({}, { env: ENV, cookieHeader: COOKIE, fetch: f }), '/v1/users/me/favorites'],
      [(f) => readSavedSearches({}, { env: ENV, cookieHeader: COOKIE, fetch: f }), '/v1/users/me/saved-searches'],
      [(f) => readAddresses({ env: ENV, cookieHeader: COOKIE, fetch: f }), '/v1/users/me/addresses'],
      [(f) => readBuyerProfile({ env: ENV, cookieHeader: COOKIE, fetch: f }), '/v1/users/me/profile'],
      [(f) => readBuyerSettings({ env: ENV, cookieHeader: COOKIE, fetch: f }), '/v1/users/me/settings'],
      [(f) => readCountries({ env: ENV, cookieHeader: COOKIE, fetch: f }), '/v1/reference/countries'],
    ];
    for (const [run, path] of reads) {
      const seen: Seen[] = [];
      await run(api(200, { items: [], nextCursor: null, profile: PROFILE, settings: SETTINGS }, seen));
      expect(seen[0]!.url, path).toBe(`https://api.internal.test${path}`);
      expect(seen[0]!.method).toBe('GET');
    }
  });

  it('passes a cursor through verbatim and parses nothing', async () => {
    const seen: Seen[] = [];
    await readFavorites(
      { cursor: 'ZnYxfDIwMjYtMDktMDF8YWJj', limit: '10' },
      { env: ENV, cookieHeader: COOKIE, fetch: api(200, { items: [], nextCursor: null }, seen) },
    );
    expect(seen[0]!.url).toContain('cursor=ZnYxfDIwMjYtMDktMDF8YWJj');
    expect(seen[0]!.url).toContain('limit=10');
  });

  it('validates the body against the contract', async () => {
    const good = await readFavorites(
      {},
      { env: ENV, cookieHeader: COOKIE, fetch: api(200, { items: [FAVORITE], nextCursor: null }) },
    );
    expect(good.kind).toBe('ok');
    expect(good.kind === 'ok' && good.data.items[0]!.listing?.priceMinor).toBe('250000');

    // A field the contract does not name means the body has drifted; that is a failure, not a render.
    const drifted = await readFavorites(
      {},
      {
        env: ENV,
        cookieHeader: COOKIE,
        fetch: api(200, { items: [{ ...FAVORITE, userId: OTHER_USER }], nextCursor: null }),
      },
    );
    expect(drifted.kind).toBe('unavailable');
  });

  it('keeps a session that ended, a row that is absent and an outage apart', async () => {
    const unauthenticated = await readAddresses({ env: ENV, cookieHeader: COOKIE, fetch: api(401, {}) });
    expect(unauthenticated.kind).toBe('unauthenticated');

    const missing = await readBuyerProfile({ env: ENV, cookieHeader: COOKIE, fetch: api(404, {}) });
    expect(missing.kind).toBe('missing');

    const refused = await readFavorites({}, { env: ENV, cookieHeader: COOKIE, fetch: api(400, {}) });
    expect(refused.kind).toBe('invalid');

    const down = await readBuyerSettings({ env: ENV, cookieHeader: COOKIE, fetch: api(500, {}) });
    expect(down.kind).toBe('unavailable');
  });

  it('never reaches the API without a session cookie', async () => {
    const seen: Seen[] = [];
    const result = await readFavorites({}, { env: ENV, cookieHeader: null, fetch: api(200, {}, seen) });
    expect(result.kind).toBe('unauthenticated');
    expect(seen).toEqual([]);
  });

  it('reads the profile and the settings without inventing a field', async () => {
    const profile = await readBuyerProfile({ env: ENV, cookieHeader: COOKIE, fetch: api(200, { profile: PROFILE }) });
    expect(profile.kind === 'ok' && profile.data.profile.displayName).toBe('Amina');

    const withRole = await readBuyerProfile({
      env: ENV,
      cookieHeader: COOKIE,
      fetch: api(200, { profile: { ...PROFILE, role: 'admin' } }),
    });
    expect(withRole.kind).toBe('unavailable');

    const settings = await readBuyerSettings({ env: ENV, cookieHeader: COOKIE, fetch: api(200, { settings: SETTINGS }) });
    expect(settings.kind === 'ok' && settings.data.settings.notifyEmail).toBe(true);

    const withPreferences = await readBuyerSettings({
      env: ENV,
      cookieHeader: COOKIE,
      fetch: api(200, { settings: { ...SETTINGS, preferences: {} } }),
    });
    expect(withPreferences.kind).toBe('unavailable');
  });

  it('reads the saved searches and the countries', async () => {
    const searches = await readSavedSearches(
      {},
      { env: ENV, cookieHeader: COOKIE, fetch: api(200, { items: [SAVED_SEARCH], nextCursor: null }) },
    );
    expect(searches.kind === 'ok' && searches.data.items[0]!.notify).toBe(true);

    const countries = await readCountries({
      env: ENV,
      cookieHeader: COOKIE,
      fetch: api(200, { items: [{ code: 'EG', nameEn: 'Egypt', nameAr: 'مصر', phoneCode: '20', isMarketplaceEnabled: true }] }),
    });
    expect(countries.kind === 'ok' && countries.data.items[0]!.code).toBe('EG');
  });

  it('reads the addresses', async () => {
    const result = await readAddresses({ env: ENV, cookieHeader: COOKIE, fetch: api(200, { items: [ADDRESS] }) });
    expect(result.kind === 'ok' && result.data.items[0]!.isDefaultShipping).toBe(true);
  });
});

/* ------------------------------------------------------------------------------------------------ */

describe('7-E writes', () => {
  it('refuses a cross-site write before anything else', async () => {
    const seen: Seen[] = [];
    const request = new Request('https://web.test/api/account/favorites', {
      method: 'POST',
      headers: { origin: 'https://evil.test', 'content-type': 'application/json', cookie: COOKIE },
      body: JSON.stringify({ listingId: LISTING_A }),
    });
    const response = await handleAddFavorite(request, { env: ENV, fetch: api(200, {}, seen) });
    expect(response.status).toBe(403);
    expect(seen).toEqual([]);
  });

  it('refuses every write without a session, before reaching the API', async () => {
    const seen: Seen[] = [];
    const request = new Request('https://web.test/api/account/favorites', {
      method: 'POST',
      headers: { origin: 'https://web.test', 'content-type': 'application/json' },
      body: JSON.stringify({ listingId: LISTING_A }),
    });
    const response = await handleAddFavorite(request, { env: ENV, fetch: api(200, {}, seen) });
    expect(response.status).toBe(401);
    expect(seen).toEqual([]);
  });

  it('rebuilds the favorite body, dropping anything a page added', async () => {
    const seen: Seen[] = [];
    await handleAddFavorite(
      write('POST', 'favorites', { listingId: LISTING_A, userId: OTHER_USER }),
      { env: ENV, fetch: api(200, { changed: true }, seen) },
    );
    // The schema is strict, so a body naming an account is refused outright rather than trimmed.
    expect(seen).toEqual([]);

    const clean: Seen[] = [];
    const ok = await handleAddFavorite(write('POST', 'favorites', { listingId: LISTING_A }), {
      env: ENV,
      fetch: api(200, { changed: true }, clean),
    });
    expect(ok.status).toBe(200);
    expect(JSON.parse(clean[0]!.body)).toEqual({ listingId: LISTING_A });
    expect(clean[0]!.headers.get('cookie')).toBeNull();
  });

  it('checks a path identifier here, so nothing but an identifier reaches a URL', async () => {
    const seen: Seen[] = [];
    const bad = await handleRemoveFavorite(write('DELETE', 'favorites/x'), '../../admin', {
      env: ENV,
      fetch: api(200, {}, seen),
    });
    expect(bad.status).toBe(400);
    expect(seen).toEqual([]);

    const good: Seen[] = [];
    await handleRemoveFavorite(write('DELETE', `favorites/${LISTING_A}`), LISTING_A.toUpperCase(), {
      env: ENV,
      fetch: api(200, { changed: true }, good),
    });
    expect(good[0]!.url).toBe(`https://api.internal.test/v1/users/me/favorites/${LISTING_A}`);
    expect(good[0]!.method).toBe('DELETE');
  });

  it('rebuilds a saved search from the three fields the contract names', async () => {
    const seen: Seen[] = [];
    const response = await handleCreateSavedSearch(
      write('POST', 'saved-searches', { name: '  Sofas  ', query: { q: 'sofa' }, notify: true }),
      { env: ENV, fetch: api(201, { id: SAVED_A }, seen) },
    );
    expect(response.status).toBe(201);
    expect(JSON.parse(seen[0]!.body)).toEqual({ name: 'Sofas', query: { q: 'sofa' }, notify: true });
  });

  it('refuses a saved search that tries to set a matching timestamp', async () => {
    const seen: Seen[] = [];
    const response = await handleUpdateSavedSearch(
      write('PATCH', `saved-searches/${SAVED_A}`, { name: 'S', query: {}, lastMatchedAt: '2026-09-01T00:00:00.000Z' }),
      SAVED_A,
      { env: ENV, fetch: api(200, {}, seen) },
    );
    expect(response.status).toBe(400);
    expect(seen).toEqual([]);
  });

  it('forwards a name conflict so a form can act on it', async () => {
    const problem = {
      type: 'about:blank',
      title: 'Conflict',
      status: 409,
      detail: 'You already have a saved search with that name.',
      instance: '/v1/users/me/saved-searches',
      code: 'SAVED_SEARCH_NAME_TAKEN',
    };
    const response = await handleCreateSavedSearch(
      write('POST', 'saved-searches', { name: 'Sofas', query: {} }),
      { env: ENV, fetch: api(409, problem) },
    );
    expect(response.status).toBe(409);
    expect(JSON.parse(await response.text())['code']).toBe('SAVED_SEARCH_NAME_TAKEN');
  });

  it('forwards the D17 shipping refusal, and an absence', async () => {
    const conflict = await handleCreateAddress(write('POST', 'addresses', { ...ADDRESS_BODY, countryCode: 'SA' }), {
      env: ENV,
      fetch: api(409, { code: 'ADDRESS_COUNTRY_NOT_SHIPPABLE' }),
    });
    expect(conflict.status).toBe(409);

    const missing = await handleUpdateAddress(write('PATCH', `addresses/${ADDRESS_A}`, ADDRESS_BODY), ADDRESS_A, {
      env: ENV,
      fetch: api(404, { code: 'NOT_FOUND' }),
    });
    expect(missing.status).toBe(404);
  });

  it('turns an unexpected upstream status into the generic outage', async () => {
    const response = await handleDeleteAddress(write('DELETE', `addresses/${ADDRESS_A}`), ADDRESS_A, {
      env: ENV,
      fetch: api(418, { code: 'HTTP_ERROR' }),
    });
    expect(response.status).toBe(503);
    expect(JSON.parse(await response.text())['code']).toBe('SERVICE_UNAVAILABLE');
  });

  it('rebuilds an address field by field', async () => {
    const seen: Seen[] = [];
    await handleCreateAddress(
      write('POST', 'addresses', { ...ADDRESS_BODY, countryCode: ' eg ', userId: OTHER_USER }),
      { env: ENV, fetch: api(201, { id: ADDRESS_A }, seen) },
    );
    // Strict schema: a body naming an account never leaves this origin at all.
    expect(seen).toEqual([]);

    const clean: Seen[] = [];
    await handleCreateAddress(write('POST', 'addresses', { ...ADDRESS_BODY, countryCode: ' eg ' }), {
      env: ENV,
      fetch: api(201, { id: ADDRESS_A }, clean),
    });
    const body = JSON.parse(clean[0]!.body) as Record<string, unknown>;
    expect(body['countryCode']).toBe('EG');
    expect(Object.keys(body).sort()).toEqual([
      'apartment',
      'building',
      'city',
      'countryCode',
      'district',
      'governorate',
      'isDefaultBilling',
      'isDefaultShipping',
      'label',
      'landmark',
      'phoneE164',
      'postalCode',
      'purpose',
      'recipientName',
      'streetAddress',
    ]);
  });

  it('sends only the profile fields the page actually set', async () => {
    const seen: Seen[] = [];
    await handleUpdateProfile(write('PATCH', 'profile', { displayName: 'Amina' }), {
      env: ENV,
      fetch: api(200, { changed: true }, seen),
    });
    expect(JSON.parse(seen[0]!.body)).toEqual({ displayName: 'Amina' });
  });

  it.each(['phoneE164', 'status', 'role', 'emailVerifiedAt', 'id'])(
    'refuses a profile write carrying %s, before it leaves this origin',
    async (field) => {
      const seen: Seen[] = [];
      const response = await handleUpdateProfile(write('PATCH', 'profile', { displayName: 'Amina', [field]: 'x' }), {
        env: ENV,
        fetch: api(200, {}, seen),
      });
      expect(response.status).toBe(400);
      expect(seen).toEqual([]);
    },
  );

  it('sends settings as a whole state', async () => {
    const seen: Seen[] = [];
    const body = {
      notifyEmail: false,
      notifySms: true,
      notifyWhatsapp: true,
      notifyInApp: false,
      marketingOptIn: true,
      digitStyle: 'arabic_indic',
    };
    const response = await handleUpdateSettings(write('PUT', 'settings', body), {
      env: ENV,
      fetch: api(200, { changed: true }, seen),
    });
    expect(response.status).toBe(200);
    expect(seen[0]!.method).toBe('PUT');
    expect(JSON.parse(seen[0]!.body)).toEqual(body);
  });

  it('refuses a partial settings write and one carrying preferences', async () => {
    const seen: Seen[] = [];
    expect((await handleUpdateSettings(write('PUT', 'settings', { notifyEmail: false }), { env: ENV, fetch: api(200, {}, seen) })).status).toBe(400);
    expect(
      (
        await handleUpdateSettings(
          write('PUT', 'settings', {
            notifyEmail: true,
            notifySms: false,
            notifyWhatsapp: false,
            notifyInApp: true,
            marketingOptIn: false,
            digitStyle: null,
            preferences: {},
          }),
          { env: ENV, fetch: api(200, {}, seen) },
        )
      ).status,
    ).toBe(400);
    expect(seen).toEqual([]);
  });

  it('validates a success body before any of it reaches a browser', async () => {
    const drifted = await handleDeleteSavedSearch(write('DELETE', `saved-searches/${SAVED_A}`), SAVED_A, {
      env: ENV,
      fetch: api(200, { changed: true, secret: 'x' }),
    });
    expect(drifted.status).toBe(503);
  });

  it('never returns a cacheable answer', async () => {
    const response = await handleAddFavorite(write('POST', 'favorites', { listingId: LISTING_A }), {
      env: ENV,
      fetch: api(200, { changed: true }),
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
