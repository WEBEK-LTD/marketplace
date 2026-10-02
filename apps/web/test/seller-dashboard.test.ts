import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import ar from '../messages/ar.json';
import en from '../messages/en.json';
import { APP_DIR, startBuiltApp, type RunningApp } from './support/next-server.js';
import { problem, startStubApi, type StubApi } from './support/stub-api.js';

/**
 * The seller area shell, over real HTTP against the built app (Phase 6-B).
 *
 * Run against the built app rather than a unit harness for the same reason the messaging protection tests
 * are: what matters is what actually reaches a browser, including the streamed RSC payload. A signed-out
 * visitor must receive none of the seller shell, and "none" has to mean none of the document.
 *
 * The heaviest assertions are about absence:
 *
 *   * no identifier, contact detail, legal name, suspension reason, object path or timestamp anywhere in
 *     the response — the seller's own uuid included;
 *   * no client component on this page at all, so none of that can travel as client props;
 *   * no dead link to a seller surface that does not exist yet;
 *   * no change to the public seller route, the slug rules or the messaging navigation.
 *
 * And about the one distinction that matters most: a failing service is an error, never "you are not a
 * seller".
 *
 * No browser, no Playwright, no live provider, no deployment.
 */

// Exactly 43 base64url characters: the web app's env validation refuses any other length at startup,
// which surfaces as a 500 on every page rather than as a configuration error.
const CANARY_CREDENTIAL = 'test-web-seller-shell-canary-not-realxxxxxx';
const ACCESS = '__Host-mp_access=canary-access-token-value-not-a-real-token';
const REFRESH = '__Host-mp_refresh=canary-refresh-token-value-not-a-real-toke';
const SESSION = `${ACCESS}; ${REFRESH}`;
const USER_ID = '11111111-1111-4111-8111-111111111111';
const IDENTITY = { user: { id: USER_ID, displayName: 'Nadia' } };

const SELLER = {
  slug: 'good-shop',
  displayName: 'Good Shop',
  status: 'active',
  verificationStatus: 'verified',
  city: 'Cairo',
  countryCode: 'EG',
};

/** Values the seller identity contract does not carry, offered to the API anyway. */
const PRIVATE_VALUES = {
  legalName: 'Good Shop Trading LLC',
  contactEmail: 'private@seller.invalid',
  contactPhone: '+201555000999',
  suspensionReason: 'Repeated policy breaches, internal note',
  logoPath: 'logos/good-shop.webp',
  bannerPath: 'banners/good-shop.webp',
  verifiedAt: '2026-02-01T00:00:00.000Z',
} as const;

type SellerMode =
  | { readonly kind: 'seller'; readonly seller: Record<string, unknown> }
  | { readonly kind: 'not_a_seller' }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'unavailable' };

let api: StubApi;
let app: RunningApp;

beforeAll(async () => {
  api = await startStubApi();
  app = await startBuiltApp({ API_BASE_URL: api.baseUrl, INTERNAL_BFF_CREDENTIAL: CANARY_CREDENTIAL });
}, 120_000);

afterAll(async () => {
  await app.stop();
  await api.stop();
});

function json(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

/** The API as it behaves for each case, plus the identity read the session gate makes. */
function apiServes(mode: SellerMode = { kind: 'seller', seller: SELLER }): void {
  api.reply((request, response) => {
    const path = request.url.split('?')[0] ?? '';

    if (path === '/v1/users/me') return json(response, IDENTITY);

    if (path === '/v1/sellers/me') {
      if (mode.kind === 'not_a_seller') return problem(response, 404, 'NOT_FOUND');
      if (mode.kind === 'unauthenticated') return problem(response, 401, 'AUTHENTICATION_REQUIRED');
      if (mode.kind === 'unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      return json(response, { seller: mode.seller });
    }

    // The public catalogue routes the regression block needs.
    if (path === '/v1/listings') return json(response, { listings: [], nextCursor: null });
    if (path === '/v1/services') return json(response, { services: [], nextCursor: null });
    if (path === '/v1/categories') return json(response, { categories: [] });
    if (path === '/v1/search') return json(response, { results: [], nextCursor: null });
    if (path === '/v1/sellers/good-shop') {
      return json(response, {
        seller: { slug: 'good-shop', displayName: 'Good Shop', bio: null, contentLanguage: null, city: 'Cairo' },
        availability: 'available',
      });
    }
    return problem(response, 404, 'NOT_FOUND');
  });
}

beforeEach(() => {
  api.seen.length = 0;
  apiServes();
});

interface Page {
  readonly status: number;
  readonly location: string | null;
  readonly robotsHeader: string | null;
  readonly html: string;
}

/** `cookie: null` means a signed-out visitor; omitting it means the signed-in session. */
async function load(path: string, cookie: string | null = SESSION): Promise<Page> {
  const response = await fetch(`${app.baseUrl}${path}`, {
    redirect: 'manual',
    headers: cookie === null ? {} : { cookie },
  });
  return {
    status: response.status,
    location: response.headers.get('location'),
    robotsHeader: response.headers.get('x-robots-tag'),
    html: await response.text(),
  };
}

function countOf(html: string, pattern: RegExp): number {
  return html.match(pattern)?.length ?? 0;
}

describe('authentication', () => {
  it('redirects a signed-out visitor through the existing protected-route behaviour', async () => {
    const page = await load('/dashboard/seller', null);

    expect(page.status).toBe(307);
    expect(page.location).toContain('/login');
    expect(page.robotsHeader).toBe('noindex');
  });

  it('redirects under /ar to the Arabic sign-in', async () => {
    const page = await load('/ar/dashboard/seller', null);

    expect(page.status).toBe(307);
    expect(page.location).toContain('/ar/login');
  });

  it('gives a signed-out visitor none of the shell, payload included', async () => {
    const page = await load('/dashboard/seller', null);

    for (const absent of [
      'Seller dashboard',
      'Seller account',
      'Verification status',
      'Good Shop',
      'good-shop',
      'Cairo',
    ]) {
      expect(page.html, absent).not.toContain(absent);
    }
  });

  it('shows the signed-out view when the session is refused by the API', async () => {
    api.reply((request, response) => {
      const path = request.url.split('?')[0] ?? '';
      if (path === '/v1/users/me') return problem(response, 401, 'AUTHENTICATION_REQUIRED');
      return json(response, { seller: SELLER });
    });
    const page = await load('/dashboard/seller');

    expect(page.status).toBe(200);
    expect(page.html).toContain('You are signed out');
    expect(page.html).not.toContain('Seller account');
    expect(page.html).not.toContain('Good Shop');
  });

  it('reaches the page with a session', async () => {
    const page = await load('/dashboard/seller');

    expect(page.status).toBe(200);
    expect(page.html).toContain('Seller dashboard');
  });
});

describe('the seller states', () => {
  it('renders an active seller', async () => {
    const page = await load('/dashboard/seller');

    expect(page.html).toContain('Seller account');
    expect(page.html).toContain('Good Shop');
    expect(page.html).toContain('>Active</dd>');
    expect(page.html).toContain('>Verified</dd>');
    expect(page.html).toContain('Cairo');
    expect(page.html).toContain('>EG</dd>');
  });

  it('renders a pending seller, including that it is unverified', async () => {
    apiServes({
      kind: 'seller',
      seller: { ...SELLER, status: 'pending', verificationStatus: 'unverified' },
    });
    const page = await load('/dashboard/seller');

    expect(page.status).toBe(200);
    expect(page.html).toContain('>Pending</dd>');
    expect(page.html).toContain('>Unverified</dd>');
    // A pending seller reaches the area: the shell is accessible to them.
    expect(page.html).toContain('Seller account');
  });

  it('renders a suspended seller, saying so and nothing more', async () => {
    apiServes({ kind: 'seller', seller: { ...SELLER, status: 'suspended' } });
    const page = await load('/dashboard/seller');

    expect(page.status).toBe(200);
    expect(page.html).toContain('>Suspended</dd>');
    // Functional copy only: no reason, no moderation detail, no appeal machinery invented here.
    expect(page.html).not.toContain(PRIVATE_VALUES.suspensionReason);
    for (const absent of ['reason', 'Reason', 'appeal', 'Appeal', 'moderat', 'Moderat']) {
      expect(page.html, absent).not.toContain(absent);
    }
  });

  it('renders a closed seller', async () => {
    apiServes({ kind: 'seller', seller: { ...SELLER, status: 'closed' } });
    const page = await load('/dashboard/seller');

    expect(page.status).toBe(200);
    expect(page.html).toContain('>Closed</dd>');
    // Closed is not active: the word "Active" appears nowhere as a rendered state.
    expect(page.html).not.toContain('>Active</dd>');
  });

  it('omits the city row entirely when the seller has none', async () => {
    apiServes({ kind: 'seller', seller: { ...SELLER, city: null } });
    const page = await load('/dashboard/seller');

    expect(page.status).toBe(200);
    expect(page.html).toContain('>EG</dd>');
    expect(page.html).not.toContain('>City</dt>');
  });

  it('says so, and only that, when the caller is not a seller', async () => {
    apiServes({ kind: 'not_a_seller' });
    const page = await load('/dashboard/seller');

    expect(page.status).toBe(200);
    expect(page.html).toContain('You&#x27;re not a seller yet');
    expect(page.html).not.toContain('Seller account');
    // No fabricated storefront and no dead link to a page that does not exist yet.
    expect(page.html).not.toContain('Good Shop');
    expect(page.html).not.toContain('/become-a-seller');
  });

  it('shows an error, never "not a seller", when the service cannot answer', async () => {
    apiServes({ kind: 'unavailable' });
    const page = await load('/dashboard/seller');

    expect(page.status).toBe(200);
    expect(page.html).toContain('Seller profile unavailable');
    expect(page.html).not.toContain('You&#x27;re not a seller yet');
    expect(page.html).not.toContain('Seller account');
    expect(page.html).not.toContain('Good Shop');
  });

  it('follows the session behaviour when the seller read is refused mid-render', async () => {
    apiServes({ kind: 'unauthenticated' });
    const page = await load('/dashboard/seller');

    expect(page.status).toBe(200);
    expect(page.html).toContain('Your session has ended');
    expect(page.html).toContain('Sign in');
    expect(page.html).not.toContain('Seller account');
    expect(page.html).not.toContain('You&#x27;re not a seller yet');
  });

  it('reads the caller’s own identity on one internal hop, with the credential and no browser cookie', async () => {
    api.seen.length = 0;
    await load('/dashboard/seller');

    const asked = api.seen.filter((call) => call.url === '/v1/sellers/me');
    expect(asked).toHaveLength(1);
    expect(asked[0]?.method).toBe('GET');
    expect(asked[0]?.credential).toBe(CANARY_CREDENTIAL);
    expect(asked[0]?.cookie).toBeNull();
    // And never the public reader: no slug is involved on this page.
    expect(api.seen.some((call) => call.url.startsWith('/v1/sellers/good-shop'))).toBe(false);
  });
});

describe('privacy', () => {
  it('renders no identifier, contact detail, legal name, object path or timestamp', async () => {
    apiServes({ kind: 'seller', seller: { ...SELLER, ...PRIVATE_VALUES, userId: USER_ID } });
    const page = await load('/dashboard/seller');

    // A seventh field means the contract refused the body, so the page shows the error rather than a
    // half-built account. Either way, none of the private values may appear.
    for (const value of Object.values(PRIVATE_VALUES)) {
      expect(page.html, value).not.toContain(value);
    }
    expect(page.html).not.toContain(USER_ID);
    expect(page.html).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });

  it('renders no identifier on a perfectly ordinary page either', async () => {
    const page = await load('/dashboard/seller');

    expect(page.html).not.toContain(USER_ID);
    expect(page.html).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/);
    for (const absent of ['userId', 'sellerUserId', 'legalName', 'contactEmail', 'suspensionReason']) {
      expect(page.html, absent).not.toContain(absent);
    }
  });

  it('names no API address, token or credential', async () => {
    const page = await load('/dashboard/seller');

    expect(page.html).not.toContain('/v1/');
    expect(page.html).not.toContain(api.baseUrl);
    expect(page.html).not.toContain('canary-access-token');
    expect(page.html).not.toContain('canary-refresh-token');
    expect(page.html).not.toContain(CANARY_CREDENTIAL);
  });

  it('has no client component at all, so seller data cannot travel as client props', () => {
    // The strongest form of the RSC-payload rule: there is nothing on this page that could receive props.
    for (const file of [
      'src/app/[locale]/dashboard/seller/page.tsx',
      'src/components/seller-dashboard-nav.tsx',
      'src/components/seller-account-view.tsx',
    ]) {
      const source = readFileSync(join(APP_DIR, file), 'utf8');
      expect(source, file).not.toContain("'use client'");
      expect(source, file).not.toContain('"use client"');
    }
  });

  it('reads the seller identity on the server only: no browser fetch and no provider client', async () => {
    const page = await load('/dashboard/seller');

    for (const absent of ['/api/sellers/me', 'createClient', 'supabase', 'ws://', 'wss://']) {
      expect(page.html.toLowerCase(), absent).not.toContain(absent.toLowerCase());
    }
  });
});

describe('localization and direction', () => {
  it('renders in English with exactly one h1', async () => {
    const page = await load('/dashboard/seller');

    expect(page.html).toContain('>Seller dashboard</h1>');
    expect(countOf(page.html, /<h1[^>]*>/g)).toBe(1);
  });

  it('renders in Arabic, right to left, with exactly one h1', async () => {
    const page = await load('/ar/dashboard/seller');

    expect(page.status).toBe(200);
    expect(page.html).toContain('<html lang="ar" dir="rtl">');
    expect(page.html).toContain('لوحة البائع');
    expect(page.html).toContain('حساب البائع');
    expect(page.html).toContain('حالة التحقق');
    expect(countOf(page.html, /<h1[^>]*>/g)).toBe(1);
  });

  it('renders the Arabic state labels', async () => {
    apiServes({
      kind: 'seller',
      seller: { ...SELLER, status: 'suspended', verificationStatus: 'rejected' },
    });
    const page = await load('/ar/dashboard/seller');

    expect(page.html).toContain('موقوف');
    expect(page.html).toContain('مرفوض');
  });

  it('says "not a seller yet" in Arabic too', async () => {
    apiServes({ kind: 'not_a_seller' });
    const page = await load('/ar/dashboard/seller');

    expect(page.html).toContain('لست بائعًا بعد');
  });

  it('lays out with logical properties, so /ar mirrors without a second stylesheet', () => {
    for (const file of ['src/components/seller-dashboard-nav.tsx', 'src/components/seller-account-view.tsx']) {
      const source = readFileSync(join(APP_DIR, file), 'utf8');
      expect(source, file).not.toMatch(/\b(ml|mr|pl|pr)-\d|\btext-(left|right)\b|\b(left|right)-\d/);
    }
  });

  it('carries the same SellerDashboard keys in English and Arabic', () => {
    expect(Object.keys(ar.SellerDashboard).sort()).toEqual(Object.keys(en.SellerDashboard).sort());
  });

  it('has a distinct, non-empty Arabic value for every English one', () => {
    for (const key of Object.keys(en.SellerDashboard) as Array<keyof typeof en.SellerDashboard>) {
      const english = en.SellerDashboard[key];
      const arabic = (ar.SellerDashboard as Record<string, string>)[key];
      expect(arabic, key).toBeTruthy();
      expect(arabic, key).not.toBe(english);
    }
  });

  it('keeps the approved copy exactly', () => {
    expect(en.SellerDashboard.title).toBe('Seller dashboard');
    expect(en.SellerDashboard.account).toBe('Seller account');
    expect(en.SellerDashboard.status).toBe('Status');
    expect(en.SellerDashboard.verificationStatus).toBe('Verification status');
    expect(en.SellerDashboard.city).toBe('City');
    expect(en.SellerDashboard.country).toBe('Country');
    expect(en.SellerDashboard.statusPending).toBe('Pending');
    expect(en.SellerDashboard.statusActive).toBe('Active');
    expect(en.SellerDashboard.statusSuspended).toBe('Suspended');
    expect(en.SellerDashboard.statusClosed).toBe('Closed');
    expect(en.SellerDashboard.notASeller).toBe("You're not a seller yet");
    expect(en.SellerDashboard.becomeASeller).toBe('Become a seller');
    expect(ar.SellerDashboard.title).toBe('لوحة البائع');
    expect(ar.SellerDashboard.notASeller).toBe('لست بائعًا بعد');
    expect(ar.SellerDashboard.becomeASeller).toBe('كن بائعًا');
  });
});

describe('the seller navigation', () => {
  it('is a real nav with an accessible name', async () => {
    const page = await load('/dashboard/seller');
    expect(page.html).toContain('<nav aria-label="Seller dashboard"');
  });

  it('links to the one seller route that exists, as an ordinary anchor', async () => {
    const page = await load('/dashboard/seller');
    expect(page.html).toContain('href="/dashboard/seller"');
  });

  // Narrowed in 6-F, which built `/dashboard/seller/listings`, and again in 6-G, which built
  // `/dashboard/seller/services`: neither is a dead link any more, so both moved to the positive assertion
  // below. Everything else in this list is still a surface that does not exist, and the public
  // `/seller/listings` the owner forbade is still forbidden — asserted as a link target rather than as a
  // substring, because `/dashboard/seller/listings` contains it.
  it('renders no dead link to a seller surface that does not exist yet', async () => {
    const page = await load('/dashboard/seller');
    // 6-I added the verification page, so its link is now expected rather than forbidden. Everything else
    // on this list is still a surface that does not exist — shipping in particular, which the approved S-11
    // decision defers to Phase 8.
    expect(page.html).toContain('href="/dashboard/seller/verification"');
    // 6-J built five of the surfaces this list used to forbid, so each one is now expected. What remains
    // forbidden is what still does not exist: shipping (deferred to Phase 8 by the approved S-11 decision),
    // a settings page, and the two addresses the owner ruled out.
    for (const present of [
      'href="/dashboard/seller/orders"',
      'href="/dashboard/seller/reviews"',
      'href="/dashboard/seller/earnings"',
      'href="/dashboard/seller/promotions"',
      'href="/dashboard/seller/analytics"',
    ]) {
      expect(page.html, present).toContain(present);
    }
    for (const absent of [
      '/dashboard/seller/shipping',
      '/dashboard/seller/settings',
      '/become-a-seller',
      '/seller/overview',
    ]) {
      expect(page.html, absent).not.toContain(absent);
    }
    // The public seller namespace the owner forbade, as a link target in either locale.
    for (const forbidden of ['href="/seller/listings"', 'href="/ar/seller/listings"']) {
      expect(page.html, forbidden).not.toContain(forbidden);
    }
  });

  it('links to the surfaces 6-F and 6-G built, and to no other new one', async () => {
    const page = await load('/dashboard/seller');
    expect(page.html).toContain('href="/dashboard/seller/listings"');
    expect(page.html).toContain('href="/dashboard/seller/services"');
    expect(page.html).toContain('href="/dashboard/seller/profile"');
  });

  it('is a list of links with a visible focus ring, reachable by keyboard', async () => {
    const page = await load('/dashboard/seller');
    expect(page.html).toMatch(/<nav aria-label="Seller dashboard"[^>]*>[\s\S]*?<ul[^>]*>[\s\S]*?<li>/);
    // An ordinary anchor: no role, no tabindex, no click-only control.
    expect(page.html).not.toMatch(/<div[^>]*role="link"/);
    const source = readFileSync(join(APP_DIR, 'src/components/seller-dashboard-nav.tsx'), 'utf8');
    expect(source).toContain('focus-visible:outline');
  });

  it('links under /ar when the page is Arabic', async () => {
    const page = await load('/ar/dashboard/seller');
    expect(page.html).toContain('href="/ar/dashboard/seller"');
  });

  it('leaves the messaging navigation exactly as it was', async () => {
    const page = await load('/dashboard/seller');

    // The signed-in navigation still renders its own links, under its own accessible name. 7-E added
    // the buyer account surfaces to it; the messaging and settings links it already had are untouched.
    expect(page.html).toContain('href="/dashboard/messages"');
    expect(page.html).toContain('href="/dashboard/settings"');
    expect(page.html).toContain('<nav aria-label="Your account"');
  });

  it('is not added to the messaging surfaces', async () => {
    const page = await load('/dashboard/settings');

    expect(page.status).toBe(200);
    // The seller nav belongs to the seller shell; the settings page did not grow a seller link.
    expect(page.html).not.toContain('href="/dashboard/seller"');
    expect(page.html).not.toContain('<nav aria-label="Seller dashboard"');
  });
});

describe('robots and routing', () => {
  it('is noindex, in both locales', async () => {
    expect((await load('/dashboard/seller')).robotsHeader).toBe('noindex');
    expect((await load('/ar/dashboard/seller')).robotsHeader).toBe('noindex');
  });

  it('declares noindex in its metadata as well as its header', async () => {
    const page = await load('/dashboard/seller');
    expect(page.html).toContain('name="robots" content="noindex, nofollow"');
  });

  it('resolves in both locales', async () => {
    expect((await load('/dashboard/seller')).status).toBe(200);
    expect((await load('/ar/dashboard/seller')).status).toBe(200);
  });

  it('leaves the public seller profile route exactly as it was', async () => {
    const page = await load('/seller/good-shop', null);

    expect(page.status).toBe(200);
    expect(page.html).toContain('Good Shop');
    // Still indexable, still public, still no session needed.
    expect(page.robotsHeader).toBeNull();
  });

  it('keeps `/seller/messages` and `/seller/overview` as ordinary public slug lookups', async () => {
    // Nothing was reserved: these are slugs nobody holds, so they are the same 404 any unknown slug gets.
    for (const path of ['/seller/messages', '/seller/overview', '/seller/seller']) {
      const page = await load(path, null);
      expect(page.status, path).toBe(404);
      expect(page.html, path).not.toContain('Seller dashboard');
      expect(page.html, path).not.toContain('Seller account');
    }
  });

  it('added no slug reservation to the shared routing helpers', () => {
    const source = readFileSync(
      join(APP_DIR, '../../packages/config/src/security-headers.ts'),
      'utf8',
    );
    for (const absent of ['RESERVED', 'reserved', 'overview', 'dashboard/seller']) {
      expect(source, absent).not.toContain(absent);
    }
  });

  it('left the middleware untouched by seller-specific logic', () => {
    const source = readFileSync(join(APP_DIR, 'src/proxy.ts'), 'utf8');
    expect(source).not.toContain('/dashboard/seller');
    expect(source).not.toContain('sellers/me');
  });
});

describe('the surfaces around it are unchanged', () => {
  it('the public catalogue still answers with no session', async () => {
    for (const path of ['/listings', '/services', '/categories', '/marketplace', '/search?q=chair']) {
      const page = await load(path, null);
      expect(page.status, path).toBe(200);
    }
  });

  it('the messaging surfaces still redirect a signed-out visitor', async () => {
    for (const path of ['/dashboard/messages', '/dashboard/settings']) {
      const page = await load(path, null);
      expect(page.status, path).toBe(307);
      expect(page.location, path).toContain('/login');
    }
  });

  it('the public seller BFF route still needs no session', async () => {
    const response = await fetch(`${app.baseUrl}/api/sellers/good-shop`, { redirect: 'manual' });
    expect(response.status).toBe(200);
  });

  it('and the 6-A identity route still refuses without one', async () => {
    const response = await fetch(`${app.baseUrl}/api/sellers/me`, { redirect: 'manual' });
    expect(response.status).toBe(401);
  });
});
