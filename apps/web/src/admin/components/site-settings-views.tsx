import { headers } from 'next/headers';
import { getLocale, getTranslations } from 'next-intl/server';
import { readSiteSettings, type SiteSettingsResult } from '../server/bff';
import { SiteSettingForm, type SiteSettingFormCopy } from './site-settings-forms';
import { ADMIN_PANEL, ADMIN_PANEL_SPACE, ADMIN_WELL } from '../ui';

/**
 * The office's own settings (0113).
 *
 * **Everything renders inside the page's `RequireStaff` gate**, so a colleague who may not open this section
 * receives a refusal and no data.
 *
 * **The description beside each field is the database's own**, in the console reader's language. The rows carry
 * `description_en` and `description_ar` because 0008 requires both, and reading them here rather than keeping a
 * parallel catalogue of console copy is what stops the screen explaining a setting differently from the
 * migration that created it.
 *
 * **The label is the key's last segment, tidied** — `office.address_ar` reads as "Address ar" — and the
 * description does the explaining. That is deliberate rather than lazy: a second per-key catalogue of labels
 * would be a list somebody has to extend every time a migration adds a setting, and the one that got forgotten
 * would render a blank label. The description is required by the schema, so it cannot be forgotten.
 *
 * **There are no controls to hide.** This surface has one key, so a colleague who can see a field can change
 * it, and `canManage` is reported by the API all the same rather than inferred from a role.
 */

async function cookieHeader(): Promise<string | null> {
  return (await headers()).get('cookie');
}

/** One message for every answer that is not data. */
async function problem<T>(result: SiteSettingsResult<T>): Promise<string | null> {
  const t = await getTranslations('SiteSettings');
  if (result.kind === 'ok') return null;
  if (result.kind === 'unauthenticated') return t('sessionExpired');
  if (result.kind === 'notFound') return t('notFoundBody');
  return t('unavailable');
}

/**
 * `office.address_ar` → `Address ar`.
 *
 * The category prefix is dropped because the screen is already the category, and the remainder is read as
 * words. No per-key catalogue: see the component note above for why.
 */
function labelFor(key: string): string {
  const last = key.split('.').slice(1).join(' ') || key;
  const words = last.replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export async function OfficeSettingsPanel() {
  const t = await getTranslations('SiteSettings');
  const locale = await getLocale();
  const result = await readSiteSettings('office', { cookieHeader: await cookieHeader() });
  const message = await problem(result);

  if (result.kind !== 'ok') {
    return (
      <div className={`mt-6 ${ADMIN_WELL}`} role="status">
        <p className="text-sm text-ink-strong">{message}</p>
      </div>
    );
  }

  const copy: SiteSettingFormCopy = {
    save: t('save'),
    saving: t('saving'),
    saved: t('saved'),
    publicBadge: t('publicBadge'),
    privateBadge: t('privateBadge'),
    booleanOn: t('booleanOn'),
    invalidJson: t('invalidJson'),
    refused: t('refused'),
    notFound: t('notFoundBody'),
    sessionExpired: t('sessionExpired'),
    unavailable: t('unavailable'),
  };

  if (result.data.settings.length === 0) {
    return (
      <div className={`mt-6 ${ADMIN_WELL}`} role="status">
        <p className="text-sm text-ink-strong">{t('empty')}</p>
      </div>
    );
  }

  return (
    <section className={`mt-6 ${ADMIN_PANEL} ${ADMIN_PANEL_SPACE}`}>
      <h2 className="text-lg font-semibold text-ink-strong">{t('officeHeading')}</h2>
      <p className="mt-1 max-w-prose text-sm text-ink-muted">{t('officeIntro')}</p>
      <div className="mt-5">
        {result.data.settings.map((setting) => (
          <SiteSettingForm
            key={setting.key}
            /*
              Narrowed rather than passed whole. The form is a client component, so every field crosses into
              the browser's flight payload — and a `SiteSetting` carries both languages' descriptions and an
              `updatedAt` the form never renders. The description is chosen here and sent once.
            */
            setting={{
              key: setting.key,
              category: setting.category,
              value: setting.value,
              valueType: setting.valueType,
              isPublic: setting.isPublic,
            }}
            label={labelFor(setting.key)}
            description={locale === 'ar' ? setting.descriptionAr : setting.descriptionEn}
            copy={copy}
          />
        ))}
      </div>
    </section>
  );
}
