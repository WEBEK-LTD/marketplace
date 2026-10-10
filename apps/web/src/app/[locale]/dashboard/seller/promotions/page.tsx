import type { Locale } from '@repo/shared-types';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { formatListingAmount } from '../../../../../components/listing-price';
import {
  SellerFact,
  SellerReadSurface,
  SellerSurfacePager,
} from '../../../../../components/seller-read-surface';
import { readSellerPromotions } from '../../../../../server/bff';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('SellerPromotions');
  return { title: t('title'), robots: { index: false, follow: false } };
}

/**
 * `/dashboard/seller/promotions` — the caller's own promotions (Phase 6-J).
 *
 * **Read-only.** No "promote a listing", no "cancel", no "pay", no "extend". Writers for all of those exist
 * in the database and none is reachable from here or from anywhere else in this API, so this page offers no
 * copy that implies otherwise.
 */
export default async function SellerPromotionsPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: Locale }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ locale }, query, t, dashboard, session, sellers] = await Promise.all([
    params,
    searchParams,
    getTranslations('SellerPromotions'),
    getTranslations('SellerDashboard'),
    getTranslations('Session'),
    getTranslations('Sellers'),
  ]);

  const cursorParam = query['cursor'];
  const cursor = typeof cursorParam === 'string' && cursorParam !== '' ? cursorParam : null;
  const cookieHeader = (await headers()).get('cookie');
  const lookup = await readSellerPromotions({ cookieHeader, cursor });

  const statusLabel = (status: string): string => {
    const labels: Record<string, string> = {
      draft: t('statusDraft'),
      pending_payment: t('statusPendingPayment'),
      paid: t('statusPaid'),
      scheduled: t('statusScheduled'),
      active: t('statusActive'),
      paused: t('statusPaused'),
      expired: t('statusExpired'),
      cancelled: t('statusCancelled'),
      refunded: t('statusRefunded'),
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
      {lookup.kind !== 'ok' ? null : lookup.data.promotions.length === 0 ? (
        <p role="status" className="mt-6 text-ink-muted">
          {t('empty')}
        </p>
      ) : (
        <ul className="mt-6 space-y-4">
          {lookup.data.promotions.map((promotion) => {
            const money = (amount: string): string =>
              formatListingAmount(
                amount,
                promotion.currencyCode,
                promotion.currencyDecimalPlaces,
              ) ?? amount;
            return (
              <li
                key={`${promotion.listingSlug}-${promotion.createdAt}`}
                className="rounded-lg border border-hairline p-4"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm">
                    <span className="text-ink-muted">{t('listing')} </span>
                    <span className="font-medium">{promotion.listingTitle}</span>
                  </p>
                  <p className="text-sm font-medium">{statusLabel(promotion.status)}</p>
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <SellerFact label={t('price')} value={money(promotion.priceMinor)} />
                  <SellerFact
                    label={t('duration')}
                    value={`${promotion.durationDays} ${t('durationDays')}`}
                  />
                  <SellerFact label={t('priority')} value={String(promotion.priority)} />
                  <SellerFact label={t('created')} value={promotion.createdAt.slice(0, 10)} />
                  {promotion.startsAt === null ? null : (
                    <SellerFact label={t('starts')} value={promotion.startsAt.slice(0, 10)} />
                  )}
                  {promotion.endsAt === null ? null : (
                    <SellerFact label={t('ends')} value={promotion.endsAt.slice(0, 10)} />
                  )}
                  {promotion.refundedAmountMinor === '0' ? null : (
                    <SellerFact
                      label={t('refunded')}
                      value={money(promotion.refundedAmountMinor)}
                    />
                  )}
                </dl>
              </li>
            );
          })}
        </ul>
      )}

      {lookup.kind === 'ok' ? (
        <SellerSurfacePager
          locale={locale}
          path="/dashboard/seller/promotions"
          cursor={lookup.data.nextCursor}
          label={t('nextPage')}
        />
      ) : null}
    </SellerReadSurface>
  );
}
