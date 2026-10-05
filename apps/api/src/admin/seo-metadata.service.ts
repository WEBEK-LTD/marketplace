import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  SeoDirective,
  SeoMetadataDetail,
  SeoMetadataEntityType,
  SeoMetadataEntry,
  SeoRestrictiveDirective,
} from '@repo/contracts';
import { SEO_DIRECTIVES, SEO_METADATA_ENTITY_TYPES, SEO_RESTRICTIVE_DIRECTIVES } from '@repo/contracts';
import { isAal2 } from '../auth/access-token-claims.js';
import { StaffConsoleService } from './staff-console.service.js';
import type { SeoMetadataRefusalCode } from './seo-metadata.errors.js';
import {
  SeoMetadataCursorInvalidError,
  SeoMetadataNotFoundError,
  SeoMetadataRefusedError,
  SeoMetadataUnavailableError,
} from './seo-metadata.errors.js';
import { decodeSeoMetadataCursor, encodeSeoMetadataCursor } from './seo-metadata.cursor.js';

/**
 * Maintaining the per-entity SEO metadata overrides.
 *
 * **Authorization, in the one order it is ever done**, which is this console's and is not varied: the provider
 * validates the token and says whose it is; the assurance level is read from that same now-vouched-for token; the
 * database reports the caller's *effective* permissions under the platform's own `requires_mfa` rule; and every
 * `app_private` function re-applies the same test itself, with the key as a **literal**.
 *
 * **Two keys, and the separation is visible to the console.** `seo.metadata.read` opens the section and every read;
 * `seo.metadata.manage` is required by every write, and the detail reports whether this caller holds it.
 *
 * **The two owner decisions are not applied here.** A stored canonical is withheld for a listing, a category and a
 * seller, and a stored directive set is reduced to its restrictions, *in the database* — before anything leaves it.
 * This service shapes what the reader returned and re-decides neither, which is why the detail can carry the stored
 * value and the effective value side by side without this file knowing the rule that separates them.
 */

export const SEO_METADATA_READ = 'seo.metadata.read';
export const SEO_METADATA_MANAGE = 'seo.metadata.manage';

export const SEO_METADATA_STORE = Symbol('SEO_METADATA_STORE');

/* ------------------------------------------------------------------------------------------------ */
/* The rows each function returns                                                                    */
/* ------------------------------------------------------------------------------------------------ */

/** One row of `app_private.seo_metadata_for_staff` (0091). */
export interface SeoMetadataListDbRow {
  readonly entryId: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly routePath: string | null;
  readonly targetSlug: string | null;
  readonly localeCode: string;
  readonly metaTitle: string | null;
  readonly metaDescription: string | null;
  readonly canonicalPath: string | null;
  readonly robotsDirectives: readonly string[] | null;
  readonly ogTitle: string | null;
  readonly ogDescription: string | null;
  readonly shareMediaId: string | null;
  readonly canonicalIsHonoured: boolean;
  readonly updatedAt: Date | string;
}

/** One row of `app_private.seo_metadata_entry_for_staff` (0091). */
export interface SeoMetadataDetailDbRow extends SeoMetadataListDbRow {
  readonly shareObjectPath: string | null;
  readonly effectiveCanonicalPath: string | null;
  readonly effectiveRobotsDirectives: readonly string[] | null;
  readonly createdAt: Date | string;
  readonly updatedBy: string | null;
  readonly canManage: boolean;
}

/** One row of either public reader (0091). */
export interface PublicSeoMetadataDbRow {
  readonly metaTitle: string | null;
  readonly metaDescription: string | null;
  readonly canonicalPath: string | null;
  readonly robotsDirectives: readonly string[] | null;
  readonly ogTitle: string | null;
  readonly ogDescription: string | null;
  readonly shareObjectPath: string | null;
}

/** The database operations this service needs. Every one is a named definer function from 0091. */
export interface SeoMetadataStore {
  seoMetadataForStaff(input: {
    userId: string;
    isAal2: boolean;
    limit: number;
    entityType: string | null;
    locale: string | null;
    cursorUpdatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly SeoMetadataListDbRow[]>;

  seoMetadataEntryForStaff(input: {
    userId: string;
    isAal2: boolean;
    entryId: string;
  }): Promise<SeoMetadataDetailDbRow | null>;

  seoMetadataSaveForStaff(input: {
    userId: string;
    isAal2: boolean;
    entityType: string;
    entityId: string | null;
    routePath: string | null;
    localeCode: string;
    metaTitle: string | null;
    metaDescription: string | null;
    canonicalPath: string | null;
    robotsDirectives: readonly string[] | null;
    ogTitle: string | null;
    ogDescription: string | null;
    shareMediaId: string | null;
  }): Promise<string>;

  seoMetadataDeleteForStaff(input: {
    userId: string;
    isAal2: boolean;
    entryId: string;
  }): Promise<boolean>;
}

export interface SeoMetadataPage {
  readonly items: readonly SeoMetadataEntry[];
  readonly nextCursor: string | null;
}

/**
 * The SQLSTATEs a refused write arrives as, each with **our own** code and sentence.
 *
 * The database's text is deliberately not forwarded, as on every other admin surface: a constraint's wording is not
 * an API response, and mapping the five characters to a code we control means a change to one cannot change what a
 * browser is shown.
 */
const REFUSALS: ReadonlyMap<string, { readonly code: SeoMetadataRefusalCode; readonly detail: string }> = new Map([
  // check_violation — an entity kind 0030 does not list, a path that is not relative, a value past a length bound,
  // an empty directive set, a directive outside the allowed list, or a set that contradicts itself.
  [
    '23514',
    {
      code: 'SEO_METADATA_NOT_ALLOWED' as const,
      detail:
        'That is not an allowed metadata entry: both paths must be addresses on this site, every value has a length limit, and the robots directives must be from the allowed set and must not contradict each other.',
    },
  ],
  // foreign_key_violation — a locale code or a share-image identifier that names no row.
  [
    '23503',
    {
      code: 'SEO_METADATA_TARGET_UNKNOWN' as const,
      detail: 'That locale or that image does not exist.',
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

/**
 * The directives the contract can express, from whatever the database returned.
 *
 * A value outside the vocabulary is dropped rather than carried, because the response schema would refuse the whole
 * body for one unknown member and an unreadable screen is worse than a missing directive. The drift is logged: it
 * would mean 0030's allowed set and this contract had come apart, which somebody needs to know.
 */
function directivesOf(
  values: readonly string[] | null,
  allowed: readonly string[],
  onDrift: (value: string) => void,
): string[] {
  const kept: string[] = [];
  for (const value of values ?? []) {
    if (allowed.includes(value)) kept.push(value);
    else onDrift(value);
  }
  return kept;
}

@Injectable()
export class SeoMetadataAdminService {
  private readonly logger = new Logger(SeoMetadataAdminService.name);

  constructor(
    @Inject(SEO_METADATA_STORE) private readonly store: SeoMetadataStore,
    private readonly console: StaffConsoleService,
  ) {}

  /** One page of overrides, newest edit first. */
  async list(input: {
    accessToken: string;
    limit: number;
    entityType: string | null;
    locale: string | null;
    cursor: string | null;
  }): Promise<SeoMetadataPage> {
    const staff = await this.#reader(input.accessToken);

    let position: { updatedAt: Date; id: string } | null = null;
    if (input.cursor !== null) {
      position = decodeSeoMetadataCursor(input.cursor);
      if (position === null) throw new SeoMetadataCursorInvalidError();
    }

    let rows: readonly SeoMetadataListDbRow[];
    try {
      rows = await this.store.seoMetadataForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        limit: input.limit + 1,
        // Passed as parameters. An unknown value matches nothing in the database rather than being refused here, so
        // a stale filter in a bookmark shows an empty page instead of an error.
        entityType: input.entityType,
        locale: input.locale,
        cursorUpdatedAt: position?.updatedAt ?? null,
        cursorId: position?.id ?? null,
      });
    } catch (error) {
      this.logger.error('The metadata overrides could not be read.');
      throw new SeoMetadataUnavailableError(error);
    }

    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    const last = page.at(-1);
    return {
      items: page.map((row) => this.#entry(row)),
      nextCursor:
        hasMore && last !== undefined
          ? encodeSeoMetadataCursor({ updatedAt: new Date(toIso(last.updatedAt)), id: last.entryId })
          : null,
    };
  }

  /** One override, with what the public would actually receive. */
  async detail(input: { accessToken: string; entryId: string }): Promise<SeoMetadataDetail> {
    const staff = await this.#reader(input.accessToken);

    let row: SeoMetadataDetailDbRow | null;
    try {
      row = await this.store.seoMetadataEntryForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        entryId: input.entryId,
      });
    } catch (error) {
      this.logger.error('The metadata override could not be read.');
      throw new SeoMetadataUnavailableError(error);
    }

    if (row === null) throw new SeoMetadataNotFoundError();

    return {
      ...this.#entry(row),
      shareObjectPath: row.shareObjectPath,
      effectiveCanonicalPath: row.effectiveCanonicalPath,
      // Already reduced by the database. Narrowed to the contract's vocabulary, never re-derived here.
      effectiveRobotsDirectives: directivesOf(row.effectiveRobotsDirectives, SEO_RESTRICTIVE_DIRECTIVES, (value) =>
        this.logger.warn(`A metadata override carried an unknown effective directive: ${value}`),
      ) as SeoRestrictiveDirective[],
      createdAt: toIso(row.createdAt),
      updatedBy: row.updatedBy,
      canManage: row.canManage,
    };
  }

  /** Writes one surface's metadata for one locale. Creating and replacing are the same call. */
  async save(input: {
    accessToken: string;
    entityType: string;
    entityId: string | null;
    routePath: string | null;
    localeCode: string;
    metaTitle: string | null;
    metaDescription: string | null;
    canonicalPath: string | null;
    robotsDirectives: readonly string[] | null;
    ogTitle: string | null;
    ogDescription: string | null;
    shareMediaId: string | null;
  }): Promise<string> {
    const staff = await this.#reader(input.accessToken);
    return this.#write(async () =>
      this.store.seoMetadataSaveForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        entityType: input.entityType,
        entityId: input.entityId,
        routePath: input.routePath,
        localeCode: input.localeCode,
        metaTitle: input.metaTitle,
        metaDescription: input.metaDescription,
        canonicalPath: input.canonicalPath,
        robotsDirectives: input.robotsDirectives,
        ogTitle: input.ogTitle,
        ogDescription: input.ogDescription,
        shareMediaId: input.shareMediaId,
      }),
    );
  }

  /** Removes one override, returning that surface to its derived metadata. */
  async remove(input: { accessToken: string; entryId: string }): Promise<void> {
    const staff = await this.#reader(input.accessToken);
    const removed = await this.#write(async () =>
      this.store.seoMetadataDeleteForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        entryId: input.entryId,
      }),
    );
    if (!removed) throw new SeoMetadataNotFoundError();
  }

  #entry(row: SeoMetadataListDbRow): SeoMetadataEntry {
    return {
      id: row.entryId,
      // Narrowed to the contract's vocabulary. 0030's constraint is the authority and this is its restatement, so
      // the cast is safe for every value the table can hold.
      entityType: row.entityType as SeoMetadataEntityType,
      entityId: row.entityId,
      routePath: row.routePath,
      targetSlug: row.targetSlug,
      localeCode: row.localeCode,
      metaTitle: row.metaTitle,
      metaDescription: row.metaDescription,
      canonicalPath: row.canonicalPath,
      robotsDirectives: directivesOf(row.robotsDirectives, SEO_DIRECTIVES, (value) =>
        this.logger.warn(`A metadata override carried an unknown stored directive: ${value}`),
      ) as SeoDirective[],
      ogTitle: row.ogTitle,
      ogDescription: row.ogDescription,
      shareMediaId: row.shareMediaId,
      canonicalIsHonoured: row.canonicalIsHonoured,
      updatedAt: toIso(row.updatedAt),
    };
  }

  /**
   * Runs a write and sorts its failures.
   *
   * `42501` is the database refusing a caller without `seo.metadata.manage`, and becomes a 404 rather than a 403: a
   * caller may hold the read key and not the manage key, and the detail already reports that through `canManage`.
   */
  async #write<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      const sqlstate = sqlstateOf(error);
      if (sqlstate === '42501') throw new SeoMetadataNotFoundError();
      const refusal = sqlstate === null ? undefined : REFUSALS.get(sqlstate);
      if (refusal !== undefined) throw new SeoMetadataRefusedError(refusal.code, refusal.detail);
      this.logger.error('A metadata override could not be written.');
      throw new SeoMetadataUnavailableError(error);
    }
  }

  async #reader(accessToken: string): Promise<{ id: string; isAal2: boolean }> {
    const session = await this.console.forToken(accessToken);
    if (!session.permissions.includes(SEO_METADATA_READ)) throw new SeoMetadataNotFoundError();
    return { id: session.id, isAal2: isAal2(accessToken) };
  }
}

/** Every entity kind the table allows, as a set, for the one shape check the controller makes. */
export const SEO_METADATA_KINDS: ReadonlySet<string> = new Set(SEO_METADATA_ENTITY_TYPES);
