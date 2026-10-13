import { Heading, PageContainer } from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import { RequireStaff } from '../../../../admin/components/require-staff';
import { OfficeSettingsPanel } from '../../../../admin/components/site-settings-views';
import { sectionByHref } from '../../../../admin/server/console-sections';

/**
 * The office's own details (0113).
 *
 * **The gate is a server component inside the page, and everything else is inside it.** The permission comes
 * from the section list rather than from a string typed here, so this page and the navigation entry pointing at
 * it can never disagree.
 *
 * The gate is `settings.site.manage`, and there is no second key: 0033 seeds no `settings.site.read`, so
 * whoever can open this section may change it. That is why this page has no read-only shape.
 *
 * **It is one category of settings, not all of them.** A screen listing every setting on the platform is a
 * screen nobody can find anything in; the address names the category it edits.
 */
export const dynamic = 'force-dynamic';

export default async function Page() {
  const section = sectionByHref('/settings/office');
  if (section === null) return null;

  const [sections, t] = await Promise.all([getTranslations('Sections'), getTranslations('SiteSettings')]);

  return (
    <RequireStaff permission={section.permission}>
      <PageContainer>
        <div className="py-10">
          <Heading level={1}>{sections('siteSettings.title')}</Heading>
          <p className="mt-2 max-w-prose text-ink-muted">{t('pageIntro')}</p>
          <OfficeSettingsPanel />
        </div>
      </PageContainer>
    </RequireStaff>
  );
}
