import { Heading, PageContainer } from '@repo/ui';
import { getTranslations } from 'next-intl/server';

export default async function HomePage() {
  const t = await getTranslations('Site');
  return (
    <PageContainer>
      <div className="py-12">
        <Heading level={1}>{t('name')}</Heading>
      </div>
    </PageContainer>
  );
}
