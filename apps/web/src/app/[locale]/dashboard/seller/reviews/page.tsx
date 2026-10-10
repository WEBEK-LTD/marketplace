import type { Locale } from '@repo/shared-types';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import {
  SellerFact,
  SellerReadSurface,
  SellerSurfacePager,
} from '../../../../../components/seller-read-surface';
import { readSellerReviews } from '../../../../../server/bff';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('SellerReviews');
  return { title: t('title'), robots: { index: false, follow: false } };
}

/**
 * `/dashboard/seller/reviews` — the reviews on the caller's own storefront (Phase 6-J).
 *
 * **Read-only.** No "moderate", no "hide", no "remove", no "reply" — a reply writer exists in the database
 * but no approved seller surface calls it, and inventing one here would be adding a write to a read-only
 * increment. So this page shows a reply the seller has already written and offers no way to write one.
 *
 * A seller sees their own reviews in every state, because the reviews table's own policy says the owner may.
 * What they never see is *why* a state was reached: no moderation reason, moderator or auto-hidden reason is
 * in the contract this page reads, so there is nothing to render even by accident.
 *
 * **The average is the `seller_ratings` view's**, in basis points, divided by 10000 only for display — the
 * number itself is never recomputed, and the page says plainly that the summary counts published reviews
 * only, which is why it can legitimately disagree with the list beneath it.
 */
export default async function SellerReviewsPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: Locale }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ locale }, query, t, dashboard, session, sellers] = await Promise.all([
    params,
    searchParams,
    getTranslations('SellerReviews'),
    getTranslations('SellerDashboard'),
    getTranslations('Session'),
    getTranslations('Sellers'),
  ]);

  const cursorParam = query['cursor'];
  const cursor = typeof cursorParam === 'string' && cursorParam !== '' ? cursorParam : null;
  const cookieHeader = (await headers()).get('cookie');
  const lookup = await readSellerReviews({ cookieHeader, cursor });

  const statusLabel = (status: string): string => {
    const labels: Record<string, string> = {
      published: t('statusPublished'),
      pending_moderation: t('statusPendingModeration'),
      hidden: t('statusHidden'),
      removed: t('statusRemoved'),
    };
    return labels[status] ?? status;
  };

  return (
    <SellerReadSurface
      locale={locale}
      title={t('title')}
      intro={t('intro')}
      state={lookup.kind === 'ok' ? { kind: 'ok' } : { kind: lookup.kind }}
      unavailableTitle={t('errorUnavailable')}
      unavailableDescription={sellers('error')}
      notASellerLabel={dashboard('notASeller')}
      dashboardLabel={dashboard('title')}
      sessionBody={session('expiredBody')}
      signInLabel={session('signIn')}
    >
      {lookup.kind !== 'ok' ? null : (
        <>
          <section aria-labelledby="seller-rating-heading" className="mt-6">
            <h2 id="seller-rating-heading" className="text-lg font-semibold text-ink-strong">
              {t('summary')}
            </h2>
            {lookup.data.summary === null ? (
              <p role="status" className="mt-2 text-ink-muted">
                {t('noSummary')}
              </p>
            ) : (
              <>
                <dl className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <SellerFact
                    label={t('average')}
                    // The view's basis points, shown as stars. The stored number is never rewritten.
                    value={(lookup.data.summary.averageRatingBasisPoints / 10_000).toFixed(2)}
                  />
                  <SellerFact
                    label={t('reviewCount')}
                    value={String(lookup.data.summary.reviewCount)}
                  />
                  <SellerFact
                    label={t('latest')}
                    value={lookup.data.summary.latestReviewAt?.slice(0, 10) ?? '—'}
                  />
                </dl>
                <h3 className="mt-4 text-sm font-medium">{t('distribution')}</h3>
                <ul className="mt-1 text-sm text-ink-body">
                  {(
                    [
                      [5, lookup.data.summary.fiveStarCount],
                      [4, lookup.data.summary.fourStarCount],
                      [3, lookup.data.summary.threeStarCount],
                      [2, lookup.data.summary.twoStarCount],
                      [1, lookup.data.summary.oneStarCount],
                    ] as const
                  ).map(([stars, count]) => (
                    <li key={stars}>
                      {stars} {t('stars')}: {count}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-ink-muted">{t('summaryNote')}</p>
              </>
            )}
          </section>

          {lookup.data.reviews.length === 0 ? (
            <p role="status" className="mt-6 text-ink-muted">
              {t('empty')}
            </p>
          ) : (
            <ul className="mt-6 space-y-4">
              {lookup.data.reviews.map((review) => (
                <li
                  key={review.orderNumber}
                  className="rounded-lg border border-hairline p-4"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="text-sm">
                      <span className="font-medium">
                        {review.rating} {t('stars')}
                      </span>
                      <span className="text-ink-muted">
                        {' '}
                        · {t('orderNumber')} {review.orderNumber}
                      </span>
                    </p>
                    <p className="text-sm text-ink-muted">{statusLabel(review.status)}</p>
                  </div>
                  {review.title === null ? null : (
                    <p className="mt-2 text-sm font-medium">{review.title}</p>
                  )}
                  {review.body === null ? null : (
                    <p className="mt-1 max-w-prose text-sm text-ink-body">{review.body}</p>
                  )}
                  <h3 className="mt-3 text-xs font-medium text-ink-muted">{t('yourReply')}</h3>
                  {review.replyBody === null ? (
                    <p className="text-sm text-ink-muted">{t('noReply')}</p>
                  ) : (
                    <p className="max-w-prose text-sm text-ink-body">{review.replyBody}</p>
                  )}
                </li>
              ))}
            </ul>
          )}

          <SellerSurfacePager
            locale={locale}
            path="/dashboard/seller/reviews"
            cursor={lookup.data.nextCursor}
            label={t('nextPage')}
          />
        </>
      )}
    </SellerReadSurface>
  );
}
