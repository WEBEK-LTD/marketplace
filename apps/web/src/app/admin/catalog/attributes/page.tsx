import { Heading, PageContainer } from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import { RequireStaff } from '../../../../admin/components/require-staff';
import { AttributeCreatePanel, AttributeVocabulary } from '../../../../admin/components/attributes-views';
import { sectionByHref } from '../../../../admin/server/console-sections';

/**
 * The structured attribute vocabulary — the questions a category can ask its sellers.
 *
 * **The gate is a server component inside the page, and everything else is inside it.** Nothing above
 * `RequireStaff` reads anything or renders anything about an attribute, so a colleague who may not open this
 * section receives a refusal and no data — not hidden data, no data. The permission comes from the section list
 * rather than from a string typed here, so this page and the navigation entry pointing at it can never disagree.
 *
 * The gate is `catalog.attribute.manage`. There is **no separate read key for this vocabulary and none was
 * invented**: the manage key is what the table's own RLS policy names, so the people who maintain it are the
 * people who may see it. Which categories ask for an attribute is a different authority — `catalog.category.manage`
 * — and lives on the category's own screen.
 */
export const dynamic = 'force-dynamic';

export default async function Page() {
  const section = sectionByHref('/catalog/attributes');
  if (section === null) return null;

  const [sections, t] = await Promise.all([getTranslations('Sections'), getTranslations('Attributes')]);

  return (
    <RequireStaff permission={section.permission}>
      <PageContainer>
        <div className="py-10">
          <Heading level={1}>{sections('attributes.title')}</Heading>
          <p className="mt-2 max-w-prose text-ink-muted">{t('pageIntro')}</p>
          <AttributeVocabulary />
          <AttributeCreatePanel />
        </div>
      </PageContainer>
    </RequireStaff>
  );
}
