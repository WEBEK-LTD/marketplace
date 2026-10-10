import type { Locale } from '@repo/shared-types';
import { Heading, PageContainer } from '@repo/ui';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { UnblockPerson } from '../../../../components/account-actions';
import {
  AccountEmpty,
  AccountError,
  AccountSkeleton,
  BlockedPersonSummary,
  type BlockCopy,
} from '../../../../components/account-views';
import { RequireSession } from '../../../../components/require-session';
import { readBlocks } from '../../../../server/bff';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Blocks');
  return { title: t('title'), robots: { index: false, follow: false } };
}

/**
 * The people this person has blocked (0103).
 *
 * **This screen is one direction only.** It lists blocks the caller made. There is no operation anywhere
 * in this platform that answers who has blocked *them*, and so there is nothing on this page that could
 * accidentally show it — that absence is in the API and the database, not something this page is choosing
 * to hide.
 *
 * **Nobody is identified here.** Each row names a person by a display name and a storefront slug where
 * those exist, and carries an opaque reference for the unblock. The account identifier is never sent to
 * this origin, so there is none in the markup and none in the RSC payload.
 *
 * **What blocking did and did not do** is stated in the introduction rather than left to be discovered:
 * contact stops in both directions, existing conversations stay readable, and the blocked seller's
 * listings are still in the catalogue. Somebody using this screen is usually trying to make something
 * stop, and the one thing worse than not helping them is letting them believe it did more than it did.
 *
 * **What crosses into the client.** One unblock button per row, holding an opaque reference and three
 * words. Everything read is rendered on the server.
 */
export default async function BlocksPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: Locale }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ locale }, query, t] = await Promise.all([params, searchParams, getTranslations('Blocks')]);
  const cursor = typeof query['cursor'] === 'string' ? query['cursor'] : null;
  const prefix = locale === 'ar' ? '/ar' : '';
  const base = `${prefix}/dashboard/blocks`;

  return (
    <RequireSession>
      <PageContainer>
        <div className="py-12">
          <Heading level={1}>{t('title')}</Heading>
          <p className="mt-2 max-w-prose text-ink-muted">{t('intro')}</p>
          <p className="mt-2 max-w-prose text-sm text-ink-muted">{t('effect')}</p>

          <Suspense fallback={<AccountSkeleton label={t('title')} />}>
            <ListSection cursor={cursor} base={base} t={t} />
          </Suspense>
        </div>
      </PageContainer>
    </RequireSession>
  );
}

type Translate = Awaited<ReturnType<typeof getTranslations<'Blocks'>>>;

function summaryCopy(t: Translate): BlockCopy {
  return {
    listLabel: t('listLabel'),
    unnamed: t('unnamed'),
    storefront: t('storefront'),
    reasonLabel: t('reasonLabel'),
    blockedOn: t('blockedOn'),
  };
}

async function ListSection({
  cursor,
  base,
  t,
}: {
  readonly cursor: string | null;
  readonly base: string;
  readonly t: Translate;
}) {
  const requestHeaders = await headers();
  const result = await readBlocks({ cursor }, { cookieHeader: requestHeaders.get('cookie') });

  if (result.kind !== 'ok') {
    return <AccountError title={t('error')} retry={t('retry')} href={base} />;
  }
  if (result.data.items.length === 0) {
    return <AccountEmpty title={t('empty')} hint={t('emptyHint')} />;
  }

  const copy = summaryCopy(t);
  const next = result.data.nextCursor;

  return (
    <>
      <ul className="mt-6 space-y-3" aria-label={t('listLabel')}>
        {result.data.items.map((person) => (
          <li key={person.reference} className="rounded-lg border border-hairline p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <BlockedPersonSummary person={person} copy={copy} />
              </div>
              <UnblockPerson
                reference={person.reference}
                copy={{ remove: t('unblock'), working: t('working'), failed: t('failed') }}
              />
            </div>
          </li>
        ))}
      </ul>
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
