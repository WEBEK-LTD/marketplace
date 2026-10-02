import { Inject, Injectable, Logger } from '@nestjs/common';
import type { RedirectStatusCode, SeoRedirect, SeoRedirectDetail } from '@repo/contracts';
import { isAal2 } from '../auth/access-token-claims.js';
import { StaffConsoleService } from './staff-console.service.js';
import type { SeoRedirectRefusalCode } from './seo-redirects.errors.js';
import {
  SeoRedirectCursorInvalidError,
  SeoRedirectNotFoundError,
  SeoRedirectRefusedError,
  SeoRedirectUnavailableError,
} from './seo-redirects.errors.js';
import { decodeSeoRedirectCursor, encodeSeoRedirectCursor } from './seo-redirects.cursor.js';

/**
 * Maintaining the SEO redirect map.
 *
 * **Authorization, in the one order it is ever done**, which is this console's and is not varied:
 *
 *   1. The **provider** validates the caller's access token and says whose it is.
 *   2. The **assurance level** is read from that same, now-vouched-for token. Reading a claim first would be
 *      reading an attacker's JSON.
 *   3. The **database** reports the caller's *effective* permissions under the platform's own `requires_mfa`
 *      rule. Both roles that hold a redirect key — `admin` and `super_admin` — require MFA, so staff at `aal1`
 *      hold nothing at all; asking whether the effective set contains the key is therefore the AAL2 check and the
 *      permission check at once.
 *   4. Every `app_private` function below **re-applies the same test itself**, with the account and the assurance
 *      level as parameters and the key as a **literal**. No bug in this file can turn into somebody rewriting
 *      where the site's addresses point.
 *
 * **Two keys, and the separation between them is visible to the console.** `seo.redirect.read` opens the section
 * and every read; `seo.redirect.manage` is required by every write, and the detail reports whether this caller
 * holds it so a console renders its controls from the answer rather than from a role name. No role name is
 * checked anywhere in this file.
 *
 * **Every rule this surface appears to apply is applied in the database.** That both sides are relative paths,
 * that neither may leave the site, that an entry may not point at itself, that one address names one redirect,
 * which status codes exist, and how a chain is followed are all migration 0030. This service passes the caller's
 * account, shapes the answer, and **checks nothing a second time**.
 *
 * **It knows nothing about LIVE PAGE WINS.** That precedence is the public web's, decided in its own request path
 * before the map is consulted at all. An operator here is editing instructions about addresses, not deciding
 * which addresses are live.
 */

export const SEO_REDIRECT_READ = 'seo.redirect.read';
export const SEO_REDIRECT_MANAGE = 'seo.redirect.manage';

export const SEO_REDIRECTS_STORE = Symbol('SEO_REDIRECTS_STORE');

/* ------------------------------------------------------------------------------------------------ */
/* The rows each function returns                                                                    */
/* ------------------------------------------------------------------------------------------------ */

/** One row of `app_private.redirects_for_staff` (0090). */
export interface SeoRedirectListDbRow {
  readonly redirectId: string;
  readonly fromPath: string;
  readonly toPath: string;
  readonly statusCode: number | string;
  readonly isActive: boolean;
  readonly note: string | null;
  readonly createdAt: Date | string;
  readonly updatedAt: Date | string;
}

/** One row of `app_private.redirect_for_staff` (0090). */
export interface SeoRedirectDetailDbRow extends SeoRedirectListDbRow {
  readonly createdBy: string | null;
  readonly canManage: boolean;
  readonly resolvedToPath: string | null;
  readonly resolvedStatusCode: number | string | null;
}

/** The database operations this service needs. Every one is a named definer function from 0090. */
export interface SeoRedirectsStore {
  redirectsForStaff(input: {
    userId: string;
    isAal2: boolean;
    limit: number;
    search: string | null;
    isActive: boolean | null;
    cursorUpdatedAt: Date | null;
    cursorId: string | null;
  }): Promise<readonly SeoRedirectListDbRow[]>;

  redirectForStaff(input: {
    userId: string;
    isAal2: boolean;
    redirectId: string;
  }): Promise<SeoRedirectDetailDbRow | null>;

  redirectCreateForStaff(input: {
    userId: string;
    isAal2: boolean;
    fromPath: string;
    toPath: string;
    statusCode: number;
    note: string | null;
    isActive: boolean;
  }): Promise<string>;

  redirectUpdateForStaff(input: {
    userId: string;
    isAal2: boolean;
    redirectId: string;
    fromPath: string | null;
    toPath: string | null;
    statusCode: number | null;
    note: string | null;
  }): Promise<boolean>;

  redirectStateForStaff(input: {
    userId: string;
    isAal2: boolean;
    redirectId: string;
    isActive: boolean;
  }): Promise<boolean>;

  redirectDeleteForStaff(input: {
    userId: string;
    isAal2: boolean;
    redirectId: string;
  }): Promise<boolean>;
}

export interface SeoRedirectPage {
  readonly items: readonly SeoRedirect[];
  readonly nextCursor: string | null;
}

/**
 * The SQLSTATEs a refused write arrives as, each with **our own** code and sentence.
 *
 * The database's text is deliberately not forwarded, exactly as on the other admin surfaces: 0030's constraint
 * messages happen to be safe, but a PostgreSQL message is a different kind of value from an API response, and
 * mapping the five characters to a code we control means a change to a constraint's wording cannot change what a
 * browser is shown.
 *
 * **`23502` is deliberately absent.** A not-null violation would mean the request reached the database without a
 * field the contract requires, which is a failure of this service rather than of the caller, so it takes the 503
 * path with everything else unexpected.
 */
const REFUSALS: ReadonlyMap<string, { readonly code: SeoRedirectRefusalCode; readonly detail: string }> = new Map([
  // unique_violation — another entry already names that from_path. One address names one redirect.
  [
    '23505',
    {
      code: 'SEO_REDIRECT_PATH_TAKEN' as const,
      detail: 'Another redirect already starts from that address.',
    },
  ],
  // check_violation — a path that is not relative, a destination that would leave the site, an entry pointing at
  // itself, or a status code outside 0030's four.
  [
    '23514',
    {
      code: 'SEO_REDIRECT_NOT_ALLOWED' as const,
      detail: 'That is not an allowed redirect: both addresses must be paths on this site, they must differ, and the status code must be 301, 302, 307 or 308.',
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
export class SeoRedirectsAdminService {
  private readonly logger = new Logger(SeoRedirectsAdminService.name);

  constructor(
    @Inject(SEO_REDIRECTS_STORE) private readonly store: SeoRedirectsStore,
    private readonly console: StaffConsoleService,
  ) {}

  /** One page of the map, newest edit first. */
  async list(input: {
    accessToken: string;
    limit: number;
    search: string | null;
    isActive: boolean | null;
    cursor: string | null;
  }): Promise<SeoRedirectPage> {
    const staff = await this.#reader(input.accessToken);

    let position: { updatedAt: Date; id: string } | null = null;
    if (input.cursor !== null) {
      position = decodeSeoRedirectCursor(input.cursor);
      // One refusal for malformed, altered and outdated — including a position from any other list on this
      // platform, whose rows sit behind different keys entirely.
      if (position === null) throw new SeoRedirectCursorInvalidError();
    }

    let rows: readonly SeoRedirectListDbRow[];
    try {
      rows = await this.store.redirectsForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        limit: input.limit + 1,
        search: input.search,
        isActive: input.isActive,
        cursorUpdatedAt: position?.updatedAt ?? null,
        cursorId: position?.id ?? null,
      });
    } catch (error) {
      this.logger.error('The redirect map could not be read.');
      throw new SeoRedirectUnavailableError(error);
    }

    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    const last = page.at(-1);
    return {
      items: page.map((row) => this.#summary(row)),
      nextCursor:
        hasMore && last !== undefined
          ? encodeSeoRedirectCursor({ updatedAt: new Date(toIso(last.updatedAt)), id: last.redirectId })
          : null,
    };
  }

  /** One entry, with the manage capability and where its chain ends. */
  async detail(input: { accessToken: string; redirectId: string }): Promise<SeoRedirectDetail> {
    const staff = await this.#reader(input.accessToken);

    let row: SeoRedirectDetailDbRow | null;
    try {
      row = await this.store.redirectForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        redirectId: input.redirectId,
      });
    } catch (error) {
      this.logger.error('The redirect could not be read.');
      throw new SeoRedirectUnavailableError(error);
    }

    // No row covers both an entry that does not exist and a caller without the read key. The console cannot tell
    // the two apart, which is the point.
    if (row === null) throw new SeoRedirectNotFoundError();

    return {
      ...this.#summary(row),
      createdBy: row.createdBy,
      canManage: row.canManage,
      resolvedToPath: row.resolvedToPath,
      resolvedStatusCode:
        row.resolvedStatusCode === null ? null : (toNumber(row.resolvedStatusCode) as RedirectStatusCode),
    };
  }

  /** Adds an entry. */
  async create(input: {
    accessToken: string;
    fromPath: string;
    toPath: string;
    statusCode: number;
    note: string | null;
    isActive: boolean;
  }): Promise<string> {
    const staff = await this.#reader(input.accessToken);
    return this.#write(async () =>
      this.store.redirectCreateForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        fromPath: input.fromPath,
        toPath: input.toPath,
        statusCode: input.statusCode,
        note: input.note,
        isActive: input.isActive,
      }),
    );
  }

  /** Changes an entry's paths, status code or note. Never whether it is active. */
  async update(input: {
    accessToken: string;
    redirectId: string;
    fromPath: string | null;
    toPath: string | null;
    statusCode: number | null;
    note: string | null;
  }): Promise<void> {
    const staff = await this.#reader(input.accessToken);
    const changed = await this.#write(async () =>
      this.store.redirectUpdateForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        redirectId: input.redirectId,
        fromPath: input.fromPath,
        toPath: input.toPath,
        statusCode: input.statusCode,
        note: input.note,
      }),
    );
    if (!changed) throw new SeoRedirectNotFoundError();
  }

  /** Switches an entry on or off. */
  async setState(input: { accessToken: string; redirectId: string; isActive: boolean }): Promise<void> {
    const staff = await this.#reader(input.accessToken);
    const changed = await this.#write(async () =>
      this.store.redirectStateForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        redirectId: input.redirectId,
        isActive: input.isActive,
      }),
    );
    if (!changed) throw new SeoRedirectNotFoundError();
  }

  /** Removes an entry. */
  async remove(input: { accessToken: string; redirectId: string }): Promise<void> {
    const staff = await this.#reader(input.accessToken);
    const removed = await this.#write(async () =>
      this.store.redirectDeleteForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        redirectId: input.redirectId,
      }),
    );
    // An entry that was not there is an absence, not a refusal: the database answers false for it and the
    // operator's remedy is the same either way.
    if (!removed) throw new SeoRedirectNotFoundError();
  }

  #summary(row: SeoRedirectListDbRow): SeoRedirect {
    return {
      id: row.redirectId,
      fromPath: row.fromPath,
      toPath: row.toPath,
      statusCode: toNumber(row.statusCode) as RedirectStatusCode,
      isActive: row.isActive,
      note: row.note,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    };
  }

  /**
   * Runs a write and sorts its failures.
   *
   * `42501` is the database refusing a caller who does not hold `seo.redirect.manage`. It becomes a 404 rather
   * than a 403: a caller may hold the read key and not the manage key, and the detail already reports that
   * through `canManage`. Turning it into an absence keeps this surface's one rule — a refusal and an absence look
   * the same.
   *
   * The two refusal SQLSTATEs become a 409 carrying our own code and sentence, because each is a real conflict an
   * operator has to see in order to fix. Anything else is a 503: an unexpected failure is not a user error.
   */
  async #write<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      const sqlstate = sqlstateOf(error);
      if (sqlstate === '42501') throw new SeoRedirectNotFoundError();
      const refusal = sqlstate === null ? undefined : REFUSALS.get(sqlstate);
      if (refusal !== undefined) throw new SeoRedirectRefusedError(refusal.code, refusal.detail);
      this.logger.error('A redirect could not be written.');
      throw new SeoRedirectUnavailableError(error);
    }
  }

  async #reader(accessToken: string): Promise<{ id: string; isAal2: boolean }> {
    const session = await this.console.forToken(accessToken);
    if (!session.permissions.includes(SEO_REDIRECT_READ)) throw new SeoRedirectNotFoundError();
    return { id: session.id, isAal2: isAal2(accessToken) };
  }
}
