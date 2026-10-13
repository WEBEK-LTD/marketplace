import { z } from './zod.js';

/**
 * Site settings — the console's path to `public.site_settings` (0113).
 *
 * **A setting is edited, never created.** `public.site_settings` has carried a key, a category, a declared
 * value type and an `is_public` flag since 0008, and every one of those is a decision made in a migration where
 * it can be reviewed. This surface therefore offers exactly one verb — write the value of a setting that
 * already exists — and the database's own writer refuses an unknown key. A console that could mint a setting
 * could mint a *public* setting, which would make `is_public` a text box rather than a reviewed decision.
 *
 * **The value is typed by the setting, not by the request.** `value_type` is stored on the row; the request
 * carries a JSON value and the database checks it against that type, exactly as 0008's own
 * `site_settings_value_matches_type` does. So the contract below accepts a JSON value rather than four
 * alternative fields, and a mismatch is a refusal with a code rather than a shape nobody declared.
 *
 * **One key gates read and write alike.** `settings.site.manage` is seeded by 0033 and 0033 seeds no
 * `settings.site.read`, so whoever can reach this surface may change it. No key is invented here.
 *
 * **A category is the unit.** The console edits a screen's worth of settings at a time and reading every
 * setting on the platform to render one screen is how a settings page becomes a place nobody can find
 * anything.
 */

/** The category format `site_settings_category_format` enforces, restated so a bad one is a 400 and not a 500. */
export const SITE_SETTINGS_CATEGORY_PATTERN = /^[a-z][a-z0-9_]*$/;

/** The key format `site_settings_key_format` enforces: a dotted path of at least two segments. */
export const SITE_SETTINGS_KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

export const SiteSettingsCategorySchema = z.string().regex(SITE_SETTINGS_CATEGORY_PATTERN).max(64);
export const SiteSettingKeySchema = z.string().regex(SITE_SETTINGS_KEY_PATTERN).max(120);

/** The four types 0008 declares. The console renders a control per type and sends a value of that type. */
export const SITE_SETTING_VALUE_TYPES = ['string', 'number', 'boolean', 'json'] as const;
export type SiteSettingValueType = (typeof SITE_SETTING_VALUE_TYPES)[number];
export const SiteSettingValueTypeSchema = z.enum(SITE_SETTING_VALUE_TYPES);

/**
 * One setting, as the console sees it.
 *
 * `description` is the row's own, in the console reader's language, so the screen explains each field without a
 * second catalogue of copy that would have to be kept in step with the migrations.
 *
 * `isPublic` is reported and is **not editable**. It is shown because an operator typing into a field should
 * know whether what they type will appear on the public site, and it is read-only because changing it changes
 * what the public reader will serve.
 */
export const SiteSettingSchema = z
  .object({
    key: SiteSettingKeySchema,
    category: SiteSettingsCategorySchema,
    /** Whatever the setting holds. Its shape is `valueType`'s business and the database's. */
    value: z.unknown(),
    valueType: SiteSettingValueTypeSchema,
    isPublic: z.boolean(),
    descriptionEn: z.string().min(1),
    descriptionAr: z.string().min(1),
    updatedAt: z.string().nullable(),
  })
  .strict();
export type SiteSetting = z.infer<typeof SiteSettingSchema>;

export const SiteSettingsResponseSchema = z
  .object({
    category: SiteSettingsCategorySchema,
    settings: z.array(SiteSettingSchema),
    /**
     * Always true for a caller who received an answer at all: one key gates both reading and writing, so there
     * is no second capability to report. Present so the console does not have to assume it.
     */
    canManage: z.boolean(),
  })
  .strict();
export type SiteSettingsResponse = z.infer<typeof SiteSettingsResponseSchema>;

/**
 * Writing one setting's value.
 *
 * The key is in the address and the value is the whole body, because the value is the whole resource. There is
 * no partial update of a setting: a setting is one value.
 */
export const SaveSiteSettingRequestSchema = z
  .object({
    /** `z.unknown()` would make the field optional; `z.any()` keeps "present and null" distinguishable. */
    value: z.any(),
  })
  .strict();
export type SaveSiteSettingRequest = z.infer<typeof SaveSiteSettingRequestSchema>;

export const SiteSettingsWriteResponseSchema = z.object({ ok: z.literal(true) }).strict();
export type SiteSettingsWriteResponse = z.infer<typeof SiteSettingsWriteResponseSchema>;
