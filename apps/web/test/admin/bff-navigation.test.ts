import { describe, expect, it } from 'vitest';
import {
  handleNavigationItemCreate,
  handleNavigationItemPromote,
  handleNavigationItemRemove,
  handleNavigationItemState,
  handleNavigationItemUpdate,
  handleNavigationItemsReorder,
  handleNavigationMenuCreate,
  handleNavigationMenuRemove,
  handleNavigationMenuState,
  handleNavigationMenuUpdate,
  readNavigationMenu,
  readNavigationMenus,
} from '../../src/admin/server/bff/navigation';

/**
 * The navigation BFF, on the admin origin (0094).
 *
 * What matters at this boundary:
 *
 *   * the caller's token comes from `__Host-mp_admin_access` and never from a body, and the browser's own `Cookie`
 *     header is never forwarded upstream;
 *   * **a target is rebuilt as the one value it is**, so a stale hidden field cannot send a page id alongside a
 *     path and a form cannot describe something 0030 would refuse;
 *   * **a path can never leave the site**, including in its protocol-relative form;
 *   * **no visibility flag is ever forwarded by an editing handler**, so changing a label cannot show a menu;
 *   * responses are validated before a byte reaches a browser;
 *   * every write is same-origin, and a cross-origin submission is refused before its body is read.
 *
 * Everything is stubbed at the `fetch` boundary: no API, no database, no network.
 */

const ENV = {
  API_BASE_URL: 'https://api.internal.test',
  INTERNAL_BFF_CREDENTIAL: 'test-navigation-canary-not-realabcdefghijkl',
} as const;

const SESSION_TOKEN = 'canary-admin-access-token-not-a-real-token';
const COOKIE = `__Host-mp_admin_access=${SESSION_TOKEN}; __Host-mp_admin_refresh=canary-refresh-not-real`;
const ORIGIN = 'https://admin.test';

const MENU = 'fd000000-0000-4000-8000-0000000000e1';
const ITEM = 'fd000000-0000-4000-8000-0000000000e2';
const PAGE = 'fd000000-0000-4000-8000-0000000000e4';

const SUMMARY = {
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

const ITEM_ROW = {
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
};

const DETAIL = { ...SUMMARY, canManage: true, items: [ITEM_ROW] };

interface Seen {
  url: string;
  method: string;
  cookie: string | null;
  sessionToken: string | null;
  body: string | null;
}

function apiReturns(status: number, body: unknown, seen: { value?: Seen } = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const sent = new Headers(init?.headers);
    seen.value = {
      url: String(input),
      method: init?.method ?? 'GET',
      cookie: sent.get('cookie'),
      sessionToken: sent.get('x-session-token') ?? sent.get('X-Session-Token'),
      body: typeof init?.body === 'string' ? init.body : null,
    };
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': status < 400 ? 'application/json' : 'application/problem+json' },
    });
  }) as unknown as typeof fetch;
}

function apiUnreachable(): typeof fetch {
  return (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
}

function writeRequest(
  path: string,
  method: string,
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { origin: ORIGIN, 'content-type': 'application/json', cookie: COOKIE, ...headers },
    body: JSON.stringify(body),
  });
}

/* ------------------------------------------------------------------------------------------------ */
/* Reads                                                                                             */
/* ------------------------------------------------------------------------------------------------ */

describe('readNavigationMenus', () => {
  it('presents the session token upstream and never the browser cookie', async () => {
    const seen: { value?: Seen } = {};
    await readNavigationMenus({
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReturns(200, { menus: [SUMMARY], canManage: true }, seen),
    });
    expect(seen.value?.sessionToken).toBe(SESSION_TOKEN);
    expect(seen.value?.cookie).toBeNull();
    expect(seen.value?.url).toContain('/v1/admin/navigation/menus');
  });

  it('is unauthenticated with no session cookie, without calling upstream', async () => {
    const seen: { value?: Seen } = {};
    const result = await readNavigationMenus({ env: ENV, cookieHeader: null, fetch: apiReturns(200, {}, seen) });
    expect(result.kind).toBe('unauthenticated');
    expect(seen.value).toBeUndefined();
  });

  it('carries the capability flag and both counts', async () => {
    const result = await readNavigationMenus({
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReturns(200, {
        menus: [{ ...SUMMARY, isServed: false, renderableItemCount: 0 }],
        canManage: false,
      }),
    });
    expect(result.kind === 'ok' && result.data.canManage).toBe(false);
    expect(result.kind === 'ok' && result.data.menus[0]?.isServed).toBe(false);
    expect(result.kind === 'ok' && result.data.menus[0]?.renderableItemCount).toBe(0);
  });

  it('turns every other answer into its own outcome', async () => {
    const cases: readonly [number, string][] = [
      [401, 'unauthenticated'],
      [404, 'notFound'],
      [400, 'invalid'],
      [503, 'unavailable'],
      [500, 'unavailable'],
    ];
    for (const [status, kind] of cases) {
      const result = await readNavigationMenus({
        env: ENV,
        cookieHeader: COOKIE,
        fetch: apiReturns(status, { status, code: 'X' }),
      });
      expect(result.kind, String(status)).toBe(kind);
    }
    expect((await readNavigationMenus({ env: ENV, cookieHeader: COOKIE, fetch: apiUnreachable() })).kind).toBe(
      'unavailable',
    );
  });

  it('refuses a drifted body rather than handing it to a screen', async () => {
    const result = await readNavigationMenus({
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReturns(200, { menus: [{ ...SUMMARY, promotionId: MENU }], canManage: true }),
    });
    expect(result.kind).toBe('unavailable');
  });
});

describe('readNavigationMenu', () => {
  it('asks for the one menu, with the locale for the targets own titles', async () => {
    const seen: { value?: Seen } = {};
    const result = await readNavigationMenu(MENU, 'ar', {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReturns(200, { menu: DETAIL }, seen),
    });
    expect(result.kind === 'ok' && result.data.items[0]?.targetSlug).toBe('about');
    expect(seen.value?.url).toContain(`/v1/admin/navigation/menus/${MENU}`);
    expect(seen.value?.url).toContain('locale=ar');
  });

  it('defaults an unrecognised locale rather than sending it on', async () => {
    const seen: { value?: Seen } = {};
    await readNavigationMenu(MENU, 'de', {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReturns(200, { menu: DETAIL }, seen),
    });
    expect(seen.value?.url).toContain('locale=en');
  });

  it('is notFound for an identifier that could not be one, without calling upstream', async () => {
    const seen: { value?: Seen } = {};
    const result = await readNavigationMenu('not-a-uuid', 'en', {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReturns(200, {}, seen),
    });
    expect(result.kind).toBe('notFound');
    expect(seen.value).toBeUndefined();
  });

  it('keeps every state an entry can be in', async () => {
    const result = await readNavigationMenu(MENU, 'en', {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReturns(200, {
        menu: {
          ...DETAIL,
          items: [
            ITEM_ROW,
            { ...ITEM_ROW, id: MENU, targetState: 'not_public' },
            { ...ITEM_ROW, id: PAGE, targetState: 'missing', targetSlug: null, targetTitle: null },
          ],
        },
      }),
    });
    expect(result.kind === 'ok' && result.data.items.map((item) => item.targetState)).toEqual([
      'public',
      'not_public',
      'missing',
    ]);
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* Writes                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

describe('creating a menu', () => {
  it('rebuilds the body from declared fields and presents the token', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleNavigationMenuCreate(
      writeRequest('/api/navigation/menus', 'POST', {
        menuKey: 'footer',
        labelEn: 'Footer',
        labelAr: 'التذييل',
        isActive: true,
        sortOrder: 3,
      }),
      { env: ENV, fetch: apiReturns(201, { id: MENU }, seen) },
    );
    expect(response.status).toBe(201);
    expect(seen.value?.sessionToken).toBe(SESSION_TOKEN);
    expect(seen.value?.cookie).toBeNull();
    // The two fields nobody declared never reach upstream: the body is rebuilt, not forwarded.
    const sent = JSON.parse(seen.value?.body ?? '{}') as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(['labelAr', 'labelEn', 'menuKey']);
  });

  it('refuses a key that is not 0030s shape', async () => {
    for (const menuKey of ['Header', 'header-menu', '1header', '']) {
      const response = await handleNavigationMenuCreate(
        writeRequest('/api/navigation/menus', 'POST', { menuKey, labelEn: 'X' }),
        { env: ENV, fetch: apiReturns(201, { id: MENU }) },
      );
      expect(response.status, menuKey).toBe(400);
    }
  });

  it('refuses a cross-origin submission before reading its body', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleNavigationMenuCreate(
      writeRequest('/api/navigation/menus', 'POST', { menuKey: 'header', labelEn: 'Header' }, {
        origin: 'https://evil.test',
      }),
      { env: ENV, fetch: apiReturns(201, { id: MENU }, seen) },
    );
    expect(response.status).toBe(403);
    expect(seen.value).toBeUndefined();
  });

  it('is unauthenticated with no session cookie', async () => {
    const response = await handleNavigationMenuCreate(
      new Request(`${ORIGIN}/api/navigation/menus`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ menuKey: 'header', labelEn: 'Header' }),
      }),
      { env: ENV, fetch: apiReturns(201, { id: MENU }) },
    );
    expect(response.status).toBe(401);
  });

  it('forwards a refusal with its own code', async () => {
    const response = await handleNavigationMenuCreate(
      writeRequest('/api/navigation/menus', 'POST', { menuKey: 'header', labelEn: 'Header' }),
      {
        env: ENV,
        fetch: apiReturns(409, { status: 409, code: 'NAVIGATION_MENU_KEY_TAKEN' }),
      },
    );
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('NAVIGATION_MENU_KEY_TAKEN');
  });
});

describe('changing a menu', () => {
  it('never forwards a visibility flag', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleNavigationMenuUpdate(
      writeRequest('/api/navigation/menus', 'PATCH', { menuId: MENU, labelEn: 'Header', isActive: false }),
      { env: ENV, fetch: apiReturns(200, { ok: true }, seen) },
    );
    expect(response.status).toBe(200);
    const sent = JSON.parse(seen.value?.body ?? '{}') as Record<string, unknown>;
    expect('isActive' in sent).toBe(false);
    expect(seen.value?.method).toBe('PATCH');
  });

  it('keeps a null Arabic label, which clears it, apart from an absent one', async () => {
    const cleared: { value?: Seen } = {};
    await handleNavigationMenuUpdate(
      writeRequest('/api/navigation/menus', 'PATCH', { menuId: MENU, labelAr: null }),
      { env: ENV, fetch: apiReturns(200, { ok: true }, cleared) },
    );
    expect(JSON.parse(cleared.value?.body ?? '{}')).toEqual({ labelAr: null });

    const untouched: { value?: Seen } = {};
    await handleNavigationMenuUpdate(
      writeRequest('/api/navigation/menus', 'PATCH', { menuId: MENU, labelEn: 'Header' }),
      { env: ENV, fetch: apiReturns(200, { ok: true }, untouched) },
    );
    expect(JSON.parse(untouched.value?.body ?? '{}')).toEqual({ labelEn: 'Header' });
  });

  it('refuses a body with no identifier and one with nothing to change', async () => {
    const noId = await handleNavigationMenuUpdate(
      writeRequest('/api/navigation/menus', 'PATCH', { labelEn: 'Header' }),
      { env: ENV, fetch: apiReturns(200, { ok: true }) },
    );
    const nothing = await handleNavigationMenuUpdate(
      writeRequest('/api/navigation/menus', 'PATCH', { menuId: MENU }),
      { env: ENV, fetch: apiReturns(200, { ok: true }) },
    );
    expect(noId.status).toBe(400);
    expect(nothing.status).toBe(400);
  });
});

describe('an entry', () => {
  it('is created with exactly the target field its kind owns', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleNavigationItemCreate(
      writeRequest('/api/navigation/items', 'POST', {
        menuId: MENU,
        labelEn: 'About',
        // A form posts every field; only the one belonging to the chosen kind may travel.
        targetKind: 'page',
        pageId: PAGE,
        blogPostId: ITEM,
        categoryId: ITEM,
        path: '/about',
        opensInNewTab: true,
      }),
      { env: ENV, fetch: apiReturns(201, { id: ITEM }, seen) },
    );
    expect(response.status).toBe(201);
    expect(JSON.parse(seen.value?.body ?? '{}')).toEqual({
      menuId: MENU,
      labelEn: 'About',
      target: { kind: 'page', pageId: PAGE },
      opensInNewTab: true,
    });
  });

  it('is created with a relative path and refused with anything else', async () => {
    const seen: { value?: Seen } = {};
    const ok = await handleNavigationItemCreate(
      writeRequest('/api/navigation/items', 'POST', {
        menuId: MENU,
        labelEn: 'Browse',
        targetKind: 'path',
        path: '/listings',
      }),
      { env: ENV, fetch: apiReturns(201, { id: ITEM }, seen) },
    );
    expect(ok.status).toBe(201);
    expect(JSON.parse(seen.value?.body ?? '{}').target).toEqual({ kind: 'path', path: '/listings' });

    for (const path of ['https://evil.example', '//evil.example', 'listings', '']) {
      const refused = await handleNavigationItemCreate(
        writeRequest('/api/navigation/items', 'POST', {
          menuId: MENU,
          labelEn: 'Away',
          targetKind: 'path',
          path,
        }),
        { env: ENV, fetch: apiReturns(201, { id: ITEM }) },
      );
      expect(refused.status, path).toBe(400);
    }
  });

  it('is refused with a kind nobody declared, or no kind at all', async () => {
    for (const body of [
      { menuId: MENU, labelEn: 'X', targetKind: 'nonsense', path: '/x' },
      { menuId: MENU, labelEn: 'X' },
      { menuId: MENU, labelEn: 'X', targetKind: 'page' },
    ]) {
      const response = await handleNavigationItemCreate(
        writeRequest('/api/navigation/items', 'POST', body),
        { env: ENV, fetch: apiReturns(201, { id: ITEM }) },
      );
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('carries a parent when one was chosen and nothing when none was', async () => {
    const withParent: { value?: Seen } = {};
    await handleNavigationItemCreate(
      writeRequest('/api/navigation/items', 'POST', {
        menuId: MENU,
        labelEn: 'About',
        targetKind: 'path',
        path: '/about',
        parentId: ITEM,
      }),
      { env: ENV, fetch: apiReturns(201, { id: ITEM }, withParent) },
    );
    expect(JSON.parse(withParent.value?.body ?? '{}').parentId).toBe(ITEM);

    // The select's empty option is the top level, and an empty string is not an identifier.
    const topLevel: { value?: Seen } = {};
    await handleNavigationItemCreate(
      writeRequest('/api/navigation/items', 'POST', {
        menuId: MENU,
        labelEn: 'About',
        targetKind: 'path',
        path: '/about',
        parentId: '',
      }),
      { env: ENV, fetch: apiReturns(201, { id: ITEM }, topLevel) },
    );
    expect('parentId' in JSON.parse(topLevel.value?.body ?? '{}')).toBe(false);
  });

  it('leaves the target alone when a change names no kind', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleNavigationItemUpdate(
      writeRequest('/api/navigation/items', 'PATCH', { itemId: ITEM, labelEn: 'About this site' }),
      { env: ENV, fetch: apiReturns(200, { ok: true }, seen) },
    );
    expect(response.status).toBe(200);
    expect(JSON.parse(seen.value?.body ?? '{}')).toEqual({ labelEn: 'About this site' });
  });

  it('never forwards a visibility flag on a change', async () => {
    const seen: { value?: Seen } = {};
    await handleNavigationItemUpdate(
      writeRequest('/api/navigation/items', 'PATCH', { itemId: ITEM, labelEn: 'About', isActive: false }),
      { env: ENV, fetch: apiReturns(200, { ok: true }, seen) },
    );
    expect('isActive' in JSON.parse(seen.value?.body ?? '{}')).toBe(false);
  });

  it('is shown, hidden, promoted and removed through its own routes', async () => {
    const state: { value?: Seen } = {};
    const stateResponse = await handleNavigationItemState(
      writeRequest('/api/navigation/items/state', 'POST', { itemId: ITEM, isActive: false }),
      { env: ENV, fetch: apiReturns(200, { ok: true }, state) },
    );
    expect(stateResponse.status).toBe(200);
    expect(state.value?.method).toBe('PUT');
    expect(state.value?.url).toContain(`/items/${ITEM}/state`);

    const promote: { value?: Seen } = {};
    await handleNavigationItemPromote(
      writeRequest('/api/navigation/items/promote', 'POST', { itemId: ITEM }),
      { env: ENV, fetch: apiReturns(200, { ok: true }, promote) },
    );
    expect(promote.value?.method).toBe('PUT');
    expect(promote.value?.url).toContain(`/items/${ITEM}/promote`);
    // A promote carries no body at all: it says one thing and needs no fields to say it.
    expect(promote.value?.body).toBeNull();

    const remove: { value?: Seen } = {};
    await handleNavigationItemRemove(
      writeRequest('/api/navigation/items/remove', 'POST', { itemId: ITEM }),
      { env: ENV, fetch: apiReturns(200, { ok: true }, remove) },
    );
    expect(remove.value?.method).toBe('DELETE');
    expect(remove.value?.body).toBeNull();
  });

  it('refuses a state change with no flag in it', async () => {
    const response = await handleNavigationItemState(
      writeRequest('/api/navigation/items/state', 'POST', { itemId: ITEM }),
      { env: ENV, fetch: apiReturns(200, { ok: true }) },
    );
    expect(response.status).toBe(400);
  });
});

describe('a menu state change and a removal', () => {
  it('each uses its own upstream method', async () => {
    const state: { value?: Seen } = {};
    await handleNavigationMenuState(
      writeRequest('/api/navigation/menus/state', 'POST', { menuId: MENU, isActive: false }),
      { env: ENV, fetch: apiReturns(200, { ok: true }, state) },
    );
    expect(state.value?.method).toBe('PUT');
    expect(state.value?.url).toContain(`/menus/${MENU}/state`);

    const remove: { value?: Seen } = {};
    await handleNavigationMenuRemove(
      writeRequest('/api/navigation/menus/remove', 'POST', { menuId: MENU }),
      { env: ENV, fetch: apiReturns(200, { ok: true }, remove) },
    );
    expect(remove.value?.method).toBe('DELETE');
    expect(remove.value?.body).toBeNull();
  });

  it('refuses an identifier that could not be one, without calling upstream', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleNavigationMenuRemove(
      writeRequest('/api/navigation/menus/remove', 'POST', { menuId: 'not-a-uuid' }),
      { env: ENV, fetch: apiReturns(200, { ok: true }, seen) },
    );
    expect(response.status).toBe(400);
    expect(seen.value).toBeUndefined();
  });
});

describe('a reorder', () => {
  it('sends the menu and the whole order', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleNavigationItemsReorder(
      writeRequest('/api/navigation/items/reorder', 'POST', { menuId: MENU, itemIds: [ITEM, PAGE] }),
      { env: ENV, fetch: apiReturns(200, { ok: true }, seen) },
    );
    expect(response.status).toBe(200);
    expect(JSON.parse(seen.value?.body ?? '{}')).toEqual({ menuId: MENU, itemIds: [ITEM, PAGE] });
    expect(seen.value?.method).toBe('PUT');
  });

  it('refuses an empty order, a missing menu and an entry that is not an identifier', async () => {
    for (const body of [
      { menuId: MENU, itemIds: [] },
      { itemIds: [ITEM] },
      { menuId: MENU, itemIds: ['not-a-uuid'] },
    ]) {
      const response = await handleNavigationItemsReorder(
        writeRequest('/api/navigation/items/reorder', 'POST', body),
        { env: ENV, fetch: apiReturns(200, { ok: true }) },
      );
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('becomes an outage when the API cannot be reached at all', async () => {
    const response = await handleNavigationItemsReorder(
      writeRequest('/api/navigation/items/reorder', 'POST', { menuId: MENU, itemIds: [ITEM] }),
      { env: ENV, fetch: apiUnreachable() },
    );
    expect(response.status).toBe(503);
  });

  it('becomes an outage when the API answers something nobody declared', async () => {
    const response = await handleNavigationItemsReorder(
      writeRequest('/api/navigation/items/reorder', 'POST', { menuId: MENU, itemIds: [ITEM] }),
      { env: ENV, fetch: apiReturns(200, { ok: 'yes' }) },
    );
    expect(response.status).toBe(503);
  });
});
