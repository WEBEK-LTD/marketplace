import type { Locale } from '@repo/shared-types';
import { Heading, PageContainer } from '@repo/ui';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { AccountEmpty, AccountError, AccountSkeleton } from '../../../../components/account-views';
import { OffersMadeList, type OfferCopy } from '../../../../components/offer-views';
import { RequireSession } from '../../../../components/require-session';
import { readOffersMade } from '../../../../server/bff';
import { offerCopy } from '../../../../components/offer-copy';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Offers');
  return { title: t('title'), robots: { index: false, follow: false } };
}

/**
 * The offers the reader has made (Phase 7-H).
 *
 * The whole body sits inside {@link RequireSession}: a layout that declines to render its children still
 * streams the page's own subtree into the flight data, so the gate has to be inside the page.
 *
 * **This is the buyer's side and only the buyer's side.** It calls the operation that reads the offers this
 * account made; the offers made *to* their storefront are a different page reading a different operation,
 * so there is no parameter either page could get wrong.
 */
export default async function OffersPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: Locale }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ locale }, query, t] = await Promise.all([params, searchParams, getTranslations('Offers')]);
  const cursor = typeof query['cursor'] === 'string' ? query['cursor'] : null;
  const prefix = locale === 'ar' ? '/ar' : '';
  const base = `${prefix}/dashboard/offers`;

  return (
    <RequireSession>
      <PageContainer>
        <div className="py-12">
          <Heading level={1}>{t('title')}</Heading>
          <p className="mt-2 max-w-prose text-neutral-600">{t('intro')}</p>

          <Suspense fallback={<AccountSkeleton label={t('title')} />}>
            <MadeSection cursor={cursor} base={base} prefix={prefix} copy={offerCopy(t, 'buyer')} t={t} />
          </Suspense>
        </div>
      </PageContainer>
    </RequireSession>
  );
}

type Translate = Awaited<ReturnType<typeof getTranslations<'Offers'>>>;

async function MadeSection({
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
  const result = await readOffersMade({ cursor }, { cookieHeader: requestHeaders.get('cookie') });

  // A refused cursor and an unavailable service are both recoverable by starting again, and the link that
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
      <OffersMadeList items={result.data.items} copy={copy} localePrefix={prefix} />
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
