import { Heading, PageContainer } from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import { RequireStaff } from '../../../../admin/components/require-staff';
import { SeoMetadataAddPanel, SeoMetadataList } from '../../../../admin/components/seo-metadata-views';
import { sectionByHref } from '../../../../admin/server/console-sections';

/**
 * The per-entity SEO metadata section — the title, description and social card a surface shows a crawler.
 *
 * **The gate is a server component inside the page, and everything else is inside it.** Nothing above `RequireStaff`
 * reads anything or renders anything about an override. The permission comes from the section list rather than from a
 * string typed here, so this page and the navigation entry pointing at it can never disagree.
 *
 * The gate is `seo.metadata.read`. **Writing needs the separate `seo.metadata.manage`**, which the detail screen asks
 * the server about rather than inferring from a role — so a reader opening this section sees the overrides and no
 * controls.
 */
export const dynamic = 'force-dynamic';

export default async function Page({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const section = sectionByHref('/seo/metadata');
  if (section === null) return null;

  const query = await searchParams;
  const [sections, t] = await Promise.all([getTranslations('Sections'), getTranslations('SeoMetadata')]);

  return (
    <RequireStaff permission={section.permission}>
      <PageContainer>
        <div className="py-10">
          <Heading level={1}>{sections('seoMetadata.title')}</Heading>
          <p className="mt-2 max-w-prose text-neutral-600">{t('pageIntro')}</p>
          <SeoMetadataList
            cursor={single(query['cursor'])}
            entityType={single(query['entityType'])}
            locale={single(query['locale'])}
          />
          <SeoMetadataAddPanel />
        </div>
      </PageContainer>
    </RequireStaff>
  );
}

/** One value, or none. A repeated parameter is not two positions; it is a malformed address. */
function single(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}
