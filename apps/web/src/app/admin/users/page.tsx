import { Heading, PageContainer } from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import { RequireStaff } from '../../../admin/components/require-staff';
import { AdminRoleCatalogue, AdminUserList } from '../../../admin/components/admin-operations-views';
import { sectionByHref } from '../../../admin/server/console-sections';

/**
 * The accounts (Phase 7-O).
 *
 * The gate is inside the page and both reads are inside the gate. The page itself is gated on
 * `users.profile.read`, which 7-F seeded on this section; the role catalogue below the list needs
 * `users.role.read`, which a moderator and a support agent do **not** hold, so for them that whole panel is
 * **absent rather than empty** — an empty "Roles" heading would itself say there was something here they
 * could not see.
 *
 * **Read-only.** No writer for `user_roles` exists in this repository, so there is no control anywhere on
 * this page or the account behind it that grants, changes or removes a role, and no route behind one.
 */
export const dynamic = 'force-dynamic';

export default async function Page({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const section = sectionByHref('/users');
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
          <Heading level={1}>{sections('users.title')}</Heading>
          <p className="mt-2 max-w-prose text-ink-muted">{t('usersIntro')}</p>
          <AdminUserList cursor={single(query['cursor'])} status={single(query['status'])} />
          <AdminRoleCatalogue />
        </div>
      </PageContainer>
    </RequireStaff>
  );
}

/** One value, or none. A repeated parameter is not two positions; it is a malformed address. */
function single(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}
