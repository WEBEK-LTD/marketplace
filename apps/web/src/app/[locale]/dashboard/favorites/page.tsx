import type { Locale } from '@repo/shared-types';
import { Heading, PageContainer } from '@repo/ui';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import {
  AccountEmpty,
  AccountError,
  AccountSkeleton,
  FavoriteList,
  type FavoriteCopy,
} from '../../../../components/account-views';
import { RequireSession } from '../../../../components/require-session';
import { readFavorites } from '../../../../server/bff';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Favorites');
  return { title: t('title'), robots: { index: false, follow: false } };
}

/**
 * The saved listings (Phase 7-E).
 *
 * **A favorite is the person's own saved row, not a live listing.** One whose listing was withdrawn, or
 * whose seller is no longer active, is still shown — with no link, no price and a sentence saying so —
 * because removing it from the screen would leave somebody unable to tidy up their own list. Nothing
 * about the hidden listing is rendered, because the reader sent nothing about it.
 *
 * **What crosses into the client.** Only the remove button is a client component, and its props are one
 * identifier and three words. The title, the price, the city and the link are all rendered here, on the
 * server, so nothing else about a favorite is in the RSC payload.
 *
 * The whole body sits inside {@link RequireSession}: a layout that declines to render its children still
 * streams the page's own subtree into the flight data, so the gate has to be inside the page.
 */
export default async function FavoritesPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: Locale }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ locale }, query, t] = await Promise.all([params, searchParams, getTranslations('Favorites')]);
  const cursor = typeof query['cursor'] === 'string' ? query['cursor'] : null;
  const prefix = locale === 'ar' ? '/ar' : '';
  const base = `${prefix}/dashboard/favorites`;

  return (
    <RequireSession>
      <PageContainer>
        <div className="py-12">
          <Heading level={1}>{t('title')}</Heading>
          <p className="mt-2 max-w-prose text-neutral-600">{t('intro')}</p>

          <Suspense fallback={<AccountSkeleton label={t('title')} />}>
            <ListSection cursor={cursor} base={base} prefix={prefix} copy={copyFor(t)} t={t} />
          </Suspense>
        </div>
      </PageContainer>
    </RequireSession>
  );
}

type Translate = Awaited<ReturnType<typeof getTranslations<'Favorites'>>>;

function copyFor(t: Translate): FavoriteCopy {
  return {
    listLabel: t('listLabel'),
    unavailable: t('unavailable'),
    unavailableHint: t('unavailableHint'),
    open: t('open'),
    remove: t('remove'),
    working: t('working'),
    failed: t('failed'),
    price: { contactForPrice: t('contactForPrice'), negotiable: t('negotiable') },
  };
}

async function ListSection({
  cursor,
  base,
  prefix,
  copy,
  t,
}: {
  readonly cursor: string | null;
  readonly base: string;
  readonly prefix: string;
  readonly copy: FavoriteCopy;
  readonly t: Translate;
}) {
  const requestHeaders = await headers();
  const result = await readFavorites({ cursor }, { cookieHeader: requestHeaders.get('cookie') });

  // A refused cursor and an unavailable service are both recoverable by starting again, and the link
  // that recovers from them is the same one: this view, with no cursor.
  if (result.kind !== 'ok') {
    return <AccountError title={t('error')} retry={t('retry')} href={base} />;
  }
  if (result.data.items.length === 0) {
    return <AccountEmpty title={t('empty')} hint={t('emptyHint')} />;
  }

  const next = result.data.nextCursor;
  return (
    <>
      <FavoriteList items={result.data.items} copy={copy} localePrefix={prefix} />
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
