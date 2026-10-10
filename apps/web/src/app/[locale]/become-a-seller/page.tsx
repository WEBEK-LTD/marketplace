import type { Locale } from '@repo/shared-types';
import { Heading, PageContainer } from '@repo/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('SellerOnboarding');
  return { title: t('title') };
}

/**
 * `/become-a-seller` — the public way in (Phase 6-C).
 *
 * **Public, and it reads nothing.** No session, no cookie, no API call, no seller data of any kind. There is
 * nothing on this page that depends on who is looking at it, which is what makes it safe to serve to anybody
 * and impossible to leak anything from.
 *
 * **One call to action, and it is a link to a route that exists.** The CTA goes to `/dashboard/seller`, and
 * that single destination is correct for all three kinds of visitor, without this page having to find out
 * which one it is talking to:
 *
 *   * signed out → the 5-A middleware redirects to `/login`, which is the existing authentication flow;
 *   * signed in without a storefront → the 6-C onboarding form;
 *   * signed in with one → their own dashboard, and no second creation is offered anywhere.
 *
 * That is the whole reason the CTA is not a bespoke "start onboarding" route: the flow already exists, and a
 * second entrance would be a second thing that has to agree with it. It also means this page never has to
 * decide whether somebody is already a seller — a decision it could only make by reading a session it has no
 * business reading.
 *
 * **Indexability follows the existing rule rather than changing it.** `isPublicCatalogRoute` in
 * `@repo/config` is deny-by-default and names the catalogue surfaces — the listings, services, categories and
 * seller-profile pages. An onboarding entry page is not one of those, so the approved policy already answers
 * `noindex` for it, and this increment does not touch that policy: the robots allowlist, the CSP and the
 * middleware are all unchanged. Adding a route to that allowlist is a deliberate edit to a frozen module, and
 * not one 6-C was asked to make.
 *
 * **No marketing.** Functional copy only: what the page is for, and the way to do it. No claims, no pricing,
 * no fee schedule, no promises about verification times — none of which has been approved, and all of which
 * would be invention.
 */
export default async function BecomeASellerPage({
  params,
}: {
  readonly params: Promise<{ readonly locale: Locale }>;
}) {
  const [{ locale }, t] = await Promise.all([params, getTranslations('SellerOnboarding')]);
  const prefix = locale === 'ar' ? '/ar' : '';

  return (
    <PageContainer>
      <div className="py-12">
        <Heading level={1}>{t('title')}</Heading>

        <p className="mt-4 max-w-prose text-ink-body">{t('createProfile')}</p>

        {/* The permanence of the public address is said here as well as on the form itself: it is the one
            decision on the next screen that cannot be undone, and somebody deciding whether to start
            deserves to know that before they start. */}
        <p className="mt-2 max-w-prose text-sm text-ink-muted">{t('slugPermanent')}</p>

        <p className="mt-8">
          <Link
            href={`${prefix}/dashboard/seller`}
            className="inline-flex items-center rounded-md bg-surface-ink px-4 py-2 text-sm font-medium text-on-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary"
          >
            {t('submit')}
          </Link>
        </p>
      </div>
    </PageContainer>
  );
}
