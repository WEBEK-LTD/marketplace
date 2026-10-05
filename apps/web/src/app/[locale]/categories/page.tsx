import { Heading, PageContainer } from '@repo/ui';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import {
  CategoryTree,
  CategoryTreeMessage,
  CategoryTreeSkeleton,
} from '../../../components/category-tree';
import { readCategories } from '../../../server/bff';
import { metadataWithOverride } from '../../../server/public-metadata';

/**
 * `/categories` and `/ar/categories` — the published category tree.
 *
 * The first page of the public marketplace, and the first that reads real data. It is a server
 * component: the tree is rendered into the HTML, so a crawler and a visitor with no JavaScript both see
 * the categories, which is what the specification's SSR rule is for.
 *
 * The three states the page can be in are all rendered here rather than guessed at by the browser:
 *
 *   * **loading** — the `Suspense` fallback, shown while the fetch is in flight. It is a boundary inside
 *     the page rather than a route-level `loading.tsx`, because C12 keeps those off dynamic routes so
 *     that real status codes reach the client;
 *   * **empty** — a catalogue with nothing published is a successful answer, not an error;
 *   * **error** — the catalogue could not be read. The page still renders, says so, and is not indexed.
 *
 * The page holds no session and sends none: the tree is identical for a guest and for a signed-in
 * person, which is what makes it safe to render this far from the authentication work.
 */

interface PageParams {
  readonly params: Promise<{ locale: string }>;
}

/**
 * Metadata follows the public SEO rules: a self-referencing canonical on the page's own locale, and
 * `hreflang` alternates so the two language versions point at each other.
 */
export async function generateMetadata({ params }: PageParams): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Categories' });
  const path = locale === 'ar' ? '/ar/categories' : '/categories';
  // A landing address, so its override is a `route` entry and its stored canonical is served (8-F).
  return await metadataWithOverride(
    { routePath: '/categories', locale },
    {
      title: t('title'),
      description: t('description'),
      canonical: path,
      languages: { en: '/categories', ar: '/ar/categories' },
      // Stated explicitly: the root layout's default is `noindex, nofollow`, and metadata is merged from
      // the root down, so a page that says nothing about robots inherits that refusal.
      index: true,
      follow: true,
    },
  );
}

/** The part that waits on the API, so the shell above it renders immediately. */
async function CategoryTreeSection({ locale }: { readonly locale: string }) {
  const t = await getTranslations({ locale, namespace: 'Categories' });
  const data = await readCategories(locale);

  if (data === null) {
    return (
      <CategoryTreeMessage tone="error" title={t('errorTitle')} description={t('errorDescription')} />
    );
  }
  if (data.categories.length === 0) {
    return (
      <CategoryTreeMessage tone="empty" title={t('emptyTitle')} description={t('emptyDescription')} />
    );
  }
  return <CategoryTree nodes={data.categories} />;
}

export default async function CategoriesPage({ params }: PageParams) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Categories' });

  return (
    <PageContainer>
      <div className="py-12">
        <Heading level={1}>{t('title')}</Heading>
        <p className="mt-2 max-w-prose text-neutral-600">{t('description')}</p>
        <Suspense fallback={<CategoryTreeSkeleton label={t('loading')} />}>
          <CategoryTreeSection locale={locale} />
        </Suspense>
      </div>
    </PageContainer>
  );
}
