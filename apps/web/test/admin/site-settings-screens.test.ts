import type { ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import arMessages from '../../messages/admin/ar.json';
import enMessages from '../../messages/admin/en.json';
import { startBuiltApp, type RunningApp } from '../support/next-server.js';
import { problem, startStubApi, type StubApi } from '../support/stub-api.js';

/** Where the console is mounted (0108). Every address in this file is console-relative. */
const CONSOLE = '/admin';

/**
 * The office settings screen, over real HTTP against the built app (0113).
 *
 * Run against the built app rather than a unit harness for the reason the shell test is: what matters is what
 * actually reaches a browser, **including the streamed RSC payload** — so a field merely hidden with CSS would
 * fail these assertions and one never rendered passes them.
 *
 * The cases this file exists for:
 *
 *   * **a guest, a buyer, staff at `aal1`, a Moderator and a colleague holding an invented
 *     `settings.site.read` all receive none of this section** — and no read is performed. The invented key is
 *     the point: it is not in the seed, nothing was built to accept it, and this section must stay shut to
 *     somebody who has it;
 *   * **the screen shows each setting's own description**, from the database rather than from a parallel
 *     catalogue of console copy, in the reader's language;
 *   * **`is_public` is reported and is not editable**, because an operator typing into a field should know
 *     whether what they type will appear on the public site;
 *   * **there is no control that could create or delete a setting**, which is the property the whole surface
 *     rests on: a console that could mint a key could mint a public one;
 *   * **the empty state is the state the platform ships in** — eight settings, all blank — and renders eight
 *     editable fields rather than an empty page, because a screen that listed only filled-in settings would
 *     have nothing to type into;
 *   * both languages and the direction that goes with each.
 *
 * No browser, no Playwright, no live provider, no deployment.
 */

/** Obviously fake, 43 base64url characters. */
const CANARY_CREDENTIAL = 'test-site-settings-screens-canary-notreal01';

const EN = enMessages;
const AR = arMessages;

const ACCESS = '__Host-mp_admin_access=canary-admin-access-token-not-a-real-token';
const REFRESH = '__Host-mp_admin_refresh=canary-admin-refresh-token-not-a-real-tok';
const SESSION = `${ACCESS}; ${REFRESH}`;

const STAFF = '11111111-1111-4111-8111-111111111111';

const MANAGE = 'settings.site.manage';

/** An administrator: the one key this surface has, plus one it never consults. */
const ADMIN = [MANAGE, 'users.profile.read'].sort();

/**
 * A colleague holding an **invented** `settings.site.read`, and the other `settings` keys that do exist.
 *
 * 0033 seeds no read key for this cluster. Nothing was built to accept one. This section must stay shut.
 */
const SETTINGS_WITHOUT_SITE = [
  'settings.site.read',
  'settings.currency.manage',
  'settings.country.manage',
  'settings.email_template.read',
].sort();

const MODERATOR = ['moderation.report.read', 'moderation.action.read', 'reviews.review.read'].sort();

type Who =
  | { kind: 'staff'; permissions: string[]; locale?: 'en' | 'ar' }
  | { kind: 'staff-aal1' }
  | { kind: 'buyer' }
  | { kind: 'unauthenticated' };

type Data = 'filled' | 'shipped' | 'empty' | 'unavailable';

interface Serve {
  readonly who: Who;
  readonly data?: Data;
}

let api: StubApi;
let app: RunningApp;

function setting(
  key: string,
  value: unknown,
  valueType: 'string' | 'number' | 'boolean' | 'json',
  isPublic: boolean,
  descriptionEn: string,
  descriptionAr: string,
): Record<string, unknown> {
  return {
    key,
    category: 'office',
    value,
    valueType,
    isPublic,
    descriptionEn,
    descriptionAr,
    updatedAt: '2026-05-02T09:00:00.000Z',
  };
}

/** The eight rows 0113 seeds, in key order, as the API returns them. */
function settingsFor(data: Data): readonly Record<string, unknown>[] {
  if (data === 'empty') return [];
  const blank = data === 'shipped';
  return [
    setting('office.address_ar', blank ? '' : 'شارع ٩، المعادي، القاهرة', 'string', true,
      'The office address in Arabic.', 'عنوان المكتب بالعربي.'),
    setting('office.address_en', blank ? '' : '9 Street, Maadi, Cairo', 'string', true,
      'The office address in English.', 'عنوان المكتب بالإنجليزي.'),
    setting('office.email', blank ? '' : 'office@example.invalid', 'string', true,
      'Where written enquiries arrive.', 'البريد اللي توصله الاستفسارات.'),
    setting('office.hours_ar', blank ? '' : 'السبت إلى الخميس، ١٠ص – ٨م', 'string', true,
      'When the office is open, in Arabic.', 'مواعيد العمل بالعربي.'),
    setting('office.hours_en', blank ? '' : 'Saturday to Thursday, 10am – 8pm', 'string', true,
      'When the office is open, in English.', 'مواعيد العمل بالإنجليزي.'),
    setting('office.social_links', blank ? [] : [{ label: 'Facebook', url: 'https://example.invalid/office' }],
      'json', true, 'The office social accounts.', 'حسابات المكتب على السوشيال.'),
    setting('office.telephone', blank ? '' : '+20 2 1234 5678', 'string', true,
      'The office telephone number.', 'رقم تليفون المكتب.'),
    setting('office.whatsapp', blank ? '' : '+20 100 000 0000', 'string', true,
      'The office WhatsApp number.', 'رقم واتساب المكتب.'),
  ];
}

function json(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function apiServes(serve: Serve): void {
  const data: Data = serve.data ?? 'filled';
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

    if (path === '/v1/admin/settings/office') {
      // The API's own shape: one key, so no key means the neutral absence.
      if (!held(MANAGE)) return problem(response, 404, 'NOT_FOUND');
      if (data === 'unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      return json(response, { category: 'office', settings: settingsFor(data), canManage: true });
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

describe('who may open the office settings at all', () => {
  it('refuses a guest, a buyer and staff at aal1, each neutrally, and performs no read', async () => {
    for (const who of [
      { kind: 'unauthenticated' } as const,
      { kind: 'buyer' } as const,
      { kind: 'staff-aal1' } as const,
    ]) {
      apiServes({ who });
      const { html } = await get('/settings/office', who.kind === 'unauthenticated' ? null : SESSION);
      expect(html, who.kind).not.toContain(EN.SiteSettings.officeHeading);
      expect(asked(), who.kind).not.toContain('/v1/admin/settings/office');
    }
  });

  it('refuses a Moderator, and performs no read', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR } });
    const { html } = await get('/settings/office');
    expect(html).not.toContain(EN.SiteSettings.officeHeading);
    expect(asked()).not.toContain('/v1/admin/settings/office');
  });

  it('refuses a colleague holding an invented settings.site.read, and the other settings keys', async () => {
    // The whole point of this case: `settings.site.read` is not in the seed and nothing accepts it.
    apiServes({ who: { kind: 'staff', permissions: SETTINGS_WITHOUT_SITE } });
    const { html } = await get('/settings/office');
    expect(html).not.toContain(EN.SiteSettings.officeHeading);
    expect(asked()).not.toContain('/v1/admin/settings/office');
  });

  it('admits an administrator', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { status, html } = await get('/settings/office');
    expect(status).toBe(200);
    expect(html).toContain(EN.Sections.siteSettings.title);
    expect(html).toContain(EN.SiteSettings.officeHeading);
    expect(asked()).toContain('/v1/admin/settings/office');
  });
});

describe('what the screen shows', () => {
  it('shows every setting with the database’s own description, not a second catalogue of copy', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get('/settings/office');
    // The descriptions are the rows'. A console that kept its own list would show something else here.
    expect(html).toContain('The office telephone number.');
    expect(html).toContain('When the office is open, in English.');
    expect(html).toContain('The office address in Arabic.');
  });

  it('shows the stored values, and a label derived from each key', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get('/settings/office');
    expect(html).toContain('+20 2 1234 5678');
    expect(html).toContain('Saturday to Thursday, 10am – 8pm');
    // `office.address_en` reads as "Address en": the category prefix is dropped, the rest is words.
    expect(html).toContain('Address en');
    expect(html).toContain('Telephone');
  });

  it('reports whether a setting is public, and offers no way to change that', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get('/settings/office');
    expect(html).toContain(EN.SiteSettings.publicBadge);
    // `is_public` is a migration decision, so it is reported and there is no control for it. The word itself
    // is in the flight payload as a prop name, which says nothing — what matters is that nothing can submit it.
    expect(html).not.toContain('name="isPublic"');
    expect(html).not.toContain('type="checkbox" id="office.telephone"');
  });

  it('offers no way to create or delete a setting, which is the property the surface rests on', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get('/settings/office');
    // A console that could mint a key could mint a *public* key.
    expect(html.toLowerCase()).not.toContain('add setting');
    expect(html.toLowerCase()).not.toContain('new setting');
    expect(html.toLowerCase()).not.toContain('delete setting');
    expect(html).not.toContain('name="valueType"');
    expect(html).not.toContain('name="category"');
  });

  it('renders eight editable fields in the state the platform actually ships in', async () => {
    // Every setting blank. A screen that listed only filled-in settings would have nothing to type into, which
    // is exactly the state 0113 exists to end.
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'shipped' });
    const { html } = await get('/settings/office');
    expect(html).toContain(EN.SiteSettings.officeHeading);
    for (const key of [
      'office.telephone',
      'office.whatsapp',
      'office.email',
      'office.address_en',
      'office.address_ar',
      'office.hours_en',
      'office.hours_ar',
      'office.social_links',
    ]) {
      expect(html, key).toContain(`id="${key}"`);
    }
  });

  it('says so plainly when the category is empty or the read failed', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'empty' });
    expect((await get('/settings/office')).html).toContain(EN.SiteSettings.empty);

    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'unavailable' });
    const failed = await get('/settings/office');
    expect(failed.status).toBe(200);
    expect(failed.html).toContain(EN.SiteSettings.unavailable);
    // An outage is not an empty category, and the screen must not report it as one.
    expect(failed.html).not.toContain(EN.SiteSettings.empty);
  });
});

describe('both languages', () => {
  it('renders the section in Arabic, right to left, with the Arabic descriptions', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN, locale: 'ar' } });
    const { status, html } = await get('/settings/office');
    expect(status).toBe(200);
    expect(html).toContain('dir="rtl"');
    expect(html).toContain(AR.Sections.siteSettings.title);
    expect(html).toContain(AR.SiteSettings.officeHeading);
    // The row's Arabic description, which is the reason both are stored.
    expect(html).toContain('رقم تليفون المكتب.');
    expect(html).not.toContain('The office telephone number.');
  });
});
