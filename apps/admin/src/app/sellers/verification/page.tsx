import { Heading, PageContainer } from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import { RequireStaff } from '../../../components/require-staff';
import { VerificationQueue } from '../../../components/verification-views';
import { sectionByHref } from '../../../server/console-sections';

/**
 * The seller verification review queue (Phase 7-G).
 *
 * **The gate is a server component inside the page, and everything else is inside it.** Nothing above
 * `RequireStaff` reads anything or renders anything about an application, so a person who may not review
 * receives a refusal and no data — not hidden data, no data. The permission comes from the section list
 * rather than from a string typed here, so this page and the navigation entry that points at it can
 * never disagree about who may open it.
 *
 * The heading is rendered around the queue rather than inside it, so a reviewer who is allowed in still
 * sees a titled page if the read behind it fails.
 */
export const dynamic = 'force-dynamic';

export default async function Page({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const section = sectionByHref('/sellers/verification');
  if (section === null) return null;

  const query = await searchParams;
  const t = await getTranslations('Sections');

  return (
    <RequireStaff permission={section.permission}>
      <PageContainer>
        <div className="py-10">
          <Heading level={1}>{t('sellerVerification.title')}</Heading>
          <p className="mt-2 max-w-prose text-neutral-600">{t('sellerVerification.description')}</p>
          <VerificationQueue status={single(query['status'])} cursor={single(query['cursor'])} />
        </div>
      </PageContainer>
    </RequireStaff>
  );
}

/** One value, or none. A repeated parameter is not two filters; it is a malformed address. */
function single(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}
