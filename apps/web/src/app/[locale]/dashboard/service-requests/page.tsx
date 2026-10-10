import type { Locale } from '@repo/shared-types';
import { Heading, PageContainer } from '@repo/ui';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { AccountEmpty, AccountError, AccountSkeleton } from '../../../../components/account-views';
import { RequestPlatformHelpButton } from '../../../../components/request-platform-help';
import { RequireSession } from '../../../../components/require-session';
import { serviceRequestCopy } from '../../../../components/service-request-copy';
import { ServiceRequestList, type ServiceRequestCopy } from '../../../../components/service-request-views';
import { readServiceRequestsMade } from '../../../../server/bff';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('ServiceRequests');
  return { title: t('title'), robots: { index: false, follow: false } };
}

/**
 * The service briefs the reader has sent (Phase 7-I).
 *
 * The whole body sits inside {@link RequireSession}: a layout that declines to render its children still
 * streams the page's own subtree into the flight data, so the gate has to be inside the page, and the read
 * has to be inside the gated subtree so a refused request performs none.
 *
 * **This is the buyer's side and only the buyer's side.** It calls the operation that reads the briefs this
 * account sent; the briefs sent *to* their storefront are a different page reading a different operation with
 * a different fixed predicate, so there is no parameter either page could get wrong.
 */
export default async function ServiceRequestsPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: Locale }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ locale }, query, t] = await Promise.all([
    params,
    searchParams,
    getTranslations('ServiceRequests'),
  ]);
  const cursor = typeof query['cursor'] === 'string' ? query['cursor'] : null;
  const prefix = locale === 'ar' ? '/ar' : '';
  const base = `${prefix}/dashboard/service-requests`;

  return (
    <RequireSession>
      <PageContainer>
        <div className="py-12">
          <Heading level={1}>{t('title')}</Heading>
          <p className="mt-2 max-w-prose text-ink-muted">{t('intro')}</p>

          {/*
            7-J: the one entry point for a brief no seller answers. It sits here rather than on a service page
            because there is no service to start from — the platform is what answers it. The button carries no
            routing field and no session state; the server decides the flow from the operation it calls.
          */}
          <div className="mt-6">
            <RequestPlatformHelpButton
              copy={{
                action: t('platformAction'),
                heading: t('platformHeading'),
                intro: t('platformIntro'),
                titleLabel: t('platformTitleLabel'),
                briefLabel: t('platformBriefLabel'),
                methodLabel: t('platformMethodLabel'),
                methodHint: t('platformMethodHint'),
                notesLabel: t('platformNotesLabel'),
                budgetLabel: t('platformBudgetLabel'),
                budgetHint: t('platformBudgetHint'),
                neededByLabel: t('platformNeededByLabel'),
                send: t('platformSend'),
                cancel: t('cancel'),
                working: t('working'),
                titleRequired: t('platformTitleRequired'),
                briefRequired: t('platformBriefRequired'),
                methodRequired: t('platformMethodRequired'),
                notesTooLong: t('platformNotesTooLong'),
                budgetInvalid: t('platformBudgetInvalid'),
                noSellerNote: t('platformNoSellerNote'),
                failedSignedOut: t('failedSignedOut'),
                failedGeneric: t('platformFailedGeneric'),
              }}
            />
          </div>

          <Suspense fallback={<AccountSkeleton label={t('title')} />}>
            <MadeSection
              cursor={cursor}
              base={base}
              prefix={prefix}
              copy={serviceRequestCopy(t, 'buyer')}
              t={t}
            />
          </Suspense>
        </div>
      </PageContainer>
    </RequireSession>
  );
}

type Translate = Awaited<ReturnType<typeof getTranslations<'ServiceRequests'>>>;

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
  readonly copy: ServiceRequestCopy;
  readonly t: Translate;
}) {
  const requestHeaders = await headers();
  const result = await readServiceRequestsMade({ cursor }, { cookieHeader: requestHeaders.get('cookie') });

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
