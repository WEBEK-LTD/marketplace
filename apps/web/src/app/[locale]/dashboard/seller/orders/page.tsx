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
import { readSellerOrders } from '../../../../../server/bff';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('SellerOrders');
  return { title: t('title'), robots: { index: false, follow: false } };
}

/**
 * `/dashboard/seller/orders` — the orders placed with the caller's own storefront (Phase 6-J).
 *
 * **Read-only, and there is nothing here that could become otherwise.** No form, no button, no client
 * component: no "change status", no "refund", no "cancel", no "mark shipped". A seller cannot move an order
 * anywhere in this API, so this page offers no copy suggesting they can.
 *
 * Every amount is rendered through `@repo/money` at the currency's own minor unit, which travels with each
 * order, so nothing here assumes two decimal places and no divisor is written in this file.
 *
 * Each item shows the title and slug the order snapshotted at purchase. That is deliberate: a listing that
 * has since been retitled or archived must not change what an old order says it was.
 */
export default async function SellerOrdersPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: Locale }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ locale }, query, t, dashboard, session, sellers] = await Promise.all([
    params,
    searchParams,
    getTranslations('SellerOrders'),
    getTranslations('SellerDashboard'),
    getTranslations('Session'),
    getTranslations('Sellers'),
  ]);

  const cursorParam = query['cursor'];
  const cursor = typeof cursorParam === 'string' && cursorParam !== '' ? cursorParam : null;
  const cookieHeader = (await headers()).get('cookie');
  const lookup = await readSellerOrders({ cookieHeader, cursor });

  const statusLabel = (status: string): string => {
    const labels: Record<string, string> = {
      pending_payment: t('statusPendingPayment'),
      paid: t('statusPaid'),
      processing: t('statusProcessing'),
      shipped: t('statusShipped'),
      delivered: t('statusDelivered'),
      completed: t('statusCompleted'),
      cancelled: t('statusCancelled'),
      refund_requested: t('statusRefundRequested'),
      refunded: t('statusRefunded'),
      disputed: t('statusDisputed'),
      requested: t('statusRequested'),
      accepted: t('statusAccepted'),
      in_progress: t('statusInProgress'),
      revision_requested: t('statusRevisionRequested'),
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
      {lookup.kind !== 'ok' ? null : lookup.data.orders.length === 0 ? (
        <p role="status" className="mt-6 text-ink-muted">
          {t('empty')}
        </p>
      ) : (
        <ul className="mt-6 space-y-4">
          {lookup.data.orders.map((order) => {
            const money = (amount: string): string =>
              formatListingAmount(amount, order.currencyCode, order.currencyDecimalPlaces) ?? amount;
            return (
              <li key={order.orderNumber} className="rounded-lg border border-hairline p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm">
                    <span className="text-ink-muted">{t('orderNumber')} </span>
                    <span className="font-medium">{order.orderNumber}</span>
                    <span className="text-ink-muted">
                      {' '}
                      · {order.orderType === 'service' ? t('typeService') : t('typeProduct')}
                    </span>
                  </p>
                  <p className="text-sm font-medium">{statusLabel(order.status)}</p>
                </div>

                <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <SellerFact label={t('subtotal')} value={money(order.subtotalMinor)} />
                  <SellerFact label={t('shipping')} value={money(order.shippingTotalMinor)} />
                  <SellerFact label={t('tax')} value={money(order.taxTotalMinor)} />
                  <SellerFact label={t('discount')} value={money(order.discountTotalMinor)} />
                  <SellerFact label={t('grandTotal')} value={money(order.grandTotalMinor)} />
                  <SellerFact label={t('commission')} value={money(order.commissionTotalMinor)} />
                  <SellerFact label={t('sellerNet')} value={money(order.sellerNetMinor)} />
                  <SellerFact label={t('placed')} value={order.placedAt.slice(0, 10)} />
                </dl>

                <h3 className="mt-4 text-sm font-medium">{t('items')}</h3>
                {order.items.length === 0 ? (
                  <p className="mt-1 text-sm text-ink-muted">{t('noItems')}</p>
                ) : (
                  <ul className="mt-1 divide-y divide-hairline">
                    {order.items.map((item) => (
                      <li key={`${item.slug}-${item.title}`} className="py-2 text-sm">
                        <span className="font-medium">{item.title}</span>
                        <span className="text-ink-muted">
                          {' '}
                          — {t('quantity')} {item.quantity}
                          {item.cancelledQuantity > 0
                            ? ` · ${t('cancelledQuantity')} ${item.cancelledQuantity}`
                            : ''}{' '}
                          · {money(item.lineTotalMinor)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {lookup.kind === 'ok' ? (
        <SellerSurfacePager
          locale={locale}
          path="/dashboard/seller/orders"
          cursor={lookup.data.nextCursor}
          label={t('nextPage')}
        />
      ) : null}
    </SellerReadSurface>
  );
}
