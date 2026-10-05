import { Heading, PageContainer } from '@repo/ui';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { AdminServiceRequestDetailView } from '../../../components/admin-service-request-views';
import { RequireStaff } from '../../../components/require-staff';
import { sectionByHref } from '../../../server/console-sections';

/**
 * One Admin Only service request (Phase 7-J).
 *
 * **Gated exactly like the queue, and by the same entry**: a nested route is not protected by its parent segment
 * in this application — there is no layout doing the checking, deliberately — so this page names the gate
 * itself. Typing the address of a request directly is therefore refused for the same people, and with the same
 * neutral page, as reaching it through a link.
 *
 * The identifier in the address names a row and is not an authorization: it is checked for shape at the BFF,
 * resolved against the caller's own permission in the API, and resolved again inside the database function. A
 * request the reader may not see — including a seller-routed one, which does not belong on this surface at all —
 * is reported as absent, exactly like one that is not there.
 *
 * **The Payment Information section is gated a second time, on its own permission**, inside the view below. A
 * colleague who holds only the request permission sees this page without it, and without any sign that it exists.
 */
export const dynamic = 'force-dynamic';

export default async function Page({
  params,
}: {
  readonly params: Promise<{ readonly requestId: string }>;
}) {
  const section = sectionByHref('/service-requests');
  if (section === null) return null;

  const { requestId } = await params;
  const [sections, t] = await Promise.all([
    getTranslations('Sections'),
    getTranslations('ServiceRequests'),
  ]);

  return (
    <RequireStaff permission={section.permission}>
      <PageContainer>
        <div className="py-10">
          <Link href="/service-requests" className="text-sm underline underline-offset-4">
            {t('backToQueue')}
          </Link>
          <div className="mt-4">
            <Heading level={1}>{sections('serviceRequests.title')}</Heading>
          </div>
          <AdminServiceRequestDetailView requestId={requestId} />
        </div>
      </PageContainer>
    </RequireStaff>
  );
}
