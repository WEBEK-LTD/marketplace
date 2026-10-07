import { Heading, PageContainer } from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import { RequireStaff } from '../../../../admin/components/require-staff';
import {
  JobRunList,
  OutboxPanel,
  ScheduleProblems,
  ScheduledJobs,
} from '../../../../admin/components/platform-operations-views';
import { sectionByHref } from '../../../../admin/server/console-sections';

/**
 * Platform job runs and outbox health (Phase 7-Q).
 *
 * **The gate is a server component inside the page, and everything else is inside it.** Nothing above
 * `RequireStaff` reads anything or renders anything about a job or an event, so a colleague who may not open
 * this section receives a refusal and no data — not hidden data, no data. The permission comes from the section
 * list rather than from a string typed here, so this page and the navigation entry pointing at it can never
 * disagree about who may open it; 7-F already seeded that entry with `platform.job.read`.
 *
 * That gate refuses more people than any other section's: `platform.job.read` is held by Admin and Super Admin
 * alone, and a Moderator or a Support Agent sees the refusal.
 *
 * **Four panels, all read-only.** The schedule the database keeps; where that schedule and reality disagree;
 * the transactional outbox as counts and ages; and the runs themselves, newest first. There is no control on
 * any of them, because the workers own every write and this repository has no writer for retrying, cancelling,
 * requeueing or re-running anything — a fact the panels state rather than imply.
 *
 * The schedule comes first and the runs last: somebody opening this page wants to know whether the platform is
 * doing what it is supposed to before reading the individual attempts.
 */
export const dynamic = 'force-dynamic';

export default async function Page({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const section = sectionByHref('/platform/jobs');
  if (section === null) return null;

  const query = await searchParams;
  const [sections, t] = await Promise.all([
    getTranslations('Sections'),
    getTranslations('Platform'),
  ]);

  return (
    <RequireStaff permission={section.permission}>
      <PageContainer>
        <div className="py-10">
          <Heading level={1}>{sections('platform.title')}</Heading>
          <p className="mt-2 max-w-prose text-neutral-600">{t('pageIntro')}</p>
          <ScheduledJobs />
          <ScheduleProblems />
          <OutboxPanel />
          <JobRunList
            cursor={single(query['cursor'])}
            status={single(query['status'])}
            jobName={single(query['jobName'])}
          />
        </div>
      </PageContainer>
    </RequireStaff>
  );
}

/** One value, or none. A repeated parameter is not two positions; it is a malformed address. */
function single(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}
