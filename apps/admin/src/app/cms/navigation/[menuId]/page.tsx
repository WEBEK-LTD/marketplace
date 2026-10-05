import { Heading, PageContainer } from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import { RequireStaff } from '../../../../components/require-staff';
import { NavigationMenuDetailView } from '../../../../components/navigation-views';
import { sectionByHref } from '../../../../server/console-sections';

/**
 * One navigation menu: what it holds, in what order, and which of its entries the public is actually shown.
 *
 * Gated on the section's own `cms.navigation.read`. The controls render only when the server reports `canManage`,
 * which is the separate `cms.navigation.manage` key tested in the database.
 *
 * A menu that does not exist and one this caller may not read both render the same message, because the API answers
 * both the same way on purpose.
 */
export const dynamic = 'force-dynamic';

export default async function Page({ params }: { readonly params: Promise<{ menuId: string }> }) {
  const section = sectionByHref('/cms/navigation');
  if (section === null) return null;

  const { menuId } = await params;
  const [sections, t] = await Promise.all([getTranslations('Sections'), getTranslations('Navigation')]);

  return (
    <RequireStaff permission={section.permission}>
      <PageContainer>
        <div className="py-10">
          <Heading level={1}>{sections('navigation.title')}</Heading>
          <p className="mt-2 max-w-prose text-neutral-600">{t('detailIntro')}</p>
          <NavigationMenuDetailView menuId={menuId} />
        </div>
      </PageContainer>
    </RequireStaff>
  );
}
