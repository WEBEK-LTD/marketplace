import { Heading, PageContainer } from '@repo/ui';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { RequireStaff } from '../../../../admin/components/require-staff';
import { BlogDetailView } from '../../../../admin/components/blog-views';
import { sectionByHref } from '../../../../admin/server/console-sections';
import { adminPath } from '../../../../admin/paths';

/**
 * One post: its state, its two locales, its tags and its retired addresses.
 *
 * Gated on the section's own `cms.blog.read`. The controls below render only when the server reports `canManage`,
 * which is the separate `cms.blog.manage` key tested in the database.
 *
 * A post that does not exist and one this caller may not read both render the same message, because the API answers
 * both the same way on purpose.
 */
export const dynamic = 'force-dynamic';

export default async function Page({ params }: { readonly params: Promise<{ postId: string }> }) {
  const section = sectionByHref('/blog');
  if (section === null) return null;

  const { postId } = await params;
  const [sections, t] = await Promise.all([getTranslations('Sections'), getTranslations('Blog')]);

  return (
    <RequireStaff permission={section.permission}>
      <PageContainer>
        <div className="py-10">
          <Heading level={1}>{sections('blog.title')}</Heading>
          <p className="mt-2 max-w-prose text-neutral-600">{t('detailIntro')}</p>
          <p className="mt-2 text-sm">
            <Link className="text-neutral-900 underline" href={adminPath('/blog')}>
              {t('backToList')}
            </Link>
          </p>
          <BlogDetailView postId={postId} />
        </div>
      </PageContainer>
    </RequireStaff>
  );
}
