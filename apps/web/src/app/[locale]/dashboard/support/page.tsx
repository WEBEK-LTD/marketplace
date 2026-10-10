import type { Locale } from '@repo/shared-types';
import { Heading, PageContainer } from '@repo/ui';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { AccountEmpty, AccountError, AccountSkeleton } from '../../../../components/account-views';
import { RequireSession } from '../../../../components/require-session';
import { openTicketCopy, supportCopy } from '../../../../components/support-copy';
import { OpenSupportTicketForm } from '../../../../components/support-forms';
import { SupportTicketList } from '../../../../components/support-views';
import { readSupportTickets } from '../../../../server/bff';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Support');
  return { title: t('title'), robots: { index: false, follow: false } };
}

/**
 * The support tickets the reader raised (Phase 7-K).
 *
 * The whole body sits inside {@link RequireSession}: a layout that declines to render its children still
 * streams the page's own subtree into the flight data, so the gate has to be inside the page, and the read has
 * to be inside the gated subtree so a refused request performs none.
 *
 * **This is the requester's side and only the requester's side.** It calls the one operation that reads the
 * tickets this account raised; the agent queue is a different application with a different permission, and
 * nothing here can reach it.
 */
export default async function SupportPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: Locale }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ locale }, query, t] = await Promise.all([params, searchParams, getTranslations('Support')]);
  const cursor = typeof query['cursor'] === 'string' ? query['cursor'] : null;
  const prefix = locale === 'ar' ? '/ar' : '';
  const base = `${prefix}/dashboard/support`;

  return (
    <RequireSession>
      <PageContainer>
        <div className="py-12">
          <Heading level={1}>{t('title')}</Heading>
          <p className="mt-2 max-w-prose text-ink-muted">{t('intro')}</p>

          <div className="mt-6">
            <OpenSupportTicketForm copy={openTicketCopy(t)} />
          </div>

          <Suspense fallback={<AccountSkeleton label={t('title')} />}>
            <TicketsSection cursor={cursor} base={base} t={t} />
          </Suspense>
        </div>
      </PageContainer>
    </RequireSession>
  );
}

type Translate = Awaited<ReturnType<typeof getTranslations<'Support'>>>;

async function TicketsSection({
  cursor,
  base,
  t,
}: {
  readonly cursor: string | null;
  readonly base: string;
  readonly t: Translate;
}) {
  const requestHeaders = await headers();
  const result = await readSupportTickets({ cursor }, { cookieHeader: requestHeaders.get('cookie') });

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
      <SupportTicketList items={result.data.items} copy={supportCopy(t)} base={base} />
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
