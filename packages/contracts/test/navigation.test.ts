import { describe, expect, it } from 'vitest';
import {
  CreateNavigationItemRequestSchema,
  CreateNavigationMenuRequestSchema,
  NAVIGATION_LABEL_MAX,
  NAVIGATION_MENU_KEYS,
  NAVIGATION_TARGET_KINDS,
  NAVIGATION_TARGET_STATES,
  NavigationMenuDetailSchema,
  NavigationPathSchema,
  NavigationStateRequestSchema,
  NavigationTargetInputSchema,
  PublicNavigationResponseSchema,
  ReorderNavigationItemsRequestSchema,
  UpdateNavigationItemRequestSchema,
  UpdateNavigationMenuRequestSchema,
} from '../src/index.js';

/**
 * The navigation contracts (0094).
 *
 * The three things worth proving here, because they are the three the database would otherwise have to catch:
 *
 *   * **the two-level limit is structural** — a link carries no children, so a third level cannot be expressed;
 *   * **a target is one thing** — 0030's "exactly the matching column is filled" CHECK is a discriminated union
 *     here, so a `path` carrying a page id is refused at the boundary;
 *   * **a path cannot leave the site** — including the protocol-relative form, which the pattern alone admits.
 */

const UUID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

describe('the shared vocabulary', () => {
  it('serves exactly the three keys the owner named', () => {
    expect([...NAVIGATION_MENU_KEYS]).toEqual(['header', 'footer', 'mobile']);
  });

  it('carries 0030s four target kinds and three target states', () => {
    expect([...NAVIGATION_TARGET_KINDS]).toEqual(['page', 'blog_post', 'category', 'path']);
    expect([...NAVIGATION_TARGET_STATES]).toEqual(['public', 'not_public', 'missing']);
  });

  it('uses 0030s own label length', () => {
    expect(NAVIGATION_LABEL_MAX).toBe(120);
  });
});

describe('a path', () => {
  it('accepts a relative address', () => {
    for (const path of ['/', '/listings', '/ar/blog', '/category/furniture', '/search?q=chair']) {
      expect(NavigationPathSchema.safeParse(path).success, path).toBe(true);
    }
  });

  it('refuses anything that could leave the site', () => {
    for (const path of [
      'https://evil.example',
      '//evil.example',
      '/\\evil.example',
      'listings',
      '',
      '   ',
      'javascript:alert(1)',
      '/listings#<script>',
    ]) {
      expect(NavigationPathSchema.safeParse(path).success, path).toBe(false);
    }
  });
});

describe('a target', () => {
  it('accepts each kind with exactly its own field', () => {
    expect(NavigationTargetInputSchema.safeParse({ kind: 'page', pageId: UUID }).success).toBe(true);
    expect(NavigationTargetInputSchema.safeParse({ kind: 'blog_post', blogPostId: UUID }).success).toBe(true);
    expect(NavigationTargetInputSchema.safeParse({ kind: 'category', categoryId: UUID }).success).toBe(true);
    expect(NavigationTargetInputSchema.safeParse({ kind: 'path', path: '/terms' }).success).toBe(true);
  });

  it('refuses a kind carrying a field that belongs to another', () => {
    // 0030's CHECK, as a shape: the database would refuse these, and so does the boundary.
    for (const target of [
      { kind: 'path', path: '/terms', pageId: UUID },
      { kind: 'page', pageId: UUID, path: '/terms' },
      { kind: 'page', blogPostId: UUID },
      { kind: 'category', categoryId: UUID, blogPostId: OTHER },
      { kind: 'page' },
      { kind: 'nonsense', path: '/terms' },
    ]) {
      expect(NavigationTargetInputSchema.safeParse(target).success, JSON.stringify(target)).toBe(false);
    }
  });
});

describe('the public response', () => {
  const link = {
    itemId: UUID,
    label: 'About',
    target: { kind: 'page', slug: 'about' },
    opensInNewTab: false,
  } as const;

  it('accepts a menu of items, each with its own second level', () => {
    const parsed = PublicNavigationResponseSchema.parse({
      menus: [
        {
          menuKey: 'footer',
          label: 'Footer',
          items: [
            { ...link, children: [{ ...link, itemId: OTHER, target: { kind: 'path', path: '/blog' } }] },
            { ...link, itemId: OTHER, children: [] },
          ],
        },
      ],
    });
    expect(parsed.menus[0]?.items[0]?.children[0]?.target).toEqual({ kind: 'path', path: '/blog' });
  });

  it('cannot express a third level', () => {
    // The structural form of owner decision 5: a child is a link, and a link has no children, so the deepest
    // thing representable is two levels. No renderer ever has to decide what a third one means.
    const parsed = PublicNavigationResponseSchema.safeParse({
      menus: [
        {
          menuKey: 'footer',
          label: 'Footer',
          items: [{ ...link, children: [{ ...link, children: [link] }] }],
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses an empty menu, which owner decision 3 drops upstream', () => {
    expect(
      PublicNavigationResponseSchema.safeParse({ menus: [{ menuKey: 'header', label: 'Header', items: [] }] })
        .success,
    ).toBe(false);
  });

  it('refuses a menu under a key the site does not place', () => {
    expect(
      PublicNavigationResponseSchema.safeParse({
        menus: [{ menuKey: 'sidebar', label: 'Sidebar', items: [{ ...link, children: [] }] }],
      }).success,
    ).toBe(false);
  });

  it('refuses a public item carrying a target state, an id or a sort order', () => {
    // The public gets what it needs to render and nothing about how the console reasons: an item that reached a
    // browser is public by construction, so there is no state to carry.
    for (const extra of [{ targetState: 'public' }, { pageId: UUID }, { sortOrder: 10 }, { isActive: true }]) {
      expect(
        PublicNavigationResponseSchema.safeParse({
          menus: [
            { menuKey: 'header', label: 'Header', items: [{ ...link, ...extra, children: [] }] },
          ],
        }).success,
        JSON.stringify(extra),
      ).toBe(false);
    }
  });

  it('refuses a public target that leaked a database id', () => {
    expect(
      PublicNavigationResponseSchema.safeParse({
        menus: [
          {
            menuKey: 'header',
            label: 'Header',
            items: [{ ...link, target: { kind: 'page', slug: 'about', pageId: UUID }, children: [] }],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('refuses a public path that is not relative', () => {
    expect(
      PublicNavigationResponseSchema.safeParse({
        menus: [
          {
            menuKey: 'header',
            label: 'Header',
            items: [{ ...link, target: { kind: 'path', path: '//evil.example' }, children: [] }],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('accepts a site with nothing composed', () => {
    expect(PublicNavigationResponseSchema.parse({ menus: [] }).menus).toEqual([]);
  });
});

describe('the console detail', () => {
  const base = {
    id: UUID,
    menuKey: 'header',
    labelEn: 'Header',
    labelAr: null,
    isActive: true,
    isServed: true,
    itemCount: 2,
    renderableItemCount: 1,
    createdAt: '2026-05-01T09:00:00.000Z',
    updatedAt: '2026-05-01T09:00:00.000Z',
    canManage: true,
  } as const;

  const item = {
    id: OTHER,
    parentId: null,
    depth: 1,
    labelEn: 'About',
    labelAr: null,
    targetKind: 'page',
    pageId: UUID,
    blogPostId: null,
    categoryId: null,
    path: null,
    targetSlug: 'about',
    targetTitle: 'About us',
    targetState: 'public',
    opensInNewTab: false,
    sortOrder: 10,
    isActive: true,
    createdAt: '2026-05-01T09:00:00.000Z',
    updatedAt: '2026-05-01T09:00:00.000Z',
  } as const;

  it('reports an item the public is not being shown, and why', () => {
    // Owner decision 3's console requirement, and owner decision 4's: an operator sees the state and the slug.
    const parsed = NavigationMenuDetailSchema.parse({
      ...base,
      items: [item, { ...item, id: UUID, targetState: 'not_public', targetSlug: 'nav-draft', isActive: false }],
    });
    expect(parsed.items[1]?.targetState).toBe('not_public');
    expect(parsed.items[1]?.targetSlug).toBe('nav-draft');
  });

  it('accepts an unserved menu, because the console lists every menu that exists', () => {
    const parsed = NavigationMenuDetailSchema.parse({
      ...base,
      menuKey: 'sidebar',
      isServed: false,
      items: [],
    });
    expect(parsed.isServed).toBe(false);
  });

  it('refuses a depth no menu can have', () => {
    expect(NavigationMenuDetailSchema.safeParse({ ...base, items: [{ ...item, depth: 3 }] }).success).toBe(false);
  });
});

describe('the authoring requests', () => {
  it('creates a menu under any legal key, served or not', () => {
    expect(CreateNavigationMenuRequestSchema.safeParse({ menuKey: 'header', labelEn: 'Header' }).success).toBe(
      true,
    );
    expect(CreateNavigationMenuRequestSchema.safeParse({ menuKey: 'sidebar', labelEn: 'Sidebar' }).success).toBe(
      true,
    );
  });

  it('refuses a key that is not 0030s shape, and a label the column could not hold', () => {
    for (const body of [
      { menuKey: 'Header', labelEn: 'Header' },
      { menuKey: '1header', labelEn: 'Header' },
      { menuKey: 'header-menu', labelEn: 'Header' },
      { menuKey: 'header', labelEn: '' },
      { menuKey: 'header', labelEn: 'x'.repeat(NAVIGATION_LABEL_MAX + 1) },
    ]) {
      expect(CreateNavigationMenuRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it('cannot show or hide anything through a save', () => {
    expect(
      CreateNavigationMenuRequestSchema.safeParse({ menuKey: 'header', labelEn: 'Header', isActive: true })
        .success,
    ).toBe(false);
    expect(
      UpdateNavigationMenuRequestSchema.safeParse({ labelEn: 'Header', isActive: false }).success,
    ).toBe(false);
    expect(
      UpdateNavigationItemRequestSchema.safeParse({ labelEn: 'About', isActive: false }).success,
    ).toBe(false);
  });

  it('refuses an update with nothing in it', () => {
    expect(UpdateNavigationMenuRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateNavigationItemRequestSchema.safeParse({}).success).toBe(false);
  });

  it('creates an item with a parent, a tab preference and a position', () => {
    const parsed = CreateNavigationItemRequestSchema.parse({
      menuId: UUID,
      labelEn: 'About us',
      labelAr: 'من نحن',
      target: { kind: 'page', pageId: OTHER },
      parentId: UUID,
      opensInNewTab: true,
      sortOrder: 20,
    });
    expect(parsed.target).toEqual({ kind: 'page', pageId: OTHER });
    expect(parsed.opensInNewTab).toBe(true);
  });

  it('refuses an item with no target at all', () => {
    expect(CreateNavigationItemRequestSchema.safeParse({ menuId: UUID, labelEn: 'About' }).success).toBe(false);
  });

  it('refuses an item that tries to name its own depth or state', () => {
    for (const extra of [{ depth: 2 }, { isActive: true }, { targetState: 'public' }, { menuKey: 'header' }]) {
      expect(
        CreateNavigationItemRequestSchema.safeParse({
          menuId: UUID,
          labelEn: 'About',
          target: { kind: 'path', path: '/about' },
          ...extra,
        }).success,
        JSON.stringify(extra),
      ).toBe(false);
    }
  });

  it('takes a reorder as one menu and the order it should hold', () => {
    expect(ReorderNavigationItemsRequestSchema.parse({ menuId: UUID, itemIds: [UUID, OTHER] }).itemIds).toEqual([
      UUID,
      OTHER,
    ]);
    expect(ReorderNavigationItemsRequestSchema.safeParse({ menuId: UUID, itemIds: [] }).success).toBe(false);
    expect(ReorderNavigationItemsRequestSchema.safeParse({ itemIds: [UUID] }).success).toBe(false);
  });

  it('takes a state change as one flag and nothing else', () => {
    expect(NavigationStateRequestSchema.parse({ isActive: false }).isActive).toBe(false);
    expect(NavigationStateRequestSchema.safeParse({}).success).toBe(false);
    expect(NavigationStateRequestSchema.safeParse({ isActive: false, sortOrder: 1 }).success).toBe(false);
  });
});
