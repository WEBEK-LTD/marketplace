import { Heading, PageContainer } from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import { RequireStaff } from '../../../admin/components/require-staff';
import { SupportAssigned, SupportQueue } from '../../../admin/components/support-console-views';
import { sectionByHref } from '../../../admin/server/console-sections';

/**
 * The support agent console's two lists (Phase 7-L).
 *
 * **The gate is a server component inside the page, and everything else is inside it.** Nothing above
 * `RequireStaff` reads anything or renders anything about a ticket, so a colleague who may not read receives a
 * refusal and no data — not hidden data, no data. The permission comes from the section list rather than from a
 * string typed here, so this page and the navigation entry pointing at it can never disagree about who may open
 * it; 7-F already seeded that entry with `support.ticket.read`.
 *
 * **Two lists, two reads, two cursors.** The shared queue is the tickets nobody has claimed, oldest first; the
 * second list is the caller's own, newest first. They are separate operations in the database rather than one
 * with a filter, so there is no parameter either could get wrong — and each pages independently, which is why
 * the queue reads `?cursor=` and the caller's own list reads `?mine=`.
 *
 * There is no dashboard, no count of anybody else's work, no SLA and no invented statistic here: the page shows
 * what is waiting and what the reader is holding.
 */
export const dynamic = 'force-dynamic';

export default async function Page({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const section = sectionByHref('/support');
  if (section === null) return null;

  const query = await searchParams;
  const [sections, t] = await Promise.all([
    getTranslations('Sections'),
    getTranslations('SupportConsole'),
  ]);

  return (
    <RequireStaff permission={section.permission}>
      <PageContainer>
        <div className="py-10">
          <Heading level={1}>{sections('support.title')}</Heading>
          <p className="mt-2 max-w-prose text-neutral-600">{sections('support.description')}</p>

          <section aria-labelledby="support-mine" className="mt-8">
            <h2 id="support-mine" className="text-lg font-medium text-neutral-900">
              {t('assignedHeading')}
            </h2>
            <p className="mt-1 max-w-prose text-sm text-neutral-600">{t('assignedIntro')}</p>
            <SupportAssigned cursor={single(query['mine'])} />
          </section>

          <section aria-labelledby="support-queue" className="mt-12">
            <h2 id="support-queue" className="text-lg font-medium text-neutral-900">
              {t('queueHeading')}
            </h2>
            <p className="mt-1 max-w-prose text-sm text-neutral-600">{t('queueIntro')}</p>
            <SupportQueue cursor={single(query['cursor'])} />
          </section>
        </div>
      </PageContainer>
    </RequireStaff>
  );
}

/** One value, or none. A repeated parameter is not two positions; it is a malformed address. */
function single(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}
