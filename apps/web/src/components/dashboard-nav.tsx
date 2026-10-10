import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

const LINK_CLASS =
  'text-sm underline decoration-edge underline-offset-4 hover:decoration-ink-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary';

/**
 * The authenticated dashboard's navigation (Phase 5-D, extended in 7-E).
 *
 * A link per signed-in surface that exists, and not one more. 5-D shipped it with three because three
 * existed; 7-E adds the six buyer account surfaces and the account home, 7-H the offers, 7-I the service
 * requests, 7-K the reader's own support tickets and 7-M the reports they filed — each exactly the extension
 * the component was shaped for, a list item rather than a rebuilt shell.
 *
 * This is deliberately still not a dashboard chrome: no sidebar, no layout ownership, no active-state
 * machinery. The 5-A wrapper already decides what a signed-in page looks like, and rebuilding that here
 * would be a redesign nobody asked for.
 *
 * **Seller links are not here and never will be.** They live in `SellerDashboardNav`, inside the seller
 * shell, because this navigation renders on every signed-in page and a person who is not a seller must
 * not be offered a storefront they do not have.
 *
 * A real `<nav>` with an accessible name, ordinary anchors inside a list — keyboard-reachable, working
 * without JavaScript, and mirrored by logical properties rather than by a second stylesheet under `/ar`.
 *
 * Deliberately no unread badge: the count is a separate read that is allowed to fail on its own, and
 * putting it here would make every signed-in page depend on it.
 */
export async function DashboardNav({ locale }: { readonly locale: string }) {
  const [
    account,
    messages,
    serviceRequests,
    notifications,
    support,
    reports,
    favorites,
    savedSearches,
    addresses,
    blocks,
    profile,
    settings,
    security,
  ] =
    await Promise.all([
      getTranslations('Account'),
      getTranslations('Messages'),
      getTranslations('Offers'),
      getTranslations('ServiceRequests'),
      getTranslations('Notifications'),
      getTranslations('Support'),
      getTranslations('Reports'),
      getTranslations('Favorites'),
      getTranslations('SavedSearches'),
      getTranslations('Addresses'),
      getTranslations('Blocks'),
      getTranslations('Profile'),
      getTranslations('Settings'),
      getTranslations('Security'),
    ]);
  const prefix = locale === 'ar' ? '/ar' : '';

  const links: readonly { readonly href: string; readonly label: string }[] = [
    { href: `${prefix}/dashboard`, label: account('title') },
    { href: `${prefix}/dashboard/messages`, label: messages('title') },
    { href: `${prefix}/dashboard/service-requests`, label: serviceRequests('title') },
    { href: `${prefix}/dashboard/notifications`, label: notifications('title') },
    { href: `${prefix}/dashboard/support`, label: support('title') },
    { href: `${prefix}/dashboard/reports`, label: reports('title') },
    { href: `${prefix}/dashboard/favorites`, label: favorites('title') },
    { href: `${prefix}/dashboard/saved-searches`, label: savedSearches('title') },
    { href: `${prefix}/dashboard/addresses`, label: addresses('title') },
    { href: `${prefix}/dashboard/blocks`, label: blocks('title') },
    { href: `${prefix}/dashboard/profile`, label: profile('title') },
    { href: `${prefix}/dashboard/settings`, label: settings('title') },
    { href: `${prefix}/dashboard/security`, label: security('title') },
  ];

  return (
    <nav aria-label={account('title')} className="border-b border-hairline">
      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8">
        <ul className="flex flex-wrap items-center gap-x-6 gap-y-2 py-3">
          {links.map((link) => (
            <li key={link.href}>
              <Link href={link.href} className={LINK_CLASS}>
                {link.label}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}
