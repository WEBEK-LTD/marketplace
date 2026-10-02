import type { ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import arMessages from '../messages/ar.json';
import enMessages from '../messages/en.json';
import { problem, startStubApi, type StubApi } from './support/stub-api.js';
import { startBuiltApp, type RunningApp } from './support/next-server.js';

/**
 * The buyer account surfaces, over real HTTP against the built app (Phase 7-E).
 *
 * Run against the built app rather than a unit harness because what matters is what actually reaches a
 * browser, including the streamed RSC payload. The assertions fall into five groups:
 *
 *   * **every state is rendered as itself** — empty, error and populated — and an unavailable service is
 *     never rendered as an empty list;
 *   * **a signed-out visitor receives none of it**, flight data included;
 *   * **nothing leaks** — no internal credential, no session token, no `/v1/...` address;
 *   * **both languages and both directions**, with Arabic mirrored by `dir="rtl"` on the document;
 *   * **nothing on these pages implies a capability that does not exist** — no saved-search schedule, no
 *     checkout, no authenticator, no password form.
 *
 * No browser, no Playwright, no live provider, no deployment.
 */

// Exactly 43 base64url characters: the web app's env validation refuses any other length at startup.
const CANARY_CREDENTIAL = 'test-web-buyer-account-canary-credential-12';
const ACCESS = '__Host-mp_access=canary-access-token-value-not-a-real-token';
const REFRESH = '__Host-mp_refresh=canary-refresh-token-value-not-a-real-toke';
const SESSION = `${ACCESS}; ${REFRESH}`;
const IDENTITY = { user: { id: '11111111-1111-4111-8111-111111111111', displayName: 'Nadia' } };

const EN = enMessages;
const AR = arMessages;

const LISTING = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  slug: 'blue-sofa',
  title: 'A blue sofa',
  city: 'Cairo',
  priceMinor: '250000',
  currencyCode: 'EGP',
  currencyMinorUnit: 2,
  isNegotiable: true,
  listingTypeCode: 'product',
};

const FAVORITE = {
  listingId: LISTING.id,
  savedAt: '2026-09-01T10:00:00.000Z',
  isAvailable: true,
  listing: LISTING,
};

const WITHDRAWN = {
  listingId: 'aaaaaaaa-0000-4000-8000-000000000002',
  savedAt: '2026-09-01T09:00:00.000Z',
  isAvailable: false,
  listing: null,
};

const SAVED_SEARCH = {
  id: 'bbbbbbbb-0000-4000-8000-000000000001',
  name: 'Sofas in Cairo',
  query: { q: 'sofa' },
  notify: true,
  lastMatchedAt: null,
  lastNotifiedAt: null,
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T10:00:00.000Z',
};

const ADDRESS = {
  id: 'cccccccc-0000-4000-8000-000000000001',
  label: 'Home',
  purpose: 'both',
  recipientName: 'Amina Hassan',
  phoneE164: '+201000000001',
  countryCode: 'EG',
  governorate: 'Cairo',
  city: 'Nasr City',
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

const PROFILE = {
  id: IDENTITY.user.id,
  displayName: 'Nadia',
  fullName: 'Nadia Farouk',
  phoneE164: '+201000000001',
  localeCode: 'en',
  timezone: 'Africa/Cairo',
  status: 'active',
  emailVerifiedAt: null,
  phoneVerifiedAt: '2026-09-01T10:00:00.000Z',
  createdAt: '2026-01-15T10:00:00.000Z',
};

const SETTINGS = {
  notifyEmail: true,
  notifySms: false,
  notifyWhatsapp: false,
  notifyInApp: true,
  marketingOptIn: false,
  digitStyle: null,
};

const COUNTRIES = {
  items: [
    { code: 'EG', nameEn: 'Egypt', nameAr: 'مصر', phoneCode: '20', isMarketplaceEnabled: true },
    { code: 'SA', nameEn: 'Saudi Arabia', nameAr: 'السعودية', phoneCode: '966', isMarketplaceEnabled: false },
  ],
};

type Mode = 'ok' | 'empty' | 'fails';

let api: StubApi;
let app: RunningApp;

beforeAll(async () => {
  api = await startStubApi();
  app = await startBuiltApp({ API_BASE_URL: api.baseUrl, INTERNAL_BFF_CREDENTIAL: CANARY_CREDENTIAL });
}, 180_000);

afterAll(async () => {
  await app.stop();
  await api.stop();
});

function json(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function apiServes(
  modes: {
    favorites?: Mode | 'paged';
    savedSearches?: Mode;
    addresses?: Mode;
    profile?: Mode;
    settings?: Mode;
    countries?: Mode;
    identity?: 'ok' | 'unauthenticated';
  } = {},
): void {
  const {
    favorites = 'ok',
    savedSearches = 'ok',
    addresses = 'ok',
    profile = 'ok',
    settings = 'ok',
    countries = 'ok',
    identity = 'ok',
  } = modes;

  api.reply((request, response) => {
    const [path] = request.url.split('?');

    if (path === '/v1/users/me') {
      if (identity === 'unauthenticated') return problem(response, 401, 'AUTHENTICATION_REQUIRED');
      return json(response, IDENTITY);
    }

    if (path === '/v1/users/me/favorites') {
      if (favorites === 'fails') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      if (favorites === 'empty') return json(response, { items: [], nextCursor: null });
      if (favorites === 'paged') return json(response, { items: [FAVORITE], nextCursor: 'ZnYxfG5leHQ' });
      return json(response, { items: [FAVORITE, WITHDRAWN], nextCursor: null });
    }

    if (path === '/v1/users/me/saved-searches') {
      if (savedSearches === 'fails') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      if (savedSearches === 'empty') return json(response, { items: [], nextCursor: null });
      return json(response, { items: [SAVED_SEARCH], nextCursor: null });
    }

    if (path === '/v1/users/me/addresses') {
      if (addresses === 'fails') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      if (addresses === 'empty') return json(response, { items: [] });
      return json(response, { items: [ADDRESS] });
    }

    if (path === '/v1/users/me/profile') {
      if (profile === 'fails') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      return json(response, { profile: PROFILE });
    }

    if (path === '/v1/users/me/settings') {
      if (settings === 'fails') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      return json(response, { settings: SETTINGS });
    }

    if (path === '/v1/reference/countries') {
      if (countries === 'fails') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      return json(response, COUNTRIES);
    }

    return problem(response, 404, 'NOT_FOUND');
  });
}

async function get(path: string, cookie = SESSION): Promise<{ status: number; html: string }> {
  const response = await fetch(`${app.baseUrl}${path}`, { redirect: 'manual', headers: { cookie } });
  return { status: response.status, html: await response.text() };
}

const SURFACES = [
  '/dashboard',
  '/dashboard/favorites',
  '/dashboard/saved-searches',
  '/dashboard/addresses',
  '/dashboard/profile',
  '/dashboard/settings',
  '/dashboard/security',
] as const;

/* ------------------------------------------------------------------------------------------------ */

describe('the dashboard shell', () => {
  it('greets the person by the name their own profile carries', async () => {
    apiServes();
    const { status, html } = await get('/dashboard');

    expect(status).toBe(200);
    expect(html).toContain('Nadia');
    expect(html).toContain(EN.Account.intro);
  });

  it('links to every surface it names, and to no seller surface', async () => {
    apiServes();
    const { html } = await get('/dashboard');

    for (const path of ['/dashboard/favorites', '/dashboard/saved-searches', '/dashboard/addresses', '/dashboard/profile', '/dashboard/settings', '/dashboard/security', '/dashboard/messages', '/dashboard/notifications']) {
      expect(html, path).toContain(`href="${path}"`);
    }
    expect(html).not.toContain('href="/dashboard/seller"');
    expect(html).not.toContain('/seller/');
  });

  it('still greets somebody whose profile could not be read', async () => {
    apiServes({ profile: 'fails' });
    const { status, html } = await get('/dashboard');

    expect(status).toBe(200);
    expect(html).toContain(EN.Account.greetingAnonymous);
    expect(html).toContain('href="/dashboard/favorites"');
  });

  it('carries the navigation on every signed-in surface', async () => {
    apiServes();
    for (const path of SURFACES) {
      const { html } = await get(path);
      expect(html, path).toContain('<nav aria-label="Your account"');
      expect(html, path).toContain('href="/dashboard/favorites"');
    }
  });
});

describe('favorites', () => {
  it('renders a saved listing with its title, its price and a link to it', async () => {
    apiServes();
    const { status, html } = await get('/dashboard/favorites');

    expect(status).toBe(200);
    expect(html).toContain(EN.Favorites.title);
    expect(html).toContain('A blue sofa');
    expect(html).toContain('href="/listing/blue-sofa"');
    // The money contract: the code and the decimal amount, never a locale-converted figure.
    expect(html).toContain('EGP');
    expect(html).toContain('2500.00');
    expect(html).toContain(EN.Favorites.negotiable);
  });

  it('keeps a withdrawn favorite on the list, with no link and no price', async () => {
    apiServes();
    const { html } = await get('/dashboard/favorites');

    expect(html).toContain(EN.Favorites.unavailable);
    expect(html).toContain(EN.Favorites.unavailableHint);
    expect(html).not.toContain(`href="/listing/${WITHDRAWN.listingId}"`);
  });

  it('renders the empty state rather than an empty page', async () => {
    apiServes({ favorites: 'empty' });
    const { html } = await get('/dashboard/favorites');

    expect(html).toContain(EN.Favorites.empty);
    expect(html).toContain(EN.Favorites.emptyHint);
  });

  it('renders the error state rather than an empty list', async () => {
    apiServes({ favorites: 'fails' });
    const { html } = await get('/dashboard/favorites');

    expect(html).toContain(EN.Favorites.error);
    expect(html).toContain(EN.Favorites.retry);
    expect(html).not.toContain(EN.Favorites.empty);
  });

  it('offers the next page only when there is one', async () => {
    apiServes({ favorites: 'paged' });
    const paged = await get('/dashboard/favorites');
    expect(paged.html).toContain(EN.Favorites.older);

    apiServes();
    const last = await get('/dashboard/favorites');
    expect(last.html).not.toContain(`>${EN.Favorites.older}<`);
  });
});

describe('saved searches', () => {
  it('renders a stored search and says plainly that nothing runs it', async () => {
    apiServes();
    const { status, html } = await get('/dashboard/saved-searches');

    expect(status).toBe(200);
    expect(html).toContain('Sofas in Cairo');
    expect(html).toContain(EN.SavedSearches.notifyOn);
    // Never matched, and the page says so rather than implying a schedule.
    expect(html).toContain(EN.SavedSearches.never);
    expect(html).toContain(EN.SavedSearches.intro);
  });

  it('offers to run the search rather than pretending it runs itself', async () => {
    apiServes();
    const { html } = await get('/dashboard/saved-searches');
    expect(html).toContain('href="/search?q=sofa"');
  });

  it('renders the empty and error states', async () => {
    apiServes({ savedSearches: 'empty' });
    expect((await get('/dashboard/saved-searches')).html).toContain(EN.SavedSearches.empty);

    apiServes({ savedSearches: 'fails' });
    const failed = await get('/dashboard/saved-searches');
    expect(failed.html).toContain(EN.SavedSearches.error);
    expect(failed.html).not.toContain(EN.SavedSearches.empty);
  });
});

describe('addresses', () => {
  it('renders an address as an address, with its defaults marked', async () => {
    apiServes();
    const { status, html } = await get('/dashboard/addresses');

    expect(status).toBe(200);
    expect(html).toContain('Amina Hassan');
    expect(html).toContain('12 Street');
    expect(html).toContain('Nasr City');
    expect(html).toContain(EN.Addresses.defaultShipping);
    expect(html).toContain('<address');
  });

  it('says nothing about shipping, checkout or an order', async () => {
    apiServes();
    const { html } = await get('/dashboard/addresses');
    expect(html).toContain(EN.Addresses.intro);
    for (const word of ['checkout', 'delivery fee', 'shipping rate', 'order total']) {
      expect(html.toLowerCase()).not.toContain(word);
    }
  });

  it('renders the empty and error states', async () => {
    apiServes({ addresses: 'empty' });
    expect((await get('/dashboard/addresses')).html).toContain(EN.Addresses.empty);

    apiServes({ addresses: 'fails' });
    const failed = await get('/dashboard/addresses');
    expect(failed.html).toContain(EN.Addresses.error);
    expect(failed.html).not.toContain(EN.Addresses.empty);
  });

  it('still lists addresses when the country reference could not be read', async () => {
    apiServes({ countries: 'fails' });
    const { status, html } = await get('/dashboard/addresses');
    expect(status).toBe(200);
    expect(html).toContain('Amina Hassan');
    // Without a country list there is nothing honest to offer in the form, so it is not offered.
    expect(html).not.toContain(`>${EN.Addresses.add}<`);
  });
});

describe('profile', () => {
  it('shows what a person may read and offers what they may change', async () => {
    apiServes();
    const { status, html } = await get('/dashboard/profile');

    expect(status).toBe(200);
    expect(html).toContain('+201000000001');
    expect(html).toContain(EN.Profile.phoneVerified);
    expect(html).toContain(EN.Profile.emailUnverified);
    expect(html).toContain('id="profile-display-name"');
    expect(html).toContain('id="profile-timezone"');
  });

  it('offers no input for anything a person may not change', async () => {
    apiServes();
    const { html } = await get('/dashboard/profile');

    for (const id of ['profile-phone', 'profile-status', 'profile-role', 'profile-password']) {
      expect(html, id).not.toContain(`id="${id}"`);
    }
    // The phone is changed on the security page, and the profile says so.
    expect(html).toContain('href="/dashboard/security"');
  });

  it('renders the error state', async () => {
    apiServes({ profile: 'fails' });
    const { html } = await get('/dashboard/profile');
    expect(html).toContain(EN.Profile.error);
  });
});

describe('settings', () => {
  it('renders the switches the schema defines and no others', async () => {
    apiServes();
    const { status, html } = await get('/dashboard/settings');

    expect(status).toBe(200);
    expect(html).toContain(EN.Settings.notifyInApp);
    expect(html).toContain(EN.Settings.notifyEmail);
    expect(html).toContain(EN.Settings.notifySms);
    expect(html).toContain(EN.Settings.notifyWhatsapp);
    expect(html).toContain(EN.Settings.marketingOptIn);
    expect(html).toContain('id="settings-digit-style"');
    expect(html).not.toContain('preferences');
  });

  it('no longer holds the phone change, which moved to security', async () => {
    apiServes();
    const { html } = await get('/dashboard/settings');
    expect(html).not.toContain('id="contact-phone"');
  });

  it('renders the error state', async () => {
    apiServes({ settings: 'fails' });
    const { html } = await get('/dashboard/settings');
    expect(html).toContain(EN.Settings.error);
  });
});

describe('security', () => {
  it('offers only mechanisms that exist', async () => {
    apiServes();
    const { status, html } = await get('/dashboard/security');

    expect(status).toBe(200);
    expect(html).toContain('id="contact-phone"');
    expect(html).toContain(EN.Security.passwordHeading);
    expect(html).toContain('href="/forgot-password"');
    expect(html).toContain(EN.Security.signOut);
  });

  it('offers no authenticator, no backup codes and no session list', async () => {
    apiServes();
    const { html } = await get('/dashboard/security');

    for (const word of ['authenticator', 'backup code', 'sign out everywhere', 'active sessions', 'totp']) {
      expect(html.toLowerCase(), word).not.toContain(word);
    }
  });
});

/* ------------------------------------------------------------------------------------------------ */

describe('a signed-out visitor', () => {
  it('is redirected away from every surface without a session cookie', async () => {
    apiServes();
    for (const path of SURFACES) {
      const { status } = await get(path, '');
      expect(status, path).toBe(307);
    }
  });

  it('receives none of the content when the API says the session ended', async () => {
    apiServes({ identity: 'unauthenticated' });
    for (const path of SURFACES) {
      const { status, html } = await get(path);
      expect(status, path).toBe(200);
      expect(html, path).toContain('You are signed out');
    }

    // And nothing from the surfaces themselves, flight data included.
    const favorites = await get('/dashboard/favorites');
    expect(favorites.html).not.toContain('A blue sofa');
    const addresses = await get('/dashboard/addresses');
    expect(addresses.html).not.toContain('Amina Hassan');
    const profile = await get('/dashboard/profile');
    expect(profile.html).not.toContain('+201000000001');
  });
});

describe('what never reaches a browser', () => {
  it('sends no credential, no token and no internal address', async () => {
    apiServes();
    for (const path of SURFACES) {
      const { html } = await get(path);
      expect(html, path).not.toContain(CANARY_CREDENTIAL);
      expect(html, path).not.toContain('canary-access-token');
      expect(html, path).not.toContain('canary-refresh-token');
      expect(html, path).not.toContain('/v1/users/me');
      expect(html, path).not.toContain('x-internal-credential');
    }
  });

  it('keeps every surface out of a search index', async () => {
    apiServes();
    for (const path of SURFACES) {
      const response = await fetch(`${app.baseUrl}${path}`, { redirect: 'manual', headers: { cookie: SESSION } });
      expect(response.headers.get('x-robots-tag'), path).toBe('noindex');
    }
  });
});

describe('both languages', () => {
  it('renders every surface in Arabic, mirrored', async () => {
    apiServes();
    const pages: Array<[string, string]> = [
      ['/ar/dashboard', AR.Account.title],
      ['/ar/dashboard/favorites', AR.Favorites.title],
      ['/ar/dashboard/saved-searches', AR.SavedSearches.title],
      ['/ar/dashboard/addresses', AR.Addresses.title],
      ['/ar/dashboard/profile', AR.Profile.title],
      ['/ar/dashboard/settings', AR.Settings.title],
      ['/ar/dashboard/security', AR.Security.title],
    ];
    for (const [path, title] of pages) {
      const { status, html } = await get(path);
      expect(status, path).toBe(200);
      expect(html, path).toContain('<html lang="ar" dir="rtl">');
      expect(html, path).toContain(title);
    }
  });

  it('keeps Arabic links under the Arabic prefix', async () => {
    apiServes();
    const { html } = await get('/ar/dashboard');
    expect(html).toContain('href="/ar/dashboard/favorites"');
    expect(html).toContain('href="/ar/dashboard/security"');
  });

  it('shows the country reference in the reader’s language', async () => {
    apiServes();
    const english = await get('/dashboard/addresses');
    expect(english.html).toContain('Egypt');

    const arabic = await get('/ar/dashboard/addresses');
    expect(arabic.html).toContain('مصر');
  });

  it('renders the English surfaces left to right', async () => {
    apiServes();
    const { html } = await get('/dashboard/favorites');
    expect(html).toContain('<html lang="en" dir="ltr">');
  });
});
