import { expect, test, type Page, type Response } from '@playwright/test';
import { WEB_URL } from '../urls.js';

/**
 * The F4 settings screen, in a real browser.
 *
 * The smoke servers run with an API address that refuses connections and with no session cookie, so what
 * this exercises is the browser half: the page hydrates, the form validates, and a request made without
 * a session is refused by the BFF without anything being stored. A signed-in run belongs to a live
 * environment, which this one is not.
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

test.describe('phone contact change', () => {
  test('the settings page renders, hydrates and carries the nonce on every script', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    const response = await page.goto(`${WEB_URL}/dashboard/settings`);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Phone number' })).toBeVisible();
    await expect(page.getByLabel('New phone number')).toBeVisible();
    await expectEveryScriptToUse(page, await nonceFrom(response));
    await page.waitForLoadState('networkidle');
    expect(errors).toEqual([]);
  });

  test('asks for the number before it sends anything', async ({ page }) => {
    await page.goto(`${WEB_URL}/dashboard/settings`);
    await page.getByRole('button', { name: 'Send code' }).click();
    await expect(page.getByRole('status')).toHaveText('Fill in this field to continue.');
  });

  test('without a session the request is refused, and nothing is stored', async ({ page, context }) => {
    await page.goto(`${WEB_URL}/dashboard/settings`);
    await page.getByLabel('New phone number').fill('+201555000111');
    await page.getByRole('button', { name: 'Send code' }).click();

    // No __Host-mp_access cookie exists here, so the BFF refuses before the API is called.
    await expect(page.getByRole('status')).toHaveText('Please sign in again to change your phone number.');
    expect(await context.cookies()).toEqual([]);
    const stored = await page.evaluate(() => ({
      local: Object.keys(globalThis.localStorage).length,
      session: Object.keys(globalThis.sessionStorage).length,
    }));
    expect(stored).toEqual({ local: 0, session: 0 });
    // The code step is not reachable without a challenge.
    await expect(page.getByLabel('Six-digit code')).toHaveCount(0);
    // And nothing about a challenge is ever in the URL: it lives in an HttpOnly cookie the page cannot
    // read, so a browser that has one still cannot see it.
    expect(page.url()).not.toContain('challenge');
    expect(page.url()).not.toContain('otp');
  });

  test('is available in Arabic, right-to-left', async ({ page }) => {
    const response = await page.goto(`${WEB_URL}/ar/dashboard/settings`);
    expect(response?.status()).toBe(200);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('heading', { level: 1, name: 'الإعدادات' })).toBeVisible();
    await expect(page.getByLabel('رقم الهاتف الجديد')).toBeVisible();
  });
});
