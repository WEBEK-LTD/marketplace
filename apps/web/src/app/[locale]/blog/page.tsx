import { Heading, PageContainer } from '@repo/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { publicBlogIndexPath, publicBlogPostPath } from '@repo/config';
import { readBlogIndex, readBlogTaxonomy } from '../../../server/bff';
import { metadataWithOverride } from '../../../server/public-metadata';

/**
 * `/blog` and `/ar/blog` — the public blog index (0092).
 *
 * A server component, for the same reason the catalogue's lists are: a post is content, and the HTML has to carry it
 * for a crawler and for a visitor with no JavaScript.
 *
 * Paging is a link, not a button. The cursor lives in the query string, so a page of posts has a URL that can be
 * shared, bookmarked and reloaded, and the browser's back button does the obvious thing.
 *
 * **Ordered newest first, and a featured post is marked rather than moved.** The order is the database's and
 * `isFeatured` is reported alongside it, so nothing here invents a promotion rule.
 *
 * **The filters come from the database's own counts.** A category or tag with nothing public under it is offered with
 * a zero beside it rather than hidden, and a filter naming something that no longer exists yields an empty page
 * rather than an error — the honest answer to a stale link.
 */

interface PageParams {
  readonly params: Promise<{ locale: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function single(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * This index is canonical at its unfiltered, unpaged address only.
 *
 * A cursor page and a filtered view are both the same blog seen from a different angle, so indexing each one would
 * spend a crawler's budget on near-duplicates of a page that is already indexed.
 */
export async function generateMetadata({ params, searchParams }: PageParams): Promise<Metadata> {
  const { locale } = await params;
  const query = await searchParams;
  const t = await getTranslations({ locale, namespace: 'Blog' });
  const narrowed =
    single(query['cursor']) !== null || single(query['category']) !== null || single(query['tag']) !== null;

  // A landing address, so its override is a `route` entry and its stored canonical **is** served: there is no row
  // behind this address and therefore no derived canonical for an override to contradict (0091's decision 1). This is
  // the index, not a post — 0092's decision B keeps overrides away from `blog_post`, and nothing here reaches one.
  return await metadataWithOverride(
    { routePath: '/blog', locale },
    {
      title: t('indexTitle'),
      description: t('indexDescription'),
      canonical: publicBlogIndexPath(locale === 'ar' ? 'ar' : 'en'),
      languages: { en: '/blog', ar: '/ar/blog' },
      // Stated on both branches: the root layout's default is `noindex, nofollow`, and metadata is merged from the
      // root down, so saying nothing here would inherit that refusal and the page would never be indexed.
      index: !narrowed,
      follow: true,
    },
  );
}

export default async function BlogIndexPage({ params, searchParams }: PageParams) {
  const { locale } = await params;
  const query = await searchParams;
  const t = await getTranslations({ locale, namespace: 'Blog' });

  const category = single(query['category']);
  const tag = single(query['tag']);
  const cursor = single(query['cursor']);
  const language = locale === 'ar' ? 'ar' : 'en';

  const [page, taxonomy] = await Promise.all([
    readBlogIndex({ locale, category, tag, cursor }),
    readBlogTaxonomy(locale),
  ]);

  const base = publicBlogIndexPath(language);
  const keep = new URLSearchParams();
  if (category !== null) keep.set('category', category);
  if (tag !== null) keep.set('tag', tag);

  return (
    <PageContainer>
      <div className="py-10">
        <Heading level={1}>{t('indexTitle')}</Heading>
        <p className="mt-2 max-w-prose text-neutral-600">{t('indexDescription')}</p>

        {/* The index could not be read. Said plainly rather than rendered as an empty blog, which would be a
            different and wrong statement. */}
        {page === null ? (
          <p className="mt-8 rounded-md border border-neutral-200 bg-neutral-50 p-4 text-neutral-700">
            {t('unavailable')}
          </p>
        ) : (
          <>
            {taxonomy === null || (taxonomy.categories.length === 0 && taxonomy.tags.length === 0) ? null : (
              <nav aria-label={t('filtersLabel')} className="mt-6 flex flex-wrap gap-2 text-sm">
                <Link
                  className={`rounded-full border px-3 py-1 ${
                    category === null && tag === null
                      ? 'border-neutral-900 bg-neutral-900 text-white'
                      : 'border-neutral-300 text-neutral-700'
                  }`}
                  href={base}
                >
                  {t('filterAll')}
                </Link>
                {taxonomy.categories.map((entry) => (
                  <Link
                    className={`rounded-full border px-3 py-1 ${
                      category === entry.slug
                        ? 'border-neutral-900 bg-neutral-900 text-white'
                        : 'border-neutral-300 text-neutral-700'
                    }`}
                    href={`${base}?category=${encodeURIComponent(entry.slug)}`}
                    key={`category-${entry.slug}`}
                  >
                    {entry.name} ({entry.postCount})
                  </Link>
                ))}
                {taxonomy.tags.map((entry) => (
                  <Link
                    className={`rounded-full border px-3 py-1 ${
                      tag === entry.slug
                        ? 'border-neutral-900 bg-neutral-900 text-white'
                        : 'border-neutral-300 text-neutral-700'
                    }`}
                    href={`${base}?tag=${encodeURIComponent(entry.slug)}`}
                    key={`tag-${entry.slug}`}
                  >
                    #{entry.name} ({entry.postCount})
                  </Link>
                ))}
              </nav>
            )}

            {page.items.length === 0 ? (
              <p className="mt-8 rounded-md border border-neutral-200 bg-neutral-50 p-4 text-neutral-700">
                {category !== null || tag !== null ? t('noMatches') : t('empty')}
              </p>
            ) : (
              <ul className="mt-8 space-y-8">
                {page.items.map((post) => (
                  <li key={post.slug}>
                    <article>
                      {/* `lang` and `dir` on the content itself: a post may come back in the other language when
                          the one that was asked for has not been written, and claiming otherwise would be a lie
                          a screen reader acts on. */}
                      <div
                        dir={post.resolvedLocale === 'ar' ? 'rtl' : 'ltr'}
                        lang={post.resolvedLocale}
                      >
                        <Heading level={2}>
                          <Link
                            className="text-neutral-900 underline"
                            href={publicBlogPostPath(language, post.slug)}
                          >
                            {post.title}
                          </Link>
                        </Heading>
                        {post.excerpt === null ? null : (
                          <p className="mt-2 text-neutral-700">{post.excerpt}</p>
                        )}
                      </div>
                      <p className="mt-2 text-sm text-neutral-500">
                        <time dateTime={post.publishedAt}>{post.publishedAt.slice(0, 10)}</time>
                        {post.categoryName === null ? null : <> · {post.categoryName}</>}
                        {post.isFeatured ? <> · {t('featured')}</> : null}
                      </p>
                    </article>
                  </li>
                ))}
              </ul>
            )}

            {page.nextCursor === null ? null : (
              <p className="mt-8">
                <Link
                  className="text-neutral-900 underline"
                  href={`${base}?${keep.size === 0 ? '' : `${keep.toString()}&`}cursor=${encodeURIComponent(page.nextCursor)}`}
                  rel="next"
                >
                  {t('nextPage')}
                </Link>
              </p>
            )}
          </>
        )}
      </div>
    </PageContainer>
  );
}
