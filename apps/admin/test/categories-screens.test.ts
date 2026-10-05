import type { ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import AR from '../messages/ar.json';
import EN from '../messages/en.json';
import { startBuiltApp, type RunningApp } from './support/next-server.js';
import { startStubApi, type StubApi } from './support/stub-api.js';

/**
 * The category console, over real HTTP against the built app.
 *
 * What only a test at this level can prove:
 *
 * **A colleague who may not open the section receives a refusal and no data** — not hidden data, no data. The
 * assertions look for the category's slug, its name and its public address in the whole response, flight payload
 * included, because a server component that rendered and then hid a row would still have shipped it.
 *
 * **A reader sees the tree and no controls.** `canManage` comes back false and every form's words are absent from
 * the payload, not merely invisible.
 *
 * **The tree is shown whole, including what the public cannot see**, with the one state a row cannot report about
 * itself — active, under a hidden ancestor — said out loud.
 *
 * **There is no rename control and no delete control anywhere**, because there are no such routes.
 *
 * No browser, no Playwright, no live provider, no deployment.
 */

const CANARY_CREDENTIAL = 'test-admin-categories-canary-credential-abc';
const SESSION = '__Host-mp_admin_access=canary-admin-access-token-not-real';

const STAFF = '11111111-1111-4111-8111-111111111111';
const CATEGORY = 'cc000000-0000-4000-8000-0000000000c1';
const CHILD = 'cc000000-0000-4000-8000-0000000000c2';

const READ = 'catalog.category.read';
const MANAGE = 'catalog.category.manage';

/** Everything an Admin holds that this section is not about. */
const ADMIN = [READ, MANAGE, 'catalog.listing.read', 'cms.page.read', 'audit.read'];
const CATEGORY_READER = [READ, 'catalog.listing.read'];

type Who =
  | { kind: 'unauthenticated' }
  | { kind: 'buyer' }
  | { kind: 'staff-aal1' }
  | { kind: 'staff'; permissions: readonly string[]; locale?: 'en' | 'ar' };

type Data = 'default' | 'empty' | 'unavailable' | 'readerDetail' | 'shadowed' | 'unwritten';

interface Serve {
  readonly who: Who;
  readonly data?: Data;
}

const ROOT = {
  categoryId: CATEGORY,
  parentId: null,
  slug: 'furniture',
  depth: 0,
  sortOrder: 1,
  listingTypeCode: 'product',
  isActive: true,
  isVisible: true,
  childCount: 1,
  listingCount: 4,
  translatedLocales: ['en', 'ar'],
  name: 'Furniture',
  updatedAt: '2026-05-02T09:00:00.000Z',
};

const SHADOWED_CHILD = {
  ...ROOT,
  categoryId: CHILD,
  parentId: CATEGORY,
  slug: 'seating',
  depth: 1,
  isActive: true,
  // Active, and still reaching nobody: the state the console has to say out loud.
  isVisible: false,
  childCount: 0,
  listingCount: 0,
  translatedLocales: [],
  name: null,
};

let api: StubApi;
let app: RunningApp;

function json(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function problem(response: ServerResponse, status: number, code: string): void {
  response.writeHead(status, { 'content-type': 'application/problem+json' });
  response.end(JSON.stringify({ status, code }));
}

function apiServes(serve: Serve): void {
  const data: Data = serve.data ?? 'default';
  api.seen.length = 0;
  api.reply((request, response) => {
    const path = request.url.split('?')[0] ?? '';
    const who = serve.who;

    if (path === '/v1/admin/session') {
      if (who.kind === 'unauthenticated') return problem(response, 401, 'AUTHENTICATION_REQUIRED');
      const base = { id: STAFF, displayName: 'Nadia', localeCode: who.kind === 'staff' ? (who.locale ?? 'en') : 'en' };
      if (who.kind === 'buyer') {
        return json(response, { session: { ...base, isStaff: false, requiresStepUp: false, roles: [], permissions: [] } });
      }
      if (who.kind === 'staff-aal1') {
        return json(response, { session: { ...base, isStaff: true, requiresStepUp: true, roles: [], permissions: [] } });
      }
      return json(response, {
        session: { ...base, isStaff: true, requiresStepUp: false, roles: ['admin'], permissions: [...who.permissions] },
      });
    }

    const held = (key: string): boolean => who.kind === 'staff' && who.permissions.includes(key);

    // The API's own gating, modelled: every read answers 404 for a caller without the read key.
    if (path === '/v1/admin/categories') {
      if (!held(READ)) return problem(response, 404, 'NOT_FOUND');
      if (data === 'unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      if (data === 'empty') return json(response, { categories: [] });
      if (data === 'shadowed') return json(response, { categories: [ROOT, SHADOWED_CHILD] });
      return json(response, { categories: [ROOT] });
    }

    if (path === `/v1/admin/categories/${CATEGORY}`) {
      if (!held(READ)) return problem(response, 404, 'NOT_FOUND');
      if (data === 'unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      return json(response, {
        category: {
          ...ROOT,
          parentSlug: null,
          createdAt: '2026-04-01T09:00:00.000Z',
          // The server's answer, which is exactly what the screen must render from.
          canManage: data === 'readerDetail' ? false : held(MANAGE),
          ...(data === 'unwritten' ? { translatedLocales: [], name: null } : {}),
        },
        translations:
          data === 'unwritten'
            ? []
            : [
                {
                  localeCode: 'en',
                  name: 'Furniture',
                  description: null,
                  metaTitle: 'Furniture',
                  metaDescription: null,
                  updatedAt: '2026-05-02T09:00:00.000Z',
                },
              ],
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
}, 180_000);

afterAll(async () => {
  await app.stop();
  await api.stop();
});

describe('who may open the section', () => {
  it('shows the tree to a colleague holding the read key', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { status, html } = await get('/catalog/categories');
    expect(status).toBe(200);
    expect(html).toContain(EN.Sections.categories.title);
    expect(html).toContain('Furniture');
    expect(html).toContain('/category/furniture');
  });

  it('gives a buyer a refusal and not one word about a category', async () => {
    apiServes({ who: { kind: 'buyer' } });
    const { html } = await get('/catalog/categories');
    for (const leak of ['Furniture', 'furniture', '/category/furniture', CATEGORY]) {
      expect(html, leak).not.toContain(leak);
    }
  });

  it('gives a staff session at aal1 a refusal and no data', async () => {
    apiServes({ who: { kind: 'staff-aal1' } });
    const { html } = await get('/catalog/categories');
    for (const leak of ['Furniture', 'furniture', CATEGORY]) {
      expect(html, leak).not.toContain(leak);
    }
  });

  it('gives a colleague holding other keys a refusal and no data', async () => {
    apiServes({ who: { kind: 'staff', permissions: ['catalog.listing.read', 'support.ticket.read'] } });
    const { html } = await get('/catalog/categories');
    for (const leak of ['Furniture', 'furniture', CATEGORY]) {
      expect(html, leak).not.toContain(leak);
    }
  });

  it('sends somebody with no session at all to sign in', async () => {
    apiServes({ who: { kind: 'unauthenticated' } });
    const { html } = await get('/catalog/categories', null);
    expect(html).not.toContain('Furniture');
  });
});

describe('the tree', () => {
  it('reports depth, order, visibility, locale coverage and contents', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get('/catalog/categories');
    expect(html).toContain(EN.Categories.columnDepth);
    expect(html).toContain(EN.Categories.columnOrder);
    expect(html).toContain(EN.Categories.columnLocales);
    expect(html).toContain(EN.Categories.stateShown);
    expect(html).toContain('en, ar');
  });

  it('says out loud when an active category is still reaching nobody', async () => {
    // The one state a row cannot report about itself.
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'shadowed' });
    const { html } = await get('/catalog/categories');
    expect(html).toContain(EN.Categories.shadowed);
    expect(html).toContain(EN.Categories.noLocales);
  });

  it('says what an empty catalogue means rather than showing an empty table', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'empty' });
    const { html } = await get('/catalog/categories');
    expect(html).toContain(EN.Categories.emptyTitle);
    expect(html).toContain(EN.Categories.emptyBody);
  });

  it('says so when the catalogue cannot be read, and shows no table', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'unavailable' });
    const { html } = await get('/catalog/categories');
    expect(html).toContain(EN.Categories.unavailableTitle);
    expect(html).not.toContain(EN.Categories.emptyTitle);
  });
});

describe('the controls', () => {
  it('offers the create form to a manager', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get('/catalog/categories');
    expect(html).toContain(EN.Categories.createSubmit);
    expect(html).toContain(EN.Categories.slugHint);
  });

  it('offers a reader no create form at all, not even hidden', async () => {
    apiServes({ who: { kind: 'staff', permissions: CATEGORY_READER } });
    const { html } = await get('/catalog/categories');
    expect(html).toContain('Furniture');
    expect(html).not.toContain(EN.Categories.createSubmit);
    expect(html).not.toContain(EN.Categories.slugHint);
  });

  it('offers a manager the placement, visibility and language forms on the detail', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get(`/catalog/categories/${CATEGORY}`);
    expect(html).toContain(EN.Categories.settingsSubmit);
    expect(html).toContain(EN.Categories.hideSubmit);
    expect(html).toContain(EN.Categories.translationSubmit);
  });

  it('tells a reader it may not change anything, and gives it no form', async () => {
    apiServes({ who: { kind: 'staff', permissions: CATEGORY_READER }, data: 'readerDetail' });
    const { html } = await get(`/catalog/categories/${CATEGORY}`);
    expect(html).toContain(EN.Categories.readOnlyBody);
    expect(html).not.toContain(EN.Categories.settingsSubmit);
    expect(html).not.toContain(EN.Categories.hideSubmit);
    expect(html).not.toContain(EN.Categories.translationSubmit);
  });

  it('offers no rename control and no delete control to anybody', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get(`/catalog/categories/${CATEGORY}`);
    // The address is shown, and said to be permanent, and there is no field to change it.
    expect(html).toContain(EN.Categories.slugImmutable);
    expect(html).not.toContain(EN.Categories.slugLabel);
    for (const absent of ['/api/categories/rename', '/api/categories/slug', 'Delete category']) {
      expect(html, absent).not.toContain(absent);
    }
  });

  it('says a category must be named before it can be shown', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'unwritten' });
    const { html } = await get(`/catalog/categories/${CATEGORY}`);
    expect(html).toContain(EN.Categories.unwrittenTitle);
    expect(html).toContain(EN.Categories.unwrittenBody);
  });
});

describe('a category that is not there', () => {
  it('answers with the neutral message rather than an error', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get('/catalog/categories/ff000000-0000-4000-8000-0000000000ff');
    expect(html).toContain(EN.Categories.notFoundBody);
  });

  it('treats an address that cannot name one the same way', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get('/catalog/categories/not-a-uuid');
    expect(html).toContain(EN.Categories.notFoundBody);
  });
});

describe('both languages', () => {
  it('renders the section in Arabic, right to left', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN, locale: 'ar' } });
    const { status, html } = await get('/catalog/categories');
    expect(status).toBe(200);
    expect(html).toContain('dir="rtl"');
    expect(html).toContain(AR.Sections.categories.title);
    expect(html).toContain(AR.Categories.treeHeading);
    expect(html).toContain(AR.Categories.createSubmit);
  });

  it('renders a reader’s read-only notice in Arabic too', async () => {
    apiServes({ who: { kind: 'staff', permissions: CATEGORY_READER, locale: 'ar' }, data: 'readerDetail' });
    const { html } = await get(`/catalog/categories/${CATEGORY}`);
    expect(html).toContain(AR.Categories.readOnlyBody);
    expect(html).not.toContain(AR.Categories.settingsSubmit);
  });

  it('says the address is permanent in Arabic as well', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN, locale: 'ar' } });
    const { html } = await get(`/catalog/categories/${CATEGORY}`);
    expect(html).toContain(AR.Categories.slugImmutable);
  });
});
