import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import enMessages from '../messages/en.json';
import arMessages from '../messages/ar.json';
import { REGISTER_CHALLENGE_COOKIE } from '../src/server/bff/register-challenge-cookie';
import { startBuiltApp, type RunningApp } from './support/next-server.js';
import { startStubApi, type StubApi } from './support/stub-api.js';

/**
 * The registration surfaces, over real HTTP against the built app (Phase 7-A).
 *
 * Run against the built app rather than a unit harness for the reason the protection tests are: what
 * matters is what actually reaches a browser, including the streamed RSC payload. A page that merely hides
 * something still ships it.
 *
 * The heaviest assertions are about absence:
 *
 *   * **nothing anywhere says an address is already registered** — no such copy exists in either
 *     catalogue, so there is no string a page could render even if some future branch tried to;
 *   * **the verification page ships no form at all without a challenge**, so a visitor who arrives cold
 *     gets a way back rather than a code box, and the form is not in the flight data either;
 *   * no internal credential, no `/v1/...` address, no session cookie and no token in anything a browser
 *     receives from these pages;
 *   * both pages are `noindex`, like every other authentication surface here.
 *
 * No browser, no Playwright, no live provider, no deployment.
 */

// Exactly 43 base64url characters: the web app's env validation refuses any other length at startup,
// which surfaces as a 500 on every page rather than as a configuration error.
const CANARY_CREDENTIAL = 'test-web-register-canary-credential-notreal';
const CHALLENGE = '22222222-2222-4222-8222-222222222222';
const CHALLENGE_COOKIE = `${REGISTER_CHALLENGE_COOKIE.name}=${CHALLENGE}`;

const EN = enMessages.Register;
const AR = arMessages.Register;

let api: StubApi;
let app: RunningApp;

beforeAll(async () => {
  api = await startStubApi();
  // The API is never reached by these pages: registration's pages call nothing. It is started anyway so
  // that a page which *did* call it would be recorded rather than silently failing.
  api.reply((_request, response) => {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ unexpected: true }));
  });
  app = await startBuiltApp({ API_BASE_URL: api.baseUrl, INTERNAL_BFF_CREDENTIAL: CANARY_CREDENTIAL });
}, 180_000);

afterAll(async () => {
  await app.stop();
  await api.stop();
});

async function get(path: string, cookie?: string): Promise<{ status: number; html: string; setCookie: string[] }> {
  const response = await fetch(`${app.baseUrl}${path}`, {
    redirect: 'manual',
    headers: cookie === undefined ? {} : { cookie },
  });
  return {
    status: response.status,
    html: await response.text(),
    setCookie: response.headers.getSetCookie(),
  };
}

describe('/register', () => {
  it('renders the form with every field the approved contract takes', async () => {
    const { status, html } = await get('/register');

    expect(status).toBe(200);
    expect(html).toContain(EN.startTitle);
    expect(html).toContain(EN.startIntro);
    for (const label of [EN.email, EN.phone, EN.password, EN.displayName]) {
      expect(html, label).toContain(label);
    }
    expect(html).toContain(EN.submitRegister);
    // The way back for somebody who does in fact have an account.
    expect(html).toContain(EN.signIn);
    expect(html).toContain('href="/login"');
  });

  it('renders in Arabic, right to left', async () => {
    const { status, html } = await get('/ar/register');

    expect(status).toBe(200);
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('lang="ar"');
    expect(html).toContain(AR.startTitle);
    expect(html).toContain(AR.submitRegister);
    expect(html).toContain('href="/ar/login"');
    // Not a word of the English catalogue leaks into the Arabic page.
    expect(html).not.toContain(EN.startTitle);
    expect(html).not.toContain(EN.submitRegister);
  });

  it('keeps the phone and code fields left to right even under RTL', async () => {
    // An E.164 number reverses visually in an RTL field, and a person checking their own number needs to
    // read it the way they dial it.
    const { html } = await get('/ar/register');
    expect(html).toContain('dir="ltr"');
  });

  it('is noindex, like every other authentication surface', async () => {
    const { html } = await get('/register');
    expect(html).toMatch(/name="robots"[^>]*content="noindex/);
  });

  it('never says an address is already registered, because no such sentence exists', async () => {
    const { html } = await get('/register');

    // Asserted at the source as well as in the render: a page cannot show a string that does not exist.
    // Scoped to the two namespaces these pages draw from — an unrelated namespace may perfectly well say
    // that something else already exists, and one of them does.
    const catalogues = [
      enMessages.Register,
      enMessages.Login,
      arMessages.Register,
      arMessages.Login,
    ]
      .map((block) => Object.values(block).join(' '))
      .join(' ')
      .toLowerCase();
    for (const phrase of ['already registered', 'already exists', 'already taken', 'is taken', 'in use']) {
      expect(catalogues, phrase).not.toContain(phrase);
    }
    for (const phrase of ['already registered', 'already taken', 'account exists']) {
      expect(html.toLowerCase(), phrase).not.toContain(phrase);
    }
  });

  it('sets no cookie and leaks no credential, token or API address', async () => {
    const { html, setCookie } = await get('/register');

    expect(setCookie).toHaveLength(0);
    expect(html).not.toContain(CANARY_CREDENTIAL);
    expect(html).not.toContain(api.baseUrl);
    expect(html).not.toContain('/v1/');
    expect(html).not.toContain('supabase');
    // The browser talks to this origin's BFF and nothing else.
    expect(html).toContain('/api/auth/register');
  });
});

describe('/register/verify', () => {
  it('ships no code form at all without a challenge', async () => {
    const { status, html } = await get('/register/verify');

    expect(status).toBe(200);
    expect(html).toContain(EN.expiredTitle);
    expect(html).toContain(EN.startAgain);
    // Not merely hidden — absent from the document, flight data included. These are strings only the
    // form renders, and none of them is anywhere in the response. (The page's `<title>` is deliberately
    // the same in both states, so it is not a marker: a title that changed would itself be a difference
    // between one visitor and another.)
    expect(html).not.toContain(EN.code);
    expect(html).not.toContain(EN.codeHint);
    expect(html).not.toContain(EN.submitResend);
    expect(html).not.toContain('one-time-code');
    expect(html).not.toContain('/api/auth/register/verify');
    expect(html).not.toContain('/api/auth/register/resend');
  });

  it('renders the form and the resend when a registration is in progress', async () => {
    const { status, html } = await get('/register/verify', CHALLENGE_COOKIE);

    expect(status).toBe(200);
    expect(html).toContain(EN.verifyTitle);
    expect(html).toContain(EN.verifyIntro);
    expect(html).toContain(EN.code);
    expect(html).toContain(EN.submitVerify);
    expect(html).toContain(EN.submitResend);
    expect(html).toContain('/api/auth/register/verify');
    expect(html).toContain('/api/auth/register/resend');
  });

  it('never puts the challenge identifier in the page', async () => {
    const { html } = await get('/register/verify', CHALLENGE_COOKIE);

    // The cookie is `HttpOnly` and stays that way: nothing about the challenge reaches the document, the
    // flight data, a URL or a form field.
    expect(html).not.toContain(CHALLENGE);
    expect(html).not.toContain(REGISTER_CHALLENGE_COOKIE.name);
  });

  it('treats a cookie that is not a challenge identifier as none at all', async () => {
    const { html } = await get('/register/verify', `${REGISTER_CHALLENGE_COOKIE.name}=not-a-uuid`);

    expect(html).toContain(EN.expiredTitle);
    expect(html).not.toContain(EN.submitResend);
    expect(html).not.toContain('/api/auth/register/verify');
  });

  it('is not unlocked by another flow’s challenge cookie', async () => {
    const { html } = await get(
      '/register/verify',
      `__Host-mp_contact_phone_challenge=${CHALLENGE}`,
    );

    expect(html).toContain(EN.expiredTitle);
    expect(html).not.toContain(EN.submitResend);
    expect(html).not.toContain('/api/auth/register/verify');
  });

  it('renders in Arabic, right to left, in both states', async () => {
    const cold = await get('/ar/register/verify');
    expect(cold.html).toContain('dir="rtl"');
    expect(cold.html).toContain(AR.expiredTitle);
    expect(cold.html).toContain('href="/ar/register"');

    const inProgress = await get('/ar/register/verify', CHALLENGE_COOKIE);
    expect(inProgress.html).toContain('dir="rtl"');
    expect(inProgress.html).toContain(AR.verifyTitle);
    expect(inProgress.html).toContain(AR.submitResend);
    expect(inProgress.html).not.toContain(EN.verifyTitle);
  });

  it('points a confirmed account at the sign-in page, because no session is created', async () => {
    const { html, setCookie } = await get('/register/verify', CHALLENGE_COOKIE);

    // VERIFY FIRST made visible: the only place this page can send somebody afterwards is sign-in.
    expect(html).toContain('/login');
    expect(setCookie).toHaveLength(0);
    expect(html).not.toContain('__Host-mp_access');
    expect(html).not.toContain('__Host-mp_refresh');
  });

  it('is noindex, and leaks no credential or API address', async () => {
    const { html } = await get('/register/verify', CHALLENGE_COOKIE);

    expect(html).toMatch(/name="robots"[^>]*content="noindex/);
    expect(html).not.toContain(CANARY_CREDENTIAL);
    expect(html).not.toContain(api.baseUrl);
    expect(html).not.toContain('/v1/');
  });
});

describe('the sign-in page', () => {
  it('offers the way to registration', async () => {
    const { html } = await get('/login');
    expect(html).toContain(enMessages.Login.createAccount);
    expect(html).toContain('href="/register"');
  });

  it('and does so in Arabic', async () => {
    const { html } = await get('/ar/login');
    expect(html).toContain(arMessages.Login.createAccount);
    expect(html).toContain('href="/ar/register"');
  });
});
