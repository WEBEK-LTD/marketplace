import type { ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import ar from '../messages/ar.json';
import en from '../messages/en.json';
import { startBuiltApp, type RunningApp } from './support/next-server.js';
import { problem, startStubApi, type StubApi } from './support/stub-api.js';

/**
 * `/become-a-seller` and the onboarding form, over real HTTP against the built app (Phase 6-C).
 *
 * Two surfaces, and the interesting properties are about who sees what.
 *
 * **The public entry page reads nothing.** No session, no cookie, no API call — asserted by watching the stub
 * API and finding it was never spoken to. That is what makes it safe to serve to anybody: there is nothing
 * about the visitor on the page, so there is nothing to leak.
 *
 * **One CTA, to a route that exists, correct for all three visitors.** It points at `/dashboard/seller`, and
 * the tests walk each case: signed out gets the 5-A redirect into the login flow, a signed-in non-seller gets
 * the form, and a signed-in seller gets their dashboard with no second creation control anywhere on it.
 *
 * **The form offers nothing it must not.** No status, verification, role, moderation, payout or media control,
 * and nothing in the page — form included — carries a UUID, a token, an API address or a private field.
 *
 * The form's *behaviour* is not tested here, because testing it would need a browser. It is tested exactly, as
 * pure functions, in `seller-onboarding.test.ts` — the same split 5-F used for polling.
 *
 * No browser, no Playwright, no live provider, no deployment.
 */

// Exactly 43 base64url characters, or the web app's env validation refuses it at startup.
const CANARY_CREDENTIAL = 'test-web-onboarding-canary-not-real-xxxxxxx';
const ACCESS = '__Host-mp_access=canary-access-token-value-not-a-real-token';
const REFRESH = '__Host-mp_refresh=canary-refresh-token-value-not-a-real-toke';
const SESSION = `${ACCESS}; ${REFRESH}`;
const USER_ID = '11111111-1111-4111-8111-111111111111';
const IDENTITY = { user: { id: USER_ID, displayName: 'Nadia' } };

const SELLER = {
  slug: 'good-shop',
  displayName: 'Good Shop',
  status: 'pending',
  verificationStatus: 'unverified',
  city: 'Cairo',
  countryCode: 'EG',
};

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

type SellerMode = 'seller' | 'not_a_seller' | 'unavailable';

function apiServes(mode: SellerMode = 'not_a_seller'): void {
  api.reply((request, response) => {
    const path = request.url.split('?')[0] ?? '';
    if (path === '/v1/users/me') return json(response, IDENTITY);
    if (path === '/v1/sellers/me') {
      if (request.method === 'POST') {
        // A creation the stub accepts, so the route can be exercised end to end over HTTP.
        response.writeHead(201, { 'content-type': 'application/json' });
        return response.end(JSON.stringify({ seller: SELLER }));
      }
      if (mode === 'not_a_seller') return problem(response, 404, 'NOT_FOUND');
      if (mode === 'unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      return json(response, { seller: { ...SELLER, status: 'active', verificationStatus: 'verified' } });
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

async function load(path: string, cookie: string | null = null): Promise<Page> {
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

/** The document's rendered words: scripts, styles and attributes removed, lower-cased for matching. */
function visibleText(html: string): string {
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/.exec(html)?.[1] ?? '';
  return main
    .replace(/<script\b[\s\S]*?<\/script>/g, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('the public entry page', () => {
  it('answers with no session at all', async () => {
    const page = await load('/become-a-seller');

    expect(page.status).toBe(200);
    expect(page.html).toContain('Become a seller');
  });

  it('answers under /ar, right to left', async () => {
    const page = await load('/ar/become-a-seller');

    expect(page.status).toBe(200);
    expect(page.html).toContain('<html lang="ar" dir="rtl">');
    expect(page.html).toContain('كن بائعًا');
    expect(page.html).toContain('أنشئ ملف البائع الخاص بك');
  });

  it('reads nothing of its own: the API is asked for nothing but the chrome', async () => {
    api.seen.length = 0;
    await load('/become-a-seller');
    await load('/ar/become-a-seller');

    // 0094 gives every public surface a composed header and footer, which is one read per page and the only one
    // this page performs. The page's own content is still entirely static.
    expect(api.seen.map((entry) => entry.url.split('?')[0])).toEqual(['/v1/navigation', '/v1/navigation']);
  });

  it('is the same page for a signed-in visitor as for a signed-out one', async () => {
    const signedOut = await load('/become-a-seller');
    const signedIn = await load('/become-a-seller', SESSION);

    expect(signedIn.status).toBe(200);
    // Byte for byte, once the per-request CSP nonce is normalised away. Nothing else on the page depends on
    // who is looking at it, so there is nothing on it to leak — and nothing that varies by session either.
    const withoutNonce = (html: string) =>
      html.replace(/nonce="[^"]*"/g, 'nonce="N"').replace(/\\"nonce\\":\\"[^\\]*\\"/g, '\\"nonce\\":\\"N\\"');
    expect(withoutNonce(signedIn.html)).toBe(withoutNonce(signedOut.html));
  });

  it('has exactly one h1', async () => {
    expect(countOf((await load('/become-a-seller')).html, /<h1[^>]*>/g)).toBe(1);
    expect(countOf((await load('/ar/become-a-seller')).html, /<h1[^>]*>/g)).toBe(1);
  });

  it('says the seller address is permanent before somebody starts', async () => {
    expect((await load('/become-a-seller')).html).toContain('This slug cannot be changed later.');
    expect((await load('/ar/become-a-seller')).html).toContain('لا يمكن تغيير هذا الاسم لاحقًا.');
  });

  it('offers one call to action, to the route that exists', async () => {
    const page = await load('/become-a-seller');

    expect(page.html).toContain('href="/dashboard/seller"');
    expect(countOf(page.html, /href="\/dashboard\/seller"/g)).toBe(1);
    expect(page.html).toContain('Create seller profile');
  });

  it('localises that call to action under /ar', async () => {
    const page = await load('/ar/become-a-seller');

    expect(page.html).toContain('href="/ar/dashboard/seller"');
    expect(page.html).toContain('إنشاء ملف البائع');
  });

  it('is a keyboard-reachable link with a visible focus ring, not a scripted control', async () => {
    const page = await load('/become-a-seller');

    expect(page.html).toMatch(/<a[^>]*href="\/dashboard\/seller"[^>]*>/);
    expect(page.html).toContain('focus-visible:outline');
    expect(page.html).not.toMatch(/<div[^>]*role="link"/);
  });

  it('links to no route that does not exist', async () => {
    const page = await load('/become-a-seller');

    for (const absent of [
      '/seller/register',
      '/register-seller',
      '/dashboard/seller/onboarding',
      '/dashboard/seller/listings',
      '/dashboard/seller/verification',
      '/pricing',
      '/fees',
    ]) {
      expect(page.html, absent).not.toContain(absent);
    }
  });

  it('makes no marketing claim and quotes no price', async () => {
    const page = await load('/become-a-seller');
    // The visible text only: a random per-request CSP nonce can contain any letters at all, so asserting
    // against the whole document would be asserting against base64 noise.
    const text = visibleText(page.html);

    for (const absent of ['free', 'commission', 'fee', '%', 'EGP', 'guarantee', 'millions', 'best']) {
      expect(text, absent).not.toContain(absent);
    }
    // And it does say the functional things it is supposed to.
    expect(text).toContain('Become a seller');
    expect(text).toContain('Create your seller profile');
  });

  it('follows the existing deny-by-default robots rule, which this increment did not change', async () => {
    // `isPublicCatalogRoute` names the catalogue surfaces only; an onboarding entry page is not one, so the
    // approved policy already answers noindex for it. The allowlist is untouched.
    expect((await load('/become-a-seller')).robotsHeader).toBe('noindex');
    expect((await load('/ar/become-a-seller')).robotsHeader).toBe('noindex');
    // And the catalogue's own exemption is exactly as it was.
    expect((await load('/listings')).robotsHeader).toBeNull();
    expect((await load('/categories')).robotsHeader).toBeNull();
  });

  it('never carries an identifier, a token or an API address', async () => {
    const page = await load('/become-a-seller', SESSION);

    expect(page.html).not.toContain(USER_ID);
    expect(page.html).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(page.html).not.toContain('canary-access-token');
    expect(page.html).not.toContain(CANARY_CREDENTIAL);
    expect(page.html).not.toContain(api.baseUrl);
    expect(page.html).not.toContain('/v1/');
  });
});

describe('the CTA leads each visitor to the right place', () => {
  it('signed out: into the existing login flow', async () => {
    const page = await load('/dashboard/seller');

    expect(page.status).toBe(307);
    expect(page.location).toContain('/login');
  });

  it('signed out under /ar: into the Arabic login flow', async () => {
    const page = await load('/ar/dashboard/seller');

    expect(page.status).toBe(307);
    expect(page.location).toContain('/ar/login');
  });

  it('signed out: with none of the form in the response', async () => {
    const page = await load('/dashboard/seller');

    for (const absent of ['Create your seller profile', 'Seller slug', 'name="slug"', 'Legal name']) {
      expect(page.html, absent).not.toContain(absent);
    }
  });

  it('signed in without a storefront: the onboarding form', async () => {
    const page = await load('/dashboard/seller', SESSION);

    expect(page.status).toBe(200);
    expect(page.html).toContain('Create your seller profile');
    // The 6-B sentence stays: it is what explains why a form is being shown.
    expect(page.html).toContain('You&#x27;re not a seller yet');
  });

  it('signed in with a storefront: their dashboard, and no creation control anywhere on it', async () => {
    apiServes('seller');
    const page = await load('/dashboard/seller', SESSION);

    expect(page.status).toBe(200);
    expect(page.html).toContain('Seller account');
    expect(page.html).toContain('>Active</dd>');
    // No second storefront is offered to somebody who has one.
    for (const absent of [
      'Create your seller profile',
      'Create seller profile',
      'name="slug"',
      'name="displayName"',
      '<form',
    ]) {
      expect(page.html, absent).not.toContain(absent);
    }
  });

  it('when the service cannot answer: an error, and still no form', async () => {
    apiServes('unavailable');
    const page = await load('/dashboard/seller', SESSION);

    expect(page.status).toBe(200);
    expect(page.html).toContain('Seller profile unavailable');
    // A failing read must not put somebody through onboarding they may not need.
    expect(page.html).not.toContain('Create your seller profile');
    expect(page.html).not.toContain('name="slug"');
  });
});

describe('the onboarding form as rendered', () => {
  it('collects exactly the ten approved fields', async () => {
    const page = await load('/dashboard/seller', SESSION);

    for (const field of [
      'slug',
      'displayName',
      'legalName',
      'bio',
      'contentLanguage',
      'countryCode',
      'governorate',
      'city',
      'contactEmail',
      'contactPhone',
    ]) {
      expect(page.html, field).toContain(`name="${field}"`);
    }
    // Ten form controls, and no eleventh: counted on the controls themselves, so the document's own
    // `<meta name=...>` tags are not mistaken for fields.
    const controls = page.html.match(/<(?:input|select|textarea)\b[^>]*\sname="([A-Za-z]+)"/g) ?? [];
    expect(controls).toHaveLength(10);
  });

  it('labels every one of them', async () => {
    const page = await load('/dashboard/seller', SESSION);

    for (const label of [
      'Seller slug',
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
    // Every field is associated with its label, not merely near it.
    expect(countOf(page.html, /<label for="seller-/g)).toBe(10);
  });

  it('warns, beside the slug field, that the address is permanent', async () => {
    const page = await load('/dashboard/seller', SESSION);

    expect(page.html).toContain('Your public seller address');
    expect(page.html).toContain('This slug cannot be changed later.');
    expect(page.html).toMatch(/aria-describedby="seller-slug-hint seller-slug-permanent"/);
  });

  it('offers no status, verification, role, moderation, payout or media control', async () => {
    const page = await load('/dashboard/seller', SESSION);

    for (const absent of [
      'name="status"',
      'name="verificationStatus"',
      'name="role"',
      'name="suspensionReason"',
      'name="verifiedAt"',
      'type="file"',
      'payout',
      'Payout',
      'IBAN',
      'Moderation',
      'Verification status',
    ]) {
      expect(page.html, absent).not.toContain(absent);
    }
  });

  it('carries no identifier, token, API address or private server field', async () => {
    const page = await load('/dashboard/seller', SESSION);

    expect(page.html).not.toContain(USER_ID);
    expect(page.html).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/);
    for (const absent of [
      'canary-access-token',
      'canary-refresh-token',
      CANARY_CREDENTIAL,
      api.baseUrl,
      '/v1/sellers',
      'userId',
      'suspensionReason',
      'logoObjectPath',
    ]) {
      expect(page.html, absent).not.toContain(absent);
    }
  });

  it('loads no provider client and opens no socket', async () => {
    const page = await load('/dashboard/seller', SESSION);

    for (const absent of ['supabase', 'createClient', 'ws://', 'wss://', 'EventSource', 'setInterval(']) {
      expect(page.html.toLowerCase(), absent).not.toContain(absent.toLowerCase());
    }
  });

  it('renders in Arabic, right to left, with one h1', async () => {
    const page = await load('/ar/dashboard/seller', SESSION);

    expect(page.status).toBe(200);
    expect(page.html).toContain('<html lang="ar" dir="rtl">');
    expect(page.html).toContain('أنشئ ملف البائع الخاص بك');
    expect(page.html).toContain('اسم البائع');
    expect(page.html).toContain('الاسم القانوني');
    expect(page.html).toContain('إنشاء ملف البائع');
    expect(countOf(page.html, /<h1[^>]*>/g)).toBe(1);
  });

  it('lays out with logical properties, so /ar mirrors without a second stylesheet', async () => {
    const page = await load('/ar/dashboard/seller', SESSION);
    expect(page.html).not.toMatch(/class="[^"]*\b(ml|mr|pl|pr)-\d/);
  });

  it('still has exactly one h1 in English, with the form below it', async () => {
    const page = await load('/dashboard/seller', SESSION);

    expect(countOf(page.html, /<h1[^>]*>/g)).toBe(1);
    expect(page.html).toContain('>Seller dashboard</h1>');
    // The form's own heading is a section heading, not a second page title.
    expect(page.html).toContain('id="seller-onboarding"');
  });

  it('is still noindex, like every other signed-in surface', async () => {
    expect((await load('/dashboard/seller', SESSION)).robotsHeader).toBe('noindex');
  });
});

describe('the BFF write on this origin', () => {
  it('refuses a cross-origin post', async () => {
    const response = await fetch(`${app.baseUrl}/api/sellers/me`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: SESSION, origin: 'https://evil.test', 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'good-shop', displayName: 'Good Shop', countryCode: 'EG' }),
    });

    expect(response.status).toBe(403);
  });

  it('refuses a post with no session', async () => {
    const response = await fetch(`${app.baseUrl}/api/sellers/me`, {
      method: 'POST',
      redirect: 'manual',
      headers: { origin: app.baseUrl, 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'good-shop', displayName: 'Good Shop', countryCode: 'EG' }),
    });

    expect(response.status).toBe(401);
  });

  it('creates through one internal hop and answers 201 with the stored storefront', async () => {
    api.seen.length = 0;
    const response = await fetch(`${app.baseUrl}/api/sellers/me`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: SESSION, origin: app.baseUrl, 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'good-shop', displayName: 'Good Shop', countryCode: 'EG' }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ seller: SELLER });

    const posts = api.seen.filter((call) => call.url === '/v1/sellers/me' && call.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.credential).toBe(CANARY_CREDENTIAL);
    expect(posts[0]?.cookie).toBeNull();
    expect(posts[0]?.body).not.toContain('canary-access-token');
  });

  it('refuses an injected status or owner before the API is asked', async () => {
    api.seen.length = 0;
    for (const injected of [{ status: 'active' }, { verificationStatus: 'verified' }, { userId: USER_ID }]) {
      const response = await fetch(`${app.baseUrl}/api/sellers/me`, {
        method: 'POST',
        redirect: 'manual',
        headers: { cookie: SESSION, origin: app.baseUrl, 'content-type': 'application/json' },
        body: JSON.stringify({
          slug: 'good-shop',
          displayName: 'Good Shop',
          countryCode: 'EG',
          ...injected,
        }),
      });
      expect(response.status, JSON.stringify(injected)).toBe(400);
    }
    expect(api.seen.filter((call) => call.method === 'POST')).toHaveLength(0);
  });
});

describe('the copy', () => {
  it('carries the same SellerOnboarding keys in English and Arabic', () => {
    expect(Object.keys(ar.SellerOnboarding).sort()).toEqual(Object.keys(en.SellerOnboarding).sort());
  });

  it('has a distinct, non-empty Arabic value for every English one', () => {
    for (const key of Object.keys(en.SellerOnboarding) as Array<keyof typeof en.SellerOnboarding>) {
      const english = en.SellerOnboarding[key];
      const arabic = (ar.SellerOnboarding as Record<string, string>)[key];
      expect(arabic, key).toBeTruthy();
      expect(arabic, key).not.toBe(english);
    }
  });

  it('is the approved functional baseline, word for word', () => {
    expect(en.SellerOnboarding.title).toBe('Become a seller');
    expect(en.SellerOnboarding.createProfile).toBe('Create your seller profile');
    expect(en.SellerOnboarding.slug).toBe('Seller slug');
    expect(en.SellerOnboarding.slugHint).toBe('Your public seller address');
    expect(en.SellerOnboarding.slugPermanent).toBe('This slug cannot be changed later.');
    expect(en.SellerOnboarding.displayName).toBe('Display name');
    expect(en.SellerOnboarding.legalName).toBe('Legal name');
    expect(en.SellerOnboarding.bio).toBe('Bio');
    expect(en.SellerOnboarding.language).toBe('Language');
    expect(en.SellerOnboarding.country).toBe('Country');
    expect(en.SellerOnboarding.governorate).toBe('Governorate');
    expect(en.SellerOnboarding.city).toBe('City');
    expect(en.SellerOnboarding.contactEmail).toBe('Contact email');
    expect(en.SellerOnboarding.contactPhone).toBe('Contact phone');
    expect(en.SellerOnboarding.submit).toBe('Create seller profile');
    expect(en.SellerOnboarding.submitting).toBe('Creating...');
    expect(en.SellerOnboarding.pending).toBe('Your seller profile is pending verification.');
    expect(en.SellerOnboarding.errorExists).toBe('Seller profile already exists');
    expect(en.SellerOnboarding.errorInvalid).toBe('Invalid seller information');
    expect(en.SellerOnboarding.errorUnavailable).toBe('Seller profile unavailable');
    expect(en.SellerOnboarding.retry).toBe('Try again');
  });

  it('and the Arabic baseline', () => {
    expect(ar.SellerOnboarding.title).toBe('كن بائعًا');
    expect(ar.SellerOnboarding.createProfile).toBe('أنشئ ملف البائع الخاص بك');
    expect(ar.SellerOnboarding.slug).toBe('اسم البائع');
    expect(ar.SellerOnboarding.slugHint).toBe('عنوان البائع العام');
    expect(ar.SellerOnboarding.slugPermanent).toBe('لا يمكن تغيير هذا الاسم لاحقًا.');
    expect(ar.SellerOnboarding.displayName).toBe('اسم العرض');
    expect(ar.SellerOnboarding.legalName).toBe('الاسم القانوني');
    expect(ar.SellerOnboarding.bio).toBe('النبذة');
    expect(ar.SellerOnboarding.language).toBe('اللغة');
    expect(ar.SellerOnboarding.country).toBe('الدولة');
    expect(ar.SellerOnboarding.governorate).toBe('المحافظة');
    expect(ar.SellerOnboarding.city).toBe('المدينة');
    expect(ar.SellerOnboarding.contactEmail).toBe('البريد الإلكتروني للتواصل');
    expect(ar.SellerOnboarding.contactPhone).toBe('هاتف التواصل');
    expect(ar.SellerOnboarding.submit).toBe('إنشاء ملف البائع');
    expect(ar.SellerOnboarding.submitting).toBe('جارٍ الإنشاء...');
    expect(ar.SellerOnboarding.pending).toBe('ملف البائع الخاص بك قيد انتظار التحقق.');
    expect(ar.SellerOnboarding.errorExists).toBe('ملف البائع موجود بالفعل');
    expect(ar.SellerOnboarding.errorInvalid).toBe('بيانات البائع غير صالحة');
    expect(ar.SellerOnboarding.errorUnavailable).toBe('تعذر تحميل ملف البائع');
    expect(ar.SellerOnboarding.retry).toBe('حاول مرة أخرى');
  });

  it('adds one line beyond the baseline: the taken-address refusal, in both locales', () => {
    // The API declares two distinct 409 codes. Folding them into one sentence would tell somebody who
    // already has a storefront that their address was taken, or the reverse.
    expect(en.SellerOnboarding.errorSlugTaken).toBe('That seller address is not available');
    expect(ar.SellerOnboarding.errorSlugTaken).toBe('عنوان البائع هذا غير متاح');
  });
});

describe('the surfaces around it are unchanged', () => {
  it('the public catalogue still answers with no session', async () => {
    for (const path of ['/listings', '/services', '/categories', '/marketplace']) {
      expect((await load(path)).status, path).toBe(200);
    }
  });

  it('the messaging surfaces still redirect a signed-out visitor', async () => {
    for (const path of ['/dashboard/messages', '/dashboard/settings']) {
      const page = await load(path);
      expect(page.status, path).toBe(307);
      expect(page.location, path).toContain('/login');
    }
  });

  it('no seller slug was reserved: /seller/become-a-seller is still an ordinary lookup', async () => {
    const page = await load('/seller/become-a-seller');

    expect(page.status).toBe(404);
    expect(page.html).not.toContain('Create your seller profile');
  });
});
