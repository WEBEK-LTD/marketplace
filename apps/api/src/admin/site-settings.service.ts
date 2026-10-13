import { Inject, Injectable, Logger } from '@nestjs/common';
import type { SiteSetting, SiteSettingValueType, SiteSettingsResponse } from '@repo/contracts';
import { SITE_SETTING_VALUE_TYPES } from '@repo/contracts';
import { isAal2 } from '../auth/access-token-claims.js';
import { StaffConsoleService } from './staff-console.service.js';
import {
  SiteSettingsNotFoundError,
  SiteSettingsRefusedError,
  SiteSettingsUnavailableError,
} from './site-settings.errors.js';

/**
 * Editing the platform's own settings (0113).
 *
 * **Authorization, in the one order this console ever does it:**
 *
 *   1. The **provider** validates the caller's access token and says whose it is.
 *   2. The **assurance level** is read from that same, now-vouched-for token.
 *   3. The **database** reports the caller's *effective* permissions under the platform's `requires_mfa` rule.
 *   4. Every `app_private` function below **re-applies the same test itself**, with the account and the
 *      assurance level as parameters and the key as a **literal**. No bug in this file can turn into somebody
 *      changing what the public site says.
 *
 * **One key, and it is 0033's.** `settings.site.manage` is seeded; `settings.site.read` is not and is not
 * invented. So whoever can reach this surface may change it, which is why `canManage` is reported as true for
 * anyone who gets an answer at all.
 *
 * **This service creates nothing and deletes nothing.** The only write it can make is the value of a setting
 * that already exists, because a key, its category, its declared type and its `is_public` flag are migration
 * decisions. The database's writer enforces that independently; this file does not have the option.
 *
 * **Nothing here reads a promotion, a placement, a balance or anything financial**, and nothing here touches
 * the settings that govern them: the caller names a category and gets that category.
 */

export const SITE_SETTINGS_MANAGE = 'settings.site.manage';

export const SITE_SETTINGS_STORE = Symbol('SITE_SETTINGS_STORE');

/** One row of `app_private.site_settings_for_staff` (0113). */
export interface SiteSettingDbRow {
  readonly key: string;
  readonly category: string;
  readonly value: unknown;
  readonly valueType: string;
  readonly isPublic: boolean;
  readonly descriptionEn: string;
  readonly descriptionAr: string;
  readonly updatedAt: Date | string | null;
}

export interface SiteSettingsStore {
  siteSettingsForStaff(input: {
    userId: string;
    isAal2: boolean;
    category: string;
  }): Promise<readonly SiteSettingDbRow[]>;

  siteSettingSaveForStaff(input: {
    userId: string;
    isAal2: boolean;
    key: string;
    value: unknown;
  }): Promise<boolean>;
}

function sqlstateOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * The row's declared type, or `json` when the database somehow holds one this API does not know.
 *
 * It cannot: 0008's `site_settings_value_type_allowed` lists exactly these four. Narrowing it here rather than
 * casting is what keeps that true of the response as well as of the column.
 */
function valueTypeOf(raw: string): SiteSettingValueType {
  return (SITE_SETTING_VALUE_TYPES as readonly string[]).includes(raw) ? (raw as SiteSettingValueType) : 'json';
}

@Injectable()
export class SiteSettingsAdminService {
  private readonly logger = new Logger(SiteSettingsAdminService.name);

  constructor(
    @Inject(SITE_SETTINGS_STORE) private readonly store: SiteSettingsStore,
    private readonly console: StaffConsoleService,
  ) {}

  /** One category's settings, in key order. */
  async list(input: { accessToken: string; category: string }): Promise<SiteSettingsResponse> {
    const staff = await this.#operator(input.accessToken);

    let rows: readonly SiteSettingDbRow[];
    try {
      rows = await this.store.siteSettingsForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        category: input.category,
      });
    } catch (error) {
      this.logger.error('The site settings could not be read.');
      throw new SiteSettingsUnavailableError(error);
    }

    return {
      category: input.category,
      settings: rows.map(
        (row): SiteSetting => ({
          key: row.key,
          category: row.category,
          value: row.value,
          valueType: valueTypeOf(row.valueType),
          isPublic: row.isPublic,
          descriptionEn: row.descriptionEn,
          descriptionAr: row.descriptionAr,
          updatedAt: toIso(row.updatedAt),
        }),
      ),
      // One key: a caller who reached this line holds it, so there is no second capability to report.
      canManage: true,
    };
  }

  /**
   * Writes one setting's value.
   *
   * The **category travels with the key**, and it is not derived from it. A key's first segment is usually its
   * category and is not always: 0033 seeds `offers.default_expiry_hours` under `marketplace`. Guessing would
   * turn a type refusal into a "not found" for exactly those settings, which is the least helpful answer
   * available. The console has just listed the category, so it knows it, and sending it costs nothing.
   */
  async save(input: { accessToken: string; category: string; key: string; value: unknown }): Promise<void> {
    const staff = await this.#operator(input.accessToken);

    let written: boolean;
    try {
      written = await this.store.siteSettingSaveForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        key: input.key,
        value: input.value,
      });
    } catch (error) {
      const sqlstate = sqlstateOf(error);
      // The database refusing a caller who does not hold the key. A 404 rather than a 403, which keeps this
      // surface's one rule: a refusal and an absence look alike. On a single-key surface it can only be
      // reached by a caller whose session changed between the check above and the write.
      if (sqlstate === '42501') throw new SiteSettingsNotFoundError();
      if (sqlstate === '23514') {
        throw new SiteSettingsRefusedError('That value is not allowed for this setting.');
      }
      this.logger.error('A site setting could not be written.');
      throw new SiteSettingsUnavailableError(error);
    }

    // **False is two different things, and they are answered differently on purpose.** The writer returns
    // false for an unknown key — an absence, because this surface cannot create one — and for a value whose
    // JSON type disagrees with the setting's. The second is a refusal the caller can act on, so the type is
    // checked here against what the reader already said in order to tell them apart. That costs one read and
    // is worth it: "not found" when the real problem is "you sent a number" is a dead end for an operator.
    if (!written) {
      const known = await this.#declaredType(staff, input.category, input.key);
      if (known === null) throw new SiteSettingsNotFoundError();
      throw new SiteSettingsRefusedError(`This setting holds a ${known} value.`);
    }
  }

  /** The declared type of one setting, or null when the caller cannot see a setting by that key. */
  async #declaredType(
    staff: { id: string; isAal2: boolean },
    category: string,
    key: string,
  ): Promise<SiteSettingValueType | null> {
    try {
      const rows = await this.store.siteSettingsForStaff({
        userId: staff.id,
        isAal2: staff.isAal2,
        category,
      });
      const row = rows.find((candidate) => candidate.key === key);
      return row === undefined ? null : valueTypeOf(row.valueType);
    } catch {
      // The write already failed; failing to explain why is not worth a second error class.
      return null;
    }
  }

  async #operator(accessToken: string): Promise<{ id: string; isAal2: boolean }> {
    const session = await this.console.forToken(accessToken);
    if (!session.permissions.includes(SITE_SETTINGS_MANAGE)) throw new SiteSettingsNotFoundError();
    return { id: session.id, isAal2: isAal2(accessToken) };
  }
}
