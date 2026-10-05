import { Heading, PageContainer } from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import { AdminServiceRequestQueue } from '../../components/admin-service-request-views';
import { RequireStaff } from '../../components/require-staff';
import { sectionByHref } from '../../server/console-sections';

/**
 * The Admin Only service request queue — Option 2 (Phase 7-J).
 *
 * **The gate is a server component inside the page, and everything else is inside it.** Nothing above
 * `RequireStaff` reads anything or renders anything about a request, so a person who may not read receives a
 * refusal and no data — not hidden data, no data. The permission comes from the section list rather than from a
 * string typed here, so this page and the navigation entry pointing at it can never disagree about who may open
 * it.
 *
 * The heading is rendered around the queue rather than inside it, so somebody who is allowed in still sees a
 * titled page if the read behind it fails.
 *
 * Neither payment field is reachable from this screen: reading them is a separate operation behind a separate
 * permission, on the detail page.
 */
export const dynamic = 'force-dynamic';

export default async function Page({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const section = sectionByHref('/service-requests');
  if (section === null) return null;

  const query = await searchParams;
  const t = await getTranslations('Sections');

  return (
    <RequireStaff permission={section.permission}>
      <PageContainer>
        <div className="py-10">
          <Heading level={1}>{t('serviceRequests.title')}</Heading>
          <p className="mt-2 max-w-prose text-neutral-600">{t('serviceRequests.description')}</p>
          <AdminServiceRequestQueue status={single(query['status'])} cursor={single(query['cursor'])} />
        </div>
      </PageContainer>
    </RequireStaff>
  );
}

/** One value, or none. A repeated parameter is not two filters; it is a malformed address. */
function single(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}
