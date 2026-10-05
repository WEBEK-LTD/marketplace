import { Heading, PageContainer } from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import { RequireStaff } from '../../../components/require-staff';
import { SeoRedirectCreatePanel, SeoRedirectList } from '../../../components/seo-redirects-views';
import { sectionByHref } from '../../../server/console-sections';

/**
 * The SEO redirect map — where an address that no longer exists is sent.
 *
 * **The gate is a server component inside the page, and everything else is inside it.** Nothing above
 * `RequireStaff` reads anything or renders anything about an entry, so a colleague who may not open this section
 * receives a refusal and no data — not hidden data, no data. The permission comes from the section list rather than
 * from a string typed here, so this page and the navigation entry pointing at it can never disagree about who may
 * open it.
 *
 * The gate is `seo.redirect.read`, held by Admin and Super Admin alone. **Adding and changing need the separate
 * `seo.redirect.manage`**, which the detail screen asks the server about rather than inferring from a role — so a
 * reader opening this section sees the map and no controls.
 */
export const dynamic = 'force-dynamic';

export default async function Page({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const section = sectionByHref('/seo/redirects');
  if (section === null) return null;

  const query = await searchParams;
  const [sections, t] = await Promise.all([
    getTranslations('Sections'),
    getTranslations('SeoRedirects'),
  ]);

  return (
    <RequireStaff permission={section.permission}>
      <PageContainer>
        <div className="py-10">
          <Heading level={1}>{sections('seoRedirects.title')}</Heading>
          <p className="mt-2 max-w-prose text-neutral-600">{t('pageIntro')}</p>
          <SeoRedirectList
            cursor={single(query['cursor'])}
            search={single(query['search'])}
            active={single(query['active'])}
          />
          <SeoRedirectCreatePanel />
        </div>
      </PageContainer>
    </RequireStaff>
  );
}

/** One value, or none. A repeated parameter is not two positions; it is a malformed address. */
function single(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}
