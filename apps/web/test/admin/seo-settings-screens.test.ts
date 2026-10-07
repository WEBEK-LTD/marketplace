import type { ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import arMessages from '../../messages/admin/ar.json';
import enMessages from '../../messages/admin/en.json';
import { startBuiltApp, type RunningApp } from '../support/next-server.js';
import { problem, startStubApi, type StubApi } from '../support/stub-api.js';

/**
 * Where the console is mounted (0108). Every address in this file is console-relative, exactly as it was while the
 * console was an application of its own; this is the one place that turns it into the address the server answers.
 */
const CONSOLE = '/admin';

/**
 * The site-wide SEO settings screen, over real HTTP against the built app (0096).
 *
 * Run against the built app rather than a unit harness for the reason the shell test is: what matters is what
 * actually reaches a browser, **including the streamed RSC payload** — so a sentence merely hidden with CSS would
 * fail these assertions and a sentence never rendered passes them.
 *
 * The cases this file exists for:
 *
 *   * **a guest, a buyer, staff at `aal1`, a Moderator and the two colleagues who hold the other `seo` keys receive
 *     none of this section** — and no read is performed. The last of those matters most: this is the only section in
 *     the console gated on a manage key, so somebody with `seo.metadata.read` and `seo.metadata.manage` must get
 *     nothing, and an **invented `seo.settings.read` must not open it either**;
 *   * **owner decisions 1–4 are explained, not just applied.** The screen says which field is served and that the
 *     rest are stored and unused, because an operator who typed a site name expecting the header to change would
 *     otherwise be waiting for something that is not going to happen;
 *   * **owner decision 5 is on the screen, both ways.** The default locale is told that its robots body is served;
 *     a non-default locale is told that its body is kept and never served — and **that warning never appears on the
 *     served locale's panel, not even in the RSC payload**;
 *   * **owner decision 8 is explained.** The stored share image is shown as an identifier and a path, with the
 *     reason it cannot be displayed, and no `<img>` for it appears anywhere;
 *   * **an unauthored locale still gets a panel**, because the table ships empty and the first save needs one;
 *   * **no promotion, placement, ranking, financial or media-upload control appears anywhere**;
 *   * both languages and the direction that goes with each.
 *
 * No browser, no Playwright, no live provider, no deployment.
 */

/** Obviously fake, 43 base64url characters. */
const CANARY_CREDENTIAL = 'test-seo-settings-screens-canary-notreal012';

const EN = enMessages;
const AR = arMessages;

const ACCESS = '__Host-mp_admin_access=canary-admin-access-token-not-a-real-token';
const REFRESH = '__Host-mp_admin_refresh=canary-admin-refresh-token-not-a-real-tok';
const SESSION = `${ACCESS}; ${REFRESH}`;

const STAFF = '11111111-1111-4111-8111-111111111111';
const MEDIA = 'ec000000-0000-4000-8000-0000000000a1';

const MANAGE = 'seo.settings.manage';

/** An administrator: the one key this surface has, plus others it never consults. */
const ADMIN = [MANAGE, 'users.profile.read'].sort();

/**
 * A colleague who holds every other `seo` key — and an invented `seo.settings.read`.
 *
 * The invented key is the point: it does not exist in the seed, nothing was built to accept it, and this section must
 * stay shut to somebody who has it.
 */
const SEO_WITHOUT_SETTINGS = [
  'seo.settings.read',
  'seo.metadata.read',
  'seo.metadata.manage',
  'seo.redirect.read',
  'seo.redirect.manage',
].sort();

const MODERATOR = ['moderation.report.read', 'moderation.action.read', 'reviews.review.read'].sort();

/** A crawl policy with an interior blank line, so a screen that normalised it would be visible. */
const ROBOTS = 'User-agent: *\nDisallow: /dashboard\n\nUser-agent: BadBot\nDisallow: /';

type Who =
  | { kind: 'staff'; permissions: string[]; locale?: 'en' | 'ar' }
  | { kind: 'staff-aal1' }
  | { kind: 'buyer' }
  | { kind: 'unauthenticated' };

type Data = 'default' | 'unauthored' | 'mixed' | 'arabicAuthored' | 'noMedia' | 'empty' | 'unavailable';

interface Serve {
  readonly who: Who;
  readonly data?: Data;
}

let api: StubApi;
let app: RunningApp;

function enLocale(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    ...overrides,
  };
}

function arLocale(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    localeCode: 'ar',
    nameEn: 'Arabic',
    nameNative: 'العربية',
    isDefaultLocale: false,
    isAuthored: false,
    robotsIsServed: false,
    siteName: null,
    defaultMetaTitle: null,
    defaultMetaDescription: null,
    defaultShareMediaId: null,
    shareMediaObjectPath: null,
    twitterSite: null,
    robotsTxtBody: null,
    organizationStructuredData: null,
    updatedAt: null,
    ...overrides,
  };
}

function localesFor(data: Data): readonly Record<string, unknown>[] {
  if (data === 'empty') return [];
  // The state the platform actually ships in: the table is empty, so neither locale is authored.
  if (data === 'unauthored') {
    return [enLocale({ isAuthored: false, siteName: null, robotsTxtBody: null, defaultShareMediaId: null,
      shareMediaObjectPath: null, organizationStructuredData: null, updatedAt: null }), arLocale()];
  }
  // One of each, so "a delete is offered for exactly the authored locales" is a real assertion.
  if (data === 'mixed') {
    return [
      enLocale({ isAuthored: false, siteName: null, robotsTxtBody: null, defaultShareMediaId: null,
        shareMediaObjectPath: null, organizationStructuredData: null, updatedAt: null }),
      arLocale({ isAuthored: true, siteName: 'سوق مصر' }),
    ];
  }
  if (data === 'arabicAuthored') {
    // A body authored on the locale whose body is never served — owner decision 5's whole point.
    return [
      enLocale({ robotsTxtBody: null }),
      arLocale({ isAuthored: true, siteName: 'سوق مصر', robotsTxtBody: 'User-agent: *\nDisallow: /' }),
    ];
  }
  if (data === 'noMedia') {
    return [enLocale({ defaultShareMediaId: null, shareMediaObjectPath: null }), arLocale()];
  }
  return [enLocale(), arLocale()];
}

function json(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function apiServes(serve: Serve): void {
  const data: Data = serve.data ?? 'default';
  api.seen.length = 0;
  api.reply((request, response) => {
    const path = request.url.split('?')[0] ?? '';
    const who = serve.who;

    if (path === '/v1/admin/session') {
      if (who.kind === 'unauthenticated') return problem(response, 401, 'AUTHENTICATION_REQUIRED');
      const base = {
        id: STAFF,
        displayName: 'Nadia',
        localeCode: who.kind === 'staff' ? (who.locale ?? 'en') : 'en',
      };
      if (who.kind === 'buyer') {
        return json(response, {
          session: { ...base, isStaff: false, requiresStepUp: false, roles: [], permissions: [] },
        });
      }
      if (who.kind === 'staff-aal1') {
        return json(response, {
          session: { ...base, isStaff: true, requiresStepUp: true, roles: [], permissions: [] },
        });
      }
      return json(response, {
        session: {
          ...base,
          isStaff: true,
          requiresStepUp: false,
          roles: ['admin'],
          permissions: [...who.permissions],
        },
      });
    }

    const held = (key: string): boolean => who.kind === 'staff' && who.permissions.includes(key);

    if (path === '/v1/admin/seo/settings') {
      // The API's own shape: one key, so no key means the neutral absence.
      if (!held(MANAGE)) return problem(response, 404, 'NOT_FOUND');
      if (data === 'unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      return json(response, { locales: localesFor(data), canManage: true });
    }

    return problem(response, 404, 'NOT_FOUND');
  });
}

async function get(path: string, cookie: string | null = SESSION): Promise<{ status: number; html: string }> {
  const response = await fetch(`${app.baseUrl}${CONSOLE}${path}`, {
    headers: cookie === null ? {} : { cookie },
    redirect: 'manual',
  });
  return { status: response.status, html: await response.text() };
}

/** Which upstream addresses were asked for while rendering. */
function asked(): readonly string[] {
  return api.seen.map((entry) => entry.url.split('?')[0] ?? '');
}

beforeAll(async () => {
  api = await startStubApi();
  app = await startBuiltApp({ API_BASE_URL: api.baseUrl, INTERNAL_BFF_CREDENTIAL: CANARY_CREDENTIAL });
}, 120_000);

afterAll(async () => {
  await app.stop();
  await api.stop();
});

/* ------------------------------------------------------------------------------------------------ */

describe('who may open the section at all', () => {
  it('refuses a guest, a buyer and staff at aal1, each neutrally', async () => {
    for (const who of [{ kind: 'unauthenticated' } as const, { kind: 'buyer' } as const, { kind: 'staff-aal1' } as const]) {
      apiServes({ who });
      const { html } = await get('/seo/settings', who.kind === 'unauthenticated' ? null : SESSION);
      expect(html, who.kind).not.toContain(EN.SeoSettings.siteNameLabel);
      expect(asked(), who.kind).not.toContain('/v1/admin/seo/settings');
    }
  });

  it('refuses a Moderator, and performs no read', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR } });
    const { html } = await get('/seo/settings');
    expect(html).not.toContain(EN.SeoSettings.siteNameLabel);
    expect(asked()).not.toContain('/v1/admin/seo/settings');
  });

  it('refuses somebody holding every other seo key, including an invented seo.settings.read', async () => {
    // The one section in this console gated on a manage key. An invented read key is not a way in.
    apiServes({ who: { kind: 'staff', permissions: SEO_WITHOUT_SETTINGS } });
    const { html } = await get('/seo/settings');
    expect(html).not.toContain(EN.SeoSettings.siteNameLabel);
    expect(html).not.toContain(EN.SeoSettings.robotsLabel);
    expect(asked()).not.toContain('/v1/admin/seo/settings');
  });

  it('shows the section to somebody holding the manage key', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { status, html } = await get('/seo/settings');
    expect(status).toBe(200);
    expect(html).toContain(EN.Sections.seoSettings.title);
    expect(html).toContain(EN.SeoSettings.siteNameLabel);
    expect(asked()).toContain('/v1/admin/seo/settings');
  });

  it('is reachable from the navigation for that colleague', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get('');
    expect(html).toContain(EN.Sections.seoSettings.title);
    expect(html).toContain('/seo/settings');
  });

  it('is absent from the navigation for somebody holding the other seo keys', async () => {
    apiServes({ who: { kind: 'staff', permissions: SEO_WITHOUT_SETTINGS } });
    const { html } = await get('');
    expect(html).not.toContain(EN.Sections.seoSettings.title);
    expect(html).not.toContain('/seo/settings');
  });
});

/* ------------------------------------------------------------------------------------------------ */

describe('what the screen says about what is actually served', () => {
  it('says that only the robots body reaches the public, and that the rest is stored', async () => {
    // Owner decisions 1-4. Nothing else in this product would ever tell an operator this.
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get('/seo/settings');
    expect(html).toContain(EN.SeoSettings.whatIsServedTitle);
    expect(html).toContain(EN.SeoSettings.storedOnlyTitle);
  });

  it('marks the default locale as the one whose robots body is served', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get('/seo/settings');
    expect(html).toContain(EN.SeoSettings.robotsServedHere);
    expect(html).toContain(EN.SeoSettings.defaultLocaleBadge);
  });

  it('tells the non-default locale that its body is kept and never served', async () => {
    // Owner decision 5, on the screen rather than in a comment.
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'arabicAuthored' });
    const { html } = await get('/seo/settings');
    expect(html).toContain(EN.SeoSettings.robotsServedElsewhere);
    expect(html).toContain(EN.SeoSettings.robotsNotServedNotice);
  });

  it('never carries the not-served warning on a screen whose only locale is the served one', async () => {
    // The RSC-payload rule: a client component's whole props object is serialised, so this sentence must be absent
    // from the payload and not merely hidden. Asserted with a single-locale answer so there is no other panel that
    // could legitimately carry it.
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    api.reply((request, response) => {
      const path = request.url.split('?')[0] ?? '';
      if (path === '/v1/admin/session') {
        return json(response, {
          session: {
            id: STAFF,
            displayName: 'Nadia',
            localeCode: 'en',
            isStaff: true,
            requiresStepUp: false,
            roles: ['admin'],
            permissions: [...ADMIN],
          },
        });
      }
      if (path === '/v1/admin/seo/settings') {
        return json(response, { locales: [enLocale()], canManage: true });
      }
      return problem(response, 404, 'NOT_FOUND');
    });
    const { html } = await get('/seo/settings');
    expect(html).toContain(EN.SeoSettings.robotsServedHere);
    expect(html).not.toContain(EN.SeoSettings.robotsNotServedNotice);
  });

  it('says that a save replaces everything for the locale', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get('/seo/settings');
    expect(html).toContain(EN.SeoSettings.replaceWarning);
  });
});

/* ------------------------------------------------------------------------------------------------ */

describe('the panels', () => {
  it('shows one panel per locale, with the stored values in the form', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get('/seo/settings');
    expect(html).toContain('Egypt Market');
    expect(html).toContain('Buy and sell in Egypt');
    expect(html).toContain('@egyptmarket');
    // Both locales, named in English and in their own script.
    expect(html).toContain('English');
    expect(html).toContain('العربية');
  });

  it('names a locale once when its own name is the English one', async () => {
    // English is seeded with both names identical, so the two-name heading would read "English (English)".
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get('/seo/settings');
    expect(html).not.toContain('English (English)');
    // And the courtesy is still paid where the names differ.
    expect(html).toContain('Arabic (العربية)');
  });

  it('carries the robots body into the form exactly as stored', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get('/seo/settings');
    expect(html).toContain('Disallow: /dashboard');
    expect(html).toContain('Disallow: /');
    expect(html).toContain('BadBot');
  });

  it('gives an unauthored locale a panel and says nothing is saved for it', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'unauthored' });
    const { html } = await get('/seo/settings');
    expect(html).toContain(EN.SeoSettings.unauthoredTitle);
    expect(html).toContain(EN.SeoSettings.unauthoredBadge);
    // The form is still there, which is the whole reason the reader returns a row for it.
    expect(html).toContain(EN.SeoSettings.siteNameLabel);
  });

  it('offers no delete at all in the state the platform ships in', async () => {
    // Nothing is authored for either locale, so there is nothing to delete and no control for it.
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'unauthored' });
    const { html } = await get('/seo/settings');
    expect(html).not.toContain(EN.SeoSettings.removeHeading);
    expect(html).not.toContain(EN.SeoSettings.remove);
  });

  it('offers a delete for exactly the locales that have something saved', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'mixed' });
    const { html } = await get('/seo/settings');
    // One authored locale in this fixture, so the heading appears once and no more.
    expect(html.split(EN.SeoSettings.removeHeading).length - 1).toBe(1);
    // And it is the unserved locale's, so the gentler of the two sentences is the one shown.
    expect(html).toContain(EN.SeoSettings.removeIntro);
    expect(html).not.toContain(EN.SeoSettings.removeIntroServed);
  });

  it('warns that deleting the served locale changes robots.txt straight away', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get('/seo/settings');
    expect(html).toContain(EN.SeoSettings.removeIntroServed);
  });
});

/* ------------------------------------------------------------------------------------------------ */

describe('the share image, which cannot be shown', () => {
  it('shows the stored identifier and its path, and says why neither becomes a picture', async () => {
    // Owner decision 8.
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get('/seo/settings');
    expect(html).toContain(MEDIA);
    expect(html).toContain('cms-media/share/default.png');
    expect(html).toContain(EN.SeoSettings.shareMediaStoredTitle);
    expect(html).toContain(EN.SeoSettings.shareMediaUnresolvableBody);
  });

  it('renders no image element and no upload control anywhere', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get('/seo/settings');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('type="file"');
    expect(html).not.toContain('cms-media.supabase');
  });

  it('shows no stored-image panel when no image is stored', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'noMedia' });
    const { html } = await get('/seo/settings');
    expect(html).not.toContain(EN.SeoSettings.shareMediaStoredTitle);
    // The field itself is still offered: an operator has to be able to set one.
    expect(html).toContain(EN.SeoSettings.shareMediaLabel);
  });
});

/* ------------------------------------------------------------------------------------------------ */

describe('what this screen must not contain', () => {
  it('has no promotion, placement, ranking or financial control', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get('/seo/settings');
    for (const name of [
      'name="promotion"',
      'name="placement"',
      'name="ranking"',
      'name="isFeatured"',
      'name="priceMinor"',
      'name="commission"',
      'name="settlement"',
      'name="payout"',
    ]) {
      expect(html, name).not.toContain(name);
    }
  });

  it('has no control over which locale is the default or which is served', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get('/seo/settings');
    for (const name of ['name="isDefault"', 'name="isDefaultLocale"', 'name="robotsIsServed"', 'name="isAuthored"']) {
      expect(html, name).not.toContain(name);
    }
  });

  it('emits no structured data of its own and no JSON-LD script', async () => {
    // Owner decision 4: the organization document is a field to type into, never a document this screen publishes.
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get('/seo/settings');
    expect(html).not.toContain('application/ld+json');
    expect(html).not.toContain('"@context"');
    expect(html).not.toContain('schema.org');
  });
});

/* ------------------------------------------------------------------------------------------------ */

describe('failures and both languages', () => {
  it('says the settings could not be loaded when the read fails', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'unavailable' });
    const { status, html } = await get('/seo/settings');
    expect(status).toBe(200);
    expect(html).toContain(EN.SeoSettings.unavailableTitle);
    expect(html).not.toContain(EN.SeoSettings.siteNameLabel);
  });

  it('says so when the platform reports no active language', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'empty' });
    const { html } = await get('/seo/settings');
    expect(html).toContain(EN.SeoSettings.emptyTitle);
  });

  it('renders in Arabic, right to left', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN, locale: 'ar' } });
    const { status, html } = await get('/seo/settings');
    expect(status).toBe(200);
    expect(html).toContain('dir="rtl"');
    expect(html).toContain(AR.Sections.seoSettings.title);
    expect(html).toContain(AR.SeoSettings.siteNameLabel);
    expect(html).toContain(AR.SeoSettings.storedOnlyTitle);
  });

  it('renders in English, left to right', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get('/seo/settings');
    expect(html).toContain('dir="ltr"');
    expect(html).toContain(EN.SeoSettings.siteNameLabel);
  });
});
