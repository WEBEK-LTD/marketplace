import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  CmsPageDetail,
  CmsPageStatus,
  CmsPageSummary,
  CmsPageTemplate,
  CmsPageTranslation,
} from '@repo/contracts';
import { isAal2 } from '../auth/access-token-claims.js';
import { StaffConsoleService } from './staff-console.service.js';
import type { CmsPageRefusalCode } from './cms-pages.errors.js';
import {
  CmsPageCursorInvalidError,
  CmsPageNotFoundError,
  CmsPageRefusedError,
  CmsPageUnavailableError,
} from './cms-pages.errors.js';
import { decodeCmsPageCursor, encodeCmsPageCursor } from './cms-pages.cursor.js';
import type { CmsCoverMediaDbRow } from './cms-media.service.js';

/**
 * Authoring CMS static pages.
 *
 * **Authorization, in the one order it is ever done**, which is this console's and is not varied:
 *
 *   1. The **provider** validates the caller's access token and says whose it is.
 *   2. The **assurance level** is read from that same, now-vouched-for token. Reading a claim first would be
 *      reading an attacker's JSON.
 *   3. The **database** reports the caller's *effective* permissions under the platform's own `requires_mfa`
 *      rule. Both roles that hold a CMS page key — `admin` and `super_admin` — require MFA, so staff at `aal1`
 *      hold nothing at all; asking whether the effective set contains the key is therefore the AAL2 check and
 *      the permission check at once.
 *   4. Every `app_private` function below **re-applies the same test itself**, with the account and the
 *      assurance level as parameters and the key as a **literal**. No bug in this file can turn into somebody
 *      editing the terms of service.
 *
 * **Two keys, and the separation between them is visible to the console.** `cms.page.read` opens the section
 * and every read; `cms.page.manage` is required by every write, and the detail reports whether this caller
 * holds it so a console renders its controls from the answer rather than from a role name. No role name is
 * checked anywhere in this file.
 *
 * **Every rule this surface appears to apply is applied in the database.** The slug format, the page-key
 * format, the template set, the four states, which lifecycle edges exist, which timestamp each state owns,
 * that a previous slug can never be taken over, that a page cannot be published before it is written, and that
 * a live page cannot lose its last locale — all of it is migration 0030 or migration 0085. This service passes
 * the caller's account, shapes the answer, and **checks nothing a second time**.
 *
 * **A refusal and an absence are the same answer**, as everywhere else in this console: a page that does not
 * exist and a caller without the read key both arrive as no row and become one {@link CmsPageNotFoundError}. A
 * *write* refusal is different and keeps its own class, because it is not an absence and a console has to be
 * able to show it.
 */

export const CMS_PAGE_READ = 'cms.page.read';
export const CMS_PAGE_MANAGE = 'cms.page.manage';

export const CMS_PAGES_STORE = Symbol('CMS_PAGES_STORE');

/* ------------------------------------------------------------------------------------------------ */
/* The rows each function returns                                                                    */
/* ------------------------------------------------------------------------------------------------ */

/** One row of `app_private.cms_pages_for_staff` (0085). */
export interface CmsPageListDbRow {
  readonly pageId: string;
  readonly slug: string;
  readonly pageKey: string | null;
  readonly status: string;
  readonly template: string;
  readonly isIndexable: boolean;
  readonly sortOrder: number | string;
  readonly scheduledFor: Date | string | null;
  readonly publishedAt: Date | string | null;
  readonly archivedAt: Date | string | null;
  readonly updatedAt: Date | string;
  readonly translatedLocales: readonly string[] | null;
  readonly title: string | null;
}

/** One row of `app_private.cms_page_for_staff` (0085). */
export interface CmsPageDetailDbRow {
  readonly pageId: string;
  readonly slug: string;
  readonly pageKey: string | null;
  readonly status: string;
  readonly template: string;
  readonly isIndexable: boolean;
  readonly sortOrder: number | string;
  readonly scheduledFor: Date | string | null;
  readonly publishedAt: Date | string | null;
  readonly archivedAt: Date | string | null;
  readonly createdAt: Date | string;
  readonly updatedAt: Date | string;
  readonly createdBy: string | null;
  readonly updatedBy: string | null;
  readonly canManage: boolean;
  readonly previousSlugs: readonly string[] | null;
}

/** One row of `app_private.cms_page_translations_for_staff` (0085). */
export interface CmsPageTranslationDbRow {
  readonly localeCode: string;
  readonly title: string;
  readonly excerpt: string | null;
  readonly body: string;
  readonly metaTitle: string | null;
  readonly metaDescription: string | null;
  readonly updatedAt: Date | string;
}

/** The database operations this service needs. Every one is a named definer function from 0085. */
export interface CmsPagesStore {
  cmsPagesForStaff(input: {
    userId: string;
    isAal2: boolean;
    limit: number;
    status: string | null;
    cursorUpdatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly CmsPageListDbRow[]>;

  cmsPageForStaff(input: {
    userId: string;
    isAal2: boolean;
    pageId: string;
  }): Promise<CmsPageDetailDbRow | null>;

  cmsPageTranslationsForStaff(input: {
    userId: string;
    isAal2: boolean;
    pageId: string;
  }): Promise<readonly CmsPageTranslationDbRow[]>;

  cmsPageCreateForStaff(input: {
    userId: string;
    isAal2: boolean;
    slug: string;
    pageKey: string | null;
    template: string;
    sortOrder: number;
    isIndexable: boolean;
  }): Promise<string>;

  cmsPageUpdateForStaff(input: {
    userId: string;
    isAal2: boolean;
    pageId: string;
    slug: string | null;
    pageKey: string | null;
    template: string | null;
    sortOrder: number | null;
    isIndexable: boolean | null;
  }): Promise<boolean>;

  cmsPageStatusForStaff(input: {
    userId: string;
    isAal2: boolean;
    pageId: string;
    status: string;
    scheduledFor: Date | null;
  }): Promise<boolean>;

  cmsPageTranslationSaveForStaff(input: {
    userId: string;
    isAal2: boolean;
    pageId: string;
    localeCode: string;
    title: string;
    body: string;
    excerpt: string | null;
    metaTitle: string | null;
    metaDescription: string | null;
  }): Promise<boolean>;

  cmsPageTranslationDeleteForStaff(input: {
    userId: string;
    isAal2: boolean;
    pageId: string;
    localeCode: string;
  }): Promise<boolean>;

  /** 0099. Attaches, leaves or removes a page's cover. `cms.page.manage`, not `cms.media.manage`. */
  cmsPageCoverForStaff(input: {
    userId: string;
    isAal2: boolean;
    pageId: string;
    coverMediaId: string | null;
    clearCover: boolean;
  }): Promise<boolean>;

  /** 0099. The cover attached to one page, or null. Needs only the section's read key. */
  cmsCoverMediaForStaff(input: {
    userId: string;
    isAal2: boolean;
    entityType: 'page' | 'blog_post';
    entityId: string;
  }): Promise<CmsCoverMediaDbRow | null>;
}

export interface CmsPagePage {
  readonly items: readonly CmsPageSummary[];
  readonly nextCursor: string | null;
}

/**
 * The SQLSTATEs a refused write arrives as, each with **our own** code and sentence.
 *
 * The database's text is deliberately not forwarded. Its messages here happen to be safe — 0030 and 0085 wrote
 * them and none interpolates a row — but a PostgreSQL constraint message is a different kind of value from an
 * API response, and this console already refuses to carry raw database text on its other surfaces. Mapping the
 * five characters to a code and a sentence we control keeps that true and means a change to a constraint's
 * wording cannot change what a browser is shown.
 *
 * **`23502` is deliberately absent.** A not-null violation would mean the request reached the database without
 * a field the contract requires, which is a failure of this service rather than of the caller, so it takes the
 * 503 path with everything else unexpected instead of being reported as a conflict the console could fix.
 */
const REFUSALS: ReadonlyMap<string, { readonly code: CmsPageRefusalCode; readonly detail: string }> = new Map([
  // restrict_violation — 0085's two guards, which are one rule read from two directions: a live page has text.
  [
    '23001',
    {
      code: 'CMS_PAGE_LOCALE_REQUIRED' as const,
      detail: 'The page must be written in at least one locale while it is published or scheduled.',
    },
  ],
  // check_violation — 0030's transition trigger, or one of its column constraints.
  [
    '23514',
    {
      code: 'CMS_PAGE_TRANSITION_NOT_ALLOWED' as const,
      detail: 'That is not an allowed change for a page in its current state.',
    },
  ],
  // unique_violation — a slug already in use, or one that belongs to another page's history and can never be
  // taken over because it still redirects there.
  [
    '23505',
    {
      code: 'CMS_PAGE_SLUG_TAKEN' as const,
      detail: 'That address is already in use, or was previously used by another page.',
    },
  ],
  // foreign_key_violation — 0030's `pages_cover_media_id_fkey` refusing a cover image that is not in the
  // library (0099). It is the only existence check on that path: this service runs none of its own.
  [
    '23503',
    {
      code: 'CMS_PAGE_COVER_MEDIA_MISSING' as const,
      detail: 'That image is not in the media library.',
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
export class CmsPagesAdminService {
  private readonly logger = new Logger(CmsPagesAdminService.name);

  constructor(
    @Inject(CMS_PAGES_STORE) private readonly store: CmsPagesStore,
    private readonly console: StaffConsoleService,
  ) {}

  /** One page of authored pages, newest edit first. */
  async list(input: {
    accessToken: string;
    limit: number;
    status: string | null;
    cursor: string | null;
  }): Promise<CmsPagePage> {
    const staff = await this.#reader(input.accessToken);

    let position: { updatedAt: Date; id: string } | null = null;
    if (input.cursor !== null) {
      position = decodeCmsPageCursor(input.cursor);
      // One refusal for malformed, altered and outdated — including a position from any other list on this
      // platform, whose rows sit behind different keys entirely.
      if (position === null) throw new CmsPageCursorInvalidError();
    }

    let rows: readonly CmsPageListDbRow[];
    try {
      rows = await this.store.cmsPagesForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        limit: input.limit + 1,
        // Passed as a parameter. An unknown value matches nothing in the database rather than being refused
        // here, so a stale filter in a bookmark shows an empty page instead of an error.
        status: input.status,
        cursorUpdatedAt: position?.updatedAt ?? null,
        cursorId: position?.id ?? null,
      });
    } catch (error) {
      this.logger.error('The authored page list could not be read.');
      throw new CmsPageUnavailableError(error);
    }

    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    const last = page.at(-1);
    return {
      items: page.map((row) => this.#summary(row)),
      nextCursor:
        hasMore && last !== undefined
          ? encodeCmsPageCursor({ updatedAt: new Date(toIso(last.updatedAt)), id: last.pageId })
          : null,
    };
  }

  /** One page, with its previous slugs and every locale it has been written in. */
  async detail(input: { accessToken: string; pageId: string }): Promise<CmsPageDetail> {
    const staff = await this.#reader(input.accessToken);

    let row: CmsPageDetailDbRow | null;
    let translations: readonly CmsPageTranslationDbRow[];
    let cover: CmsCoverMediaDbRow | null;
    try {
      row = await this.store.cmsPageForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        pageId: input.pageId,
      });
      // Read unconditionally rather than only when the page was found: the reader applies the same permission
      // test, so a caller without the key gets an empty array either way, and one round trip saves a branch
      // that could drift from the one above.
      translations = await this.store.cmsPageTranslationsForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        pageId: input.pageId,
      });
      // 0085's reader does not mention the cover and its return shape is not reshaped to add one, so the
      // attachment comes from 0099's own reader. Read unconditionally for the same reason as above: it
      // applies the same read key and answers nothing for a page this caller may not see.
      cover = await this.store.cmsCoverMediaForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        entityType: 'page',
        entityId: input.pageId,
      });
    } catch (error) {
      this.logger.error('The authored page could not be read.');
      throw new CmsPageUnavailableError(error);
    }

    // No row covers both a page that does not exist and a caller without the read key. The console cannot
    // tell the two apart, which is the point.
    if (row === null) throw new CmsPageNotFoundError();

    return {
      id: row.pageId,
      slug: row.slug,
      pageKey: row.pageKey,
      status: row.status as CmsPageStatus,
      template: row.template as CmsPageTemplate,
      isIndexable: row.isIndexable,
      sortOrder: toNumber(row.sortOrder),
      scheduledFor: toIsoOrNull(row.scheduledFor),
      publishedAt: toIsoOrNull(row.publishedAt),
      archivedAt: toIsoOrNull(row.archivedAt),
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
      canManage: row.canManage,
      previousSlugs: [...(row.previousSlugs ?? [])],
      coverMediaId: cover?.mediaId ?? null,
      coverObjectPath: cover?.objectPath ?? null,
      coverAltTextEn: cover?.altTextEn ?? null,
      coverAltTextAr: cover?.altTextAr ?? null,
      translations: translations.map(
        (entry): CmsPageTranslation => ({
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

  /** Creates a draft. */
  async create(input: {
    accessToken: string;
    slug: string;
    pageKey: string | null;
    template: CmsPageTemplate;
    sortOrder: number;
    isIndexable: boolean;
  }): Promise<string> {
    const staff = await this.#reader(input.accessToken);
    return this.#write(async () =>
      this.store.cmsPageCreateForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        slug: input.slug,
        pageKey: input.pageKey,
        template: input.template,
        sortOrder: input.sortOrder,
        isIndexable: input.isIndexable,
      }),
    );
  }

  /** Changes a page's address or presentation. Never its status. */
  async update(input: {
    accessToken: string;
    pageId: string;
    slug: string | null;
    pageKey: string | null;
    template: CmsPageTemplate | null;
    sortOrder: number | null;
    isIndexable: boolean | null;
  }): Promise<void> {
    const staff = await this.#reader(input.accessToken);
    const changed = await this.#write(async () =>
      this.store.cmsPageUpdateForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        pageId: input.pageId,
        slug: input.slug,
        pageKey: input.pageKey,
        template: input.template,
        sortOrder: input.sortOrder,
        isIndexable: input.isIndexable,
      }),
    );
    if (!changed) throw new CmsPageNotFoundError();
  }

  /**
   * Attaches or removes a page's cover image (0099).
   *
   * **An explicit null is the clear**, which is the only reason this takes a nullable rather than an optional:
   * the route's body requires the field, so the caller has always said which of the two operations they mean.
   * Leaving a cover alone is not sending this request, and the database writer keeps that third behaviour for
   * callers that need it.
   *
   * Needs `cms.page.manage` and nothing else: a page editor does not have to hold `cms.media.manage` to name
   * an entry, and this service never reads the library.
   */
  async setCover(input: {
    accessToken: string;
    pageId: string;
    mediaId: string | null;
  }): Promise<void> {
    const staff = await this.#reader(input.accessToken);
    const changed = await this.#write(async () =>
      this.store.cmsPageCoverForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        pageId: input.pageId,
        coverMediaId: input.mediaId,
        clearCover: input.mediaId === null,
      }),
    );
    if (!changed) throw new CmsPageNotFoundError();
  }

  /** Moves a page through the lifecycle. */
  async setStatus(input: {
    accessToken: string;
    pageId: string;
    status: CmsPageStatus;
    scheduledFor: string | null;
  }): Promise<void> {
    const staff = await this.#reader(input.accessToken);
    const changed = await this.#write(async () =>
      this.store.cmsPageStatusForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        pageId: input.pageId,
        status: input.status,
        scheduledFor: input.scheduledFor === null ? null : new Date(input.scheduledFor),
      }),
    );
    if (!changed) throw new CmsPageNotFoundError();
  }

  /** Writes one locale. */
  async saveTranslation(input: {
    accessToken: string;
    pageId: string;
    localeCode: string;
    title: string;
    body: string;
    excerpt: string | null;
    metaTitle: string | null;
    metaDescription: string | null;
  }): Promise<void> {
    const staff = await this.#reader(input.accessToken);
    const saved = await this.#write(async () =>
      this.store.cmsPageTranslationSaveForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        pageId: input.pageId,
        localeCode: input.localeCode,
        title: input.title,
        body: input.body,
        excerpt: input.excerpt,
        metaTitle: input.metaTitle,
        metaDescription: input.metaDescription,
      }),
    );
    if (!saved) throw new CmsPageNotFoundError();
  }

  /** Removes one locale. */
  async deleteTranslation(input: {
    accessToken: string;
    pageId: string;
    localeCode: string;
  }): Promise<void> {
    const staff = await this.#reader(input.accessToken);
    const removed = await this.#write(async () =>
      this.store.cmsPageTranslationDeleteForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        pageId: input.pageId,
        localeCode: input.localeCode,
      }),
    );
    // A locale that was not there is an absence, not a refusal: the database answers false for both a page
    // that does not exist and a locale it does not have, and the console's remedy is the same.
    if (!removed) throw new CmsPageNotFoundError();
  }

  #summary(row: CmsPageListDbRow): CmsPageSummary {
    return {
      id: row.pageId,
      slug: row.slug,
      pageKey: row.pageKey,
      status: row.status as CmsPageStatus,
      template: row.template as CmsPageTemplate,
      isIndexable: row.isIndexable,
      sortOrder: toNumber(row.sortOrder),
      scheduledFor: toIsoOrNull(row.scheduledFor),
      publishedAt: toIsoOrNull(row.publishedAt),
      archivedAt: toIsoOrNull(row.archivedAt),
      updatedAt: toIso(row.updatedAt),
      translatedLocales: [...(row.translatedLocales ?? [])],
      title: row.title,
    };
  }

  /**
   * Runs a write and sorts its failures.
   *
   * `42501` is the database refusing a caller who does not hold `cms.page.manage`. It becomes a 404 rather
   * than a 403: a caller may hold the read key and not the manage key, and telling them which pages exist but
   * not which they may edit is a distinction the detail already reports through `canManage`. Turning it into
   * an absence keeps this surface's one rule — a refusal and an absence look the same.
   *
   * The three refusal SQLSTATEs become a 409 carrying our own code and sentence, because each one is a real
   * conflict a console has to show. Anything else is a 503: an unexpected failure is not a user error.
   */
  async #write<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      const sqlstate = sqlstateOf(error);
      if (sqlstate === '42501') throw new CmsPageNotFoundError();
      const refusal = sqlstate === null ? undefined : REFUSALS.get(sqlstate);
      if (refusal !== undefined) throw new CmsPageRefusedError(refusal.code, refusal.detail);
      this.logger.error('A page could not be written.');
      throw new CmsPageUnavailableError(error);
    }
  }

  async #reader(accessToken: string): Promise<{ id: string; isAal2: boolean }> {
    const session = await this.console.forToken(accessToken);
    if (!session.permissions.includes(CMS_PAGE_READ)) throw new CmsPageNotFoundError();
    return { id: session.id, isAal2: isAal2(accessToken) };
  }
}
