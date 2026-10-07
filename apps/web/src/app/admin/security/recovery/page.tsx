import { Heading, PageContainer } from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import { RequireStaff } from '../../../../admin/components/require-staff';
import { RecoveryQueue } from '../../../../admin/components/admin-operations-views';
import { sectionByHref } from '../../../../admin/server/console-sections';

/**
 * The account recovery queue (Phase 7-O).
 *
 * The gate is inside the page and the read is inside the gate, gated on `security.recovery.review`, which
 * 7-F seeded on this section — a key a support agent holds and a moderator does not.
 *
 * **Oldest first**, because these are people locked out of their accounts and a queue of them is worked in
 * the order they arrived. There is no score, no SLA and no statistic anywhere on this page.
 */
export const dynamic = 'force-dynamic';

export default async function Page({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const section = sectionByHref('/security/recovery');
  if (section === null) return null;

  const query = await searchParams;
  const [sections, t] = await Promise.all([
    getTranslations('Sections'),
    getTranslations('AdminOps'),
  ]);

  return (
    <RequireStaff permission={section.permission}>
      <PageContainer>
        <div className="py-10">
          <Heading level={1}>{sections('recovery.title')}</Heading>
          <p className="mt-2 max-w-prose text-neutral-600">{t('recoveryIntro')}</p>
          <RecoveryQueue cursor={single(query['cursor'])} status={single(query['status'])} />
        </div>
      </PageContainer>
    </RequireStaff>
  );
}

/** One value, or none. A repeated parameter is not two positions; it is a malformed address. */
function single(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}
