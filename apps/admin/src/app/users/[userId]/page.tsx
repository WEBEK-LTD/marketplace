import { Heading, PageContainer } from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import { RequireStaff } from '../../../components/require-staff';
import { AdminUserDetailView } from '../../../components/admin-operations-views';
import { sectionByHref } from '../../../server/console-sections';

/**
 * One account (Phase 7-O).
 *
 * Three reads behind three different keys, all inside the gate. The account needs `users.profile.read`,
 * which is this section's own; its roles need `users.role.read` and its security timeline needs
 * `users.security.read`, neither of which a moderator or a support agent holds. Each of those two panels is
 * absent rather than empty when the key is missing.
 *
 * **Read-only**, for the reason the roles panel states on the page: no authoritative writer for a role
 * assignment exists in this repository, and inventing one would mean deciding the platform's
 * privilege-granting rules here.
 */
export const dynamic = 'force-dynamic';

export default async function Page({ params }: { readonly params: Promise<{ userId: string }> }) {
  const section = sectionByHref('/users');
  if (section === null) return null;

  const { userId } = await params;
  const [sections, t] = await Promise.all([
    getTranslations('Sections'),
    getTranslations('AdminOps'),
  ]);

  return (
    <RequireStaff permission={section.permission}>
      <PageContainer>
        <div className="py-10">
          <Heading level={1}>{sections('users.title')}</Heading>
          <p className="mt-2 max-w-prose text-neutral-600">{t('userDetailIntro')}</p>
          <AdminUserDetailView userId={userId} />
        </div>
      </PageContainer>
    </RequireStaff>
  );
}
