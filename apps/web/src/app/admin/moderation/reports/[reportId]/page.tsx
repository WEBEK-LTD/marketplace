import { Heading, PageContainer } from '@repo/ui';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { RequireStaff } from '../../../../../admin/components/require-staff';
import { ModerationReportDetailView } from '../../../../../admin/components/moderation-views';
import { sectionByHref } from '../../../../../admin/server/console-sections';
import { adminPath } from '../../../../../admin/paths';

/**
 * One report (Phase 7-N).
 *
 * **The gate is inside the page and every read is inside the gate**, so a colleague who may not read this
 * section performs no read and receives none of a report — in the markup or in the flight data. The report is
 * then gated twice more: the API requires the same key and the database re-applies the test with the key as a
 * literal.
 *
 * The heading is the section's rather than the report's subject, so a refusal and an outage render a titled
 * page with nothing of the report in it — including what was reported, which would be a disclosure by itself.
 */
export const dynamic = 'force-dynamic';

export default async function Page({
  params,
}: {
  readonly params: Promise<{ readonly reportId: string }>;
}) {
  const section = sectionByHref('/moderation/reports');
  if (section === null) return null;

  const [{ reportId }, sections, t] = await Promise.all([
    params,
    getTranslations('Sections'),
    getTranslations('Moderation'),
  ]);

  return (
    <RequireStaff permission={section.permission}>
      <PageContainer>
        <div className="py-10">
          <Heading level={1}>{t('reportTitle')}</Heading>
          <p className="mt-2">
            <Link href={adminPath('/moderation/reports')} className="text-sm underline underline-offset-4">
              {sections('moderation.title')}
            </Link>
          </p>
          <ModerationReportDetailView reportId={reportId} />
        </div>
      </PageContainer>
    </RequireStaff>
  );
}
