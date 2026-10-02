import { Heading, PageContainer } from '@repo/ui';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { RequireStaff } from '../../../components/require-staff';
import { ModerationListingDetailView } from '../../../components/moderation-views';
import { sectionByHref } from '../../../server/console-sections';

/**
 * One listing, for a moderation decision (Phase 7-N).
 *
 * **The gate is inside the page and every read is inside the gate.** The listing is gated twice more by the
 * API and the database, and the action form inside is gated a third time on a different key — `canModerate` is
 * the database's own answer, so the page ships the controls it means rather than guessing.
 *
 * The heading is the section's rather than the listing's title, so a refusal and an outage render a titled page
 * with nothing of the listing in it.
 */
export const dynamic = 'force-dynamic';

export default async function Page({
  params,
}: {
  readonly params: Promise<{ readonly listingId: string }>;
}) {
  const section = sectionByHref('/catalog');
  if (section === null) return null;

  const [{ listingId }, sections, t] = await Promise.all([
    params,
    getTranslations('Sections'),
    getTranslations('Moderation'),
  ]);

  return (
    <RequireStaff permission={section.permission}>
      <PageContainer>
        <div className="py-10">
          <Heading level={1}>{t('listingTitle')}</Heading>
          <p className="mt-2">
            <Link href="/catalog" className="text-sm underline underline-offset-4">
              {sections('catalog.title')}
            </Link>
          </p>
          <ModerationListingDetailView listingId={listingId} />
        </div>
      </PageContainer>
    </RequireStaff>
  );
}
