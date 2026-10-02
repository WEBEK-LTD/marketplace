import type { Locale } from '@repo/shared-types';
import { Heading, PageContainer } from '@repo/ui';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { AccountEmpty, AccountError, AccountSkeleton } from '../../../../../components/account-views';
import { RequireSession } from '../../../../../components/require-session';
import { serviceRequestCopy } from '../../../../../components/service-request-copy';
import { ServiceRequestList, type ServiceRequestCopy } from '../../../../../components/service-request-views';
import { readServiceRequestsReceived } from '../../../../../server/bff';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('SellerServiceRequests');
  return { title: t('title'), robots: { index: false, follow: false } };
}

/**
 * The service briefs sent to the reader's storefront (Phase 7-I).
 *
 * The seller's inbox. It calls the operation that reads the briefs addressed to this account's storefront,
 * which is a different function with a different fixed predicate from the buyer's — so somebody who is both a
 * buyer and a seller sees two separate lists rather than one mixed one, and neither page can be made to show
 * the other's rows.
 *
 * The whole body sits inside {@link RequireSession}, with the read inside the gated subtree, so a request
 * without a session performs no read and streams no row into the flight data.
 *
 * **Quoting is offered from the detail page; being paid is not offered anywhere.** An accepted quote records
 * what becomes due and when. The payment itself is Phase 8's.
 */
export default async function SellerServiceRequestsPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: Locale }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ locale }, query, t] = await Promise.all([
    params,
    searchParams,
    getTranslations('SellerServiceRequests'),
  ]);
  const cursor = typeof query['cursor'] === 'string' ? query['cursor'] : null;
  const prefix = locale === 'ar' ? '/ar' : '';
  const base = `${prefix}/dashboard/seller/service-requests`;

  return (
    <RequireSession>
      <PageContainer>
        <div className="py-12">
          <Heading level={1}>{t('title')}</Heading>
          <p className="mt-2 max-w-prose text-neutral-600">{t('intro')}</p>

          <Suspense fallback={<AccountSkeleton label={t('title')} />}>
            <ReceivedSection
              cursor={cursor}
              base={base}
              prefix={prefix}
              copy={serviceRequestCopy(t, 'seller')}
              t={t}
            />
          </Suspense>
        </div>
      </PageContainer>
    </RequireSession>
  );
}

type Translate = Awaited<ReturnType<typeof getTranslations<'SellerServiceRequests'>>>;

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
  readonly copy: ServiceRequestCopy;
  readonly t: Translate;
}) {
  const requestHeaders = await headers();
  const result = await readServiceRequestsReceived({ cursor }, { cookieHeader: requestHeaders.get('cookie') });

  // A refused cursor and an unavailable service are both recovered from by starting again, and the link that
  // recovers from them is the same one: this view, with no cursor.
  if (result.kind !== 'ok') {
    return <AccountError title={t('error')} retry={t('retry')} href={base} />;
  }
  if (result.data.items.length === 0) {
    return <AccountEmpty title={t('empty')} hint={t('emptyHint')} />;
  }

  const next = result.data.nextCursor;
  return (
    <>
      <ServiceRequestList items={result.data.items} copy={copy} base={base} localePrefix={prefix} />
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
