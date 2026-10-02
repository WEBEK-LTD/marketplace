import { expect, test, type Page, type Response } from '@playwright/test';
import { WEB_URL } from '../urls.js';

/**
 * The F3 recovery screens, in a real browser.
 *
 * The API address the smoke servers are given refuses connections, so a submission here exercises the
 * whole browser → BFF → (API down) path. What that proves is the part only a browser can show: the pages
 * hydrate, the forms behave, and a failed attempt leaves **nothing** behind — no cookie, no storage
 * entry, no token anywhere the browser can reach.
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

test.describe('password reset', () => {
  test('the first step renders, hydrates and carries the nonce on every script', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    const response = await page.goto(`${WEB_URL}/forgot-password`);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1, name: 'Reset your password' })).toBeVisible();
    await expect(page.getByLabel('Email or phone number')).toBeVisible();
    await expectEveryScriptToUse(page, await nonceFrom(response));
    await page.waitForLoadState('networkidle');
    expect(errors).toEqual([]);
  });

  test('asks for the field before it sends anything', async ({ page }) => {
    await page.goto(`${WEB_URL}/forgot-password`);
    await page.getByRole('button', { name: 'Send code' }).click();
    await expect(page.getByRole('status')).toHaveText('Fill in this field to continue.');
  });

  test('reports an unavailable service, and stores nothing, when the API is down', async ({ page, context }) => {
    await page.goto(`${WEB_URL}/forgot-password`);
    await page.getByLabel('Email or phone number').fill('person@example.test');
    await page.getByRole('button', { name: 'Send code' }).click();

    await expect(page.getByRole('status')).toHaveText('Password reset is temporarily unavailable. Please try again.');
    await expect(page).toHaveURL(`${WEB_URL}/forgot-password`);
    expect(await context.cookies()).toEqual([]);
    const stored = await page.evaluate(() => ({
      local: Object.keys(globalThis.localStorage).length,
      session: Object.keys(globalThis.sessionStorage).length,
    }));
    expect(stored).toEqual({ local: 0, session: 0 });
  });

  test('the code step keeps the challenge in the URL and no token anywhere', async ({ page, context }) => {
    await page.goto(`${WEB_URL}/forgot-password/verify?challenge=22222222-2222-4222-8222-222222222222`);
    await expect(page.getByRole('heading', { level: 1, name: 'Enter your code' })).toBeVisible();
    await page.getByLabel('Six-digit code').fill('123456');
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByRole('status')).toHaveText('Password reset is temporarily unavailable. Please try again.');
    expect(await context.cookies()).toEqual([]);
    expect(page.url()).not.toContain('token');
  });

  test('the password step cannot proceed without the reset cookie the browser cannot forge', async ({ page, context }) => {
    await page.goto(`${WEB_URL}/reset-password`);
    await expect(page.getByRole('heading', { level: 1, name: 'Choose a new password' })).toBeVisible();
    await page.getByLabel('New password').fill('correct horse battery staple');
    await page.getByRole('button', { name: 'Change password' }).click();

    // No __Host-mp_reset cookie exists, so the BFF refuses before the API is called, and the page shows
    // the one generic failure. Nothing is stored either way.
    await expect(page.getByRole('status')).toHaveText('Authentication failed.');
    expect(await context.cookies()).toEqual([]);
    const stored = await page.evaluate(() => ({
      local: Object.keys(globalThis.localStorage).length,
      session: Object.keys(globalThis.sessionStorage).length,
    }));
    expect(stored).toEqual({ local: 0, session: 0 });
  });

  test('is available in Arabic, right-to-left', async ({ page }) => {
    const response = await page.goto(`${WEB_URL}/ar/forgot-password`);
    expect(response?.status()).toBe(200);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('heading', { level: 1, name: 'إعادة تعيين كلمة المرور' })).toBeVisible();
  });
});
