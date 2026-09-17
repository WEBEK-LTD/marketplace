import { Heading, PageContainer } from '@repo/ui';
import { getTranslations } from 'next-intl/server';

export default async function AdminHomePage() {
  const t = await getTranslations('Home');
  return (
    <PageContainer>
      <div className="py-12">
        <Heading level={1}>{t('title')}</Heading>
      </div>
    </PageContainer>
  );
}
