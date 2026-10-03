import { Inject, Injectable, Logger } from '@nestjs/common';
import type { SeoSettingsLocale, SeoSettingsResponse } from '@repo/contracts';
import { isAal2 } from '../auth/access-token-claims.js';
import { StaffConsoleService } from './staff-console.service.js';
import type { SeoSettingsRefusalCode } from './seo-settings.errors.js';
import {
  SeoSettingsNotFoundError,
  SeoSettingsRefusedError,
  SeoSettingsUnavailableError,
} from './seo-settings.errors.js';

/**
 * Authoring the site-wide SEO defaults (0096).
 *
 * **Authorization, in the one order it is ever done**, which is this console's and is not varied:
 *
 *   1. The **provider** validates the caller's access token and says whose it is.
 *   2. The **assurance level** is read from that same, now-vouched-for token.
 *   3. The **database** reports the caller's *effective* permissions under the platform's own `requires_mfa` rule.
 *      Both roles that hold this key require MFA, so staff at `aal1` hold nothing at all.
 *   4. Every `app_private` function below **re-applies the same test itself**, with the account and the assurance
 *      level as parameters and the key as a **literal**. No bug in this file can turn into somebody rewriting what
 *      `/robots.txt` tells a crawler.
 *
 * **One key, and that is owner decision 6.** 0033 seeds `seo.settings.manage` and no `seo.settings.read`, and none
 * is invented here. So whoever can reach this surface may change it, which is why `canManage` is reported as true
 * for anyone who gets an answer at all: there is no second capability for it to distinguish, and inventing a key
 * to report would be inventing a permission.
 *
 * **Every rule this surface appears to apply is applied in the database.** The 1–120 site name, the 70-character
 * default title, the 320-character default description, the handle's format and the organization document being a
 * JSON object are 0030's five constraints. Whether a locale may be authored at all is the writer's own test against
 * `locales.is_active`. Whether a locale's robots body is the one served is computed by the reader from
 * `locales.is_default` — the very column `app_private.public_robots_body()` filters on, so the two cannot disagree.
 * This service passes the caller's account, shapes the answer, and **checks nothing a second time**.
 *
 * **Nothing here is read by a public surface.** The site name does not feed the header or any page title; the
 * default title and description feed no metadata resolver; the handle emits no Twitter metadata; the organization
 * document emits no JSON-LD. `robotsTxtBody` is the one column with a reader, and that reader is 0086's — this file
 * does not call it, wrap it or change it.
 *
 * **Nothing here reads `site_settings`, a promotion, a placement or anything financial.**
 */

export const SEO_SETTINGS_MANAGE = 'seo.settings.manage';

export const SEO_SETTINGS_STORE = Symbol('SEO_SETTINGS_STORE');

/** One row of `app_private.seo_settings_for_staff` (0096). */
export interface SeoSettingsDbRow {
  readonly localeCode: string;
  readonly localeNameEn: string;
  readonly localeNameNative: string;
  readonly isDefaultLocale: boolean;
  readonly isAuthored: boolean;
  readonly robotsIsServed: boolean;
  readonly siteName: string | null;
  readonly defaultMetaTitle: string | null;
  readonly defaultMetaDescription: string | null;
  readonly defaultShareMediaId: string | null;
  readonly shareMediaObjectPath: string | null;
  readonly twitterSite: string | null;
  readonly robotsTxtBody: string | null;
  readonly organizationStructuredData: unknown;
  readonly updatedAt: Date | string | null;
}

export interface SeoSettingsStore {
  seoSettingsForStaff(input: { userId: string; isAal2: boolean }): Promise<readonly SeoSettingsDbRow[]>;

  seoSettingsSaveForStaff(input: {
    userId: string;
    isAal2: boolean;
    localeCode: string;
    siteName: string;
    defaultMetaTitle: string | null;
    defaultMetaDescription: string | null;
    defaultShareMediaId: string | null;
    twitterSite: string | null;
    robotsTxtBody: string | null;
    organizationStructuredData: unknown;
  }): Promise<boolean>;

  seoSettingsDeleteForStaff(input: {
    userId: string;
    isAal2: boolean;
    localeCode: string;
  }): Promise<boolean>;
}

/**
 * The SQLSTATEs a refused write arrives as, each with **our own** code and sentence.
 *
 * The database's text is deliberately not forwarded: a PostgreSQL constraint message is a different kind of value
 * from an API response, and mapping the five characters to a code we control means a change to a constraint's
 * wording cannot change what a browser is shown.
 */
const REFUSALS: ReadonlyMap<string, { readonly code: SeoSettingsRefusalCode; readonly detail: string }> = new Map([
  [
    '23514',
    {
      code: 'SEO_SETTINGS_NOT_ALLOWED' as const,
      detail: 'That is not an allowed value for a site-wide SEO setting.',
    },
  ],
  [
    '23503',
    {
      code: 'SEO_SETTINGS_MEDIA_MISSING' as const,
      detail: 'The share image named does not exist.',
    },
  ],
]);

function sqlstateOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** A stored `jsonb` object, or null when the locale is unauthored. Never a scalar: 0030's constraint sees to that. */
function structuredDataOf(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

@Injectable()
export class SeoSettingsAdminService {
  private readonly logger = new Logger(SeoSettingsAdminService.name);

  constructor(
    @Inject(SEO_SETTINGS_STORE) private readonly store: SeoSettingsStore,
    private readonly console: StaffConsoleService,
  ) {}

  /** Every active locale, default locale first, authored or not. */
  async list(input: { accessToken: string }): Promise<SeoSettingsResponse> {
    const staff = await this.#operator(input.accessToken);

    let rows: readonly SeoSettingsDbRow[];
    try {
      rows = await this.store.seoSettingsForStaff({ userId: staff.id, isAal2: staff.isAal2 });
    } catch (error) {
      this.logger.error('The site-wide SEO settings could not be read.');
      throw new SeoSettingsUnavailableError(error);
    }

    return {
      locales: rows.map(
        (row): SeoSettingsLocale => ({
          localeCode: row.localeCode,
          nameEn: row.localeNameEn,
          nameNative: row.localeNameNative,
          isDefaultLocale: row.isDefaultLocale,
          isAuthored: row.isAuthored,
          // The database's own answer, from the column 0086's reader filters on. Not recomputed here.
          robotsIsServed: row.robotsIsServed,
          siteName: row.siteName,
          defaultMetaTitle: row.defaultMetaTitle,
          defaultMetaDescription: row.defaultMetaDescription,
          defaultShareMediaId: row.defaultShareMediaId,
          shareMediaObjectPath: row.shareMediaObjectPath,
          twitterSite: row.twitterSite,
          robotsTxtBody: row.robotsTxtBody,
          organizationStructuredData: structuredDataOf(row.organizationStructuredData),
          updatedAt: toIso(row.updatedAt),
        }),
      ),
      // One key: a caller who reached this line holds it, so there is no second capability to report.
      canManage: true,
    };
  }

  /** Writes one locale's settings. Creating and replacing are the same call. */
  async save(input: {
    accessToken: string;
    localeCode: string;
    siteName: string;
    defaultMetaTitle: string | null;
    defaultMetaDescription: string | null;
    defaultShareMediaId: string | null;
    twitterSite: string | null;
    robotsTxtBody: string | null;
    organizationStructuredData: unknown;
  }): Promise<void> {
    const staff = await this.#operator(input.accessToken);
    const written = await this.#write(async () =>
      this.store.seoSettingsSaveForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        localeCode: input.localeCode,
        siteName: input.siteName,
        defaultMetaTitle: input.defaultMetaTitle,
        defaultMetaDescription: input.defaultMetaDescription,
        defaultShareMediaId: input.defaultShareMediaId,
        twitterSite: input.twitterSite,
        robotsTxtBody: input.robotsTxtBody,
        organizationStructuredData: input.organizationStructuredData,
      }),
    );
    // False means the locale is not an active locale. An absence, because that is what it is: this surface offers
    // the active locales and nothing else.
    if (!written) throw new SeoSettingsNotFoundError();
  }

  /** Removes one locale's settings, returning it to unauthored. */
  async remove(input: { accessToken: string; localeCode: string }): Promise<void> {
    const staff = await this.#operator(input.accessToken);
    const deleted = await this.#write(async () =>
      this.store.seoSettingsDeleteForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        localeCode: input.localeCode,
      }),
    );
    if (!deleted) throw new SeoSettingsNotFoundError();
  }

  /**
   * Runs a write and sorts its failures.
   *
   * `42501` is the database refusing a caller who does not hold `seo.settings.manage`. It becomes a 404 rather than
   * a 403, which keeps this surface's one rule: a refusal and an absence look alike. On a single-key surface it can
   * only be reached by a caller whose session changed between the check above and the write, which is exactly the
   * case where saying nothing is right.
   */
  async #write<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      const sqlstate = sqlstateOf(error);
      if (sqlstate === '42501') throw new SeoSettingsNotFoundError();
      const refusal = sqlstate === null ? undefined : REFUSALS.get(sqlstate);
      if (refusal !== undefined) throw new SeoSettingsRefusedError(refusal.code, refusal.detail);
      this.logger.error('The site-wide SEO settings could not be written.');
      throw new SeoSettingsUnavailableError(error);
    }
  }

  async #operator(accessToken: string): Promise<{ id: string; isAal2: boolean }> {
    const session = await this.console.forToken(accessToken);
    if (!session.permissions.includes(SEO_SETTINGS_MANAGE)) throw new SeoSettingsNotFoundError();
    return { id: session.id, isAal2: isAal2(accessToken) };
  }
}
