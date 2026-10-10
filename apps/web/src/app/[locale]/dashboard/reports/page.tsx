import type { Locale } from '@repo/shared-types';
import { REPORT_REASON_CODES, REPORT_STATUSES } from '@repo/contracts';
import { Heading, PageContainer } from '@repo/ui';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { AccountEmpty, AccountError, AccountSkeleton } from '../../../../components/account-views';
import { RequireSession } from '../../../../components/require-session';
import { ReportHistoryList, type ReportHistoryCopy } from '../../../../components/report-views';
import { readOwnReports } from '../../../../server/bff';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Reports');
  return { title: t('title'), robots: { index: false, follow: false } };
}

/**
 * The reports the reader filed (Phase 7-M).
 *
 * The whole body sits inside {@link RequireSession}: a layout that declines to render its children still
 * streams the page's own subtree into the flight data, so the gate has to be inside the page, and the read has
 * to be inside the gated subtree so a refused request performs none.
 *
 * **This page exists because the schema sanctions it.** 0027's `reports_reporter_read` policy is `using
 * (reporter_user_id = public.current_user_id())`, so a reporter reading their own reports is the platform's
 * own rule rather than something added here. What the policy does not do — it is row-level — is narrow the
 * columns, which is why the projection is decided in 0076's reader: this page can only render what that reader
 * returns, and it returns none of the moderation state.
 *
 * **This is the reporter's side and only the reporter's side.** It calls the one operation that reads the
 * reports this account filed. There is no queue here, no other reporter's rows, no moderator, no triage and no
 * decision — those are 7-N's, with their own permissions, and nothing on this page can reach them.
 */
export default async function ReportsPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: Locale }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ locale }, query, t] = await Promise.all([params, searchParams, getTranslations('Reports')]);
  const cursor = typeof query['cursor'] === 'string' ? query['cursor'] : null;
  const prefix = locale === 'ar' ? '/ar' : '';
  const base = `${prefix}/dashboard/reports`;

  return (
    <RequireSession>
      <PageContainer>
        <div className="py-12">
          <Heading level={1}>{t('title')}</Heading>
          <p className="mt-2 max-w-prose text-ink-muted">{t('intro')}</p>

          <Suspense fallback={<AccountSkeleton label={t('title')} />}>
            <ReportsSection cursor={cursor} base={base} prefix={prefix} t={t} />
          </Suspense>
        </div>
      </PageContainer>
    </RequireSession>
  );
}

type Translate = Awaited<ReturnType<typeof getTranslations<'Reports'>>>;

/** The list's words, built here because this is the only page that renders them. */
function historyCopy(t: Translate): ReportHistoryCopy {
  const reasons: Record<string, string> = {};
  for (const code of REPORT_REASON_CODES) reasons[code] = t(`reasons.${code}`);
  const statuses: Record<string, string> = {};
  for (const status of REPORT_STATUSES) statuses[status] = t(`statuses.${status}`);

  return {
    subjectListing: t('subjectListing'),
    subjectSeller: t('subjectSeller'),
    subjectGone: t('subjectGone'),
    reasonLabel: t('reasonLabel'),
    reasons,
    statusLabel: t('statusLabel'),
    statuses,
    filedAt: t('filedAt'),
    yourWords: t('yourWords'),
    view: t('view'),
  };
}

async function ReportsSection({
  cursor,
  base,
  prefix,
  t,
}: {
  readonly cursor: string | null;
  readonly base: string;
  readonly prefix: string;
  readonly t: Translate;
}) {
  const requestHeaders = await headers();
  const result = await readOwnReports({ cursor }, { cookieHeader: requestHeaders.get('cookie') });

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
      <ReportHistoryList items={result.data.items} prefix={prefix} copy={historyCopy(t)} />
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
