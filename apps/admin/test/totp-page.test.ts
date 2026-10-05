import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import arMessages from '../messages/ar.json';
import enMessages from '../messages/en.json';
import { TOTP_CHALLENGE_COOKIE } from '../src/server/bff/totp-challenge-cookie';
import { startBuiltApp, type RunningApp } from './support/next-server.js';
import { startStubApi, type StubApi } from './support/stub-api.js';

/**
 * The TOTP surfaces on the admin origin, over real HTTP against the built app (Phase 7-B).
 *
 * Run against the built app rather than a unit harness because what matters is what actually reaches a
 * browser, including the streamed RSC payload. The heaviest assertions are about absence:
 *
 *   * **no secret is anywhere in either page** — the setup screen fetches one only when somebody asks to
 *     begin, so a page that is merely open, or captured, contains none;
 *   * no internal credential, no `/v1/...` address, no session cookie and no factor identifier;
 *   * both pages are `noindex`, like every other authentication surface.
 *
 * No browser, no Playwright, no live provider, no deployment.
 */

// Exactly 43 base64url characters: the admin app's env validation refuses any other length at startup.
const CANARY_CREDENTIAL = 'test-admin-totp-canary-credential-notreal12';

const EN = enMessages.Totp;
const AR = arMessages.Totp;

let api: StubApi;
let app: RunningApp;

beforeAll(async () => {
  api = await startStubApi();
  // These pages call nothing. The stub answers 500 so that a page which *did* call it would be caught
  // rather than quietly succeeding.
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

describe('/security/totp', () => {
  it('offers setup without fetching anything', async () => {
    const { status, html } = await get('/security/totp');

    expect(status).toBe(200);
    expect(html).toContain(EN.setupTitle);
    expect(html).toContain(EN.setupIntro);
    expect(html).toContain(EN.begin);
    // The secret is fetched only when somebody asks to begin, so neither the key nor the code box is
    // rendered yet. Asserted on the markup rather than on the label strings: labels travel to the client
    // as props and are in the flight data either way, which is fine — they are copy, not secrets.
    expect(html).not.toContain('totp-setup-code');
    expect(html).not.toContain('one-time-code');
    expect(html).not.toContain('<img');
  });

  it('ships no secret, no factor identifier and no credential', async () => {
    const { html, setCookie } = await get('/security/totp');

    expect(html).not.toContain(CANARY_CREDENTIAL);
    expect(html).not.toContain(api.baseUrl);
    expect(html).not.toContain('/v1/');
    expect(html).not.toContain('otpauth://');
    expect(html.toLowerCase()).not.toContain('jbswy3dpehpk3pxp');
    expect(setCookie).toHaveLength(0);
    // The browser talks to this origin's BFF and nothing else.
    expect(html).toContain('/api/auth/totp/enrol');
  });

  it('is noindex, like every other authentication surface', async () => {
    const { html } = await get('/security/totp');
    expect(html).toMatch(/name="robots"[^>]*content="noindex/);
  });

  it('never mentions backup or recovery codes, because there are none yet', async () => {
    // D9's recovery path is gated by the specification on O-1 tests 4 and 5, which have not been run.
    // A page that offered them would be promising something that does not exist.
    const { html } = await get('/security/totp');
    const copy = JSON.stringify(enMessages.Totp).toLowerCase() + JSON.stringify(arMessages.Totp).toLowerCase();
    for (const phrase of ['backup code', 'recovery code', 'رمز احتياطي']) {
      expect(copy, phrase).not.toContain(phrase);
      expect(html.toLowerCase(), phrase).not.toContain(phrase);
    }
  });
});

describe('/security/totp/challenge', () => {
  it('asks for the code and nothing else', async () => {
    const { status, html } = await get('/security/totp/challenge');

    expect(status).toBe(200);
    expect(html).toContain(EN.challengeTitle);
    expect(html).toContain(EN.challengeIntro);
    expect(html).toContain(EN.codeLabel);
    expect(html).toContain('one-time-code');
    expect(html).toContain('/api/auth/totp/verify');
  });

  it('never reveals the challenge it is answering, even when one is in flight', async () => {
    const factor = '33333333-3333-4333-8333-333333333333';
    const challenge = '22222222-2222-4222-8222-222222222222';
    const { html } = await get(
      '/security/totp/challenge',
      `${TOTP_CHALLENGE_COOKIE.name}=${factor}:${challenge}:payout.details.change`,
    );

    // The cookie is `HttpOnly` and stays server-side: none of it reaches the document or the flight data,
    // including the operation a correct code would authorise.
    expect(html).not.toContain(factor);
    expect(html).not.toContain(challenge);
    expect(html).not.toContain('payout.details.change');
    expect(html).not.toContain(TOTP_CHALLENGE_COOKIE.name);
  });

  it('is noindex and leaks no credential or API address', async () => {
    const { html } = await get('/security/totp/challenge');

    expect(html).toMatch(/name="robots"[^>]*content="noindex/);
    expect(html).not.toContain(CANARY_CREDENTIAL);
    expect(html).not.toContain(api.baseUrl);
    expect(html).not.toContain('/v1/');
  });
});

describe('both pages in Arabic', () => {
  it('render right to left, with the code field still left to right', async () => {
    // The admin app resolves to English until user profiles exist, so the catalogue is asserted directly
    // alongside the frame's own RTL behaviour, which `locale.test.tsx` covers.
    expect(Object.keys(AR).sort()).toEqual(Object.keys(EN).sort());
    expect(AR.setupTitle).not.toBe(EN.setupTitle);
    expect(AR.codeLabel).not.toBe(EN.codeLabel);

    const { html } = await get('/security/totp/challenge');
    // A six-digit code is read left to right on an Arabic page too, and so is a Base32 secret.
    expect(html).toContain('dir="ltr"');
  });
});
