import type { Locale } from '@repo/shared-types';
import type { CategoryNode } from '@repo/contracts';
import { Heading, PageContainer } from '@repo/ui';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ListingMessage } from '../../../../../components/listing-views';
import { RequireSession } from '../../../../../components/require-session';
import { SellerDashboardNav } from '../../../../../components/seller-dashboard-nav';
import {
  SellerListingCreateForm,
  type RenderableCategory,
  type SellerListingCreateLabels,
} from '../../../../../components/seller-listing-create-form';
import {
  listingActions,
  renderableListing,
  sellerCanMutate,
} from '../../../../../components/seller-listing-forms';
import {
  SellerListingRow,
  type SellerListingArchiveLabels,
  type SellerListingEditLabels,
  type SellerListingRowLabels,
  type SellerListingSubmitLabels,
} from '../../../../../components/seller-listing-row';
import { readCategories, readSellerIdentity, readSellerListings } from '../../../../../server/bff';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('SellerListings');
  return { title: t('title'), robots: { index: false, follow: false } };
}

/**
 * `/dashboard/seller/listings` — the seller's own listings, and S-8's four operations (Phase 6-F).
 *
 * **Protection is 5-A's, unchanged.** Everything below is inside {@link RequireSession}, a server component
 * rather than a layout, for the reason 6-B established and 6-D repeated: a layout that declines to render
 * `children` still streams the page segment's RSC payload, so a signed-out visitor would receive the listings
 * in the flight data of a page they never see.
 *
 * **Everything is read on the server.** The listings and the category names are fetched through the BFF's
 * server-side readers, so no token reaches a browser and no client component has to fetch in order to render.
 * The listings themselves are projected field by field into a narrow render type before they reach the one
 * client component that shows them, and the category tree's uuids are dropped in the same way — a client
 * component's props become part of the RSC payload, so the projection is what decides what a browser gets.
 *
 * **All five surfaces live here.** The index is this page; creation is a form below it; editing, submitting
 * and archiving are the controls on each row. Editing is an inline disclosure rather than a second route on
 * purpose: the listings read already carries every editable field, so an edit form can be filled from the
 * page a person is already on, without a second read operation and without a route that could show a listing
 * the index did not.
 *
 * **Controls appear only where a mutation is actually permitted.** A `suspended` or `closed` storefront still
 * sees its listings — reading one's own rows is not a mutation — but is offered no create form and no row
 * controls at all, and is told why. Within a storefront that may mutate, each row offers exactly what its own
 * status allows. Nothing is rendered disabled in the hope that the server will refuse it; a control that is
 * not permitted is not there.
 *
 * **Pagination is a link.** The next page is an ordinary anchor carrying the opaque cursor, so it works
 * without JavaScript and the back button does what it should.
 */

/** The tree, flattened to the two fields a form may see. Depth-first, so children follow their parent. */
function flattenCategories(nodes: readonly CategoryNode[]): RenderableCategory[] {
  const out: RenderableCategory[] = [];
  const walk = (list: readonly CategoryNode[], prefix: string): void => {
    for (const node of list) {
      const name = prefix === '' ? node.name : `${prefix} › ${node.name}`;
      // Projected field by field: the node's uuid is not carried, so it cannot reach a browser.
      out.push({ slug: node.slug, name });
      walk(node.children, name);
    }
  };
  walk(nodes, '');
  return out;
}

export default async function SellerListingsPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: Locale }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ locale }, query, t, dashboard, session, sellers, vocabulary] = await Promise.all([
    params,
    searchParams,
    getTranslations('SellerListings'),
    getTranslations('SellerDashboard'),
    getTranslations('Session'),
    getTranslations('Sellers'),
    getTranslations('SellerVocabulary'),
  ]);
  const prefix = locale === 'ar' ? '/ar' : '';

  const cursorParam = query['cursor'];
  const cursor = typeof cursorParam === 'string' && cursorParam !== '' ? cursorParam : null;

  const cookieHeader = (await headers()).get('cookie');
  const [identity, page, categories] = await Promise.all([
    readSellerIdentity({ cookieHeader }),
    readSellerListings({ cookieHeader, cursor }),
    readCategories(locale),
  ]);

  const createLabels: SellerListingCreateLabels = {
    create: t('create'),
    slug: t('slug'),
    slugPermanent: t('slugPermanent'),
    titleField: t('titleField'),
    description: t('description'),
    listingType: t('listingType'),
    typeProduct: t('typeProduct'),
    typeService: t('typeService'),
    category: t('category'),
    categoryHint: t('categoryHint'),
    language: t('language'),
    currency: t('currency'),
    currencyHint: t('currencyHint'),
    country: t('country'),
    price: t('price'),
    priceHint: t('priceHint'),
    negotiable: t('negotiable'),
    governorate: t('governorate'),
    city: t('city'),
    createSubmit: t('createSubmit'),
    creating: t('creating'),
    created: t('created'),
    errorInvalid: t('errorInvalid'),
    errorSlugTaken: t('errorSlugTaken'),
    errorNotEditable: t('errorNotEditable'),
    errorUnavailable: t('errorUnavailable'),
  };

  const statusLabel = (status: string): string => {
    if (status === 'pending_review') return t('statusPendingReview');
    if (status === 'approved') return t('statusApproved');
    if (status === 'active') return t('statusActive');
    if (status === 'sold') return t('statusSold');
    if (status === 'expired') return t('statusExpired');
    if (status === 'archived') return t('statusArchived');
    if (status === 'rejected') return t('statusRejected');
    if (status === 'suspended') return t('statusSuspended');
    return t('statusDraft');
  };

  const rowLabels = (status: string): SellerListingRowLabels => ({
    status: t('status'),
    statusLabel: statusLabel(status),
    category: t('category'),
    price: t('price'),
    noPrice: t('noPrice'),
    negotiable: t('negotiable'),
    mediaCount: t('mediaCount'),
    noMedia: t('noMedia'),
    awaitingReview: t('awaitingReview'),
    confirm: t('confirm'),
    cancel: t('cancel'),
    errorInvalid: t('errorInvalid'),
    errorIncomplete: t('errorIncomplete'),
    errorNotEditable: t('errorNotEditable'),
    errorUnavailable: t('errorUnavailable'),
  });

  // One label group per action this listing actually offers, and null for the rest. A control the state
  // does not allow therefore has no copy to render with, and its copy is not in the RSC payload either:
  // the decision is made here, on the server, rather than sent to a browser to be honoured.
  const editLabels = (): SellerListingEditLabels => ({
    edit: t('edit'),
    titleField: t('titleField'),
    description: t('description'),
    price: t('price'),
    priceHint: t('priceHint'),
    negotiable: t('negotiable'),
    language: t('language'),
    currency: t('currency'),
    country: t('country'),
    governorate: t('governorate'),
    city: t('city'),
    save: t('save'),
    saving: t('saving'),
    saved: t('saved'),
  });
  const submitLabels = (): SellerListingSubmitLabels => ({
    submit: t('submit'),
    submitting: t('submitting'),
    submitConfirm: t('submitConfirm'),
  });
  const archiveLabels = (): SellerListingArchiveLabels => ({
    archive: t('archive'),
    archiving: t('archiving'),
    archiveConfirm: t('archiveConfirm'),
  });

  const canMutate = identity.kind === 'ok' && sellerCanMutate(identity.seller.status);

  return (
    <RequireSession>
      <PageContainer>
        <div className="py-12">
          <Heading level={1}>{t('title')}</Heading>

          <SellerDashboardNav locale={locale} />

          {identity.kind === 'not_a_seller' ? (
            // No storefront, so no listings. The way in is 6-C's, reached through the seller landing page.
            <div role="status" className="mt-8">
              <p className="text-ink-strong">{dashboard('notASeller')}</p>
              <p className="mt-4">
                <Link
                  href={`${prefix}/dashboard/seller`}
                  className="text-sm underline decoration-edge underline-offset-4 hover:decoration-ink-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary"
                >
                  {dashboard('title')}
                </Link>
              </p>
            </div>
          ) : identity.kind === 'unauthenticated' || page.kind === 'unauthenticated' ? (
            <div role="status" className="mt-8">
              <p className="max-w-prose text-ink-muted">{session('expiredBody')}</p>
              <p className="mt-4">
                <Link
                  href={`${prefix}/login`}
                  className="text-sm underline decoration-edge underline-offset-4 hover:decoration-ink-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary"
                >
                  {session('signIn')}
                </Link>
              </p>
            </div>
          ) : identity.kind === 'unavailable' || page.kind === 'unavailable' ? (
            // Deliberately not folded into the empty state: a failing service must never read as "you have
            // no listings", which would be a page telling somebody their work had vanished.
            <div className="mt-8">
              <ListingMessage
                tone="error"
                title={t('errorUnavailable')}
                description={sellers('error')}
              />
            </div>
          ) : (
            <>
              {identity.kind === 'ok' && !canMutate ? (
                // State, and why there is no form and no controls. No reason, no moderation note, no appeal
                // machinery — none of that is in the contract and none of it is this page's to invent.
                <div role="status" className="mt-8">
                  <p className="text-ink-strong">
                    {identity.seller.status === 'suspended'
                      ? dashboard('statusSuspended')
                      : dashboard('statusClosed')}
                  </p>
                  <p className="mt-2 max-w-prose text-sm text-ink-muted">{t('notEditable')}</p>
                </div>
              ) : null}

              <section aria-labelledby="seller-listings-heading" className="mt-8">
                <h2 id="seller-listings-heading" className="text-lg font-semibold text-ink-strong">
                  {t('yourListings')}
                </h2>

                {page.kind === 'ok' && page.listings.length > 0 ? (
                  <ul className="mt-4 border-t border-hairline">
                    {page.listings.map((listing) => {
                      const render = renderableListing(listing);
                      const actions = listingActions(render.status, canMutate);
                      return (
                        <SellerListingRow
                          key={render.slug}
                          listing={render}
                          labels={rowLabels(render.status)}
                          canMutate={canMutate}
                          edit={actions.includes('edit') ? editLabels() : null}
                          submit={actions.includes('submit') ? submitLabels() : null}
                          archive={actions.includes('archive') ? archiveLabels() : null}
                          // Reading one's own details is not a mutation, so the link is offered on every row;
                          // whether they can be changed is the vocabulary page's own answer from the API.
                          details={{
                            href: `${prefix}/dashboard/seller/listings/${encodeURIComponent(render.slug)}`,
                            label: vocabulary('openLink'),
                          }}
                        />
                      );
                    })}
                  </ul>
                ) : (
                  <p role="status" className="mt-4 text-ink-muted">
                    {t('empty')}
                  </p>
                )}

                {page.kind === 'ok' && page.nextCursor !== null ? (
                  <p className="mt-6">
                    <Link
                      href={`${prefix}/dashboard/seller/listings?cursor=${encodeURIComponent(page.nextCursor)}`}
                      className="text-sm underline decoration-edge underline-offset-4 hover:decoration-ink-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary"
                    >
                      {t('nextPage')}
                    </Link>
                  </p>
                ) : null}
              </section>

              {canMutate ? (
                <SellerListingCreateForm
                  labels={createLabels}
                  categories={categories === null ? [] : flattenCategories(categories.categories)}
                  // The currencies this seller already prices in, read off their own rows. No code is
                  // named in source anywhere on this surface — owner decision E3 — so a seller with no
                  // listings yet is asked for one instead of being given a guess.
                  currencies={
                    page.kind === 'ok'
                      ? [...new Set(page.listings.map((listing) => listing.currencyCode))]
                      : []
                  }
                />
              ) : null}
            </>
          )}
        </div>
      </PageContainer>
    </RequireSession>
  );
}
