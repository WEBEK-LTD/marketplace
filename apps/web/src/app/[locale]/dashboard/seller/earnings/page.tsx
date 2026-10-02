import type { Locale } from '@repo/shared-types';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { formatListingAmount } from '../../../../../components/listing-price';
import { SellerFact, SellerReadSurface } from '../../../../../components/seller-read-surface';
import { readSellerEarnings } from '../../../../../server/bff';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('SellerEarnings');
  return { title: t('title'), robots: { index: false, follow: false } };
}

/**
 * `/dashboard/seller/earnings` — the caller's own balances (Phase 6-J).
 *
 * **Read-only, and this is the page where that matters most.** There is no "withdraw", no "transfer", no
 * "payout", no bank details and no way to reach any of them: no such operation exists in this API, so no
 * copy on this page implies one. The note beneath the balances says so in plain words rather than leaving
 * somebody hunting for a button.
 *
 * **Three amounts per currency, and no total.** Pending, available and reserved are what the balances table
 * keeps. Adding them would be a claim about what the seller is owed, and no formula in this repository
 * establishes one, so this page shows the three and invents no fourth.
 *
 * Nothing from the ledger is here — no journal, no entry, no account — because the contract this page reads
 * carries none of it.
 */
export default async function SellerEarningsPage({
  params,
}: {
  readonly params: Promise<{ readonly locale: Locale }>;
}) {
  const [{ locale }, t, dashboard, session, sellers] = await Promise.all([
    params,
    getTranslations('SellerEarnings'),
    getTranslations('SellerDashboard'),
    getTranslations('Session'),
    getTranslations('Sellers'),
  ]);

  const cookieHeader = (await headers()).get('cookie');
  const lookup = await readSellerEarnings({ cookieHeader });

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
      {lookup.kind !== 'ok' ? null : lookup.data.balances.length === 0 ? (
        <p role="status" className="mt-6 text-neutral-600">
          {t('empty')}
        </p>
      ) : (
        <>
          <ul className="mt-6 space-y-4">
            {lookup.data.balances.map((balance) => {
              const money = (amount: string): string =>
                formatListingAmount(amount, balance.currencyCode, balance.currencyDecimalPlaces) ??
                amount;
              return (
                <li
                  key={balance.currencyCode}
                  className="rounded-lg border border-neutral-200 p-4"
                >
                  <p className="text-sm">
                    <span className="text-neutral-500">{t('currency')} </span>
                    <span className="font-medium">{balance.currencyCode}</span>
                  </p>
                  <dl className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <SellerFact
                      label={t('available')}
                      value={money(balance.availableMinor)}
                      hint={t('availableHint')}
                    />
                    <SellerFact
                      label={t('pending')}
                      value={money(balance.pendingMinor)}
                      hint={t('pendingHint')}
                    />
                    <SellerFact
                      label={t('reserved')}
                      value={money(balance.reservedMinor)}
                      hint={t('reservedHint')}
                    />
                  </dl>
                  <p className="mt-3 text-xs text-neutral-500">
                    {t('updated')}: {balance.updatedAt.slice(0, 10)}
                  </p>
                </li>
              );
            })}
          </ul>
          {/* Said plainly, because a balance with no visible action invites hunting for one. */}
          <p className="mt-4 max-w-prose text-sm text-neutral-600">{t('note')}</p>
        </>
      )}
    </SellerReadSurface>
  );
}
