import { Inject, Injectable } from '@nestjs/common';
import {
  PUBLIC_LOCALES,
  type AdminCategoryDetail,
  type AdminCategoryNode,
  type AdminCategoryTranslation,
  type CategoryListingType,
  type PublicLocale,
} from '@repo/contracts';
import { StaffConsoleService } from './staff-console.service.js';
import { isAal2 } from '../auth/access-token-claims.js';
import {
  CategoryNotFoundError,
  CategoryRefusedError,
  CategoryUnavailableError,
  type CategoryRefusalCode,
} from './categories.errors.js';

/**
 * The category tree for the admin console.
 *
 * **The rules are the database's.** Migration 0010 owns the shape of the tree — the three-level limit, the cycle
 * and self-parent guards, the unique slug — and 0087's named functions own the permission test. This service
 * authorizes the caller, calls one function and maps what comes back. It re-decides nothing, which is why a
 * refusal here is always a SQLSTATE translated and never a rule restated.
 *
 * **Authorization runs in the one order the project uses everywhere.** The provider validates the token, the
 * assurance level comes from that validated token, the database returns the effective permissions under 0003's
 * `requires_mfa` rule, and then the `app_private` function re-applies the same test with the key pinned as a
 * literal. No role name is tested in application code.
 *
 * **A refusal looks like an absence.** A caller holding only `catalog.category.read` gets the same `NOT_FOUND`
 * from a write as a category that does not exist, because the database answers `42501` and a 403 would turn the
 * console into a way to ask what exists.
 */

export const CATEGORY_READ = 'catalog.category.read';
export const CATEGORY_MANAGE = 'catalog.category.manage';

export const CATEGORIES_STORE = Symbol('CATEGORIES_STORE');

export interface CategoryNodeDbRow {
  readonly categoryId: string;
  readonly parentId: string | null;
  readonly slug: string;
  readonly depth: number;
  readonly sortOrder: number;
  readonly listingTypeCode: string | null;
  readonly isActive: boolean;
  readonly isVisible: boolean;
  readonly childCount: number;
  readonly listingCount: number;
  readonly translatedLocales: readonly string[];
  readonly name: string | null;
  readonly updatedAt: Date;
}

export interface CategoryDetailDbRow extends Omit<CategoryNodeDbRow, 'name'> {
  readonly parentSlug: string | null;
  readonly createdAt: Date;
  readonly canManage: boolean;
}

export interface CategoryTranslationDbRow {
  readonly localeCode: string;
  readonly name: string;
  readonly description: string | null;
  readonly metaTitle: string | null;
  readonly metaDescription: string | null;
  readonly updatedAt: Date;
}

export interface CategoriesStore {
  categoriesForStaff(input: { userId: string; isAal2: boolean }): Promise<readonly CategoryNodeDbRow[]>;
  categoryForStaff(input: { userId: string; isAal2: boolean; categoryId: string }): Promise<CategoryDetailDbRow | null>;
  categoryTranslationsForStaff(input: {
    userId: string;
    isAal2: boolean;
    categoryId: string;
  }): Promise<readonly CategoryTranslationDbRow[]>;
  categoryCreateForStaff(input: {
    userId: string;
    isAal2: boolean;
    slug: string;
    parentId: string | null;
    listingTypeCode: string | null;
    sortOrder: number;
  }): Promise<string>;
  categoryUpdateForStaff(input: {
    userId: string;
    isAal2: boolean;
    categoryId: string;
    setParent: boolean;
    parentId: string | null;
    listingTypeCode: string | null;
    sortOrder: number | null;
  }): Promise<boolean>;
  categoryStateForStaff(input: {
    userId: string;
    isAal2: boolean;
    categoryId: string;
    isActive: boolean;
  }): Promise<boolean>;
  categoryTranslationSaveForStaff(input: {
    userId: string;
    isAal2: boolean;
    categoryId: string;
    localeCode: string;
    name: string;
    description: string | null;
    metaTitle: string | null;
    metaDescription: string | null;
  }): Promise<boolean>;
  categoryTranslationDeleteForStaff(input: {
    userId: string;
    isAal2: boolean;
    categoryId: string;
    localeCode: string;
  }): Promise<boolean>;
}

/**
 * Which refusal each SQLSTATE is, with our own sentence.
 *
 * The database's own message is deliberately **not** forwarded: it names tables, constraints and in one case a
 * specification clause, none of which belongs in an answer a browser receives.
 *
 *   `23001` restrict_violation      — 0010's tree trigger, and 0087's naming guards
 *   `23505` unique_violation        — the slug is taken
 *   `23514` check_violation         — a length or a format the column refuses
 *
 * `23001` covers both the tree refusals and the naming guards, and they need different sentences, so the two are
 * told apart by which operation raised them rather than by reading the message. That is what `#write` takes a
 * `restrictCode` for.
 */
const SLUG_TAKEN = { code: 'CATEGORY_SLUG_TAKEN' as const, detail: 'That address is already in use by another category.' };
const VALUE_NOT_ALLOWED = {
  code: 'CATEGORY_VALUE_NOT_ALLOWED' as const,
  detail: 'That value is longer or differently shaped than this field allows.',
};
const TREE_NOT_ALLOWED = {
  code: 'CATEGORY_TREE_NOT_ALLOWED' as const,
  detail: 'That is not an allowed place for this category in the tree.',
};
const NAME_REQUIRED = {
  code: 'CATEGORY_NAME_REQUIRED' as const,
  detail: 'The category must be named in at least one locale while it is shown.',
};

function sqlstateOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function localeOf(code: string): PublicLocale | null {
  return (PUBLIC_LOCALES as readonly string[]).includes(code) ? (code as PublicLocale) : null;
}

function listingTypeOf(code: string | null): CategoryListingType | null {
  return code === 'product' || code === 'service' ? code : null;
}

@Injectable()
export class CategoriesAdminService {
  constructor(
    private readonly staff: StaffConsoleService,
    @Inject(CATEGORIES_STORE) private readonly store: CategoriesStore,
  ) {}

  /** The whole tree, including the inactive: a console that hid those could not bring one back. */
  async tree(accessToken: string): Promise<readonly AdminCategoryNode[]> {
    const reader = await this.#reader(accessToken);
    const rows = await this.#read(() => this.store.categoriesForStaff(reader));
    return rows.map((row) => this.#node(row));
  }

  /** One category with every locale it has been written in. */
  async detail(
    accessToken: string,
    categoryId: string,
  ): Promise<{ readonly category: AdminCategoryDetail; readonly translations: readonly AdminCategoryTranslation[] }> {
    const reader = await this.#reader(accessToken);
    const row = await this.#read(() => this.store.categoryForStaff({ ...reader, categoryId }));
    if (row === null) throw new CategoryNotFoundError();

    const translations = await this.#read(() =>
      this.store.categoryTranslationsForStaff({ ...reader, categoryId }),
    );

    return {
      category: {
        categoryId: row.categoryId,
        parentId: row.parentId,
        parentSlug: row.parentSlug,
        slug: row.slug,
        depth: row.depth,
        sortOrder: row.sortOrder,
        listingTypeCode: listingTypeOf(row.listingTypeCode),
        isActive: row.isActive,
        isVisible: row.isVisible,
        childCount: row.childCount,
        listingCount: row.listingCount,
        translatedLocales: row.translatedLocales.flatMap((code) => {
          const locale = localeOf(code);
          return locale === null ? [] : [locale];
        }),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        canManage: row.canManage,
      },
      translations: translations.flatMap((translation) => {
        const locale = localeOf(translation.localeCode);
        if (locale === null) return [];
        return [
          {
            localeCode: locale,
            name: translation.name,
            description: translation.description,
            metaTitle: translation.metaTitle,
            metaDescription: translation.metaDescription,
            updatedAt: translation.updatedAt.toISOString(),
          },
        ];
      }),
    };
  }

  async create(
    accessToken: string,
    input: {
      readonly slug: string;
      readonly parentId: string | null;
      readonly listingTypeCode: string | null;
      readonly sortOrder: number;
    },
  ): Promise<string> {
    const writer = await this.#reader(accessToken);
    return this.#write(() => this.store.categoryCreateForStaff({ ...writer, ...input }), TREE_NOT_ALLOWED);
  }

  async update(
    accessToken: string,
    categoryId: string,
    input: {
      readonly setParent: boolean;
      readonly parentId: string | null;
      readonly listingTypeCode: string | null;
      readonly sortOrder: number | null;
    },
  ): Promise<boolean> {
    const writer = await this.#reader(accessToken);
    const changed = await this.#write(
      () => this.store.categoryUpdateForStaff({ ...writer, categoryId, ...input }),
      TREE_NOT_ALLOWED,
    );
    if (!changed) throw new CategoryNotFoundError();
    return changed;
  }

  async setState(accessToken: string, categoryId: string, isActive: boolean): Promise<boolean> {
    const writer = await this.#reader(accessToken);
    const changed = await this.#write(
      () => this.store.categoryStateForStaff({ ...writer, categoryId, isActive }),
      NAME_REQUIRED,
    );
    if (!changed) throw new CategoryNotFoundError();
    return changed;
  }

  async saveTranslation(
    accessToken: string,
    categoryId: string,
    localeCode: string,
    input: {
      readonly name: string;
      readonly description: string | null;
      readonly metaTitle: string | null;
      readonly metaDescription: string | null;
    },
  ): Promise<boolean> {
    const writer = await this.#reader(accessToken);
    const changed = await this.#write(
      () => this.store.categoryTranslationSaveForStaff({ ...writer, categoryId, localeCode, ...input }),
      NAME_REQUIRED,
    );
    if (!changed) throw new CategoryNotFoundError();
    return changed;
  }

  /**
   * Remove one locale.
   *
   * A locale that is not there answers `changed: false` rather than 404: the category was found, and nothing
   * needed doing. That is a different statement from "no such category", and a console can tell them apart.
   */
  async removeTranslation(accessToken: string, categoryId: string, localeCode: string): Promise<boolean> {
    const writer = await this.#reader(accessToken);
    return this.#write(
      () => this.store.categoryTranslationDeleteForStaff({ ...writer, categoryId, localeCode }),
      NAME_REQUIRED,
    );
  }

  #node(row: CategoryNodeDbRow): AdminCategoryNode {
    return {
      categoryId: row.categoryId,
      parentId: row.parentId,
      slug: row.slug,
      depth: row.depth,
      sortOrder: row.sortOrder,
      listingTypeCode: listingTypeOf(row.listingTypeCode),
      isActive: row.isActive,
      isVisible: row.isVisible,
      childCount: row.childCount,
      listingCount: row.listingCount,
      translatedLocales: row.translatedLocales.flatMap((code) => {
        const locale = localeOf(code);
        return locale === null ? [] : [locale];
      }),
      name: row.name,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * The caller, in the one order this project uses: the provider validates the token, the database says what the
   * account effectively holds, and the assurance level comes from that same validated token.
   */
  async #reader(accessToken: string): Promise<{ readonly userId: string; readonly isAal2: boolean }> {
    const session = await this.staff.forToken(accessToken);
    if (!session.permissions.includes(CATEGORY_READ)) throw new CategoryNotFoundError();
    return { userId: session.id, isAal2: isAal2(accessToken) };
  }

  async #read<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw new CategoryUnavailableError(error);
    }
  }

  /**
   * One write, with the database's refusals translated and nothing else let through.
   *
   * `42501` is the database refusing a caller without the manage key, and it becomes the same `NOT_FOUND` as an
   * absence. The mapped SQLSTATEs become 409s. Everything else — including `23502`, a not-null violation, which
   * would mean this service sent something it should have caught — becomes a 503 rather than a confident refusal
   * about a rule that does not exist.
   */
  async #write<T>(
    run: () => Promise<T>,
    restrict: { readonly code: CategoryRefusalCode; readonly detail: string },
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      const sqlstate = sqlstateOf(error);
      if (sqlstate === '42501') throw new CategoryNotFoundError();
      if (sqlstate === '23001') throw new CategoryRefusedError(restrict.code, restrict.detail);
      if (sqlstate === '23505') throw new CategoryRefusedError(SLUG_TAKEN.code, SLUG_TAKEN.detail);
      if (sqlstate === '23514') throw new CategoryRefusedError(VALUE_NOT_ALLOWED.code, VALUE_NOT_ALLOWED.detail);
      // A foreign key: a parent, locale or listing type that does not exist. The caller named something absent,
      // which is the same answer as naming an absent category.
      if (sqlstate === '23503') throw new CategoryNotFoundError();
      throw new CategoryUnavailableError(error);
    }
  }
}
