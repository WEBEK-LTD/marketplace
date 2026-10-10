import { Heading, PageContainer } from '@repo/ui';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { RequireStaff } from '../../../../../admin/components/require-staff';
import { CmsPageDetailView } from '../../../../../admin/components/cms-pages-views';
import { sectionByHref } from '../../../../../admin/server/console-sections';
import { adminPath } from '../../../../../admin/paths';

/**
 * One authored page: its settings, its lifecycle and every locale it has been written in.
 *
 * Gated on the section's own `cms.page.read`, exactly as the list is. The controls below render only when the
 * server reports `canManage`, which is the separate `cms.page.manage` key tested in the database — so a
 * colleague who may read this section but not change it sees the page, its history and its text, and no form.
 *
 * A page that does not exist and a page this caller may not read both render the same message, because the API
 * answers both the same way on purpose.
 */
export const dynamic = 'force-dynamic';

export default async function Page({ params }: { readonly params: Promise<{ pageId: string }> }) {
  const section = sectionByHref('/cms/pages');
  if (section === null) return null;

  const { pageId } = await params;
  const [sections, t] = await Promise.all([getTranslations('Sections'), getTranslations('Cms')]);

  return (
    <RequireStaff permission={section.permission}>
      <PageContainer>
        <div className="py-10">
          <Heading level={1}>{sections('cms.title')}</Heading>
          <p className="mt-2 max-w-prose text-ink-muted">{t('detailIntro')}</p>
          <p className="mt-2 text-sm">
            <Link className="text-ink-strong underline" href={adminPath('/cms/pages')}>
              {t('backToList')}
            </Link>
          </p>
          <CmsPageDetailView pageId={pageId} />
        </div>
      </PageContainer>
    </RequireStaff>
  );
}
