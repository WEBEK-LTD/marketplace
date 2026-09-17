'use client';

import { PageContainer } from '@repo/ui';
import { useTranslations } from 'next-intl';
import { ErrorView } from '../../components/error-view';

export default function LocaleError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useTranslations('Error');
  return (
    <PageContainer>
      <ErrorView title={t('title')} retryLabel={t('retry')} onRetry={reset} />
    </PageContainer>
  );
}
