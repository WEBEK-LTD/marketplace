import { Heading, PageContainer } from '@repo/ui';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Suspense, cache } from 'react';
import { ListingClickBeacon } from '../../../components/listing-beacon';
import { ListingGrid, ListingGridSkeleton, ListingMessage } from '../../../components/listing-views';
import { ServiceGrid, ServiceGridSkeleton } from '../../../components/service-views';
import { readListings, readServices } from '../../../server/bff';
import { metadataWithOverride } from '../../../server/public-metadata';

/**
 * `/marketplace` and `/ar/marketplace` — the public discovery hub.
 *
 * An **orchestration page**: it owns no data of its own and adds no contract. It shows the first page of
 * the listing surface and the first page of the service surface, through the same BFF functions those
 * surfaces already use, and sends a visitor onward to whichever one they want in full. There is
 * deliberately no `/v1/marketplace`, no `/api/marketplace` and no mixed cursor — aggregating two approved
 * contracts into a third would create a thing to keep in step with both for no gain.
 *
 * The two sections are **independent**, each behind its own `Suspense` boundary and each handling its own
 * failure. A service catalogue that cannot be read must not take the listings down with it: one section
 * says so and the other still renders. That is the whole reason they are not fetched together.
 *
 * V1 has no search box, no filters, no sorting, no promotion or featured ranking, and no CMS-driven
 * sections: the page reads nothing from `homepage_sections`, `banners` or `navigation_menus`.
 */

interface PageParams {
  readonly params: Promise<{ locale: string }>;
}

function prefix(locale: string): string {
  return locale === 'ar' ? '/ar' : '';
}

/** One read each per request, shared by `generateMetadata` and the two sections that render them. */
const lookupListings = cache(async () => readListings({}));
const lookupServices = cache(async () => readServices({}));

export async function generateMetadata({ params }: PageParams): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Marketplace' });

  // A landing address, so its override is a `route` entry and its stored canonical is served (8-F).
  return await metadataWithOverride(
    { routePath: '/marketplace', locale },
    {
      title: t('title'),
      description: t('description'),
      canonical: `${prefix(locale)}/marketplace`,
      languages: { en: '/marketplace', ar: '/ar/marketplace' },
      // Stated explicitly: the root layout's default is `noindex, nofollow`, and metadata is merged from
      // the root down, so a page that says nothing about robots inherits that refusal.
      // **`noindex` when the read failed.** The page still answers 200 and still renders its unavailable
      // region — that is the approved behaviour and a visitor should see an explanation rather than an error
      // code — but a crawler must not be allowed to index that explanation as the page's content. The reads
      // are shared with the body through `cache`, so asking the question here costs no second request. This
      // is the pattern `category/[slug]` already follows.
      // The hub's two sections are independent by design — one failing must not take the other down — so
      // the page is only unindexable when **both** failed and there is genuinely nothing on it to index.
      index: (await lookupListings()) !== null || (await lookupServices()) !== null,
      follow: true,
    },
  );
}

/** A section's "see the whole surface" link. The hub shows a page; the surface owns the pagination. */
function ViewAll({ href, label }: { readonly href: string; readonly label: string }) {
  return (
    <p className="mt-6">
      <a
        href={href}
        className="inline-block rounded border border-edge px-4 py-2 text-sm text-ink-strong hover:border-edge-strong"
      >
        {label}
      </a>
    </p>
  );
}

/** The listing half. Fetched and failing on its own, so the service half is unaffected either way. */
async function ListingsSection({ locale }: { readonly locale: string }) {
  const t = await getTranslations({ locale, namespace: 'Marketplace' });
  const tListings = await getTranslations({ locale, namespace: 'Listings' });
  const page = await lookupListings();

  if (page === null) {
    return (
      <ListingMessage tone="error" title={t('listingsHeading')} description={t('listingsError')} />
    );
  }
  if (page.items.length === 0) {
    return (
      <ListingMessage tone="empty" title={t('listingsHeading')} description={t('listingsEmpty')} />
    );
  }

  return (
    <>
      {/* 0101: one listener for the whole grid. No source: see `ListingClickBeacon`. */}
      <ListingClickBeacon>
        <ListingGrid
          listings={page.items}
          hrefFor={(slug) => `${prefix(locale)}/listing/${encodeURIComponent(slug)}`}
          labels={{
            contactForPrice: tListings('contactForPrice'),
            negotiable: tListings('negotiable'),
          }}
        />
      </ListingClickBeacon>
      <ViewAll href={`${prefix(locale)}/listings`} label={t('viewAllListings')} />
    </>
  );
}

/** The service half, on exactly the same terms. */
async function ServicesSection({ locale }: { readonly locale: string }) {
  const t = await getTranslations({ locale, namespace: 'Marketplace' });
  const tServices = await getTranslations({ locale, namespace: 'Services' });
  const page = await lookupServices();

  if (page === null) {
    return (
      <ListingMessage tone="error" title={t('servicesHeading')} description={t('servicesError')} />
    );
  }
  if (page.items.length === 0) {
    return (
      <ListingMessage tone="empty" title={t('servicesHeading')} description={t('servicesEmpty')} />
    );
  }

  return (
    <>
      <ServiceGrid
        services={page.items}
        hrefFor={(slug) => `${prefix(locale)}/service/${encodeURIComponent(slug)}`}
        labels={{
          contactForPrice: tServices('contactForPrice'),
          negotiable: '',
          fixedPrice: tServices('fixedPrice'),
          customPricing: tServices('customPricing'),
          deliveryTime: tServices('deliveryTime'),
          revisionsIncluded: tServices('revisionsIncluded'),
          deliveryDays: (count: number) => tServices('deliveryDays', { count }),
        }}
      />
      <ViewAll href={`${prefix(locale)}/services`} label={t('viewAllServices')} />
    </>
  );
}

export default async function MarketplacePage({ params }: PageParams) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Marketplace' });

  return (
    <PageContainer>
      <div className="py-12">
        <Heading level={1}>{t('title')}</Heading>
        <p className="mt-2 max-w-prose text-ink-muted">{t('description')}</p>

        <section aria-labelledby="marketplace-listings" className="mt-12">
          <h2 id="marketplace-listings" className="text-lg font-semibold text-ink-strong">
            {t('listingsHeading')}
          </h2>
          <Suspense fallback={<ListingGridSkeleton label={t('listingsLoading')} />}>
            <ListingsSection locale={locale} />
          </Suspense>
        </section>

        <section aria-labelledby="marketplace-services" className="mt-16">
          <h2 id="marketplace-services" className="text-lg font-semibold text-ink-strong">
            {t('servicesHeading')}
          </h2>
          <Suspense fallback={<ServiceGridSkeleton label={t('servicesLoading')} />}>
            <ServicesSection locale={locale} />
          </Suspense>
        </section>
      </div>
    </PageContainer>
  );
}
