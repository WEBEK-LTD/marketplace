import { Heading, PageContainer } from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import { RequireStaff } from '../../../../admin/components/require-staff';
import { SeoSettingsPanels } from '../../../../admin/components/seo-settings-views';
import { sectionByHref } from '../../../../admin/server/console-sections';

/**
 * The site-wide SEO defaults (0096).
 *
 * **The gate is a server component inside the page, and everything else is inside it.** The permission comes from
 * the section list rather than from a string typed here, so this page and the navigation entry pointing at it can
 * never disagree.
 *
 * The gate is `seo.settings.manage`, and there is no second key: 0033 seeds no `seo.settings.read`, so whoever can
 * open this section may change it (owner decision 6). That is why this page has no read-only shape.
 */
export const dynamic = 'force-dynamic';

export default async function Page() {
  const section = sectionByHref('/seo/settings');
  if (section === null) return null;

  const [sections, t] = await Promise.all([getTranslations('Sections'), getTranslations('SeoSettings')]);

  return (
    <RequireStaff permission={section.permission}>
      <PageContainer>
        <div className="py-10">
          <Heading level={1}>{sections('seoSettings.title')}</Heading>
          <p className="mt-2 max-w-prose text-neutral-600">{t('pageIntro')}</p>
          <SeoSettingsPanels />
        </div>
      </PageContainer>
    </RequireStaff>
  );
}
