import {
  catalogFiltersAreEmpty,
  catalogFiltersToParams,
  parseCatalogFilters,
  type CatalogFilters,
} from '@repo/contracts';
import { PageContainer, Pagination } from '@repo/ui';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { cache } from 'react';
import { CatalogFilterPanel, CatalogToolbar } from '../../../../components/catalog-filter-panel';
import { CategoryDetailView } from '../../../../components/category-detail';
import { ListingMessage } from '../../../../components/listing-views';
import { SearchResultList } from '../../../../components/search-results';
import { CATALOG_OUTCOME_HEADER } from '../../../../proxy';
import { readCategory, readCategoryFeed, type CategoryLookup } from '../../../../server/bff';
import { metadataWithOverride } from '../../../../server/public-metadata';

/**
 * `/category/[slug]` and `/ar/category/[slug]` — one public category.
 *
 * Three outcomes:
 *
 *   * **found** — 200 with the category, its description and its direct children;
 *   * **not_found** — 404, identically for a category that never existed, one that is inactive, and one
 *     under a deactivated ancestor;
 *   * **unavailable** — the catalogue could not be read. The page renders and says so.
 *
 * A valid category with no children is still a 200 and still indexable: an empty shelf is a real place.
 *
 * **Where the 404 comes from.** The middleware resolves the slug before anything renders. It cannot be
 * issued from here: Next.js 16 streams, so by the time this component has awaited anything the status
 * line is already sent and `notFound()` would produce the right body under a 200. The middleware says
 * through a request header that it has already answered 404, so the not-found view costs no second read;
 * the `notFound()` below stays as a backstop for any path that reaches this component without it.
 */

interface PageParams {
  readonly params: Promise<{ locale: string; slug: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const lookup = cache(
  async (slug: string, locale: string): Promise<CategoryLookup> => readCategory(slug, locale),
);

/** Whether the middleware already answered 404 for this request. */
const alreadyNotFound = cache(async (): Promise<boolean> => {
  return (await headers()).get(CATALOG_OUTCOME_HEADER) === 'not_found';
});

function categoryPath(locale: string, slug: string): string {
  return `${locale === 'ar' ? '/ar' : ''}/category/${encodeURIComponent(slug)}`;
}

function listingPath(locale: string, slug: string): string {
  return `${locale === 'ar' ? '/ar' : ''}/listing/${encodeURIComponent(slug)}`;
}

function servicePath(locale: string, slug: string): string {
  return `${locale === 'ar' ? '/ar' : ''}/service/${encodeURIComponent(slug)}`;
}

/** The filters this request asked for, or none at all when it asked for something malformed. */
function filtersOf(query: Record<string, string | string[] | undefined>): CatalogFilters | null {
  const parsed = parseCatalogFilters(query);
  return parsed.ok ? parsed.filters : null;
}

export async function generateMetadata({ params, searchParams }: PageParams): Promise<Metadata> {
  const { locale, slug } = await params;
  const query = await searchParams;
  const t = await getTranslations({ locale, namespace: 'Categories' });

  if (await alreadyNotFound()) {
    return { title: t('categoryNotFoundTitle'), robots: { index: false, follow: false } };
  }

  const found = await lookup(slug, locale);
  if (found.kind === 'not_found') {
    return { title: t('categoryNotFoundTitle'), robots: { index: false, follow: false } };
  }
  if (found.kind !== 'found') {
    // The catalogue could not be read. The page says so, and nothing about it is indexable.
    return { title: t('categoryErrorTitle'), robots: { index: false, follow: false } };
  }

  const { category, seo } = found;
  // Any filter at all, including one that did not parse: a view a visitor reached by asking for something
  // the contract refuses is not a page to index either.
  const asked = filtersOf(query);
  const filtered = asked === null || !catalogFiltersAreEmpty(asked);
  // The admin's meta description, then the category's own description, then nothing at all — an
  // invented sentence would be worse than none.
  const description = seo.metaDescription ?? category.description;

  // The SEO module's own override is merged in last by one shared resolver (8-F), so the order of precedence is
  // most-specific-first: the `seo_metadata` entry for this category and locale, then the category's own translated
  // meta fields, then the category's name and description. Any other order would make the override screen do nothing
  // for a category that happens to carry a translated meta title, which is a silent failure nobody could diagnose.
  //
  // **Neither of 8-D's decisions can be undone by an override.** The canonical passed below is built from the slug
  // alone and never from the query string, and a stored canonical is withheld for a category — so a filtered view
  // still points at the unfiltered page. The robots value below is the floor and a stored directive may only narrow
  // it, so a filtered view stays `noindex` however the override is written.
  return await metadataWithOverride(
    { entityType: 'category', slug: category.slug, locale },
    {
      // The admin's meta title when there is one, otherwise the category's name.
      title: seo.metaTitle ?? category.name,
      description,
      canonical: categoryPath(locale, category.slug),
      languages: {
        en: `/category/${encodeURIComponent(category.slug)}`,
        ar: `/ar/category/${encodeURIComponent(category.slug)}`,
      },
      // Stated explicitly: the root layout's default is `noindex, nofollow`, and metadata is merged from
      // the root down, so a page that says nothing about robots inherits that refusal.
      //
      // **A filtered view is `noindex`, and its canonical is the unfiltered page.** The combinations are
      // unbounded and every one of them is a slice of the same shelf, so indexing them would be asking a
      // crawler to spend its budget on near-duplicates of a page that is already indexed.
      index: !filtered,
      follow: true,
    },
  );
}

export default async function CategoryPage({ params, searchParams }: PageParams) {
  const { locale, slug } = await params;
  const query = await searchParams;
  const t = await getTranslations({ locale, namespace: 'Categories' });

  if (await alreadyNotFound()) {
    return (
      <PageContainer>
        <div className="py-12">
          <ListingMessage
            tone="empty"
            title={t('categoryNotFoundTitle')}
            description={t('categoryNotFoundDescription')}
          />
        </div>
      </PageContainer>
    );
  }

  const found = await lookup(slug, locale);

  if (found.kind === 'not_found') notFound();

  if (found.kind === 'unavailable') {
    return (
      <PageContainer>
        <div className="py-12">
          <ListingMessage tone="error" title={t('categoryErrorTitle')} description={t('categoryError')} />
        </div>
      </PageContainer>
    );
  }

  // A filter the contract refuses is told to the visitor rather than silently ignored, because ignoring it
  // would show them a wider set than they asked for — the one direction a filter must never move.
  const asked = filtersOf(query);
  const cursorRaw = query['cursor'];
  const cursor = typeof cursorRaw === 'string' && cursorRaw !== '' ? cursorRaw : null;

  return (
    <PageContainer>
      <div className="py-12">
        <CategoryDetailView
          category={found.category}
          hrefFor={(childSlug) => categoryPath(locale, childSlug)}
          labels={{
            subcategoriesHeading: t('subcategoriesHeading'),
            emptyChildrenTitle: t('emptyChildrenTitle'),
            emptyChildren: t('emptyChildren'),
            parentHeading: t('parentHeading'),
          }}
        />

        {asked === null ? (
          <div className="mt-8">
            <ListingMessage tone="error" title={t('filtersInvalidTitle')} description={t('filtersInvalid')} />
          </div>
        ) : (
          <CategoryListings
            locale={locale}
            slug={found.category.slug}
            filters={asked}
            cursor={cursor}
          />
        )}
      </div>
    </PageContainer>
  );
}

/**
 * The listings in this category, and the panel that narrowed them.
 *
 * **Two empties, said differently.** A category with nothing in it gets one sentence; a category whose
 * filters currently match nothing gets another, with the panel still there so the filter can be undone. The
 * API distinguishes them by whether the panel came back populated, and the distinction is the whole reason a
 * visitor can tell "this shelf is bare" from "I asked for too much".
 *
 * **Paging is a link and filtering is a form**, both carrying their state in the query string, so every view
 * of this page has an address — and changing a filter deliberately drops the cursor, because resuming
 * somebody else's page of a different question would be nonsense.
 */
async function CategoryListings({
  locale,
  slug,
  filters,
  cursor,
}: {
  readonly locale: string;
  readonly slug: string;
  readonly filters: CatalogFilters;
  readonly cursor: string | null;
}) {
  const [t, tListings, tServices, tFilters, tPagination] = await Promise.all([
    getTranslations({ locale, namespace: 'Categories' }),
    getTranslations({ locale, namespace: 'Listings' }),
    getTranslations({ locale, namespace: 'Services' }),
    getTranslations({ locale, namespace: 'CatalogFilters' }),
    getTranslations({ locale, namespace: 'Pagination' }),
  ]);

  const feed = await readCategoryFeed(slug, { locale, filters, cursor });

  if (feed.kind === 'invalid') {
    return (
      <div className="mt-8">
        <ListingMessage tone="error" title={t('filtersInvalidTitle')} description={t('filtersInvalid')} />
      </div>
    );
  }
  if (feed.kind === 'not_found' || feed.kind === 'unavailable') {
    // `not_found` cannot normally be reached here — the category was already resolved — so both are the
    // honest "could not be read", which must never read as "this category is empty".
    return (
      <div className="mt-8">
        <ListingMessage tone="error" title={t('categoryErrorTitle')} description={t('categoryError')} />
      </div>
    );
  }

  const panel = (
    <CatalogFilterPanel
      action={categoryPath(locale, slug)}
      facets={feed.facets}
      filters={filters}
      labels={{
        heading: tFilters('heading'),
        apply: tFilters('apply'),
        clear: tFilters('clear'),
        tagsHeading: tFilters('tagsHeading'),
        listingTypeHeading: tFilters('listingTypeHeading'),
        priceHeading: tFilters('priceHeading'),
        priceFrom: tFilters('priceFrom'),
        priceTo: tFilters('priceTo'),
        priceCurrency: tFilters('priceCurrency'),
        from: tFilters('from'),
        to: tFilters('to'),
        typeProduct: tFilters('typeProduct'),
        typeService: tFilters('typeService'),
        yes: tFilters('yes'),
        no: tFilters('no'),
        matches: (count: number) => tFilters('matches', { count }),
      }}
    />
  );

  if (feed.items.length === 0) {
    return (
      <>
        <div className="mt-8">
          <ListingMessage
            tone="empty"
            title={feed.facets.length === 0 ? t('feedEmptyTitle') : t('feedNoMatchesTitle')}
            description={feed.facets.length === 0 ? t('feedEmpty') : t('feedNoMatches')}
          />
        </div>
        {panel}
      </>
    );
  }

  // The next page keeps every filter and changes only the cursor, so paging never widens a filtered list.
  // The same filters with no cursor are this feed's own first page, which is where "back to the start" goes.
  const next = feed.nextCursor;
  const firstParams = new URLSearchParams(catalogFiltersToParams(filters));
  const nextParams = new URLSearchParams(firstParams);
  if (next !== null) nextParams.set('cursor', next);
  const firstQuery = firstParams.toString();

  return (
    <>
      <h2 className="mt-10 text-lg font-semibold text-neutral-900">{t('feedHeading')}</h2>
      <CatalogToolbar
        count={feed.items.length}
        labels={{ ordering: tFilters('ordering'), resultCount: (count) => tFilters('resultCount', { count }) }}
        className="mb-6"
      />
      <SearchResultList
        results={feed.items}
        listingHref={(itemSlug) => listingPath(locale, itemSlug)}
        serviceHref={(itemSlug) => servicePath(locale, itemSlug)}
        labels={{
          listing: {
            contactForPrice: tListings('contactForPrice'),
            negotiable: tListings('negotiable'),
          },
          service: {
            contactForPrice: tServices('contactForPrice'),
            negotiable: '',
            fixedPrice: tServices('fixedPrice'),
            customPricing: tServices('customPricing'),
            deliveryTime: tServices('deliveryTime'),
            revisionsIncluded: tServices('revisionsIncluded'),
            deliveryDays: (count: number) => tServices('deliveryDays', { count }),
          },
        }}
      />
      <Pagination
        nextHref={next === null ? null : `${categoryPath(locale, slug)}?${nextParams.toString()}`}
        firstHref={firstQuery === '' ? categoryPath(locale, slug) : `${categoryPath(locale, slug)}?${firstQuery}`}
        paged={cursor !== null}
        labels={{
          next: t('feedMore'),
          first: tPagination('first'),
          navigation: tPagination('navigation'),
        }}
        className="mt-10"
      />
      {panel}
    </>
  );
}
