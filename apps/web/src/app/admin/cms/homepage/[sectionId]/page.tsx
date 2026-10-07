import { Heading, PageContainer } from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import { RequireStaff } from '../../../../../admin/components/require-staff';
import { HomepageSectionDetailView } from '../../../../../admin/components/homepage-views';
import { sectionByHref } from '../../../../../admin/server/console-sections';

/**
 * One homepage section: what it is, what it names, and how much of that the public can still see.
 *
 * Gated on the section's own `cms.homepage.read`. The controls render only when the server reports `canManage`,
 * which is the separate `cms.homepage.manage` key tested in the database.
 *
 * A section that does not exist and one this caller may not read both render the same message, because the API
 * answers both the same way on purpose.
 */
export const dynamic = 'force-dynamic';

export default async function Page({ params }: { readonly params: Promise<{ sectionId: string }> }) {
  const section = sectionByHref('/cms/homepage');
  if (section === null) return null;

  const { sectionId } = await params;
  const [sections, t] = await Promise.all([getTranslations('Sections'), getTranslations('Homepage')]);

  return (
    <RequireStaff permission={section.permission}>
      <PageContainer>
        <div className="py-10">
          <Heading level={1}>{sections('homepage.title')}</Heading>
          <p className="mt-2 max-w-prose text-neutral-600">{t('detailIntro')}</p>
          <HomepageSectionDetailView sectionId={sectionId} />
        </div>
      </PageContainer>
    </RequireStaff>
  );
}
