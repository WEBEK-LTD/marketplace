import { Heading, PageContainer } from '@repo/ui';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { ListingGrid, ListingGridSkeleton, ListingMessage } from '../../../components/listing-views';
import { readListings } from '../../../server/bff';
import { metadataWithOverride } from '../../../server/public-metadata';

/**
 * `/listings` and `/ar/listings` — the public browse list.
 *
 * A server component, for the same reason as the category tree: a listing is content, and the HTML has
 * to carry it for a crawler and for a visitor with no JavaScript.
 *
 * Paging is a link, not a button. The cursor lives in the query string, so a page of results has a URL
 * that can be shared, bookmarked and reloaded, and the browser's back button does the obvious thing —
 * none of which is true of a list that grows in client state.
 */

interface PageParams {
  readonly params: Promise<{ locale: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function basePath(locale: string): string {
  return locale === 'ar' ? '/ar/listings' : '/listings';
}

function listingPath(locale: string, slug: string): string {
  return `${locale === 'ar' ? '/ar' : ''}/listing/${encodeURIComponent(slug)}`;
}

/**
 * The browse list is canonical at its unparameterised URL only.
 *
 * A cursor page is the same catalogue seen from a different offset, so indexing each one would spend a
 * crawler's budget on near-duplicates. Pages past the first therefore carry `noindex, follow`: not
 * indexed, but still crawled through to the listings themselves.
 */
export async function generateMetadata({ params, searchParams }: PageParams): Promise<Metadata> {
  const { locale } = await params;
  const query = await searchParams;
  const t = await getTranslations({ locale, namespace: 'Listings' });
  const paged = typeof query['cursor'] === 'string' && query['cursor'] !== '';

  // A landing address, so its override is a `route` entry and its stored canonical **is** served: there is no row
  // behind this address and therefore no derived canonical for an override to contradict (8-F). The robots value
  // below is still a floor, so a paged view stays `noindex`.
  return await metadataWithOverride(
    { routePath: '/listings', locale },
    {
      title: t('title'),
      description: t('description'),
      canonical: basePath(locale),
      languages: { en: '/listings', ar: '/ar/listings' },
      // Stated on both branches: the root layout's default is `noindex, nofollow`, and metadata is merged
      // from the root down, so saying nothing here would inherit that refusal and the page would never be
      // indexed however the robots header is set.
      index: !paged,
      follow: true,
    },
  );
}

/** The part that waits on the API, so the heading above it renders immediately. */
async function ListingsSection({
  locale,
  cursor,
}: {
  readonly locale: string;
  readonly cursor: string | null;
}) {
  const t = await getTranslations({ locale, namespace: 'Listings' });
  const page = await readListings({ cursor });

  if (page === null) {
    return <ListingMessage tone="error" title={t('errorTitle')} description={t('errorDescription')} />;
  }
  if (page.items.length === 0) {
    return <ListingMessage tone="empty" title={t('emptyTitle')} description={t('emptyDescription')} />;
  }

  const labels = { contactForPrice: t('contactForPrice'), negotiable: t('negotiable') };

  return (
    <>
      <ListingGrid
        listings={page.items}
        hrefFor={(slug) => listingPath(locale, slug)}
        labels={labels}
      />
      {page.nextCursor === null ? null : (
        <p className="mt-8">
          <a
            href={`${basePath(locale)}?cursor=${encodeURIComponent(page.nextCursor)}`}
            rel="next"
            className="inline-block rounded border border-neutral-300 px-4 py-2 text-sm text-neutral-900 hover:border-neutral-900"
          >
            {t('more')}
          </a>
        </p>
      )}
    </>
  );
}

export default async function ListingsPage({ params, searchParams }: PageParams) {
  const { locale } = await params;
  const query = await searchParams;
  const t = await getTranslations({ locale, namespace: 'Listings' });
  const raw = query['cursor'];
  const cursor = typeof raw === 'string' && raw !== '' ? raw : null;

  return (
    <PageContainer>
      <div className="py-12">
        <Heading level={1}>{t('title')}</Heading>
        <p className="mt-2 max-w-prose text-neutral-600">{t('description')}</p>
        {/* Keyed by the cursor so moving to the next page shows the loading state again. */}
        <Suspense key={cursor ?? 'first'} fallback={<ListingGridSkeleton label={t('loading')} />}>
          <ListingsSection locale={locale} cursor={cursor} />
        </Suspense>
      </div>
    </PageContainer>
  );
}
