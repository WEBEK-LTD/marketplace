import type { Locale } from '@repo/shared-types';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { SellerFact, SellerReadSurface } from '../../../../../components/seller-read-surface';
import { readSellerAnalytics } from '../../../../../server/bff';

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
 * **Per-listing analytics is absent, and the page says so.** The raw listing events exist but no rollup
 * covers them, so counting them would mean deciding what a view is and how to de-duplicate a session. A
 * truthful sentence is better than a fabricated number.
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
  const lookup = await readSellerAnalytics({ cookieHeader });

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
          <p className="mt-6 text-sm text-neutral-500">
            {t('window', { days: lookup.data.days })}
          </p>

          {lookup.data.promotions.length === 0 ? (
            <p role="status" className="mt-2 text-neutral-600">
              {t('empty')}
            </p>
          ) : (
            <ul className="mt-2 space-y-4">
              {lookup.data.promotions.map((row) => (
                <li
                  key={`${row.listingSlug}-${row.firstDay}`}
                  className="rounded-lg border border-neutral-200 p-4"
                >
                  <p className="text-sm">
                    <span className="text-neutral-500">{t('listing')} </span>
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
                  <p className="mt-2 text-xs text-neutral-500">
                    {t('status')}: {statusLabel(row.status)}
                  </p>
                </li>
              ))}
            </ul>
          )}

          {/* The honest statement about what is not here, rather than a fabricated per-listing chart. */}
          <p className="mt-6 max-w-prose text-sm text-neutral-600">{t('listingNote')}</p>
        </>
      )}
    </SellerReadSurface>
  );
}
