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
import { sellerCanMutate } from '../../../../../components/seller-listing-forms';
import {
  SellerServiceCreateForm,
  type RenderableServiceCategory,
  type SellerServiceCreateLabels,
} from '../../../../../components/seller-service-create-form';
import {
  renderableService,
  serviceActions,
} from '../../../../../components/seller-service-forms';
import {
  SellerServiceRow,
  type SellerServiceArchiveLabels,
  type SellerServiceEditLabels,
  type SellerServiceRowLabels,
  type SellerServiceSubmitLabels,
} from '../../../../../components/seller-service-row';
import { readCategories, readSellerIdentity, readSellerServices } from '../../../../../server/bff';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('SellerServices');
  return { title: t('title'), robots: { index: false, follow: false } };
}

/**
 * `/dashboard/seller/services` — the seller's own services, and S-8's four operations (Phase 6-G).
 *
 * **Protection is 5-A's, unchanged.** Everything below is inside {@link RequireSession}, a server component
 * rather than a layout, for the reason 6-B established and 6-D and 6-F repeated: a layout that declines to
 * render `children` still streams the page segment's RSC payload, so a signed-out visitor would receive the
 * services in the flight data of a page they never see.
 *
 * **Everything is read on the server**, and projected field by field before it reaches the one client
 * component that renders it — the services through {@link renderableService}, the category tree through the
 * flattener below, which drops the uuid every node carries. A client component's props become part of the RSC
 * payload, so the projection is what decides what a browser gets.
 *
 * **All four operations live here.** The index is this page; creation is a form below it; editing is an
 * inline disclosure on each row; submitting and archiving are the row's two confirmed actions, which post to
 * the *listing* routes, because those move the same `listings` row and the API's submitter is already
 * service-aware. There is no second path to either of those moves and no delete anywhere.
 *
 * **Controls appear only where a mutation is actually permitted.** A `suspended` or `closed` storefront still
 * sees its services — reading one's own rows is not a mutation — but is offered no create form and no row
 * controls at all, and is told why. Within a storefront that may mutate, each row offers exactly what its own
 * status allows, and a control that is not permitted is absent rather than disabled.
 *
 * **The products page is a different page.** This reader returns services only, so nothing here can reach a
 * product, and the listings surface is untouched.
 */

/** The tree, flattened to the two fields a form may see. Depth-first, so children follow their parent. */
function flattenCategories(nodes: readonly CategoryNode[]): RenderableServiceCategory[] {
  const out: RenderableServiceCategory[] = [];
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

export default async function SellerServicesPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: Locale }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ locale }, query, t, dashboard, session, sellers, vocabulary] = await Promise.all([
    params,
    searchParams,
    getTranslations('SellerServices'),
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
    readSellerServices({ cookieHeader, cursor }),
    readCategories(locale),
  ]);

  const createLabels: SellerServiceCreateLabels = {
    create: t('create'),
    slug: t('slug'),
    slugPermanent: t('slugPermanent'),
    titleField: t('titleField'),
    description: t('description'),
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
    pricing: t('pricing'),
    pricingModel: t('pricingModel'),
    pricingUnset: t('pricingUnset'),
    pricingFixed: t('pricingFixed'),
    pricingCustom: t('pricingCustom'),
    pricingHint: t('pricingHint'),
    deliveryDays: t('deliveryDays'),
    deliveryDaysHint: t('deliveryDaysHint'),
    revisions: t('revisions'),
    requiresBrief: t('requiresBrief'),
    scope: t('scope'),
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

  const rowLabels = (status: string): SellerServiceRowLabels => ({
    status: t('status'),
    statusLabel: statusLabel(status),
    category: t('category'),
    price: t('price'),
    noPrice: t('noPrice'),
    negotiable: t('negotiable'),
    pricing: t('pricing'),
    noPricing: t('noPricing'),
    pricingFixed: t('pricingFixed'),
    pricingCustom: t('pricingCustom'),
    deliveryDays: t('deliveryDays'),
    noDelivery: t('noDelivery'),
    revisions: t('revisions'),
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

  // One label group per action this service actually offers, and null for the rest. A control the state does
  // not allow therefore has no copy to render with, and its copy is not in the RSC payload either.
  const editLabels = (): SellerServiceEditLabels => ({
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
    pricing: t('pricing'),
    pricingModel: t('pricingModel'),
    pricingUnset: t('pricingUnset'),
    pricingFixed: t('pricingFixed'),
    pricingCustom: t('pricingCustom'),
    pricingHint: t('pricingHint'),
    deliveryDays: t('deliveryDays'),
    deliveryDaysHint: t('deliveryDaysHint'),
    revisions: t('revisions'),
    requiresBrief: t('requiresBrief'),
    scope: t('scope'),
    save: t('save'),
    saving: t('saving'),
    saved: t('saved'),
  });
  const submitLabels = (): SellerServiceSubmitLabels => ({
    submit: t('submit'),
    submitting: t('submitting'),
    submitConfirm: t('submitConfirm'),
  });
  const archiveLabels = (): SellerServiceArchiveLabels => ({
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
            // no services", which would be a page telling somebody their work had vanished.
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

              <section aria-labelledby="seller-services-heading" className="mt-8">
                <h2 id="seller-services-heading" className="text-lg font-semibold text-ink-strong">
                  {t('yourServices')}
                </h2>

                {page.kind === 'ok' && page.services.length > 0 ? (
                  <ul className="mt-4 border-t border-hairline">
                    {page.services.map((service) => {
                      const render = renderableService(service);
                      const actions = serviceActions(render.status, canMutate);
                      return (
                        <SellerServiceRow
                          key={render.slug}
                          service={render}
                          labels={rowLabels(render.status)}
                          canMutate={canMutate}
                          edit={actions.includes('edit') ? editLabels() : null}
                          submit={actions.includes('submit') ? submitLabels() : null}
                          archive={actions.includes('archive') ? archiveLabels() : null}
                          // Reading one's own details is not a mutation, so the link is offered on every row;
                          // whether they can be changed is the vocabulary page's own answer from the API.
                          details={{
                            href: `${prefix}/dashboard/seller/services/${encodeURIComponent(render.slug)}`,
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
                      href={`${prefix}/dashboard/seller/services?cursor=${encodeURIComponent(page.nextCursor)}`}
                      className="text-sm underline decoration-edge underline-offset-4 hover:decoration-ink-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary"
                    >
                      {t('nextPage')}
                    </Link>
                  </p>
                ) : null}
              </section>

              {canMutate ? (
                <SellerServiceCreateForm
                  labels={createLabels}
                  categories={categories === null ? [] : flattenCategories(categories.categories)}
                  // The currencies this seller already prices services in, read off their own rows. No code
                  // is named in source anywhere on this surface — owner decision E3.
                  currencies={
                    page.kind === 'ok'
                      ? [...new Set(page.services.map((service) => service.currencyCode))]
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
