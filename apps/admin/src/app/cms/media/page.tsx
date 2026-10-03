import { Heading, PageContainer } from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import { RequireStaff } from '../../../components/require-staff';
import { CmsMediaList, CmsMediaUploadPanel } from '../../../components/cms-media-views';
import { sectionByHref } from '../../../server/console-sections';

/**
 * The CMS media library (0098).
 *
 * **The gate is a server component inside the page, and everything else is inside it.** The permission comes from the
 * section list rather than from a string typed here, so this page and the navigation entry pointing at it can never
 * disagree.
 *
 * The gate is `cms.media.manage`, and there is no second key: 0033 seeds no `cms.media.read`, so whoever can open this
 * section may change it. That is why this page has no read-only shape.
 */
export const dynamic = 'force-dynamic';

export default async function Page({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const section = sectionByHref('/cms/media');
  if (section === null) return null;

  const params = await searchParams;
  const cursor = typeof params['cursor'] === 'string' ? params['cursor'] : undefined;
  // Which entry's references — and therefore whose delete control — this response renders (owner decision 5).
  const usageFor = typeof params['usage'] === 'string' ? params['usage'] : undefined;
  const [sections, t] = await Promise.all([getTranslations('Sections'), getTranslations('CmsMedia')]);

  return (
    <RequireStaff permission={section.permission}>
      <PageContainer>
        <div className="py-10">
          <Heading level={1}>{sections('cmsMedia.title')}</Heading>
          <p className="mt-2 max-w-prose text-neutral-600">{t('pageIntro')}</p>
          <CmsMediaUploadPanel />
          <CmsMediaList cursor={cursor} usageFor={usageFor} />
        </div>
      </PageContainer>
    </RequireStaff>
  );
}
