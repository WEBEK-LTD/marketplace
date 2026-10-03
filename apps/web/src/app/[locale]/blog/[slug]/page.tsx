import { Heading, PageContainer } from '@repo/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { cache } from 'react';
import { publicBlogIndexPath } from '@repo/config';
import { CATALOG_OUTCOME_HEADER } from '../../../../proxy';
import { readBlogPost, type BlogPostLookup } from '../../../../server/bff';

/**
 * `/blog/[slug]` and `/ar/blog/[slug]` — one public post (0092).
 *
 * Four outcomes:
 *
 *   * **found** — 200 with the post;
 *   * **moved** — a 301 issued by the proxy, which is the only place it can be issued from;
 *   * **not_found** — 404, identically for a draft, a schedule, an archive, a future publication, a published post
 *     nobody has written and a slug that never existed;
 *   * **unavailable** — the blog could not be read. The page renders and says so.
 *
 * **Where the 404 and the 301 come from.** The proxy resolves the slug before anything renders. Neither can be issued
 * from here: Next.js 16 streams, so by the time this component has awaited anything the status line is already sent,
 * and `notFound()` would produce the right body under a 200. The proxy says through a request header that it has
 * already answered 404, so the not-found view costs no second read; the `notFound()` below stays as a backstop for any
 * path that reaches this component without it.
 *
 * **This page's `<head>` comes from the post and from nowhere else.** `metaTitle` and `metaDescription` are columns of
 * the post's own translation, which is why `metadataWithOverride` is deliberately *not* used here: 0092's decision B
 * keeps `seo_metadata` away from a blog post, so there is no second source to merge and no precedence rule that could
 * be got wrong. The blog index is a different address and does use the shared resolver, because a landing route is a
 * `route` entry and has no row behind it.
 */

interface PageParams {
  readonly params: Promise<{ locale: string; slug: string }>;
}

const lookup = cache(
  async (slug: string, locale: string): Promise<BlogPostLookup> => readBlogPost(slug, locale),
);

/** Whether the proxy already answered 404 for this request. */
const alreadyNotFound = cache(async (): Promise<boolean> => {
  return (await headers()).get(CATALOG_OUTCOME_HEADER) === 'not_found';
});

function postPath(locale: string, slug: string): string {
  return `${locale === 'ar' ? '/ar' : ''}/blog/${encodeURIComponent(slug)}`;
}

export async function generateMetadata({ params }: PageParams): Promise<Metadata> {
  const { locale, slug } = await params;
  const t = await getTranslations({ locale, namespace: 'Blog' });

  if (await alreadyNotFound()) {
    return { title: t('notFoundTitle'), robots: { index: false, follow: false } };
  }

  const found = await lookup(slug, locale);
  if (found.kind === 'not_found' || found.kind === 'moved') {
    return { title: t('notFoundTitle'), robots: { index: false, follow: false } };
  }
  if (found.kind !== 'found') {
    // The blog could not be read. The page says so, and nothing about it is indexable.
    return { title: t('errorTitle'), robots: { index: false, follow: false } };
  }

  const { post } = found;
  return {
    // The post's own meta title when there is one, otherwise its title. No override is consulted.
    title: post.metaTitle ?? post.title,
    ...(post.metaDescription === null && post.excerpt === null
      ? {}
      : { description: post.metaDescription ?? post.excerpt ?? '' }),
    alternates: {
      canonical: postPath(locale, post.slug),
      languages: {
        en: `/blog/${encodeURIComponent(post.slug)}`,
        ar: `/ar/blog/${encodeURIComponent(post.slug)}`,
      },
    },
    // Stated explicitly: the root layout's default is `noindex, nofollow`, and metadata is merged from the root
    // down, so a page that says nothing about robots inherits that refusal. `isIndexable` is the administrator's
    // own decision on the post, carried through rather than re-derived.
    robots: { index: post.isIndexable, follow: true },
  };
}

export default async function BlogPostPage({ params }: PageParams) {
  const { locale, slug } = await params;
  const t = await getTranslations({ locale, namespace: 'Blog' });
  const language = locale === 'ar' ? 'ar' : 'en';

  if (await alreadyNotFound()) {
    return (
      <PageContainer>
        <div className="py-12">
          <Heading level={1}>{t('notFoundTitle')}</Heading>
          <p className="mt-2 text-neutral-700">{t('notFoundBody')}</p>
          <p className="mt-4">
            <Link className="text-neutral-900 underline" href={publicBlogIndexPath(language)}>
              {t('backToIndex')}
            </Link>
          </p>
        </div>
      </PageContainer>
    );
  }

  const found = await lookup(slug, locale);
  if (found.kind === 'not_found' || found.kind === 'moved') notFound();

  if (found.kind !== 'found') {
    return (
      <PageContainer>
        <div className="py-12">
          <Heading level={1}>{t('errorTitle')}</Heading>
          <p className="mt-2 text-neutral-700">{t('unavailable')}</p>
        </div>
      </PageContainer>
    );
  }

  const { post } = found;
  return (
    <PageContainer>
      {/* `lang` and `dir` on the content itself, because a post may come back in the other language when the one
          that was asked for has not been written. */}
      <article className="py-10" dir={post.resolvedLocale === 'ar' ? 'rtl' : 'ltr'} lang={post.resolvedLocale}>
        <Heading level={1}>{post.title}</Heading>
        <p className="mt-2 text-sm text-neutral-500">
          <time dateTime={post.publishedAt}>{post.publishedAt.slice(0, 10)}</time>
          {post.categoryName === null ? null : (
            <>
              {' · '}
              <Link
                className="text-neutral-700 underline"
                href={`${publicBlogIndexPath(language)}?category=${encodeURIComponent(post.categorySlug ?? '')}`}
              >
                {post.categoryName}
              </Link>
            </>
          )}
        </p>
        {post.excerpt === null ? null : <p className="mt-4 text-lg text-neutral-700">{post.excerpt}</p>}
        {/* The body is the author's text, rendered as text. Nothing here interprets it as markup: a post is
            written by staff, but turning stored text into HTML would be a decision this increment was not asked
            to make and the wrong place to make it. */}
        <div className="mt-6 whitespace-pre-wrap text-neutral-900">{post.body}</div>

        {post.tags.length === 0 ? null : (
          <p className="mt-8 flex flex-wrap gap-2 text-sm">
            {post.tags.map((tag) => (
              <Link
                className="rounded-full border border-neutral-300 px-3 py-1 text-neutral-700"
                href={`${publicBlogIndexPath(language)}?tag=${encodeURIComponent(tag.slug)}`}
                key={tag.slug}
              >
                #{tag.name}
              </Link>
            ))}
          </p>
        )}
      </article>
      <p className="pb-10">
        <Link className="text-neutral-900 underline" href={publicBlogIndexPath(language)}>
          {t('backToIndex')}
        </Link>
      </p>
    </PageContainer>
  );
}
