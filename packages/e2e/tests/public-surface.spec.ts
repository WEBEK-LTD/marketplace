import { expect, test, type APIResponse, type Page, type Response } from '@playwright/test';
import { ADMIN_URL, WEB_URL } from '../urls.js';

/**
 * The public surface, on whatever target this run points at (local servers or a Netlify deploy).
 *
 * **Every assertion here holds whether or not the API behind the target can be reached**, which is what makes
 * one suite usable before the API is hosted and after. So a catalogue page is "results *or* a named unavailable
 * region", never one or the other — and never an error page, a blank page or a stack trace. Pinning the
 * degraded state as the expected state would make the suite fail the moment the API appeared; pinning the
 * healthy state would make it unrunnable until then.
 *
 * What it is really for is the set of facts that are **only** knowable against a deployed runtime: that the
 * middleware runs there, that the security headers survive the platform's own response handling, that routing
 * and locale resolution work behind the platform's proxy, and that a failed upstream read degrades instead of
 * crashing. Every one of those has been a deployment defect in somebody's project.
 *
 * Two invariants are absolute rather than either/or, because getting them wrong is dangerous rather than
 * merely wrong: `robots.txt` must never answer `200` with a body that reads as permission, and the admin
 * console must never show console content to a signed-out visitor.
 */

/** Text that means the page did not render — as opposed to rendering an unavailable region, which is fine. */
const CRASH_MARKERS = [
  'Internal Server Error',
  'Application error',
  'ECONNREFUSED',
  'at Object.',
  'TypeError:',
  'Unhandled Runtime Error',
];

/** Every inventory variable name, plus the internal credential header. None may appear in a response body. */
const NEVER_IN_A_BODY = [
  'x-internal-credential',
  'INTERNAL_BFF_CREDENTIAL',
  'API_BASE_URL',
  'APP_SYSTEM_DATABASE_URL',
  'SUPABASE_SECRET_KEY',
  'ANALYTICS_SESSION_KEY',
  'DEVICE_IDENTITY_KEY',
  'PSEUDONYMOUS_USER_ID_KEY',
  'OTP_PEPPER',
  'WAABEK_API_KEY',
];

/**
 * Uncaught exceptions, which are never acceptable, kept separately from console errors, which on a deployed
 * target legitimately include the browser's own report of a resource that did not load.
 */
function collectFailures(page: Page): { pageErrors: string[]; consoleErrors: string[] } {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(`${error.name}: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    // A failed resource fetch is reported by the browser, not thrown by the page. On a target whose API is
    // unreachable this is expected; it is not evidence of a broken page.
    if (text.startsWith('Failed to load resource')) return;
    consoleErrors.push(`${text} @ ${message.location().url}`);
  });
  return { pageErrors, consoleErrors };
}

/**
 * Response headers, lower-cased, from either kind of response.
 *
 * A page navigation gives a `Response` and an API request gives an `APIResponse`; only the first has
 * `allHeaders()`, and the second's `headers()` is already lower-cased, so one helper covers both.
 */
async function headers(response: Response | APIResponse | null): Promise<Record<string, string>> {
  expect(response).not.toBeNull();
  const received = response!;
  return 'allHeaders' in received ? await received.allHeaders() : received.headers();
}

/** The per-response CSP nonce, which only exists if the middleware ran in this runtime. */
async function nonceFrom(response: Response | null): Promise<string> {
  const csp = (await headers(response))['content-security-policy'] ?? '';
  const match = /'nonce-([A-Za-z0-9+/=_-]+)'/.exec(csp);
  expect(match, 'the Content-Security-Policy carries a nonce').not.toBeNull();
  return match![1]!;
}

async function expectEveryScriptToUse(page: Page, nonce: string): Promise<void> {
  const nonces = await page.$$eval('script', (elements) =>
    elements.map((element) => (element as HTMLScriptElement).nonce),
  );
  expect(nonces.length).toBeGreaterThan(0);
  for (const value of nonces) expect(value).toBe(nonce);
}

/**
 * The referrer policy each surface sets. They differ on purpose: a console sends no referrer at all, because the
 * path of an admin page is itself information about what is being administered, while the public catalogue sends
 * its origin on a cross-site navigation like any public site. The console's is the stricter of the two.
 *
 * **Since 0108 the two surfaces share an origin**, which makes this the sharpest observable test that they are
 * still distinct: one deployment answering one request with `no-referrer` and the next with
 * `strict-origin-when-cross-origin`, chosen per path. A single site-wide value — or, worse, two values of the
 * same header on one response — is what this would catch.
 */
const REFERRER_POLICY = Object.freeze({ web: 'strict-origin-when-cross-origin', admin: 'no-referrer' });

/** The headers both surfaces set on every response, none of which depends on the API. */
async function expectSecurityHeaders(response: Response | null, app: 'web' | 'admin' = 'web'): Promise<void> {
  const received = await headers(response);
  expect(received['strict-transport-security']).toContain('max-age=');
  expect(received['x-content-type-options']).toBe('nosniff');
  // Exactly one value, not two. A `next.config.ts` entry scoped to the console path would be applied in addition
  // to the site-wide one, and Playwright joins repeated headers with a comma — so a comma here is the failure.
  expect(received['referrer-policy']).toBe(REFERRER_POLICY[app]);
  expect(received['permissions-policy']).toContain('camera=()');
  expect(received['cross-origin-opener-policy']).toBe('same-origin');

  const csp = received['content-security-policy'] ?? '';
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("object-src 'none'");
}

/** A page that rendered: its heading is there, nothing crashed, and no configuration leaked into the markup. */
async function expectRenderedPage(page: Page, response: Response | null, heading: string): Promise<void> {
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
  await expectSecurityHeaders(response);
  await expectEveryScriptToUse(page, await nonceFrom(response));

  const body = await page.content();
  for (const marker of CRASH_MARKERS) expect(body, marker).not.toContain(marker);
  for (const secret of NEVER_IN_A_BODY) expect(body, secret).not.toContain(secret);
}

/* ------------------------------------------------------------------------------------- public catalogue */

const CATALOGUE: ReadonlyArray<{ path: string; heading: string }> = [
  { path: '/listings', heading: 'Listings' },
  { path: '/marketplace', heading: 'Marketplace' },
  { path: '/search?q=chair', heading: 'Search' },
  { path: '/blog', heading: 'Blog' },
];

test.describe('the public catalogue', () => {
  for (const { path, heading } of CATALOGUE) {
    test(`${path} renders, with or without a reachable API`, async ({ page }) => {
      const failures = collectFailures(page);
      const response = await page.goto(`${WEB_URL}${path}`);
      await expectRenderedPage(page, response, heading);
      await page.waitForLoadState('networkidle');
      expect(failures.pageErrors).toEqual([]);
      expect(failures.consoleErrors).toEqual([]);
    });
  }

  /**
   * The degraded shape, asserted as "one of the two" rather than as either. A page that cannot read its data
   * must say so in words a visitor can act on; what it must never do is render nothing.
   */
  test('a catalogue page shows either results or a named unavailable region', async ({ page }) => {
    await page.goto(`${WEB_URL}/listings`);
    const items = await page.locator('main li').count();
    const unavailable = await page.getByText(/unavailable|couldn’t load|couldn't load/i).count();
    expect(items + unavailable).toBeGreaterThan(0);
  });

  test('Arabic catalogue routes resolve and render right-to-left', async ({ page }) => {
    const response = await page.goto(`${WEB_URL}/ar/listings`);
    expect(response?.status()).toBe(200);
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expectSecurityHeaders(response);
  });

  /** A CMS page that could not be read must not be indexable as the page it was meant to be. */
  test('a CMS page is either the authored page or a noindex unavailable page', async ({ page }) => {
    const response = await page.goto(`${WEB_URL}/about`);
    expect(response?.status()).toBe(200);
    await expectSecurityHeaders(response);

    const robots = await page.locator('meta[name="robots"]').getAttribute('content');
    const title = await page.title();
    if (title === 'Page unavailable') {
      expect(robots).toContain('noindex');
    } else {
      expect(await page.locator('h1').count()).toBeGreaterThan(0);
    }
  });

  test('every navigation gets its own nonce, so the middleware is not serving a cached header', async ({
    page,
  }) => {
    const first = await nonceFrom(await page.goto(`${WEB_URL}/listings`));
    const second = await nonceFrom(await page.goto(`${WEB_URL}/listings`));
    expect(second).not.toBe(first);
  });
});

/* ------------------------------------------------------------------------------- robots and the sitemap */

test.describe('the crawl documents', () => {
  /**
   * The one genuinely dangerous outcome, and the reason this is an absolute rather than an either/or: an empty
   * `robots.txt` means "no restrictions", so a failed read must not quietly open whatever an administrator
   * disallowed. Either the authored directives are served, or nothing is — never a permissive blank.
   */
  test('robots.txt serves directives or fails closed, never a permissive empty 200', async ({ request }) => {
    const response = await request.get(`${WEB_URL}/robots.txt`);
    expect([200, 503]).toContain(response.status());

    const body = await response.text();
    if (response.status() === 200) {
      expect(body).toMatch(/^\s*User-agent:/im);
      expect(body.trim()).not.toBe('');
    } else {
      expect(body).not.toMatch(/User-agent:/i);
      expect(body).not.toMatch(/Allow:/i);
    }
    expect((await headers(response))['content-type']).toContain('text/plain');
  });

  test('sitemap.xml serves a sitemap or fails closed, never a 200 that is not XML', async ({ request }) => {
    const response = await request.get(`${WEB_URL}/sitemap.xml`);
    expect([200, 503]).toContain(response.status());
    if (response.status() === 200) {
      const body = await response.text();
      expect(body).toMatch(/<(urlset|sitemapindex)\b/);
      expect((await headers(response))['content-type']).toContain('xml');
    }
  });

  test('neither document is cached, so an authored change needs no deployment', async ({ request }) => {
    for (const path of ['/robots.txt', '/sitemap.xml']) {
      const received = await headers(await request.get(`${WEB_URL}${path}`));
      expect(received['cache-control'], path).toContain('no-store');
    }
  });
});

/* ------------------------------------------------------------------------------------ not-found handling */

test.describe('unknown paths', () => {
  test('the web site answers 404 with its own page and refuses indexing', async ({ page }) => {
    const response = await page.goto(`${WEB_URL}/nope-not-a-route`);
    expect(response?.status()).toBe(404);
    expect((await headers(response))['x-robots-tag']).toContain('noindex');
    await expectSecurityHeaders(response);
  });

  test('the admin console answers 404 with its own page', async ({ page }) => {
    const response = await page.goto(`${ADMIN_URL}/nope-not-a-route`);
    expect(response?.status()).toBe(404);
    expect((await headers(response))['x-robots-tag']).toContain('noindex');
    await expectSecurityHeaders(response, 'admin');
  });
});

/* ------------------------------------------------------------------------------------- the admin console */

/**
 * Console routes a signed-out visitor must never see the contents of, relative to the console's own base.
 *
 * The console's root is the empty string rather than `/`: `ADMIN_URL` already ends at `/admin`, and appending a
 * slash would address `/admin/`, which Next.js answers with a 308 to `/admin` — a redirect this suite has no
 * reason to be testing.
 */
const CONSOLE_ROUTES = ['', '/login', '/users', '/catalog'];

test.describe('the admin console', () => {
  for (const path of CONSOLE_ROUTES) {
    test(`${path} shows the signed-out surface and nothing of the console`, async ({ page }) => {
      const failures = collectFailures(page);
      const response = await page.goto(`${ADMIN_URL}${path}`);
      expect(response?.status()).toBe(200);

      // Whatever the API can or cannot do, a signed-out visitor sees the sign-in surface.
      await expect(page.getByText(/signed out|Sign in/i).first()).toBeVisible();

      const body = await page.content();
      for (const marker of CRASH_MARKERS) expect(body, marker).not.toContain(marker);
      for (const secret of NEVER_IN_A_BODY) expect(body, secret).not.toContain(secret);

      expect(failures.pageErrors).toEqual([]);
    });
  }

  /** The console is never indexed: the header is on every response, not only on the pages that remember. */
  test('every response refuses indexing', async ({ request }) => {
    for (const path of [...CONSOLE_ROUTES, '/nope-not-a-route']) {
      const response = await request.get(`${ADMIN_URL}${path}`);
      expect((await headers(response))['x-robots-tag'], path).toContain('noindex');
    }
  });

  test('publishes no crawl documents of its own', async ({ request }) => {
    for (const path of ['/robots.txt', '/sitemap.xml']) {
      const response = await request.get(`${ADMIN_URL}${path}`);
      expect(response.status(), path).not.toBe(200);
    }
  });

  test('sets the same security headers as the public site, and a stricter referrer policy', async ({ page }) => {
    const response = await page.goto(ADMIN_URL);
    await expectSecurityHeaders(response, 'admin');
    // Not merely different: the console sends no referrer at all, where the public site sends its origin.
    expect((await headers(response))['referrer-policy']).toBe('no-referrer');
  });

  /**
   * The two surfaces share an origin and nothing else (0108).
   *
   * This is the assertion that the merge did not blur them. It is observable from outside — no header, no
   * internal constant, just what each address actually renders — which is the only kind of evidence that
   * settles it for a deployment.
   */
  test('the console and the marketplace render different documents at the same origin', async ({ page }) => {
    await page.goto(ADMIN_URL);
    const consoleBody = await page.content();

    await page.goto(`${WEB_URL}/`);
    const marketplaceBody = await page.content();

    // The marketplace carries the composed site navigation; the console must not, whatever else it carries.
    await page.goto(ADMIN_URL);
    await expect(page.getByRole('contentinfo')).toHaveCount(0);

    // And they are not the same page served twice.
    expect(consoleBody).not.toBe(marketplaceBody);
  });

  /** The marketplace sign-in and the staff sign-in are different pages at different addresses. */
  test('the staff sign-in is not the buyer sign-in', async ({ page }) => {
    const staff = await page.goto(`${ADMIN_URL}/login`);
    expect(staff?.status()).toBe(200);
    expect((await headers(staff))['referrer-policy']).toBe('no-referrer');

    const buyer = await page.goto(`${WEB_URL}/login`);
    expect(buyer?.status()).toBe(200);
    expect((await headers(buyer))['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });
});
