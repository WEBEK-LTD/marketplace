import { Heading, PageContainer } from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import { RequireStaff } from '../../../../admin/components/require-staff';
import { NavigationAddPanel, NavigationMenuList } from '../../../../admin/components/navigation-views';
import { sectionByHref } from '../../../../admin/server/console-sections';

/**
 * The navigation section — what the site's header, footer and mobile drawer hold (0094).
 *
 * **The gate is a server component inside the page, and everything else is inside it.** The permission comes from
 * the section list rather than from a string typed here, so this page and the navigation entry pointing at it can
 * never disagree.
 *
 * The gate is `cms.navigation.read`. **Arranging needs the separate `cms.navigation.manage`**, which each panel
 * asks the server about rather than inferring from a role — so a reader sees the menus and no controls.
 */
export const dynamic = 'force-dynamic';

export default async function Page() {
  const section = sectionByHref('/cms/navigation');
  if (section === null) return null;

  const [sections, t] = await Promise.all([getTranslations('Sections'), getTranslations('Navigation')]);

  return (
    <RequireStaff permission={section.permission}>
      <PageContainer>
        <div className="py-10">
          <Heading level={1}>{sections('navigation.title')}</Heading>
          <p className="mt-2 max-w-prose text-ink-muted">{t('pageIntro')}</p>
          <NavigationMenuList />
          <NavigationAddPanel />
        </div>
      </PageContainer>
    </RequireStaff>
  );
}
