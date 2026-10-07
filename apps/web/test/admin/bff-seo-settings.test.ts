import { describe, expect, it } from 'vitest';
import {
  handleSeoSettingsRemove,
  handleSeoSettingsSave,
  readSeoSettings,
} from '../../src/admin/server/bff/seo-settings';

/**
 * The site-wide SEO settings BFF, on the admin origin (0096).
 *
 * What matters at this boundary:
 *
 *   * the caller's token comes from `__Host-mp_admin_access` and never from a body, and the browser's own `Cookie`
 *     header is never forwarded upstream;
 *   * **the body is rebuilt, never forwarded** — an `updatedBy`, an `isAuthored` or a `robotsIsServed` has nowhere to
 *     go, because none is a field of the contract;
 *   * **absent stays absent.** A save is a replace and the API clears what it is not given, so turning an absent field
 *     into null here would be making the same decision twice in two places;
 *   * **the locale is checked here and travels in the address upstream**, so a made-up locale, a traversal or an
 *     encoded separator never becomes an upstream request;
 *   * **the robots body crosses untouched**, interior newlines included, because it is served to crawlers verbatim;
 *   * responses are validated before a byte reaches a browser, so a field the contract does not name cannot reach a
 *     screen even if the API sent one;
 *   * the two refusals a screen must act on are forwarded with the API's own problem body, and anything else becomes
 *     one 503;
 *   * every write is same-origin, and a cross-origin submission is refused before its body is read.
 *
 * Everything is stubbed at the `fetch` boundary: no API, no database, no network.
 */

const ENV = {
  API_BASE_URL: 'https://api.internal.test',
  INTERNAL_BFF_CREDENTIAL: 'test-settings-canary-credential-abcdefghijk',
} as const;

const SESSION_TOKEN = 'canary-admin-access-token-not-a-real-token';
const COOKIE = `__Host-mp_admin_access=${SESSION_TOKEN}; __Host-mp_admin_refresh=canary-refresh-not-real`;
const ORIGIN = 'https://admin.test';

const MEDIA = 'eb000000-0000-4000-8000-0000000000a1';
const ROBOTS = 'User-agent: *\nDisallow: /dashboard\n\nUser-agent: BadBot\nDisallow: /';

const EN_LOCALE = {
  localeCode: 'en',
  nameEn: 'English',
  nameNative: 'English',
  isDefaultLocale: true,
  isAuthored: true,
  robotsIsServed: true,
  siteName: 'Egypt Market',
  defaultMetaTitle: 'Buy and sell in Egypt',
  defaultMetaDescription: 'Everything for sale, in one place.',
  defaultShareMediaId: MEDIA,
  shareMediaObjectPath: 'cms-media/share/default.png',
  twitterSite: '@egyptmarket',
  robotsTxtBody: ROBOTS,
  organizationStructuredData: { name: 'Egypt Market' },
  updatedAt: '2026-05-02T09:00:00.000Z',
};

interface Seen {
  url: string;
  method: string;
  cookie: string | null;
  sessionToken: string | null;
  body: string | null;
}

function apiReturns(status: number, body: unknown, seen: { value?: Seen } = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const sent = new Headers(init?.headers);
    seen.value = {
      url: String(input),
      method: init?.method ?? 'GET',
      cookie: sent.get('cookie'),
      sessionToken: sent.get('x-session-token') ?? sent.get('X-Session-Token'),
      body: typeof init?.body === 'string' ? init.body : null,
    };
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': status < 400 ? 'application/json' : 'application/problem+json' },
    });
  }) as unknown as typeof fetch;
}

function apiUnreachable(): typeof fetch {
  return (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
}

function writeRequest(
  path: string,
  method: string,
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { origin: ORIGIN, 'content-type': 'application/json', cookie: COOKIE, ...headers },
    body: JSON.stringify(body),
  });
}

/** The one required field, so a test can say what it is actually about. */
const MINIMAL = { localeCode: 'en', siteName: 'Egypt Market' } as const;

/* ------------------------------------------------------------------------------------------------ */
/* Reads                                                                                             */
/* ------------------------------------------------------------------------------------------------ */

describe('readSeoSettings', () => {
  it('presents the session token upstream and never the browser cookie', async () => {
    const seen: { value?: Seen } = {};
    await readSeoSettings({
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReturns(200, { locales: [EN_LOCALE], canManage: true }, seen),
    });
    expect(seen.value?.sessionToken).toBe(SESSION_TOKEN);
    expect(seen.value?.cookie).toBeNull();
    expect(seen.value?.url).toBe('https://api.internal.test/v1/admin/seo/settings');
  });

  it('is unauthenticated with no session cookie, without calling upstream', async () => {
    const seen: { value?: Seen } = {};
    const result = await readSeoSettings({ env: ENV, cookieHeader: null, fetch: apiReturns(200, {}, seen) });
    expect(result.kind).toBe('unauthenticated');
    expect(seen.value).toBeUndefined();
  });

  it('returns the locales a screen renders', async () => {
    const result = await readSeoSettings({
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReturns(200, { locales: [EN_LOCALE], canManage: true }),
    });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.data.locales[0]?.localeCode).toBe('en');
    expect(result.data.locales[0]?.robotsIsServed).toBe(true);
    // The body arrives exactly as the API sent it, blank line and all.
    expect(result.data.locales[0]?.robotsTxtBody).toBe(ROBOTS);
  });

  it('is notFound when the API reports an absence', async () => {
    const result = await readSeoSettings({
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReturns(404, { code: 'NOT_FOUND' }),
    });
    expect(result.kind).toBe('notFound');
  });

  it('is unauthenticated when the API says so', async () => {
    const result = await readSeoSettings({
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReturns(401, { code: 'AUTHENTICATION_REQUIRED' }),
    });
    expect(result.kind).toBe('unauthenticated');
  });

  it('is unavailable when the API is unreachable', async () => {
    const result = await readSeoSettings({ env: ENV, cookieHeader: COOKIE, fetch: apiUnreachable() });
    expect(result.kind).toBe('unavailable');
  });

  it('refuses a body the contract does not describe rather than passing it on', async () => {
    const result = await readSeoSettings({
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReturns(200, { locales: [{ ...EN_LOCALE, surprise: 'a field nobody declared' }], canManage: true }),
    });
    expect(result.kind).toBe('unavailable');
  });

  it('refuses a body missing the served marking, because a screen must not guess it', async () => {
    const { robotsIsServed: _omitted, ...withoutMarking } = EN_LOCALE;
    const result = await readSeoSettings({
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReturns(200, { locales: [withoutMarking], canManage: true }),
    });
    expect(result.kind).toBe('unavailable');
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* Saving                                                                                            */
/* ------------------------------------------------------------------------------------------------ */

describe('handleSeoSettingsSave', () => {
  it('sends the locale in the address and the fields in the body', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleSeoSettingsSave(
      writeRequest('/api/seo/settings', 'PUT', { ...MINIMAL, robotsTxtBody: ROBOTS }),
      { env: ENV, fetch: apiReturns(200, { ok: true }, seen) },
    );
    expect(response.status).toBe(200);
    expect(seen.value?.method).toBe('PUT');
    expect(seen.value?.url).toBe('https://api.internal.test/v1/admin/seo/settings/en');
    const body = JSON.parse(seen.value?.body ?? '{}');
    expect(body.siteName).toBe('Egypt Market');
    // Verbatim, because it is served verbatim.
    expect(body.robotsTxtBody).toBe(ROBOTS);
    // The locale is the address upstream, not a field of the row.
    expect(body).not.toHaveProperty('localeCode');
  });

  it('keeps an absent field absent, because the API clears what it is not given', async () => {
    const seen: { value?: Seen } = {};
    await handleSeoSettingsSave(writeRequest('/api/seo/settings', 'PUT', MINIMAL), {
      env: ENV,
      fetch: apiReturns(200, { ok: true }, seen),
    });
    const body = JSON.parse(seen.value?.body ?? '{}');
    expect(Object.keys(body)).toEqual(['siteName']);
  });

  it('forwards an explicit null, which is how a field is cleared', async () => {
    const seen: { value?: Seen } = {};
    await handleSeoSettingsSave(
      writeRequest('/api/seo/settings', 'PUT', { ...MINIMAL, robotsTxtBody: null, twitterSite: null }),
      { env: ENV, fetch: apiReturns(200, { ok: true }, seen) },
    );
    const body = JSON.parse(seen.value?.body ?? '{}');
    expect(body.robotsTxtBody).toBeNull();
    expect(body.twitterSite).toBeNull();
  });

  it('drops a field the contract does not name', async () => {
    const seen: { value?: Seen } = {};
    await handleSeoSettingsSave(
      writeRequest('/api/seo/settings', 'PUT', {
        ...MINIMAL,
        updatedBy: '11111111-1111-4111-8111-111111111111',
        isAuthored: true,
        robotsIsServed: true,
        isDefaultLocale: true,
      }),
      { env: ENV, fetch: apiReturns(200, { ok: true }, seen) },
    );
    const body = JSON.parse(seen.value?.body ?? '{}');
    expect(body).not.toHaveProperty('updatedBy');
    expect(body).not.toHaveProperty('isAuthored');
    expect(body).not.toHaveProperty('robotsIsServed');
    expect(body).not.toHaveProperty('isDefaultLocale');
  });

  it('refuses a locale that is not a locale, without calling upstream', async () => {
    const seen: { value?: Seen } = {};
    for (const locale of ['english', 'e', 'EN', 'en_GB', '../en', 'en/x', '']) {
      const response = await handleSeoSettingsSave(
        writeRequest('/api/seo/settings', 'PUT', { ...MINIMAL, localeCode: locale }),
        { env: ENV, fetch: apiReturns(200, { ok: true }, seen) },
      );
      expect(response.status, locale).toBe(400);
    }
    expect(seen.value).toBeUndefined();
  });

  it('refuses a missing site name, without calling upstream', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleSeoSettingsSave(
      writeRequest('/api/seo/settings', 'PUT', { localeCode: 'en' }),
      { env: ENV, fetch: apiReturns(200, { ok: true }, seen) },
    );
    expect(response.status).toBe(400);
    expect(seen.value).toBeUndefined();
  });

  it('refuses the lengths and the handle format, without calling upstream', async () => {
    const seen: { value?: Seen } = {};
    const bad: readonly Record<string, unknown>[] = [
      { ...MINIMAL, siteName: 'n'.repeat(121) },
      { ...MINIMAL, defaultMetaTitle: 't'.repeat(71) },
      { ...MINIMAL, defaultMetaDescription: 'd'.repeat(321) },
      { ...MINIMAL, twitterSite: 'egyptmarket' },
      { ...MINIMAL, defaultShareMediaId: 'not-a-uuid' },
      { ...MINIMAL, organizationStructuredData: [1, 2, 3] },
    ];
    for (const body of bad) {
      const response = await handleSeoSettingsSave(writeRequest('/api/seo/settings', 'PUT', body), {
        env: ENV,
        fetch: apiReturns(200, { ok: true }, seen),
      });
      expect(response.status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    expect(seen.value).toBeUndefined();
  });

  it('refuses a cross-origin submission before reading its body', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleSeoSettingsSave(
      writeRequest('/api/seo/settings', 'PUT', MINIMAL, { origin: 'https://evil.test' }),
      { env: ENV, fetch: apiReturns(200, { ok: true }, seen) },
    );
    expect(response.status).toBe(403);
    expect(seen.value).toBeUndefined();
  });

  it('needs a session cookie', async () => {
    const seen: { value?: Seen } = {};
    const request = new Request(`${ORIGIN}/api/seo/settings`, {
      method: 'PUT',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify(MINIMAL),
    });
    const response = await handleSeoSettingsSave(request, { env: ENV, fetch: apiReturns(200, { ok: true }, seen) });
    expect(response.status).toBe(401);
    expect(seen.value).toBeUndefined();
  });

  it('forwards the two refusals a screen must act on, with the API’s own body', async () => {
    for (const code of ['SEO_SETTINGS_NOT_ALLOWED', 'SEO_SETTINGS_MEDIA_MISSING']) {
      const response = await handleSeoSettingsSave(writeRequest('/api/seo/settings', 'PUT', MINIMAL), {
        env: ENV,
        fetch: apiReturns(409, { code, status: 409 }),
      });
      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe(code);
    }
  });

  it('forwards an absence as an absence', async () => {
    const response = await handleSeoSettingsSave(writeRequest('/api/seo/settings', 'PUT', MINIMAL), {
      env: ENV,
      fetch: apiReturns(404, { code: 'NOT_FOUND', status: 404 }),
    });
    expect(response.status).toBe(404);
  });

  it('turns anything else into one 503', async () => {
    for (const status of [418, 500, 502]) {
      const response = await handleSeoSettingsSave(writeRequest('/api/seo/settings', 'PUT', MINIMAL), {
        env: ENV,
        fetch: apiReturns(status, { code: 'SOMETHING_ELSE' }),
      });
      expect(response.status, String(status)).toBe(503);
    }
  });

  it('is a 503 when the API is unreachable', async () => {
    const response = await handleSeoSettingsSave(writeRequest('/api/seo/settings', 'PUT', MINIMAL), {
      env: ENV,
      fetch: apiUnreachable(),
    });
    expect(response.status).toBe(503);
  });

  it('refuses an upstream success whose body is not the contract’s', async () => {
    const response = await handleSeoSettingsSave(writeRequest('/api/seo/settings', 'PUT', MINIMAL), {
      env: ENV,
      fetch: apiReturns(200, { ok: 'yes' }),
    });
    expect(response.status).toBe(503);
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* Removing                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

describe('handleSeoSettingsRemove', () => {
  it('sends a DELETE to the locale’s address', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleSeoSettingsRemove(
      writeRequest('/api/seo/settings/remove', 'POST', { localeCode: 'ar' }),
      { env: ENV, fetch: apiReturns(200, { ok: true }, seen) },
    );
    expect(response.status).toBe(200);
    expect(seen.value?.method).toBe('DELETE');
    expect(seen.value?.url).toBe('https://api.internal.test/v1/admin/seo/settings/ar');
    // No body on a delete: there is nothing to say beyond which locale.
    expect(seen.value?.body).toBeNull();
  });

  it('refuses a locale that is not a locale, without calling upstream', async () => {
    const seen: { value?: Seen } = {};
    for (const locale of ['english', '../en', 'en/x', '']) {
      const response = await handleSeoSettingsRemove(
        writeRequest('/api/seo/settings/remove', 'POST', { localeCode: locale }),
        { env: ENV, fetch: apiReturns(200, { ok: true }, seen) },
      );
      expect(response.status, locale).toBe(400);
    }
    expect(seen.value).toBeUndefined();
  });

  it('refuses a submission with no locale at all', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleSeoSettingsRemove(writeRequest('/api/seo/settings/remove', 'POST', {}), {
      env: ENV,
      fetch: apiReturns(200, { ok: true }, seen),
    });
    expect(response.status).toBe(400);
    expect(seen.value).toBeUndefined();
  });

  it('refuses a cross-origin submission before reading its body', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleSeoSettingsRemove(
      writeRequest('/api/seo/settings/remove', 'POST', { localeCode: 'en' }, { origin: 'https://evil.test' }),
      { env: ENV, fetch: apiReturns(200, { ok: true }, seen) },
    );
    expect(response.status).toBe(403);
    expect(seen.value).toBeUndefined();
  });

  it('forwards an absence as an absence', async () => {
    const response = await handleSeoSettingsRemove(
      writeRequest('/api/seo/settings/remove', 'POST', { localeCode: 'ar' }),
      { env: ENV, fetch: apiReturns(404, { code: 'NOT_FOUND', status: 404 }) },
    );
    expect(response.status).toBe(404);
  });

  it('is a 503 when the API is unreachable', async () => {
    const response = await handleSeoSettingsRemove(
      writeRequest('/api/seo/settings/remove', 'POST', { localeCode: 'en' }),
      { env: ENV, fetch: apiUnreachable() },
    );
    expect(response.status).toBe(503);
  });
});
