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
 * The per-entity SEO metadata screens, over real HTTP against the built app.
 *
 * Run against the built app rather than a unit harness for the reason the shell test is: what matters is what actually
 * reaches a browser, **including the streamed RSC payload** — so a control merely hidden with CSS would fail these
 * assertions and a control never rendered passes them.
 *
 * The cases this file exists for:
 *
 *   * **a guest, a buyer, staff at `aal1`, a Moderator, a Support Agent and somebody who maintains only the redirect
 *     map receive none of this section** — no override, no title, no address — and no read is performed. The last of
 *     those is the one that matters most: the two SEO sections are separate keys, and this is where that is visible;
 *   * **the read/manage separation is on the screen.** A colleague holding `seo.metadata.read` and not
 *     `seo.metadata.manage` sees the overrides and **not one control or any of their words**;
 *   * **both owner rules are stated where an operator will read them, and reported per entry from the server's own
 *     answer** — a stored canonical that will not be served, and stored directives that have been narrowed, are each
 *     said out loud rather than left to be discovered;
 *   * **the screens offer no structured data, no site-wide defaults and no `service` kind**, which are the three
 *     things an operator could reasonably expect and would not get;
 *   * both languages and the direction that goes with each.
 *
 * No browser, no Playwright, no live provider, no deployment.
 */

const CANARY_CREDENTIAL = 'test-metadata-screens-canary-notreal0123456';

const EN = enMessages;
const AR = arMessages;

const ACCESS = '__Host-mp_admin_access=canary-admin-access-token-not-a-real-token';
const REFRESH = '__Host-mp_admin_refresh=canary-admin-refresh-token-not-a-real-tok';
const SESSION = `${ACCESS}; ${REFRESH}`;

const STAFF = '11111111-1111-4111-8111-111111111111';
const ENTRY = 'fe000000-0000-4000-8000-00000000d7a1';
const CATEGORY = '22222222-2222-4222-8222-222222222222';

const READ = 'seo.metadata.read';
const MANAGE = 'seo.metadata.manage';

/** An administrator: both metadata keys, plus others this surface never consults. */
const ADMIN = [READ, MANAGE, 'users.profile.read'].sort();

/** A colleague who may read the overrides and change none — the read/manage separation, on a screen. */
const METADATA_READER = [READ].sort();

const MODERATOR = ['moderation.report.read', 'moderation.action.read', 'reviews.review.read'].sort();
const SUPPORT = ['support.ticket.read', 'support.ticket.manage', 'users.profile.read'].sort();

/** Somebody who maintains the redirect map and not this: one module, two keys, two sections. */
const REDIRECTS_ONLY = ['seo.redirect.read', 'seo.redirect.manage'].sort();

type Who =
  | { kind: 'staff'; permissions: string[]; locale?: 'en' | 'ar' }
  | { kind: 'staff-aal1' }
  | { kind: 'buyer' }
  | { kind: 'unauthenticated' };

type Data = 'default' | 'honoured' | 'narrowed' | 'blog' | 'empty' | 'unavailable' | 'readerDetail';

interface Serve {
  readonly who: Who;
  readonly data?: Data;
}

let api: StubApi;
let app: RunningApp;

/** A listing override: a stored canonical that will not be served, and permissive directives that will not either. */
const LISTING_ENTRY = {
  id: ENTRY,
  entityType: 'listing',
  entityId: CATEGORY,
  routePath: null,
  targetSlug: 'a-lovely-chair',
  localeCode: 'en',
  metaTitle: 'A lovely chair',
  metaDescription: 'A chair worth having.',
  canonicalPath: '/elsewhere',
  robotsDirectives: ['index', 'follow', 'nosnippet'],
  ogTitle: null,
  ogDescription: null,
  shareMediaId: null,
  canonicalIsHonoured: false,
  updatedAt: '2026-05-02T09:00:00.000Z',
};

/** A route override, where a canonical *is* served and the directives are purely restrictive. */
const ROUTE_ENTRY = {
  ...LISTING_ENTRY,
  entityType: 'route',
  entityId: null,
  routePath: '/listings',
  targetSlug: null,
  canonicalPath: '/listings',
  robotsDirectives: ['noindex'],
  canonicalIsHonoured: true,
};

function detailFor(data: Data, canManage: boolean): Record<string, unknown> {
  const base = {
    shareObjectPath: null,
    createdAt: '2026-05-01T09:00:00.000Z',
    updatedBy: STAFF,
    canManage,
  };
  if (data === 'honoured') {
    return { ...ROUTE_ENTRY, ...base, effectiveCanonicalPath: '/listings', effectiveRobotsDirectives: ['noindex'] };
  }
  if (data === 'blog') {
    return {
      ...LISTING_ENTRY,
      ...base,
      entityType: 'blog_post',
      effectiveCanonicalPath: null,
      effectiveRobotsDirectives: [],
    };
  }
  // The default and the narrowed case are the same row: a listing whose canonical is withheld and whose permissive
  // directives have been dropped. Both notices belong on it.
  return { ...LISTING_ENTRY, ...base, effectiveCanonicalPath: null, effectiveRobotsDirectives: ['nosnippet'] };
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

    if (path === '/v1/admin/seo/metadata') {
      if (!held(READ)) return problem(response, 404, 'NOT_FOUND');
      if (data === 'unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      if (data === 'empty') return json(response, { items: [], nextCursor: null });
      return json(response, {
        items: [data === 'honoured' ? ROUTE_ENTRY : LISTING_ENTRY],
        nextCursor: null,
      });
    }

    if (path === `/v1/admin/seo/metadata/${ENTRY}`) {
      if (!held(READ)) return problem(response, 404, 'NOT_FOUND');
      if (data === 'unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      return json(response, { entry: detailFor(data, data === 'readerDetail' ? false : held(MANAGE)) });
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
  it('shows a guest, a buyer, staff at aal1, a moderator, a support agent and a redirect-map maintainer nothing', async () => {
    for (const who of [
      { kind: 'unauthenticated' } as const,
      { kind: 'buyer' } as const,
      { kind: 'staff-aal1' } as const,
      { kind: 'staff', permissions: MODERATOR } as const,
      { kind: 'staff', permissions: SUPPORT } as const,
      // Maintaining the redirect map and maintaining the metadata overrides are different jobs with different seeded
      // keys, and this is where that separation is visible.
      { kind: 'staff', permissions: REDIRECTS_ONLY } as const,
    ]) {
      apiServes({ who });
      for (const path of ['/seo/metadata', `/seo/metadata/${ENTRY}`]) {
        const { html } = await get(path);
        const label = `${who.kind}:${JSON.stringify('permissions' in who ? who.permissions : [])}:${path}`;
        expect(html, label).not.toContain('A lovely chair');
        expect(html, label).not.toContain('a-lovely-chair');
        expect(html, label).not.toContain('/elsewhere');
        expect(html, label).not.toContain(EN.SeoMetadata.saveSubmit);
        expect(html, label).not.toContain(EN.SeoMetadata.remove);
      }
      expect(api.seen.filter((entry) => entry.url.startsWith('/v1/admin/seo/metadata')), who.kind).toEqual([]);
    }
  });
});

describe('the read and manage keys are separate on the screen', () => {
  it('gives a reader the overrides and the entry, and not one control', async () => {
    apiServes({ who: { kind: 'staff', permissions: METADATA_READER }, data: 'readerDetail' });

    const list = await get('/seo/metadata');
    expect(list.status).toBe(200);
    expect(list.html).toContain('A lovely chair');
    expect(list.html).not.toContain(EN.SeoMetadata.saveSubmit);
    expect(list.html).not.toContain(EN.SeoMetadata.replaceWarning);

    const detail = await get(`/seo/metadata/${ENTRY}`);
    expect(detail.status).toBe(200);
    expect(detail.html).toContain(EN.SeoMetadata.readOnlyBody);
    for (const absent of [
      EN.SeoMetadata.saveSubmit,
      EN.SeoMetadata.remove,
      EN.SeoMetadata.removeConfirm,
      EN.SeoMetadata.replaceWarning,
      EN.SeoMetadata.directivesHint,
    ]) {
      expect(detail.html, absent).not.toContain(absent);
    }
  });

  it('gives a manager every control, and no read-only notice', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });

    const list = await get('/seo/metadata');
    expect(list.html).toContain(EN.SeoMetadata.saveSubmit);
    expect(list.html).toContain(EN.SeoMetadata.replaceWarning);

    const detail = await get(`/seo/metadata/${ENTRY}`);
    expect(detail.status).toBe(200);
    for (const present of [EN.SeoMetadata.saveSubmit, EN.SeoMetadata.remove, EN.SeoMetadata.replaceWarning]) {
      expect(detail.html, present).toContain(present);
    }
    expect(detail.html).not.toContain(EN.SeoMetadata.readOnlyBody);
  });
});

describe('what the screens say about the two rules', () => {
  it('states both of them on the list, where an operator will read them before writing', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get('/seo/metadata');
    expect(html).toContain(EN.SeoMetadata.rulesTitle);
    expect(html).toContain(EN.SeoMetadata.rulesBody);
  });

  it('says that a stored canonical will not be served for a listing', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get(`/seo/metadata/${ENTRY}`);
    expect(html).toContain('/elsewhere');
    expect(html).toContain(EN.SeoMetadata.canonicalIgnoredTitle);
    expect(html).toContain(EN.SeoMetadata.canonicalIgnoredBody);
  });

  it('says that the permissive directives have been dropped', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'narrowed' });
    const { html } = await get(`/seo/metadata/${ENTRY}`);
    expect(html).toContain(EN.SeoMetadata.directivesNarrowedTitle);
    expect(html).toContain(EN.SeoMetadata.directivesNarrowedBody);
  });

  it('says neither when a route honours its canonical and its directives all take effect', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'honoured' });
    const { html } = await get(`/seo/metadata/${ENTRY}`);
    expect(html).not.toContain(EN.SeoMetadata.canonicalIgnoredTitle);
    expect(html).not.toContain(EN.SeoMetadata.directivesNarrowedTitle);
    expect(html).toContain('/listings');
  });

  it('shows the stored value and the effective value as separate things', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get(`/seo/metadata/${ENTRY}`);
    expect(html).toContain(EN.SeoMetadata.storedCanonical);
    expect(html).toContain(EN.SeoMetadata.effectiveCanonical);
    expect(html).toContain(EN.SeoMetadata.storedDirectives);
    expect(html).toContain(EN.SeoMetadata.effectiveDirectives);
  });
});

describe('what the screens say this section does not do', () => {
  it('says so on the panel that writes one', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get('/seo/metadata');
    expect(html).toContain(EN.SeoMetadata.notHereTitle);
    expect(html).toContain(EN.SeoMetadata.notHereBody);
  });

  it('offers no structured-data field and no service kind', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get('/seo/metadata');
    // Asserted on what the form submits rather than on prose, because a field is how a thing becomes writable.
    expect(html).not.toContain('id="metadata-structured');
    expect(html).not.toContain('name="structuredData"');
    expect(html).not.toContain('value="service"');
  });

  it('cannot rewrite an override for a kind with no public page, and says why', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'blog' });
    const { html } = await get(`/seo/metadata/${ENTRY}`);
    expect(html).toContain(EN.SeoMetadata.notWritableBody);
    expect(html).not.toContain(EN.SeoMetadata.replaceWarning);
    // It can still be removed, which is the whole of what an operator can usefully do with it.
    expect(html).toContain(EN.SeoMetadata.remove);
  });
});

describe('the list', () => {
  it('distinguishes no overrides at all from a filter that matched nothing', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'empty' });
    const empty = await get('/seo/metadata');
    expect(empty.html).toContain(EN.SeoMetadata.emptyBody);
    expect(empty.html).not.toContain(EN.SeoMetadata.noMatchesBody);

    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'empty' });
    const filtered = await get('/seo/metadata?entityType=seller');
    expect(filtered.html).toContain(EN.SeoMetadata.noMatchesBody);
    expect(filtered.html).not.toContain(EN.SeoMetadata.emptyBody);
  });

  it('carries both filters upstream', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { status } = await get('/seo/metadata?entityType=listing&locale=ar');
    expect(status).toBe(200);
    const asked = api.seen.find((entry) => entry.url.startsWith('/v1/admin/seo/metadata?'));
    expect(asked?.url).toContain('entityType=listing');
    expect(asked?.url).toContain('locale=ar');
  });

  it('reports an outage rather than an empty set of overrides', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'unavailable' });
    const { html } = await get('/seo/metadata');
    expect(html).toContain(EN.SeoMetadata.unavailable);
    expect(html).not.toContain(EN.SeoMetadata.emptyBody);
  });
});

describe('both languages', () => {
  it('renders the section in Arabic, right to left', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN, locale: 'ar' } });
    const { status, html } = await get('/seo/metadata');
    expect(status).toBe(200);
    expect(html).toContain('dir="rtl"');
    expect(html).toContain(AR.SeoMetadata.listHeading);
    expect(html).toContain(AR.SeoMetadata.rulesTitle);
    expect(html).toContain(AR.Sections.seoMetadata.title);
  });

  it('renders the entry in Arabic too, including the rule it has to state', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN, locale: 'ar' } });
    const { html } = await get(`/seo/metadata/${ENTRY}`);
    expect(html).toContain(AR.SeoMetadata.canonicalIgnoredTitle);
    expect(html).toContain(AR.SeoMetadata.storedDirectives);
    // An address is an address in both languages.
    expect(html).toContain('/elsewhere');
  });
});

describe('an override that is not there', () => {
  it('answers the section’s own not-found message rather than a blank page', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { status, html } = await get('/seo/metadata/fe000000-0000-4000-8000-0000000000ff');
    expect(status).toBe(200);
    expect(html).toContain(EN.SeoMetadata.notFoundBody);
  });

  it('answers the same for an identifier that could never be one, without asking upstream', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get('/seo/metadata/not-a-uuid');
    expect(html).toContain(EN.SeoMetadata.notFoundBody);
    expect(api.seen.filter((entry) => entry.url.includes('not-a-uuid'))).toEqual([]);
  });
});
