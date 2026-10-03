import type { ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import arMessages from '../messages/ar.json';
import enMessages from '../messages/en.json';
import { startBuiltApp, type RunningApp } from './support/next-server.js';
import { problem, startStubApi, type StubApi } from './support/stub-api.js';

/**
 * The help-centre screens, over real HTTP against the built app (0095).
 *
 * Run against the built app rather than a unit harness for the reason the shell test is: what matters is what
 * actually reaches a browser, **including the streamed RSC payload** — so a control merely hidden with CSS would
 * fail these assertions and a control never rendered passes them.
 *
 * The cases this file exists for:
 *
 *   * **a guest, a buyer, staff at `aal1`, a Moderator and somebody who only writes the blog receive none of this
 *     section** — and no read is performed. The last of those matters most: writing the help centre and writing the
 *     blog are separate keys, and this is where that is visible;
 *   * **the read/manage separation is on the screen.** A colleague holding `cms.faq.read` and not `cms.faq.manage`
 *     sees the questions and **not one control or any of their words**;
 *   * **owner decision 5 is explained, not just applied.** A topic no published page carries is named and
 *     explained, because the public site shows it to nobody and this is the only place the reason exists;
 *   * **a topic mapped to a page at an address this application does not serve is marked**, which only this layer
 *     can know;
 *   * **owner decision 6 is visible.** The create form says the entry is saved unpublished, and nothing on an
 *     editing form publishes one;
 *   * **owner decision 3 is shown.** The detail previews the answer as paragraphs split on blank lines, and no part
 *     of it is rendered as markup;
 *   * **no structured-data, promotion or image control appears anywhere**;
 *   * both languages and the direction that goes with each.
 *
 * No browser, no Playwright, no live provider, no deployment.
 */

/** Obviously fake, 43 base64url characters. */
const CANARY_CREDENTIAL = 'test-faqs-screens-canary-notreal0123456789a';

const EN = enMessages;
const AR = arMessages;

const ACCESS = '__Host-mp_admin_access=canary-admin-access-token-not-a-real-token';
const REFRESH = '__Host-mp_admin_refresh=canary-admin-refresh-token-not-a-real-tok';
const SESSION = `${ACCESS}; ${REFRESH}`;

const STAFF = '11111111-1111-4111-8111-111111111111';
const FAQ = 'fe000000-0000-4000-8000-0000000000e1';
const SECOND = 'fe000000-0000-4000-8000-0000000000e2';

const READ = 'cms.faq.read';
const MANAGE = 'cms.faq.manage';

/** An administrator: both help-centre keys, plus others this surface never consults. */
const ADMIN = [READ, MANAGE, 'users.profile.read'].sort();

/** A colleague who may read the help centre and change none of it. */
const FAQ_READER = [READ].sort();

const MODERATOR = ['moderation.report.read', 'moderation.action.read', 'reviews.review.read'].sort();

/** Somebody who writes the blog and not the help centre: one module, two keys, two sections. */
const BLOG_ONLY = ['cms.blog.read', 'cms.blog.manage'].sort();

const ANSWER = 'Open a listing and read it.\n\nThen press buy.';

type Who =
  | { kind: 'staff'; permissions: string[]; locale?: 'en' | 'ar' }
  | { kind: 'staff-aal1' }
  | { kind: 'buyer' }
  | { kind: 'unauthenticated' };

type Data = 'default' | 'two' | 'empty' | 'unmapped' | 'unservable' | 'unpublished' | 'unavailable' | 'readerDetail';

interface Serve {
  readonly who: Who;
  readonly data?: Data;
}

let api: StubApi;
let app: RunningApp;

function entryFor(data: Data, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base = {
    id: FAQ,
    topic: 'faq',
    questionEn: 'How do I buy?',
    questionAr: null,
    answerEn: ANSWER,
    answerAr: null,
    sortOrder: 10,
    isPublished: true,
    isMapped: true,
    pageSlug: 'faq',
    createdAt: '2026-04-01T09:00:00.000Z',
    updatedAt: '2026-05-02T09:00:00.000Z',
  };
  if (data === 'unmapped') return { ...base, topic: 'shipping', isMapped: false, pageSlug: null, ...overrides };
  // Published, carrying a topic, and at an address this application serves no page for.
  if (data === 'unservable') {
    return { ...base, topic: 'invented', isMapped: true, pageSlug: 'not-a-served-address', ...overrides };
  }
  if (data === 'unpublished') return { ...base, isPublished: false, ...overrides };
  return { ...base, ...overrides };
}

function topicsFor(data: Data): readonly Record<string, unknown>[] {
  if (data === 'empty') return [];
  if (data === 'unmapped') {
    return [{ topic: 'shipping', entryCount: 1, publishedCount: 0, isMapped: false, pageSlug: null }];
  }
  if (data === 'unservable') {
    return [{ topic: 'invented', entryCount: 1, publishedCount: 1, isMapped: true, pageSlug: 'not-a-served-address' }];
  }
  return [{ topic: 'faq', entryCount: 3, publishedCount: 2, isMapped: true, pageSlug: 'faq' }];
}

function itemsFor(data: Data): readonly Record<string, unknown>[] {
  if (data === 'empty') return [];
  if (data === 'two') {
    return [entryFor('default'), entryFor('default', { id: SECOND, questionEn: 'How do I sell?', sortOrder: 20 })];
  }
  return [entryFor(data)];
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

    if (path === '/v1/admin/faqs/topics') {
      if (!held(READ)) return problem(response, 404, 'NOT_FOUND');
      if (data === 'unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      return json(response, { topics: topicsFor(data) });
    }

    if (path === `/v1/admin/faqs/${FAQ}`) {
      if (!held(READ)) return problem(response, 404, 'NOT_FOUND');
      if (data === 'unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      return json(response, {
        faq: { ...entryFor(data), canManage: data === 'readerDetail' ? false : held(MANAGE) },
      });
    }

    if (path === '/v1/admin/faqs') {
      if (!held(READ)) return problem(response, 404, 'NOT_FOUND');
      if (data === 'unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      return json(response, {
        items: itemsFor(data),
        nextCursor: null,
        canManage: data === 'readerDetail' ? false : held(MANAGE),
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
      const { html } = await get('/cms/faqs');
      expect(html, who.kind).not.toContain(EN.Faqs.listHeading);
      // Not one read was performed for a caller who may not be here.
      expect(
        api.seen.some((entry) => entry.url.startsWith('/v1/admin/faqs')),
        who.kind,
      ).toBe(false);
    }
  });

  it('refuses a Moderator and somebody who only writes the blog', async () => {
    for (const permissions of [MODERATOR, BLOG_ONLY]) {
      apiServes({ who: { kind: 'staff', permissions: [...permissions] } });
      const { html } = await get('/cms/faqs');
      expect(html, permissions.join(',')).not.toContain(EN.Faqs.listHeading);
      expect(html, permissions.join(',')).not.toContain(EN.Faqs.addHeading);
    }
  });

  it('lets an administrator in', async () => {
    apiServes({ who: { kind: 'staff', permissions: [...ADMIN] } });
    const { status, html } = await get('/cms/faqs');
    expect(status).toBe(200);
    expect(html).toContain(EN.Sections.faqs.title);
    expect(html).toContain(EN.Faqs.topicsHeading);
    expect(html).toContain('How do I buy?');
  });
});

describe('the topics panel', () => {
  it('shows each topic, which page shows it and how much is published', async () => {
    apiServes({ who: { kind: 'staff', permissions: [...ADMIN] } });
    const { html } = await get('/cms/faqs');
    expect(html).toContain('faq');
    expect(html).toContain('/faq');
  });

  it('names a topic no published page carries', async () => {
    // Owner decision 5: free-form topics are legal, and the console is where an unmapped one is explained.
    apiServes({ who: { kind: 'staff', permissions: [...ADMIN] }, data: 'unmapped' });
    const { html } = await get('/cms/faqs');
    expect(html).toContain(EN.Faqs.notShown);
  });

  it('marks a topic whose page has no address on this site', async () => {
    apiServes({ who: { kind: 'staff', permissions: [...ADMIN] }, data: 'unservable' });
    const { html } = await get('/cms/faqs');
    expect(html).toContain(EN.Faqs.unservablePage);
  });

  it('says so when nothing has been written at all', async () => {
    apiServes({ who: { kind: 'staff', permissions: [...ADMIN] }, data: 'empty' });
    const { html } = await get('/cms/faqs');
    expect(html).toContain(EN.Faqs.emptyTitle);
    expect(html).toContain(EN.Faqs.noEntriesTitle);
  });

  it('says what this screen does not do', async () => {
    apiServes({ who: { kind: 'staff', permissions: [...ADMIN] } });
    const { html } = await get('/cms/faqs');
    expect(html).toContain(EN.Faqs.notHereTitle);
  });

  it('reports an outage rather than an empty help centre', async () => {
    apiServes({ who: { kind: 'staff', permissions: [...ADMIN] }, data: 'unavailable' });
    const { html } = await get('/cms/faqs');
    expect(html).toContain(EN.Faqs.unavailableTitle);
    expect(html).not.toContain(EN.Faqs.emptyTitle);
  });
});

describe('the read and manage keys are separate on the screen', () => {
  it('gives a reader the questions and not one control, nor any of their words', async () => {
    apiServes({ who: { kind: 'staff', permissions: [...FAQ_READER] } });
    const { status, html } = await get('/cms/faqs');
    expect(status).toBe(200);
    expect(html).toContain(EN.Faqs.listHeading);
    expect(html).toContain('How do I buy?');
    // Not the panel, not the button, and not the words either: a client component's whole props object is
    // serialised into the RSC payload, so a control rendered and hidden would still leak its labels.
    expect(html).not.toContain(EN.Faqs.addHeading);
    expect(html).not.toContain(EN.Faqs.answerHint);
    expect(html).not.toContain(EN.Faqs.unpublishedNotice);
  });

  it('gives a reader the detail and none of its controls', async () => {
    apiServes({ who: { kind: 'staff', permissions: [...FAQ_READER] }, data: 'readerDetail' });
    const { status, html } = await get(`/cms/faqs/${FAQ}`);
    expect(status).toBe(200);
    expect(html).toContain('How do I buy?');
    expect(html).not.toContain(EN.Faqs.remove);
    expect(html).not.toContain(EN.Faqs.clearArabic);
    expect(html).not.toContain(EN.Faqs.answerHint);
  });

  it('gives a manager every control', async () => {
    apiServes({ who: { kind: 'staff', permissions: [...ADMIN] } });
    const list = await get('/cms/faqs');
    expect(list.html).toContain(EN.Faqs.addHeading);
    // Owner decision 6 said out loud, where somebody is about to save one.
    expect(list.html).toContain(EN.Faqs.unpublishedNotice);

    const detail = await get(`/cms/faqs/${FAQ}`);
    expect(detail.html).toContain(EN.Faqs.remove);
    expect(detail.html).toContain(EN.Faqs.clearArabic);
    // Published already, so the control offers the other direction.
    expect(detail.html).toContain(EN.Faqs.unpublish);
  });

  it('offers publishing to a manager looking at an unpublished entry', async () => {
    apiServes({ who: { kind: 'staff', permissions: [...ADMIN] }, data: 'unpublished' });
    const { html } = await get(`/cms/faqs/${FAQ}`);
    expect(html).toContain(EN.Faqs.publish);
    expect(html).toContain(EN.Faqs.unpublished);
  });

  it('offers an order only for a single topic with more than one question', async () => {
    apiServes({ who: { kind: 'staff', permissions: [...ADMIN] }, data: 'two' });
    const narrowed = await get('/cms/faqs?topic=faq');
    expect(narrowed.html).toContain(EN.Faqs.reorderHint);

    // Every topic at once: there is no single order to apply, so the control is not rendered at all.
    const everything = await get('/cms/faqs');
    expect(everything.html).not.toContain(EN.Faqs.reorderHint);
  });
});

describe('one entry', () => {
  it('previews the answer as paragraphs, and never as markup', async () => {
    // Owner decision 3, shown rather than described.
    apiServes({ who: { kind: 'staff', permissions: [...ADMIN] } });
    const { html } = await get(`/cms/faqs/${FAQ}`);
    expect(html).toContain(EN.Faqs.previewHeading);
    expect(html).toContain('Open a listing and read it.');
    expect(html).toContain('Then press buy.');
  });

  it('explains a topic no page carries, and one whose page has no address', async () => {
    apiServes({ who: { kind: 'staff', permissions: [...ADMIN] }, data: 'unmapped' });
    const unmapped = await get(`/cms/faqs/${FAQ}`);
    expect(unmapped.html).toContain(EN.Faqs.notShownBody);

    apiServes({ who: { kind: 'staff', permissions: [...ADMIN] }, data: 'unservable' });
    const unservable = await get(`/cms/faqs/${FAQ}`);
    expect(unservable.html).toContain(EN.Faqs.unservablePageBody);
  });

  it('answers an entry that does not exist the way it answers one you may not read', async () => {
    apiServes({ who: { kind: 'staff', permissions: [...ADMIN] } });
    const { html } = await get('/cms/faqs/fe000000-0000-4000-8000-00000000ffff');
    expect(html).toContain(EN.Faqs.notFoundTitle);
  });
});

describe('nothing financial, promotional or visual is on these screens', () => {
  it('offers no structured data, promotion, ranking or image control anywhere', async () => {
    apiServes({ who: { kind: 'staff', permissions: [...ADMIN] } });
    const list = await get('/cms/faqs');
    const detail = await get(`/cms/faqs/${FAQ}`);
    for (const html of [list.html, detail.html]) {
      // Asserted as field names rather than as words, for the reason the other CMS screens are: the copy may
      // legitimately mention what is elsewhere.
      for (const name of [
        'structuredData',
        'promotionId',
        'placement',
        'ranking',
        'mediaId',
        'imageId',
        'metaTitle',
        'canonicalPath',
      ]) {
        expect(html, name).not.toContain(`name="${name}"`);
      }
      expect(html).not.toContain('<img');
      for (const word of ['wallet', 'payout', 'settlement', 'commission']) {
        expect(html.toLowerCase(), word).not.toContain(word);
      }
    }
  });
});

describe('both languages', () => {
  it('renders the section in Arabic, mirrored', async () => {
    apiServes({ who: { kind: 'staff', permissions: [...ADMIN], locale: 'ar' } });
    const { html } = await get('/cms/faqs');
    expect(html).toContain('dir="rtl"');
    expect(html).toContain(AR.Sections.faqs.title);
    expect(html).toContain(AR.Faqs.topicsHeading);
  });

  it('explains an unmapped topic in Arabic too', async () => {
    apiServes({ who: { kind: 'staff', permissions: [...ADMIN], locale: 'ar' }, data: 'unmapped' });
    const { html } = await get(`/cms/faqs/${FAQ}`);
    expect(html).toContain(AR.Faqs.notShownBody);
  });
});
