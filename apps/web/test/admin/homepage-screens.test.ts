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
 * The homepage composition screens, over real HTTP against the built app (0093).
 *
 * Run against the built app rather than a unit harness for the reason the shell test is: what matters is what
 * actually reaches a browser, **including the streamed RSC payload** — so a control merely hidden with CSS would
 * fail these assertions and a control never rendered passes them.
 *
 * The cases this file exists for:
 *
 *   * **a guest, a buyer, staff at `aal1`, a Moderator and somebody who maintains only the blog receive none of
 *     this section** — and no read is performed. The last of those matters most: composing the homepage and
 *     writing the blog are separate keys, and this is where that is visible;
 *   * **the read/manage separation is on the screen.** A colleague holding `cms.homepage.read` and not
 *     `cms.homepage.manage` sees the sections and **not one control or any of their words**;
 *   * **owner decision C is explained, not just applied.** A section that is shown but can render nothing says so
 *     in as many words, because the public homepage skips it silently and this is the only place the reason exists;
 *   * **an unserved type is named and explained** rather than silently missing — the banner strip above all;
 *   * **a misconfigured section is marked**, which is the one check only this layer can make;
 *   * **no promotion, placement, ranking or image control appears anywhere**;
 *   * both languages and the direction that goes with each.
 *
 * No browser, no Playwright, no live provider, no deployment.
 */

const CANARY_CREDENTIAL = 'test-homepage-screens-canary-notreal0123456';

const EN = enMessages;
const AR = arMessages;

const ACCESS = '__Host-mp_admin_access=canary-admin-access-token-not-a-real-token';
const REFRESH = '__Host-mp_admin_refresh=canary-admin-refresh-token-not-a-real-tok';
const SESSION = `${ACCESS}; ${REFRESH}`;

const STAFF = '11111111-1111-4111-8111-111111111111';
const SECTION = 'fc000000-0000-4000-8000-0000000000e1';
const SECOND = 'fc000000-0000-4000-8000-0000000000e2';

const READ = 'cms.homepage.read';
const MANAGE = 'cms.homepage.manage';

/** An administrator: both homepage keys, plus others this surface never consults. */
const ADMIN = [READ, MANAGE, 'users.profile.read'].sort();

/** A colleague who may read the composition and change none. */
const HOMEPAGE_READER = [READ].sort();

const MODERATOR = ['moderation.report.read', 'moderation.action.read', 'reviews.review.read'].sort();

/** Somebody who writes the blog and does not compose the homepage: one module, two keys, two sections. */
const BLOG_ONLY = ['cms.blog.read', 'cms.blog.manage'].sort();

type Who =
  | { kind: 'staff'; permissions: string[]; locale?: 'en' | 'ar' }
  | { kind: 'staff-aal1' }
  | { kind: 'buyer' }
  | { kind: 'unauthenticated' };

type Data =
  | 'default'
  | 'two'
  | 'empty'
  | 'skipped'
  | 'unserved'
  | 'misconfigured'
  | 'unavailable'
  | 'readerDetail';

interface Serve {
  readonly who: Who;
  readonly data?: Data;
}

let api: StubApi;
let app: RunningApp;

function summaryFor(data: Data): Record<string, unknown> {
  const base = {
    id: SECTION,
    sectionKey: 'home_picks',
    sectionType: 'featured_listings',
    titleEn: 'Our picks',
    titleAr: null,
    sortOrder: 20,
    isActive: true,
    isServed: true,
    isConfigured: true,
    updatedAt: '2026-05-02T09:00:00.000Z',
  };
  if (data === 'unserved') {
    return { ...base, sectionKey: 'home_strip', sectionType: 'banner_strip', isServed: false, isConfigured: false };
  }
  if (data === 'misconfigured') return { ...base, isConfigured: false };
  return base;
}

function detailFor(data: Data, canManage: boolean): Record<string, unknown> {
  const base = {
    id: SECTION,
    sectionKey: 'home_picks',
    sectionType: 'featured_listings',
    titleEn: 'Our picks',
    titleAr: null,
    subtitleEn: null,
    subtitleAr: null,
    config: { ids: ['22222222-2222-4222-8222-222222222222'] },
    sortOrder: 20,
    isActive: true,
    isServed: true,
    isConfigured: true,
    createdAt: '2026-04-01T09:00:00.000Z',
    updatedAt: '2026-05-02T09:00:00.000Z',
    canManage,
    chosenCount: 4,
    renderableCount: 2,
  };
  // Shown, and nothing left to render: the state owner decision C produces, and the one the console must explain.
  if (data === 'skipped') return { ...base, chosenCount: 4, renderableCount: 0 };
  if (data === 'unserved') {
    return {
      ...base,
      sectionKey: 'home_strip',
      sectionType: 'banner_strip',
      isServed: false,
      isConfigured: false,
      config: {},
      chosenCount: 0,
      renderableCount: 0,
    };
  }
  if (data === 'misconfigured') return { ...base, isConfigured: false, config: { count: 4 } };
  return base;
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

    if (path === '/v1/admin/homepage/sections') {
      if (!held(READ)) return problem(response, 404, 'NOT_FOUND');
      if (data === 'unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      const listed =
        data === 'empty'
          ? []
          : data === 'two'
            ? [summaryFor('default'), { ...summaryFor('default'), id: SECOND, sectionKey: 'home_latest' }]
            : [summaryFor(data)];
      return json(response, {
        sections: listed,
        canManage: data === 'readerDetail' ? false : held(MANAGE),
      });
    }

    if (path === `/v1/admin/homepage/sections/${SECTION}`) {
      if (!held(READ)) return problem(response, 404, 'NOT_FOUND');
      if (data === 'unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      return json(response, { section: detailFor(data, data === 'readerDetail' ? false : held(MANAGE)) });
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

beforeAll(async () => {
  api = await startStubApi();
  app = await startBuiltApp({
    API_BASE_URL: api.baseUrl,
    INTERNAL_BFF_CREDENTIAL: CANARY_CREDENTIAL,
  });
}, 180_000);

afterAll(async () => {
  await app?.stop();
  await api?.stop();
});

describe('who receives none of this section', () => {
  it('shows a guest, a buyer, staff at aal1, a moderator and a blog-only maintainer nothing', async () => {
    for (const who of [
      { kind: 'unauthenticated' } as const,
      { kind: 'buyer' } as const,
      { kind: 'staff-aal1' } as const,
      { kind: 'staff', permissions: MODERATOR } as const,
      // Writing the blog and composing the homepage are different jobs behind different seeded keys.
      { kind: 'staff', permissions: BLOG_ONLY } as const,
    ]) {
      apiServes({ who });
      for (const path of ['/cms/homepage', `/cms/homepage/${SECTION}`]) {
        const { html } = await get(path);
        const label = `${who.kind}:${JSON.stringify('permissions' in who ? who.permissions : [])}:${path}`;
        expect(html, label).not.toContain('Our picks');
        expect(html, label).not.toContain('home_picks');
        expect(html, label).not.toContain(EN.Homepage.saveSubmit);
        expect(html, label).not.toContain(EN.Homepage.showSection);
      }
      expect(api.seen.filter((entry) => entry.url.startsWith('/v1/admin/homepage')), who.kind).toEqual([]);
    }
  });
});

describe('the read and manage keys are separate on the screen', () => {
  it('gives a reader the sections and not one control', async () => {
    apiServes({ who: { kind: 'staff', permissions: HOMEPAGE_READER }, data: 'readerDetail' });

    const list = await get('/cms/homepage');
    expect(list.status).toBe(200);
    expect(list.html).toContain('home_picks');
    // Not one word of a control: the add panel and the reorder form both read the capability and render nothing.
    expect(list.html).not.toContain(EN.Homepage.addHeading);
    expect(list.html).not.toContain(EN.Homepage.reorderNotice);
    expect(list.html).not.toContain(EN.Homepage.hiddenNotice);

    const detail = await get(`/cms/homepage/${SECTION}`);
    expect(detail.status).toBe(200);
    expect(detail.html).toContain(EN.Homepage.readOnlyTitle);
    expect(detail.html).not.toContain(EN.Homepage.saveSubmit);
    expect(detail.html).not.toContain(EN.Homepage.showSection);
    expect(detail.html).not.toContain(EN.Homepage.hideSection);
    expect(detail.html).not.toContain(EN.Homepage.removeSection);
  });

  it('gives a manager every control', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });

    const list = await get('/cms/homepage');
    expect(list.html).toContain(EN.Homepage.addHeading);

    const detail = await get(`/cms/homepage/${SECTION}`);
    expect(detail.html).toContain(EN.Homepage.saveSubmit);
    expect(detail.html).toContain(EN.Homepage.removeSection);
    expect(detail.html).not.toContain(EN.Homepage.readOnlyTitle);
  });

  it('offers exactly one visibility word, never both', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const shown = await get(`/cms/homepage/${SECTION}`);
    // A client component's whole props object is serialised into the RSC payload, so passing both labels would put
    // the wrong one in the page's own source. The section is shown, so only "hide" may appear.
    expect(shown.html).toContain(EN.Homepage.hideSection);
    expect(shown.html).not.toContain(EN.Homepage.showSection);
  });
});

describe('editing cannot publish', () => {
  it('keeps visibility in its own panel, with its own words', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get(`/cms/homepage/${SECTION}`);
    expect(html).toContain(EN.Homepage.editHeading);
    expect(html).toContain(EN.Homepage.stateHeading);
    // And the editing panel says plainly that saving does not show the section.
    expect(html).toContain(EN.Homepage.noPublishNotice);
  });
});

describe('what the section explains', () => {
  it('says why a shown section renders nothing', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'skipped' });
    const { html } = await get(`/cms/homepage/${SECTION}`);
    // Owner decision C: the public homepage skips it silently, so this is the only place the reason exists.
    expect(html).toContain(EN.Homepage.skippedTitle);
    expect(html).toContain(EN.Homepage.skippedBody);
  });

  it('does not cry wolf about a section that still renders', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get(`/cms/homepage/${SECTION}`);
    expect(html).not.toContain(EN.Homepage.skippedTitle);
    expect(html).toContain(EN.Homepage.countsHeading);
  });

  it('names an unserved type and explains why, rather than leaving it a mystery', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'unserved' });
    const { html } = await get(`/cms/homepage/${SECTION}`);
    expect(html).toContain(EN.Homepage.notServedTitle);
    expect(html).toContain(EN.Homepage.notServedBody);
    // And the list marks it too, so it is visible before anybody opens it.
    const list = await get('/cms/homepage');
    expect(list.html).toContain(EN.Homepage.notServed);
    expect(list.html).toContain('home_strip');
  });

  it('marks a misconfigured section, which is the one check only the console can make', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'misconfigured' });
    const detail = await get(`/cms/homepage/${SECTION}`);
    expect(detail.html).toContain(EN.Homepage.notConfiguredTitle);
    expect(detail.html).toContain(EN.Homepage.notConfiguredBody);
    const list = await get('/cms/homepage');
    expect(list.html).toContain(EN.Homepage.notConfigured);
  });

  it('states the absences an operator would otherwise discover', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const list = await get('/cms/homepage');
    // No paid promotion, no images, no navigation, no FAQs — said rather than silently missing.
    expect(list.html).toContain(EN.Homepage.notHereTitle);
    expect(list.html).toContain(EN.Homepage.notHereBody);
    expect(list.html).toContain(EN.Homepage.typesBody);
  });

  it('offers no promotion, placement, ranking or image control anywhere', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const detail = await get(`/cms/homepage/${SECTION}`);
    for (const name of ['promotionId', 'placement', 'ranking', 'promoted', 'mediaId', 'imageId', 'bannerId']) {
      expect(detail.html, name).not.toContain(`name="${name}"`);
      expect(detail.html, name).not.toContain(`id="homepage-edit-${name}"`);
    }
  });
});

describe('the list', () => {
  it('tells an uncomposed homepage from one that could not be read', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'empty' });
    const empty = await get('/cms/homepage');
    expect(empty.status).toBe(200);
    expect(empty.html).toContain(EN.Homepage.emptyTitle);
    expect(empty.html).not.toContain(EN.Homepage.unavailableTitle);

    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'unavailable' });
    const broken = await get('/cms/homepage');
    expect(broken.status).toBe(200);
    expect(broken.html).toContain(EN.Homepage.unavailableTitle);
    expect(broken.html).not.toContain(EN.Homepage.emptyTitle);
  });

  it('offers no reorder control for a single section, and not its words either', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get('/cms/homepage');
    // One section: there is no order to change. Decided on the server, so not even the labels reach the payload —
    // a client component that returned null would still have carried them here.
    expect(html).not.toContain(EN.Homepage.reorderSubmit);
    expect(html).not.toContain(EN.Homepage.reorderNotice);
    expect(html).not.toContain(EN.Homepage.moveUp);
  });

  it('offers the reorder control once there are two sections to order', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'two' });
    const { html } = await get('/cms/homepage');
    expect(html).toContain(EN.Homepage.reorderNotice);
    expect(html).toContain(EN.Homepage.reorderSubmit);
    expect(html).toContain('home_latest');
  });

  it('withholds the reorder control from a reader even with two sections', async () => {
    apiServes({ who: { kind: 'staff', permissions: HOMEPAGE_READER }, data: 'two' });
    const { html } = await get('/cms/homepage');
    expect(html).toContain('home_latest');
    expect(html).not.toContain(EN.Homepage.reorderSubmit);
  });
});

describe('both languages', () => {
  it('renders Arabic right to left with the Arabic words', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN, locale: 'ar' } });
    const { html } = await get('/cms/homepage');
    expect(html).toContain('dir="rtl"');
    expect(html).toContain(AR.Sections.homepage.title);
    expect(html).toContain(AR.Homepage.listHeading);
    expect(html).toContain(AR.Homepage.notHereBody);
  });

  it('renders English left to right with the English words', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get('/cms/homepage');
    expect(html).toContain('dir="ltr"');
    expect(html).toContain(EN.Sections.homepage.title);
    expect(html).toContain(EN.Homepage.listHeading);
  });
});

describe('a section that is not there', () => {
  it('reads the same as one this caller may not see', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { status, html } = await get('/cms/homepage/fc000000-0000-4000-8000-00000000dead');
    expect(status).toBe(200);
    expect(html).toContain(EN.Homepage.notFoundTitle);
    expect(html).toContain(EN.Homepage.notFoundBody);
  });

  it('is the same message for an address that could not name a section', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get('/cms/homepage/not-a-uuid');
    expect(html).toContain(EN.Homepage.notFoundTitle);
    // Nothing was asked upstream: a string that cannot be an identifier names nothing.
    expect(api.seen.filter((entry) => entry.url.includes('not-a-uuid'))).toEqual([]);
  });
});
