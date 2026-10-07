import { Heading, PageContainer } from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import { RequireStaff } from '../../../admin/components/require-staff';
import { AuditTrail } from '../../../admin/components/admin-operations-views';
import { sectionByHref } from '../../../admin/server/console-sections';

/**
 * The audit trail (Phase 7-O).
 *
 * The gate is inside the page and the read is inside the gate, gated on `audit.read` — a key only an
 * administrator holds.
 *
 * **Strictly read-only, and it shows names rather than values.** A row says which columns changed, not what
 * they changed to: the old and new rows are whole-row JSON redacted per calling trigger, so a screen
 * carrying them would expose every unredacted column of every audited table to anybody holding this one key.
 * Reading this page writes nothing to the trail.
 *
 * The two filters are the ones the audit indexes support. There is deliberately no actor filter and no
 * dashboard: assembling one colleague's activity is not what an audit read is for.
 */
export const dynamic = 'force-dynamic';

export default async function Page({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const section = sectionByHref('/audit');
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
          <Heading level={1}>{sections('audit.title')}</Heading>
          <p className="mt-2 max-w-prose text-neutral-600">{t('auditIntro')}</p>
          <AuditTrail
            cursor={single(query['cursor'])}
            tableSchema={single(query['tableSchema'])}
            tableName={single(query['tableName'])}
            recordId={single(query['recordId'])}
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
