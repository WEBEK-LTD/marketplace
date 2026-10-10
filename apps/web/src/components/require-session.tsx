import { Heading, PageContainer } from '@repo/ui';
import { headers } from 'next/headers';
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { readCurrentUser } from '../server/bff';
import { DashboardNav } from './dashboard-nav';
import { SessionKeeper } from './session-keeper';

/**
 * The server-side gate every protected page renders inside (Phase 5-A).
 *
 * **Why this is a component and not a layout.** A layout that refuses to render `children` hides the
 * page from the document and nothing more: Next.js renders the page segment independently, so its output
 * still reaches the browser inside the streamed RSC payload. That was measured, not assumed — a first
 * version of this gate lived in `dashboard/layout.tsx` and the protection test found the whole settings
 * page, labels and all, in the flight data of a signed-out response. For the settings page that was
 * copy; for a page that renders somebody's conversations it would be their conversations.
 *
 * A server component inside the page does not have that problem. `children` is a React element that is
 * only *invoked* if this component returns it, so when the answer is "signed out" the protected subtree
 * is never rendered, never serialized and never sent. A protected page therefore has one rule: build
 * nothing outside this wrapper.
 *
 * **What it decides, and what it does not.** It asks the API who the caller is, presenting the caller's
 * own access cookie. That is the real check; the middleware's cookie-presence redirect in front of it is
 * only there so that a visitor with no session at all gets a redirect status rather than a page, which
 * has to be decided before the response commits.
 *
 * A forged cookie, an expired token, a revoked session and a deleted account all arrive here and all get
 * the same signed-out view. None of them is distinguished, because a visitor learning *why* they are
 * signed out learns something about an account they may not own.
 *
 * An unreachable API is deliberately a third case. It is not a sign-out — the session may be perfectly
 * good — so it says so, offers no sign-in link that would be a lie, and makes no renewal attempt.
 */
export async function RequireSession({ children }: { readonly children: ReactNode }) {
  const [locale, t, requestHeaders] = await Promise.all([
    getLocale(),
    getTranslations('Session'),
    headers(),
  ]);
  const session = await readCurrentUser({ cookieHeader: requestHeaders.get('cookie') });

  if (session.kind === 'authenticated') {
    return (
      <>
        <SessionKeeper mode="keep" />
        <DashboardNav locale={locale} />
        {children}
      </>
    );
  }

  const unavailable = session.kind === 'unavailable';

  return (
    <PageContainer>
      <div className="py-12" role="status">
        <Heading level={1}>{unavailable ? t('unavailableTitle') : t('expiredTitle')}</Heading>
        <p className="mt-4 max-w-prose text-ink-muted">
          {unavailable ? t('unavailableBody') : t('expiredBody')}
        </p>
        {!unavailable && (
          <Link
            href={locale === 'ar' ? '/ar/login' : '/login'}
            className="mt-6 inline-block rounded-md border border-edge px-4 py-2 text-sm"
          >
            {t('signIn')}
          </Link>
        )}
      </div>
      {/* One attempt to renew an access token that has merely expired — the common case a quarter of
          an hour after signing in. A refused renewal leaves the sign-in link above and stops. */}
      {!unavailable && <SessionKeeper mode="restore" />}
    </PageContainer>
  );
}
