import type { Locale } from '@repo/shared-types';
import { Heading, PageContainer } from '@repo/ui';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { AccountError, AccountSkeleton } from '../../../../components/account-views';
import {
  BuyerSettingsForm,
  type SettingsFormLabels,
} from '../../../../components/buyer-account-forms';
import { RequireSession } from '../../../../components/require-session';
import { readBuyerSettings } from '../../../../server/bff';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Settings');
  return { title: t('title'), robots: { index: false, follow: false } };
}

/**
 * Account settings (Phase 7-E).
 *
 * **Exactly the settings the schema defines**, and no others: the four notification channels, the
 * marketing opt-in, and the digit style that overrides the locale default (D15). The free-form
 * `preferences` object is not exposed — it has no approved keys, and offering a person a setting nobody
 * has agreed on would be inventing one.
 *
 * These are the same switches the notification writer already consults before it creates anything, so
 * turning email off here is honoured by that writer rather than by a rule this page invented.
 *
 * **The phone change moved to the security page** in this increment, where a contact change belongs
 * alongside sign-in. This page no longer holds it, and the navigation links to both.
 *
 * The write is a whole state: every switch is sent on every save, because a partial write would need a
 * merge rule and a merge rule is a second place the current state has to be known.
 */
export default async function SettingsPage({
  params,
}: {
  readonly params: Promise<{ readonly locale: Locale }>;
}) {
  const [{ locale }, t] = await Promise.all([params, getTranslations('Settings')]);
  const prefix = locale === 'ar' ? '/ar' : '';

  return (
    <RequireSession>
      <PageContainer>
        <div className="py-12">
          <Heading level={1}>{t('title')}</Heading>
          <p className="mt-2 max-w-prose text-ink-muted">{t('intro')}</p>

          <Suspense fallback={<AccountSkeleton label={t('title')} />}>
            <SettingsSection base={`${prefix}/dashboard/settings`} t={t} />
          </Suspense>
        </div>
      </PageContainer>
    </RequireSession>
  );
}

type Translate = Awaited<ReturnType<typeof getTranslations<'Settings'>>>;

function formLabels(t: Translate): SettingsFormLabels {
  return {
    channelsHeading: t('channelsHeading'),
    channelsIntro: t('channelsIntro'),
    notifyInApp: t('notifyInApp'),
    notifyEmail: t('notifyEmail'),
    notifySms: t('notifySms'),
    notifyWhatsapp: t('notifyWhatsapp'),
    marketingOptIn: t('marketingOptIn'),
    marketingHint: t('marketingHint'),
    displayHeading: t('displayHeading'),
    digitStyle: t('digitStyle'),
    digitStyleDefault: t('digitStyleDefault'),
    digitStyleWestern: t('digitStyleWestern'),
    digitStyleArabicIndic: t('digitStyleArabicIndic'),
    save: t('save'),
    saving: t('saving'),
    saved: t('saved'),
    invalid: t('invalid'),
    missing: t('missing'),
    signedOut: t('signedOut'),
    failed: t('genericFailure'),
  };
}

async function SettingsSection({ base, t }: { readonly base: string; readonly t: Translate }) {
  const requestHeaders = await headers();
  const result = await readBuyerSettings({ cookieHeader: requestHeaders.get('cookie') });

  if (result.kind !== 'ok') {
    return <AccountError title={t('error')} retry={t('retry')} href={base} />;
  }

  const settings = result.data.settings;
  return (
    <BuyerSettingsForm
      labels={formLabels(t)}
      initial={{
        notifyEmail: settings.notifyEmail,
        notifySms: settings.notifySms,
        notifyWhatsapp: settings.notifyWhatsapp,
        notifyInApp: settings.notifyInApp,
        marketingOptIn: settings.marketingOptIn,
        digitStyle: settings.digitStyle ?? '',
      }}
    />
  );
}
