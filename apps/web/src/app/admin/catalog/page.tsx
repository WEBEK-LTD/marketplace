import { Heading, PageContainer } from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import { RequireStaff } from '../../../admin/components/require-staff';
import { ModerationListingQueue } from '../../../admin/components/moderation-views';
import { sectionByHref } from '../../../admin/server/console-sections';

/**
 * The listings awaiting review (Phase 7-F's section, given its tools in 7-N).
 *
 * **The gate is a server component inside the page, and the read is inside it.** The permission comes from the
 * section list — `catalog.listing.read`, which 7-F seeded this section with — so the link and the page cannot
 * disagree. Moderating one of these listings needs `catalog.listing.moderate`, which is checked on the action
 * rather than on the reading: gating the section on a manage permission would hide it from colleagues who are
 * meant to read it.
 *
 * A work queue, so oldest first. There is no dashboard, no count of anybody's throughput, no KPI and no
 * invented statistic here: the page shows what is waiting.
 */
export const dynamic = 'force-dynamic';

export default async function Page({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const section = sectionByHref('/catalog');
  if (section === null) return null;

  const query = await searchParams;
  const [sections, t] = await Promise.all([
    getTranslations('Sections'),
    getTranslations('Moderation'),
  ]);

  return (
    <RequireStaff permission={section.permission}>
      <PageContainer>
        <div className="py-10">
          <Heading level={1}>{sections('catalog.title')}</Heading>
          <p className="mt-2 max-w-prose text-ink-muted">{t('listingsIntro')}</p>
          <ModerationListingQueue cursor={single(query['cursor'])} />
        </div>
      </PageContainer>
    </RequireStaff>
  );
}

function single(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}
