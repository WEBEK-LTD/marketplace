import { Heading, PageContainer } from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import { RequireStaff } from '../../../../admin/components/require-staff';
import { ListingAnalyticsTable } from '../../../../admin/components/listing-analytics-views';
import { sectionByHref } from '../../../../admin/server/console-sections';

/**
 * Listing analytics (0102).
 *
 * **The gate is a server component inside the page, and everything else is inside it.** Nothing above
 * `RequireStaff` reads anything or renders anything about a listing, so a colleague who may not open this
 * section receives a refusal and no data — not hidden data, no data. The permission comes from the section list
 * rather than from a string typed here, so this page and the navigation entry pointing at it can never disagree
 * about who may open it.
 *
 * `analytics.listing.read` is held by Admin and Super Admin alone, so this gate refuses as many people as the
 * platform section's does: a Moderator or a Support Agent sees the refusal.
 *
 * **One panel, read-only.** The rollup as it stands, newest day first. There is no control, because the rollup
 * is a scheduled job and this repository has no writer for recomputing a day from a console — a fact the panel
 * states rather than implies.
 */
export const dynamic = 'force-dynamic';

export default async function Page({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const section = sectionByHref('/analytics/listings');
  if (section === null) return null;

  const query = await searchParams;
  const [sections, t] = await Promise.all([
    getTranslations('Sections'),
    getTranslations('ListingAnalytics'),
  ]);

  const one = (value: string | string[] | undefined): string | null =>
    typeof value === 'string' && value !== '' ? value : null;

  return (
    <RequireStaff permission={section.permission}>
      <PageContainer>
        <div className="py-10">
          <Heading level={1}>{sections('listingAnalytics.title')}</Heading>
          <p className="mt-2 max-w-prose text-ink-muted">{t('pageIntro')}</p>
          <ListingAnalyticsTable cursor={one(query['cursor'])} days={one(query['days'])} />
        </div>
      </PageContainer>
    </RequireStaff>
  );
}
