import type { Locale } from '@repo/shared-types';
import { Heading, PageContainer } from '@repo/ui';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ListingMessage } from '../../../../../components/listing-views';
import { RequireSession } from '../../../../../components/require-session';
import {
  SellerMediaForm,
  type SellerMediaFormLabels,
} from '../../../../../components/seller-media-form';
import {
  SellerProfileForm,
  type SellerProfileFormLabels,
} from '../../../../../components/seller-profile-form';
import { SellerDashboardNav } from '../../../../../components/seller-dashboard-nav';
import { readSellerIdentity } from '../../../../../server/bff';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('SellerProfile');
  return { title: t('title'), robots: { index: false, follow: false } };
}

/**
 * `/dashboard/seller/profile` — the seller's own profile, and the form that edits it (Phase 6-D).
 *
 * **Protection is 5-A's, unchanged.** Everything below is inside {@link RequireSession}, a server component
 * rather than a layout, for the reason 6-B established: a layout that declines to render `children` still
 * streams the page segment's RSC payload, so a signed-out visitor would receive the form in the flight data
 * of a page they never see.
 *
 * **Three read-only facts, rendered by the server.** The slug, the status and the verification state are
 * displayed here and are not props of the form — there is no version of them in the client bundle that
 * could be edited or posted. The slug carries the one sentence that matters about it: it cannot be changed.
 *
 * **The form appears only when the storefront may actually be edited.** `pending` and `active` get it;
 * `suspended` and `closed` get their state and a sentence saying the profile cannot be edited in it, and no
 * form at all — so no mutation request can be made, rather than being made and refused. The API refuses
 * those states too; this is the surface agreeing with it, not the surface deciding it.
 *
 * **What the form can pre-fill, and what it cannot.** The 6-A projection carries six fields, and 6-D was
 * not permitted to add a read operation or change that projection, so this page can show the display name,
 * the city and the country and not the legal name, bio, language, governorate or contact details. Those
 * boxes start blank and a blank box preserves what is stored — said once, in the form, in the approved
 * copy's own terms. A seller can therefore set those fields here but not clear them from this screen; the
 * API supports clearing, and an increment that adds a seller-profile read can offer it.
 *
 * **No creation.** A caller with no storefront is sent to the 6-C surface rather than shown a second
 * onboarding form, because two forms that create the same thing are two things that have to agree.
 */
export default async function SellerProfilePage({
  params,
}: {
  readonly params: Promise<{ readonly locale: Locale }>;
}) {
  const [{ locale }, t, dashboard, session, sellers, media] = await Promise.all([
    params,
    getTranslations('SellerProfile'),
    getTranslations('SellerDashboard'),
    getTranslations('Session'),
    getTranslations('Sellers'),
    getTranslations('SellerMedia'),
  ]);
  const prefix = locale === 'ar' ? '/ar' : '';

  // Strings only, and the three values the form must display in order to edit them.
  const labels: SellerProfileFormLabels = {
    edit: t('edit'),
    displayName: t('displayName'),
    legalName: t('legalName'),
    bio: t('bio'),
    language: t('language'),
    country: t('country'),
    governorate: t('governorate'),
    city: t('city'),
    contactEmail: t('contactEmail'),
    contactPhone: t('contactPhone'),
    save: t('save'),
    saving: t('saving'),
    saved: t('saved'),
    errorInvalid: t('errorInvalid'),
    errorUnavailable: t('errorUnavailable'),
    notEditable: t('notEditable'),
    retry: t('retry'),
    unchangedHint: t('unchangedHint'),
  };

  // Strings only, again: this is the whole of what the media controls receive.
  const mediaLabels: SellerMediaFormLabels = {
    title: media('title'),
    logo: media('logo'),
    banner: media('banner'),
    chooseFile: media('chooseFile'),
    upload: media('upload'),
    uploading: media('uploading'),
    uploaded: media('uploaded'),
    noFile: media('noFile'),
    typeNotAllowed: media('typeNotAllowed'),
    tooLarge: media('tooLarge'),
    errorUnavailable: media('errorUnavailable'),
    notEditable: media('notEditable'),
    retry: media('retry'),
    allowedTypes: media('allowedTypes'),
  };

  const cookieHeader = (await headers()).get('cookie');
  const identity = await readSellerIdentity({ cookieHeader });

  const statusLabel = (status: string): string => {
    if (status === 'active') return dashboard('statusActive');
    if (status === 'suspended') return dashboard('statusSuspended');
    if (status === 'closed') return dashboard('statusClosed');
    return dashboard('statusPending');
  };
  const verificationLabel = (status: string): string => {
    if (status === 'verified') return dashboard('verificationVerified');
    if (status === 'rejected') return dashboard('verificationRejected');
    if (status === 'pending') return dashboard('verificationPending');
    return dashboard('verificationUnverified');
  };

  return (
    <RequireSession>
      <PageContainer>
        <div className="py-12">
          <Heading level={1}>{t('title')}</Heading>

          <SellerDashboardNav locale={locale} />

          {identity.kind === 'ok' ? (
            <>
              {/* The read-only facts. Rendered here, on the server, so none of them is a form value. */}
              <dl className="mt-8 grid max-w-xl grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2">
                <div className="flex justify-between gap-4 border-b border-neutral-100 py-2">
                  <dt className="text-sm text-neutral-600">{t('slug')}</dt>
                  <dd className="text-sm font-medium text-neutral-900">{identity.seller.slug}</dd>
                </div>
                <div className="flex justify-between gap-4 border-b border-neutral-100 py-2">
                  <dt className="text-sm text-neutral-600">{dashboard('status')}</dt>
                  <dd className="text-sm font-medium text-neutral-900">
                    {statusLabel(identity.seller.status)}
                  </dd>
                </div>
                <div className="flex justify-between gap-4 border-b border-neutral-100 py-2">
                  <dt className="text-sm text-neutral-600">{dashboard('verificationStatus')}</dt>
                  <dd className="text-sm font-medium text-neutral-900">
                    {verificationLabel(identity.seller.verificationStatus)}
                  </dd>
                </div>
              </dl>
              <p className="mt-2 max-w-prose text-sm text-neutral-600">{t('slugPermanent')}</p>

              {identity.seller.status === 'suspended' || identity.seller.status === 'closed' ? (
                // State, and why there is no form. No reason, no moderation note, no appeal machinery —
                // none of that is in the contract and none of it is this page's to invent.
                <div role="status" className="mt-8">
                  <p className="text-neutral-900">
                    {identity.seller.status === 'suspended' ? t('suspended') : t('closed')}
                  </p>
                  <p className="mt-2 max-w-prose text-sm text-neutral-600">{t('notEditable')}</p>
                </div>
              ) : (
                <>
                  <SellerProfileForm
                    labels={labels}
                    known={{
                      // Projected field by field: the three editable values the identity carries, and nothing
                      // that happens to sit beside them.
                      displayName: identity.seller.displayName,
                      city: identity.seller.city,
                      countryCode: identity.seller.countryCode,
                    }}
                  />
                  {/* Media, in the same branch as the editing form and for the same reason: a suspended or
                      closed storefront receives no mutation authorization, so it is offered no control that
                      would ask for one. */}
                  <SellerMediaForm labels={mediaLabels} />
                </>
              )}
            </>
          ) : identity.kind === 'not_a_seller' ? (
            // No storefront to edit. The way in is 6-C's, and it is a link rather than a second form.
            <div role="status" className="mt-8">
              <p className="text-neutral-900">{dashboard('notASeller')}</p>
              <p className="mt-4">
                <Link
                  href={`${prefix}/dashboard/seller`}
                  className="text-sm underline decoration-neutral-300 underline-offset-4 hover:decoration-neutral-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900"
                >
                  {dashboard('title')}
                </Link>
              </p>
            </div>
          ) : identity.kind === 'unauthenticated' ? (
            <div role="status" className="mt-8">
              <p className="max-w-prose text-neutral-600">{session('expiredBody')}</p>
              <p className="mt-4">
                <Link
                  href={`${prefix}/login`}
                  className="text-sm underline decoration-neutral-300 underline-offset-4 hover:decoration-neutral-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900"
                >
                  {session('signIn')}
                </Link>
              </p>
            </div>
          ) : (
            <div className="mt-8">
              <ListingMessage tone="error" title={t('errorUnavailable')} description={sellers('error')} />
            </div>
          )}
        </div>
      </PageContainer>
    </RequireSession>
  );
}
