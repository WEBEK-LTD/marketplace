import { Heading, PageContainer } from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import { RequireStaff } from '../../../components/require-staff';
import { HomepageAddPanel, HomepageSectionList } from '../../../components/homepage-views';
import { sectionByHref } from '../../../server/console-sections';

/**
 * The homepage composition section — what the site's front page is made of, and in what order (0093).
 *
 * **The gate is a server component inside the page, and everything else is inside it.** The permission comes from
 * the section list rather than from a string typed here, so this page and the navigation entry pointing at it can
 * never disagree.
 *
 * The gate is `cms.homepage.read`. **Composing needs the separate `cms.homepage.manage`**, which each panel asks
 * the server about rather than inferring from a role — so a reader sees the sections and no controls.
 */
export const dynamic = 'force-dynamic';

export default async function Page() {
  const section = sectionByHref('/cms/homepage');
  if (section === null) return null;

  const [sections, t] = await Promise.all([getTranslations('Sections'), getTranslations('Homepage')]);

  return (
    <RequireStaff permission={section.permission}>
      <PageContainer>
        <div className="py-10">
          <Heading level={1}>{sections('homepage.title')}</Heading>
          <p className="mt-2 max-w-prose text-neutral-600">{t('pageIntro')}</p>
          <HomepageSectionList />
          <HomepageAddPanel />
        </div>
      </PageContainer>
    </RequireStaff>
  );
}
