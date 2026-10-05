import { Heading, PageContainer } from '@repo/ui';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { RequireStaff } from '../../../../components/require-staff';
import { VerificationDetail } from '../../../../components/verification-views';
import { sectionByHref } from '../../../../server/console-sections';

/**
 * One seller verification submission (Phase 7-G).
 *
 * **Gated exactly like the queue, and by the same entry**: a nested route is not protected by its parent
 * segment in this application — there is no layout doing the checking, deliberately — so this page names
 * the gate itself. Typing the address of an application directly is therefore refused for the same
 * people and with the same neutral page as reaching it through a link.
 *
 * The identifier in the address names a row and is not an authorization: it is checked for shape at the
 * BFF, resolved against the reviewer's own permission in the API, and resolved again inside the database
 * function. An application the reader may not review is reported as absent, exactly like one that is not
 * there.
 */
export const dynamic = 'force-dynamic';

export default async function Page({
  params,
}: {
  readonly params: Promise<{ readonly verificationId: string }>;
}) {
  const section = sectionByHref('/sellers/verification');
  if (section === null) return null;

  const { verificationId } = await params;
  const [sections, t] = await Promise.all([
    getTranslations('Sections'),
    getTranslations('Verification'),
  ]);

  return (
    <RequireStaff permission={section.permission}>
      <PageContainer>
        <div className="py-10">
          <Link href="/sellers/verification" className="text-sm underline underline-offset-4">
            {t('backToQueue')}
          </Link>
          <div className="mt-4">
            <Heading level={1}>{sections('sellerVerification.title')}</Heading>
          </div>
          <VerificationDetail verificationId={verificationId} />
        </div>
      </PageContainer>
    </RequireStaff>
  );
}
