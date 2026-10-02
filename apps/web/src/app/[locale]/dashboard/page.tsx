import type { Locale } from '@repo/shared-types';
import { Heading, PageContainer } from '@repo/ui';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { RequireSession } from '../../../components/require-session';
import { readBuyerProfile } from '../../../server/bff';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Account');
  // Explicit, because the root layout's default is noindex and a signed-in surface must stay that way.
  return { title: t('title'), robots: { index: false, follow: false } };
}

/**
 * The buyer dashboard (Phase 7-E).
 *
 * The home of the signed-in account: a greeting that comes from the person's own profile, and a card
 * for each surface they own. Every card is a real destination that exists — favorites, saved searches,
 * addresses, profile, settings, security, and the two 5-D/7-C surfaces that were already here. There is
 * no placeholder panel and no card for anything that has not been built.
 *
 * **Seller links are deliberately absent.** A person who is not a seller has no storefront, and the
 * seller area has its own shell and its own navigation. Nothing here reaches it.
 *
 * The whole body sits inside {@link RequireSession}, which is what keeps a signed-out visitor from
 * receiving any of it. That wrapper is a server component rather than a layout for a measured reason: a
 * layout that declines to render its children still streams the page's own subtree into the RSC payload,
 * so the gate has to be inside the page.
 *
 * The greeting is read separately from the rest, inside its own `Suspense` boundary, so a profile read
 * that fails leaves the person with a working set of links rather than an error page.
 */
export default async function DashboardPage({
  params,
}: {
  readonly params: Promise<{ readonly locale: Locale }>;
}) {
  const [{ locale }, t, messages, notifications, favorites, savedSearches, addresses, profile, settings, security] =
    await Promise.all([
      params,
      getTranslations('Account'),
      getTranslations('Messages'),
      getTranslations('Notifications'),
      getTranslations('Favorites'),
      getTranslations('SavedSearches'),
      getTranslations('Addresses'),
      getTranslations('Profile'),
      getTranslations('Settings'),
      getTranslations('Security'),
    ]);

  const prefix = locale === 'ar' ? '/ar' : '';
  const cards: readonly { readonly href: string; readonly title: string; readonly body: string }[] = [
    { href: `${prefix}/dashboard/favorites`, title: favorites('title'), body: t('favoritesCard') },
    { href: `${prefix}/dashboard/saved-searches`, title: savedSearches('title'), body: t('savedSearchesCard') },
    { href: `${prefix}/dashboard/addresses`, title: addresses('title'), body: t('addressesCard') },
    { href: `${prefix}/dashboard/profile`, title: profile('title'), body: t('profileCard') },
    { href: `${prefix}/dashboard/settings`, title: settings('title'), body: t('settingsCard') },
    { href: `${prefix}/dashboard/security`, title: security('title'), body: t('securityCard') },
    { href: `${prefix}/dashboard/messages`, title: messages('title'), body: t('messagesCard') },
    { href: `${prefix}/dashboard/notifications`, title: notifications('title'), body: t('notificationsCard') },
  ];

  return (
    <RequireSession>
      <PageContainer>
        <div className="py-12">
          <Suspense fallback={<Heading level={1}>{t('greetingAnonymous')}</Heading>}>
            <Greeting />
          </Suspense>
          <p className="mt-2 max-w-prose text-neutral-600">{t('intro')}</p>

          <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label={t('title')}>
            {cards.map((card) => (
              <li key={card.href}>
                <Link
                  href={card.href}
                  className="block h-full rounded-lg border border-neutral-200 p-4 hover:border-neutral-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900"
                >
                  <span className="block text-base font-medium text-neutral-900">{card.title}</span>
                  <span className="mt-1 block text-sm text-neutral-600">{card.body}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </PageContainer>
    </RequireSession>
  );
}

/**
 * The greeting, read on its own.
 *
 * Anything other than a successful read greets the person without a name. A profile that could not be
 * loaded is not worth an error here: the page's job is to get somebody to the surface they wanted.
 */
async function Greeting() {
  const [t, requestHeaders] = await Promise.all([getTranslations('Account'), headers()]);
  const result = await readBuyerProfile({ cookieHeader: requestHeaders.get('cookie') });
  const name = result.kind === 'ok' ? result.data.profile.displayName : null;

  return (
    <Heading level={1}>{name === null ? t('greetingAnonymous') : t('greeting', { name })}</Heading>
  );
}
