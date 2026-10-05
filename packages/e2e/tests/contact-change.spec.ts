import { expect, test, type Page, type Response } from '@playwright/test';
import { WEB_URL } from '../urls.js';

/**
 * The F4 settings screen, in a real browser — now a **protected** screen.
 *
 * This spec originally navigated straight to `/dashboard/settings` and exercised the phone-change form there: at
 * the time the smoke servers had no session and the page still rendered. Dashboard protection changed that, and
 * a signed-out navigation now gets a real `307` to the sign-in page. The four assertions about the form were
 * therefore describing a surface a signed-out browser can no longer reach, and they had gone unnoticed because
 * Playwright has never been runnable in the sandbox this repository is developed in.
 *
 * So what is asserted here is what a browser can actually establish without a session, and what it adds over
 * `apps/web/test/dashboard-protection.test.ts` (which already proves the status line and the empty body on the
 * wire): that the redirect is **followed to a page that renders and hydrates**, in both locales, and that
 * nothing is left behind in the browser on the way — no cookie, no storage, nothing about a challenge or a code
 * in the URL. The signed-in half of the form belongs to an environment with a live API, which this is not.
 */

function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`${message.text()} @ ${message.location().url}`);
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.name}`));
  return errors;
}

async function nonceFrom(response: Response | null): Promise<string> {
  expect(response).not.toBeNull();
  const csp = (await response!.allHeaders())['content-security-policy'] ?? '';
  const match = /'nonce-([A-Za-z0-9+/=_-]+)'/.exec(csp);
  expect(match, 'CSP header carries a nonce').not.toBeNull();
  return match![1]!;
}

async function expectEveryScriptToUse(page: Page, nonce: string): Promise<void> {
  const nonces = await page.$$eval('script', (elements) => elements.map((element) => (element as HTMLScriptElement).nonce));
  expect(nonces.length).toBeGreaterThan(0);
  for (const value of nonces) expect(value).toBe(nonce);
}

test.describe('the protected settings screen', () => {
  test('a signed-out visit lands on a sign-in page that renders and carries the nonce', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    const response = await page.goto(`${WEB_URL}/dashboard/settings`);

    // Playwright follows the 307, so this is the sign-in page's own response.
    expect(response?.status()).toBe(200);
    expect(new URL(page.url()).pathname).toBe('/login');
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    await expectEveryScriptToUse(page, await nonceFrom(response));
    await page.waitForLoadState('networkidle');
    expect(errors).toEqual([]);
  });

  test('the settings form is not reachable, in any part', async ({ page }) => {
    await page.goto(`${WEB_URL}/dashboard/settings`);

    // None of the phone-change surface exists on the page a signed-out visitor is given.
    await expect(page.getByRole('heading', { level: 2, name: 'Phone number' })).toHaveCount(0);
    await expect(page.getByLabel('New phone number')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Send code' })).toHaveCount(0);
    await expect(page.getByLabel('Six-digit code')).toHaveCount(0);
  });

  test('nothing is stored and nothing about a challenge reaches the URL', async ({ page, context }) => {
    await page.goto(`${WEB_URL}/dashboard/settings`);

    expect(await context.cookies()).toEqual([]);
    const stored = await page.evaluate(() => ({
      local: Object.keys(globalThis.localStorage).length,
      session: Object.keys(globalThis.sessionStorage).length,
    }));
    expect(stored).toEqual({ local: 0, session: 0 });

    // A challenge lives in an HttpOnly cookie the page cannot read, and never in a URL — so a redirect away
    // from a protected page cannot carry one either.
    expect(page.url()).not.toContain('challenge');
    expect(page.url()).not.toContain('otp');
  });

  test('is protected in Arabic too, and keeps the locale through the redirect', async ({ page }) => {
    const response = await page.goto(`${WEB_URL}/ar/dashboard/settings`);
    expect(response?.status()).toBe(200);
    expect(new URL(page.url()).pathname).toBe('/ar/login');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  });
});
