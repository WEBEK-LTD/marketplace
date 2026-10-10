import { Heading, PageContainer } from '@repo/ui';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { RequireStaff } from '../../../../../admin/components/require-staff';
import { SeoRedirectDetailView } from '../../../../../admin/components/seo-redirects-views';
import { sectionByHref } from '../../../../../admin/server/console-sections';
import { adminPath } from '../../../../../admin/paths';

/**
 * One entry of the redirect map: where it points, whether it is switched on, and where its chain ends.
 *
 * Gated on the section's own `seo.redirect.read`, exactly as the list is. The controls below render only when the
 * server reports `canManage`, which is the separate `seo.redirect.manage` key tested in the database — so a
 * colleague who may read this section but not change it sees the entry and no form.
 *
 * An entry that does not exist and an entry this caller may not read both render the same message, because the API
 * answers both the same way on purpose.
 */
export const dynamic = 'force-dynamic';

export default async function Page({ params }: { readonly params: Promise<{ redirectId: string }> }) {
  const section = sectionByHref('/seo/redirects');
  if (section === null) return null;

  const { redirectId } = await params;
  const [sections, t] = await Promise.all([
    getTranslations('Sections'),
    getTranslations('SeoRedirects'),
  ]);

  return (
    <RequireStaff permission={section.permission}>
      <PageContainer>
        <div className="py-10">
          <Heading level={1}>{sections('seoRedirects.title')}</Heading>
          <p className="mt-2 max-w-prose text-ink-muted">{t('detailIntro')}</p>
          <p className="mt-2 text-sm">
            <Link className="text-ink-strong underline" href={adminPath('/seo/redirects')}>
              {t('backToList')}
            </Link>
          </p>
          <SeoRedirectDetailView redirectId={redirectId} />
        </div>
      </PageContainer>
    </RequireStaff>
  );
}
