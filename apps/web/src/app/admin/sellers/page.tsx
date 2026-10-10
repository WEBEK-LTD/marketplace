import { Heading, PageContainer } from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import { RequireStaff } from '../../../admin/components/require-staff';
import { AdminSellerList } from '../../../admin/components/admin-operations-views';
import { sectionByHref } from '../../../admin/server/console-sections';

/**
 * The storefronts (Phase 7-O).
 *
 * **The gate is a server component inside the page, and everything else is inside it.** Nothing above
 * `RequireStaff` reads anything or renders anything about a storefront, so a colleague who may not read this
 * section receives a refusal and no data — not hidden data, no data. The permission comes from the section
 * list rather than from a string typed here, so this page and the navigation entry pointing at it can never
 * disagree about who may open it; 7-F already seeded that entry with `sellers.profile.read`.
 *
 * **Read-only, and the page says so.** No writer in this repository sets a storefront's account status, so
 * there is no suspend, close or reinstate control here and no route behind one. That gap is reported for an
 * owner decision rather than filled with an invented rule.
 *
 * The two filters are the vocabularies 0009 already has; a value that is not one is dropped rather than
 * refused, so a mistyped bookmark shows the whole list.
 */
export const dynamic = 'force-dynamic';

export default async function Page({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const section = sectionByHref('/sellers');
  if (section === null) return null;

  const query = await searchParams;
  const [sections, t] = await Promise.all([
    getTranslations('Sections'),
    getTranslations('AdminOps'),
  ]);

  return (
    <RequireStaff permission={section.permission}>
      <PageContainer>
        <div className="py-10">
          <Heading level={1}>{sections('sellers.title')}</Heading>
          <p className="mt-2 max-w-prose text-ink-muted">{t('sellersIntro')}</p>
          <AdminSellerList
            cursor={single(query['cursor'])}
            status={single(query['status'])}
            verificationStatus={single(query['verificationStatus'])}
          />
        </div>
      </PageContainer>
    </RequireStaff>
  );
}

/** One value, or none. A repeated parameter is not two positions; it is a malformed address. */
function single(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}
