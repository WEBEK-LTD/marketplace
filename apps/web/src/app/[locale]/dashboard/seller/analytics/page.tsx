import type { Locale } from '@repo/shared-types';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { SellerFact, SellerReadSurface } from '../../../../../components/seller-read-surface';
import { readSellerAnalytics, readSellerListingAnalytics } from '../../../../../server/bff';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('SellerAnalytics');
  return { title: t('title'), robots: { index: false, follow: false } };
}

/**
 * `/dashboard/seller/analytics` — how the caller's own promotions performed (Phase 6-J).
 *
 * **Every number on this page was computed by a scheduled job**, not here: the impressions, views and clicks
 * are the `promotion_analytics` rollup's own rows, summed over the window. There is no chart built from a
 * guessed formula, no click-through rate, no conversion rate and no trend line, because none of those has an
 * established business definition in this repository and inventing one would be inventing a KPI.
 *
 * **Per-listing analytics arrived with 0102**, as a second section over its own rollup: clicks, contacts,
 * favourites and shares. Impressions and views are still absent for listings, and the page still says so,
 * because counting them would mean deciding what a view is and how to de-duplicate a session. The two
 * sections read two separate operations; neither one's shape depends on the other.
 *
 * **The two reads are independent.** A listing rollup that cannot be read must not take the promotion
 * section down with it, so each section renders or reports its own absence.
 */
export default async function SellerAnalyticsPage({
  params,
}: {
  readonly params: Promise<{ readonly locale: Locale }>;
}) {
  const [{ locale }, t, promotions, dashboard, session, sellers] = await Promise.all([
    params,
    getTranslations('SellerAnalytics'),
    // A row here is a promotion, so its status labels are the promotions page's own rather than a second
    // copy of the same nine words.
    getTranslations('SellerPromotions'),
    getTranslations('SellerDashboard'),
    getTranslations('Session'),
    getTranslations('Sellers'),
  ]);

  const cookieHeader = (await headers()).get('cookie');
  const [lookup, listings] = await Promise.all([
    readSellerAnalytics({ cookieHeader }),
    readSellerListingAnalytics({ cookieHeader }),
  ]);

  const statusLabel = (status: string): string => {
    const labels: Record<string, string> = {
      draft: promotions('statusDraft'),
      pending_payment: promotions('statusPendingPayment'),
      paid: promotions('statusPaid'),
      scheduled: promotions('statusScheduled'),
      active: promotions('statusActive'),
      paused: promotions('statusPaused'),
      expired: promotions('statusExpired'),
      cancelled: promotions('statusCancelled'),
      refunded: promotions('statusRefunded'),
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
          <p className="mt-6 text-sm text-ink-muted">
            {t('window', { days: lookup.data.days })}
          </p>

          <h2 className="mt-8 text-lg font-medium text-ink-strong">{t('promotionsHeading')}</h2>

          {lookup.data.promotions.length === 0 ? (
            <p role="status" className="mt-2 text-ink-muted">
              {t('empty')}
            </p>
          ) : (
            <ul className="mt-2 space-y-4">
              {lookup.data.promotions.map((row) => (
                <li
                  key={`${row.listingSlug}-${row.firstDay}`}
                  className="rounded-lg border border-hairline p-4"
                >
                  <p className="text-sm">
                    <span className="text-ink-muted">{t('listing')} </span>
                    <span className="font-medium">{row.listingTitle}</span>
                  </p>
                  <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <SellerFact label={t('impressions')} value={row.impressions} />
                    <SellerFact label={t('views')} value={row.views} />
                    <SellerFact label={t('clicks')} value={row.clicks} />
                    <SellerFact
                      label={t('period')}
                      value={`${row.firstDay} — ${row.lastDay}`}
                    />
                  </dl>
                  <p className="mt-2 text-xs text-ink-muted">
                    {t('status')}: {statusLabel(row.status)}
                  </p>
                </li>
              ))}
            </ul>
          )}

          <h2 className="mt-10 text-lg font-medium text-ink-strong">{t('listingsHeading')}</h2>

          {listings.kind !== 'ok' ? (
            // Its own failure, reported where it happened: the promotion section above still rendered.
            <p role="status" className="mt-2 text-ink-muted">
              {t('errorUnavailable')}
            </p>
          ) : listings.data.listings.length === 0 ? (
            <p role="status" className="mt-2 text-ink-muted">
              {t('listingsEmpty')}
            </p>
          ) : (
            <ul className="mt-2 space-y-4">
              {listings.data.listings.map((row) => (
                <li
                  key={`${row.listingSlug}-${row.firstDay}`}
                  className="rounded-lg border border-hairline p-4"
                >
                  <p className="text-sm">
                    <span className="text-ink-muted">{t('listing')} </span>
                    <span className="font-medium">{row.listingTitle}</span>
                  </p>
                  <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
                    <SellerFact label={t('clicks')} value={row.clicks} />
                    <SellerFact label={t('contacts')} value={row.contacts} />
                    <SellerFact label={t('favorites')} value={row.favorites} />
                    <SellerFact label={t('shares')} value={row.shares} />
                    <SellerFact label={t('period')} value={`${row.firstDay} — ${row.lastDay}`} />
                  </dl>
                </li>
              ))}
            </ul>
          )}

          {/* What is still not here, said plainly rather than filled in with a number nobody agreed. */}
          <p className="mt-6 max-w-prose text-sm text-ink-muted">{t('listingNote')}</p>
        </>
      )}
    </SellerReadSurface>
  );
}
