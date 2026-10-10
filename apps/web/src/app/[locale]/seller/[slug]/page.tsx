import { PageContainer } from '@repo/ui';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { cache } from 'react';
import { ListingMessage } from '../../../../components/listing-views';
import { SellerProfileView } from '../../../../components/seller-profile';
import { ReportForm } from '../../../../components/report-form';
import { reportCopy } from '../../../../components/report-copy';
import { BlockPerson } from '../../../../components/account-actions';
import { blockCopy } from '../../../../components/block-copy';
import { StartConversationButton } from '../../../../components/start-conversation';
import { startConversationLabels } from '../../../../components/start-conversation-labels';
import { CATALOG_OUTCOME_HEADER } from '../../../../proxy';
import { readSeller, type SellerLookup } from '../../../../server/bff';
import { metadataWithOverride } from '../../../../server/public-metadata';

/**
 * `/seller/[slug]` and `/ar/seller/[slug]` — one public seller profile.
 *
 * Three outcomes:
 *
 *   * **found, available** — 200, indexable, the ordinary profile;
 *   * **found, unavailable** — 200 with the suspended marker and `noindex, follow`. The page exists
 *     because it was linked and shared while the seller traded; it just says they are not trading now;
 *   * **not_found** — 404, identically for a pending seller, a closed seller and a slug that names
 *     nobody. A seller who has applied and not been approved must not be discoverable by guessing.
 *
 * **Where the 404 comes from.** The middleware resolves the slug before anything renders. It cannot be
 * issued from here: Next.js 16 streams, so by the time this component has awaited anything the status
 * line is already sent and `notFound()` would produce the right body under a 200. The middleware says
 * through a request header that it has already answered 404, so the not-found view costs no second read.
 */

interface PageParams {
  readonly params: Promise<{ locale: string; slug: string }>;
}

const lookup = cache(async (slug: string): Promise<SellerLookup> => readSeller(slug));

/** Whether the middleware already answered 404 for this request. */
const alreadyNotFound = cache(async (): Promise<boolean> => {
  return (await headers()).get(CATALOG_OUTCOME_HEADER) === 'not_found';
});

function sellerPath(locale: string, slug: string): string {
  return `${locale === 'ar' ? '/ar' : ''}/seller/${encodeURIComponent(slug)}`;
}

export async function generateMetadata({ params }: PageParams): Promise<Metadata> {
  const { locale, slug } = await params;
  const t = await getTranslations({ locale, namespace: 'Sellers' });

  if (await alreadyNotFound()) {
    return { title: t('notFoundTitle'), robots: { index: false, follow: false } };
  }

  const found = await lookup(slug);
  if (found.kind === 'not_found') {
    return { title: t('notFoundTitle'), robots: { index: false, follow: false } };
  }
  if (found.kind !== 'found') {
    return { title: t('errorTitle'), robots: { index: false, follow: false } };
  }

  const { seller, availability } = found;

  // The administrator's override is merged in by one shared resolver (8-F). A seller's stored canonical is withheld,
  // so the self-referencing address below stands; and the robots decision below is the floor, so a suspended profile
  // stays `noindex` however the override is written. 0030's own predicate withholds a suspended seller's override
  // entirely, which is the same answer reached a second way.
  return await metadataWithOverride(
    { entityType: 'seller', slug: seller.slug, locale },
    {
      // The seller's own name, on a suspended profile as much as a live one.
      title: seller.displayName,
      description: seller.bio ?? t('noDescription'),
      canonical: sellerPath(locale, seller.slug),
      languages: {
        en: `/seller/${encodeURIComponent(seller.slug)}`,
        ar: `/ar/seller/${encodeURIComponent(seller.slug)}`,
      },
      // Stated explicitly: the root layout's default is `noindex, nofollow`, and metadata is merged from
      // the root down, so a page that says nothing about robots inherits that refusal.
      index: availability !== 'unavailable',
      follow: true,
    },
  );
}

export default async function SellerPage({ params }: PageParams) {
  const { locale, slug } = await params;
  const [t, messages, session] = await Promise.all([
    getTranslations({ locale, namespace: 'Sellers' }),
    getTranslations({ locale, namespace: 'Messages' }),
    getTranslations({ locale, namespace: 'Session' }),
  ]);
  const report = await getTranslations({ locale, namespace: 'Report' });
  const blocks = await getTranslations({ locale, namespace: 'Blocks' });

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

  const found = await lookup(slug);

  if (found.kind === 'not_found') notFound();

  if (found.kind === 'unavailable') {
    return (
      <PageContainer>
        <div className="py-12">
          <ListingMessage tone="error" title={t('errorTitle')} description={t('error')} />
        </div>
      </PageContainer>
    );
  }

  const prefix = locale === 'ar' ? '/ar' : '';

  return (
    <PageContainer>
      <div className="py-12">
        <SellerProfileView
          seller={found.seller}
          availability={found.availability}
          labels={{ unavailable: t('unavailable'), noDescription: t('noDescription') }}
          actions={
            <>
        {/*
          The contact action, and only on a profile that is actually trading: a suspended seller cannot be
          contacted, so offering the button there would be offering something that always refuses. The
          seller travels as the slug already in this page's URL — the profile contract has no identifier in
          it, and this page needs none.
        */}
        {found.availability === 'available' ? (
            <StartConversationButton
              subject={{ kind: 'seller', sellerSlug: found.seller.slug }}
              messagesPath={`${prefix}/dashboard/messages`}
              loginPath={`${prefix}/login`}
              labels={startConversationLabels({
                action: messages('contactSeller'),
                working: messages('working'),
                signIn: session('signIn'),
                cannotMessage: messages('cannotMessage'),
                failed: messages('actionFailed'),
              })}
            />
        ) : null}

        {/*
          0103. Blocking this seller, offered on a trading profile for the same reason the contact action is:
          0103's resolver requires a publicly visible storefront, so offering it on a suspended one would be
          offering something that always refuses. The seller travels as the slug already in this page's URL —
          the profile contract has no identifier in it, and this control needs none.

          No session is read to decide whether to draw it. This is a cached public catalogue page and
          personalising it would change that caching, so the control is drawn for everyone and a visitor who
          turns out not to be signed in is offered the way in instead.
        */}
        {found.availability === 'available' ? (
            <BlockPerson
              handle={{ sellerSlug: found.seller.slug }}
              loginPath={`${prefix}/login`}
              copy={blockCopy(blocks)}
            />
        ) : null}
            </>
          }
        />


        {/*
          Reporting the storefront, and unlike the contact action it is offered on a suspended profile too:
          0050 keeps that page reachable and 0076 admits the same two statuses it does, so somebody looking at
          a page they can see can report it. The seller travels as the slug already in this page's URL — the
          profile contract has no identifier in it, and neither does this form.
        */}
        <div className="mt-8 border-t border-hairline pt-6">
          <ReportForm
            subject={{ subjectType: 'seller', subjectSlug: found.seller.slug }}
            loginPath={`${prefix}/login`}
            copy={reportCopy(report)}
          />
        </div>
      </div>
    </PageContainer>
  );
}
