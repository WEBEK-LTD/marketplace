import type { ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startBuiltApp, type RunningApp } from './support/next-server.js';
import { startStubApi, type StubApi } from './support/stub-api.js';

/**
 * The public seller profile, over real HTTP against the built app (Phase 4-E).
 *
 * Two things are being held to account. The statuses, which must be decided before the response commits —
 * Next.js 16 streams, so a `notFound()` in the page would render the right body under a 200, the soft-404
 * already fixed for listings. And the split between a *suspended* seller, who has a 200 page that says
 * "unavailable", and a *pending or closed* one, who is a 404 indistinguishable from a stranger.
 *
 * No browser, no Playwright, no live provider, no deployment.
 */

const CANARY_CREDENTIAL = 'test-web-seller-canary-credential-not-realx';

const SELLER = {
  slug: 'good-shop',
  displayName: 'Good Shop',
  bio: 'We restore mid-century furniture.',
  contentLanguage: 'en',
  city: 'Cairo',
} as const;

const ARABIC_SELLER = {
  slug: 'arabic-shop',
  displayName: 'متجر جيد',
  bio: 'نصنع الأثاث يدويًا.',
  contentLanguage: 'ar',
  city: 'الإسكندرية',
} as const;

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

function notFound(response: ServerResponse): void {
  response.writeHead(404, { 'content-type': 'application/problem+json' });
  response.end(JSON.stringify({ status: 404, code: 'NOT_FOUND' }));
}

/**
 * The API as it really behaves: an active seller, a suspended one, a bare one, and everything else — a
 * pending seller, a closed seller and a stranger — refused identically.
 */
function apiServesSellers(): void {
  api.reply((request, response) => {
    const [path] = request.url.split('?');
    if (path === '/v1/sellers/good-shop') return json(response, { seller: SELLER, availability: 'available' });
    if (path === '/v1/sellers/arabic-shop') {
      return json(response, { seller: ARABIC_SELLER, availability: 'available' });
    }
    if (path === '/v1/sellers/gone-shop') {
      return json(response, {
        seller: { ...SELLER, slug: 'gone-shop', displayName: 'Gone Shop' },
        availability: 'unavailable',
      });
    }
    if (path === '/v1/sellers/bare-shop') {
      return json(response, {
        seller: { slug: 'bare-shop', displayName: 'Bare Shop', bio: null, contentLanguage: null, city: null },
        availability: 'available',
      });
    }
    return notFound(response);
  });
}

beforeEach(() => {
  api.seen.length = 0;
  apiServesSellers();
});

interface Page {
  readonly status: number;
  readonly robotsHeader: string | null;
  readonly robotsMeta: string | null;
  readonly title: string | null;
  readonly description: string | null;
  readonly canonical: string | null;
  readonly alternates: readonly string[];
  readonly html: string;
}

async function load(path: string): Promise<Page> {
  const response = await fetch(`${app.baseUrl}${path}`, { redirect: 'manual' });
  const html = await response.text();
  const pick = (re: RegExp): string | null => re.exec(html)?.[1] ?? null;
  return {
    status: response.status,
    robotsHeader: response.headers.get('x-robots-tag'),
    robotsMeta: pick(/<meta name="robots" content="([^"]*)"\/?>/),
    title: pick(/<title>([^<]*)<\/title>/),
    description: pick(/<meta name="description" content="([^"]*)"\/?>/),
    canonical: pick(/<link rel="canonical" href="([^"]*)"\/?>/),
    alternates: [...html.matchAll(/<link rel="alternate" hrefLang="([^"]*)" href="([^"]*)"\/?>/g)].map(
      (m) => `${m[1]}=${m[2]}`,
    ),
    html,
  };
}

describe('an active seller', () => {
  it('answers 200 and renders the name, bio and city', async () => {
    const page = await load('/seller/good-shop');
    expect(page.status).toBe(200);
    expect(page.html).toContain('Good Shop');
    expect(page.html).toContain('We restore mid-century furniture.');
    expect(page.html).toContain('Cairo');
  });

  it('is indexable, with a self-referencing canonical and both hreflang alternates', async () => {
    const page = await load('/seller/good-shop');
    expect(page.robotsHeader).toBeNull();
    expect(page.robotsMeta ?? '').not.toContain('noindex');
    expect(page.title).toBe('Good Shop');
    expect(page.description).toBe('We restore mid-century furniture.');
    expect(page.canonical).toBe('/seller/good-shop');
    expect(page.alternates).toEqual(['en=/seller/good-shop', 'ar=/ar/seller/good-shop']);
  });

  it('renders under /ar right-to-left, with its own canonical', async () => {
    const page = await load('/ar/seller/good-shop');
    expect(page.status).toBe(200);
    expect(page.html).toContain('<html lang="ar" dir="rtl">');
    expect(page.canonical).toBe('/ar/seller/good-shop');
  });

  it('marks a bio with the language it was written in, not the page language', async () => {
    const page = await load('/seller/arabic-shop');
    expect(page.status).toBe(200);
    expect(page.html).toContain('<html lang="en" dir="ltr">');
    expect(page.html).toContain('lang="ar"');
    expect(page.html).toContain('نصنع الأثاث يدويًا.');
  });
});

describe('a seller with nothing optional filled in', () => {
  it('is still a 200 and says there is no description', async () => {
    const page = await load('/seller/bare-shop');
    expect(page.status).toBe(200);
    expect(page.html).toContain('Bare Shop');
    expect(page.html).toContain('No seller description is available.');
    expect(page.description).toBe('No seller description is available.');
  });

  it('says it in Arabic too', async () => {
    const page = await load('/ar/seller/bare-shop');
    expect(page.status).toBe(200);
    expect(page.html).toContain('لا يتوفر وصف لهذا البائع.');
  });
});

describe('a suspended seller', () => {
  it('answers 200 with the unavailable marker, still naming the seller', async () => {
    const page = await load('/seller/gone-shop');
    expect(page.status).toBe(200);
    expect(page.html).toContain('Gone Shop');
    expect(page.html).toContain('This seller is currently unavailable.');
  });

  it('is noindex, follow', async () => {
    const page = await load('/seller/gone-shop');
    expect(page.robotsHeader).toBeNull();
    expect(page.robotsMeta).toBe('noindex, follow');
  });

  it('says it in Arabic, and never gives the suspension reason', async () => {
    const page = await load('/ar/seller/gone-shop');
    expect(page.status).toBe(200);
    expect(page.html).toContain('هذا البائع غير متاح حاليًا.');
    // The words that would give the reason away, and the field names it could arrive in. The bare word
    // `reason` used to stand in for all of them, which worked while nothing on this page had another use for
    // it; 7-M's report form asks a reporter to choose a *report* reason from the platform's own vocabulary,
    // so the proxy now fires on copy that discloses nothing. These name the leak instead of a word near it.
    for (const leak of [
      'suspend',
      'policy',
      'breach',
      'suspensionreason',
      'moderationreason',
      'suspendedat',
      'internalstatus',
      'moderation',
    ]) {
      expect(page.html.toLowerCase(), leak).not.toContain(leak);
    }
  });
});

describe('a seller the public may not see', () => {
  it('is a real 404 for pending, closed and unknown alike', async () => {
    for (const slug of ['waiting-shop', 'left-shop', 'no-such-shop']) {
      const page = await load(`/seller/${slug}`);
      expect(page.status, slug).toBe(404);
    }
  });

  it('is a real 404 in Arabic too, with the localized view', async () => {
    const page = await load('/ar/seller/waiting-shop');
    expect(page.status).toBe(404);
    expect(page.html).toContain('<html lang="ar" dir="rtl">');
    expect(page.html).toContain('البائع غير موجود');
  });

  it('is noindex, and tells a caller nothing about the seller state', async () => {
    const page = await load('/seller/waiting-shop');
    expect(page.robotsMeta ?? '').toContain('noindex');
    for (const leak of ['pending', 'closed', 'suspended', 'approval', 'Good Shop']) {
      expect(page.html, leak).not.toContain(leak);
    }
  });

  it('answers identically whether the seller is pending, closed or a stranger', async () => {
    // Byte-comparing the whole document would compare the CSP nonce and the requested path, which differ
    // for every request and tell a caller nothing. What must be identical is everything a visitor or a
    // crawler can actually distinguish: the status, the robots directive, the title and the visible text.
    const answers = await Promise.all(
      ['waiting-shop', 'left-shop', 'no-such-shop'].map(async (slug) => {
        const page = await load(`/seller/${slug}`);
        const visible = /<main[^>]*>([\s\S]*?)<\/main>/.exec(page.html)?.[1] ?? '';
        return JSON.stringify({
          status: page.status,
          robots: page.robotsMeta,
          title: page.title,
          visible: visible.replaceAll(slug, 'SLUG'),
        });
      }),
    );
    expect(new Set(answers).size).toBe(1);
  });

  it('asks its own reader exactly once, and consults the redirect map once', async () => {
    api.seen.length = 0;
    await load('/seller/waiting-shop');
    // Still one read of this surface: the page does not read again behind the middleware's decision.
    expect(api.seen.map((s) => s.url).filter((url) => url.startsWith('/v1/sellers/'))).toEqual([
      '/v1/sellers/waiting-shop',
    ]);
    // And exactly one more call, which is 8-E's redirect map being consulted — a path that would answer 404 is
    // precisely when it may be, and the answer here leaves the 404 alone.
    expect(
      api.seen.map((s) => s.url).filter((url) => url.startsWith('/v1/seo/redirects/resolve')),
    ).toHaveLength(1);
    // And nothing else of this page's own: 0094's composed chrome is one further read on every public surface,
    // which is counted out here rather than left to make this inventory look open.
    expect(api.seen.filter((entry) => !entry.url.startsWith('/v1/navigation'))).toHaveLength(2);
  });
});

describe('the robots policy covers the seller surface', () => {
  it('/seller/[slug] is not globally noindex', async () => {
    for (const path of ['/seller/good-shop', '/ar/seller/good-shop', '/seller/bare-shop']) {
      const page = await load(path);
      expect(page.robotsHeader, path).toBeNull();
      expect(page.robotsMeta ?? '', path).not.toContain('noindex');
    }
  });

  it('a lookalike or traversal path cannot claim the seller exemption', async () => {
    for (const path of [
      '/sellerfoo',
      '/sellers',
      '/seller/good-shop/edit',
      '/seller/Good-Shop',
      '/seller/..%2Fdashboard',
    ]) {
      const page = await load(path);
      expect(page.robotsHeader, path).toBe('noindex');
      expect(page.html, path).not.toContain('We restore mid-century furniture.');
    }
  });
});

describe('the contact action (Phase 5-E)', () => {
  it('offers to message a seller who is trading', async () => {
    const page = await load('/seller/good-shop');
    expect(page.html).toContain('Message seller');
  });

  it('offers nothing to message on a suspended profile, which cannot be contacted', async () => {
    const page = await load('/seller/gone-shop');
    expect(page.html).not.toContain('Message seller');
  });

  it('carries the action in Arabic on the Arabic profile', async () => {
    const page = await load('/ar/seller/arabic-shop');
    expect(page.html).toContain('مراسلة البائع');
  });

  it('still exposes no seller identifier: the action travels by slug', async () => {
    const page = await load('/seller/good-shop');
    // The five public fields and nothing else. A uuid anywhere here would be the identifier 4-E excluded.
    expect(page.html).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });
});

describe('the block action (0103)', () => {
  it('offers to block a seller who is trading', async () => {
    const page = await load('/seller/good-shop');
    expect(page.html).toContain('>Block</button>');
  });

  /**
   * Not on a suspended profile, for the same reason the contact action is not: 0103's resolver requires a
   * publicly visible storefront, so the button there would be one that always refuses.
   */
  it('offers nothing to block on a suspended profile', async () => {
    const page = await load('/seller/gone-shop');
    expect(page.html).not.toContain('>Block</button>');
  });

  it('carries the action in Arabic on the Arabic profile', async () => {
    const page = await load('/ar/seller/arabic-shop');
    expect(page.html).toContain('حجب');
  });

  /** The handle is the slug already in the URL. There is no identifier for it to carry. */
  it('still exposes no seller identifier', async () => {
    const page = await load('/seller/good-shop');
    expect(page.html).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(page.html).toContain('good-shop');
  });

  /**
   * This is a cached public catalogue page, so it reads no session to decide whether to draw the control.
   * A visitor who turns out not to be signed in is offered the way in by the BFF's answer instead — which
   * is why the sign-out wording is not in the markup and no session cookie was presented upstream.
   */
  it('decides nothing from a session, so the page stays the same for everybody', async () => {
    api.seen.length = 0;
    const page = await load('/seller/good-shop');
    expect(page.html).not.toContain('>Yes, block</button>');
    for (const seen of api.seen) {
      expect(seen.cookie).toBeNull();
    }
  });

  it('does not filter the seller out of anything, and says nothing about blocking anywhere else', async () => {
    const page = await load('/seller/good-shop');
    for (const absent of ['blocked you', 'has blocked', 'blockedUserId', 'Unblock']) {
      expect(page.html, absent).not.toContain(absent);
    }
  });
});

describe('the page carries nothing it was told not to', () => {
  it('has no listing, service, rating or contact details', async () => {
    const page = await load('/seller/good-shop');
    for (const absent of [
      'EGP',
      'Contact for price',
      'Show more',
      'Reviews',
      'rating',
      'Verified',
      'listingCount',
      'good@',
      '+2010',
    ]) {
      expect(page.html, absent).not.toContain(absent);
    }
  });

  it('never exposes the internal credential to the browser', async () => {
    const page = await load('/seller/good-shop');
    expect(page.html).not.toContain(CANARY_CREDENTIAL);
  });

  it('reaches the API with the internal credential and no browser cookie', async () => {
    api.seen.length = 0;
    await load('/seller/good-shop');
    const first = api.seen[0];
    expect(first?.url).toBe('/v1/sellers/good-shop');
    expect(first?.credential).toBe(CANARY_CREDENTIAL);
    expect(first?.cookie).toBeNull();
  });
});

/**
 * The authenticated seller identity route (Phase 6-A).
 *
 * `bff-seller-identity.test.ts` proves the handler contract; this proves the wiring against the built app:
 * the route exists where the browser asks, the middleware leaves it alone, `/api/sellers/me` is not
 * shadowed by `/api/sellers/[slug]` and does not shadow it, and no session means no answer.
 */
const SESSION =
  '__Host-mp_access=seller-canary-access-token-not-a-real-token; ' +
  '__Host-mp_refresh=seller-canary-refresh-token-not-a-real-toke';

describe('GET /api/sellers/me', () => {
  function apiServesIdentity(outcome: { status: number; body: unknown }): void {
    api.reply((request, response) => {
      const [path] = request.url.split('?');
      if (path === '/v1/sellers/me') {
        response.writeHead(outcome.status, {
          'content-type': outcome.status >= 400 ? 'application/problem+json' : 'application/json',
        });
        return void response.end(JSON.stringify(outcome.body));
      }
      if (path === '/v1/sellers/good-shop') {
        return json(response, { seller: SELLER, availability: 'available' });
      }
      notFound(response);
    });
  }

  const identity = {
    slug: 'good-shop',
    displayName: 'Good Shop',
    status: 'active',
    verificationStatus: 'verified',
    city: 'Cairo',
    countryCode: 'EG',
  };

  it('answers the caller’s own seller identity with a session', async () => {
    apiServesIdentity({ status: 200, body: { seller: identity } });
    const response = await fetch(`${app.baseUrl}/api/sellers/me`, {
      redirect: 'manual',
      headers: { cookie: SESSION },
    });
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ seller: identity });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(text).not.toContain('canary-access-token');
    expect(text).not.toContain(CANARY_CREDENTIAL);
    expect(text).not.toContain('/v1/');
  });

  it('refuses with 401 and no session, without a redirect', async () => {
    apiServesIdentity({ status: 200, body: { seller: identity } });
    const response = await fetch(`${app.baseUrl}/api/sellers/me`, { redirect: 'manual' });

    // 401 rather than 404: the route ran and found no session cookie. And rather than a 307 — a BFF route
    // is not a protected page.
    expect(response.status).toBe(401);
    expect(response.headers.get('location')).toBeNull();
  });

  it('passes the API’s 404 through for an account that is not a seller', async () => {
    apiServesIdentity({
      status: 404,
      body: { type: 'about:blank', title: 'Not Found', status: 404, code: 'NOT_FOUND', detail: 'x' },
    });
    const response = await fetch(`${app.baseUrl}/api/sellers/me`, {
      redirect: 'manual',
      headers: { cookie: SESSION },
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(404);
    expect(body['code']).toBe('NOT_FOUND');
    expect(body['seller']).toBeUndefined();
  });

  it('is not rewritten into a locale path and needs no proxy change', async () => {
    apiServesIdentity({ status: 200, body: { seller: identity } });
    const response = await fetch(`${app.baseUrl}/api/sellers/me`, {
      redirect: 'manual',
      headers: { cookie: SESSION },
    });
    expect(response.status).not.toBe(404);
    expect(response.headers.get('x-robots-tag')).toBe('noindex');
  });

  it('does not shadow the public slug route, and is not shadowed by it', async () => {
    apiServesIdentity({ status: 200, body: { seller: identity } });
    api.seen.length = 0;

    const mine = await fetch(`${app.baseUrl}/api/sellers/me`, {
      redirect: 'manual',
      headers: { cookie: SESSION },
    });
    const theirs = await fetch(`${app.baseUrl}/api/sellers/good-shop`, { redirect: 'manual' });

    expect(mine.status).toBe(200);
    expect(theirs.status).toBe(200);
    expect(api.seen.map((call) => call.url)).toEqual(['/v1/sellers/me', '/v1/sellers/good-shop']);
    // The public read still carries no session, exactly as 4-E built it.
    expect(api.seen[1]?.cookie).toBeNull();
  });

  // Narrowed in 6-C (which added `POST`) and again in 6-D (which added `PATCH`). What still holds in full is
  // the half that matters for the increments after it: nothing replaces a storefront wholesale and nothing
  // deletes one, so neither can arrive by accident.
  it('offers no wholesale replace or delete on that path', async () => {
    apiServesIdentity({ status: 200, body: { seller: identity } });
    for (const method of ['PUT', 'DELETE'] as const) {
      const response = await fetch(`${app.baseUrl}/api/sellers/me`, {
        method,
        redirect: 'manual',
        headers: { cookie: SESSION, origin: app.baseUrl, 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: 'Renamed' }),
      });
      expect(response.status, method).toBe(405);
    }
  });

  it('and the one write it does offer refuses a body that is not a creation', async () => {
    apiServesIdentity({ status: 200, body: { seller: identity } });
    const response = await fetch(`${app.baseUrl}/api/sellers/me`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: SESSION, origin: app.baseUrl, 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Renamed' }),
    });

    // The 6-C route exists, and a rename is not what it does: no slug, no country, so the strict contract
    // refuses it here without the API ever being asked.
    expect(response.status).toBe(400);
  });
});
