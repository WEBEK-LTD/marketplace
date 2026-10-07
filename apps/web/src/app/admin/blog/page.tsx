import { Heading, PageContainer } from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import { RequireStaff } from '../../../admin/components/require-staff';
import { BlogAddPanel, BlogList, BlogTaxonomyView } from '../../../admin/components/blog-views';
import { sectionByHref } from '../../../admin/server/console-sections';

/**
 * The blog section — the posts, and the categories and tags they are filed under (0092).
 *
 * **The gate is a server component inside the page, and everything else is inside it.** Nothing above `RequireStaff`
 * reads anything or renders anything about a post. The permission comes from the section list rather than from a
 * string typed here, so this page and the navigation entry pointing at it can never disagree.
 *
 * The gate is `cms.blog.read`. **Writing needs the separate `cms.blog.manage`**, which each panel asks the server
 * about rather than inferring from a role — so a reader opening this section sees the posts and no controls.
 */
export const dynamic = 'force-dynamic';

export default async function Page({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const section = sectionByHref('/blog');
  if (section === null) return null;

  const query = await searchParams;
  const [sections, t] = await Promise.all([getTranslations('Sections'), getTranslations('Blog')]);

  return (
    <RequireStaff permission={section.permission}>
      <PageContainer>
        <div className="py-10">
          <Heading level={1}>{sections('blog.title')}</Heading>
          <p className="mt-2 max-w-prose text-neutral-600">{t('pageIntro')}</p>
          <BlogList
            cursor={single(query['cursor'])}
            status={single(query['status'])}
            search={single(query['search'])}
          />
          <BlogAddPanel />
          <BlogTaxonomyView />
        </div>
      </PageContainer>
    </RequireStaff>
  );
}

/** One value, or none. A repeated parameter is not two positions; it is a malformed address. */
function single(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}
