import type { Locale } from '@repo/shared-types';
import { Heading, PageContainer } from '@repo/ui';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { AccountError, AccountFact, AccountSkeleton } from '../../../../components/account-views';
import {
  BuyerProfileForm,
  type ProfileFormLabels,
} from '../../../../components/buyer-account-forms';
import { RequireSession } from '../../../../components/require-session';
import { readBuyerProfile } from '../../../../server/bff';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Profile');
  return { title: t('title'), robots: { index: false, follow: false } };
}

/**
 * The buyer profile (Phase 7-E).
 *
 * Two halves, and the split is the point.
 *
 * **What a person may edit** is a form of four fields: display name, full name, language and time zone.
 * Those are the four the writer accepts, and the form has no other input — there is no shape in which a
 * phone number, an account status or a role could be sent from here.
 *
 * **What a person may only read** is rendered above it as plain facts: the phone number and whether it
 * is confirmed, whether the email is confirmed, and when the account was created. A number is changed
 * through the verified contact-change flow on the security page, and the sentence under these facts says
 * so and links there rather than offering an input that would not work.
 *
 * Nothing on this page can change what the account is allowed to do.
 */
export default async function ProfilePage({
  params,
}: {
  readonly params: Promise<{ readonly locale: Locale }>;
}) {
  const [{ locale }, t] = await Promise.all([params, getTranslations('Profile')]);
  const prefix = locale === 'ar' ? '/ar' : '';

  return (
    <RequireSession>
      <PageContainer>
        <div className="py-12">
          <Heading level={1}>{t('title')}</Heading>
          <p className="mt-2 max-w-prose text-neutral-600">{t('intro')}</p>

          <Suspense fallback={<AccountSkeleton label={t('title')} />}>
            <ProfileSection base={`${prefix}/dashboard/profile`} securityHref={`${prefix}/dashboard/security`} t={t} />
          </Suspense>
        </div>
      </PageContainer>
    </RequireSession>
  );
}

type Translate = Awaited<ReturnType<typeof getTranslations<'Profile'>>>;

function formLabels(t: Translate): ProfileFormLabels {
  return {
    displayName: t('displayName'),
    displayNameHint: t('displayNameHint'),
    fullName: t('fullName'),
    fullNameHint: t('fullNameHint'),
    language: t('language'),
    languageDefault: t('languageDefault'),
    timezone: t('timezone'),
    timezoneHint: t('timezoneHint'),
    save: t('save'),
    saving: t('saving'),
    saved: t('saved'),
    invalidLanguage: t('invalidLanguage'),
    invalidTimezone: t('invalidTimezone'),
    invalid: t('invalid'),
    missing: t('missing'),
    signedOut: t('signedOut'),
    failed: t('genericFailure'),
  };
}

async function ProfileSection({
  base,
  securityHref,
  t,
}: {
  readonly base: string;
  readonly securityHref: string;
  readonly t: Translate;
}) {
  const requestHeaders = await headers();
  const result = await readBuyerProfile({ cookieHeader: requestHeaders.get('cookie') });

  if (result.kind !== 'ok') {
    return <AccountError title={t('error')} retry={t('retry')} href={base} />;
  }

  const profile = result.data.profile;
  return (
    <>
      <section className="mt-8 max-w-lg">
        <h2 className="text-xl font-semibold text-neutral-900">{t('factsHeading')}</h2>
        <dl className="mt-3">
          <AccountFact label={t('phone')}>
            {profile.phoneE164 ?? t('phoneNone')}
            {profile.phoneE164 !== null && (
              <span className="ms-2 text-xs font-normal text-neutral-600">
                {profile.phoneVerifiedAt === null ? t('phoneUnverified') : t('phoneVerified')}
              </span>
            )}
          </AccountFact>
          <AccountFact label={t('email')}>
            {profile.emailVerifiedAt === null ? t('emailUnverified') : t('emailVerified')}
          </AccountFact>
          <AccountFact label={t('memberSince')}>{profile.createdAt.slice(0, 10)}</AccountFact>
        </dl>
        <p className="mt-3 text-sm text-neutral-600">
          <Link href={securityHref} className="underline underline-offset-4">
            {t('changePhone')}
          </Link>
        </p>
      </section>

      <section className="mt-10">
        <h2 className="text-xl font-semibold text-neutral-900">{t('title')}</h2>
        <BuyerProfileForm
          labels={formLabels(t)}
          initial={{
            displayName: profile.displayName ?? '',
            fullName: profile.fullName ?? '',
            localeCode: profile.localeCode ?? '',
            timezone: profile.timezone,
          }}
        />
      </section>
    </>
  );
}
