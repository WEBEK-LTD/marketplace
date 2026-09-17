import { Heading, PageContainer } from '@repo/ui';
import { getTranslations } from 'next-intl/server';

/**
 * Localized 404 for unknown URLs. There is deliberately no catch-all route: Next.js 16 does not
 * server-render not-found boundaries reached through notFound() (vercel/next.js#98295), while
 * unmatched URLs render this page as real HTML with a 404 status.
 */
export default async function NotFound() {
  const t = await getTranslations('NotFound');
  return (
    <PageContainer>
      <div className="py-12">
        <Heading level={1}>{t('title')}</Heading>
        <p className="mt-2 text-neutral-600">{t('description')}</p>
      </div>
    </PageContainer>
  );
}
