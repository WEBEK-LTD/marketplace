import { Heading, PageContainer } from '@repo/ui';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { RequireStaff } from '../../../../../admin/components/require-staff';
import { SeoMetadataDetailView } from '../../../../../admin/components/seo-metadata-views';
import { sectionByHref } from '../../../../../admin/server/console-sections';
import { adminPath } from '../../../../../admin/paths';

/**
 * One metadata override: what was stored, and what a visitor's browser will actually be told.
 *
 * Gated on the section's own `seo.metadata.read`. The controls below render only when the server reports `canManage`,
 * which is the separate `seo.metadata.manage` key tested in the database.
 *
 * An override that does not exist and one this caller may not read both render the same message, because the API
 * answers both the same way on purpose.
 */
export const dynamic = 'force-dynamic';

export default async function Page({ params }: { readonly params: Promise<{ entryId: string }> }) {
  const section = sectionByHref('/seo/metadata');
  if (section === null) return null;

  const { entryId } = await params;
  const [sections, t] = await Promise.all([getTranslations('Sections'), getTranslations('SeoMetadata')]);

  return (
    <RequireStaff permission={section.permission}>
      <PageContainer>
        <div className="py-10">
          <Heading level={1}>{sections('seoMetadata.title')}</Heading>
          <p className="mt-2 max-w-prose text-neutral-600">{t('detailIntro')}</p>
          <p className="mt-2 text-sm">
            <Link className="text-neutral-900 underline" href={adminPath('/seo/metadata')}>
              {t('backToList')}
            </Link>
          </p>
          <SeoMetadataDetailView entryId={entryId} />
        </div>
      </PageContainer>
    </RequireStaff>
  );
}
