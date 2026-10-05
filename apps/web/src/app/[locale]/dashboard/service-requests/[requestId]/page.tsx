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
import {
  ServiceRequestDetailView,
  type ServiceRequestCopy,
} from '../../../../../components/service-request-views';
import { readServiceRequestDetail } from '../../../../../server/bff';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('ServiceRequests');
  return { title: t('title'), robots: { index: false, follow: false } };
}

/**
 * One brief the reader sent, with the quotes it has drawn (Phase 7-I).
 *
 * **The buyer's view of a brief.** The seller's view of the same brief is a different page under the seller
 * shell, reading the same operation; what differs is the words, which decide which steps are drawn. Which
 * steps are *allowed* is the database's, and it answers from the caller's own account either way.
 *
 * **A brief that is not the reader's and one that does not exist render the same thing.** The API answers 404
 * for both, so this page has no branch that could tell them apart and therefore none that could leak the
 * difference.
 *
 * **Accepting a quote is offered here; paying for it is not.** An acceptance records what becomes due and
 * when. The payment itself is Phase 8's, and nothing on this page charges, reserves or orders anything.
 */
export default async function ServiceRequestDetailPage({
  params,
}: {
  readonly params: Promise<{ readonly locale: Locale; readonly requestId: string }>;
}) {
  const [{ locale, requestId }, t] = await Promise.all([params, getTranslations('ServiceRequests')]);
  const prefix = locale === 'ar' ? '/ar' : '';
  const base = `${prefix}/dashboard/service-requests`;

  return (
    <RequireSession>
      <PageContainer>
        <div className="py-12">
          <Heading level={1}>{t('detailTitle')}</Heading>
          <p className="mt-2 text-sm">
            <Link href={base} className="underline underline-offset-4">
              {t('backToList')}
            </Link>
          </p>

          <Suspense fallback={<AccountSkeleton label={t('detailTitle')} />}>
            <DetailSection
              requestId={requestId}
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

async function DetailSection({
  requestId,
  base,
  prefix,
  copy,
  t,
}: {
  readonly requestId: string;
  readonly base: string;
  readonly prefix: string;
  readonly copy: ServiceRequestCopy;
  readonly t: Translate;
}) {
  const requestHeaders = await headers();
  const result = await readServiceRequestDetail(requestId, {
    cookieHeader: requestHeaders.get('cookie'),
  });

  if (result.kind === 'notFound') {
    return <AccountEmpty title={t('notFound')} hint={t('notFoundHint')} />;
  }
  if (result.kind !== 'ok') {
    return <AccountError title={t('error')} retry={t('retry')} href={base} />;
  }

  return (
    <ServiceRequestDetailView request={result.data.request} copy={copy} localePrefix={prefix} />
  );
}
