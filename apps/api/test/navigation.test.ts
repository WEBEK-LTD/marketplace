import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  CreateNavigationItemResponseSchema,
  CreateNavigationMenuResponseSchema,
  NavigationMenuDetailResponseSchema,
  NavigationMenusResponseSchema,
  NavigationWriteResponseSchema,
  PublicNavigationResponseSchema,
  SESSION_TOKEN_HEADER,
} from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { AuthenticationRequiredError } from '../src/auth/auth-errors.js';
import { NAVIGATION_STORE } from '../src/admin/navigation.service.js';
import { NAVIGATION_PUBLIC_STORE } from '../src/cms/navigation-public.service.js';
import { SUPABASE_AUTH_CLIENT } from '../src/auth/login.service.js';
import { STAFF_CONSOLE_STORE, type StaffConsoleRow } from '../src/admin/staff-console.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * Navigation at the API boundary (0094).
 *
 * The properties this suite exists for:
 *
 * **An empty menu never reaches a browser.** Owner decision 3, asserted from both ends: a menu whose items have
 * all become unavailable is absent from the public response, and the console detail still lists them with the
 * state that explains why.
 *
 * **A child without its parent is dropped.** The store returns a child whose parent is not in the result, and the
 * response does not contain it.
 *
 * **A page target carries a slug and never an href.** Owner decision 4 lives in the web application's route map,
 * so the API is asserted to hand over the slug and nothing more.
 *
 * **A malformed row costs one item, not the chrome.** The store returns a path that is not relative and the rest
 * of the menu still renders.
 *
 * **Reading and managing are separate keys**, and the split is visible: a caller with only `cms.navigation.read`
 * lists the menus, gets `canManage: false`, and every write answers 404 — identical to a menu that does not exist.
 *
 * **Editing cannot show anything.** `PATCH` is driven with `isActive` in the body and the store is asserted never
 * to have been asked to change a state.
 *
 * Everything is stubbed at the store boundary: no database, no Redis, no network.
 */

const STAFF = '11111111-1111-4111-8111-111111111111';
const MENU = 'fd000000-0000-4000-8000-0000000000e1';
const ITEM = 'fd000000-0000-4000-8000-0000000000e2';
const CHILD = 'fd000000-0000-4000-8000-0000000000e3';
const PAGE = 'fd000000-0000-4000-8000-0000000000e4';

function token(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.c2lnbmF0dXJl`;
}

const ACCESS_TOKEN = token({ sub: STAFF, aal: 'aal2' });
const AAL1_TOKEN = token({ sub: STAFF, aal: 'aal1' });

const READ = 'cms.navigation.read';
const MANAGE = 'cms.navigation.manage';

/** Every other key a console surface uses. Not one of them opens this section. */
const OTHER_KEYS = [
  'sellers.profile.read',
  'users.profile.read',
  'audit.read',
  'moderation.report.read',
  'support.ticket.read',
  'cms.page.read',
  'cms.blog.read',
  'cms.banner.read',
  'cms.homepage.read',
  'seo.metadata.read',
] as const;

/** One row of the public reader. A parent unless `parentItemId` says otherwise. */
function publicRow(overrides: Record<string, unknown> = {}) {
  return {
    menuKey: 'header',
    menuLabel: 'Header',
    itemId: ITEM,
    parentItemId: null,
    depth: 1,
    label: 'About',
    targetKind: 'page',
    targetSlug: 'about',
    targetPath: null,
    opensInNewTab: false,
    sortOrder: 10,
    ...overrides,
  };
}

const MENU_ROW = {
  menuId: MENU,
  menuKey: 'header',
  labelEn: 'Header',
  labelAr: null,
  isActive: true,
  isServed: true,
  itemCount: 2,
  renderableItemCount: 1,
  createdAt: '2026-05-01T09:00:00.000Z',
  updatedAt: '2026-05-02T09:00:00.000Z',
  canManage: true,
};

const ITEM_ROW = {
  itemId: ITEM,
  parentItemId: null,
  depth: 1,
  labelEn: 'About',
  labelAr: null,
  targetKind: 'page',
  pageId: PAGE,
  blogPostId: null,
  categoryId: null,
  targetPath: null,
  targetSlug: 'about',
  targetTitle: 'About us',
  targetState: 'public',
  opensInNewTab: false,
  sortOrder: 10,
  isActive: true,
  createdAt: '2026-05-01T09:00:00.000Z',
  updatedAt: '2026-05-02T09:00:00.000Z',
};

interface Seen {
  name: string;
  input: unknown;
}

interface Doubles {
  permissions?: readonly string[];
  unauthenticated?: boolean;
  publicRows?: readonly unknown[];
  publicError?: boolean;
  menuRows?: readonly unknown[];
  menuRow?: unknown;
  itemRows?: readonly unknown[];
  saveId?: string | null;
  writeResult?: boolean;
  writeError?: { code: string };
}

let app: NestFastifyApplication | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function sqlError(code: string): Error & { code: string } {
  const error = new Error('the database refused the write') as Error & { code: string };
  error.code = code;
  return error;
}

async function createApp(doubles: Doubles = {}): Promise<Seen[]> {
  const seen: Seen[] = [];

  const publicStore = {
    publicNavigationItems: async (input: unknown) => {
      seen.push({ name: 'publicNavigationItems', input });
      if (doubles.publicError === true) throw new Error('the database is unavailable');
      return doubles.publicRows ?? [publicRow()];
    },
  };

  const write = async (name: string, input: unknown): Promise<boolean> => {
    seen.push({ name, input });
    if (doubles.writeError !== undefined) throw sqlError(doubles.writeError.code);
    return doubles.writeResult ?? true;
  };

  const adminStore = {
    navigationMenusForStaff: async (input: unknown) => {
      seen.push({ name: 'navigationMenusForStaff', input });
      return doubles.menuRows ?? [MENU_ROW];
    },
    navigationMenuForStaff: async (input: unknown) => {
      seen.push({ name: 'navigationMenuForStaff', input });
      return doubles.menuRow === undefined ? MENU_ROW : doubles.menuRow;
    },
    navigationItemsForStaff: async (input: unknown) => {
      seen.push({ name: 'navigationItemsForStaff', input });
      return doubles.itemRows ?? [ITEM_ROW];
    },
    navigationMenuSaveForStaff: async (input: unknown) => {
      seen.push({ name: 'navigationMenuSaveForStaff', input });
      if (doubles.writeError !== undefined) throw sqlError(doubles.writeError.code);
      return doubles.saveId === undefined ? MENU : doubles.saveId;
    },
    navigationMenuStateForStaff: async (input: unknown) => write('navigationMenuStateForStaff', input),
    navigationMenuDeleteForStaff: async (input: unknown) => write('navigationMenuDeleteForStaff', input),
    navigationItemSaveForStaff: async (input: unknown) => {
      seen.push({ name: 'navigationItemSaveForStaff', input });
      if (doubles.writeError !== undefined) throw sqlError(doubles.writeError.code);
      return doubles.saveId === undefined ? ITEM : doubles.saveId;
    },
    navigationItemPromoteForStaff: async (input: unknown) => write('navigationItemPromoteForStaff', input),
    navigationItemStateForStaff: async (input: unknown) => write('navigationItemStateForStaff', input),
    navigationItemsReorderForStaff: async (input: unknown) => {
      seen.push({ name: 'navigationItemsReorderForStaff', input });
      if (doubles.writeError !== undefined) throw sqlError(doubles.writeError.code);
      return 1;
    },
    navigationItemDeleteForStaff: async (input: unknown) => write('navigationItemDeleteForStaff', input),
  };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(TEST_ENV)] })
    .overrideProvider(SUPABASE_AUTH_CLIENT)
    .useValue({
      getUser: async () => {
        if (doubles.unauthenticated === true) throw new AuthenticationRequiredError();
        return { id: STAFF, phone: null };
      },
      signInWithPassword: async () => {
        throw new Error('reading the navigation must never sign anyone in');
      },
      revokeAllSessions: async () => {
        throw new Error('reading the navigation must never revoke a session');
      },
    })
    .overrideProvider(STAFF_CONSOLE_STORE)
    .useValue({
      staffConsoleAccess: async (input: { userId: string; isAal2: boolean }): Promise<StaffConsoleRow> => {
        // The platform's own behaviour, modelled rather than asserted around: a role that requires MFA counts for
        // nothing at aal1, so the effective set is empty.
        const granted = [...(doubles.permissions ?? [READ, MANAGE])];
        return {
          hasConsoleRole: true,
          requiresStepUp: false,
          roles: ['admin'],
          permissions: input.isAal2 ? granted : [],
        };
      },
      buyerProfile: async (userId: string) => ({ id: userId, displayName: 'Nadia', localeCode: 'en' }),
    })
    .overrideProvider(NAVIGATION_PUBLIC_STORE)
    .useValue(publicStore)
    .overrideProvider(NAVIGATION_STORE)
    .useValue(adminStore)
    .compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(
    createFastifyAdapter(TEST_ENV, { logStream: { write: () => undefined } }),
    NEST_APP_OPTIONS,
  );
  await configureApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return seen;
}

function request(options: {
  method: string;
  url: string;
  accessToken?: string;
  payload?: unknown;
  credential?: string;
}) {
  const headers: Record<string, string> = {
    [INTERNAL_CREDENTIAL_HEADER]: options.credential ?? TEST_INTERNAL_CREDENTIAL,
  };
  if (options.accessToken !== undefined) headers[SESSION_TOKEN_HEADER] = options.accessToken;
  if (options.payload !== undefined) headers['content-type'] = 'application/json';
  return app!.inject({
    method: options.method as 'GET',
    url: options.url,
    headers,
    ...(options.payload === undefined ? {} : { payload: JSON.stringify(options.payload) }),
  });
}

/* ------------------------------------------------------------------------------------------------ */
/* The public menus                                                                                  */
/* ------------------------------------------------------------------------------------------------ */

describe('GET /v1/navigation', () => {
  it('answers with no session at all', async () => {
    await createApp();
    const response = await request({ method: 'GET', url: '/v1/navigation' });
    expect(response.statusCode).toBe(200);
    const body = PublicNavigationResponseSchema.parse(response.json());
    expect(body.menus[0]?.menuKey).toBe('header');
  });

  it('is a 200 with no menus for a site nobody has composed', async () => {
    await createApp({ publicRows: [] });
    const response = await request({ method: 'GET', url: '/v1/navigation' });
    expect(response.statusCode).toBe(200);
    expect(PublicNavigationResponseSchema.parse(response.json()).menus).toEqual([]);
  });

  it('asks for all three placements when none was named', async () => {
    const seen = await createApp();
    await request({ method: 'GET', url: '/v1/navigation' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.input).toEqual({ menuKeys: ['header', 'footer', 'mobile'], locale: 'en' });
  });

  it('asks for exactly the placements named, in that order, once each', async () => {
    const seen = await createApp();
    await request({ method: 'GET', url: '/v1/navigation?menus=footer,header,footer' });
    expect(seen[0]?.input).toEqual({ menuKeys: ['footer', 'header'], locale: 'en' });
  });

  it('ignores a placement this platform does not have rather than refusing', async () => {
    const seen = await createApp();
    const response = await request({ method: 'GET', url: '/v1/navigation?menus=sidebar,header' });
    expect(response.statusCode).toBe(200);
    expect(seen[0]?.input).toEqual({ menuKeys: ['header'], locale: 'en' });
  });

  it('reads nothing at all when every placement named is unknown', async () => {
    const seen = await createApp();
    const response = await request({ method: 'GET', url: '/v1/navigation?menus=sidebar,nonsense' });
    expect(response.statusCode).toBe(200);
    expect(PublicNavigationResponseSchema.parse(response.json()).menus).toEqual([]);
    // Not one database call: there was nothing to ask about.
    expect(seen).toEqual([]);
  });

  it('passes the locale through and defaults an unrecognised one', async () => {
    const seen = await createApp();
    await request({ method: 'GET', url: '/v1/navigation?locale=ar' });
    await request({ method: 'GET', url: '/v1/navigation?locale=de' });
    expect((seen[0]?.input as { locale: string }).locale).toBe('ar');
    expect((seen[1]?.input as { locale: string }).locale).toBe('en');
  });

  it('nests a second level under its parent and never deeper', async () => {
    await createApp({
      publicRows: [
        publicRow({ menuKey: 'footer', menuLabel: 'Footer', itemId: ITEM, label: 'Company' }),
        publicRow({
          menuKey: 'footer',
          menuLabel: 'Footer',
          itemId: CHILD,
          parentItemId: ITEM,
          depth: 2,
          label: 'About us',
        }),
      ],
    });
    const response = await request({ method: 'GET', url: '/v1/navigation?menus=footer' });
    const body = PublicNavigationResponseSchema.parse(response.json());
    expect(body.menus[0]?.items).toHaveLength(1);
    expect(body.menus[0]?.items[0]?.children.map((child) => child.label)).toEqual(['About us']);
  });

  it('drops a child whose parent is not in the result', async () => {
    // Owner decision 3's second half: the database omits a parent whose target went away, and an entry without
    // its heading is not the arrangement that was made.
    await createApp({
      publicRows: [publicRow({ itemId: CHILD, parentItemId: 'fd000000-0000-4000-8000-00000000ffff', depth: 2 })],
    });
    const response = await request({ method: 'GET', url: '/v1/navigation?menus=header' });
    expect(PublicNavigationResponseSchema.parse(response.json()).menus).toEqual([]);
  });

  it('hands over a slug for a page, a post and a category, and never an address', async () => {
    // Owner decision 4 belongs to the route map, so the API must not invent an href here.
    await createApp({
      publicRows: [
        publicRow({ itemId: ITEM, targetKind: 'page', targetSlug: 'about' }),
        publicRow({ itemId: CHILD, targetKind: 'blog_post', targetSlug: 'a-post', sortOrder: 20 }),
        publicRow({ itemId: PAGE, targetKind: 'category', targetSlug: 'furniture', sortOrder: 30 }),
      ],
    });
    const response = await request({ method: 'GET', url: '/v1/navigation?menus=header' });
    const body = PublicNavigationResponseSchema.parse(response.json());
    expect(body.menus[0]?.items.map((item) => item.target)).toEqual([
      { kind: 'page', slug: 'about' },
      { kind: 'blog_post', slug: 'a-post' },
      { kind: 'category', slug: 'furniture' },
    ]);
  });

  it('serves a path entry as the path it was given', async () => {
    await createApp({ publicRows: [publicRow({ targetKind: 'path', targetSlug: null, targetPath: '/listings' })] });
    const response = await request({ method: 'GET', url: '/v1/navigation?menus=header' });
    const body = PublicNavigationResponseSchema.parse(response.json());
    expect(body.menus[0]?.items[0]?.target).toEqual({ kind: 'path', path: '/listings' });
  });

  it('loses one unreadable entry rather than the whole chrome', async () => {
    await createApp({
      publicRows: [
        // A path that could leave the site, which 0030's CHECK should have refused: dropped here as well.
        publicRow({ itemId: CHILD, targetKind: 'path', targetSlug: null, targetPath: '//evil.example' }),
        // A kind nobody declared.
        publicRow({ itemId: PAGE, targetKind: 'nonsense', targetSlug: 'x', sortOrder: 20 }),
        // A page entry with no slug at all.
        publicRow({ itemId: MENU, targetKind: 'page', targetSlug: null, sortOrder: 30 }),
        publicRow({ itemId: ITEM, label: 'About', sortOrder: 40 }),
      ],
    });
    const response = await request({ method: 'GET', url: '/v1/navigation?menus=header' });
    const body = PublicNavigationResponseSchema.parse(response.json());
    expect(body.menus[0]?.items.map((item) => item.label)).toEqual(['About']);
  });

  it('carries opens_in_new_tab through as stored', async () => {
    await createApp({ publicRows: [publicRow({ opensInNewTab: true })] });
    const response = await request({ method: 'GET', url: '/v1/navigation?menus=header' });
    const body = PublicNavigationResponseSchema.parse(response.json());
    expect(body.menus[0]?.items[0]?.opensInNewTab).toBe(true);
  });

  it('falls back to the menu key when a menu has no label of its own', async () => {
    await createApp({ publicRows: [publicRow({ menuLabel: null })] });
    const response = await request({ method: 'GET', url: '/v1/navigation?menus=header' });
    expect(PublicNavigationResponseSchema.parse(response.json()).menus[0]?.label).toBe('header');
  });

  it('is a 503 when the menus could not be read, rather than an empty chrome', async () => {
    // The web layer falls back to its own neutral header and footer (owner decision 7), and it can only do that
    // if it can tell an outage from a site nobody has composed.
    await createApp({ publicError: true });
    const response = await request({ method: 'GET', url: '/v1/navigation' });
    expect(response.statusCode).toBe(503);
  });

  it('refuses a caller without the internal credential', async () => {
    await createApp();
    const response = await request({ method: 'GET', url: '/v1/navigation', credential: 'wrong' });
    expect(response.statusCode).toBe(403);
  });

  it('asks the database for nothing but the menus', async () => {
    // Owner decision — nothing here reads a banner, a promotion, a placement or a ranking, and the closed
    // inventory is what keeps it that way.
    const seen = await createApp();
    await request({ method: 'GET', url: '/v1/navigation' });
    expect([...new Set(seen.map((entry) => entry.name))]).toEqual(['publicNavigationItems']);
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* The console                                                                                       */
/* ------------------------------------------------------------------------------------------------ */

describe('GET /v1/admin/navigation/menus', () => {
  it('lists for a caller holding the read key, and reports the manage capability', async () => {
    await createApp({ permissions: [READ] });
    const response = await request({
      method: 'GET',
      url: '/v1/admin/navigation/menus',
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(200);
    const body = NavigationMenusResponseSchema.parse(response.json());
    expect(body.canManage).toBe(false);
    expect(body.menus[0]?.menuKey).toBe('header');
    expect(body.menus[0]?.renderableItemCount).toBe(1);
  });

  it('lists a menu the public site does not place, and marks it', async () => {
    await createApp({
      menuRows: [{ ...MENU_ROW, menuKey: 'sidebar', isServed: false, renderableItemCount: 0 }],
    });
    const response = await request({
      method: 'GET',
      url: '/v1/admin/navigation/menus',
      accessToken: ACCESS_TOKEN,
    });
    const body = NavigationMenusResponseSchema.parse(response.json());
    expect(body.menus[0]?.isServed).toBe(false);
  });

  it('is a 404 for every other console key, and for the same caller at aal1', async () => {
    for (const key of OTHER_KEYS) {
      await createApp({ permissions: [key] });
      const response = await request({
        method: 'GET',
        url: '/v1/admin/navigation/menus',
        accessToken: ACCESS_TOKEN,
      });
      expect(response.statusCode, key).toBe(404);
      await app?.close();
      app = undefined;
    }

    await createApp();
    const atAal1 = await request({
      method: 'GET',
      url: '/v1/admin/navigation/menus',
      accessToken: AAL1_TOKEN,
    });
    expect(atAal1.statusCode).toBe(404);
  });

  it('needs a session at all', async () => {
    await createApp();
    const response = await request({ method: 'GET', url: '/v1/admin/navigation/menus' });
    expect(response.statusCode).toBe(401);
  });
});

describe('GET /v1/admin/navigation/menus/:menuId', () => {
  it('lists every item, including the ones the public is not being shown', async () => {
    // Owner decision 3's console requirement: an operator sees what the public does not, and why.
    await createApp({
      itemRows: [
        ITEM_ROW,
        { ...ITEM_ROW, itemId: CHILD, targetState: 'not_public', targetSlug: 'nav-draft', isActive: false },
        { ...ITEM_ROW, itemId: PAGE, targetState: 'missing', targetSlug: null, targetTitle: null },
      ],
    });
    const response = await request({
      method: 'GET',
      url: `/v1/admin/navigation/menus/${MENU}`,
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(200);
    const body = NavigationMenuDetailResponseSchema.parse(response.json());
    expect(body.menu.items.map((item) => item.targetState)).toEqual(['public', 'not_public', 'missing']);
    expect(body.menu.items[1]?.targetSlug).toBe('nav-draft');
    expect(body.menu.canManage).toBe(true);
  });

  it('passes the locale through for the targets own titles', async () => {
    const seen = await createApp();
    await request({
      method: 'GET',
      url: `/v1/admin/navigation/menus/${MENU}?locale=ar`,
      accessToken: ACCESS_TOKEN,
    });
    const items = seen.find((entry) => entry.name === 'navigationItemsForStaff');
    expect((items?.input as { locale: string }).locale).toBe('ar');
  });

  it('is the same 404 for a menu that does not exist and a caller who may not read it', async () => {
    await createApp({ menuRow: null });
    const absent = await request({
      method: 'GET',
      url: `/v1/admin/navigation/menus/${MENU}`,
      accessToken: ACCESS_TOKEN,
    });
    await app?.close();
    app = undefined;

    await createApp({ permissions: [] });
    const refused = await request({
      method: 'GET',
      url: `/v1/admin/navigation/menus/${MENU}`,
      accessToken: ACCESS_TOKEN,
    });
    expect(absent.statusCode).toBe(404);
    expect(refused.statusCode).toBe(404);
    expect(absent.json()).toEqual(refused.json());
  });

  it('refuses an identifier that could not be one', async () => {
    await createApp();
    const response = await request({
      method: 'GET',
      url: '/v1/admin/navigation/menus/not-a-uuid',
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(400);
  });

  it('is not shadowed by the reorder route', async () => {
    const seen = await createApp();
    const response = await request({
      method: 'PUT',
      url: '/v1/admin/navigation/items/reorder',
      accessToken: ACCESS_TOKEN,
      payload: { menuId: MENU, itemIds: [ITEM] },
    });
    expect(response.statusCode).toBe(200);
    expect(seen.some((entry) => entry.name === 'navigationItemsReorderForStaff')).toBe(true);
  });
});

describe('writing', () => {
  it('creates a menu under any legal key', async () => {
    const seen = await createApp();
    const response = await request({
      method: 'POST',
      url: '/v1/admin/navigation/menus',
      accessToken: ACCESS_TOKEN,
      payload: { menuKey: 'sidebar', labelEn: 'Sidebar' },
    });
    expect(response.statusCode).toBe(201);
    expect(CreateNavigationMenuResponseSchema.parse(response.json()).id).toBe(MENU);
    const save = seen.find((entry) => entry.name === 'navigationMenuSaveForStaff');
    expect(save?.input).toMatchObject({ menuId: null, menuKey: 'sidebar', labelEn: 'Sidebar', labelAr: null });
  });

  it('creates an item with the one target field its kind owns', async () => {
    const seen = await createApp();
    const response = await request({
      method: 'POST',
      url: '/v1/admin/navigation/items',
      accessToken: ACCESS_TOKEN,
      payload: {
        menuId: MENU,
        labelEn: 'About',
        target: { kind: 'page', pageId: PAGE },
        opensInNewTab: true,
        sortOrder: 20,
      },
    });
    expect(response.statusCode).toBe(201);
    expect(CreateNavigationItemResponseSchema.parse(response.json()).id).toBe(ITEM);
    const save = seen.find((entry) => entry.name === 'navigationItemSaveForStaff');
    expect(save?.input).toMatchObject({
      itemId: null,
      menuId: MENU,
      targetKind: 'page',
      pageId: PAGE,
      blogPostId: null,
      categoryId: null,
      path: null,
      opensInNewTab: true,
      sortOrder: 20,
    });
  });

  it('refuses a target carrying a field that belongs to another kind', async () => {
    await createApp();
    const response = await request({
      method: 'POST',
      url: '/v1/admin/navigation/items',
      accessToken: ACCESS_TOKEN,
      payload: {
        menuId: MENU,
        labelEn: 'About',
        target: { kind: 'path', path: '/about', pageId: PAGE },
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses a path that could leave the site', async () => {
    for (const path of ['https://evil.example', '//evil.example', 'about']) {
      await createApp();
      const response = await request({
        method: 'POST',
        url: '/v1/admin/navigation/items',
        accessToken: ACCESS_TOKEN,
        payload: { menuId: MENU, labelEn: 'Away', target: { kind: 'path', path } },
      });
      expect(response.statusCode, path).toBe(400);
      await app?.close();
      app = undefined;
    }
  });

  it('cannot show anything through a save', async () => {
    const seen = await createApp();
    const menu = await request({
      method: 'PATCH',
      url: `/v1/admin/navigation/menus/${MENU}`,
      accessToken: ACCESS_TOKEN,
      payload: { labelEn: 'Header', isActive: true },
    });
    const item = await request({
      method: 'PATCH',
      url: `/v1/admin/navigation/items/${ITEM}`,
      accessToken: ACCESS_TOKEN,
      payload: { labelEn: 'About', isActive: true },
    });
    expect(menu.statusCode).toBe(400);
    expect(item.statusCode).toBe(400);
    // And the state writers were never reached by either.
    expect(seen.some((entry) => entry.name.endsWith('StateForStaff'))).toBe(false);
  });

  it('leaves the target alone when a change does not name one', async () => {
    const seen = await createApp();
    const response = await request({
      method: 'PATCH',
      url: `/v1/admin/navigation/items/${ITEM}`,
      accessToken: ACCESS_TOKEN,
      payload: { labelEn: 'About this site' },
    });
    expect(response.statusCode).toBe(200);
    const save = seen.find((entry) => entry.name === 'navigationItemSaveForStaff');
    expect(save?.input).toMatchObject({
      itemId: ITEM,
      labelEn: 'About this site',
      targetKind: null,
      pageId: null,
      blogPostId: null,
      categoryId: null,
      path: null,
      sortOrder: null,
    });
  });

  it('replaces the whole target when a change names one', async () => {
    const seen = await createApp();
    await request({
      method: 'PATCH',
      url: `/v1/admin/navigation/items/${ITEM}`,
      accessToken: ACCESS_TOKEN,
      payload: { target: { kind: 'path', path: '/about-us' } },
    });
    const save = seen.find((entry) => entry.name === 'navigationItemSaveForStaff');
    expect(save?.input).toMatchObject({ targetKind: 'path', path: '/about-us', pageId: null });
  });

  it('never moves an item between menus', async () => {
    const seen = await createApp();
    await request({
      method: 'PATCH',
      url: `/v1/admin/navigation/items/${ITEM}`,
      accessToken: ACCESS_TOKEN,
      payload: { labelEn: 'About' },
    });
    const save = seen.find((entry) => entry.name === 'navigationItemSaveForStaff');
    expect((save?.input as { menuId: string | null }).menuId).toBeNull();
  });

  it('refuses an update with nothing in it', async () => {
    await createApp();
    const response = await request({
      method: 'PATCH',
      url: `/v1/admin/navigation/items/${ITEM}`,
      accessToken: ACCESS_TOKEN,
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });

  it('shows and hides a menu and an item through their own routes', async () => {
    const seen = await createApp();
    const menu = await request({
      method: 'PUT',
      url: `/v1/admin/navigation/menus/${MENU}/state`,
      accessToken: ACCESS_TOKEN,
      payload: { isActive: false },
    });
    const item = await request({
      method: 'PUT',
      url: `/v1/admin/navigation/items/${ITEM}/state`,
      accessToken: ACCESS_TOKEN,
      payload: { isActive: true },
    });
    expect(NavigationWriteResponseSchema.parse(menu.json()).ok).toBe(true);
    expect(NavigationWriteResponseSchema.parse(item.json()).ok).toBe(true);
    expect(seen.find((entry) => entry.name === 'navigationMenuStateForStaff')?.input).toMatchObject({
      isActive: false,
    });
    expect(seen.find((entry) => entry.name === 'navigationItemStateForStaff')?.input).toMatchObject({
      isActive: true,
    });
  });

  it('promotes an item out from under its heading', async () => {
    const seen = await createApp();
    const response = await request({
      method: 'PUT',
      url: `/v1/admin/navigation/items/${ITEM}/promote`,
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(200);
    expect(seen.find((entry) => entry.name === 'navigationItemPromoteForStaff')?.input).toMatchObject({
      itemId: ITEM,
    });
  });

  it('is a 404 when a promote moved nothing, because the console should reload', async () => {
    await createApp({ writeResult: false });
    const response = await request({
      method: 'PUT',
      url: `/v1/admin/navigation/items/${ITEM}/promote`,
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(404);
  });

  it('removes a menu and an item', async () => {
    const seen = await createApp();
    const menu = await request({
      method: 'DELETE',
      url: `/v1/admin/navigation/menus/${MENU}`,
      accessToken: ACCESS_TOKEN,
    });
    const item = await request({
      method: 'DELETE',
      url: `/v1/admin/navigation/items/${ITEM}`,
      accessToken: ACCESS_TOKEN,
    });
    expect(menu.statusCode).toBe(200);
    expect(item.statusCode).toBe(200);
    expect(seen.some((entry) => entry.name === 'navigationMenuDeleteForStaff')).toBe(true);
    expect(seen.some((entry) => entry.name === 'navigationItemDeleteForStaff')).toBe(true);
  });

  it('is a 404 for every write when the caller holds only the read key', async () => {
    const writes: readonly { method: string; url: string; payload?: unknown }[] = [
      { method: 'POST', url: '/v1/admin/navigation/menus', payload: { menuKey: 'header', labelEn: 'Header' } },
      { method: 'PATCH', url: `/v1/admin/navigation/menus/${MENU}`, payload: { labelEn: 'Header' } },
      { method: 'PUT', url: `/v1/admin/navigation/menus/${MENU}/state`, payload: { isActive: true } },
      { method: 'DELETE', url: `/v1/admin/navigation/menus/${MENU}` },
      {
        method: 'POST',
        url: '/v1/admin/navigation/items',
        payload: { menuId: MENU, labelEn: 'About', target: { kind: 'path', path: '/about' } },
      },
      { method: 'PATCH', url: `/v1/admin/navigation/items/${ITEM}`, payload: { labelEn: 'About' } },
      { method: 'PUT', url: `/v1/admin/navigation/items/${ITEM}/state`, payload: { isActive: true } },
      { method: 'PUT', url: `/v1/admin/navigation/items/${ITEM}/promote` },
      { method: 'DELETE', url: `/v1/admin/navigation/items/${ITEM}` },
      { method: 'PUT', url: '/v1/admin/navigation/items/reorder', payload: { menuId: MENU, itemIds: [ITEM] } },
    ];

    for (const write of writes) {
      // The database refuses a caller without the manage key, and that refusal is a 404 identical to an absence.
      await createApp({ permissions: [READ], writeError: { code: '42501' } });
      const response = await request({ ...write, accessToken: ACCESS_TOKEN });
      expect(response.statusCode, `${write.method} ${write.url}`).toBe(404);
      await app?.close();
      app = undefined;
    }
  });
});

describe('a refused write', () => {
  it('becomes a 409 carrying our own code, never the databases text', async () => {
    const cases: readonly { code: string; expected: string }[] = [
      { code: '23505', expected: 'NAVIGATION_MENU_KEY_TAKEN' },
      { code: '23514', expected: 'NAVIGATION_NOT_ALLOWED' },
      { code: '23503', expected: 'NAVIGATION_REFERENCE_UNKNOWN' },
      { code: '23502', expected: 'NAVIGATION_NOT_ALLOWED' },
    ];

    for (const refusal of cases) {
      await createApp({ writeError: { code: refusal.code } });
      const response = await request({
        method: 'POST',
        url: '/v1/admin/navigation/menus',
        accessToken: ACCESS_TOKEN,
        payload: { menuKey: 'header', labelEn: 'Header' },
      });
      expect(response.statusCode, refusal.code).toBe(409);
      const body = response.json() as { code: string; detail: string };
      expect(body.code).toBe(refusal.expected);
      expect(body.detail).not.toContain('the database refused the write');
      await app?.close();
      app = undefined;
    }
  });

  it('is a 503 for a SQLSTATE nobody mapped', async () => {
    await createApp({ writeError: { code: '08006' } });
    const response = await request({
      method: 'POST',
      url: '/v1/admin/navigation/menus',
      accessToken: ACCESS_TOKEN,
      payload: { menuKey: 'header', labelEn: 'Header' },
    });
    expect(response.statusCode).toBe(503);
  });

  it('is a 404 when a save named something that does not exist', async () => {
    await createApp({ saveId: null });
    const response = await request({
      method: 'PATCH',
      url: `/v1/admin/navigation/menus/${MENU}`,
      accessToken: ACCESS_TOKEN,
      payload: { labelEn: 'Header' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('is a 404 when a state change or a delete matched nothing', async () => {
    for (const write of [
      { method: 'PUT', url: `/v1/admin/navigation/menus/${MENU}/state`, payload: { isActive: true } },
      { method: 'DELETE', url: `/v1/admin/navigation/menus/${MENU}` },
      { method: 'PUT', url: `/v1/admin/navigation/items/${ITEM}/state`, payload: { isActive: true } },
      { method: 'DELETE', url: `/v1/admin/navigation/items/${ITEM}` },
    ]) {
      await createApp({ writeResult: false });
      const response = await request({ ...write, accessToken: ACCESS_TOKEN });
      expect(response.statusCode, write.url).toBe(404);
      await app?.close();
      app = undefined;
    }
  });

  it('is still a 200 when a reorder moved nothing, because a stale screen is not a refusal', async () => {
    await createApp({ writeResult: false });
    const response = await request({
      method: 'PUT',
      url: '/v1/admin/navigation/items/reorder',
      accessToken: ACCESS_TOKEN,
      payload: { menuId: MENU, itemIds: [ITEM] },
    });
    expect(response.statusCode).toBe(200);
  });
});
