import type { ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import arMessages from '../messages/ar.json';
import enMessages from '../messages/en.json';
import { startBuiltApp, type RunningApp } from './support/next-server.js';
import { problem, startStubApi, type StubApi } from './support/stub-api.js';

/**
 * The CMS static page screens, over real HTTP against the built app.
 *
 * Run against the built app rather than a unit harness for the reason the shell test is: what matters is what
 * actually reaches a browser, **including the streamed RSC payload** — which is why a control that is merely
 * hidden with CSS would fail these assertions and a control that is never rendered passes them.
 *
 * The cases this file exists for:
 *
 *   * **a guest, a buyer, staff at `aal1`, a Moderator and a Support Agent receive none of this section** — no
 *     page, no slug, no body — in the markup or in the flight data, and no read is performed;
 *   * **the read/manage separation is on the screen.** A colleague holding `cms.page.read` and not
 *     `cms.page.manage` sees the list, the page and its text, and **not one authoring control or any of their
 *     words**. The capability comes from the server's own answer, so this is the assertion that fails if
 *     somebody later decides it from a role name;
 *   * **a page that has not been written is visibly the one that cannot be published**, rather than looking
 *     like an ordinary row;
 *   * **the previous addresses are shown with what they mean**, because a colleague renaming a page needs to
 *     know the old address keeps working and can never be reused;
 *   * both languages and the direction that goes with each.
 *
 * No browser, no Playwright, no live provider, no deployment.
 */

const CANARY_CREDENTIAL = 'test-cms-pages-canary-notreal01234567890abc';

const EN = enMessages;
const AR = arMessages;

const ACCESS = '__Host-mp_admin_access=canary-admin-access-token-not-a-real-token';
const REFRESH = '__Host-mp_admin_refresh=canary-admin-refresh-token-not-a-real-tok';
const SESSION = `${ACCESS}; ${REFRESH}`;

const STAFF = '11111111-1111-4111-8111-111111111111';
const PAGE = 'fe000000-0000-4000-8000-00000000c115';
const UNWRITTEN = 'fe000000-0000-4000-8000-00000000c116';

const READ = 'cms.page.read';
const MANAGE = 'cms.page.manage';

/** An administrator: both page keys, plus others this surface never consults. */
const ADMIN = [READ, MANAGE, 'users.profile.read'].sort();

/** A colleague who may read pages and change none — the read/manage separation, on a screen. */
const PAGE_READER = [READ].sort();

/** A moderator, who by the platform's own decision holds neither page key. */
const MODERATOR = ['moderation.report.read', 'moderation.action.read', 'reviews.review.read'].sort();

/** A support agent, likewise. */
const SUPPORT = ['support.ticket.read', 'support.ticket.manage', 'users.profile.read'].sort();

type Who =
  | { kind: 'staff'; permissions: string[]; locale?: 'en' | 'ar' }
  | { kind: 'staff-aal1' }
  | { kind: 'buyer' }
  | { kind: 'unauthenticated' };

type Data =
  | 'default'
  | 'unwritten'
  | 'unavailable'
  | 'readerDetail'
  | 'offListSlug'
  /** 0099: a page with a cover attached, and one whose attached entry has no alt text. */
  | 'withCover'
  | 'withUnlabelledCover';

interface Serve {
  readonly who: Who;
  readonly data?: Data;
}

let api: StubApi;
let app: RunningApp;

const SUMMARY = {
  id: PAGE,
  slug: 'terms',
  pageKey: 'terms',
  status: 'published',
  template: 'legal',
  isIndexable: true,
  sortOrder: 10,
  scheduledFor: null,
  publishedAt: '2026-05-01T09:00:00.000Z',
  archivedAt: null,
  updatedAt: '2026-05-02T09:00:00.000Z',
  translatedLocales: ['en'],
  title: 'Terms of Service',
};

/** A page nobody has written: no locale, no title. This is the state that cannot be published. */
const UNWRITTEN_SUMMARY = {
  ...SUMMARY,
  id: UNWRITTEN,
  slug: 'privacy',
  pageKey: null,
  status: 'draft',
  publishedAt: null,
  translatedLocales: [],
  title: null,
};

const DETAIL = {
  ...SUMMARY,
  createdAt: '2026-04-01T09:00:00.000Z',
  canManage: true,
  previousSlugs: ['terms-old'],
  coverMediaId: null,
  coverObjectPath: null,
  coverAltTextEn: null,
  coverAltTextAr: null,
  translations: [
    {
      localeCode: 'en',
      title: 'Terms of Service',
      excerpt: null,
      body: 'The body of the terms.',
      metaTitle: 'Terms',
      metaDescription: 'Our terms.',
      updatedAt: '2026-05-02T09:00:00.000Z',
    },
  ],
};

/** An attached cover, as the API reports one: a stored path and the alt text somebody wrote. Never a URL. */
const COVER = {
  coverMediaId: 'fe000000-0000-4000-8000-0000000000a1',
  coverObjectPath: 'cms-media/1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d.png',
  coverAltTextEn: 'A harbour at dawn',
  coverAltTextAr: 'ميناء عند الفجر',
};

/** Alt text is optional in the library, so the console has to render an attachment that has none. */
const UNLABELLED_COVER = {
  coverMediaId: 'fe000000-0000-4000-8000-0000000000a2',
  coverObjectPath: 'cms-media/2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e.webp',
  coverAltTextEn: null,
  coverAltTextAr: null,
};

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

    // The API's own gating, modelled: every read answers 404 for a caller without the read key.
    if (path === '/v1/admin/cms/pages') {
      if (!held(READ)) return problem(response, 404, 'NOT_FOUND');
      if (data === 'unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      return json(response, {
        items: data === 'unwritten' ? [UNWRITTEN_SUMMARY] : [SUMMARY],
        nextCursor: null,
      });
    }

    if (path === `/v1/admin/cms/pages/${PAGE}`) {
      if (!held(READ)) return problem(response, 404, 'NOT_FOUND');
      if (data === 'unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      // The manage capability is the server's answer, which is exactly what the screen must render from.
      return json(response, {
        page: {
          ...DETAIL,
          ...(data === 'offListSlug' ? { slug: 'seasonal-campaign' } : {}),
          ...(data === 'withCover' ? COVER : {}),
          ...(data === 'withUnlabelledCover' ? UNLABELLED_COVER : {}),
          canManage: data === 'readerDetail' ? false : held(MANAGE),
        },
      });
    }

    return problem(response, 404, 'NOT_FOUND');
  });
}

async function get(path: string, cookie: string | null = SESSION): Promise<{ status: number; html: string }> {
  const response = await fetch(`${app.baseUrl}${path}`, {
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
  it('shows a guest, a buyer, staff at aal1, a moderator and a support agent nothing about any page', async () => {
    for (const who of [
      { kind: 'unauthenticated' } as const,
      { kind: 'buyer' } as const,
      { kind: 'staff-aal1' } as const,
      { kind: 'staff', permissions: MODERATOR } as const,
      { kind: 'staff', permissions: SUPPORT } as const,
    ]) {
      apiServes({ who });
      for (const path of ['/cms/pages', `/cms/pages/${PAGE}`]) {
        const { html } = await get(path);
        const label = `${who.kind}:${path}`;
        // Not the page, not its address, not its text — in markup or in flight data.
        expect(html, label).not.toContain('Terms of Service');
        expect(html, label).not.toContain('terms-old');
        expect(html, label).not.toContain('The body of the terms.');
        // And not one authoring control.
        expect(html, label).not.toContain(EN.Cms.createSubmit);
        expect(html, label).not.toContain(EN.Cms.statusSubmit);
      }
      // No read was attempted against the pages surface for any of them.
      expect(api.seen.filter((entry) => entry.url.startsWith('/v1/admin/cms/pages')), who.kind).toEqual([]);
    }
  });
});

describe('the read and manage keys are separate on the screen', () => {
  it('gives a reader the list, the page and its text, and not one control', async () => {
    apiServes({ who: { kind: 'staff', permissions: PAGE_READER }, data: 'readerDetail' });

    const list = await get('/cms/pages');
    expect(list.status).toBe(200);
    expect(list.html).toContain('Terms of Service');
    // The create panel's words are absent entirely, not hidden.
    expect(list.html).not.toContain(EN.Cms.createSubmit);
    expect(list.html).not.toContain(EN.Cms.slugHint);

    const detail = await get(`/cms/pages/${PAGE}`);
    expect(detail.status).toBe(200);
    expect(detail.html).toContain('terms');
    expect(detail.html).toContain(EN.Cms.readOnlyBody);
    for (const absent of [
      EN.Cms.settingsSubmit,
      EN.Cms.statusSubmit,
      EN.Cms.translationSubmit,
      EN.Cms.translationRemove,
      EN.Cms.indexableLabel,
      EN.Cms.bodyLabel,
    ]) {
      expect(detail.html, absent).not.toContain(absent);
    }
  });

  it('gives a manager every control, and no read-only notice', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });

    const list = await get('/cms/pages');
    expect(list.html).toContain(EN.Cms.createSubmit);

    const detail = await get(`/cms/pages/${PAGE}`);
    expect(detail.status).toBe(200);
    for (const present of [
      EN.Cms.settingsSubmit,
      EN.Cms.statusSubmit,
      EN.Cms.translationSubmit,
      EN.Cms.indexableLabel,
      EN.Cms.bodyLabel,
    ]) {
      expect(detail.html, present).toContain(present);
    }
    expect(detail.html).not.toContain(EN.Cms.readOnlyBody);
  });
});

describe('what the screens say about a page', () => {
  it('shows a page that has not been written as the one that cannot be published', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'unwritten' });
    const { html } = await get('/cms/pages');
    expect(html).toContain(EN.Cms.untitled);
    expect(html).toContain('privacy');
  });

  it('shows the previous addresses with what they mean', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get(`/cms/pages/${PAGE}`);
    expect(html).toContain('terms-old');
    expect(html).toContain(EN.Cms.previousSlugsNote);
  });

  it('says so when the pages could not be read, rather than showing an empty list', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'unavailable' });
    const { html } = await get('/cms/pages');
    expect(html).toContain(EN.Cms.unavailableTitle);
    expect(html).not.toContain(EN.Cms.emptyTitle);
  });

  it('answers a page that is not there with the neutral message', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get('/cms/pages/fe000000-0000-4000-8000-0000000000ff');
    expect(html).toContain(EN.Cms.notFoundBody);
  });
});

describe('the cover image on the screen (0099)', () => {
  it('says there is no cover, and offers the field to attach one', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get(`/cms/pages/${PAGE}`);
    expect(html).toContain(EN.Cms.coverHeading);
    expect(html).toContain(EN.Cms.coverNoneBody);
    expect(html).toContain(EN.Cms.coverMediaIdLabel);
    expect(html).toContain(EN.Cms.coverSubmit);
  });

  it('does not ship the remove control, or its words, when there is nothing to remove', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get(`/cms/pages/${PAGE}`);
    // A client component's whole props object is serialised into the payload, so this is about the payload
    // and not only about the rendered markup: the label must not be in the response at all.
    expect(html).not.toContain(EN.Cms.coverRemove);
  });

  it('shows the stored path and both alt texts for an attached cover, and offers removal', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'withCover' });
    const { html } = await get(`/cms/pages/${PAGE}`);
    expect(html).toContain('cms-media/1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d.png');
    expect(html).toContain('A harbour at dawn');
    expect(html).toContain(EN.Cms.coverPathLabel);
    expect(html).toContain(EN.Cms.coverAltEnLabel);
    expect(html).toContain(EN.Cms.coverAltArLabel);
    expect(html).toContain(EN.Cms.coverRemove);
    expect(html).not.toContain(EN.Cms.coverNoneBody);
  });

  it('renders no image and no URL for an attached cover, because the bucket is private', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'withCover' });
    const { html } = await get(`/cms/pages/${PAGE}`);
    // The path is text. Nothing on this screen fetches the object or mints a credential for it.
    expect(html).not.toContain('<img');
    expect(html).not.toContain('background-image');
    expect(html).not.toContain('token=');
    expect(html).not.toContain('/storage/v1/');
    expect(html).not.toContain('https://cms-media');
  });

  it('says the alt text is not written rather than leaving the row blank', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'withUnlabelledCover' });
    const { html } = await get(`/cms/pages/${PAGE}`);
    expect(html).toContain('cms-media/2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e.webp');
    expect(html).toContain(EN.Cms.coverAltNone);
  });

  it('tells an operator that attaching a cover changes nothing a visitor sees', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'withCover' });
    const { html } = await get(`/cms/pages/${PAGE}`);
    expect(html).toContain(EN.Cms.coverNotShownTitle);
    expect(html).toContain(EN.Cms.coverNotShownBody);
  });

  it('gives a reader no cover control at all, not a disabled one', async () => {
    apiServes({ who: { kind: 'staff', permissions: PAGE_READER }, data: 'readerDetail' });
    const { html } = await get(`/cms/pages/${PAGE}`);
    for (const absent of [
      EN.Cms.coverHeading,
      EN.Cms.coverMediaIdLabel,
      EN.Cms.coverSubmit,
      EN.Cms.coverRemove,
      EN.Cms.coverMediaIdHint,
    ]) {
      expect(html, absent).not.toContain(absent);
    }
  });

  it('is in Arabic for an Arabic console', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN, locale: 'ar' }, data: 'withCover' });
    const { html } = await get(`/cms/pages/${PAGE}`);
    expect(html).toContain(AR.Cms.coverHeading);
    expect(html).toContain(AR.Cms.coverPathLabel);
    // The stored path is not a translated thing.
    expect(html).toContain('cms-media/1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d.png');
  });
});

describe('the public address', () => {
  /**
   * The public site serves a fixed set of page addresses. Authoring cannot change that set, so the one thing
   * the console owes an operator is to say which addresses reach a visitor and which do not — otherwise a page
   * is published, looks published, and reaches nobody.
   */
  it('shows the address a visitor would use', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get(`/cms/pages/${PAGE}`);
    expect(html).toContain(EN.Cms.publicAddressLabel);
    expect(html).toContain('/terms');
    expect(html).not.toContain(EN.Cms.publicAddressNoneTitle);
  });

  it('says plainly when the site serves no address for this page', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'offListSlug' });
    const { html } = await get(`/cms/pages/${PAGE}`);
    expect(html).toContain(EN.Cms.publicAddressNone);
    expect(html).toContain(EN.Cms.publicAddressNoneTitle);
    expect(html).toContain(EN.Cms.publicAddressNoneBody);
  });

  it('tells a reader the same thing it tells a manager', async () => {
    // Nothing here is a capability, so it is not gated on one: it is a fact about the deployment.
    apiServes({ who: { kind: 'staff', permissions: PAGE_READER }, data: 'offListSlug' });
    const { html } = await get(`/cms/pages/${PAGE}`);
    expect(html).toContain(EN.Cms.publicAddressNoneTitle);
  });

  it('says it in Arabic too', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN, locale: 'ar' }, data: 'offListSlug' });
    const { html } = await get(`/cms/pages/${PAGE}`);
    expect(html).toContain(AR.Cms.publicAddressNoneTitle);
  });
});

describe('both languages', () => {
  it('renders the section in Arabic, right to left', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN, locale: 'ar' } });
    const { status, html } = await get('/cms/pages');
    expect(status).toBe(200);
    expect(html).toContain('dir="rtl"');
    expect(html).toContain(AR.Sections.cms.title);
    expect(html).toContain(AR.Cms.listHeading);
    expect(html).toContain(AR.Cms.createSubmit);
  });

  it('renders a reader’s read-only notice in Arabic too', async () => {
    apiServes({ who: { kind: 'staff', permissions: PAGE_READER, locale: 'ar' }, data: 'readerDetail' });
    const { html } = await get(`/cms/pages/${PAGE}`);
    expect(html).toContain(AR.Cms.readOnlyBody);
    expect(html).not.toContain(AR.Cms.settingsSubmit);
  });
});
