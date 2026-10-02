import { Heading, PageContainer } from '@repo/ui';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { RecoveryResetForm } from '../../../components/recovery-forms';
import { recoveryLabels } from '../forgot-password/labels';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Recovery');
  return { title: t('resetTitle'), robots: { index: false, follow: false } };
}

/**
 * Step three: the new password.
 *
 * The page reads no token and holds no session. Authorisation for the change is the `__Host-mp_reset`
 * cookie, which this page cannot read and the browser sends on its own.
 */
export default async function ResetPasswordPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations('Recovery');
  const prefix = locale === 'ar' ? '/ar' : '';
  return (
    <PageContainer>
      <div className="py-12">
        <Heading level={1}>{t('resetTitle')}</Heading>
        <p className="mt-2 max-w-sm text-neutral-600">{t('resetIntro')}</p>
        <RecoveryResetForm
          action="/api/auth/recovery/reset"
          signInHref={`${prefix}/login`}
          labels={await recoveryLabels()}
        />
      </div>
    </PageContainer>
  );
}
