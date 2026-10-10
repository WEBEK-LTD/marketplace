import { Heading, PageContainer, Pagination } from '@repo/ui';
import {
  SEARCH_MIN_QUERY_LENGTH,
  catalogFiltersToParams,
  parseCatalogFilters,
  type CatalogFilters,
} from '@repo/contracts';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { ListingGridSkeleton, ListingMessage } from '../../../components/listing-views';
import { SearchForm, SearchResultList } from '../../../components/search-results';
import { readSearch } from '../../../server/bff';

/**
 * `/search` and `/ar/search` — public search.
 *
 * A server component, and a `GET` form: a search is a URL, so it can be shared, bookmarked and reloaded,
 * and it works with no JavaScript. Paging follows the same principle — the cursor lives in the query
 * string and "show more" is a link, not a button that mutates client state.
 *
 * **Not indexable.** Search-result pages are not SEO landing pages in V1, so the page carries
 * `noindex, follow`: a crawler does not index the result list but does follow through to the listings,
 * services and categories it names, which are indexable in their own right. The route is deliberately
 * *not* added to the public-catalogue allowlist — the route-aware policy denies by default, so `/search`
 * already receives the `noindex` header, and the page's own metadata supplies `follow`.
 *
 * A query shorter than the minimum is refused here without calling the API at all. An empty search box
 * must not quietly become a browse feed, and it must not become an expensive query either.
 */

interface PageParams {
  readonly params: Promise<{ locale: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function basePath(locale: string): string {
  return locale === 'ar' ? '/ar/search' : '/search';
}

function listingPath(locale: string, slug: string): string {
  return `${locale === 'ar' ? '/ar' : ''}/listing/${encodeURIComponent(slug)}`;
}

function servicePath(locale: string, slug: string): string {
  return `${locale === 'ar' ? '/ar' : ''}/service/${encodeURIComponent(slug)}`;
}

function firstValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

export async function generateMetadata({ params }: PageParams): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Search' });

  return {
    title: t('title'),
    description: t('description'),
    // Stated explicitly rather than inherited: the root layout's default is `noindex, nofollow`, and a
    // result page should still be crawled through to the pages it links to.
    robots: { index: false, follow: true },
  };
}

/** The part that waits on the API, so the form above it renders immediately. */
async function Results({
  locale,
  query,
  cursor,
  filters,
}: {
  readonly locale: string;
  readonly query: string;
  readonly cursor: string | null;
  readonly filters: CatalogFilters;
}) {
  const t = await getTranslations({ locale, namespace: 'Search' });
  // The cards are the listing and service surfaces' own, so their labels come from those namespaces
  // rather than being duplicated into Search.
  const tListings = await getTranslations({ locale, namespace: 'Listings' });
  const tServices = await getTranslations({ locale, namespace: 'Services' });
  const tPagination = await getTranslations({ locale, namespace: 'Pagination' });
  const found = await readSearch({ q: query, locale, cursor, filters });

  if (found.kind === 'invalid') {
    return <ListingMessage tone="error" title={t('errorTitle')} description={t('minLength')} />;
  }
  if (found.kind === 'unavailable') {
    return <ListingMessage tone="error" title={t('errorTitle')} description={t('error')} />;
  }
  if (found.page.items.length === 0) {
    return <ListingMessage tone="empty" title={t('emptyTitle')} description={t('empty')} />;
  }

  const listingLabels = {
    contactForPrice: tListings('contactForPrice'),
    negotiable: tListings('negotiable'),
  };
  const serviceLabels = {
    contactForPrice: tServices('contactForPrice'),
    negotiable: '',
    fixedPrice: tServices('fixedPrice'),
    customPricing: tServices('customPricing'),
    deliveryTime: tServices('deliveryTime'),
    revisionsIncluded: tServices('revisionsIncluded'),
    deliveryDays: (count: number) => tServices('deliveryDays', { count }),
  };

  const next = found.page.nextCursor;
  // Every filter is carried into the next page, so paging a filtered search cannot widen it. The same
  // parameters without a cursor are the search's own first page, which is where "back to the start" goes.
  const firstParams = new URLSearchParams([['q', query], ...catalogFiltersToParams(filters)]);
  const nextParams = new URLSearchParams(firstParams);
  if (next !== null) nextParams.set('cursor', next);

  return (
    <>
      <SearchResultList
        results={found.page.items}
        listingHref={(slug) => listingPath(locale, slug)}
        serviceHref={(slug) => servicePath(locale, slug)}
        labels={{ listing: listingLabels, service: serviceLabels }}
      />
      <Pagination
        nextHref={next === null ? null : `${basePath(locale)}?${nextParams.toString()}`}
        firstHref={`${basePath(locale)}?${firstParams.toString()}`}
        paged={cursor !== null}
        labels={{
          next: t('more'),
          first: tPagination('first'),
          position: tPagination('showing', { count: found.page.items.length }),
          navigation: tPagination('navigation'),
        }}
        className="mt-10"
      />
    </>
  );
}

export default async function SearchPage({ params, searchParams }: PageParams) {
  const { locale } = await params;
  const query = await searchParams;
  const t = await getTranslations({ locale, namespace: 'Search' });

  const raw = firstValue(query['q']);
  const trimmed = raw.trim();
  const cursorRaw = firstValue(query['cursor']);
  const cursor = cursorRaw === '' ? null : cursorRaw;

  // 8-D's shared filters. A malformed one is refused here rather than ignored: a search that quietly
  // dropped the part it could not read would answer a wider question than the visitor asked.
  const asked = parseCatalogFilters(query);

  // Counted in Unicode characters, not UTF-16 units, so a two-character query of surrogate pairs is
  // treated as two characters rather than four.
  const longEnough = Array.from(trimmed).length >= SEARCH_MIN_QUERY_LENGTH;
  const askedAnything = raw !== '';

  return (
    <PageContainer>
      <div className="py-12">
        <Heading level={1}>{t('title')}</Heading>
        <SearchForm
          action={basePath(locale)}
          query={raw}
          labels={{ label: t('description'), placeholder: t('placeholder'), submit: t('submit') }}
        />

        {!askedAnything ? null : !asked.ok ? (
          <p role="alert" className="mt-8 text-sm text-ink-strong">
            {t('filtersInvalid')}
          </p>
        ) : !longEnough ? (
          // Refused here: too short to be worth asking the API, and an empty box is not a browse feed.
          <p role="alert" className="mt-8 text-sm text-ink-strong">
            {t('minLength')}
          </p>
        ) : (
          <Suspense
            key={`${trimmed}:${cursor ?? 'first'}:${new URLSearchParams(catalogFiltersToParams(asked.ok ? asked.filters : {})).toString()}`}
            fallback={<ListingGridSkeleton label={t('loading')} />}
          >
            <Results locale={locale} query={trimmed} cursor={cursor} filters={asked.ok ? asked.filters : {}} />
          </Suspense>
        )}
      </div>
    </PageContainer>
  );
}
