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
 * The SEO redirect-map screens, over real HTTP against the built app.
 *
 * Run against the built app rather than a unit harness for the reason the shell test is: what matters is what
 * actually reaches a browser, **including the streamed RSC payload** — which is why a control that is merely hidden
 * with CSS would fail these assertions and a control that is never rendered passes them.
 *
 * The cases this file exists for:
 *
 *   * **a guest, a buyer, staff at `aal1`, a Moderator and a Support Agent receive none of this section** — no
 *     entry, no address, no note — in the markup or in the flight data, and no read is performed;
 *   * **the read/manage separation is on the screen.** A colleague holding `seo.redirect.read` and not
 *     `seo.redirect.manage` sees the map and the entry, and **not one control or any of their words**. The
 *     capability comes from the server's own answer, so this is the assertion that fails if somebody later decides
 *     it from a role name;
 *   * **LIVE PAGE WINS is said on the screen**, because an operator cannot deduce it from anything else there and
 *     the surprise it prevents is a redirect that appears to do nothing;
 *   * **an entry that redirects nobody says so** — switched off, pointing onwards through a chain, or caught in a
 *     loop — because each of those is invisible from the addresses alone;
 *   * **the screens offer no priority, no pattern and no bulk import**, which are the features this map does not
 *     have and must not appear to have;
 *   * both languages and the direction that goes with each.
 *
 * No browser, no Playwright, no live provider, no deployment.
 */

const CANARY_CREDENTIAL = 'test-redirects-screens-canary-notreal012345';

const EN = enMessages;
const AR = arMessages;

const ACCESS = '__Host-mp_admin_access=canary-admin-access-token-not-a-real-token';
const REFRESH = '__Host-mp_admin_refresh=canary-admin-refresh-token-not-a-real-tok';
const SESSION = `${ACCESS}; ${REFRESH}`;

const STAFF = '11111111-1111-4111-8111-111111111111';
const ENTRY = 'fe000000-0000-4000-8000-00000000d1c7';

const READ = 'seo.redirect.read';
const MANAGE = 'seo.redirect.manage';

/** An administrator: both redirect keys, plus others this surface never consults. */
const ADMIN = [READ, MANAGE, 'users.profile.read'].sort();

/** A colleague who may read the map and change none of it — the read/manage separation, on a screen. */
const MAP_READER = [READ].sort();

/** A moderator, who by the platform's own decision holds neither redirect key. */
const MODERATOR = ['moderation.report.read', 'moderation.action.read', 'reviews.review.read'].sort();

/** A support agent, likewise. */
const SUPPORT = ['support.ticket.read', 'support.ticket.manage', 'users.profile.read'].sort();

/** Somebody who maintains the CMS pages, and therefore not this. Two clusters, two keys. */
const CMS_ONLY = ['cms.page.read', 'cms.page.manage'].sort();

type Who =
  | { kind: 'staff'; permissions: string[]; locale?: 'en' | 'ar' }
  | { kind: 'staff-aal1' }
  | { kind: 'buyer' }
  | { kind: 'unauthenticated' };

type Data = 'default' | 'inactive' | 'chain' | 'loop' | 'empty' | 'unavailable' | 'readerDetail';

interface Serve {
  readonly who: Who;
  readonly data?: Data;
}

let api: StubApi;
let app: RunningApp;

const SUMMARY = {
  id: ENTRY,
  fromPath: '/old-offer',
  toPath: '/new-offer',
  statusCode: 301,
  isActive: true,
  note: 'campaign ended',
  createdAt: '2026-05-01T09:00:00.000Z',
  updatedAt: '2026-05-02T09:00:00.000Z',
};

const DETAIL = {
  ...SUMMARY,
  createdBy: STAFF,
  canManage: true,
  resolvedToPath: '/new-offer',
  resolvedStatusCode: 301,
};

function json(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function detailFor(data: Data, canManage: boolean): Record<string, unknown> {
  if (data === 'inactive') {
    return { ...DETAIL, canManage, isActive: false, resolvedToPath: null, resolvedStatusCode: null };
  }
  // The destination is itself redirected onwards: the chain ends somewhere the operator did not type.
  if (data === 'chain') {
    return { ...DETAIL, canManage, resolvedToPath: '/newest-offer', resolvedStatusCode: 301 };
  }
  // Active and resolving to nothing: the chain comes back to where it started, so the map ignores it.
  if (data === 'loop') {
    return { ...DETAIL, canManage, isActive: true, resolvedToPath: null, resolvedStatusCode: null };
  }
  return { ...DETAIL, canManage };
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
    if (path === '/v1/admin/seo/redirects') {
      if (!held(READ)) return problem(response, 404, 'NOT_FOUND');
      if (data === 'unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      if (data === 'empty') return json(response, { items: [], nextCursor: null });
      return json(response, {
        items: [data === 'inactive' ? { ...SUMMARY, isActive: false } : SUMMARY],
        nextCursor: null,
      });
    }

    if (path === `/v1/admin/seo/redirects/${ENTRY}`) {
      if (!held(READ)) return problem(response, 404, 'NOT_FOUND');
      if (data === 'unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      // The manage capability is the server's answer, which is exactly what the screen must render from.
      return json(response, { redirect: detailFor(data, data === 'readerDetail' ? false : held(MANAGE)) });
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
  it('shows a guest, a buyer, staff at aal1, a moderator, a support agent and a CMS author nothing about any entry', async () => {
    for (const who of [
      { kind: 'unauthenticated' } as const,
      { kind: 'buyer' } as const,
      { kind: 'staff-aal1' } as const,
      { kind: 'staff', permissions: MODERATOR } as const,
      { kind: 'staff', permissions: SUPPORT } as const,
      // Maintaining the site's static pages and maintaining its redirect map are different jobs with different
      // seeded keys, and this is where that separation is visible.
      { kind: 'staff', permissions: CMS_ONLY } as const,
    ]) {
      apiServes({ who });
      for (const path of ['/seo/redirects', `/seo/redirects/${ENTRY}`]) {
        const { html } = await get(path);
        const label = `${who.kind}:${JSON.stringify('permissions' in who ? who.permissions : [])}:${path}`;
        // Not the entry, not its addresses, not its note — in markup or in flight data.
        expect(html, label).not.toContain('/old-offer');
        expect(html, label).not.toContain('/new-offer');
        expect(html, label).not.toContain('campaign ended');
        // And not one control.
        expect(html, label).not.toContain(EN.SeoRedirects.createSubmit);
        expect(html, label).not.toContain(EN.SeoRedirects.activate);
        expect(html, label).not.toContain(EN.SeoRedirects.remove);
      }
      // No read was attempted against the redirect surface for any of them.
      expect(api.seen.filter((entry) => entry.url.startsWith('/v1/admin/seo/redirects')), who.kind).toEqual([]);
    }
  });
});

describe('the read and manage keys are separate on the screen', () => {
  it('gives a reader the map and the entry, and not one control', async () => {
    apiServes({ who: { kind: 'staff', permissions: MAP_READER }, data: 'readerDetail' });

    const list = await get('/seo/redirects');
    expect(list.status).toBe(200);
    expect(list.html).toContain('/old-offer');
    // The create panel's words are absent entirely, not hidden.
    expect(list.html).not.toContain(EN.SeoRedirects.createSubmit);
    expect(list.html).not.toContain(EN.SeoRedirects.activeHint);

    const detail = await get(`/seo/redirects/${ENTRY}`);
    expect(detail.status).toBe(200);
    expect(detail.html).toContain('/new-offer');
    expect(detail.html).toContain(EN.SeoRedirects.readOnlyBody);
    for (const absent of [
      EN.SeoRedirects.editSubmit,
      EN.SeoRedirects.activate,
      EN.SeoRedirects.deactivate,
      EN.SeoRedirects.remove,
      EN.SeoRedirects.removeConfirm,
      EN.SeoRedirects.fromRenameHint,
    ]) {
      expect(detail.html, absent).not.toContain(absent);
    }
  });

  it('gives a manager every control, and no read-only notice', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });

    const list = await get('/seo/redirects');
    expect(list.html).toContain(EN.SeoRedirects.createSubmit);
    expect(list.html).toContain(EN.SeoRedirects.activeHint);

    const detail = await get(`/seo/redirects/${ENTRY}`);
    expect(detail.status).toBe(200);
    for (const present of [
      EN.SeoRedirects.editSubmit,
      EN.SeoRedirects.fromRenameHint,
      EN.SeoRedirects.deactivate,
      EN.SeoRedirects.remove,
    ]) {
      expect(detail.html, present).toContain(present);
    }
    expect(detail.html).not.toContain(EN.SeoRedirects.readOnlyBody);
  });

  it('offers switching on, not off, for an entry that is off', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'inactive' });
    const { html } = await get(`/seo/redirects/${ENTRY}`);
    expect(html).toContain(EN.SeoRedirects.activate);
    expect(html).not.toContain(EN.SeoRedirects.deactivate);
  });
});

describe('what the screens say about the map', () => {
  it('states that a live page always wins, where an operator will read it', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get('/seo/redirects');
    // The one fact an operator cannot deduce from anything else on the screen.
    expect(html).toContain(EN.SeoRedirects.precedenceTitle);
    expect(html).toContain(EN.SeoRedirects.precedenceBody);
  });

  it('says that an entry switched off redirects nobody', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'inactive' });
    const { html } = await get(`/seo/redirects/${ENTRY}`);
    expect(html).toContain(EN.SeoRedirects.stateInactive);
    expect(html).toContain(EN.SeoRedirects.resolvedNone);
  });

  it('says when the destination is itself redirected onwards', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'chain' });
    const { html } = await get(`/seo/redirects/${ENTRY}`);
    expect(html).toContain('/newest-offer');
    expect(html).toContain(EN.SeoRedirects.chainTitle);
    expect(html).toContain(EN.SeoRedirects.chainBody);
  });

  it('warns when a live entry resolves to nothing, which is a loop', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'loop' });
    const { html } = await get(`/seo/redirects/${ENTRY}`);
    expect(html).toContain(EN.SeoRedirects.loopTitle);
    expect(html).toContain(EN.SeoRedirects.loopBody);
  });

  it('does not warn about a chain when the destination is the destination', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get(`/seo/redirects/${ENTRY}`);
    expect(html).not.toContain(EN.SeoRedirects.chainTitle);
    expect(html).not.toContain(EN.SeoRedirects.loopTitle);
  });

  it('distinguishes an empty map from a search that matched nothing', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'empty' });
    const empty = await get('/seo/redirects');
    expect(empty.html).toContain(EN.SeoRedirects.emptyBody);
    expect(empty.html).not.toContain(EN.SeoRedirects.noMatchesBody);

    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'empty' });
    const searched = await get('/seo/redirects?search=nothing-like-this');
    expect(searched.html).toContain(EN.SeoRedirects.noMatchesBody);
    expect(searched.html).not.toContain(EN.SeoRedirects.emptyBody);
  });

  it('carries the search and the state filter upstream, and keeps them on the page', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { status } = await get('/seo/redirects?search=offer&active=false');
    expect(status).toBe(200);
    const asked = api.seen.find((entry) => entry.url.startsWith('/v1/admin/seo/redirects?'));
    expect(asked?.url).toContain('search=offer');
    expect(asked?.url).toContain('active=false');
  });

  it('reports an outage rather than an empty map', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'unavailable' });
    const { html } = await get('/seo/redirects');
    expect(html).toContain(EN.SeoRedirects.unavailable);
    // An empty map and an unreadable one must never look alike: one is a fact, the other is a failure.
    expect(html).not.toContain(EN.SeoRedirects.emptyBody);
  });

  it('offers nothing this map does not have', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const list = await get('/seo/redirects');
    const detail = await get(`/seo/redirects/${ENTRY}`);

    // Asserted on the fields the forms actually submit rather than on the whole document, because the framework's
    // own markup contains words like `fetchPriority` that have nothing to do with this screen.
    for (const html of [list.html, detail.html]) {
      for (const absent of ['priority', 'pattern', 'regex', 'wildcard', 'import', 'hits', 'group']) {
        expect(html, absent).not.toContain(`name="${absent}"`);
        expect(html, absent).not.toContain(`id="redirect-${absent}"`);
      }
    }

    // And on the words the section can say at all: none of them promises a feature this map has not got. A label is
    // how a control becomes discoverable, so a catalogue with no word for a thing cannot offer it.
    const sectionCopy = Object.values(EN.SeoRedirects).join(' ').toLowerCase();
    for (const absent of ['priority', 'wildcard', 'regular expression', 'bulk', 'import', 'pattern']) {
      expect(sectionCopy, absent).not.toContain(absent);
    }
  });
});

describe('both languages', () => {
  it('renders the section in Arabic, right to left', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN, locale: 'ar' } });
    const { status, html } = await get('/seo/redirects');
    expect(status).toBe(200);
    expect(html).toContain('dir="rtl"');
    expect(html).toContain(AR.SeoRedirects.listHeading);
    expect(html).toContain(AR.SeoRedirects.precedenceTitle);
    expect(html).toContain(AR.Sections.seoRedirects.title);
  });

  it('renders the entry in Arabic too', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN, locale: 'ar' }, data: 'chain' });
    const { html } = await get(`/seo/redirects/${ENTRY}`);
    expect(html).toContain(AR.SeoRedirects.chainTitle);
    expect(html).toContain(AR.SeoRedirects.deactivate);
    // An address is an address in both languages.
    expect(html).toContain('/old-offer');
  });
});

describe('an entry that is not there', () => {
  it('answers the section’s own not-found message rather than a blank page', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { status, html } = await get('/seo/redirects/fe000000-0000-4000-8000-0000000000ff');
    expect(status).toBe(200);
    expect(html).toContain(EN.SeoRedirects.notFoundBody);
  });

  it('answers the same for an identifier that could never be one', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get('/seo/redirects/not-a-uuid');
    expect(html).toContain(EN.SeoRedirects.notFoundBody);
    // Nothing was asked upstream about a value that cannot name a row.
    expect(api.seen.filter((entry) => entry.url.includes('not-a-uuid'))).toEqual([]);
  });
});
