import { Heading, PageContainer } from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import { RequireStaff } from '../../../../admin/components/require-staff';
import { ModerationReportQueue } from '../../../../admin/components/moderation-views';
import { sectionByHref } from '../../../../admin/server/console-sections';

/**
 * The report queue (Phase 7-N).
 *
 * **The gate is a server component inside the page, and everything else is inside it.** Nothing above
 * `RequireStaff` reads anything or renders anything about a report, so a colleague who may not read this
 * section receives a refusal and no data — not hidden data, no data. The permission comes from the section
 * list rather than from a string typed here, so this page and the navigation entry pointing at it can never
 * disagree about who may open it; 7-F already seeded that entry with `moderation.report.read`.
 *
 * **Oldest first, and no ranking.** The schema's priority column is text and its own index orders it
 * lexically, which expresses nothing about severity — so the queue is ordered by age, priority is shown as a
 * fact, and there is no score, no SLA and no statistic anywhere on this page.
 *
 * The status filter is one of the five the database already has; a value that is not one is dropped rather
 * than refused, so a mistyped bookmark shows the whole queue.
 */
export const dynamic = 'force-dynamic';

export default async function Page({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const section = sectionByHref('/moderation/reports');
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
          <Heading level={1}>{sections('moderation.title')}</Heading>
          <p className="mt-2 max-w-prose text-neutral-600">{t('reportsIntro')}</p>
          <ModerationReportQueue cursor={single(query['cursor'])} status={single(query['status'])} />
        </div>
      </PageContainer>
    </RequireStaff>
  );
}

/** One value, or none. A repeated parameter is not two positions; it is a malformed address. */
function single(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}
