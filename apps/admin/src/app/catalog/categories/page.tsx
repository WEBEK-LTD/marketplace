import { Heading, PageContainer } from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import { RequireStaff } from '../../../components/require-staff';
import { CategoryCreatePanel, CategoryTree } from '../../../components/categories-views';
import { sectionByHref } from '../../../server/console-sections';

/**
 * The category tree — the spine of the catalogue.
 *
 * **The gate is a server component inside the page, and everything else is inside it.** Nothing above
 * `RequireStaff` reads anything or renders anything about a category, so a colleague who may not open this section
 * receives a refusal and no data — not hidden data, no data. The permission comes from the section list rather than
 * from a string typed here, so this page and the navigation entry pointing at it can never disagree.
 *
 * The gate is `catalog.category.read`, held by Admin and Super Admin alone. **Creating and editing need the
 * separate `catalog.category.manage`**, which the screens ask the server about rather than inferring from a role,
 * so a reader opening this section sees the tree and no controls.
 */
export const dynamic = 'force-dynamic';

export default async function Page() {
  const section = sectionByHref('/catalog/categories');
  if (section === null) return null;

  const [sections, t] = await Promise.all([
    getTranslations('Sections'),
    getTranslations('Categories'),
  ]);

  return (
    <RequireStaff permission={section.permission}>
      <PageContainer>
        <div className="py-10">
          <Heading level={1}>{sections('categories.title')}</Heading>
          <p className="mt-2 max-w-prose text-neutral-600">{t('pageIntro')}</p>
          <CategoryTree />
          <CategoryCreatePanel />
        </div>
      </PageContainer>
    </RequireStaff>
  );
}
