import { publicCmsPagePath, type CmsPageSlug } from '@repo/config';
import { PageContainer } from '@repo/ui';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound, permanentRedirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { cache } from 'react';
import { CmsPageView } from './cms-page-view';
import { FaqList } from './faq-list';
import { ListingMessage } from './listing-views';
import { CATALOG_OUTCOME_HEADER } from '../proxy';
import { readCmsPage, type CmsPageLookup } from '../server/bff/cms-pages';
import { readFaqs } from '../server/bff/faqs';
import { metadataWithOverride } from '../server/public-metadata';

/**
 * One CMS static page, rendered for whichever of the specification's static addresses asked for it.
 *
 * Each address has its own route file, and every one of them does the same two things: it names its slug and
 * calls the two functions here. The content, the translations, the metadata and the publication state all come
 * from the database, so writing or retitling a page is an authoring action; only *adding an address* is a code
 * change, and the specification's route map fixes that list. The admin console says so on any page whose slug
 * is not on it, rather than leaving an operator to find out from a visitor.
 *
 * **Why one file per address rather than one parametric route.** A route matching any single segment would own
 * every unknown URL on the site, and the status would then have to be chosen inside the page. Next.js 16
 * commits the status line as soon as a page starts awaiting, so `notFound()` called there arrives as a `200`
 * with the right body — a soft 404. That was measured on this build, and it is the reason `app/not-found.tsx`
 * records that this app deliberately has no catch-all: an unmatched URL renders that page as real HTML under a
 * real 404. The closed list keeps that true.
 *
 * **Where the status comes from.** The middleware resolves the address before anything renders, which is the
 * last moment the status can still be chosen, exactly as it does for the catalogue surfaces. It issues the 301
 * for a renamed page and the 404 for one nobody may see, and tells this page through a request header that it
 * has already answered 404 — so the not-found view costs no second read. The `permanentRedirect` and
 * `notFound` calls below stay as a backstop for any path that reaches this component without having passed the
 * middleware: they render the right body, only the status is weaker.
 *
 * Four outcomes:
 *
 *   * **found** — 200 with the page;
 *   * **moved** — a permanent redirect to the page's current address, in the same locale. The slug history is
 *     kept forever and can never be reassigned, so this is safe to make permanent;
 *   * **not_found** — 404, identically for a draft, a scheduled page, an archived one, a page whose
 *     publication moment has not arrived, a published page nobody has written in any locale, and an address
 *     the specification names that nobody has authored yet;
 *   * **unavailable** — the page could not be read. It says so, rather than claiming the terms of service do
 *     not exist. These addresses are real and fixed, so a failure here is a failure, not an absence.
 *
 * **Indexing follows the administrator's own decision**, not this file's: `isIndexable` comes from the page
 * row, and the middleware withholds the blanket robots header on these addresses so that decision is the one
 * that reaches the response. The root layout defaults to `noindex, nofollow` and metadata merges downward, so
 * a page that says nothing about robots inherits that refusal — which is why the indexable case states it.
 *
 * **The help centre (0095).** A page carrying a `page_key` shows the published FAQ entries of the topic that key
 * names — `/faq` shows `faq` and `/help` shows `help` (owner decision 1). Three things about that are deliberate:
 * the questions are read **only for a page that has a key**, so no other address pays for a read it would not
 * use; a page with nothing published under its key renders no section at all, not an empty heading (owner
 * decision 2); and **the head is untouched** — `generateMetadata` above does not read the entries and nothing
 * below contributes a title, a description, a canonical or any structured data, which is owner decisions 4 and 7
 * together. A failure to read the questions costs the section and never the page.
 */

/** One read per request, shared by `generateMetadata` and the component so the head cannot disagree with the body. */
const lookup = cache(
  async (slug: string, locale: string): Promise<CmsPageLookup> => readCmsPage(slug, locale),
);

/** Whether the middleware already answered 404 for this request. */
const alreadyNotFound = cache(async (): Promise<boolean> => {
  return (await headers()).get(CATALOG_OUTCOME_HEADER) === 'not_found';
});

export interface CmsStaticPageParams {
  readonly params: Promise<{ locale: string }>;
}

/** The document head for one static address. */
export async function cmsStaticPageMetadata(slug: CmsPageSlug, locale: string): Promise<Metadata> {
  const t = await getTranslations({ locale, namespace: 'Pages' });

  if (await alreadyNotFound()) {
    return { title: t('notFoundTitle'), robots: { index: false, follow: false } };
  }

  const found = await lookup(slug, locale);

  if (found.kind === 'not_found') {
    return { title: t('notFoundTitle'), robots: { index: false, follow: false } };
  }
  if (found.kind === 'moved') {
    // The component redirects; this head is never rendered. Stated anyway, so that nothing about an address
    // which no longer serves content could be indexed if it ever were.
    return { title: t('notFoundTitle'), robots: { index: false, follow: false } };
  }
  if (found.kind !== 'found') {
    // The page could not be read. It says so, and nothing about that is indexable.
    return { title: t('errorTitle'), robots: { index: false, follow: false } };
  }

  const { page } = found;
  // The administrator's meta description, then the page's own excerpt, then nothing at all — an invented
  // sentence would be worse than none.
  const description = page.metaDescription ?? page.excerpt;

  // The SEO module's own override is merged in last by one shared resolver (8-F), most-specific-first: the
  // `seo_metadata` entry for this page and locale, then the page's own meta fields, then its title and excerpt.
  //
  // **A page is one of the two kinds that honours a stored canonical**, which is why the self-referencing address
  // below is a default rather than the last word: a static page has no slug history question an override could
  // confuse, and an administrator pointing two near-identical pages at one canonical is the ordinary use for the
  // field. The robots value below is still a floor — a page the administrator has marked unindexable cannot be
  // indexed by an override, because a stored directive may only narrow.
  return await metadataWithOverride(
    { entityType: 'page', slug: page.slug, locale },
    {
      // The administrator's meta title when there is one, otherwise the page's own title.
      title: page.metaTitle ?? page.title,
      description,
      // Self-referencing, on the current address. An old address redirects here rather than declaring itself
      // canonical, which is what keeps one page from having two addresses in an index.
      canonical: publicCmsPagePath(locale === 'ar' ? 'ar' : 'en', page.slug),
      languages: {
        en: publicCmsPagePath('en', page.slug),
        ar: publicCmsPagePath('ar', page.slug),
      },
      index: page.isIndexable,
      follow: page.isIndexable,
    },
  );
}

/** The body for one static address. */
export async function renderCmsStaticPage(slug: CmsPageSlug, locale: string) {
  const t = await getTranslations({ locale, namespace: 'Pages' });

  if (await alreadyNotFound()) {
    // The middleware has already answered 404 and said so. Render the localized not-found view under that
    // status, without asking the API about a page nobody may see.
    return (
      <PageContainer>
        <div className="py-12">
          <ListingMessage tone="empty" title={t('notFoundTitle')} description={t('notFoundDescription')} />
        </div>
      </PageContainer>
    );
  }

  const found = await lookup(slug, locale);

  if (found.kind === 'moved') {
    // In the same locale: a visitor reading Arabic who follows an old Arabic address should land on the
    // Arabic page, not be moved to the English root.
    permanentRedirect(publicCmsPagePath(locale === 'ar' ? 'ar' : 'en', found.movedTo));
  }

  if (found.kind === 'not_found') notFound();

  if (found.kind === 'unavailable') {
    return (
      <PageContainer>
        <div className="py-12">
          <ListingMessage tone="error" title={t('errorTitle')} description={t('errorDescription')} />
        </div>
      </PageContainer>
    );
  }

  // Only a page that carries a key can show questions, and only then is anything read (0095, owner decision 1).
  // A null answer is a failed read, and it costs the section rather than the page: `FaqList` renders nothing for
  // an empty list, which is also what owner decision 2 asks for when nothing is published.
  const faqs = found.page.pageKey === null ? [] : ((await readFaqs(found.page.pageKey, locale)) ?? []);

  return (
    <PageContainer>
      <div className="py-12">
        <CmsPageView page={found.page} />
        <FaqList entries={faqs} locale={locale} />
      </div>
    </PageContainer>
  );
}
