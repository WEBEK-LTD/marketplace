import { Heading, PageContainer } from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import { RequireStaff } from '../../../../components/require-staff';
import { JobRunDetailView } from '../../../../components/platform-operations-views';
import { sectionByHref } from '../../../../server/console-sections';

/**
 * One job run (Phase 7-Q).
 *
 * One read, inside the gate, behind the same key as the section: `platform.job.read`, held by Admin and Super
 * Admin alone. A run that does not exist and a caller without that key are answered identically.
 *
 * **Read-only, and the page states both reasons.** There is no re-run control, because nothing in this
 * repository re-runs a job on demand — `run_scheduled_job` is the scheduler's own entry point and the console
 * has no authorized path to it. And a failed run shows its error class and SQLSTATE but not the failure text:
 * the job runner stores that text in a free-form details object as a raw PostgreSQL error message, which quotes
 * the row that caused it, so it is not carried onto a screen at all.
 */
export const dynamic = 'force-dynamic';

export default async function Page({ params }: { readonly params: Promise<{ runId: string }> }) {
  const section = sectionByHref('/platform/jobs');
  if (section === null) return null;

  const { runId } = await params;
  const [sections, t] = await Promise.all([
    getTranslations('Sections'),
    getTranslations('Platform'),
  ]);

  return (
    <RequireStaff permission={section.permission}>
      <PageContainer>
        <div className="py-10">
          <Heading level={1}>{sections('platform.title')}</Heading>
          <p className="mt-2 max-w-prose text-neutral-600">{t('runDetailIntro')}</p>
          <JobRunDetailView runId={runId} />
        </div>
      </PageContainer>
    </RequireStaff>
  );
}
