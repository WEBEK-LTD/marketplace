import { Heading, PageContainer } from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import { RequireStaff } from '../../../../admin/components/require-staff';
import { DisputeDetailView } from '../../../../admin/components/dispute-management-views';
import { sectionByHref } from '../../../../admin/server/console-sections';

/**
 * One dispute (Phase 7-R).
 *
 * Two reads inside the gate, both behind `disputes.dispute.read`: the dispute with the order it is about, and
 * its thread including the internal staff notes. A dispute that does not exist and a caller without that key
 * are answered identically.
 *
 * **Acting is a second key.** `disputes.dispute.manage` is not `disputes.dispute.read`, so the API reports
 * `canManage` as a capability and a colleague who may only read is shipped neither control nor the words for
 * either.
 *
 * **A resolution records a decision and moves no money.** Choosing a refund resolution records that a refund is
 * owed; issuing it is a separate, later operation that does not exist in this platform yet, and the page says so
 * beside the control, beside a recorded decision, and in its standing note.
 *
 * **No evidence panel**, because nothing in this platform attaches evidence to a dispute yet — and nothing here
 * assigns a dispute or changes its due date, for the same reason.
 */
export const dynamic = 'force-dynamic';

export default async function Page({ params }: { readonly params: Promise<{ disputeId: string }> }) {
  const section = sectionByHref('/disputes');
  if (section === null) return null;

  const { disputeId } = await params;
  const [sections, t] = await Promise.all([
    getTranslations('Sections'),
    getTranslations('Disputes'),
  ]);

  return (
    <RequireStaff permission={section.permission}>
      <PageContainer>
        <div className="py-10">
          <Heading level={1}>{sections('disputes.title')}</Heading>
          <p className="mt-2 max-w-prose text-neutral-600">{t('detailIntro')}</p>
          <DisputeDetailView disputeId={disputeId} />
        </div>
      </PageContainer>
    </RequireStaff>
  );
}
