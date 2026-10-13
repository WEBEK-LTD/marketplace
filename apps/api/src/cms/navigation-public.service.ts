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
  type PublicOfficeContact,
  OfficeSocialLinkSchema,
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
  /** `app_private.public_site_settings(text)`: one category's public settings that have a value (0113). */
  publicSiteSettings(category: string): Promise<readonly { key: string; value: unknown }[]>;
}

/** The settings category the office's own details live under. */
const OFFICE_CATEGORY = 'office';

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

  /**
   * The office's own contact details, in the reader's language (0113).
   *
   * **The language picks between two stored values; it never translates one.** An address and a set of opening
   * hours are written once per language by the office, because a machine translation of an address is a wrong
   * address. A language the office has not written is absent rather than filled from the other one.
   *
   * **Absent means unset, all the way down.** The database omits a setting with no value, and this method omits
   * a field it did not receive, so a field that reaches a renderer has something in it. Nothing here converts
   * an empty string into a field.
   *
   * **A malformed social link costs that link, not the chrome** — the same rule a malformed menu item follows
   * a few lines above. The settings table is editable from the console, so a value that does not parse is a
   * thing that can happen, and the footer of every page on the site goes through here.
   */
  async officeContact(locale: PublicLocale): Promise<PublicOfficeContact> {
    const rows = await this.store.publicSiteSettings(OFFICE_CATEGORY);
    const byKey = new Map(rows.map((row) => [row.key, row.value]));

    const text = (key: string): string | undefined => {
      const value = byKey.get(key);
      if (typeof value !== 'string') return undefined;
      const trimmed = value.trim();
      return trimmed === '' ? undefined : trimmed;
    };

    const socialLinks = ((): { label: string; url: string }[] | undefined => {
      const raw = byKey.get('office.social_links');
      if (!Array.isArray(raw)) return undefined;
      const links = raw.flatMap((entry) => {
        const parsed = OfficeSocialLinkSchema.safeParse(entry);
        if (!parsed.success) {
          this.logger.warn('An office social link could not be read and was skipped.');
          return [];
        }
        return [parsed.data];
      });
      return links.length === 0 ? undefined : links.slice(0, 12);
    })();

    const address = text(locale === 'ar' ? 'office.address_ar' : 'office.address_en');
    const hours = text(locale === 'ar' ? 'office.hours_ar' : 'office.hours_en');
    const telephone = text('office.telephone');
    const whatsapp = text('office.whatsapp');
    const email = text('office.email');

    // Built by assignment rather than with nullish fields: `exactOptionalPropertyTypes` is on, so an absent
    // field has to be absent from the object and not present holding `undefined`.
    const contact: {
      telephone?: string;
      whatsapp?: string;
      email?: string;
      address?: string;
      hours?: string;
      socialLinks?: { label: string; url: string }[];
    } = {};
    if (telephone !== undefined) contact.telephone = telephone;
    if (whatsapp !== undefined) contact.whatsapp = whatsapp;
    if (email !== undefined) contact.email = email;
    if (address !== undefined) contact.address = address;
    if (hours !== undefined) contact.hours = hours;
    if (socialLinks !== undefined) contact.socialLinks = socialLinks;
    return contact;
  }
}
