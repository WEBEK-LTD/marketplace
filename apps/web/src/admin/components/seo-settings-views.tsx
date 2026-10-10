import { Heading } from '@repo/ui';
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import type { SeoSettingsLocale } from '@repo/contracts';
import { readSeoSettings, type SeoSettingsResult } from '../server/bff';
import {
  SeoSettingsForm,
  SeoSettingsRemoveForm,
  type SeoSettingsFormCopy,
} from './seo-settings-forms';

/**
 * The site-wide SEO settings section (0096).
 *
 * **Every panel renders inside the page's `RequireStaff` gate**, so a colleague who may not open this section
 * receives a refusal and no data.
 *
 * **One panel per active locale, authored or not.** The database returns a row for each, which is what makes the
 * first save possible: the table ships empty, and a screen that listed only stored rows would have nothing to type
 * into.
 *
 * **Three things an operator could not otherwise work out are said out loud**, because getting any of them wrong is
 * expensive and nothing else on any screen would mention them:
 *
 *   1. **Only the robots body is served.** The site name, the default title and description, the handle and the
 *      organization document are stored and read by nothing today. An operator who typed a site name here and
 *      expected the header to change would be waiting for something that is not going to happen, so the screen says
 *      which of these fields reaches the public and which do not (owner decisions 1–4).
 *   2. **Which locale's robots body is served**, which the database answers and this screen reports rather than
 *      works out. A body authored on any other locale is stored and never served (owner decision 5).
 *   3. **The share image cannot be resolved or displayed**, because the bucket is private and this platform has no
 *      media origin or signing capability. The identifier is shown as text and nothing tries to render it (owner
 *      decision 8).
 *
 * **There are no controls to hide.** This surface has one key, so a colleague who can see a panel can change it, and
 * `canManage` is reported by the API all the same rather than inferred from a role.
 */

const CARD = 'mt-6 rounded-lg border border-hairline bg-surface-raised p-5';

async function cookieHeader(): Promise<string | null> {
  return (await headers()).get('cookie');
}

/** One message for every answer that is not data. */
async function problem<T>(result: SeoSettingsResult<T>): Promise<string | null> {
  const t = await getTranslations('SeoSettings');
  if (result.kind === 'ok') return null;
  if (result.kind === 'unauthenticated') return t('sessionExpired');
  if (result.kind === 'notFound') return t('notFoundBody');
  return t('unavailable');
}

function Message({ tone, title, body }: { tone: 'empty' | 'error' | 'note'; title: string; body: string }) {
  const classes =
    tone === 'error'
      ? 'border-red-200 bg-red-50'
      : tone === 'note'
        ? 'border-amber-200 bg-amber-50'
        : 'border-hairline bg-surface-sunken';
  return (
    <div className={`mt-4 rounded-md border p-4 ${classes}`}>
      <p className="font-medium text-ink-strong">{title}</p>
      <p className="mt-1 text-sm text-ink-body">{body}</p>
    </div>
  );
}

/** A stored JSON object as text an operator can edit, or empty when there is nothing authored. */
function structuredDataText(value: Record<string, unknown> | null): string {
  if (value === null || Object.keys(value).length === 0) return '';
  return JSON.stringify(value, null, 2);
}

export async function SeoSettingsPanels() {
  const t = await getTranslations('SeoSettings');
  const result = await readSeoSettings({ cookieHeader: await cookieHeader() });
  const failure = await problem(result);

  if (failure !== null || result.kind !== 'ok') {
    return (
      <section className={CARD}>
        <Heading level={2}>{t('listHeading')}</Heading>
        <Message tone="error" title={t('unavailableTitle')} body={failure ?? t('unavailable')} />
      </section>
    );
  }

  const { locales } = result.data;

  return (
    <>
      <section className={CARD}>
        <Heading level={2}>{t('whatIsServedTitle')}</Heading>
        {/* Owner decisions 1-4, stated plainly: an operator has to know which of these fields does anything. */}
        <p className="mt-1 text-sm text-ink-body">{t('whatIsServedBody')}</p>
        <Message tone="note" title={t('storedOnlyTitle')} body={t('storedOnlyBody')} />
      </section>

      {locales.length === 0 ? (
        <section className={CARD}>
          <Heading level={2}>{t('listHeading')}</Heading>
          <Message tone="empty" title={t('emptyTitle')} body={t('emptyBody')} />
        </section>
      ) : (
        locales.map((locale) => <LocalePanel key={locale.localeCode} locale={locale} />)
      )}
    </>
  );
}

async function LocalePanel({ locale }: { readonly locale: SeoSettingsLocale }) {
  const t = await getTranslations('SeoSettings');

  const copy: SeoSettingsFormCopy = {
    siteNameLabel: t('siteNameLabel'),
    siteNameHint: t('siteNameHint'),
    defaultMetaTitleLabel: t('defaultMetaTitleLabel'),
    defaultMetaTitleHint: t('defaultMetaTitleHint'),
    defaultMetaDescriptionLabel: t('defaultMetaDescriptionLabel'),
    defaultMetaDescriptionHint: t('defaultMetaDescriptionHint'),
    shareMediaLabel: t('shareMediaLabel'),
    shareMediaHint: t('shareMediaHint'),
    twitterSiteLabel: t('twitterSiteLabel'),
    twitterSiteHint: t('twitterSiteHint'),
    robotsLabel: t('robotsLabel'),
    robotsHint: t('robotsHint'),
    structuredDataLabel: t('structuredDataLabel'),
    structuredDataHint: t('structuredDataHint'),
    submit: t('saveSubmit'),
    replaceWarning: t('replaceWarning'),
    failed: t('saveFailed'),
    invalid: t('invalid'),
    notAllowed: t('notAllowed'),
    mediaMissing: t('mediaMissing'),
    badJson: t('badJson'),
    // Owner decision 5. Built here and omitted entirely for the served locale, so the sentence never travels in a
    // payload it does not apply to.
    ...(locale.robotsIsServed ? {} : { robotsNotServedNotice: t('robotsNotServedNotice') }),
  };

  return (
    <section className={CARD}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Heading level={2}>
          {/*
            The native name is shown beside the English one only when it differs. English is seeded with both names
            identical, so the two-name form would render "English (English)" — which reads as a bug rather than as
            the courtesy to Arabic readers that it is.
          */}
          {locale.nameNative === locale.nameEn
            ? t('localeHeadingSame', { name: locale.nameEn })
            : t('localeHeading', { name: locale.nameEn, native: locale.nameNative })}
        </Heading>
        <p className="text-xs text-ink-muted">
          <code>{locale.localeCode}</code>
          {locale.isDefaultLocale ? ` · ${t('defaultLocaleBadge')}` : ''}
          {locale.isAuthored ? '' : ` · ${t('unauthoredBadge')}`}
        </p>
      </div>

      {/* The database's own answer about which locale reaches a crawler, reported and not recomputed. */}
      <p className="mt-2 text-sm text-ink-body">
        {locale.robotsIsServed ? t('robotsServedHere') : t('robotsServedElsewhere')}
      </p>

      {locale.isAuthored ? null : <Message tone="empty" title={t('unauthoredTitle')} body={t('unauthoredBody')} />}

      {/* Owner decision 8: the stored identifier, said to be unresolvable rather than shown as a broken image. */}
      {locale.defaultShareMediaId === null ? null : (
        <div className="mt-4 rounded-md border border-hairline bg-surface-sunken p-4">
          <p className="font-medium text-ink-strong">{t('shareMediaStoredTitle')}</p>
          <p className="mt-1 break-all font-mono text-xs text-ink-body">{locale.defaultShareMediaId}</p>
          {locale.shareMediaObjectPath === null ? null : (
            <p className="mt-1 break-all font-mono text-xs text-ink-body">{locale.shareMediaObjectPath}</p>
          )}
          <p className="mt-2 text-sm text-ink-body">{t('shareMediaUnresolvableBody')}</p>
        </div>
      )}

      <SeoSettingsForm
        copy={copy}
        values={{
          localeCode: locale.localeCode,
          siteName: locale.siteName ?? '',
          defaultMetaTitle: locale.defaultMetaTitle ?? '',
          defaultMetaDescription: locale.defaultMetaDescription ?? '',
          defaultShareMediaId: locale.defaultShareMediaId ?? '',
          twitterSite: locale.twitterSite ?? '',
          robotsTxtBody: locale.robotsTxtBody ?? '',
          organizationStructuredData: structuredDataText(locale.organizationStructuredData),
        }}
      />

      {locale.isAuthored ? (
        <div className="mt-6 border-t border-hairline pt-4">
          <p className="font-medium text-ink-strong">{t('removeHeading')}</p>
          <p className="mt-1 text-sm text-ink-body">
            {locale.robotsIsServed ? t('removeIntroServed') : t('removeIntro')}
          </p>
          <SeoSettingsRemoveForm
            copy={{ submit: t('remove'), confirm: t('removeConfirm'), failed: t('removeFailed') }}
            localeCode={locale.localeCode}
          />
        </div>
      ) : null}

      {locale.updatedAt === null ? null : (
        <p className="mt-4 text-xs text-ink-muted">{t('lastChanged', { when: locale.updatedAt })}</p>
      )}
    </section>
  );
}
