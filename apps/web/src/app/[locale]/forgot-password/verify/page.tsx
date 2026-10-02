import { Heading, PageContainer } from '@repo/ui';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { RecoveryVerifyForm } from '../../../../components/recovery-forms';
import { recoveryLabels } from '../labels';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Recovery');
  return { title: t('verifyTitle'), robots: { index: false, follow: false } };
}

/**
 * Step two: the code.
 *
 * The challenge identifier arrives in the query string. It is opaque and useless on its own — the code
 * itself went to the account's verified contact — so it is read here rather than stored anywhere.
 */
export default async function ForgotPasswordVerifyPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  const t = await getTranslations('Recovery');
  const prefix = locale === 'ar' ? '/ar' : '';
  const challenge = query['challenge'];
  return (
    <PageContainer>
      <div className="py-12">
        <Heading level={1}>{t('verifyTitle')}</Heading>
        <p className="mt-2 max-w-sm text-neutral-600">{t('verifyIntro')}</p>
        <RecoveryVerifyForm
          action="/api/auth/recovery/verify"
          challengeId={typeof challenge === 'string' ? challenge : ''}
          fallbackHref={`${prefix}/reset-password`}
          labels={await recoveryLabels()}
        />
      </div>
    </PageContainer>
  );
}
