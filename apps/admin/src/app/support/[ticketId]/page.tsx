import { Heading, PageContainer } from '@repo/ui';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { RequireStaff } from '../../../components/require-staff';
import { SupportTicketDetail } from '../../../components/support-console-views';
import { sectionByHref } from '../../../server/console-sections';

/**
 * One support ticket, for the colleague working it (Phase 7-L).
 *
 * **The gate is inside the page and every read is inside the gate**, so a colleague who may not read this
 * section performs no read and receives none of a ticket — in the markup or in the flight data. The ticket
 * itself is then gated a second time by the database, which answers only for a ticket assigned to the caller or
 * to nobody; a ticket a colleague holds is the same `notFound` as one that does not exist.
 *
 * The heading is the section's rather than the ticket's subject, so a refusal and an outage render a titled
 * page with nothing of the ticket in it — including its subject, which would otherwise be a disclosure all by
 * itself.
 */
export const dynamic = 'force-dynamic';

export default async function Page({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly ticketId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const section = sectionByHref('/support');
  if (section === null) return null;

  const [{ ticketId }, query, sections, t] = await Promise.all([
    params,
    searchParams,
    getTranslations('Sections'),
    getTranslations('SupportConsole'),
  ]);

  return (
    <RequireStaff permission={section.permission}>
      <PageContainer>
        <div className="py-10">
          <Heading level={1}>{t('ticketTitle')}</Heading>
          <p className="mt-2">
            <Link href="/support" className="text-sm underline underline-offset-4">
              {sections('support.title')}
            </Link>
          </p>
          <SupportTicketDetail ticketId={ticketId} cursor={single(query['cursor'])} />
        </div>
      </PageContainer>
    </RequireStaff>
  );
}

function single(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}
