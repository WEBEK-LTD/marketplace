import { Heading, PageContainer } from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import { RequireStaff } from '../../components/require-staff';
import { DisputeQueue } from '../../components/dispute-management-views';
import { sectionByHref } from '../../server/console-sections';

/**
 * The dispute queue (Phase 7-R).
 *
 * **The gate is a server component inside the page, and everything else is inside it.** Nothing above
 * `RequireStaff` reads anything or renders anything about a dispute, so a colleague who may not open this
 * section receives a refusal and no data — not hidden data, no data. The permission comes from the section list
 * rather than from a string typed here, so this page and the navigation entry pointing at it can never disagree
 * about who may open it; 7-F already seeded that entry with `disputes.dispute.read`.
 *
 * That gate refuses a Moderator, who holds neither dispute key by the platform's own decision.
 *
 * **Oldest first**, unlike the review queue: somebody is out of pocket while a dispute waits, so the useful end
 * of this list is the end that has waited longest.
 *
 * **The status filter offers two values**, because only `open` and `resolved` are reachable — no writer in this
 * platform puts a dispute into any other state. Offering the other four would promise a workflow that does not
 * exist.
 */
export const dynamic = 'force-dynamic';

export default async function Page({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const section = sectionByHref('/disputes');
  if (section === null) return null;

  const query = await searchParams;
  const [sections, t] = await Promise.all([
    getTranslations('Sections'),
    getTranslations('Disputes'),
  ]);

  return (
    <RequireStaff permission={section.permission}>
      <PageContainer>
        <div className="py-10">
          <Heading level={1}>{sections('disputes.title')}</Heading>
          <p className="mt-2 max-w-prose text-neutral-600">{t('queueIntro')}</p>
          <p className="mt-2 max-w-prose text-sm text-neutral-600">{t('boundaryNote')}</p>
          <DisputeQueue cursor={single(query['cursor'])} status={single(query['status'])} />
        </div>
      </PageContainer>
    </RequireStaff>
  );
}

/** One value, or none. A repeated parameter is not two positions; it is a malformed address. */
function single(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}
