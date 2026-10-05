import { Heading, PageContainer } from '@repo/ui';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { RequireStaff } from '../../../../components/require-staff';
import { CategoryDetailView } from '../../../../components/categories-views';
import { CategoryAttributePanel } from '../../../../components/attributes-views';
import { sectionByHref } from '../../../../server/console-sections';

/**
 * One category: what it is, where it sits, whether anybody can see it, and every locale it has been written in.
 *
 * Gated on the same `catalog.category.read` as the tree. The writes need `catalog.category.manage`, and whether
 * this caller holds it is the server's answer on the detail rather than a guess made here.
 *
 * There is no rename control and no delete control on this screen, because neither route exists.
 */
export const dynamic = 'force-dynamic';

export default async function Page({
  params,
}: {
  readonly params: Promise<{ categoryId: string }>;
}) {
  const section = sectionByHref('/catalog/categories');
  if (section === null) return null;

  const { categoryId } = await params;
  const [sections, t] = await Promise.all([
    getTranslations('Sections'),
    getTranslations('Categories'),
  ]);

  return (
    <RequireStaff permission={section.permission}>
      <PageContainer>
        <div className="py-10">
          <Heading level={1}>{sections('categories.title')}</Heading>
          <p className="mt-2">
            <Link className="text-sm underline hover:no-underline" href="/catalog/categories">
              {t('backToTree')}
            </Link>
          </p>
          <CategoryDetailView categoryId={categoryId} />
          {/* Which attributes this category asks its sellers about. Its own authority — `catalog.category.manage`,
              which is what `category_attributes`' write policy names — reported by the API rather than guessed. */}
          <CategoryAttributePanel categoryId={categoryId} />
        </div>
      </PageContainer>
    </RequireStaff>
  );
}
