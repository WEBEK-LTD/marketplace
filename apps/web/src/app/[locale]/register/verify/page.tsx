import { Heading, PageContainer } from '@repo/ui';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { RegisterVerifyForm } from '../../../../components/register-forms';
import { readRegisterChallengeCookie } from '../../../../server/bff';
import { registerLabels } from '../labels';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Register');
  return { title: t('verifyTitle'), robots: { index: false, follow: false } };
}

/**
 * Step two of registration: confirm the contact.
 *
 * **What protects this route.** There is nothing here worth protecting with a session — by decision there
 * is no session yet — so what the page checks is that a registration is actually in progress: the
 * `HttpOnly` challenge cookie. Without it the form is never rendered, so a visitor who arrives at this URL
 * cold gets a way back rather than a code box that could never work, and the RSC payload carries no form
 * for them either.
 *
 * That check discloses nothing, because the previous step sets the cookie whether or not it created an
 * account. Someone who registered an address that was already taken reaches exactly this page, sees
 * exactly this form, and is refused when they submit a code — in the same words a wrong code earns.
 *
 * **No session is created here.** Confirming a contact is permission to sign in, not a sign-in, so a
 * success sends the person to the sign-in page.
 */
export default async function RegisterVerifyPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const [t, requestHeaders] = await Promise.all([getTranslations('Register'), headers()]);
  const prefix = locale === 'ar' ? '/ar' : '';

  if (readRegisterChallengeCookie(requestHeaders.get('cookie')) === null) {
    return (
      <PageContainer>
        <div className="py-12" role="status">
          <Heading level={1}>{t('expiredTitle')}</Heading>
          <p className="mt-4 max-w-prose text-neutral-600">{t('expiredBody')}</p>
          <Link
            href={`${prefix}/register`}
            className="mt-6 inline-block rounded-md border border-neutral-300 px-4 py-2 text-sm"
          >
            {t('startAgain')}
          </Link>
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <div className="py-12">
        <Heading level={1}>{t('verifyTitle')}</Heading>
        <p className="mt-2 max-w-sm text-neutral-600">{t('verifyIntro')}</p>
        <RegisterVerifyForm
          action="/api/auth/register/verify"
          resendAction="/api/auth/register/resend"
          signInHref={`${prefix}/login`}
          labels={await registerLabels()}
        />
      </div>
    </PageContainer>
  );
}
