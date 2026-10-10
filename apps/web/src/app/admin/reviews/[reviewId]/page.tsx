import { Heading, PageContainer } from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import { RequireStaff } from '../../../../admin/components/require-staff';
import { ReviewDetailView } from '../../../../admin/components/review-moderation-views';
import { sectionByHref } from '../../../../admin/server/console-sections';

/**
 * One review (Phase 7-P).
 *
 * Two reads behind two different keys, both inside the gate. The review itself needs `reviews.review.read`,
 * which is this section's own; its moderation trail needs `moderation.action.read`, which is 0027's key and
 * which a colleague holding both review keys does not necessarily hold — so that panel is absent rather than
 * empty when the key is missing.
 *
 * **The decision control is a third key.** `reviews.review.moderate` is not `reviews.review.read`, so the API
 * reports `canModerate` as a capability and a colleague who may only read is shipped neither the control nor
 * the words for it.
 *
 * **The seller's reply is read-only**, for the reason the page states: no writer for a reply's status exists
 * in this repository, and inventing one would mean deciding the platform's reply-moderation rules here.
 */
export const dynamic = 'force-dynamic';

export default async function Page({ params }: { readonly params: Promise<{ reviewId: string }> }) {
  const section = sectionByHref('/reviews');
  if (section === null) return null;

  const { reviewId } = await params;
  const [sections, t] = await Promise.all([
    getTranslations('Sections'),
    getTranslations('Reviews'),
  ]);

  return (
    <RequireStaff permission={section.permission}>
      <PageContainer>
        <div className="py-10">
          <Heading level={1}>{sections('reviews.title')}</Heading>
          <p className="mt-2 max-w-prose text-ink-muted">{t('detailIntro')}</p>
          <ReviewDetailView reviewId={reviewId} />
        </div>
      </PageContainer>
    </RequireStaff>
  );
}
