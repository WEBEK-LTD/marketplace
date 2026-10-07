import { Heading, PageContainer } from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import { RequireStaff } from '../../../../../admin/components/require-staff';
import { RecoveryRequestDetailView } from '../../../../../admin/components/admin-operations-views';
import { sectionByHref } from '../../../../../admin/server/console-sections';

/**
 * One recovery request (Phase 7-O).
 *
 * The gate is inside the page and every read and every control is inside the gate. Exactly one control is
 * ever shipped, and only when the database would accept it from this colleague: the account holder is
 * refused at every step, and the reviewer cannot be the second approver. Where no control is offered, the
 * page says which rule is in the way rather than leaving a colleague clicking at a refusal.
 */
export const dynamic = 'force-dynamic';

export default async function Page({
  params,
}: {
  readonly params: Promise<{ requestId: string }>;
}) {
  const section = sectionByHref('/security/recovery');
  if (section === null) return null;

  const { requestId } = await params;
  const [sections, t] = await Promise.all([
    getTranslations('Sections'),
    getTranslations('AdminOps'),
  ]);

  return (
    <RequireStaff permission={section.permission}>
      <PageContainer>
        <div className="py-10">
          <Heading level={1}>{sections('recovery.title')}</Heading>
          <p className="mt-2 max-w-prose text-neutral-600">{t('recoveryDetailIntro')}</p>
          <RecoveryRequestDetailView requestId={requestId} />
        </div>
      </PageContainer>
    </RequireStaff>
  );
}
