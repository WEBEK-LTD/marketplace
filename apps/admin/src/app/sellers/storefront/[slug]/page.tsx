import { Heading, PageContainer } from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import { RequireStaff } from '../../../../components/require-staff';
import { AdminSellerDetailView } from '../../../../components/admin-operations-views';
import { sectionByHref } from '../../../../server/console-sections';

/**
 * One storefront (Phase 7-O).
 *
 * Its own path segment rather than `/sellers/[slug]`, so it can never collide with 7-G's
 * `/sellers/verification`: a storefront whose slug happened to be `verification` would otherwise be
 * unreachable, and a route that silently cannot address one of its own rows is a bug waiting for the row.
 *
 * The gate is inside the page and the read is inside the gate, so a colleague who may not read storefronts
 * receives a refusal and no read is performed at all. It shares `/sellers`'s permission, which is the
 * section this page belongs to.
 */
export const dynamic = 'force-dynamic';

export default async function Page({ params }: { readonly params: Promise<{ slug: string }> }) {
  const section = sectionByHref('/sellers');
  if (section === null) return null;

  const { slug } = await params;
  const [sections, t] = await Promise.all([
    getTranslations('Sections'),
    getTranslations('AdminOps'),
  ]);

  return (
    <RequireStaff permission={section.permission}>
      <PageContainer>
        <div className="py-10">
          <Heading level={1}>{sections('sellers.title')}</Heading>
          <p className="mt-2 max-w-prose text-neutral-600">{t('sellerDetailIntro')}</p>
          <AdminSellerDetailView slug={slug} />
        </div>
      </PageContainer>
    </RequireStaff>
  );
}
