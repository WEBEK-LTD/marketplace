import { EmptyState, PageContainer } from '@repo/ui';
import { getTranslations } from 'next-intl/server';

/**
 * Localized 404 for unknown URLs. There is deliberately no catch-all route: Next.js 16 does not
 * server-render not-found boundaries reached through notFound() (vercel/next.js#98295), while
 * unmatched URLs render this page as real HTML with a 404 status.
 *
 * **The title is this page's `h1`.** An empty state that *is* the page owns the document's heading; demoting it
 * to an `h2` would leave the 404 with no `h1` at all.
 *
 * **It offers no actions, and that is a deliberate reversal inside 0109.** A pair of "browse" buttons here looks
 * like the obvious polish, and it is wrong for a structural reason: this one file is the `notFound` slot of the
 * root layout, so its markup is serialised into the RSC payload of *every* page on the origin — including
 * `/login`, which owner decision 2 keeps on the plain chrome, and including the staff console, whose 404 must
 * carry no marketplace links at all (0108). Catalogue links here would leak into both. The way out is already
 * in the chrome: the brand returns home from every page, and the footer carries the three catalogue doors
 * wherever the public chrome is served.
 *
 * The `empty` tone is deliberate — a mistyped address is not a failure of the product, and drawing it as an
 * outage would say it was.
 */
export default async function NotFound() {
  const t = await getTranslations('NotFound');

  return (
    <PageContainer>
      <div className="py-16">
        <EmptyState as="h1" title={t('title')} description={t('description')} tone="empty" />
      </div>
    </PageContainer>
  );
}
