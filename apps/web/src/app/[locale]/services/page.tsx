import { Heading, PageContainer } from '@repo/ui';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { ServiceGrid, ServiceGridSkeleton, ServiceMessage } from '../../../components/service-views';
import { readServices } from '../../../server/bff';

/**
 * `/services` and `/ar/services` — the public service list.
 *
 * A server component, for the same reason as the listing surface: a service is content, and the HTML has
 * to carry it for a crawler and for a visitor with no JavaScript.
 *
 * Paging is a link, not a button. The cursor lives in the query string, so a page of results has a URL
 * that can be shared, bookmarked and reloaded, and the browser's back button does the obvious thing.
 */

interface PageParams {
  readonly params: Promise<{ locale: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function basePath(locale: string): string {
  return locale === 'ar' ? '/ar/services' : '/services';
}

function servicePath(locale: string, slug: string): string {
  return `${locale === 'ar' ? '/ar' : ''}/service/${encodeURIComponent(slug)}`;
}

/**
 * The service list is canonical at its unparameterised URL only.
 *
 * A cursor page is the same catalogue seen from a different offset, so indexing each one would spend a
 * crawler's budget on near-duplicates. Pages past the first carry `noindex, follow`: not indexed, but
 * still crawled through to the services themselves.
 */
export async function generateMetadata({ params, searchParams }: PageParams): Promise<Metadata> {
  const { locale } = await params;
  const query = await searchParams;
  const t = await getTranslations({ locale, namespace: 'Services' });
  const paged = typeof query['cursor'] === 'string' && query['cursor'] !== '';

  return {
    title: t('title'),
    description: t('description'),
    alternates: {
      canonical: basePath(locale),
      languages: { en: '/services', ar: '/ar/services' },
    },
    // Stated on both branches: the root layout's default is `noindex, nofollow`, and metadata is merged
    // from the root down, so saying nothing here would inherit that refusal.
    robots: paged ? { index: false, follow: true } : { index: true, follow: true },
  };
}

/** The part that waits on the API, so the heading above it renders immediately. */
async function ServicesSection({ locale, cursor }: { readonly locale: string; readonly cursor: string | null }) {
  const t = await getTranslations({ locale, namespace: 'Services' });
  const page = await readServices({ cursor });

  if (page === null) {
    return <ServiceMessage tone="error" title={t('errorTitle')} description={t('errorDescription')} />;
  }
  if (page.items.length === 0) {
    return <ServiceMessage tone="empty" title={t('emptyTitle')} description={t('emptyDescription')} />;
  }

  const labels = {
    contactForPrice: t('contactForPrice'),
    negotiable: '',
    fixedPrice: t('fixedPrice'),
    customPricing: t('customPricing'),
    deliveryTime: t('deliveryTime'),
    revisionsIncluded: t('revisionsIncluded'),
    deliveryDays: (count: number) => t('deliveryDays', { count }),
  };

  return (
    <>
      <ServiceGrid services={page.items} hrefFor={(slug) => servicePath(locale, slug)} labels={labels} />
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

export default async function ServicesPage({ params, searchParams }: PageParams) {
  const { locale } = await params;
  const query = await searchParams;
  const t = await getTranslations({ locale, namespace: 'Services' });
  const raw = query['cursor'];
  const cursor = typeof raw === 'string' && raw !== '' ? raw : null;

  return (
    <PageContainer>
      <div className="py-12">
        <Heading level={1}>{t('title')}</Heading>
        <p className="mt-2 max-w-prose text-neutral-600">{t('description')}</p>
        {/* Keyed by the cursor so moving to the next page shows the loading state again. */}
        <Suspense key={cursor ?? 'first'} fallback={<ServiceGridSkeleton label={t('loading')} />}>
          <ServicesSection locale={locale} cursor={cursor} />
        </Suspense>
      </div>
    </PageContainer>
  );
}
