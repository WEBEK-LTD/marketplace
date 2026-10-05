import type { ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import ar from '../messages/ar.json';
import en from '../messages/en.json';
import { startBuiltApp, type RunningApp } from './support/next-server.js';
import { problem, startStubApi, type StubApi } from './support/stub-api.js';

/**
 * `/dashboard/seller/profile`, over real HTTP against the built app (Phase 6-D).
 *
 * What this page owes, and what the assertions are about:
 *
 * **Three read-only facts, and they are not inputs.** The slug, the status and the verification state are
 * rendered by the server page, and the tests check that they appear as text and that no form control carries
 * them — a read-only *input* would still post, and a disabled one would still be in the DOM to re-enable.
 *
 * **Editing exists only where the API allows it.** A suspended or closed storefront gets its state and no
 * form at all, so no mutation request can be made rather than being made and refused; asserted by looking
 * for the absence of `<form` and of every field name.
 *
 * **Nothing private, ever.** No identifier, no token, no API address, no legal name, no suspension reason,
 * no object path, no timestamp — asserted against the whole document, RSC payload included.
 *
 * The form's *behaviour* — preserved values on failure, the server response replacing the display, the
 * disabled submit — is tested exactly, as pure functions and against the component source, in
 * `seller-profile-edit.test.ts`. Testing it here would need a browser.
 *
 * No browser, no Playwright, no live provider, no deployment.
 */

// Exactly 43 base64url characters, or the web app's env validation refuses it at startup.
const CANARY_CREDENTIAL = 'test-web-profile-edit-canary-not-real-xxxxx';
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

/** Values the identity contract does not carry, offered to the API anyway. */
const PRIVATE_VALUES = {
  legalName: 'Good Shop Trading LLC',
  contactEmail: 'private@seller.invalid',
  contactPhone: '+201555000999',
  suspensionReason: 'Repeated policy breaches, internal note',
  logoPath: 'logos/good-shop.webp',
  verifiedAt: '2026-02-01T00:00:00.000Z',
} as const;

type Mode =
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

function apiServes(mode: Mode = { kind: 'seller', seller: SELLER }): void {
  api.reply((request, response) => {
    const path = request.url.split('?')[0] ?? '';
    if (path === '/v1/users/me') return json(response, IDENTITY);
    if (path === '/v1/sellers/me') {
      if (request.method === 'PATCH') {
        response.writeHead(200, { 'content-type': 'application/json' });
        return response.end(JSON.stringify({ seller: { ...SELLER, displayName: 'Renamed Shop' } }));
      }
      if (mode.kind === 'not_a_seller') return problem(response, 404, 'NOT_FOUND');
      if (mode.kind === 'unauthenticated') return problem(response, 401, 'AUTHENTICATION_REQUIRED');
      if (mode.kind === 'unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      return json(response, { seller: mode.seller });
    }
    if (path === '/v1/sellers/good-shop') {
      return json(response, {
        seller: { slug: 'good-shop', displayName: 'Good Shop', bio: null, contentLanguage: null, city: 'Cairo' },
        availability: 'available',
      });
    }
    if (path === '/v1/listings') return json(response, { listings: [], nextCursor: null });
    if (path === '/v1/services') return json(response, { services: [], nextCursor: null });
    if (path === '/v1/categories') return json(response, { categories: [] });
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

/** The form controls the page rendered, by name. */
function controls(html: string): string[] {
  return (html.match(/<(?:input|select|textarea)\b[^>]*\sname="([A-Za-z]+)"/g) ?? []).map(
    (tag) => /name="([A-Za-z]+)"/.exec(tag)?.[1] ?? '',
  );
}

describe('protection', () => {
  it('redirects a signed-out visitor into the existing login flow', async () => {
    const page = await load('/dashboard/seller/profile', null);

    expect(page.status).toBe(307);
    expect(page.location).toContain('/login');
    expect(page.robotsHeader).toBe('noindex');
  });

  it('redirects to the Arabic sign-in under /ar', async () => {
    const page = await load('/ar/dashboard/seller/profile', null);

    expect(page.status).toBe(307);
    expect(page.location).toContain('/ar/login');
  });

  it('gives a signed-out visitor none of the form, payload included', async () => {
    const page = await load('/dashboard/seller/profile', null);

    for (const absent of ['Edit seller profile', 'name="displayName"', 'Legal name', 'good-shop', 'Good Shop']) {
      expect(page.html, absent).not.toContain(absent);
    }
  });

  it('shows the signed-out view when the session is refused by the API', async () => {
    api.reply((request, response) => {
      const path = request.url.split('?')[0] ?? '';
      if (path === '/v1/users/me') return problem(response, 401, 'AUTHENTICATION_REQUIRED');
      return json(response, { seller: SELLER });
    });
    const page = await load('/dashboard/seller/profile');

    expect(page.status).toBe(200);
    expect(page.html).toContain('You are signed out');
    expect(page.html).not.toContain('Edit seller profile');
  });

  it('is noindex, in both locales', async () => {
    expect((await load('/dashboard/seller/profile')).robotsHeader).toBe('noindex');
    expect((await load('/ar/dashboard/seller/profile')).robotsHeader).toBe('noindex');
    expect((await load('/dashboard/seller/profile')).html).toContain('name="robots" content="noindex, nofollow"');
  });
});

describe('the read-only facts', () => {
  it('shows the slug, the status and the verification state as text', async () => {
    const page = await load('/dashboard/seller/profile');

    expect(page.status).toBe(200);
    expect(page.html).toContain('>Seller slug</dt>');
    expect(page.html).toContain('>good-shop</dd>');
    expect(page.html).toContain('>Status</dt>');
    expect(page.html).toContain('>Active</dd>');
    expect(page.html).toContain('>Verification status</dt>');
    expect(page.html).toContain('>Verified</dd>');
  });

  it('says the seller address cannot be changed', async () => {
    const page = await load('/dashboard/seller/profile');
    expect(page.html).toContain('This seller address cannot be changed.');
  });

  it('offers no control for the slug, the status or the verification state', async () => {
    const page = await load('/dashboard/seller/profile');
    const names = controls(page.html);

    // Not "disabled" and not "readonly" — absent. A disabled input is still in the DOM.
    for (const forbidden of ['slug', 'status', 'verificationStatus']) {
      expect(names, forbidden).not.toContain(forbidden);
    }
    expect(page.html).not.toContain('name="slug"');
    expect(page.html).not.toContain('readOnly');
  });

  it('renders the four statuses as their approved labels', async () => {
    for (const [status, label] of [
      ['pending', '>Pending</dd>'],
      ['active', '>Active</dd>'],
    ] as const) {
      apiServes({ kind: 'seller', seller: { ...SELLER, status } });
      expect((await load('/dashboard/seller/profile')).html, status).toContain(label);
    }
  });
});

describe('the editable form', () => {
  // Narrowed in 6-E, which added the two media file inputs to this same page. The nine editable profile fields
  // are still exactly nine; the assertion now names the whole set of controls, so an unapproved tenth profile
  // field still fails here.
  it('collects exactly the nine editable fields, beside the two media inputs', async () => {
    const page = await load('/dashboard/seller/profile');

    expect(controls(page.html).sort()).toEqual([
      'banner',
      'bio',
      'city',
      'contactEmail',
      'contactPhone',
      'contentLanguage',
      'countryCode',
      'displayName',
      'governorate',
      'legalName',
      'logo',
    ]);
  });

  it('labels every one of them, and associates each label with its field', async () => {
    const page = await load('/dashboard/seller/profile');

    for (const label of [
      'Display name',
      'Legal name',
      'Bio',
      'Language',
      'Country',
      'Governorate',
      'City',
      'Contact email',
      'Contact phone',
    ]) {
      expect(page.html, label).toContain(label);
    }
    expect(countOf(page.html, /<label for="profile-/g)).toBe(9);
  });

  it('pre-fills the three values the seller identity carries', async () => {
    apiServes({ kind: 'seller', seller: { ...SELLER, displayName: 'Good Shop', city: 'Cairo' } });
    const page = await load('/dashboard/seller/profile');

    expect(page.html).toMatch(/<input[^>]*name="displayName"[^>]*value="Good Shop"/);
    expect(page.html).toMatch(/<input[^>]*name="city"[^>]*value="Cairo"/);
    expect(page.html).toMatch(/name="countryCode"/);
  });

  it('says that a blank field keeps its current value', async () => {
    const page = await load('/dashboard/seller/profile');
    expect(page.html).toContain('Leave a field blank to keep its current value.');
  });

  it('is editable for a pending storefront too', async () => {
    apiServes({ kind: 'seller', seller: { ...SELLER, status: 'pending', verificationStatus: 'unverified' } });
    const page = await load('/dashboard/seller/profile');

    expect(page.status).toBe(200);
    expect(page.html).toContain('Edit seller profile');
    expect(page.html).toContain('name="displayName"');
    expect(page.html).toContain('>Pending</dd>');
  });

  it('offers a save button that says what it does', async () => {
    const page = await load('/dashboard/seller/profile');
    expect(page.html).toContain('Save changes');
    expect(page.html).toContain('type="submit"');
  });

  // Narrowed in 6-E, which added the approved logo and banner upload. What still holds in full is the half that
  // keeps 6-I out: no verification document UI of any kind, and no upload that is not one of the two.
  it('offers no verification documents, and no upload beyond the approved two', async () => {
    const page = await load('/dashboard/seller/profile');

    for (const absent of [
      'enctype',
      'multipart/form-data',
      'Document',
      'National ID',
      'Passport',
      'Commercial register',
      'Tax card',
      'Bank statement',
    ]) {
      expect(page.html, absent).not.toContain(absent);
    }
    // Exactly two file inputs: the logo and the banner.
    expect(page.html.match(/<input[^>]*type="file"/g) ?? []).toHaveLength(2);
  });

  it('offers no role, moderation or payout control', async () => {
    const page = await load('/dashboard/seller/profile');

    for (const absent of ['name="role"', 'Payout', 'IBAN', 'Moderation', 'Suspend', 'Verify']) {
      expect(page.html, absent).not.toContain(absent);
    }
  });
});

describe('a storefront that cannot be edited', () => {
  it('shows a suspended state and no form at all', async () => {
    apiServes({ kind: 'seller', seller: { ...SELLER, status: 'suspended' } });
    const page = await load('/dashboard/seller/profile');

    expect(page.status).toBe(200);
    expect(page.html).toContain('Seller profile is suspended');
    expect(page.html).toContain('Seller profile cannot be edited in this state');
    expect(page.html).toContain('>Suspended</dd>');
    // No form: no request can be made, rather than being made and refused.
    expect(page.html).not.toContain('<form');
    expect(controls(page.html)).toEqual([]);
    expect(page.html).not.toContain('Save changes');
  });

  it('shows a closed state and no form at all', async () => {
    apiServes({ kind: 'seller', seller: { ...SELLER, status: 'closed' } });
    const page = await load('/dashboard/seller/profile');

    expect(page.status).toBe(200);
    expect(page.html).toContain('Seller profile is closed');
    expect(page.html).toContain('Seller profile cannot be edited in this state');
    expect(page.html).not.toContain('<form');
    expect(controls(page.html)).toEqual([]);
  });

  it('never says why a storefront is suspended', async () => {
    apiServes({ kind: 'seller', seller: { ...SELLER, status: 'suspended', ...PRIVATE_VALUES } });
    const page = await load('/dashboard/seller/profile');

    // The extra fields make the contract refuse the body, so the page shows the error view; either way none
    // of these values can appear.
    for (const value of Object.values(PRIVATE_VALUES)) {
      expect(page.html, value).not.toContain(value);
    }
    for (const absent of ['reason', 'Reason', 'moderat', 'Moderat', 'appeal', 'Appeal', 'policy']) {
      expect(page.html, absent).not.toContain(absent);
    }
  });

  it('still shows the read-only facts for a suspended storefront', async () => {
    apiServes({ kind: 'seller', seller: { ...SELLER, status: 'suspended' } });
    const page = await load('/dashboard/seller/profile');

    expect(page.html).toContain('>good-shop</dd>');
    expect(page.html).toContain('>Verified</dd>');
  });
});

describe('the other states', () => {
  it('sends a caller with no storefront to the onboarding surface rather than showing a second form', async () => {
    apiServes({ kind: 'not_a_seller' });
    const page = await load('/dashboard/seller/profile');

    expect(page.status).toBe(200);
    expect(page.html).toContain('You&#x27;re not a seller yet');
    expect(page.html).toContain('href="/dashboard/seller"');
    // 6-C owns creation. There is no second creation form here.
    expect(page.html).not.toContain('Edit seller profile');
    expect(page.html).not.toContain('Create your seller profile');
    expect(page.html).not.toContain('name="slug"');
    expect(controls(page.html)).toEqual([]);
  });

  it('shows an error, not an empty form, when the service cannot answer', async () => {
    apiServes({ kind: 'unavailable' });
    const page = await load('/dashboard/seller/profile');

    expect(page.status).toBe(200);
    expect(page.html).toContain('Seller profile unavailable');
    expect(page.html).not.toContain('Edit seller profile');
    expect(controls(page.html)).toEqual([]);
  });

  it('follows the session behaviour when the read is refused mid-render', async () => {
    apiServes({ kind: 'unauthenticated' });
    const page = await load('/dashboard/seller/profile');

    expect(page.status).toBe(200);
    expect(page.html).toContain('Your session has ended');
    expect(page.html).not.toContain('Edit seller profile');
  });

  it('reads the caller identity on one internal hop, with the credential and no browser cookie', async () => {
    api.seen.length = 0;
    await load('/dashboard/seller/profile');

    const asked = api.seen.filter((call) => call.url === '/v1/sellers/me');
    expect(asked).toHaveLength(1);
    expect(asked[0]?.method).toBe('GET');
    expect(asked[0]?.credential).toBe(CANARY_CREDENTIAL);
    expect(asked[0]?.cookie).toBeNull();
  });
});

describe('privacy', () => {
  it('renders no identifier, contact detail, legal name, object path or timestamp', async () => {
    apiServes({ kind: 'seller', seller: { ...SELLER, ...PRIVATE_VALUES, userId: USER_ID } });
    const page = await load('/dashboard/seller/profile');

    for (const value of Object.values(PRIVATE_VALUES)) {
      expect(page.html, value).not.toContain(value);
    }
    expect(page.html).not.toContain(USER_ID);
    expect(page.html).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });

  it('renders no identifier on an ordinary page either', async () => {
    const page = await load('/dashboard/seller/profile');

    expect(page.html).not.toContain(USER_ID);
    expect(page.html).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/);
    for (const absent of ['userId', 'sellerUserId', 'suspensionReason', 'logoObjectPath', 'verifiedAt']) {
      expect(page.html, absent).not.toContain(absent);
    }
  });

  it('names no API address, token or credential', async () => {
    const page = await load('/dashboard/seller/profile');

    expect(page.html).not.toContain('/v1/');
    expect(page.html).not.toContain(api.baseUrl);
    expect(page.html).not.toContain('canary-access-token');
    expect(page.html).not.toContain('canary-refresh-token');
    expect(page.html).not.toContain(CANARY_CREDENTIAL);
  });

  it('loads no provider client, opens no socket and starts no polling', async () => {
    const page = await load('/dashboard/seller/profile');

    for (const absent of ['supabase', 'createClient', 'ws://', 'wss://', 'EventSource', 'setInterval(']) {
      expect(page.html.toLowerCase(), absent).not.toContain(absent.toLowerCase());
    }
  });
});

describe('localization and accessibility', () => {
  it('renders in English with exactly one h1', async () => {
    const page = await load('/dashboard/seller/profile');

    expect(page.html).toContain('>Seller profile</h1>');
    expect(countOf(page.html, /<h1[^>]*>/g)).toBe(1);
  });

  it('renders in Arabic, right to left, with exactly one h1', async () => {
    const page = await load('/ar/dashboard/seller/profile');

    expect(page.status).toBe(200);
    expect(page.html).toContain('<html lang="ar" dir="rtl">');
    expect(page.html).toContain('ملف البائع');
    expect(page.html).toContain('تعديل ملف البائع');
    expect(page.html).toContain('لا يمكن تغيير عنوان البائع هذا.');
    expect(page.html).toContain('حفظ التغييرات');
    expect(countOf(page.html, /<h1[^>]*>/g)).toBe(1);
  });

  it('says the suspended and closed states in Arabic too', async () => {
    apiServes({ kind: 'seller', seller: { ...SELLER, status: 'suspended' } });
    expect((await load('/ar/dashboard/seller/profile')).html).toContain('ملف البائع موقوف');
    apiServes({ kind: 'seller', seller: { ...SELLER, status: 'closed' } });
    expect((await load('/ar/dashboard/seller/profile')).html).toContain('ملف البائع مغلق');
  });

  it('lays out with logical properties rather than left and right', async () => {
    const page = await load('/ar/dashboard/seller/profile');
    expect(page.html).not.toMatch(/class="[^"]*\b(ml|mr|pl|pr)-\d/);
  });

  it('carries the same SellerProfile keys in English and Arabic', () => {
    expect(Object.keys(ar.SellerProfile).sort()).toEqual(Object.keys(en.SellerProfile).sort());
  });

  it('has a distinct, non-empty Arabic value for every English one', () => {
    for (const key of Object.keys(en.SellerProfile) as Array<keyof typeof en.SellerProfile>) {
      const english = en.SellerProfile[key];
      const arabic = (ar.SellerProfile as Record<string, string>)[key];
      expect(arabic, key).toBeTruthy();
      expect(arabic, key).not.toBe(english);
    }
  });

  it('is the approved functional baseline, word for word', () => {
    expect(en.SellerProfile.title).toBe('Seller profile');
    expect(en.SellerProfile.edit).toBe('Edit seller profile');
    expect(en.SellerProfile.slug).toBe('Seller slug');
    expect(en.SellerProfile.slugPermanent).toBe('This seller address cannot be changed.');
    expect(en.SellerProfile.displayName).toBe('Display name');
    expect(en.SellerProfile.legalName).toBe('Legal name');
    expect(en.SellerProfile.bio).toBe('Bio');
    expect(en.SellerProfile.language).toBe('Language');
    expect(en.SellerProfile.country).toBe('Country');
    expect(en.SellerProfile.governorate).toBe('Governorate');
    expect(en.SellerProfile.city).toBe('City');
    expect(en.SellerProfile.contactEmail).toBe('Contact email');
    expect(en.SellerProfile.contactPhone).toBe('Contact phone');
    expect(en.SellerProfile.save).toBe('Save changes');
    expect(en.SellerProfile.saving).toBe('Saving...');
    expect(en.SellerProfile.saved).toBe('Changes saved');
    expect(en.SellerProfile.errorUnavailable).toBe('Seller profile unavailable');
    expect(en.SellerProfile.suspended).toBe('Seller profile is suspended');
    expect(en.SellerProfile.closed).toBe('Seller profile is closed');
    expect(en.SellerProfile.notEditable).toBe('Seller profile cannot be edited in this state');
    expect(en.SellerProfile.errorInvalid).toBe('Invalid seller information');
    expect(en.SellerProfile.retry).toBe('Try again');
  });

  it('and the Arabic baseline', () => {
    expect(ar.SellerProfile.title).toBe('ملف البائع');
    expect(ar.SellerProfile.edit).toBe('تعديل ملف البائع');
    expect(ar.SellerProfile.slugPermanent).toBe('لا يمكن تغيير عنوان البائع هذا.');
    expect(ar.SellerProfile.save).toBe('حفظ التغييرات');
    expect(ar.SellerProfile.saving).toBe('جارٍ الحفظ...');
    expect(ar.SellerProfile.saved).toBe('تم حفظ التغييرات');
    expect(ar.SellerProfile.suspended).toBe('ملف البائع موقوف');
    expect(ar.SellerProfile.closed).toBe('ملف البائع مغلق');
    expect(ar.SellerProfile.notEditable).toBe('لا يمكن تعديل ملف البائع في هذه الحالة');
  });

  it('adds one line beyond the baseline: what a blank field means', () => {
    // Six of the nine editable fields are not in the readable identity, so their boxes start blank and a
    // blank box preserves what is stored. Somebody typing into this form has to be told which.
    expect(en.SellerProfile.unchangedHint).toBe('Leave a field blank to keep its current value.');
    expect(ar.SellerProfile.unchangedHint).toBe('اترك الحقل فارغًا للإبقاء على قيمته الحالية.');
  });
});

describe('the seller navigation', () => {
  // Narrowed in 6-F, which built `/dashboard/seller/listings`, and again in 6-G, which built
  // `/dashboard/seller/services`: both are real routes and real links now, so both moved from the absent
  // list to the present one. Every other entry is still a surface that does not exist, and the assertion
  // still fails the moment a link to one appears.
  it('now links to the ten seller pages, and to nothing that does not exist', async () => {
    const page = await load('/dashboard/seller/profile');

    expect(page.html).toContain('href="/dashboard/seller"');
    expect(page.html).toContain('href="/dashboard/seller/profile"');
    expect(page.html).toContain('href="/dashboard/seller/listings"');
    expect(page.html).toContain('href="/dashboard/seller/services"');
    // 6-I added the fifth: verification. Everything below is still a surface that does not exist.
    expect(page.html).toContain('href="/dashboard/seller/verification"');
    // 6-J added the remaining five, so the navigation now carries ten links. Shipping, a settings page and a
    // standalone media page are still absent, because none of them exists.
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
      '/dashboard/seller/media',
    ]) {
      expect(page.html, absent).not.toContain(absent);
    }
  });

  it('links under /ar when the page is Arabic', async () => {
    const page = await load('/ar/dashboard/seller/profile');
    expect(page.html).toContain('href="/ar/dashboard/seller/profile"');
  });

  it('and the messaging navigation is unchanged', async () => {
    const page = await load('/dashboard/seller/profile');

    expect(page.html).toContain('href="/dashboard/messages"');
    expect(page.html).toContain('href="/dashboard/settings"');
  });
});

describe('the BFF write on this origin', () => {
  it('refuses a cross-origin PATCH', async () => {
    const response = await fetch(`${app.baseUrl}/api/sellers/me`, {
      method: 'PATCH',
      redirect: 'manual',
      headers: { cookie: SESSION, origin: 'https://evil.test', 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Renamed Shop' }),
    });

    expect(response.status).toBe(403);
  });

  it('refuses a PATCH with no session', async () => {
    const response = await fetch(`${app.baseUrl}/api/sellers/me`, {
      method: 'PATCH',
      redirect: 'manual',
      headers: { origin: app.baseUrl, 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Renamed Shop' }),
    });

    expect(response.status).toBe(401);
  });

  it('edits through one internal hop and answers 200 with the stored storefront', async () => {
    api.seen.length = 0;
    const response = await fetch(`${app.baseUrl}/api/sellers/me`, {
      method: 'PATCH',
      redirect: 'manual',
      headers: { cookie: SESSION, origin: app.baseUrl, 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Renamed Shop' }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ seller: { ...SELLER, displayName: 'Renamed Shop' } });

    const patches = api.seen.filter((call) => call.url === '/v1/sellers/me' && call.method === 'PATCH');
    expect(patches).toHaveLength(1);
    expect(patches[0]?.credential).toBe(CANARY_CREDENTIAL);
    expect(patches[0]?.cookie).toBeNull();
    expect(patches[0]?.body).not.toContain('canary-access-token');
  });

  it('refuses an injected slug, status or owner before the API is asked', async () => {
    api.seen.length = 0;
    for (const injected of [{ slug: 'new-address' }, { status: 'active' }, { userId: USER_ID }]) {
      const response = await fetch(`${app.baseUrl}/api/sellers/me`, {
        method: 'PATCH',
        redirect: 'manual',
        headers: { cookie: SESSION, origin: app.baseUrl, 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: 'Renamed Shop', ...injected }),
      });
      expect(response.status, JSON.stringify(injected)).toBe(400);
    }
    expect(api.seen.filter((call) => call.method === 'PATCH')).toHaveLength(0);
  });

  it('still offers no PUT or DELETE on that path', async () => {
    for (const method of ['PUT', 'DELETE'] as const) {
      const response = await fetch(`${app.baseUrl}/api/sellers/me`, {
        method,
        redirect: 'manual',
        headers: { cookie: SESSION, origin: app.baseUrl, 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: 'Renamed Shop' }),
      });
      expect(response.status, method).toBe(405);
    }
  });
});

describe('the surfaces around it are unchanged', () => {
  it('the public seller profile still answers with no session', async () => {
    const page = await load('/seller/good-shop', null);

    expect(page.status).toBe(200);
    expect(page.html).toContain('Good Shop');
    expect(page.robotsHeader).toBeNull();
    // And it offers no editing of any kind.
    expect(page.html).not.toContain('Edit seller profile');
    expect(controls(page.html)).toEqual([]);
  });

  it('there is no public editing route', async () => {
    for (const path of ['/seller/profile', '/seller/good-shop/edit']) {
      const page = await load(path, null);
      expect(page.status, path).toBe(404);
      expect(page.html, path).not.toContain('Edit seller profile');
    }
  });

  it('the 6-B shell still answers', async () => {
    const page = await load('/dashboard/seller');

    expect(page.status).toBe(200);
    expect(page.html).toContain('Seller account');
  });

  it('/become-a-seller is untouched: still public, still noindex', async () => {
    const page = await load('/become-a-seller', null);

    expect(page.status).toBe(200);
    expect(page.html).toContain('Become a seller');
    expect(page.robotsHeader).toBe('noindex');
  });

  it('the public catalogue still answers with no session', async () => {
    for (const path of ['/listings', '/services', '/categories', '/marketplace']) {
      expect((await load(path, null)).status, path).toBe(200);
    }
  });

  it('the messaging surfaces still redirect a signed-out visitor', async () => {
    for (const path of ['/dashboard/messages', '/dashboard/settings']) {
      const page = await load(path, null);
      expect(page.status, path).toBe(307);
      expect(page.location, path).toContain('/login');
    }
  });
});

describe('the media controls (Phase 6-E)', () => {
  it('offers a logo and a banner input, and nothing else', async () => {
    const page = await load('/dashboard/seller/profile');

    expect(page.html).toContain('Seller media');
    expect(page.html).toContain('>Logo</label>');
    expect(page.html).toContain('>Banner</label>');
    expect(page.html).toMatch(/<input[^>]*id="seller-media-logo"[^>]*type="file"/);
    expect(page.html).toMatch(/<input[^>]*id="seller-media-banner"[^>]*type="file"/);
    expect(page.html.match(/<input[^>]*type="file"/g) ?? []).toHaveLength(2);
  });

  it('accepts only the four approved image types, never a wildcard', async () => {
    const page = await load('/dashboard/seller/profile');

    expect(page.html).toContain('accept="image/jpeg,image/png,image/webp,image/avif"');
    expect(page.html).not.toContain('accept="image/*"');
    expect(page.html).not.toContain('image/svg');
    expect(page.html).not.toContain('application/pdf');
  });

  it('says what may be uploaded, beside the inputs', async () => {
    const page = await load('/dashboard/seller/profile');

    expect(page.html).toContain('JPEG, PNG, WebP or AVIF, up to 5 MB');
    expect(page.html).toMatch(/aria-describedby="seller-media-logo-types"/);
    expect(page.html).toMatch(/aria-describedby="seller-media-banner-types"/);
  });

  it('carries no bucket, no object path, no signed URL and no provider address', async () => {
    const page = await load('/dashboard/seller/profile');

    for (const absent of [
      'seller-media/',
      'storage/v1',
      'object/upload/sign',
      'token=',
      'supabase',
      'createSignedUrl',
      'logoObjectPath',
      'bannerObjectPath',
    ]) {
      expect(page.html.toLowerCase(), absent).not.toContain(absent.toLowerCase());
    }
  });

  it('offers no deletion, cropping, gallery or reordering', async () => {
    const page = await load('/dashboard/seller/profile');

    for (const absent of ['Delete', 'Remove', 'Crop', 'Gallery', 'Reorder']) {
      expect(page.html, absent).not.toContain(absent);
    }
  });

  it('is absent entirely for a suspended storefront: no control can ask for authorization', async () => {
    apiServes({ kind: 'seller', seller: { ...SELLER, status: 'suspended' } });
    const page = await load('/dashboard/seller/profile');

    expect(page.html).toContain('Seller profile is suspended');
    expect(page.html).not.toContain('Seller media');
    expect(page.html).not.toContain('type="file"');
    expect(page.html).not.toContain('id="seller-media-logo"');
  });

  it('is absent for a closed storefront too', async () => {
    apiServes({ kind: 'seller', seller: { ...SELLER, status: 'closed' } });
    const page = await load('/dashboard/seller/profile');

    expect(page.html).toContain('Seller profile is closed');
    expect(page.html).not.toContain('type="file"');
  });

  it('is absent for a caller with no storefront, and when the read fails', async () => {
    apiServes({ kind: 'not_a_seller' });
    expect((await load('/dashboard/seller/profile')).html).not.toContain('type="file"');

    apiServes({ kind: 'unavailable' });
    expect((await load('/dashboard/seller/profile')).html).not.toContain('type="file"');
  });

  it('is present for a pending storefront, which may upload', async () => {
    apiServes({ kind: 'seller', seller: { ...SELLER, status: 'pending', verificationStatus: 'unverified' } });
    const page = await load('/dashboard/seller/profile');

    expect(page.html).toContain('Seller media');
    expect(page.html.match(/<input[^>]*type="file"/g) ?? []).toHaveLength(2);
  });

  it('renders in Arabic, right to left', async () => {
    const page = await load('/ar/dashboard/seller/profile');

    expect(page.html).toContain('وسائط البائع');
    expect(page.html).toContain('الشعار');
    expect(page.html).toContain('الغلاف');
    expect(page.html).toContain('تحميل');
  });

  it('adds no second h1', async () => {
    const page = await load('/dashboard/seller/profile');
    expect(countOf(page.html, /<h1[^>]*>/g)).toBe(1);
  });

  it('carries the same SellerMedia keys in English and Arabic', () => {
    expect(Object.keys(ar.SellerMedia).sort()).toEqual(Object.keys(en.SellerMedia).sort());
    for (const key of Object.keys(en.SellerMedia) as Array<keyof typeof en.SellerMedia>) {
      const arabic = (ar.SellerMedia as Record<string, string>)[key];
      expect(arabic, key).toBeTruthy();
      expect(arabic, key).not.toBe(en.SellerMedia[key]);
    }
  });
});

describe('the media BFF routes on this origin (Phase 6-E)', () => {
  it('refuses a cross-origin authorization and a cross-origin confirmation', async () => {
    for (const path of ['/api/sellers/me/media/uploads', '/api/sellers/me/media']) {
      const response = await fetch(`${app.baseUrl}${path}`, {
        method: 'POST',
        redirect: 'manual',
        headers: { cookie: SESSION, origin: 'https://evil.test', 'content-type': 'application/json' },
        body: JSON.stringify({ mediaKind: 'logo', contentType: 'image/webp', byteSize: 1024 }),
      });
      expect(response.status, path).toBe(403);
    }
  });

  it('refuses both with no session', async () => {
    for (const path of ['/api/sellers/me/media/uploads', '/api/sellers/me/media']) {
      const response = await fetch(`${app.baseUrl}${path}`, {
        method: 'POST',
        redirect: 'manual',
        headers: { origin: app.baseUrl, 'content-type': 'application/json' },
        body: JSON.stringify({ mediaKind: 'logo', contentType: 'image/webp', byteSize: 1024 }),
      });
      expect(response.status, path).toBe(401);
    }
  });

  it('refuses an authorization that names a destination, before the API is asked', async () => {
    api.seen.length = 0;
    for (const injected of [
      { objectPath: 'seller-media/good-shop/logo/x.webp' },
      { bucket: 'seller-media' },
      { slug: 'good-shop' },
    ]) {
      const response = await fetch(`${app.baseUrl}/api/sellers/me/media/uploads`, {
        method: 'POST',
        redirect: 'manual',
        headers: { cookie: SESSION, origin: app.baseUrl, 'content-type': 'application/json' },
        body: JSON.stringify({ mediaKind: 'logo', contentType: 'image/webp', byteSize: 1024, ...injected }),
      });
      expect(response.status, JSON.stringify(injected)).toBe(400);
    }
    expect(api.seen.filter((call) => call.url.includes('/media'))).toHaveLength(0);
  });

  it('refuses a disallowed type without a round trip', async () => {
    api.seen.length = 0;
    const response = await fetch(`${app.baseUrl}/api/sellers/me/media/uploads`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: SESSION, origin: app.baseUrl, 'content-type': 'application/json' },
      body: JSON.stringify({ mediaKind: 'logo', contentType: 'image/svg+xml', byteSize: 1024 }),
    });

    expect(response.status).toBe(400);
    expect(api.seen.filter((call) => call.url.includes('/media'))).toHaveLength(0);
  });

  it('offers no GET and no DELETE on either media route', async () => {
    for (const path of ['/api/sellers/me/media/uploads', '/api/sellers/me/media']) {
      for (const method of ['GET', 'DELETE'] as const) {
        const response = await fetch(`${app.baseUrl}${path}`, {
          method,
          redirect: 'manual',
          headers: { cookie: SESSION, origin: app.baseUrl },
        });
        expect(response.status, `${method} ${path}`).toBe(405);
      }
    }
  });
});
