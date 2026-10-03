import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  BlogCategory,
  BlogPostDetail,
  BlogPostStatus,
  BlogPostSummary,
  BlogPostTranslation,
  BlogTag,
  BlogTaxonomyResponse,
} from '@repo/contracts';
import { isAal2 } from '../auth/access-token-claims.js';
import { StaffConsoleService } from './staff-console.service.js';
import type { BlogRefusalCode } from './blog.errors.js';
import {
  BlogCursorInvalidError,
  BlogNotFoundError,
  BlogRefusedError,
  BlogUnavailableError,
} from './blog.errors.js';
import { decodeBlogPostCursor, encodeBlogPostCursor } from './blog.cursor.js';
import type { CmsCoverMediaDbRow } from './cms-media.service.js';

/**
 * Authoring the blog (0092).
 *
 * **Authorization, in the one order it is ever done**, which is this console's and is not varied:
 *
 *   1. The **provider** validates the caller's access token and says whose it is.
 *   2. The **assurance level** is read from that same, now-vouched-for token. Reading a claim first would be
 *      reading an attacker's JSON.
 *   3. The **database** reports the caller's *effective* permissions under the platform's own `requires_mfa`
 *      rule. Both roles that hold a blog key — `admin` and `super_admin` — require MFA, so staff at `aal1` hold
 *      nothing at all; asking whether the effective set contains the key is therefore the AAL2 check and the
 *      permission check at once.
 *   4. Every `app_private` function below **re-applies the same test itself**, with the account and the
 *      assurance level as parameters and the key as a **literal**. No bug in this file can turn into somebody
 *      publishing a post.
 *
 * **Two keys, and the separation between them is visible to the console.** `cms.blog.read` opens the section
 * and every read; `cms.blog.manage` is required by every write, and both the post detail and the taxonomy
 * report whether this caller holds it so a console renders its controls from the answer rather than from a role
 * name. No role name is checked anywhere in this file.
 *
 * **Every rule this surface appears to apply is applied in the database.** The slug formats, the four states,
 * which lifecycle edges exist, which timestamp each state owns, that a retired slug can never be taken over,
 * that only a published post may be featured, that a post cannot be published before it is written, and that a
 * live post cannot lose its last locale — all of it is migration 0030 or migration 0092. This service passes the
 * caller's account, shapes the answer, and **checks nothing a second time**.
 *
 * **A refusal and an absence are the same answer**, as everywhere else in this console: a post that does not
 * exist and a caller without the read key both arrive as no row and become one {@link BlogNotFoundError}. A
 * *write* refusal is different and keeps its own class, because it is not an absence and a console has to be
 * able to show it.
 */

export const BLOG_READ = 'cms.blog.read';
export const BLOG_MANAGE = 'cms.blog.manage';

export const BLOG_STORE = Symbol('BLOG_STORE');

/* ------------------------------------------------------------------------------------------------ */
/* The rows each function returns                                                                    */
/* ------------------------------------------------------------------------------------------------ */

/** One row of `app_private.blog_posts_for_staff` (0092). */
export interface BlogPostListDbRow {
  readonly postId: string;
  readonly slug: string;
  readonly status: string;
  readonly blogCategoryId: string | null;
  readonly categorySlug: string | null;
  readonly isIndexable: boolean;
  readonly isFeatured: boolean;
  readonly scheduledFor: Date | string | null;
  readonly publishedAt: Date | string | null;
  readonly archivedAt: Date | string | null;
  readonly updatedAt: Date | string;
  readonly translatedLocales: readonly string[] | null;
  readonly tagCount: number | string;
  readonly title: string | null;
}

/** One row of `app_private.blog_post_for_staff` (0092). */
export interface BlogPostDetailDbRow {
  readonly postId: string;
  readonly slug: string;
  readonly status: string;
  readonly blogCategoryId: string | null;
  readonly categorySlug: string | null;
  readonly isIndexable: boolean;
  readonly isFeatured: boolean;
  readonly coverMediaId: string | null;
  readonly coverObjectPath: string | null;
  readonly authorUserId: string | null;
  readonly scheduledFor: Date | string | null;
  readonly publishedAt: Date | string | null;
  readonly archivedAt: Date | string | null;
  readonly createdAt: Date | string;
  readonly updatedAt: Date | string;
  readonly createdBy: string | null;
  readonly updatedBy: string | null;
  readonly canManage: boolean;
  readonly previousSlugs: readonly string[] | null;
  readonly translatedLocales: readonly string[] | null;
  readonly tagIds: readonly string[] | null;
}

/** One row of `app_private.blog_post_translations_for_staff` (0092). */
export interface BlogPostTranslationDbRow {
  readonly localeCode: string;
  readonly title: string;
  readonly excerpt: string | null;
  readonly body: string;
  readonly metaTitle: string | null;
  readonly metaDescription: string | null;
  readonly updatedAt: Date | string;
}

/** One row of `app_private.blog_categories_for_staff` (0092). */
export interface BlogCategoryDbRow {
  readonly categoryId: string;
  readonly slug: string;
  readonly nameEn: string;
  readonly nameAr: string | null;
  readonly descriptionEn: string | null;
  readonly descriptionAr: string | null;
  readonly sortOrder: number | string;
  readonly isActive: boolean;
  readonly postCount: number | string;
  readonly updatedAt: Date | string;
}

/** One row of `app_private.blog_tags_for_staff` (0092). */
export interface BlogTagDbRow {
  readonly tagId: string;
  readonly slug: string;
  readonly nameEn: string;
  readonly nameAr: string | null;
  readonly isActive: boolean;
  readonly postCount: number | string;
  readonly updatedAt: Date | string;
}

/** The database operations this service needs. Every one is a named definer function from 0092. */
export interface BlogStore {
  blogPostsForStaff(input: {
    userId: string;
    isAal2: boolean;
    limit: number;
    status: string | null;
    search: string | null;
    categoryId: string | null;
    cursorUpdatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly BlogPostListDbRow[]>;

  blogPostForStaff(input: {
    userId: string;
    isAal2: boolean;
    postId: string;
  }): Promise<BlogPostDetailDbRow | null>;

  /** 0099. The cover attached to one post, or null. Shared with the page console; read key only. */
  cmsCoverMediaForStaff(input: {
    userId: string;
    isAal2: boolean;
    entityType: 'page' | 'blog_post';
    entityId: string;
  }): Promise<CmsCoverMediaDbRow | null>;

  blogPostTranslationsForStaff(input: {
    userId: string;
    isAal2: boolean;
    postId: string;
  }): Promise<readonly BlogPostTranslationDbRow[]>;

  blogCategoriesForStaff(input: { userId: string; isAal2: boolean }): Promise<readonly BlogCategoryDbRow[]>;

  blogTagsForStaff(input: { userId: string; isAal2: boolean }): Promise<readonly BlogTagDbRow[]>;

  blogPostCreateForStaff(input: {
    userId: string;
    isAal2: boolean;
    slug: string;
    categoryId: string | null;
    isIndexable: boolean;
  }): Promise<string>;

  blogPostUpdateForStaff(input: {
    userId: string;
    isAal2: boolean;
    postId: string;
    slug: string | null;
    categoryId: string | null;
    clearCategory: boolean;
    coverMediaId: string | null;
    clearCover: boolean;
    isIndexable: boolean | null;
    isFeatured: boolean | null;
  }): Promise<boolean>;

  blogPostStatusForStaff(input: {
    userId: string;
    isAal2: boolean;
    postId: string;
    status: string;
    scheduledFor: Date | null;
  }): Promise<boolean>;

  blogPostTranslationSaveForStaff(input: {
    userId: string;
    isAal2: boolean;
    postId: string;
    localeCode: string;
    title: string;
    body: string;
    excerpt: string | null;
    metaTitle: string | null;
    metaDescription: string | null;
  }): Promise<boolean>;

  blogPostTranslationDeleteForStaff(input: {
    userId: string;
    isAal2: boolean;
    postId: string;
    localeCode: string;
  }): Promise<boolean>;

  blogPostTagsSetForStaff(input: {
    userId: string;
    isAal2: boolean;
    postId: string;
    tagIds: readonly string[];
  }): Promise<boolean>;

  blogCategorySaveForStaff(input: {
    userId: string;
    isAal2: boolean;
    categoryId: string | null;
    slug: string | null;
    nameEn: string | null;
    nameAr: string | null;
    descriptionEn: string | null;
    descriptionAr: string | null;
    sortOrder: number | null;
    isActive: boolean | null;
  }): Promise<string | null>;

  blogTagSaveForStaff(input: {
    userId: string;
    isAal2: boolean;
    tagId: string | null;
    slug: string | null;
    nameEn: string | null;
    nameAr: string | null;
    isActive: boolean | null;
  }): Promise<string | null>;
}

export interface BlogPostPage {
  readonly items: readonly BlogPostSummary[];
  readonly nextCursor: string | null;
}

/**
 * The SQLSTATEs a refused write arrives as, each with **our own** code and sentence.
 *
 * The database's text is deliberately not forwarded. A PostgreSQL constraint message is a different kind of
 * value from an API response, and this console already refuses to carry raw database text on its other
 * surfaces. Mapping the five characters to a code and a sentence we control keeps that true and means a change
 * to a constraint's wording cannot change what a browser is shown.
 *
 * **`23502` is deliberately absent.** A not-null violation would mean the request reached the database without
 * a field the contract requires, which is a failure of this service rather than of the caller, so it takes the
 * 503 path with everything else unexpected.
 */
const REFUSALS: ReadonlyMap<string, { readonly code: BlogRefusalCode; readonly detail: string }> = new Map([
  // restrict_violation — 0092's two guards, which are one rule read from two directions: a live post has text.
  [
    '23001',
    {
      code: 'BLOG_LOCALE_REQUIRED' as const,
      detail: 'The post must be written in at least one locale while it is published or scheduled.',
    },
  ],
  // check_violation — 0030's transition trigger, or one of its column constraints such as the rule that only a
  // published post may be featured.
  [
    '23514',
    {
      code: 'BLOG_CHANGE_NOT_ALLOWED' as const,
      detail: 'That is not an allowed change for a post in its current state.',
    },
  ],
  // unique_violation — a slug already in use, or one that belongs to another post's history and can never be
  // taken over because it still redirects there.
  [
    '23505',
    {
      code: 'BLOG_SLUG_TAKEN' as const,
      detail: 'That address is already in use, or was previously used by another post.',
    },
  ],
  // foreign_key_violation — a category, cover or tag that does not exist. Reported rather than swallowed: a
  // console that sent one has a bug, and quietly ignoring it would hide it.
  [
    '23503',
    {
      code: 'BLOG_REFERENCE_UNKNOWN' as const,
      detail: 'A category, cover image or tag in that request does not exist.',
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

function toIsoOrNull(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

function toNumber(value: number | string): number {
  return typeof value === 'number' ? value : Number(value);
}

@Injectable()
export class BlogAdminService {
  private readonly logger = new Logger(BlogAdminService.name);

  constructor(
    @Inject(BLOG_STORE) private readonly store: BlogStore,
    private readonly console: StaffConsoleService,
  ) {}

  /** One page of authored posts, newest edit first. */
  async list(input: {
    accessToken: string;
    limit: number;
    status: string | null;
    search: string | null;
    categoryId: string | null;
    cursor: string | null;
  }): Promise<BlogPostPage> {
    const staff = await this.#reader(input.accessToken);

    let position: { updatedAt: Date; id: string } | null = null;
    if (input.cursor !== null) {
      position = decodeBlogPostCursor(input.cursor);
      // One refusal for malformed, altered and outdated — including a position from any other list on this
      // platform, whose rows sit behind different keys entirely.
      if (position === null) throw new BlogCursorInvalidError();
    }

    let rows: readonly BlogPostListDbRow[];
    try {
      rows = await this.store.blogPostsForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        limit: input.limit + 1,
        // Passed as parameters. An unknown value matches nothing in the database rather than being refused
        // here, so a stale filter in a bookmark shows an empty page instead of an error.
        status: input.status,
        search: input.search,
        categoryId: input.categoryId,
        cursorUpdatedAt: position?.updatedAt ?? null,
        cursorId: position?.id ?? null,
      });
    } catch (error) {
      this.logger.error('The authored post list could not be read.');
      throw new BlogUnavailableError(error);
    }

    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    const last = page.at(-1);
    return {
      items: page.map((row) => this.#summary(row)),
      nextCursor:
        hasMore && last !== undefined
          ? encodeBlogPostCursor({ updatedAt: new Date(toIso(last.updatedAt)), id: last.postId })
          : null,
    };
  }

  /** One post, with its previous slugs, its tags and every locale it has been written in. */
  async detail(input: { accessToken: string; postId: string }): Promise<BlogPostDetail> {
    const staff = await this.#reader(input.accessToken);

    let row: BlogPostDetailDbRow | null;
    let translations: readonly BlogPostTranslationDbRow[];
    let cover: CmsCoverMediaDbRow | null;
    try {
      row = await this.store.blogPostForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        postId: input.postId,
      });
      // Read unconditionally rather than only when the post was found: the reader applies the same permission
      // test, so a caller without the key gets an empty array either way, and one round trip saves a branch
      // that could drift from the one above.
      translations = await this.store.blogPostTranslationsForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        postId: input.postId,
      });
      // 0092's reader carries the cover's id and path but not its alt text, and its return shape is not
      // reshaped to add one, so the labels come from 0099's shared reader — the same one the page editor
      // uses, so both consoles describe an attachment in the same words. Read unconditionally for the
      // reason above: it applies the same read key.
      cover = await this.store.cmsCoverMediaForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        entityType: 'blog_post',
        entityId: input.postId,
      });
    } catch (error) {
      this.logger.error('The authored post could not be read.');
      throw new BlogUnavailableError(error);
    }

    // No row covers both a post that does not exist and a caller without the read key. The console cannot tell
    // the two apart, which is the point.
    if (row === null) throw new BlogNotFoundError();

    return {
      id: row.postId,
      slug: row.slug,
      status: row.status as BlogPostStatus,
      categoryId: row.blogCategoryId,
      categorySlug: row.categorySlug,
      isIndexable: row.isIndexable,
      isFeatured: row.isFeatured,
      coverMediaId: row.coverMediaId,
      coverObjectPath: row.coverObjectPath,
      coverAltTextEn: cover?.altTextEn ?? null,
      coverAltTextAr: cover?.altTextAr ?? null,
      authorUserId: row.authorUserId,
      scheduledFor: toIsoOrNull(row.scheduledFor),
      publishedAt: toIsoOrNull(row.publishedAt),
      archivedAt: toIsoOrNull(row.archivedAt),
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
      canManage: row.canManage,
      previousSlugs: [...(row.previousSlugs ?? [])],
      tagIds: [...(row.tagIds ?? [])],
      translations: translations.map(
        (entry): BlogPostTranslation => ({
          localeCode: entry.localeCode,
          title: entry.title,
          excerpt: entry.excerpt,
          body: entry.body,
          metaTitle: entry.metaTitle,
          metaDescription: entry.metaDescription,
          updatedAt: toIso(entry.updatedAt),
        }),
      ),
    };
  }

  /** The categories and tags, with whether this caller may change them. */
  async taxonomy(input: { accessToken: string }): Promise<BlogTaxonomyResponse> {
    const staff = await this.#reader(input.accessToken);

    let categories: readonly BlogCategoryDbRow[];
    let tags: readonly BlogTagDbRow[];
    try {
      categories = await this.store.blogCategoriesForStaff({ userId: staff.id, isAal2: staff.isAal2 });
      tags = await this.store.blogTagsForStaff({ userId: staff.id, isAal2: staff.isAal2 });
    } catch (error) {
      this.logger.error('The blog taxonomy could not be read.');
      throw new BlogUnavailableError(error);
    }

    // Reported from the session's effective permissions rather than from a role name, and the writers re-apply
    // the same test in the database, so a console that renders a control it should not have changes nothing.
    const session = await this.console.forToken(input.accessToken);
    return {
      categories: categories.map(
        (row): BlogCategory => ({
          id: row.categoryId,
          slug: row.slug,
          nameEn: row.nameEn,
          nameAr: row.nameAr,
          descriptionEn: row.descriptionEn,
          descriptionAr: row.descriptionAr,
          sortOrder: toNumber(row.sortOrder),
          isActive: row.isActive,
          postCount: toNumber(row.postCount),
          updatedAt: toIso(row.updatedAt),
        }),
      ),
      tags: tags.map(
        (row): BlogTag => ({
          id: row.tagId,
          slug: row.slug,
          nameEn: row.nameEn,
          nameAr: row.nameAr,
          isActive: row.isActive,
          postCount: toNumber(row.postCount),
          updatedAt: toIso(row.updatedAt),
        }),
      ),
      canManage: session.permissions.includes(BLOG_MANAGE),
    };
  }

  /** Creates a draft. */
  async create(input: {
    accessToken: string;
    slug: string;
    categoryId: string | null;
    isIndexable: boolean;
  }): Promise<string> {
    const staff = await this.#reader(input.accessToken);
    return this.#write(async () =>
      this.store.blogPostCreateForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        slug: input.slug,
        categoryId: input.categoryId,
        isIndexable: input.isIndexable,
      }),
    );
  }

  /**
   * Changes a post's address or presentation. Never its status.
   *
   * `clearCategory` and `clearCover` carry what null cannot: in the database null means "leave it alone", so
   * clearing a reference needs a flag of its own. The controller turns an explicit `null` in the request body
   * into that flag, and an absent field into neither.
   */
  async update(input: {
    accessToken: string;
    postId: string;
    slug: string | null;
    categoryId: string | null;
    clearCategory: boolean;
    coverMediaId: string | null;
    clearCover: boolean;
    isIndexable: boolean | null;
    isFeatured: boolean | null;
  }): Promise<void> {
    const staff = await this.#reader(input.accessToken);
    const changed = await this.#write(async () =>
      this.store.blogPostUpdateForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        postId: input.postId,
        slug: input.slug,
        categoryId: input.categoryId,
        clearCategory: input.clearCategory,
        coverMediaId: input.coverMediaId,
        clearCover: input.clearCover,
        isIndexable: input.isIndexable,
        isFeatured: input.isFeatured,
      }),
    );
    if (!changed) throw new BlogNotFoundError();
  }

  /** Moves a post through the lifecycle. */
  async setStatus(input: {
    accessToken: string;
    postId: string;
    status: BlogPostStatus;
    scheduledFor: string | null;
  }): Promise<void> {
    const staff = await this.#reader(input.accessToken);
    const changed = await this.#write(async () =>
      this.store.blogPostStatusForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        postId: input.postId,
        status: input.status,
        scheduledFor: input.scheduledFor === null ? null : new Date(input.scheduledFor),
      }),
    );
    if (!changed) throw new BlogNotFoundError();
  }

  /** Writes one locale. */
  async saveTranslation(input: {
    accessToken: string;
    postId: string;
    localeCode: string;
    title: string;
    body: string;
    excerpt: string | null;
    metaTitle: string | null;
    metaDescription: string | null;
  }): Promise<void> {
    const staff = await this.#reader(input.accessToken);
    const saved = await this.#write(async () =>
      this.store.blogPostTranslationSaveForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        postId: input.postId,
        localeCode: input.localeCode,
        title: input.title,
        body: input.body,
        excerpt: input.excerpt,
        metaTitle: input.metaTitle,
        metaDescription: input.metaDescription,
      }),
    );
    if (!saved) throw new BlogNotFoundError();
  }

  /** Removes one locale. */
  async deleteTranslation(input: {
    accessToken: string;
    postId: string;
    localeCode: string;
  }): Promise<void> {
    const staff = await this.#reader(input.accessToken);
    const removed = await this.#write(async () =>
      this.store.blogPostTranslationDeleteForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        postId: input.postId,
        localeCode: input.localeCode,
      }),
    );
    // A locale that was not there is an absence, not a refusal: the database answers false for both a post
    // that does not exist and a locale it does not have, and the console's remedy is the same.
    if (!removed) throw new BlogNotFoundError();
  }

  /** Replaces a post's whole tag set. */
  async setTags(input: {
    accessToken: string;
    postId: string;
    tagIds: readonly string[];
  }): Promise<void> {
    const staff = await this.#reader(input.accessToken);
    const saved = await this.#write(async () =>
      this.store.blogPostTagsSetForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        postId: input.postId,
        tagIds: input.tagIds,
      }),
    );
    if (!saved) throw new BlogNotFoundError();
  }

  /** Creates or replaces one category. */
  async saveCategory(input: {
    accessToken: string;
    categoryId: string | null;
    slug: string | null;
    nameEn: string | null;
    nameAr: string | null;
    descriptionEn: string | null;
    descriptionAr: string | null;
    sortOrder: number | null;
    isActive: boolean | null;
  }): Promise<string> {
    const staff = await this.#reader(input.accessToken);
    const id = await this.#write(async () =>
      this.store.blogCategorySaveForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        categoryId: input.categoryId,
        slug: input.slug,
        nameEn: input.nameEn,
        nameAr: input.nameAr,
        descriptionEn: input.descriptionEn,
        descriptionAr: input.descriptionAr,
        sortOrder: input.sortOrder,
        isActive: input.isActive,
      }),
    );
    // Null means the identifier named nothing. The writer does not create one in that case, so this is an
    // absence rather than a refusal.
    if (id === null) throw new BlogNotFoundError();
    return id;
  }

  /** Creates or replaces one tag. */
  async saveTag(input: {
    accessToken: string;
    tagId: string | null;
    slug: string | null;
    nameEn: string | null;
    nameAr: string | null;
    isActive: boolean | null;
  }): Promise<string> {
    const staff = await this.#reader(input.accessToken);
    const id = await this.#write(async () =>
      this.store.blogTagSaveForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        tagId: input.tagId,
        slug: input.slug,
        nameEn: input.nameEn,
        nameAr: input.nameAr,
        isActive: input.isActive,
      }),
    );
    if (id === null) throw new BlogNotFoundError();
    return id;
  }

  #summary(row: BlogPostListDbRow): BlogPostSummary {
    return {
      id: row.postId,
      slug: row.slug,
      status: row.status as BlogPostStatus,
      categoryId: row.blogCategoryId,
      categorySlug: row.categorySlug,
      isIndexable: row.isIndexable,
      isFeatured: row.isFeatured,
      scheduledFor: toIsoOrNull(row.scheduledFor),
      publishedAt: toIsoOrNull(row.publishedAt),
      archivedAt: toIsoOrNull(row.archivedAt),
      updatedAt: toIso(row.updatedAt),
      translatedLocales: [...(row.translatedLocales ?? [])],
      tagCount: toNumber(row.tagCount),
      title: row.title,
    };
  }

  /**
   * Runs a write and sorts its failures.
   *
   * `42501` is the database refusing a caller who does not hold `cms.blog.manage`. It becomes a 404 rather than
   * a 403: a caller may hold the read key and not the manage key, and telling them which posts exist but not
   * which they may edit is a distinction the detail already reports through `canManage`. Turning it into an
   * absence keeps this surface's one rule — a refusal and an absence look the same.
   *
   * The four refusal SQLSTATEs become a 409 carrying our own code and sentence, because each one is a real
   * conflict a console has to show. Anything else is a 503: an unexpected failure is not a user error.
   */
  async #write<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      const sqlstate = sqlstateOf(error);
      if (sqlstate === '42501') throw new BlogNotFoundError();
      const refusal = sqlstate === null ? undefined : REFUSALS.get(sqlstate);
      if (refusal !== undefined) throw new BlogRefusedError(refusal.code, refusal.detail);
      this.logger.error('A blog row could not be written.');
      throw new BlogUnavailableError(error);
    }
  }

  async #reader(accessToken: string): Promise<{ id: string; isAal2: boolean }> {
    const session = await this.console.forToken(accessToken);
    if (!session.permissions.includes(BLOG_READ)) throw new BlogNotFoundError();
    return { id: session.id, isAal2: isAal2(accessToken) };
  }
}
