import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PublicCmsPage, PublicCmsPageLink, PublicLocale } from '@repo/contracts';
import { CmsPublicUnavailableError } from './cms-errors.js';

/**
 * The public side of CMS static pages.
 *
 * Everything this service knows about visibility comes from the database: `cms_content_is_public` decides what
 * is published, 0085's reader decides which locale comes back and whether a slug is a redirect, and this layer
 * shapes the answer. It holds no user context on purpose — a page is the same for a guest and for a signed-in
 * person, so there is nothing here to authorize and nothing to leak between callers.
 *
 * **The three answers are the database's, not this service's.** A page, a slug that moved, or absence. This
 * layer does not decide that a draft is invisible or that an unwritten page is absent; it reports which of the
 * three it was told.
 *
 * `resolvedLocale` is carried all the way to the contract because a renderer needs it: a page may exist in
 * English and not in Arabic, nothing is machine translated, and a page served in the fallback language has to
 * say so in its markup rather than claim to be in the language that was asked for.
 */

export const CMS_PUBLIC_STORE = Symbol('CMS_PUBLIC_STORE');

/** One row of `app_private.cms_page_for_public` (0085). */
export interface PublicCmsPageDbRow {
  readonly kind: string;
  readonly pageId: string | null;
  readonly slug: string | null;
  readonly pageKey: string | null;
  readonly template: string | null;
  readonly isIndexable: boolean | null;
  readonly publishedAt: Date | string | null;
  readonly updatedAt: Date | string | null;
  readonly resolvedLocale: string | null;
  readonly title: string | null;
  readonly excerpt: string | null;
  readonly body: string | null;
  readonly metaTitle: string | null;
  readonly metaDescription: string | null;
  readonly coverObjectPath: string | null;
}

/** One row of `app_private.cms_pages_for_public` (0085). */
export interface PublicCmsPageLinkDbRow {
  readonly pageId: string;
  readonly slug: string;
  readonly pageKey: string | null;
  readonly template: string;
  readonly isIndexable: boolean;
  readonly sortOrder: number | string;
  readonly publishedAt: Date | string | null;
  readonly updatedAt: Date | string;
  readonly resolvedLocale: string;
  readonly title: string;
}

export interface CmsPublicStore {
  /** `app_private.cms_page_for_public(text, text)`: one page, one redirect, or absence. */
  cmsPageForPublic(input: { slug: string; locale: PublicLocale }): Promise<PublicCmsPageDbRow | null>;
  /** `app_private.cms_pages_for_public(text)`: every page the public may see, already ordered. */
  cmsPagesForPublic(locale: PublicLocale): Promise<readonly PublicCmsPageLinkDbRow[]>;
}

/** What a slug resolved to. The three kinds the database answers with, named. */
export type CmsPageLookup =
  | { readonly kind: 'page'; readonly page: PublicCmsPage }
  | { readonly kind: 'moved'; readonly movedTo: string }
  | { readonly kind: 'not_found' };

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

@Injectable()
export class CmsPagesService {
  private readonly logger = new Logger(CmsPagesService.name);

  constructor(@Inject(CMS_PUBLIC_STORE) private readonly store: CmsPublicStore) {}

  /**
   * One page by slug.
   *
   * A database that cannot answer is a 503 and never an absence: telling a visitor that the terms of service do
   * not exist, when in truth we could not read them, would be a worse answer than admitting the failure.
   */
  async bySlug(slug: string, locale: PublicLocale): Promise<CmsPageLookup> {
    let row: PublicCmsPageDbRow | null;
    try {
      row = await this.store.cmsPageForPublic({ slug, locale });
    } catch (error) {
      this.logger.error('A public page could not be read.');
      throw new CmsPublicUnavailableError(error);
    }

    // The reader always returns one row, so a missing row is a failure of this layer's assumptions rather
        // than an answer. Treated as absence, because a page the API cannot describe is not a page.
    if (row === null) return { kind: 'not_found' };

    if (row.kind === 'moved') {
      // A redirect with no target would send a browser nowhere; absence is the honest answer instead.
      return row.slug === null ? { kind: 'not_found' } : { kind: 'moved', movedTo: row.slug };
    }

    if (row.kind !== 'page') return { kind: 'not_found' };

    // Every field below is non-null for a `page` answer by the reader's own construction. Each is checked
    // anyway: a null here would mean the reader changed, and rendering a page titled "null" is worse than a
    // 404.
    if (
      row.slug === null ||
      row.template === null ||
      row.isIndexable === null ||
      row.resolvedLocale === null ||
      row.title === null ||
      row.body === null ||
      row.publishedAt === null ||
      row.updatedAt === null
    ) {
      this.logger.error('A public page answer was incomplete.');
      return { kind: 'not_found' };
    }

    return {
      kind: 'page',
      page: {
        slug: row.slug,
        pageKey: row.pageKey,
        template: row.template as PublicCmsPage['template'],
        isIndexable: row.isIndexable,
        resolvedLocale: row.resolvedLocale as PublicLocale,
        title: row.title,
        excerpt: row.excerpt,
        body: row.body,
        metaTitle: row.metaTitle,
        metaDescription: row.metaDescription,
        coverObjectPath: row.coverObjectPath,
        publishedAt: toIso(row.publishedAt),
        updatedAt: toIso(row.updatedAt),
      },
    };
  }

  /**
   * Every page the public may see.
   *
   * An empty list is a state, not a failure: nothing published yet is something a footer renders as nothing.
   */
  async index(locale: PublicLocale): Promise<readonly PublicCmsPageLink[]> {
    let rows: readonly PublicCmsPageLinkDbRow[];
    try {
      rows = await this.store.cmsPagesForPublic(locale);
    } catch (error) {
      this.logger.error('The public page index could not be read.');
      throw new CmsPublicUnavailableError(error);
    }

    return rows.map((row) => ({
      slug: row.slug,
      pageKey: row.pageKey,
      template: row.template as PublicCmsPageLink['template'],
      isIndexable: row.isIndexable,
      resolvedLocale: row.resolvedLocale as PublicLocale,
      title: row.title,
      updatedAt: toIso(row.updatedAt),
    }));
  }
}
