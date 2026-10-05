import { PageContainer } from '@repo/ui';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound, permanentRedirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { cache } from 'react';
import { ListingDetailView, ListingMessage } from '../../../../components/listing-views';
import { MakeOfferButton } from '../../../../components/make-offer';
import { StartConversationButton } from '../../../../components/start-conversation';
import { ReportForm } from '../../../../components/report-form';
import { reportCopy } from '../../../../components/report-copy';
import { startConversationLabels } from '../../../../components/start-conversation-labels';
import { CATALOG_OUTCOME_HEADER } from '../../../../proxy';
import { readListing, type ListingLookup } from '../../../../server/bff';
import { metadataWithOverride } from '../../../../server/public-metadata';

/**
 * `/listing/[slug]` and `/ar/listing/[slug]` — one public listing.
 *
 * Four outcomes reach this page, and each becomes the response the owner approved:
 *
 *   * **found** — 200 with the listing rendered into the HTML;
 *   * **moved** — the slug was a previous one, so the browser is sent to the current URL with a 301, which
 *     is what keeps a shared link working and a search engine's index pointed at one address;
 *   * **not_found** — 404, identically for a listing that never existed, one still in draft, one that was
 *     rejected and one whose seller is suspended;
 *   * **unavailable** — the catalogue could not be read. The page renders and says so.
 *
 * A listing that is no longer purchasable still answers 200 with its content and an availability marker,
 * because the page was shared and linked while it was live; it carries `noindex` so it leaves the index
 * rather than standing as a live result.
 *
 * **Where the status comes from.** The 301 and the 404 are issued by the middleware, which resolves the
 * slug before anything renders. They cannot be issued from here: Next.js 16 streams, so by the time this
 * component has awaited anything the status line is already sent, and `permanentRedirect` or `notFound`
 * called at that point produces the right body under a 200. The middleware tells this page about the 404
 * it already issued through a request header, so the not-found view costs no second read. The
 * `permanentRedirect` and `notFound` calls below stay as a backstop for any path that reaches this
 * component without having passed the middleware; they render the right thing, only the status is weaker.
 *
 * The lookup is wrapped in `cache` so that `generateMetadata` and the page body share one read per
 * request instead of asking the API twice for the same listing.
 */

interface PageParams {
  readonly params: Promise<{ locale: string; slug: string }>;
}

const lookup = cache(
  async (slug: string, locale: string): Promise<ListingLookup> => readListing(slug, locale),
);

/** Whether the middleware already answered 404 for this request. */
const alreadyNotFound = cache(async (): Promise<boolean> => {
  return (await headers()).get(CATALOG_OUTCOME_HEADER) === 'not_found';
});

function listingPath(locale: string, slug: string): string {
  return `${locale === 'ar' ? '/ar' : ''}/listing/${encodeURIComponent(slug)}`;
}

export async function generateMetadata({ params }: PageParams): Promise<Metadata> {
  const { locale, slug } = await params;
  const t = await getTranslations({ locale, namespace: 'Listings' });

  if (await alreadyNotFound()) {
    return { title: t('notFoundTitle'), robots: { index: false, follow: false } };
  }

  const found = await lookup(slug, locale);

  if (found.kind !== 'found') {
    // Nothing here is indexable: a redirect, a 404 and a failure are all handled by the page itself.
    return { title: t('notFoundTitle'), robots: { index: false, follow: false } };
  }

  const { listing } = found;
  const unavailable = listing.availability === 'no_longer_available';

  // The administrator's override is merged in by one shared resolver (8-F). The canonical below is the only one this
  // page can have: the reader withholds a stored canonical for a listing, so the self-referencing address stands
  // whatever anybody wrote. The robots decision below is the floor, and a stored directive may only narrow it — so a
  // listing that is no longer available stays `noindex` however the override is written.
  return await metadataWithOverride(
    { entityType: 'listing', slug: listing.slug, locale },
    {
      title: listing.title,
      description: listing.description.slice(0, 160),
      canonical: listingPath(locale, listing.slug),
      languages: {
        en: `/listing/${encodeURIComponent(listing.slug)}`,
        ar: `/ar/listing/${encodeURIComponent(listing.slug)}`,
      },
      // Stated on every branch: the root layout's default is `noindex, nofollow`, and metadata is merged
      // from the root down, so a page that says nothing about robots inherits that refusal.
      index: !unavailable,
      follow: true,
    },
  );
}

export default async function ListingPage({ params }: PageParams) {
  const { locale, slug } = await params;
  const [t, messages, session] = await Promise.all([
    getTranslations({ locale, namespace: 'Listings' }),
    getTranslations({ locale, namespace: 'Messages' }),
    getTranslations({ locale, namespace: 'Session' }),
  ]);
  const offer = await getTranslations({ locale, namespace: 'MakeOffer' });
  const report = await getTranslations({ locale, namespace: 'Report' });

  // The middleware has already answered 404 for this request and said so. Render the localized
  // not-found view under that status, without asking the API about a listing nobody may see.
  if (await alreadyNotFound()) {
    return (
      <PageContainer>
        <div className="py-12">
          <ListingMessage
            tone="empty"
            title={t('notFoundTitle')}
            description={t('notFoundDescription')}
          />
        </div>
      </PageContainer>
    );
  }

  const found = await lookup(slug, locale);

  if (found.kind === 'moved') {
    // A previous slug is a permanent move, so the browser gets a 301 to the current URL.
    permanentRedirect(listingPath(locale, found.canonicalSlug));
  }
  if (found.kind === 'not_found') notFound();

  if (found.kind === 'unavailable') {
    return (
      <PageContainer>
        <div className="py-12">
          <ListingMessage tone="error" title={t('errorTitle')} description={t('errorDescription')} />
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <div className="py-12">
        <ListingDetailView
          listing={found.listing}
          labels={{
            contactForPrice: t('contactForPrice'),
            negotiable: t('negotiable'),
            noLongerAvailable: t('noLongerAvailable'),
            sellerHeading: t('sellerHeading'),
            categoryHeading: t('categoryHeading'),
            detailsHeading: t('detailsHeading'),
            tagsHeading: t('tagsHeading'),
            descriptionHeading: t('descriptionHeading'),
            yes: t('yes'),
            no: t('no'),
          }}
        />

        {/*
          The contact action, and only while the listing is still purchasable: a listing that is no longer
          available cannot be contacted about, and the database says so too, so a button here would promise
          something that always refuses. The listing id is the subject; no seller identifier is involved.
        */}
        {found.listing.availability === 'available' ? (
          <div className="mt-8">
            <StartConversationButton
              subject={{ kind: 'listing', listingId: found.listing.id }}
              messagesPath={`${locale === 'ar' ? '/ar' : ''}/dashboard/messages`}
              loginPath={`${locale === 'ar' ? '/ar' : ''}/login`}
              labels={startConversationLabels({
                action: messages('contactSeller'),
                working: messages('working'),
                signIn: session('signIn'),
                cannotMessage: messages('cannotMessage'),
                failed: messages('actionFailed'),
              })}
            />
          </div>
        ) : null}

        {/*
          The offer action, on the same condition as the contact action and for the same reason: a listing
          that is no longer purchasable cannot be offered on, and the database says so too. The listing's
          own currency is passed so somebody typing an amount knows the unit; it is never sent back, because
          the currency of an offer comes out of the listing row inside the database. `isNegotiable` is not
          used as a gate here — it is the seller's display hint, and the offers schema does not condition
          on it, so gating on it would be a rule this increment invented.
        */}
        {found.listing.availability === 'available' ? (
          <div className="mt-8">
            <MakeOfferButton
              listingId={found.listing.id}
              currencyCode={found.listing.currencyCode}
              offersPath={`${locale === 'ar' ? '/ar' : ''}/dashboard/offers`}
              loginPath={`${locale === 'ar' ? '/ar' : ''}/login`}
              copy={{
                action: offer('action'),
                heading: offer('heading'),
                amountLabel: offer('amountLabel'),
                amountHint: offer('amountHint'),
                quantityLabel: offer('quantityLabel'),
                noteLabel: offer('noteLabel'),
                send: offer('send'),
                cancel: offer('cancel'),
                working: offer('working'),
                amountRequired: offer('amountRequired'),
                signIn: session('signIn'),
                failedAlreadyOpen: offer('failedAlreadyOpen'),
                failedOwnListing: offer('failedOwnListing'),
                failedNotAvailable: offer('failedNotAvailable'),
                failedBlocked: offer('failedBlocked'),
                failedGeneric: offer('failedGeneric'),
              }}
            />
          </div>
        ) : null}

        {/*
          Reporting the listing, and unlike the two actions above it is offered whatever the availability: a
          listing that is sold, expired or archived still has a page, still has content somebody may need to
          report, and the reporting path does not condition on availability — 0047's resolver admits every
          publicly visible state. The subject is the slug this page is addressed by; no listing id and no
          seller identifier is involved, which is the whole reason the subject travels as a slug.
        */}
        <div className="mt-8 border-t border-neutral-200 pt-6">
          <ReportForm
            subject={{ subjectType: 'listing', subjectSlug: found.listing.slug }}
            loginPath={`${locale === 'ar' ? '/ar' : ''}/login`}
            copy={reportCopy(report)}
          />
        </div>
      </div>
    </PageContainer>
  );
}
