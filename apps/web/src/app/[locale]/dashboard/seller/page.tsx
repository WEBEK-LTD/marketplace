import type { Locale } from '@repo/shared-types';
import { Heading, PageContainer } from '@repo/ui';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ListingMessage } from '../../../../components/listing-views';
import { RequireSession } from '../../../../components/require-session';
import {
  SellerAccountView,
  type SellerAccountLabels,
} from '../../../../components/seller-account-view';
import { SellerDashboardNav } from '../../../../components/seller-dashboard-nav';
import {
  SellerOnboardingForm,
  type SellerOnboardingLabels,
} from '../../../../components/seller-onboarding-form';
import { readSellerIdentity } from '../../../../server/bff';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('SellerDashboard');
  // Explicit, because the root layout's default is noindex and a signed-in surface must stay that way.
  return { title: t('title'), robots: { index: false, follow: false } };
}

/**
 * `/dashboard/seller` — the seller area's landing page (Phase 6-B).
 *
 * **Why it lives under `/dashboard`.** The public seller profile is `/seller/[slug]`, and the middleware
 * resolves any single lowercase segment after `/seller/` as a profile slug. An authenticated area at
 * `/seller/overview` would therefore have been answered as "no seller owns the slug `overview`". Putting
 * the area under `/dashboard/seller` avoids that collision entirely and inherits the protection that
 * prefix already has, which is the same resolution messaging took for `/dashboard/messages`.
 *
 * **What protects it.** {@link RequireSession}, exactly as every other signed-in page. It is a server
 * component rather than a layout for a measured reason: a layout that declines to render `children` still
 * streams the page's own subtree into the RSC payload, so a signed-out visitor would receive the seller
 * shell in the flight data of a page they never see. Everything below is therefore inside the wrapper.
 *
 * **What it renders, and what it cannot.** The six fields `GET /v1/sellers/me` returns, through the
 * server-side reader on one internal hop. There is no client component on this page at all, so no seller
 * data crosses into a client bundle; and the contract carries no identifier, contact detail, suspension
 * reason, object path or timestamp, so there is nothing here to leak even by accident.
 *
 * **Four states, four different answers.** A storefront in any state is shown as it is — a seller must be
 * able to see that their own account is pending, suspended or closed. No storefront says so and stops
 * there. A session that ended between the gate and this read shows the session-ended view. And a failing
 * service shows an error: it is emphatically *not* turned into "you are not a seller", which would be a
 * page telling somebody their shop does not exist because a request timed out.
 *
 * 6-B adds no write control of any kind, so a suspended seller sees a state rather than a disabled form.
 */
export default async function SellerDashboardPage({
  params,
}: {
  readonly params: Promise<{ readonly locale: Locale }>;
}) {
  const [{ locale }, t, session, sellers, onboarding] = await Promise.all([
    params,
    getTranslations('SellerDashboard'),
    getTranslations('Session'),
    // The failure copy is 4-E's and is reused rather than reinvented: this is a seller profile that could
    // not be loaded, which is the sentence that namespace already owns.
    getTranslations('Sellers'),
    getTranslations('SellerOnboarding'),
  ]);
  const prefix = locale === 'ar' ? '/ar' : '';

  const labels: SellerAccountLabels = {
    account: t('account'),
    status: t('status'),
    verificationStatus: t('verificationStatus'),
    city: t('city'),
    country: t('country'),
    statusLabel: (status) => {
      if (status === 'active') return t('statusActive');
      if (status === 'suspended') return t('statusSuspended');
      if (status === 'closed') return t('statusClosed');
      return t('statusPending');
    },
    verificationLabel: (status) => {
      if (status === 'verified') return t('verificationVerified');
      if (status === 'rejected') return t('verificationRejected');
      if (status === 'pending') return t('verificationPending');
      return t('verificationUnverified');
    },
  };

  // Strings only. This is everything that crosses into the client bundle on this page, and it is all copy:
  // no seller, no identifier, no token, no API address.
  const onboardingLabels: SellerOnboardingLabels = {
    createProfile: onboarding('createProfile'),
    slug: onboarding('slug'),
    slugHint: onboarding('slugHint'),
    slugPermanent: onboarding('slugPermanent'),
    displayName: onboarding('displayName'),
    legalName: onboarding('legalName'),
    bio: onboarding('bio'),
    language: onboarding('language'),
    country: onboarding('country'),
    governorate: onboarding('governorate'),
    city: onboarding('city'),
    contactEmail: onboarding('contactEmail'),
    contactPhone: onboarding('contactPhone'),
    submit: onboarding('submit'),
    submitting: onboarding('submitting'),
    pending: onboarding('pending'),
    errorExists: onboarding('errorExists'),
    errorSlugTaken: onboarding('errorSlugTaken'),
    errorInvalid: onboarding('errorInvalid'),
    errorUnavailable: onboarding('errorUnavailable'),
    retry: onboarding('retry'),
  };

  const cookieHeader = (await headers()).get('cookie');
  const identity = await readSellerIdentity({ cookieHeader });

  return (
    <RequireSession>
      <PageContainer>
        <div className="py-12">
          <Heading level={1}>{t('title')}</Heading>

          <SellerDashboardNav locale={locale} />

          {identity.kind === 'ok' ? (
            <SellerAccountView seller={identity.seller} labels={labels} />
          ) : identity.kind === 'not_a_seller' ? (
            // No storefront yet, so this is where one is created (6-C). The sentence stays: it is what tells
            // somebody who arrived here from a link why they are being shown a form. The form is rendered
            // only in this branch, so a seller who already has a storefront is never offered a second
            // creation control anywhere on this page.
            <>
              <p role="status" className="mt-8 text-neutral-900">
                {t('notASeller')}
              </p>
              <SellerOnboardingForm labels={onboardingLabels} />
            </>
          ) : identity.kind === 'unauthenticated' ? (
            // The session ended between this page's own gate and the seller read. Not a storefront state.
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
            // The service could not answer. Deliberately an error rather than "not a seller".
            <div className="mt-8">
              <ListingMessage
                tone="error"
                title={sellers('errorTitle')}
                description={sellers('error')}
              />
            </div>
          )}
        </div>
      </PageContainer>
    </RequireSession>
  );
}
