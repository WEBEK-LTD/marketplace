import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

const LINK_CLASS =
  'text-sm underline decoration-edge underline-offset-4 hover:decoration-ink-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary';

/**
 * The seller area's own navigation (Phase 6-B).
 *
 * Separate from `DashboardNav` on purpose, and not an extension of it: that one belongs to messaging and
 * settings, and growing it would mean every signed-in page carrying seller links whether or not the person
 * is a seller. This one renders inside the seller shell only.
 *
 * **A link per page that exists, and not one more.** 6-B shipped it with a single link because a single
 * seller page existed; 6-D added the profile, 6-F the listings, 6-G the services, 6-I the verification,
 * 6-J the five read-only surfaces, 7-H the offers and 7-I the service request inbox — each exactly the
 * extension the component was shaped for, a list item rather than a rebuilt shell. Shipping is still absent, because the approved S-11 decision keeps shipping
 * configuration for Phase 8 and a navigation that listed it today would be a link that 404s.
 *
 * A real `<nav>` with an accessible name, an ordinary anchor inside a list — keyboard-reachable, working
 * without JavaScript, and mirrored by logical properties rather than by a second stylesheet under `/ar`.
 */
export async function SellerDashboardNav({ locale }: { readonly locale: string }) {
  const [
    t,
    profile,
    listings,
    services,
    verification,
    orders,
    reviews,
    earnings,
    promotions,
    analytics,
  ] =
    await Promise.all([
      getTranslations('SellerDashboard'),
      getTranslations('SellerProfile'),
      getTranslations('SellerListings'),
      getTranslations('SellerServices'),
      getTranslations('SellerVerification'),
      getTranslations('SellerOffers'),
      getTranslations('SellerServiceRequests'),
      getTranslations('SellerOrders'),
      getTranslations('SellerReviews'),
      getTranslations('SellerEarnings'),
      getTranslations('SellerPromotions'),
      getTranslations('SellerAnalytics'),
    ]);
  const prefix = locale === 'ar' ? '/ar' : '';

  return (
    <nav aria-label={t('title')} className="mt-6 border-y border-hairline">
      <div className="mx-auto w-full max-w-6xl">
        <ul className="flex flex-wrap items-center gap-6 py-3">
          <li>
            <Link href={`${prefix}/dashboard/seller`} className={LINK_CLASS}>
              {t('title')}
            </Link>
          </li>
          <li>
            <Link href={`${prefix}/dashboard/seller/profile`} className={LINK_CLASS}>
              {profile('title')}
            </Link>
          </li>
          <li>
            <Link href={`${prefix}/dashboard/seller/listings`} className={LINK_CLASS}>
              {listings('title')}
            </Link>
          </li>
          <li>
            <Link href={`${prefix}/dashboard/seller/services`} className={LINK_CLASS}>
              {services('title')}
            </Link>
          </li>
          <li>
            <Link href={`${prefix}/dashboard/seller/verification`} className={LINK_CLASS}>
              {verification('title')}
            </Link>
          </li>
          <li>
            <Link href={`${prefix}/dashboard/seller/orders`} className={LINK_CLASS}>
              {orders('title')}
            </Link>
          </li>
          <li>
            <Link href={`${prefix}/dashboard/seller/reviews`} className={LINK_CLASS}>
              {reviews('title')}
            </Link>
          </li>
          <li>
            <Link href={`${prefix}/dashboard/seller/earnings`} className={LINK_CLASS}>
              {earnings('title')}
            </Link>
          </li>
          <li>
            <Link href={`${prefix}/dashboard/seller/promotions`} className={LINK_CLASS}>
              {promotions('title')}
            </Link>
          </li>
          <li>
            <Link href={`${prefix}/dashboard/seller/analytics`} className={LINK_CLASS}>
              {analytics('title')}
            </Link>
          </li>
        </ul>
      </div>
    </nav>
  );
}
