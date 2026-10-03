import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  NAVIGATION_MENU_KEYS,
  NavigationPathSchema,
  type NavigationMenuKey,
  type PublicLocale,
  type PublicNavigationItem,
  type PublicNavigationLink,
  type PublicNavigationMenu,
  type PublicNavigationTarget,
} from '@repo/contracts';
import { CmsPublicUnavailableError } from './cms-errors.js';

/**
 * The public side of navigation (0094).
 *
 * **This service assembles; it decides nothing.** Which menus are active, which items are active, and which
 * targets are still public are all answered by the database, through the predicates that already own each
 * question. This layer reads the flat rows and builds the two-level shape a renderer wants.
 *
 * **Owner decision 3 is applied in the database and completed here.** The reader omits an item whose target is
 * not public and any child of an omitted parent; this layer drops a menu that came back with nothing, so an
 * empty menu is never in the response and no renderer has to decide what one means.
 *
 * **Owner decision 4 is not applied here either.** A page item carries its slug; whether this platform serves a
 * page at that address is the *web application's* route map, and the surface that owns it drops what it cannot
 * serve. Nothing here invents a URL for a page, a post or a category.
 *
 * **A malformed row costs one item, not the chrome.** Every item is checked against the public contract before it
 * is used — a path that is not relative, a kind nobody declared — and one that fails is skipped and logged. The
 * header of every page on the site goes through here, so a single bad row must not be able to take the site down.
 */

export const NAVIGATION_PUBLIC_STORE = Symbol('NAVIGATION_PUBLIC_STORE');

/** One row of `app_private.public_navigation_items` (0094). */
export interface PublicNavigationItemDbRow {
  readonly menuKey: string;
  readonly menuLabel: string | null;
  readonly itemId: string;
  readonly parentItemId: string | null;
  readonly depth: number | string;
  readonly label: string | null;
  readonly targetKind: string;
  readonly targetSlug: string | null;
  readonly targetPath: string | null;
  readonly opensInNewTab: boolean | null;
  readonly sortOrder: number | string;
}

export interface NavigationPublicStore {
  /** `app_private.public_navigation_items(text[], text)`: the renderable items of the menus named, in order. */
  publicNavigationItems(input: {
    menuKeys: readonly string[];
    locale: PublicLocale;
  }): Promise<readonly PublicNavigationItemDbRow[]>;
}

const SERVED: ReadonlySet<string> = new Set(NAVIGATION_MENU_KEYS);

/** Where one row points, or null when the row could not say. */
function targetOf(row: PublicNavigationItemDbRow): PublicNavigationTarget | null {
  switch (row.targetKind) {
    case 'page':
    case 'blog_post':
    case 'category': {
      // The three id-bearing kinds carry a slug and never an address: the route map belongs to the caller.
      const slug = row.targetSlug;
      if (slug === null || slug === '') return null;
      return { kind: row.targetKind, slug };
    }
    case 'path': {
      // Checked against the contract rather than trusted: 0030's CHECK says a path is relative, and a second
      // opinion here costs nothing and refuses a row that somehow got past it.
      const parsed = NavigationPathSchema.safeParse(row.targetPath);
      return parsed.success ? { kind: 'path', path: parsed.data } : null;
    }
    default:
      return null;
  }
}

function linkOf(row: PublicNavigationItemDbRow): PublicNavigationLink | null {
  const label = row.label;
  if (label === null || label.trim() === '') return null;
  const target = targetOf(row);
  if (target === null) return null;
  return { itemId: row.itemId, label, target, opensInNewTab: row.opensInNewTab === true };
}

@Injectable()
export class NavigationPublicService {
  private readonly logger = new Logger(NavigationPublicService.name);

  constructor(@Inject(NAVIGATION_PUBLIC_STORE) private readonly store: NavigationPublicStore) {}

  /**
   * The menus named, assembled, in the order they were asked for.
   *
   * A database that cannot answer is a 503 and never an empty chrome: the web layer falls back to its own neutral
   * header and footer (owner decision 7), and it can only do that if it can tell an outage from a site nobody has
   * composed.
   */
  async menus(input: {
    menuKeys: readonly NavigationMenuKey[];
    locale: PublicLocale;
  }): Promise<readonly PublicNavigationMenu[]> {
    // Asked for in one read, however many menus a page renders.
    const wanted = input.menuKeys.filter((key) => SERVED.has(key));
    if (wanted.length === 0) return [];

    let rows: readonly PublicNavigationItemDbRow[];
    try {
      rows = await this.store.publicNavigationItems({ menuKeys: wanted, locale: input.locale });
    } catch (error) {
      this.logger.error('The navigation menus could not be read.');
      throw new CmsPublicUnavailableError(error);
    }

    const menus = new Map<string, { label: string; items: PublicNavigationItem[] }>();
    const byId = new Map<string, PublicNavigationItem>();

    // Two passes rather than one, because a child can only be attached once its parent exists — and the reader
    // returns a parent before its children, so a single pass would still need the same bookkeeping.
    for (const row of rows) {
      if (row.parentItemId !== null) continue;
      const link = linkOf(row);
      if (link === null) {
        this.logger.warn(`Navigation item ${row.itemId} could not be read and was skipped.`);
        continue;
      }
      const menu = menus.get(row.menuKey) ?? {
        label: row.menuLabel === null || row.menuLabel.trim() === '' ? row.menuKey : row.menuLabel,
        items: [],
      };
      const item: PublicNavigationItem = { ...link, children: [] };
      menu.items.push(item);
      byId.set(row.itemId, item);
      menus.set(row.menuKey, menu);
    }

    for (const row of rows) {
      if (row.parentItemId === null) continue;
      const parent = byId.get(row.parentItemId);
      // A child whose parent was skipped goes with it, which is the same rule the database applies to a parent
      // whose target is not public (owner decision 3).
      if (parent === undefined) continue;
      const link = linkOf(row);
      if (link === null) {
        this.logger.warn(`Navigation item ${row.itemId} could not be read and was skipped.`);
        continue;
      }
      parent.children.push(link);
    }

    // In the order they were asked for, and a menu with nothing in it is not in the answer at all.
    return wanted.flatMap((key) => {
      const menu = menus.get(key);
      if (menu === undefined || menu.items.length === 0) return [];
      return [{ menuKey: key, label: menu.label, items: menu.items }];
    });
  }
}
