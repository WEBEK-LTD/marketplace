import { Breadcrumb, PageContainer } from '@repo/ui';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound, permanentRedirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { cache } from 'react';
import { ReportForm } from '../../../../components/report-form';
import { reportCopy } from '../../../../components/report-copy';
import { EnquireButton } from '../../../../components/listing-enquiry';
import { ServiceDetailView, ServiceMessage } from '../../../../components/service-views';
import { CATALOG_OUTCOME_HEADER } from '../../../../proxy';
import { readService, type ServiceLookup } from '../../../../server/bff';
import { metadataWithOverride } from '../../../../server/public-metadata';

/**
 * `/service/[slug]` and `/ar/service/[slug]` — one public service.
 *
 * Four outcomes reach this page:
 *
 *   * **found** — 200 with the service rendered into the HTML;
 *   * **moved** — the slug is a previous one, or it names a product; either way the browser is sent to the
 *     canonical URL on the surface that owns it, so one listing never has two public addresses;
 *   * **not_found** — 404, identically for a service that never existed, one still in draft, one that was
 *     rejected and one whose seller is suspended;
 *   * **unavailable** — the catalogue could not be read. The page renders and says so.
 *
 * A service that is no longer purchasable still answers 200 with its content and an availability marker;
 * it carries `noindex` so it leaves the index rather than standing as a live result.
 *
 * **Where the status comes from.** The 301 and the 404 are issued by the middleware, which resolves the
 * slug before anything renders. They cannot be issued from here: Next.js 16 streams, so by the time this
 * component has awaited anything the status line is already sent. The middleware tells this page about
 * the 404 it already issued through a request header, so the not-found view costs no second read.
 */

interface PageParams {
  readonly params: Promise<{ locale: string; slug: string }>;
}

const lookup = cache(
  async (slug: string, locale: string): Promise<ServiceLookup> => readService(slug, locale),
);

/** Whether the middleware already answered 404 for this request. */
const alreadyNotFound = cache(async (): Promise<boolean> => {
  return (await headers()).get(CATALOG_OUTCOME_HEADER) === 'not_found';
});

function servicePath(locale: string, slug: string): string {
  return `${locale === 'ar' ? '/ar' : ''}/service/${encodeURIComponent(slug)}`;
}

function listingPath(locale: string, slug: string): string {
  return `${locale === 'ar' ? '/ar' : ''}/listing/${encodeURIComponent(slug)}`;
}

export async function generateMetadata({ params }: PageParams): Promise<Metadata> {
  const { locale, slug } = await params;
  const t = await getTranslations({ locale, namespace: 'Services' });

  if (await alreadyNotFound()) {
    return { title: t('notFoundTitle'), robots: { index: false, follow: false } };
  }

  const found = await lookup(slug, locale);
  if (found.kind !== 'found') {
    return { title: t('notFoundTitle'), robots: { index: false, follow: false } };
  }

  const { service } = found;
  const unavailable = service.availability === 'no_longer_available';

  // The administrator's override is merged in by one shared resolver (8-F). A service is a `listings` row, so its
  // override is a `listing` entry — 0030 has no `service` kind — and its stored canonical is withheld like any other
  // listing's, leaving the self-referencing address below as the only one this page can have.
  return await metadataWithOverride(
    { entityType: 'listing', slug: service.slug, locale },
    {
      title: service.title,
      description: service.description.slice(0, 160),
      canonical: servicePath(locale, service.slug),
      languages: {
        en: `/service/${encodeURIComponent(service.slug)}`,
        ar: `/ar/service/${encodeURIComponent(service.slug)}`,
      },
      // Stated on every branch: the root layout's default is `noindex, nofollow`, and metadata is merged
      // from the root down, so a page that says nothing about robots inherits that refusal.
      index: !unavailable,
      follow: true,
    },
  );
}

export default async function ServicePage({ params }: PageParams) {
  const { locale, slug } = await params;
  const [t, enquiry, session, tAccessibility] = await Promise.all([
    getTranslations({ locale, namespace: 'Services' }),
    getTranslations({ locale, namespace: 'Enquiry' }),
    getTranslations({ locale, namespace: 'Session' }),
    getTranslations({ locale, namespace: 'Accessibility' }),
  ]);
  const report = await getTranslations({ locale, namespace: 'Report' });

  // The middleware has already answered 404 for this request and said so. Render the localized
  // not-found view under that status, without asking the API about a service nobody may see.
  if (await alreadyNotFound()) {
    return (
      <PageContainer>
        <div className="py-12">
          <ServiceMessage tone="empty" title={t('notFoundTitle')} description={t('notFoundDescription')} />
        </div>
      </PageContainer>
    );
  }

  const found = await lookup(slug, locale);

  if (found.kind === 'moved') {
    // A backstop only: the middleware issues the real 301 before anything renders.
    permanentRedirect(
      found.canonicalType === 'service'
        ? servicePath(locale, found.canonicalSlug)
        : listingPath(locale, found.canonicalSlug),
    );
  }
  if (found.kind === 'not_found') notFound();

  if (found.kind === 'unavailable') {
    return (
      <PageContainer>
        <div className="py-12">
          <ServiceMessage tone="error" title={t('errorTitle')} description={t('errorDescription')} />
        </div>
      </PageContainer>
    );
  }

  const prefix = locale === 'ar' ? '/ar' : '';

  return (
    <PageContainer>
      <div className="py-12">
        {/*
          Where this service sits in the catalogue. Built from the detail contract's own `category`, which until
          0109 was printed as plain text in the facts card — named but not reachable. Both hrefs are routes that
          already exist, so the trail is navigation rather than a new read.
        */}
        <Breadcrumb
          label={tAccessibility('breadcrumb')}
          className="mb-6"
          items={[
            { label: t('title'), href: `${prefix}/services` },
            { label: found.service.category.name, href: `${prefix}/category/${found.service.category.slug}` },
            { label: found.service.title },
          ]}
        />
        <ServiceDetailView
          service={found.service}
          labels={{
            contactForPrice: t('contactForPrice'),
            negotiable: '',
            fixedPrice: t('fixedPrice'),
            customPricing: t('customPricing'),
            deliveryTime: t('deliveryTime'),
            revisionsIncluded: t('revisionsIncluded'),
            deliveryDays: (count: number) => t('deliveryDays', { count }),
            noLongerAvailable: t('noLongerAvailable'),
            requiresBrief: t('requiresBrief'),
            scope: t('scope'),
            sellerHeading: t('sellerHeading'),
            categoryHeading: t('categoryHeading'),
            detailsHeading: t('detailsHeading'),
            tagsHeading: t('tagsHeading'),
            descriptionHeading: t('descriptionHeading'),
            yes: t('yes'),
            no: t('no'),
          }}
          actions={
            <>
        {/*
          The enquiry action (OD-A4), which was 7-I's request-a-quote action until the office replaced the
          seller as the party that answers.

          No session is read here: the page is public and cacheable, and the markup is the same for everyone.
          Whether this visitor owns the listing is the database's to answer, not this page's to guess.
        */}
        {/*
          The enquiry is offered on any available service, not only a custom-priced one. The pricing-model
          gate belonged to 7-I, where a brief was a request for a *quote* and a fixed-price service had
          nothing to quote. Under OD-A1 every sale is concluded at the office whatever the listing says, so
          gating on the pricing model would hide the only action the page has.
        */}
        {found.service.availability === 'available' ? (
          <>
            <EnquireButton
              listingId={found.service.id}
              currencyCode={found.service.currencyCode}
              requestsPath={`${locale === 'ar' ? '/ar' : ''}/dashboard/service-requests`}
              loginPath={`${locale === 'ar' ? '/ar' : ''}/login`}
              copy={{
                action: enquiry('action'),
                heading: enquiry('heading'),
                titleLabel: enquiry('titleLabel'),
                briefLabel: enquiry('briefLabel'),
                budgetLabel: enquiry('budgetLabel'),
                budgetHint: enquiry('budgetHint'),
                neededByLabel: enquiry('neededByLabel'),
                send: enquiry('send'),
                cancel: enquiry('cancel'),
                working: enquiry('working'),
                titleRequired: enquiry('titleRequired'),
                briefRequired: enquiry('briefRequired'),
                budgetInvalid: enquiry('budgetInvalid'),
                signIn: session('signIn'),
                failedNotCustom: enquiry('failedNotCustom'),
                failedOwnListing: enquiry('failedOwnListing'),
                failedNotAvailable: enquiry('failedNotAvailable'),
                failedBlocked: enquiry('failedBlocked'),
                failedGeneric: enquiry('failedGeneric'),
              }}
            />
          </>
        ) : null}
            </>
          }
        />


        {/*
          Reporting the service. **The subject type is `listing`**, not a type of its own: a service is a row
          in `public.listings` with a service `listing_type_code`, sharing one table and one slug namespace,
          and 0027's eight subject types contain no `service`. Inventing one would be inventing a subject
          type; using `listing` is naming the row as the schema names it. Offered whatever the availability,
          for the reason the listing page gives.
        */}
        <div className="mt-8 border-t border-hairline pt-6">
          <ReportForm
            subject={{ subjectType: 'listing', subjectSlug: found.service.slug }}
            loginPath={`${locale === 'ar' ? '/ar' : ''}/login`}
            copy={reportCopy(report)}
          />
        </div>
      </div>
    </PageContainer>
  );
}
