import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  PublicBlogPost,
  PublicBlogPostSummary,
  PublicBlogTaxonomyEntry,
  PublicLocale,
} from '@repo/contracts';
import { CmsPublicUnavailableError } from './cms-errors.js';

/**
 * The public side of the blog (0092).
 *
 * Everything this service knows about visibility comes from the database: `cms_content_is_public` decides what
 * is published, 0092's readers decide which locale comes back and whether a slug is a redirect, and this layer
 * shapes the answer. It holds no user context on purpose — a post is the same for a guest and for a signed-in
 * person, so there is nothing here to authorize and nothing to leak between callers.
 *
 * **The three answers are the database's, not this service's.** A post, a slug that moved, or absence. This
 * layer does not decide that a draft is invisible or that an unwritten post is absent; it reports which of the
 * three it was told.
 *
 * **A post's `<head>` comes from the post.** `metaTitle` and `metaDescription` are the translation's own
 * columns, carried through untouched. 0092's decision B keeps `seo_metadata` out of this entirely, so there is
 * no second source to merge and no precedence rule to get wrong.
 *
 * `resolvedLocale` is carried all the way to the contract because a renderer needs it: a post may exist in
 * English and not in Arabic, nothing is machine translated, and a post served in the fallback language has to
 * say so in its markup rather than claim to be in the language that was asked for.
 */

export const BLOG_PUBLIC_STORE = Symbol('BLOG_PUBLIC_STORE');

/** One row of `app_private.blog_post_for_public` (0092). */
export interface PublicBlogPostDbRow {
  readonly kind: string;
  readonly postId: string | null;
  readonly slug: string | null;
  readonly isIndexable: boolean | null;
  readonly isFeatured: boolean | null;
  readonly publishedAt: Date | string | null;
  readonly updatedAt: Date | string | null;
  readonly categorySlug: string | null;
  readonly categoryName: string | null;
  readonly coverObjectPath: string | null;
  readonly resolvedLocale: string | null;
  readonly title: string | null;
  readonly excerpt: string | null;
  readonly body: string | null;
  readonly metaTitle: string | null;
  readonly metaDescription: string | null;
  readonly tagSlugs: readonly string[] | null;
  readonly tagNames: readonly string[] | null;
}

/** One row of `app_private.blog_posts_for_public` (0092). */
export interface PublicBlogPostListDbRow {
  readonly postId: string;
  readonly slug: string;
  readonly isFeatured: boolean;
  readonly publishedAt: Date | string;
  readonly updatedAt: Date | string;
  readonly categorySlug: string | null;
  readonly categoryName: string | null;
  readonly coverObjectPath: string | null;
  readonly resolvedLocale: string;
  readonly title: string;
  readonly excerpt: string | null;
}

/** One row of `app_private.blog_taxonomy_for_public` (0092). */
export interface PublicBlogTaxonomyDbRow {
  readonly entryType: string;
  readonly entryId: string;
  readonly slug: string;
  readonly name: string;
  readonly sortOrder: number | string;
  readonly postCount: number | string;
}

export interface BlogPublicStore {
  /** `app_private.blog_post_for_public(text, text)`: one post, one redirect, or absence. */
  blogPostForPublic(input: { slug: string; locale: PublicLocale }): Promise<PublicBlogPostDbRow | null>;

  /** `app_private.blog_posts_for_public(...)`: one page of the index, already ordered. */
  blogPostsForPublic(input: {
    locale: PublicLocale;
    categorySlug: string | null;
    tagSlug: string | null;
    limit: number;
    cursorPublishedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly PublicBlogPostListDbRow[]>;

  /** `app_private.blog_taxonomy_for_public(text)`: the active filters with their public counts. */
  blogTaxonomyForPublic(locale: PublicLocale): Promise<readonly PublicBlogTaxonomyDbRow[]>;
}

/** What a slug resolved to. The three kinds the database answers with, named. */
export type BlogPostLookup =
  | { readonly kind: 'post'; readonly post: PublicBlogPost }
  | { readonly kind: 'moved'; readonly movedTo: string }
  | { readonly kind: 'not_found' };

export interface PublicBlogIndex {
  readonly items: readonly PublicBlogPostSummary[];
  readonly nextCursor: string | null;
}

export interface PublicBlogTaxonomy {
  readonly categories: readonly PublicBlogTaxonomyEntry[];
  readonly tags: readonly PublicBlogTaxonomyEntry[];
}

/**
 * The public index cursor.
 *
 * Tagged `bi1` and separate from the catalogue's untagged cursor on purpose. The sort key here is
 * `published_at` rather than `created_at`, and a position in the listings feed is a real position in the wrong
 * list — the same reasoning every other tagged cursor on this platform is built on.
 *
 * It is not a credential and confers no access: the reader behind it applies 0030's own publication predicate,
 * so an edited cursor can only move a visitor around inside posts anybody may read. Nothing is ever
 * interpolated — a cursor decodes to a fixed pair of typed values or to nothing at all.
 */
export const BLOG_INDEX_CURSOR_VERSION = 'bi1';

const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export function encodeBlogIndexCursor(publishedAt: Date, id: string): string {
  return Buffer.from(
    [BLOG_INDEX_CURSOR_VERSION, publishedAt.toISOString(), id.toLowerCase()].join('|'),
    'utf8',
  ).toString('base64url');
}

export function decodeBlogIndexCursor(cursor: string): { publishedAt: Date; id: string } | null {
  if (typeof cursor !== 'string' || cursor === '' || !BASE64URL_PATTERN.test(cursor)) return null;
  let text: string;
  try {
    text = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  // `Buffer.from` ignores characters it does not recognise, so the round trip is what makes this strict.
  if (Buffer.from(text, 'utf8').toString('base64url') !== cursor) return null;

  const parts = text.split('|');
  if (parts.length !== 3) return null;
  const [tag, timestamp, id] = parts as [string, string, string];
  if (tag !== BLOG_INDEX_CURSOR_VERSION) return null;
  if (!UUID_PATTERN.test(id)) return null;
  if (!TIMESTAMP_PATTERN.test(timestamp)) return null;

  const publishedAt = new Date(timestamp);
  if (Number.isNaN(publishedAt.getTime())) return null;
  // `2026-02-31T…` matches the pattern and is not a date; re-serialising catches it.
  if (publishedAt.toISOString() !== timestamp) return null;
  return { publishedAt, id };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toNumber(value: number | string): number {
  return typeof value === 'number' ? value : Number(value);
}

@Injectable()
export class BlogPublicService {
  private readonly logger = new Logger(BlogPublicService.name);

  constructor(@Inject(BLOG_PUBLIC_STORE) private readonly store: BlogPublicStore) {}

  /**
   * One post by slug.
   *
   * A database that cannot answer is a 503 and never an absence: telling a visitor that a post does not exist,
   * when in truth we could not read it, would be a worse answer than admitting the failure.
   */
  async bySlug(slug: string, locale: PublicLocale): Promise<BlogPostLookup> {
    let row: PublicBlogPostDbRow | null;
    try {
      row = await this.store.blogPostForPublic({ slug, locale });
    } catch (error) {
      this.logger.error('A blog post could not be read.');
      throw new CmsPublicUnavailableError(error);
    }

    if (row === null || row.kind === 'not_found') return { kind: 'not_found' };
    if (row.kind === 'moved') {
      // The moved member carries a slug and nothing else, so a caller cannot render it as a post.
      return row.slug === null ? { kind: 'not_found' } : { kind: 'moved', movedTo: row.slug };
    }

    // Every field below is non-null on the `post` branch of the reader. Anything missing here would mean the
    // function's result shape and this interface have drifted, which is a 503 rather than a half-rendered page.
    //
    // `absent` covers undefined as well as null on purpose: a drifted reader does not return a null column, it
    // stops returning the column at all, and checking only for null would let that reach `new Date(undefined)`
    // and surface as a 500 — an unexpected failure rather than the honest unavailability it is.
    const absent = (value: unknown): boolean => value === null || value === undefined;
    if (
      absent(row.slug) ||
      absent(row.isIndexable) ||
      absent(row.isFeatured) ||
      absent(row.resolvedLocale) ||
      absent(row.title) ||
      absent(row.body) ||
      absent(row.publishedAt) ||
      absent(row.updatedAt)
    ) {
      this.logger.error('A blog post row was missing a field the reader always returns.');
      throw new CmsPublicUnavailableError();
    }

    const slugs = row.tagSlugs ?? [];
    const names = row.tagNames ?? [];
    return {
      kind: 'post',
      post: {
        slug: row.slug as string,
        isIndexable: row.isIndexable as boolean,
        isFeatured: row.isFeatured as boolean,
        categorySlug: row.categorySlug,
        categoryName: row.categoryName,
        resolvedLocale: row.resolvedLocale as PublicLocale,
        title: row.title as string,
        excerpt: row.excerpt,
        body: row.body as string,
        metaTitle: row.metaTitle,
        metaDescription: row.metaDescription,
        coverObjectPath: row.coverObjectPath,
        // The two arrays are built in one aggregate pass over the same rows with the same ordering, so index
        // `i` names the same tag in both. Zipping to the shorter of the two is the belt to that braces: a
        // mismatch would mean the reader changed, and a tag with no name is not worth rendering.
        tags: slugs.slice(0, Math.min(slugs.length, names.length)).map((tagSlug, index) => ({
          slug: tagSlug,
          name: names[index] as string,
        })),
        publishedAt: toIso(row.publishedAt as Date | string),
        updatedAt: toIso(row.updatedAt as Date | string),
      },
    };
  }

  /** One page of the public index, newest published first. */
  async index(input: {
    locale: PublicLocale;
    categorySlug: string | null;
    tagSlug: string | null;
    limit: number;
    cursor: string | null;
  }): Promise<PublicBlogIndex | null> {
    let position: { publishedAt: Date; id: string } | null = null;
    if (input.cursor !== null) {
      position = decodeBlogIndexCursor(input.cursor);
      // Null tells the controller to answer 400. One refusal for malformed, altered and outdated — including a
      // position from any other list on this platform.
      if (position === null) return null;
    }

    let rows: readonly PublicBlogPostListDbRow[];
    try {
      rows = await this.store.blogPostsForPublic({
        locale: input.locale,
        // Passed as parameters. A slug that names nothing, or something deactivated, matches nothing in the
        // database rather than being refused here, so a stale link shows an empty page instead of an error.
        categorySlug: input.categorySlug,
        tagSlug: input.tagSlug,
        limit: input.limit + 1,
        cursorPublishedAt: position?.publishedAt ?? null,
        cursorId: position?.id ?? null,
      });
    } catch (error) {
      this.logger.error('The blog index could not be read.');
      throw new CmsPublicUnavailableError(error);
    }

    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    const last = page.at(-1);
    return {
      items: page.map(
        (row): PublicBlogPostSummary => ({
          slug: row.slug,
          isFeatured: row.isFeatured,
          categorySlug: row.categorySlug,
          categoryName: row.categoryName,
          resolvedLocale: row.resolvedLocale as PublicLocale,
          title: row.title,
          excerpt: row.excerpt,
          coverObjectPath: row.coverObjectPath,
          publishedAt: toIso(row.publishedAt),
          updatedAt: toIso(row.updatedAt),
        }),
      ),
      nextCursor:
        hasMore && last !== undefined
          ? encodeBlogIndexCursor(new Date(toIso(last.publishedAt)), last.postId)
          : null,
    };
  }

  /** The filters the index offers, with how many posts the public may see under each. */
  async taxonomy(locale: PublicLocale): Promise<PublicBlogTaxonomy> {
    let rows: readonly PublicBlogTaxonomyDbRow[];
    try {
      rows = await this.store.blogTaxonomyForPublic(locale);
    } catch (error) {
      this.logger.error('The blog taxonomy could not be read.');
      throw new CmsPublicUnavailableError(error);
    }

    const entry = (row: PublicBlogTaxonomyDbRow): PublicBlogTaxonomyEntry => ({
      slug: row.slug,
      name: row.name,
      postCount: toNumber(row.postCount),
    });
    return {
      categories: rows.filter((row) => row.entryType === 'category').map(entry),
      tags: rows.filter((row) => row.entryType === 'tag').map(entry),
    };
  }
}
