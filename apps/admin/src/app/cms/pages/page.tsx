import { Heading, PageContainer } from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import { RequireStaff } from '../../../components/require-staff';
import { CmsPageCreatePanel, CmsPageList } from '../../../components/cms-pages-views';
import { sectionByHref } from '../../../server/console-sections';

/**
 * The CMS pages section — the static pages the public site serves.
 *
 * **The gate is a server component inside the page, and everything else is inside it.** Nothing above
 * `RequireStaff` reads anything or renders anything about a page, so a colleague who may not open this section
 * receives a refusal and no data — not hidden data, no data. The permission comes from the section list rather
 * than from a string typed here, so this page and the navigation entry pointing at it can never disagree about
 * who may open it.
 *
 * The gate is `cms.page.read`, held by Admin and Super Admin alone. **Creating and editing need the separate
 * `cms.page.manage`**, which the detail screen asks the server about rather than inferring from a role — so a
 * reader opening this section sees the list and no controls.
 */
export const dynamic = 'force-dynamic';

export default async function Page({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const section = sectionByHref('/cms/pages');
  if (section === null) return null;

  const query = await searchParams;
  const [sections, t] = await Promise.all([getTranslations('Sections'), getTranslations('Cms')]);

  return (
    <RequireStaff permission={section.permission}>
      <PageContainer>
        <div className="py-10">
          <Heading level={1}>{sections('cms.title')}</Heading>
          <p className="mt-2 max-w-prose text-neutral-600">{t('pageIntro')}</p>
          <CmsPageList cursor={single(query['cursor'])} status={single(query['status'])} />
          <CmsPageCreatePanel />
        </div>
      </PageContainer>
    </RequireStaff>
  );
}

/** One value, or none. A repeated parameter is not two positions; it is a malformed address. */
function single(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}
