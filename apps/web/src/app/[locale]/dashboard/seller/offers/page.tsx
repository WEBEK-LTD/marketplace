import type { Locale } from '@repo/shared-types';
import { Heading, PageContainer } from '@repo/ui';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { AccountEmpty, AccountError, AccountSkeleton } from '../../../../../components/account-views';
import { OffersReceivedList, type OfferCopy } from '../../../../../components/offer-views';
import { RequireSession } from '../../../../../components/require-session';
import { readOffersReceived } from '../../../../../server/bff';
import { offerCopy } from '../../../../../components/offer-copy';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('SellerOffers');
  return { title: t('title'), robots: { index: false, follow: false } };
}

/**
 * The offers made to the reader's storefront (Phase 7-H).
 *
 * The seller's side. It calls the operation that reads the offers made to this account's storefront, which
 * is a different function with a different fixed predicate from the buyer's — so somebody who is both a
 * buyer and a seller sees two separate lists rather than one mixed one, and neither page can be made to
 * show the other's rows.
 *
 * **Accepting is offered here and paying is not.** An acceptance records what becomes due and when; the
 * payment itself is Phase 8's, and no button on this page charges, reserves or orders anything.
 */
export default async function SellerOffersPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: Locale }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ locale }, query, t] = await Promise.all([
    params,
    searchParams,
    getTranslations('SellerOffers'),
  ]);
  const cursor = typeof query['cursor'] === 'string' ? query['cursor'] : null;
  const prefix = locale === 'ar' ? '/ar' : '';
  const base = `${prefix}/dashboard/seller/offers`;

  return (
    <RequireSession>
      <PageContainer>
        <div className="py-12">
          <Heading level={1}>{t('title')}</Heading>
          <p className="mt-2 max-w-prose text-neutral-600">{t('intro')}</p>

          <Suspense fallback={<AccountSkeleton label={t('title')} />}>
            <ReceivedSection cursor={cursor} base={base} prefix={prefix} copy={offerCopy(t, 'seller')} t={t} />
          </Suspense>
        </div>
      </PageContainer>
    </RequireSession>
  );
}

type Translate = Awaited<ReturnType<typeof getTranslations<'SellerOffers'>>>;

async function ReceivedSection({
  cursor,
  base,
  prefix,
  copy,
  t,
}: {
  readonly cursor: string | null;
  readonly base: string;
  readonly prefix: string;
  readonly copy: OfferCopy;
  readonly t: Translate;
}) {
  const requestHeaders = await headers();
  const result = await readOffersReceived({ cursor }, { cookieHeader: requestHeaders.get('cookie') });

  if (result.kind !== 'ok') {
    return <AccountError title={t('error')} retry={t('retry')} href={base} />;
  }
  if (result.data.items.length === 0) {
    return <AccountEmpty title={t('empty')} hint={t('emptyHint')} />;
  }

  const next = result.data.nextCursor;
  return (
    <>
      <OffersReceivedList items={result.data.items} copy={copy} localePrefix={prefix} />
      {next !== null && (
        <Link
          href={`${base}?cursor=${encodeURIComponent(next)}`}
          className="mt-6 inline-block text-sm underline underline-offset-4"
        >
          {t('older')}
        </Link>
      )}
    </>
  );
}
