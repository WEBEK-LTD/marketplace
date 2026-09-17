import { expect, test, type Page, type Response } from '@playwright/test';
import { ADMIN_URL, WEB_URL } from '../urls.js';

// Phase 1 smoke surface only (owner decision E6): English home, Arabic home with RTL, 404, CSP nonce,
// and no unexpected console errors. Admin has no public Arabic route (Arabic is resolved from profiles
// in Phase 3), so only its English surface is covered here.

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

/** The only acceptable console error on a 404 page is the browser's report of that 404 itself. */
function withoutExpected404(errors: string[], url: string): string[] {
  return errors.filter((error) => !(error.startsWith('Failed to load resource') && error.includes('404') && error.endsWith(`@ ${url}`)));
}

test.describe('web', () => {
  test('English home page, left-to-right, with a nonce on every script', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    const response = await page.goto(`${WEB_URL}/`);
    expect(response?.status()).toBe(200);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByRole('heading', { level: 1, name: 'Marketplace' })).toBeVisible();
    await expectEveryScriptToUse(page, await nonceFrom(response));
    await page.waitForLoadState('networkidle');
    expect(errors).toEqual([]);
  });

  test('Arabic home page, right-to-left', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    const response = await page.goto(`${WEB_URL}/ar`);
    expect(response?.status()).toBe(200);
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('heading', { level: 1, name: 'السوق' })).toBeVisible();
    await expectEveryScriptToUse(page, await nonceFrom(response));
    await page.waitForLoadState('networkidle');
    expect(errors).toEqual([]);
  });

  test('unknown paths render the 404 page', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    const url = `${WEB_URL}/nope`;
    const response = await page.goto(url);
    expect(response?.status()).toBe(404);
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    await expectEveryScriptToUse(page, await nonceFrom(response));
    await page.waitForLoadState('networkidle');
    expect(withoutExpected404(errors, url)).toEqual([]);
  });

  test('every navigation gets a new CSP nonce', async ({ page }) => {
    const first = await nonceFrom(await page.goto(`${WEB_URL}/`));
    const second = await nonceFrom(await page.goto(`${WEB_URL}/`));
    expect(second).not.toBe(first);
  });
});

test.describe('admin', () => {
  test('English home page with a nonce on every script', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    const response = await page.goto(`${ADMIN_URL}/`);
    expect(response?.status()).toBe(200);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByRole('heading', { level: 1, name: 'Admin' })).toBeVisible();
    await expectEveryScriptToUse(page, await nonceFrom(response));
    await page.waitForLoadState('networkidle');
    expect(errors).toEqual([]);
  });

  test('unknown paths render the 404 page', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    const url = `${ADMIN_URL}/nope`;
    const response = await page.goto(url);
    expect(response?.status()).toBe(404);
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    await expectEveryScriptToUse(page, await nonceFrom(response));
    await page.waitForLoadState('networkidle');
    expect(withoutExpected404(errors, url)).toEqual([]);
  });
});
