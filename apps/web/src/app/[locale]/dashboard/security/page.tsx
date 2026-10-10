import type { Locale } from '@repo/shared-types';
import { Heading, PageContainer } from '@repo/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { PhoneChangeForm } from '../../../../components/phone-change-form';
import { RequireSession } from '../../../../components/require-session';
import { SignOutButton } from '../../../../components/sign-out-button';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Security');
  return { title: t('title'), robots: { index: false, follow: false } };
}

/**
 * The buyer security surface (Phase 7-E).
 *
 * **Only mechanisms that already exist.** Three sections, and each one is a path this repository already
 * has: the verified phone change of F4, the password reset of F3, and the sign-out of 5-A. There is no
 * authenticator app here, no backup codes, no session list and no "sign out everywhere" — no approved
 * mechanism for any of those exists for a buyer, and building the button without the mechanism would be
 * building a button that lies.
 *
 * **The password section is a link, not a form**, and it says what it is. This project has no
 * authenticated password-change endpoint; what it has is the reset flow, and pointing at that honestly
 * is better than an input that would have nowhere to post.
 *
 * The phone change itself moved here from the settings page in this increment: a contact change belongs
 * beside sign-in, and settings is where notification preferences live. The form and the two endpoints
 * behind it are F4's, unchanged.
 *
 * The page reads no account data. Everything on it is a form or a link, and every request those make
 * carries the session cookie the browser already has, which only the BFF can read.
 */
export default async function SecurityPage({
  params,
}: {
  readonly params: Promise<{ readonly locale: Locale }>;
}) {
  const [{ locale }, t] = await Promise.all([params, getTranslations('Security')]);
  const prefix = locale === 'ar' ? '/ar' : '';

  return (
    <RequireSession>
      <PageContainer>
        <div className="py-12">
          <Heading level={1}>{t('title')}</Heading>
          <p className="mt-2 max-w-prose text-ink-muted">{t('intro')}</p>

          <section className="mt-10">
            <h2 className="text-xl font-semibold text-ink-strong">{t('phoneHeading')}</h2>
            <p className="mt-2 max-w-sm text-ink-muted">{t('phoneIntro')}</p>
            <PhoneChangeForm
              startAction="/api/auth/contact/phone/start"
              verifyAction="/api/auth/contact/phone/verify"
              labels={{
                newPhone: t('newPhone'),
                newPhoneHint: t('newPhoneHint'),
                code: t('code'),
                codeHint: t('codeHint'),
                submitStart: t('submitStart'),
                submitVerify: t('submitVerify'),
                submitting: t('submitting'),
                incomplete: t('incomplete'),
                sent: t('sent'),
                done: t('done'),
                failed: t('failed'),
                invalid: t('invalid'),
                throttled: t('throttled'),
                unavailable: t('unavailable'),
                signedOut: t('signedOut'),
              }}
            />
          </section>

          <section className="mt-12">
            <h2 className="text-xl font-semibold text-ink-strong">{t('passwordHeading')}</h2>
            <p className="mt-2 max-w-prose text-ink-muted">{t('passwordIntro')}</p>
            <Link
              href={`${prefix}/forgot-password`}
              className="mt-3 inline-block rounded-md border border-edge px-4 py-2 text-sm font-medium text-ink-strong"
            >
              {t('passwordLink')}
            </Link>
          </section>

          <section className="mt-12">
            <h2 className="text-xl font-semibold text-ink-strong">{t('sessionHeading')}</h2>
            <p className="mt-2 max-w-prose text-ink-muted">{t('sessionIntro')}</p>
            <SignOutButton label={t('signOut')} working={t('submitting')} failed={t('unavailable')} />
          </section>
        </div>
      </PageContainer>
    </RequireSession>
  );
}
