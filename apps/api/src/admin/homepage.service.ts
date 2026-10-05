import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  homepageConfigIsValid,
  type HomepageSectionDetail,
  type HomepageSectionSummary,
  type HomepageSectionType,
  type HomepageSectionsResponse,
} from '@repo/contracts';
import { isAal2 } from '../auth/access-token-claims.js';
import { StaffConsoleService } from './staff-console.service.js';
import type { HomepageRefusalCode } from './homepage.errors.js';
import {
  HomepageNotFoundError,
  HomepageRefusedError,
  HomepageUnavailableError,
} from './homepage.errors.js';

/**
 * Authoring the homepage (0093).
 *
 * **Authorization, in the one order it is ever done**, which is this console's and is not varied:
 *
 *   1. The **provider** validates the caller's access token and says whose it is.
 *   2. The **assurance level** is read from that same, now-vouched-for token.
 *   3. The **database** reports the caller's *effective* permissions under the platform's own `requires_mfa`
 *      rule. Both roles that hold a homepage key require MFA, so staff at `aal1` hold nothing at all.
 *   4. Every `app_private` function below **re-applies the same test itself**, with the account and the assurance
 *      level as parameters and the key as a **literal**. No bug in this file can turn into somebody rearranging
 *      the site's front page.
 *
 * **Two keys, and the separation is visible to the console.** `cms.homepage.read` opens the section and every
 * read; `cms.homepage.manage` is required by every write, and both the list and the detail report whether this
 * caller holds it, so a console renders its controls from the answer rather than from a role name.
 *
 * **Every rule this surface appears to apply is applied in the database.** The key format, the nine legal types,
 * that `config` is an object, and the title lengths are 0030's constraints. Which rows a section can still show
 * is each row's own visibility predicate. This service passes the caller's account, shapes the answer, and
 * **checks nothing a second time** — with one exception it owns: whether a stored document matches its section's
 * type, which is a contract question the database has no opinion about and which the list reports as
 * `isConfigured` so an operator can find and fix it.
 *
 * **Nothing here reads a promotion, a placement, a ranking or anything financial.** Owner decision A: a featured
 * section is the ids an administrator chose.
 */

export const HOMEPAGE_READ = 'cms.homepage.read';
export const HOMEPAGE_MANAGE = 'cms.homepage.manage';

export const HOMEPAGE_STORE = Symbol('HOMEPAGE_STORE');

/** One row of `app_private.homepage_sections_for_staff` (0093). */
export interface HomepageSectionListDbRow {
  readonly sectionId: string;
  readonly sectionKey: string;
  readonly sectionType: string;
  readonly titleEn: string | null;
  readonly titleAr: string | null;
  readonly subtitleEn: string | null;
  readonly subtitleAr: string | null;
  readonly config: unknown;
  readonly sortOrder: number | string;
  readonly isActive: boolean;
  readonly isServed: boolean;
  readonly updatedAt: Date | string;
}

/** One row of `app_private.homepage_section_for_staff` (0093). */
export interface HomepageSectionDetailDbRow extends HomepageSectionListDbRow {
  readonly createdAt: Date | string;
  readonly canManage: boolean;
  readonly chosenCount: number | string;
  readonly renderableCount: number | string;
}

export interface HomepageStore {
  homepageSectionsForStaff(input: {
    userId: string;
    isAal2: boolean;
  }): Promise<readonly HomepageSectionListDbRow[]>;

  homepageSectionForStaff(input: {
    userId: string;
    isAal2: boolean;
    sectionId: string;
  }): Promise<HomepageSectionDetailDbRow | null>;

  homepageSectionSaveForStaff(input: {
    userId: string;
    isAal2: boolean;
    sectionId: string | null;
    sectionKey: string | null;
    sectionType: string | null;
    titleEn: string | null;
    titleAr: string | null;
    subtitleEn: string | null;
    subtitleAr: string | null;
    config: unknown;
    sortOrder: number | null;
  }): Promise<string | null>;

  homepageSectionStateForStaff(input: {
    userId: string;
    isAal2: boolean;
    sectionId: string;
    isActive: boolean;
  }): Promise<boolean>;

  homepageSectionsReorderForStaff(input: {
    userId: string;
    isAal2: boolean;
    sectionIds: readonly string[];
  }): Promise<number>;

  homepageSectionDeleteForStaff(input: {
    userId: string;
    isAal2: boolean;
    sectionId: string;
  }): Promise<boolean>;
}

/**
 * The SQLSTATEs a refused write arrives as, each with **our own** code and sentence.
 *
 * The database's text is deliberately not forwarded: a PostgreSQL constraint message is a different kind of value
 * from an API response, and mapping the five characters to a code we control means a change to a constraint's
 * wording cannot change what a browser is shown.
 */
const REFUSALS: ReadonlyMap<string, { readonly code: HomepageRefusalCode; readonly detail: string }> = new Map([
  [
    '23505',
    {
      code: 'HOMEPAGE_SECTION_KEY_TAKEN' as const,
      detail: 'Another homepage section already uses that key.',
    },
  ],
  [
    '23514',
    {
      code: 'HOMEPAGE_SECTION_NOT_ALLOWED' as const,
      detail: 'That is not an allowed value for a homepage section.',
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

@Injectable()
export class HomepageAdminService {
  private readonly logger = new Logger(HomepageAdminService.name);

  constructor(
    @Inject(HOMEPAGE_STORE) private readonly store: HomepageStore,
    private readonly console: StaffConsoleService,
  ) {}

  /** Every section in the homepage's own order, with whether this caller may change any of it. */
  async list(input: { accessToken: string }): Promise<HomepageSectionsResponse> {
    const staff = await this.#reader(input.accessToken);

    let rows: readonly HomepageSectionListDbRow[];
    try {
      rows = await this.store.homepageSectionsForStaff({ userId: staff.id, isAal2: staff.isAal2 });
    } catch (error) {
      this.logger.error('The homepage sections could not be read.');
      throw new HomepageUnavailableError(error);
    }

    const session = await this.console.forToken(input.accessToken);
    return {
      sections: rows.map(
        (row): HomepageSectionSummary => ({
          id: row.sectionId,
          sectionKey: row.sectionKey,
          sectionType: row.sectionType as HomepageSectionType,
          titleEn: row.titleEn,
          titleAr: row.titleAr,
          sortOrder: toNumber(row.sortOrder),
          isActive: row.isActive,
          isServed: row.isServed,
          // The one check this layer owns: the database has no opinion about what a section type's document
          // should look like, and an operator needs to be told which section is misconfigured.
          isConfigured: homepageConfigIsValid(row.sectionType, row.config),
          updatedAt: toIso(row.updatedAt),
        }),
      ),
      canManage: session.permissions.includes(HOMEPAGE_MANAGE),
    };
  }

  /** One section, with how much of its content is still renderable. */
  async detail(input: { accessToken: string; sectionId: string }): Promise<HomepageSectionDetail> {
    const staff = await this.#reader(input.accessToken);

    let row: HomepageSectionDetailDbRow | null;
    try {
      row = await this.store.homepageSectionForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        sectionId: input.sectionId,
      });
    } catch (error) {
      this.logger.error('The homepage section could not be read.');
      throw new HomepageUnavailableError(error);
    }

    // No row covers both a section that does not exist and a caller without the read key.
    if (row === null) throw new HomepageNotFoundError();

    return {
      id: row.sectionId,
      sectionKey: row.sectionKey,
      sectionType: row.sectionType as HomepageSectionType,
      titleEn: row.titleEn,
      titleAr: row.titleAr,
      subtitleEn: row.subtitleEn,
      subtitleAr: row.subtitleAr,
      config: row.config,
      sortOrder: toNumber(row.sortOrder),
      isActive: row.isActive,
      isServed: row.isServed,
      isConfigured: homepageConfigIsValid(row.sectionType, row.config),
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
      canManage: row.canManage,
      chosenCount: toNumber(row.chosenCount),
      renderableCount: toNumber(row.renderableCount),
    };
  }

  /** Creates a hidden section. */
  async create(input: {
    accessToken: string;
    sectionKey: string;
    sectionType: string;
    titleEn: string | null;
    titleAr: string | null;
    subtitleEn: string | null;
    subtitleAr: string | null;
    config: unknown;
    sortOrder: number | null;
  }): Promise<string> {
    const staff = await this.#reader(input.accessToken);
    const id = await this.#write(async () =>
      this.store.homepageSectionSaveForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        sectionId: null,
        sectionKey: input.sectionKey,
        sectionType: input.sectionType,
        titleEn: input.titleEn,
        titleAr: input.titleAr,
        subtitleEn: input.subtitleEn,
        subtitleAr: input.subtitleAr,
        config: input.config,
        sortOrder: input.sortOrder,
      }),
    );
    if (id === null) throw new HomepageUnavailableError();
    return id;
  }

  /** Changes a section. Never its visibility: that is the next call. */
  async update(input: {
    accessToken: string;
    sectionId: string;
    sectionKey: string | null;
    sectionType: string | null;
    titleEn: string | null;
    titleAr: string | null;
    subtitleEn: string | null;
    subtitleAr: string | null;
    config: unknown;
    sortOrder: number | null;
  }): Promise<void> {
    const staff = await this.#reader(input.accessToken);
    const id = await this.#write(async () =>
      this.store.homepageSectionSaveForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        sectionId: input.sectionId,
        sectionKey: input.sectionKey,
        sectionType: input.sectionType,
        titleEn: input.titleEn,
        titleAr: input.titleAr,
        subtitleEn: input.subtitleEn,
        subtitleAr: input.subtitleAr,
        config: input.config,
        sortOrder: input.sortOrder,
      }),
    );
    // Null means the identifier named nothing. The writer does not create one in that case.
    if (id === null) throw new HomepageNotFoundError();
  }

  /** Shows or hides one section. The only call that can put one in front of the public. */
  async setState(input: { accessToken: string; sectionId: string; isActive: boolean }): Promise<void> {
    const staff = await this.#reader(input.accessToken);
    const changed = await this.#write(async () =>
      this.store.homepageSectionStateForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        sectionId: input.sectionId,
        isActive: input.isActive,
      }),
    );
    if (!changed) throw new HomepageNotFoundError();
  }

  /** Sets the order of the sections named. */
  async reorder(input: { accessToken: string; sectionIds: readonly string[] }): Promise<void> {
    const staff = await this.#reader(input.accessToken);
    await this.#write(async () =>
      this.store.homepageSectionsReorderForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        sectionIds: input.sectionIds,
      }),
    );
    // Deliberately not an error when nothing moved: an order that named only sections somebody else has since
    // deleted is a stale screen, and the remedy is to reload — not a refusal the console has to explain.
  }

  /** Removes one section. */
  async remove(input: { accessToken: string; sectionId: string }): Promise<void> {
    const staff = await this.#reader(input.accessToken);
    const deleted = await this.#write(async () =>
      this.store.homepageSectionDeleteForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        sectionId: input.sectionId,
      }),
    );
    if (!deleted) throw new HomepageNotFoundError();
  }

  /**
   * Runs a write and sorts its failures.
   *
   * `42501` is the database refusing a caller who does not hold `cms.homepage.manage`. It becomes a 404 rather
   * than a 403: a caller may hold the read key and not the manage key, and the list already reports which through
   * `canManage`. Turning it into an absence keeps this surface's one rule — a refusal and an absence look alike.
   */
  async #write<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      const sqlstate = sqlstateOf(error);
      if (sqlstate === '42501') throw new HomepageNotFoundError();
      const refusal = sqlstate === null ? undefined : REFUSALS.get(sqlstate);
      if (refusal !== undefined) throw new HomepageRefusedError(refusal.code, refusal.detail);
      this.logger.error('A homepage section could not be written.');
      throw new HomepageUnavailableError(error);
    }
  }

  async #reader(accessToken: string): Promise<{ id: string; isAal2: boolean }> {
    const session = await this.console.forToken(accessToken);
    if (!session.permissions.includes(HOMEPAGE_READ)) throw new HomepageNotFoundError();
    return { id: session.id, isAal2: isAal2(accessToken) };
  }
}
