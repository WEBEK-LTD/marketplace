import type { Locale } from '@repo/shared-types';
import { Heading, PageContainer } from '@repo/ui';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { DeleteSavedSearch } from '../../../../components/account-actions';
import {
  AccountEmpty,
  AccountError,
  AccountSkeleton,
  SavedSearchSummary,
  type SavedSearchCopy,
} from '../../../../components/account-views';
import { RequireSession } from '../../../../components/require-session';
import {
  EditSavedSearch,
  NewSavedSearch,
  type SavedSearchFormLabels,
} from '../../../../components/saved-search-form';
import { readSavedSearches } from '../../../../server/bff';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('SavedSearches');
  return { title: t('title'), robots: { index: false, follow: false } };
}

/**
 * The saved searches (Phase 7-E).
 *
 * **Saving a search stores it. It does not run it.** There is no matching engine in this project, so
 * `notify` is a stored preference and the surface says exactly that beside the switch, and reports
 * "never" for the last match because that is what the data says. Nothing here implies a schedule, and
 * nothing here creates a notification.
 *
 * **What crosses into the client.** The create and edit forms and the delete button. The form holds the
 * three fields a person owns — name, terms and the notify switch — because it must show them in order
 * to let somebody edit them; the summary a person reads is rendered on the server.
 */
export default async function SavedSearchesPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: Locale }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ locale }, query, t] = await Promise.all([params, searchParams, getTranslations('SavedSearches')]);
  const cursor = typeof query['cursor'] === 'string' ? query['cursor'] : null;
  const prefix = locale === 'ar' ? '/ar' : '';
  const base = `${prefix}/dashboard/saved-searches`;

  return (
    <RequireSession>
      <PageContainer>
        <div className="py-12">
          <Heading level={1}>{t('title')}</Heading>
          <p className="mt-2 max-w-prose text-neutral-600">{t('intro')}</p>

          <NewSavedSearch labels={formLabels(t)} addLabel={t('add')} />

          <Suspense fallback={<AccountSkeleton label={t('title')} />}>
            <ListSection cursor={cursor} base={base} prefix={prefix} t={t} />
          </Suspense>
        </div>
      </PageContainer>
    </RequireSession>
  );
}

type Translate = Awaited<ReturnType<typeof getTranslations<'SavedSearches'>>>;

function formLabels(t: Translate): SavedSearchFormLabels {
  return {
    name: t('name'),
    nameHint: t('nameHint'),
    terms: t('terms'),
    termsHint: t('termsHint'),
    notify: t('notify'),
    notifyHint: t('notifyHint'),
    save: t('save'),
    saving: t('saving'),
    saved: t('saved'),
    cancel: t('cancel'),
    required: t('required'),
    nameTaken: t('nameTaken'),
    invalid: t('invalid'),
    missing: t('missing'),
    signedOut: t('signedOut'),
    failed: t('genericFailure'),
  };
}

function summaryCopy(t: Translate): SavedSearchCopy {
  return {
    listLabel: t('listLabel'),
    notifyOn: t('notifyOn'),
    notifyOff: t('notifyOff'),
    never: t('never'),
    lastMatched: t('lastMatched'),
    open: t('open'),
  };
}

async function ListSection({
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
  const result = await readSavedSearches({ cursor }, { cookieHeader: requestHeaders.get('cookie') });

  if (result.kind !== 'ok') {
    return <AccountError title={t('error')} retry={t('retry')} href={base} />;
  }
  if (result.data.items.length === 0) {
    return <AccountEmpty title={t('empty')} hint={t('emptyHint')} />;
  }

  const copy = summaryCopy(t);
  const labels = formLabels(t);
  const next = result.data.nextCursor;

  return (
    <>
      <ul className="mt-6 space-y-3" aria-label={t('listLabel')}>
        {result.data.items.map((search) => (
          <li key={search.id} className="rounded-lg border border-neutral-200 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <SavedSearchSummary search={search} copy={copy} localePrefix={prefix} />
              </div>
              <span className="flex flex-wrap items-center gap-2">
                <EditSavedSearch
                  labels={labels}
                  editLabel={t('edit')}
                  initial={{
                    id: search.id,
                    name: search.name,
                    terms: typeof search.query['q'] === 'string' ? search.query['q'] : '',
                    notify: search.notify,
                  }}
                />
                <DeleteSavedSearch
                  savedSearchId={search.id}
                  copy={{ remove: t('remove'), working: t('working'), failed: t('failed') }}
                />
              </span>
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
