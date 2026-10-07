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
 * The navigation screens, over real HTTP against the built app (0094).
 *
 * Run against the built app rather than a unit harness for the reason the shell test is: what matters is what
 * actually reaches a browser, **including the streamed RSC payload** — so a control merely hidden with CSS would
 * fail these assertions and a control never rendered passes them.
 *
 * The cases this file exists for:
 *
 *   * **a guest, a buyer, staff at `aal1`, a Moderator and somebody who only composes the homepage receive none of
 *     this section** — and no read is performed. The last of those matters most: arranging the menus and composing
 *     the front page are separate keys, and this is where that is visible;
 *   * **the read/manage separation is on the screen.** A colleague holding `cms.navigation.read` and not
 *     `cms.navigation.manage` sees the menus and **not one control or any of their words**;
 *   * **owner decision 3 is explained, not just applied.** A menu that is placed and shown and can render nothing
 *     says so in as many words, because the public site skips it silently and this is the only place the reason
 *     exists; and an entry whose target was unpublished or deleted is marked with which of the two it is;
 *   * **owner decision 4 is explained too.** An entry pointing at a published page the site serves no address for
 *     is marked, because nothing else would ever say so;
 *   * **a menu under an unplaced key is named and explained** rather than silently inert;
 *   * **no promotion, placement, ranking or image control appears anywhere**;
 *   * both languages and the direction that goes with each.
 *
 * No browser, no Playwright, no live provider, no deployment.
 */

/** Obviously fake, 43 base64url characters. */
const CANARY_CREDENTIAL = 'test-navigation-screens-canary-notreal01234';

const EN = enMessages;
const AR = arMessages;

const ACCESS = '__Host-mp_admin_access=canary-admin-access-token-not-a-real-token';
const REFRESH = '__Host-mp_admin_refresh=canary-admin-refresh-token-not-a-real-tok';
const SESSION = `${ACCESS}; ${REFRESH}`;

const STAFF = '11111111-1111-4111-8111-111111111111';
const MENU = 'fd000000-0000-4000-8000-0000000000e1';
const ITEM = 'fd000000-0000-4000-8000-0000000000e2';
const CHILD = 'fd000000-0000-4000-8000-0000000000e3';
const PAGE = 'fd000000-0000-4000-8000-0000000000e4';

const READ = 'cms.navigation.read';
const MANAGE = 'cms.navigation.manage';

/** An administrator: both navigation keys, plus others this surface never consults. */
const ADMIN = [READ, MANAGE, 'users.profile.read'].sort();

/** A colleague who may read the arrangement and change none of it. */
const NAVIGATION_READER = [READ].sort();

const MODERATOR = ['moderation.report.read', 'moderation.action.read', 'reviews.review.read'].sort();

/** Somebody who composes the front page and does not arrange the menus: one module, two keys, two sections. */
const HOMEPAGE_ONLY = ['cms.homepage.read', 'cms.homepage.manage'].sort();

type Who =
  | { kind: 'staff'; permissions: string[]; locale?: 'en' | 'ar' }
  | { kind: 'staff-aal1' }
  | { kind: 'buyer' }
  | { kind: 'unauthenticated' };

type Data =
  | 'default'
  | 'two'
  | 'empty'
  | 'nothingToShow'
  | 'unplaced'
  | 'states'
  | 'unservable'
  | 'nested'
  | 'unavailable'
  | 'readerDetail';

interface Serve {
  readonly who: Who;
  readonly data?: Data;
}

let api: StubApi;
let app: RunningApp;

function itemFor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ITEM,
    parentId: null,
    depth: 1,
    labelEn: 'About',
    labelAr: null,
    targetKind: 'page',
    pageId: PAGE,
    blogPostId: null,
    categoryId: null,
    path: null,
    targetSlug: 'about',
    targetTitle: 'About us',
    targetState: 'public',
    opensInNewTab: false,
    sortOrder: 10,
    isActive: true,
    createdAt: '2026-04-01T09:00:00.000Z',
    updatedAt: '2026-05-02T09:00:00.000Z',
    ...overrides,
  };
}

function summaryFor(data: Data): Record<string, unknown> {
  const base = {
    id: MENU,
    menuKey: 'header',
    labelEn: 'Header',
    labelAr: null,
    isActive: true,
    isServed: true,
    itemCount: 2,
    renderableItemCount: 1,
    createdAt: '2026-04-01T09:00:00.000Z',
    updatedAt: '2026-05-02T09:00:00.000Z',
  };
  if (data === 'unplaced') return { ...base, menuKey: 'sidebar', isServed: false, renderableItemCount: 0 };
  // Placed, shown, and nothing left to render: the state owner decision 3 produces.
  if (data === 'nothingToShow') return { ...base, itemCount: 2, renderableItemCount: 0 };
  return base;
}

function itemsFor(data: Data): readonly Record<string, unknown>[] {
  if (data === 'empty') return [];
  if (data === 'states') {
    return [
      itemFor(),
      itemFor({ id: CHILD, labelEn: 'Hidden target', targetState: 'not_public', targetSlug: 'nav-draft' }),
      itemFor({ id: PAGE, labelEn: 'Gone target', targetState: 'missing', targetSlug: null, targetTitle: null }),
    ];
  }
  if (data === 'unservable') {
    // Published, and at an address the application serves no page for — owner decision 4.
    return [itemFor({ labelEn: 'Unservable', targetSlug: 'nav-made-up-page' })];
  }
  if (data === 'nested') {
    return [
      itemFor({ labelEn: 'Company', targetKind: 'path', pageId: null, path: '/about', targetSlug: null }),
      itemFor({ id: CHILD, parentId: ITEM, depth: 2, labelEn: 'About us' }),
    ];
  }
  if (data === 'two') {
    return [itemFor(), itemFor({ id: CHILD, labelEn: 'Terms', sortOrder: 20 })];
  }
  if (data === 'nothingToShow') {
    return [itemFor({ targetState: 'not_public' }), itemFor({ id: CHILD, targetState: 'missing' })];
  }
  return [itemFor()];
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

    if (path === '/v1/admin/navigation/menus') {
      if (!held(READ)) return problem(response, 404, 'NOT_FOUND');
      if (data === 'unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      const listed = data === 'empty' ? [] : [summaryFor(data)];
      return json(response, {
        menus: listed,
        canManage: data === 'readerDetail' ? false : held(MANAGE),
      });
    }

    if (path === `/v1/admin/navigation/menus/${MENU}`) {
      if (!held(READ)) return problem(response, 404, 'NOT_FOUND');
      if (data === 'unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      return json(response, {
        menu: {
          ...summaryFor(data),
          canManage: data === 'readerDetail' ? false : held(MANAGE),
          items: itemsFor(data),
        },
      });
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
  app = await startBuiltApp({ API_BASE_URL: api.baseUrl, INTERNAL_BFF_CREDENTIAL: CANARY_CREDENTIAL });
}, 120_000);

afterAll(async () => {
  await app.stop();
  await api.stop();
});

/* ------------------------------------------------------------------------------------------------ */

describe('who may open the section at all', () => {
  it('refuses a guest, a buyer and staff at aal1, each neutrally', async () => {
    for (const who of [{ kind: 'unauthenticated' }, { kind: 'buyer' }, { kind: 'staff-aal1' }] as const) {
      apiServes({ who });
      const { html } = await get('/cms/navigation');
      expect(html, who.kind).not.toContain(EN.Navigation.listHeading);
      // Not one read was performed for a caller who may not be here.
      expect(
        api.seen.some((entry) => entry.url.startsWith('/v1/admin/navigation')),
        who.kind,
      ).toBe(false);
    }
  });

  it('refuses a Moderator and somebody who only composes the homepage', async () => {
    for (const permissions of [MODERATOR, HOMEPAGE_ONLY]) {
      apiServes({ who: { kind: 'staff', permissions: [...permissions] } });
      const { html } = await get('/cms/navigation');
      expect(html, permissions.join(',')).not.toContain(EN.Navigation.listHeading);
      expect(html, permissions.join(',')).not.toContain(EN.Navigation.addHeading);
    }
  });

  it('lets an administrator in', async () => {
    apiServes({ who: { kind: 'staff', permissions: [...ADMIN] } });
    const { status, html } = await get('/cms/navigation');
    expect(status).toBe(200);
    expect(html).toContain(EN.Sections.navigation.title);
    expect(html).toContain(EN.Navigation.listHeading);
    expect(html).toContain('header');
  });
});

describe('the menu list', () => {
  it('shows what each menu holds and how much of it the public sees', async () => {
    apiServes({ who: { kind: 'staff', permissions: [...ADMIN] } });
    const { html } = await get('/cms/navigation');
    expect(html).toContain('Header');
    expect(html).toContain(EN.Navigation.shown);
    // "1 of 2 shown" — the count that makes owner decision 3 visible.
    expect(html).toContain('1');
  });

  it('names a menu the site does not place', async () => {
    apiServes({ who: { kind: 'staff', permissions: [...ADMIN] }, data: 'unplaced' });
    const { html } = await get('/cms/navigation');
    expect(html).toContain(EN.Navigation.notPlaced);
  });

  it('warns that a shown menu can render nothing', async () => {
    apiServes({ who: { kind: 'staff', permissions: [...ADMIN] }, data: 'nothingToShow' });
    const { html } = await get('/cms/navigation');
    expect(html).toContain(EN.Navigation.nothingToShow);
  });

  it('says so when there are no menus at all', async () => {
    apiServes({ who: { kind: 'staff', permissions: [...ADMIN] }, data: 'empty' });
    const { html } = await get('/cms/navigation');
    expect(html).toContain(EN.Navigation.emptyTitle);
  });

  it('says what this screen does not do', async () => {
    // Banners, FAQs and the locale switch are all out of scope, and an operator should not have to guess.
    apiServes({ who: { kind: 'staff', permissions: [...ADMIN] } });
    const { html } = await get('/cms/navigation');
    expect(html).toContain(EN.Navigation.notHereTitle);
  });

  it('reports an outage rather than an empty arrangement', async () => {
    apiServes({ who: { kind: 'staff', permissions: [...ADMIN] }, data: 'unavailable' });
    const { html } = await get('/cms/navigation');
    expect(html).toContain(EN.Navigation.unavailableTitle);
    expect(html).not.toContain(EN.Navigation.emptyTitle);
  });
});

describe('the read and manage keys are separate on the screen', () => {
  it('gives a reader the menus and not one control, nor any of their words', async () => {
    apiServes({ who: { kind: 'staff', permissions: [...NAVIGATION_READER] } });
    const { status, html } = await get('/cms/navigation');
    expect(status).toBe(200);
    expect(html).toContain(EN.Navigation.listHeading);
    // Not the panel, not the button, and not the words either: a client component's whole props object is
    // serialised into the RSC payload, so a control rendered and hidden would still leak its labels.
    expect(html).not.toContain(EN.Navigation.addHeading);
    expect(html).not.toContain(EN.Navigation.keyHint);
    expect(html).not.toContain(EN.Navigation.saveSubmit);
  });

  it('gives a reader the menu detail and none of its controls', async () => {
    apiServes({ who: { kind: 'staff', permissions: [...NAVIGATION_READER] }, data: 'readerDetail' });
    const { status, html } = await get(`/cms/navigation/${MENU}`);
    expect(status).toBe(200);
    expect(html).toContain(EN.Navigation.entriesHeading);
    expect(html).toContain('About');
    expect(html).not.toContain(EN.Navigation.addEntryHeading);
    expect(html).not.toContain(EN.Navigation.removeMenu);
    expect(html).not.toContain(EN.Navigation.promote);
    expect(html).not.toContain(EN.Navigation.pathHint);
    expect(html).not.toContain(EN.Navigation.reorderHint);
  });

  it('gives a manager every control', async () => {
    apiServes({ who: { kind: 'staff', permissions: [...ADMIN] }, data: 'two' });
    const { html } = await get(`/cms/navigation/${MENU}`);
    expect(html).toContain(EN.Navigation.addEntryHeading);
    expect(html).toContain(EN.Navigation.removeMenu);
    expect(html).toContain(EN.Navigation.pathHint);
    // Two top-level entries, so there is an order to change.
    expect(html).toContain(EN.Navigation.reorderHint);
  });

  it('offers no reorder when there is nothing to reorder', async () => {
    apiServes({ who: { kind: 'staff', permissions: [...ADMIN] } });
    const { html } = await get(`/cms/navigation/${MENU}`);
    // The hint rather than the one-word heading: "Order" is a substring of `sortOrder`, which the row controls
    // legitimately carry, so the heading alone is not a signal.
    expect(html).not.toContain(EN.Navigation.reorderHint);
  });

  it('offers promotion only for an entry that sits under a heading', async () => {
    apiServes({ who: { kind: 'staff', permissions: [...ADMIN] }, data: 'nested' });
    const nested = await get(`/cms/navigation/${MENU}`);
    expect(nested.html).toContain(EN.Navigation.promote);

    apiServes({ who: { kind: 'staff', permissions: [...ADMIN] } });
    const flat = await get(`/cms/navigation/${MENU}`);
    expect(flat.html).not.toContain(EN.Navigation.promote);
  });
});

describe('the menu detail explains what the public is not shown', () => {
  it('marks an entry whose target is unpublished and one whose target is gone', async () => {
    apiServes({ who: { kind: 'staff', permissions: [...ADMIN] }, data: 'states' });
    const { html } = await get(`/cms/navigation/${MENU}`);
    expect(html).toContain(EN.Navigation.targetNotPublic);
    expect(html).toContain(EN.Navigation.targetMissing);
    // And the target's own title, so an operator can recognise the row being pointed at.
    expect(html).toContain('About us');
  });

  it('marks an entry pointing at a page the site serves no address for', async () => {
    // Owner decision 4: published, and still omitted from the public navigation. Only this screen can say so.
    apiServes({ who: { kind: 'staff', permissions: [...ADMIN] }, data: 'unservable' });
    const { html } = await get(`/cms/navigation/${MENU}`);
    expect(html).toContain(EN.Navigation.targetUnservable);
  });

  it('does not mark an entry pointing at a page the site does serve', async () => {
    apiServes({ who: { kind: 'staff', permissions: [...ADMIN] } });
    const { html } = await get(`/cms/navigation/${MENU}`);
    expect(html).not.toContain(EN.Navigation.targetUnservable);
  });

  it('explains a menu that is shown and can render nothing', async () => {
    apiServes({ who: { kind: 'staff', permissions: [...ADMIN] }, data: 'nothingToShow' });
    const { html } = await get(`/cms/navigation/${MENU}`);
    expect(html).toContain(EN.Navigation.nothingToShowBody);
  });

  it('explains a menu the site does not place', async () => {
    apiServes({ who: { kind: 'staff', permissions: [...ADMIN] }, data: 'unplaced' });
    const { html } = await get(`/cms/navigation/${MENU}`);
    expect(html).toContain(EN.Navigation.notPlacedBody);
  });

  it('says so when a menu holds no entries', async () => {
    apiServes({ who: { kind: 'staff', permissions: [...ADMIN] }, data: 'empty' });
    const { html } = await get(`/cms/navigation/${MENU}`);
    expect(html).toContain(EN.Navigation.noEntriesTitle);
  });

  it('shows a second level under its heading', async () => {
    apiServes({ who: { kind: 'staff', permissions: [...ADMIN] }, data: 'nested' });
    const { html } = await get(`/cms/navigation/${MENU}`);
    expect(html).toContain('Company');
    expect(html).toContain('About us');
  });

  it('answers a menu that does not exist the way it answers one you may not read', async () => {
    apiServes({ who: { kind: 'staff', permissions: [...ADMIN] } });
    const { html } = await get('/cms/navigation/fd000000-0000-4000-8000-00000000ffff');
    expect(html).toContain(EN.Navigation.notFoundTitle);
  });
});

describe('nothing financial, promotional or visual is on these screens', () => {
  it('offers no promotion, placement, ranking or image control anywhere', async () => {
    apiServes({ who: { kind: 'staff', permissions: [...ADMIN] }, data: 'nested' });
    const list = await get('/cms/navigation');
    const detail = await get(`/cms/navigation/${MENU}`);
    for (const html of [list.html, detail.html]) {
      // Asserted as field names rather than as words, because the screen mentions banners on purpose — to say
      // where they are arranged instead — and a prose mention is the opposite of a control.
      for (const name of [
        'promotionId',
        'placement',
        'ranking',
        'promoted',
        'mediaId',
        'imageId',
        'bannerId',
        'priceMinor',
      ]) {
        expect(html, name).not.toContain(`name="${name}"`);
      }
      // No image anywhere: `navigation_items` has no media column and there is no origin to address one with.
      expect(html).not.toContain('<img');
      // And no word that could only come from a financial field.
      for (const word of ['wallet', 'payout', 'settlement', 'commission']) {
        expect(html.toLowerCase(), word).not.toContain(word);
      }
    }
  });
});

describe('both languages', () => {
  it('renders the section in Arabic, mirrored', async () => {
    apiServes({ who: { kind: 'staff', permissions: [...ADMIN], locale: 'ar' } });
    const { html } = await get('/cms/navigation');
    expect(html).toContain('dir="rtl"');
    expect(html).toContain(AR.Sections.navigation.title);
    expect(html).toContain(AR.Navigation.listHeading);
  });

  it('explains the two warnings in Arabic too', async () => {
    apiServes({ who: { kind: 'staff', permissions: [...ADMIN], locale: 'ar' }, data: 'nothingToShow' });
    const { html } = await get(`/cms/navigation/${MENU}`);
    expect(html).toContain(AR.Navigation.nothingToShow);

    apiServes({ who: { kind: 'staff', permissions: [...ADMIN], locale: 'ar' }, data: 'unplaced' });
    const unplaced = await get(`/cms/navigation/${MENU}`);
    expect(unplaced.html).toContain(AR.Navigation.notPlaced);
  });
});
