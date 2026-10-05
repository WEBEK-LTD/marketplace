import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  CategoryDetail,
  CategoryLink,
  CategoryNode,
  CategorySeo,
  PublicLocale,
} from '@repo/contracts';
import { CatalogUnavailableError } from './catalog-errors.js';

/**
 * The public category tree (Phase 4-A).
 *
 * Everything this service knows about visibility, ordering and names comes from
 * `app_private.public_categories`: the database decides what is published, in what order, and what each
 * category is called in the requested locale. This layer does one thing the database cannot do
 * comfortably — turn a flat parent-pointer list into the nested shape the contract describes — and
 * nothing else.
 *
 * It holds no user context on purpose. The tree is the same for a guest and for a signed-in person, so
 * there is nothing here to authorize and nothing to leak between callers.
 */

/** The database operations this service needs. */
export interface CategoryStore {
  /** `app_private.public_categories(text)`: published categories, shallowest first, already ordered. */
  publicCategories(locale: PublicLocale): Promise<readonly CategoryRow[]>;
  /** `app_private.public_category_by_slug(text, text)`: one category, its parent and its children. */
  publicCategoryBySlug(input: {
    slug: string;
    locale: PublicLocale;
  }): Promise<Pick<CategoryDetailRow, 'outcome'> & Partial<CategoryDetailRow>>;
}

/**
 * One category as the reader returns it.
 *
 * `metaTitle` and `metaDescription` are carried here and deliberately **not** in the public contract:
 * the page uses them to build its document head, and they never reach a browser as content.
 */
export interface CategoryDetailRow {
  readonly outcome: 'found' | 'not_found';
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly metaTitle: string | null;
  readonly metaDescription: string | null;
  readonly parent: CategoryLink | null;
  readonly children: readonly CategoryLink[];
}

/** What a category read resolved to. There is no `moved`: categories keep no slug history. */
export type CategoryLookup =
  | { readonly kind: 'found'; readonly category: CategoryDetail; readonly seo: CategorySeo }
  | { readonly kind: 'not_found' };


export interface CategoryRow {
  readonly id: string;
  readonly parentId: string | null;
  readonly slug: string;
  readonly name: string;
}

export const CATEGORY_STORE = Symbol('CATEGORY_STORE');

@Injectable()
export class CategoriesService {
  private readonly logger = new Logger(CategoriesService.name);

  constructor(@Inject(CATEGORY_STORE) private readonly store: CategoryStore) {}

  /**
   * The published tree for one locale.
   *
   * An empty catalogue is an empty array, not a failure: nothing published yet is a state the page
   * renders, not an error it reports. A database that cannot answer is a 503 — never an empty tree,
   * which would tell a visitor the marketplace has no categories when in truth we do not know.
   */
  async tree(locale: PublicLocale): Promise<readonly CategoryNode[]> {
    let rows: readonly CategoryRow[];
    try {
      rows = await this.store.publicCategories(locale);
    } catch (error) {
      // The reason stays here; the caller gets the approved problem and nothing about the database.
      this.logger.error('The category tree could not be read.');
      throw new CatalogUnavailableError(error);
    }
    return assembleTree(rows);
  }

  /**
   * One category by slug.
   *
   * An inactive category, one under a deactivated ancestor, and a slug that names nothing are one
   * outcome here as they are in the database: `not_found`. Telling them apart would let the surface be
   * used to discover that a category exists but is switched off.
   */
  async bySlug(slug: string, locale: PublicLocale): Promise<CategoryLookup> {
    let row: Awaited<ReturnType<CategoryStore['publicCategoryBySlug']>>;
    try {
      row = await this.store.publicCategoryBySlug({ slug, locale });
    } catch (error) {
      this.logger.error('A category could not be read.');
      throw new CatalogUnavailableError(error);
    }

    if (row.outcome !== 'found') return { kind: 'not_found' };

    // A `found` row always carries the projection; anything missing means the reader and this service
    // disagree, which is a failure rather than a half-rendered page.
    if (row.id === undefined || row.slug === undefined || row.name === undefined) {
      this.logger.error('A category row arrived without its projection.');
      throw new CatalogUnavailableError(new Error('incomplete category row'));
    }

    return {
      kind: 'found',
      category: {
        id: row.id,
        slug: row.slug,
        name: row.name,
        description: row.description ?? null,
        parent: row.parent ?? null,
        children: [...(row.children ?? [])],
      },
      seo: {
        metaTitle: row.metaTitle ?? null,
        metaDescription: row.metaDescription ?? null,
      },
    };
  }
}

/**
 * Builds the nested tree from the flat rows.
 *
 * The rows arrive shallowest first and already in sibling order, so one pass is enough: by the time a
 * child is seen its parent is already in the map, and pushing preserves the order the database chose.
 *
 * A row whose parent is missing from the set is dropped rather than promoted to a root. It cannot
 * happen — the reader only returns categories whose ancestors are visible, and a pgTAP assertion pins
 * that — but silently reparenting a category would move it somewhere a visitor could actually see, and
 * dropping it is the failure that shows up as absence rather than as a lie about the catalogue.
 */
export function assembleTree(rows: readonly CategoryRow[]): readonly CategoryNode[] {
  const children = new Map<string, CategoryNode[]>();
  const nodes = new Map<string, CategoryNode>();
  const roots: CategoryNode[] = [];

  for (const row of rows) {
    const own: CategoryNode[] = [];
    const node: CategoryNode = { id: row.id, slug: row.slug, name: row.name, children: own };
    children.set(row.id, own);
    nodes.set(row.id, node);

    if (row.parentId === null) {
      roots.push(node);
      continue;
    }
    children.get(row.parentId)?.push(node);
  }

  return roots;
}
