import { Heading, PageContainer } from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import { RequireStaff } from '../../components/require-staff';
import { ReviewQueue } from '../../components/review-moderation-views';
import { sectionByHref } from '../../server/console-sections';

/**
 * The review queue (Phase 7-P).
 *
 * **The gate is a server component inside the page, and everything else is inside it.** Nothing above
 * `RequireStaff` reads anything or renders anything about a review, so a colleague who may not read this
 * section receives a refusal and no data — not hidden data, no data. The permission comes from the section
 * list rather than from a string typed here, so this page and the navigation entry pointing at it can never
 * disagree about who may open it; 7-F already seeded that entry with `reviews.review.read`.
 *
 * **Newest first**, unlike the support and recovery queues: a review is published the moment it is written
 * rather than arriving in a state that needs draining, so the useful end of the list is the recent one. The
 * status filter is 0026's own four; a value that is not one of them is dropped rather than refused, so a
 * mistyped bookmark shows the whole queue.
 */
export const dynamic = 'force-dynamic';

export default async function Page({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const section = sectionByHref('/reviews');
  if (section === null) return null;

  const query = await searchParams;
  const [sections, t] = await Promise.all([
    getTranslations('Sections'),
    getTranslations('Reviews'),
  ]);

  return (
    <RequireStaff permission={section.permission}>
      <PageContainer>
        <div className="py-10">
          <Heading level={1}>{sections('reviews.title')}</Heading>
          <p className="mt-2 max-w-prose text-neutral-600">{t('queueIntro')}</p>
          <ReviewQueue cursor={single(query['cursor'])} status={single(query['status'])} />
        </div>
      </PageContainer>
    </RequireStaff>
  );
}

/** One value, or none. A repeated parameter is not two positions; it is a malformed address. */
function single(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}
