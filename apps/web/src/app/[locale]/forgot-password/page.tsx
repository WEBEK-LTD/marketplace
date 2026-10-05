import { Heading, PageContainer } from '@repo/ui';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { RecoveryStartForm } from '../../../components/recovery-forms';
import { recoveryLabels } from './labels';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Recovery');
  return { title: t('startTitle'), robots: { index: false, follow: false } };
}

/**
 * Step one of the password reset.
 *
 * The page says the same thing to everyone, because the server answers the same way for every
 * identifier: it never confirms that an account exists, and it never names a destination.
 */
export default async function ForgotPasswordPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations('Recovery');
  const prefix = locale === 'ar' ? '/ar' : '';
  return (
    <PageContainer>
      <div className="py-12">
        <Heading level={1}>{t('startTitle')}</Heading>
        <p className="mt-2 max-w-sm text-neutral-600">{t('startIntro')}</p>
        <RecoveryStartForm
          action="/api/auth/recovery/start"
          nextHref={`${prefix}/forgot-password/verify`}
          labels={await recoveryLabels()}
        />
      </div>
    </PageContainer>
  );
}
