import { expect, test, type Page, type Response } from '@playwright/test';
import { ADMIN_URL, WEB_URL } from '../urls.js';

/**
 * The F2 sign-in screens, in a real browser.
 *
 * The HTTP tests in each app already prove the route contract; what only a browser can show is that the
 * page hydrates and that a submitted form behaves. The smoke servers are started with an API address
 * that refuses connections, so a submission here exercises the whole browser → BFF → (API down) path
 * and must end in the approved "temporarily unavailable" sentence — never a token, never a session and
 * never a hint about the account.
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

test.describe('web sign-in', () => {
  test('renders, hydrates and carries the nonce on every script', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    const response = await page.goto(`${WEB_URL}/login`);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    await expect(page.getByLabel('Email or phone number')).toBeVisible();
    await expect(page.getByLabel('Password')).toBeVisible();
    await expectEveryScriptToUse(page, await nonceFrom(response));
    await page.waitForLoadState('networkidle');
    expect(errors).toEqual([]);
  });

  test('asks for both fields before it sends anything', async ({ page }) => {
    await page.goto(`${WEB_URL}/login`);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('status')).toHaveText('Enter your email or phone number and your password.');
  });

  test('reports an unavailable service, with no session and no token, when the API is down', async ({ page, context }) => {
    await page.goto(`${WEB_URL}/login`);
    await page.getByLabel('Email or phone number').fill('person@example.test');
    await page.getByLabel('Password').fill('correct horse battery staple');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByRole('status')).toHaveText('Sign-in is temporarily unavailable. Please try again.');
    // Still on the sign-in screen, with nothing stored anywhere a browser can reach.
    await expect(page).toHaveURL(`${WEB_URL}/login`);
    expect(await context.cookies()).toEqual([]);
    const stored = await page.evaluate(() => ({
      local: Object.keys(globalThis.localStorage).length,
      session: Object.keys(globalThis.sessionStorage).length,
    }));
    expect(stored).toEqual({ local: 0, session: 0 });
  });

  test('is available in Arabic, right-to-left', async ({ page }) => {
    const response = await page.goto(`${WEB_URL}/ar/login`);
    expect(response?.status()).toBe(200);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('heading', { level: 1, name: 'تسجيل الدخول' })).toBeVisible();
  });
});

test.describe('admin sign-in', () => {
  test('renders and hydrates on the console surface', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    const response = await page.goto(`${ADMIN_URL}/login`);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    await expectEveryScriptToUse(page, await nonceFrom(response));
    await page.waitForLoadState('networkidle');
    expect(errors).toEqual([]);
  });
});
