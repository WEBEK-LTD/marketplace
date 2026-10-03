import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  type NavigationItem,
  type NavigationMenuDetail,
  type NavigationMenuSummary,
  type NavigationMenusResponse,
  type NavigationTargetInput,
  type NavigationTargetKind,
  type NavigationTargetState,
} from '@repo/contracts';
import { isAal2 } from '../auth/access-token-claims.js';
import { StaffConsoleService } from './staff-console.service.js';
import type { NavigationRefusalCode } from './navigation.errors.js';
import {
  NavigationNotFoundError,
  NavigationRefusedError,
  NavigationUnavailableError,
} from './navigation.errors.js';

/**
 * Authoring the navigation (0094).
 *
 * **Authorization, in the one order it is ever done**, which is this console's and is not varied:
 *
 *   1. The **provider** validates the caller's access token and says whose it is.
 *   2. The **assurance level** is read from that same, now-vouched-for token.
 *   3. The **database** reports the caller's *effective* permissions under the platform's own `requires_mfa`
 *      rule. Both roles that hold a navigation key require MFA, so staff at `aal1` hold nothing at all.
 *   4. Every `app_private` function below **re-applies the same test itself**, with the account and the assurance
 *      level as parameters and the key as a **literal**. No bug in this file can turn into somebody rearranging
 *      the site's header.
 *
 * **Two keys, and the separation is visible to the console.** `cms.navigation.read` opens the section and every
 * read; `cms.navigation.manage` is required by every write, and both the list and the detail report whether this
 * caller holds it, so a console renders its controls from the answer rather than from a role name.
 *
 * **Every rule this surface appears to apply is applied in the database.** The key format, the label lengths, the
 * four target kinds, that exactly the matching target column is filled, that a path is relative, the two-level
 * depth and the same-menu rule for a child are 0030's constraints and triggers. Whether a target is still public
 * is each row's own visibility predicate. This service passes the caller's account and shapes the answer.
 *
 * **Nothing here reads a banner, an FAQ, a promotion, a ranking or anything financial.**
 */

export const NAVIGATION_READ = 'cms.navigation.read';
export const NAVIGATION_MANAGE = 'cms.navigation.manage';

export const NAVIGATION_STORE = Symbol('NAVIGATION_STORE');

/** One row of `app_private.navigation_menus_for_staff` (0094). */
export interface NavigationMenuListDbRow {
  readonly menuId: string;
  readonly menuKey: string;
  readonly labelEn: string;
  readonly labelAr: string | null;
  readonly isActive: boolean;
  readonly isServed: boolean;
  readonly itemCount: number | string;
  readonly renderableItemCount: number | string;
  readonly createdAt: Date | string;
  readonly updatedAt: Date | string;
}

/** One row of `app_private.navigation_menu_for_staff` (0094). */
export interface NavigationMenuDetailDbRow extends NavigationMenuListDbRow {
  readonly canManage: boolean;
}

/** One row of `app_private.navigation_items_for_staff` (0094). */
export interface NavigationItemDbRow {
  readonly itemId: string;
  readonly parentItemId: string | null;
  readonly depth: number | string;
  readonly labelEn: string;
  readonly labelAr: string | null;
  readonly targetKind: string;
  readonly pageId: string | null;
  readonly blogPostId: string | null;
  readonly categoryId: string | null;
  readonly targetPath: string | null;
  readonly targetSlug: string | null;
  readonly targetTitle: string | null;
  readonly targetState: string;
  readonly opensInNewTab: boolean;
  readonly sortOrder: number | string;
  readonly isActive: boolean;
  readonly createdAt: Date | string;
  readonly updatedAt: Date | string;
}

export interface NavigationStore {
  navigationMenusForStaff(input: {
    userId: string;
    isAal2: boolean;
  }): Promise<readonly NavigationMenuListDbRow[]>;

  navigationMenuForStaff(input: {
    userId: string;
    isAal2: boolean;
    menuId: string;
  }): Promise<NavigationMenuDetailDbRow | null>;

  navigationItemsForStaff(input: {
    userId: string;
    isAal2: boolean;
    menuId: string;
    locale: string;
  }): Promise<readonly NavigationItemDbRow[]>;

  navigationMenuSaveForStaff(input: {
    userId: string;
    isAal2: boolean;
    menuId: string | null;
    menuKey: string | null;
    labelEn: string | null;
    labelAr: string | null;
  }): Promise<string | null>;

  navigationMenuStateForStaff(input: {
    userId: string;
    isAal2: boolean;
    menuId: string;
    isActive: boolean;
  }): Promise<boolean>;

  navigationMenuDeleteForStaff(input: {
    userId: string;
    isAal2: boolean;
    menuId: string;
  }): Promise<boolean>;

  navigationItemSaveForStaff(input: {
    userId: string;
    isAal2: boolean;
    itemId: string | null;
    menuId: string | null;
    labelEn: string | null;
    labelAr: string | null;
    targetKind: string | null;
    pageId: string | null;
    blogPostId: string | null;
    categoryId: string | null;
    path: string | null;
    parentId: string | null;
    opensInNewTab: boolean | null;
    sortOrder: number | null;
  }): Promise<string | null>;

  navigationItemPromoteForStaff(input: {
    userId: string;
    isAal2: boolean;
    itemId: string;
  }): Promise<boolean>;

  navigationItemStateForStaff(input: {
    userId: string;
    isAal2: boolean;
    itemId: string;
    isActive: boolean;
  }): Promise<boolean>;

  navigationItemsReorderForStaff(input: {
    userId: string;
    isAal2: boolean;
    menuId: string;
    itemIds: readonly string[];
  }): Promise<number>;

  navigationItemDeleteForStaff(input: {
    userId: string;
    isAal2: boolean;
    itemId: string;
  }): Promise<boolean>;
}

/**
 * The SQLSTATEs a refused write arrives as, each with **our own** code and sentence.
 *
 * The database's text is deliberately not forwarded: a PostgreSQL constraint message is a different kind of value
 * from an API response, and mapping the five characters to a code we control means a change to a constraint's
 * wording cannot change what a browser is shown.
 *
 * `23514` covers more here than on other surfaces, because 0030 expresses several navigation rules as CHECKs and
 * the depth trigger raises `check_violation` deliberately — one code for the family, as the contract records.
 */
const REFUSALS: ReadonlyMap<string, { readonly code: NavigationRefusalCode; readonly detail: string }> = new Map([
  [
    '23505',
    {
      code: 'NAVIGATION_MENU_KEY_TAKEN' as const,
      detail: 'Another navigation menu already uses that key.',
    },
  ],
  [
    '23514',
    {
      code: 'NAVIGATION_NOT_ALLOWED' as const,
      detail: 'That is not an allowed arrangement for a navigation menu.',
    },
  ],
  [
    '23503',
    {
      code: 'NAVIGATION_REFERENCE_UNKNOWN' as const,
      detail: 'Something that request refers to does not exist.',
    },
  ],
  [
    '23502',
    {
      code: 'NAVIGATION_NOT_ALLOWED' as const,
      detail: 'That is not an allowed arrangement for a navigation menu.',
    },
  ],
]);

function sqlstateOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toNumber(value: number | string): number {
  return typeof value === 'number' ? value : Number(value);
}

function toSummary(row: NavigationMenuListDbRow): NavigationMenuSummary {
  return {
    id: row.menuId,
    menuKey: row.menuKey,
    labelEn: row.labelEn,
    labelAr: row.labelAr,
    isActive: row.isActive,
    isServed: row.isServed,
    itemCount: toNumber(row.itemCount),
    renderableItemCount: toNumber(row.renderableItemCount),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

function toItem(row: NavigationItemDbRow): NavigationItem {
  return {
    id: row.itemId,
    parentId: row.parentItemId,
    // 0030's trigger allows one level of nesting, so a row is at depth 1 or 2 and nothing else.
    depth: toNumber(row.depth) === 2 ? 2 : 1,
    labelEn: row.labelEn,
    labelAr: row.labelAr,
    targetKind: row.targetKind as NavigationTargetKind,
    pageId: row.pageId,
    blogPostId: row.blogPostId,
    categoryId: row.categoryId,
    path: row.targetPath,
    targetSlug: row.targetSlug,
    targetTitle: row.targetTitle,
    targetState: row.targetState as NavigationTargetState,
    opensInNewTab: row.opensInNewTab,
    sortOrder: toNumber(row.sortOrder),
    isActive: row.isActive,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

/** One target input, flattened into the four columns the writer takes. */
function targetColumns(target: NavigationTargetInput | null): {
  targetKind: string | null;
  pageId: string | null;
  blogPostId: string | null;
  categoryId: string | null;
  path: string | null;
} {
  if (target === null) {
    // Every column null means "leave the target alone", which is what an edit to a label is.
    return { targetKind: null, pageId: null, blogPostId: null, categoryId: null, path: null };
  }
  return {
    targetKind: target.kind,
    pageId: target.kind === 'page' ? target.pageId : null,
    blogPostId: target.kind === 'blog_post' ? target.blogPostId : null,
    categoryId: target.kind === 'category' ? target.categoryId : null,
    path: target.kind === 'path' ? target.path : null,
  };
}

@Injectable()
export class NavigationAdminService {
  private readonly logger = new Logger(NavigationAdminService.name);

  constructor(
    @Inject(NAVIGATION_STORE) private readonly store: NavigationStore,
    private readonly console: StaffConsoleService,
  ) {}

  /** Every menu, served ones first, with whether this caller may change any of it. */
  async list(input: { accessToken: string }): Promise<NavigationMenusResponse> {
    const staff = await this.#reader(input.accessToken);

    let rows: readonly NavigationMenuListDbRow[];
    try {
      rows = await this.store.navigationMenusForStaff({ userId: staff.id, isAal2: staff.isAal2 });
    } catch (error) {
      this.logger.error('The navigation menus could not be read.');
      throw new NavigationUnavailableError(error);
    }

    const session = await this.console.forToken(input.accessToken);
    return {
      menus: rows.map(toSummary),
      canManage: session.permissions.includes(NAVIGATION_MANAGE),
    };
  }

  /** One menu with every item it holds — including the ones the public is not being shown. */
  async detail(input: {
    accessToken: string;
    menuId: string;
    locale: string;
  }): Promise<NavigationMenuDetail> {
    const staff = await this.#reader(input.accessToken);

    let row: NavigationMenuDetailDbRow | null;
    let items: readonly NavigationItemDbRow[];
    try {
      row = await this.store.navigationMenuForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        menuId: input.menuId,
      });
      // Asked for unconditionally: a menu the caller may not read returns no row above and no items here, so the
      // two answers cannot disagree.
      items = await this.store.navigationItemsForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        menuId: input.menuId,
        locale: input.locale,
      });
    } catch (error) {
      this.logger.error('The navigation menu could not be read.');
      throw new NavigationUnavailableError(error);
    }

    // No row covers both a menu that does not exist and a caller without the read key.
    if (row === null) throw new NavigationNotFoundError();

    return { ...toSummary(row), canManage: row.canManage, items: items.map(toItem) };
  }

  /** Creates a menu. */
  async createMenu(input: {
    accessToken: string;
    menuKey: string;
    labelEn: string;
    labelAr: string | null;
  }): Promise<string> {
    const staff = await this.#reader(input.accessToken);
    const id = await this.#write(async () =>
      this.store.navigationMenuSaveForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        menuId: null,
        menuKey: input.menuKey,
        labelEn: input.labelEn,
        labelAr: input.labelAr,
      }),
    );
    if (id === null) throw new NavigationUnavailableError();
    return id;
  }

  /** Changes a menu. Never its visibility: that is the next call. */
  async updateMenu(input: {
    accessToken: string;
    menuId: string;
    menuKey: string | null;
    labelEn: string | null;
    labelAr: string | null;
  }): Promise<void> {
    const staff = await this.#reader(input.accessToken);
    const id = await this.#write(async () =>
      this.store.navigationMenuSaveForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        menuId: input.menuId,
        menuKey: input.menuKey,
        labelEn: input.labelEn,
        labelAr: input.labelAr,
      }),
    );
    // Null means the identifier named nothing. The writer does not create one in that case.
    if (id === null) throw new NavigationNotFoundError();
  }

  /** Shows or hides one menu — the call that can take a whole menu off every public surface at once. */
  async setMenuState(input: { accessToken: string; menuId: string; isActive: boolean }): Promise<void> {
    const staff = await this.#reader(input.accessToken);
    const changed = await this.#write(async () =>
      this.store.navigationMenuStateForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        menuId: input.menuId,
        isActive: input.isActive,
      }),
    );
    if (!changed) throw new NavigationNotFoundError();
  }

  /** Removes one menu, and its items with it. */
  async removeMenu(input: { accessToken: string; menuId: string }): Promise<void> {
    const staff = await this.#reader(input.accessToken);
    const deleted = await this.#write(async () =>
      this.store.navigationMenuDeleteForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        menuId: input.menuId,
      }),
    );
    if (!deleted) throw new NavigationNotFoundError();
  }

  /** Creates an item. */
  async createItem(input: {
    accessToken: string;
    menuId: string;
    labelEn: string;
    labelAr: string | null;
    target: NavigationTargetInput;
    parentId: string | null;
    opensInNewTab: boolean | null;
    sortOrder: number | null;
  }): Promise<string> {
    const staff = await this.#reader(input.accessToken);
    const id = await this.#write(async () =>
      this.store.navigationItemSaveForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        itemId: null,
        menuId: input.menuId,
        labelEn: input.labelEn,
        labelAr: input.labelAr,
        ...targetColumns(input.target),
        parentId: input.parentId,
        opensInNewTab: input.opensInNewTab,
        sortOrder: input.sortOrder,
      }),
    );
    if (id === null) throw new NavigationUnavailableError();
    return id;
  }

  /** Changes an item. Never its visibility, and never which menu it belongs to. */
  async updateItem(input: {
    accessToken: string;
    itemId: string;
    labelEn: string | null;
    labelAr: string | null;
    target: NavigationTargetInput | null;
    parentId: string | null;
    opensInNewTab: boolean | null;
    sortOrder: number | null;
  }): Promise<void> {
    const staff = await this.#reader(input.accessToken);
    const id = await this.#write(async () =>
      this.store.navigationItemSaveForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        itemId: input.itemId,
        // An item never moves between menus: 0030 would refuse a child whose parent is elsewhere anyway, and
        // moving a heading between menus is a delete and a create rather than an edit.
        menuId: null,
        labelEn: input.labelEn,
        labelAr: input.labelAr,
        ...targetColumns(input.target),
        parentId: input.parentId,
        opensInNewTab: input.opensInNewTab,
        sortOrder: input.sortOrder,
      }),
    );
    if (id === null) throw new NavigationNotFoundError();
  }

  /** Moves one second-level item up to the top level of its own menu. */
  async promoteItem(input: { accessToken: string; itemId: string }): Promise<void> {
    const staff = await this.#reader(input.accessToken);
    const changed = await this.#write(async () =>
      this.store.navigationItemPromoteForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        itemId: input.itemId,
      }),
    );
    // Nothing moved means the item does not exist or was already at the top level, and this surface does not
    // distinguish the two: either way the console's answer is to reload.
    if (!changed) throw new NavigationNotFoundError();
  }

  /** Shows or hides one item. */
  async setItemState(input: { accessToken: string; itemId: string; isActive: boolean }): Promise<void> {
    const staff = await this.#reader(input.accessToken);
    const changed = await this.#write(async () =>
      this.store.navigationItemStateForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        itemId: input.itemId,
        isActive: input.isActive,
      }),
    );
    if (!changed) throw new NavigationNotFoundError();
  }

  /** Sets the order of the items named, inside one menu. */
  async reorder(input: {
    accessToken: string;
    menuId: string;
    itemIds: readonly string[];
  }): Promise<void> {
    const staff = await this.#reader(input.accessToken);
    await this.#write(async () =>
      this.store.navigationItemsReorderForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        menuId: input.menuId,
        itemIds: input.itemIds,
      }),
    );
    // Deliberately not an error when nothing moved: an order that named only items somebody else has since
    // deleted is a stale screen, and the remedy is to reload — not a refusal the console has to explain.
  }

  /** Removes one item, and anything under it. */
  async removeItem(input: { accessToken: string; itemId: string }): Promise<void> {
    const staff = await this.#reader(input.accessToken);
    const deleted = await this.#write(async () =>
      this.store.navigationItemDeleteForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        itemId: input.itemId,
      }),
    );
    if (!deleted) throw new NavigationNotFoundError();
  }

  /**
   * Runs a write and sorts its failures.
   *
   * `42501` is the database refusing a caller who does not hold `cms.navigation.manage`. It becomes a 404 rather
   * than a 403: a caller may hold the read key and not the manage key, and the list already reports which through
   * `canManage`. Turning it into an absence keeps this surface's one rule — a refusal and an absence look alike.
   */
  async #write<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      const sqlstate = sqlstateOf(error);
      if (sqlstate === '42501') throw new NavigationNotFoundError();
      const refusal = sqlstate === null ? undefined : REFUSALS.get(sqlstate);
      if (refusal !== undefined) throw new NavigationRefusedError(refusal.code, refusal.detail);
      this.logger.error('A navigation menu could not be written.');
      throw new NavigationUnavailableError(error);
    }
  }

  async #reader(accessToken: string): Promise<{ id: string; isAal2: boolean }> {
    const session = await this.console.forToken(accessToken);
    if (!session.permissions.includes(NAVIGATION_READ)) throw new NavigationNotFoundError();
    return { id: session.id, isAal2: isAal2(accessToken) };
  }
}
