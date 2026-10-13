import { Alert, PageContainer } from '@repo/ui';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { cache } from 'react';
import type { PublicLocale } from '@repo/config';
import { HomeHero } from '../../components/home-hero';
import { HomepageSections } from '../../components/homepage-sections';
import { readHomepage } from '../../server/bff';
import { metadataWithOverride } from '../../server/public-metadata';

/**
 * `/` and `/ar` — the public homepage (0093).
 *
 * **Composed, not written.** What appears here is the sections an administrator arranged in the console, each
 * naming content rather than copying it — so the homepage can never show a listing that has been sold or a seller
 * who has been suspended. The API drops any section with nothing left to show, which is why nothing below handles
 * an empty section.
 *
 * **A homepage nobody has composed still works.** It falls back to the site's name and the entry points that have
 * always existed, so a fresh marketplace has a front page rather than a blank one. That fallback is the page this
 * route rendered before 0093, kept deliberately: inventing marketing copy for an uncomposed site would be inventing
 * content nobody asked for.
 *
 * **This page is indexable** (owner decision E), with a self-referencing canonical, and it carries 0091's route
 * override like every other landing address — `/` is a `route` entry, so a stored canonical there *is* honoured.
 * Before this increment the homepage declared no metadata at all and therefore inherited the root layout's
 * `noindex, nofollow`: the site's own front page was not indexable.
 *
 * A server component, because the homepage is content and the HTML has to carry it for a crawler and for a visitor
 * with no JavaScript.
 */

interface PageParams {
  readonly params: Promise<{ locale: string }>;
}

/** One read per request, shared by `generateMetadata` and the page body. */
const lookup = cache(async (locale: string) => readHomepage(locale));

export async function generateMetadata({ params }: PageParams): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Homepage' });
  const site = await getTranslations({ locale, namespace: 'Site' });

  // A landing address, so its override is a `route` entry and a stored canonical **is** served: there is no row
  // behind `/` for a derived canonical to contradict (0091's decision 1).
  return await metadataWithOverride(
    { routePath: '/', locale },
    {
      title: site('name'),
      description: t('metaDescription'),
      canonical: locale === 'ar' ? '/ar' : '/',
      languages: { en: '/', ar: '/ar' },
      // Owner decision E, stated rather than inherited: the root layout defaults to `noindex, nofollow` and
      // metadata merges from the root down, so saying nothing here is what used to leave the front page unindexed.
      // **`noindex` when the read failed.** The page still answers 200 and still renders its unavailable
      // region — that is the approved behaviour and a visitor should see an explanation rather than an error
      // code — but a crawler must not be allowed to index that explanation as the page's content. The read is
      // shared with the body through `cache`, so asking the question here costs no second request. This is the
      // pattern `category/[slug]` already follows.
      index: (await lookup(locale)) !== null,
      follow: true,
    },
  );
}

/**
 * The page is the opening band and then whatever an administrator composed.
 *
 * The band itself moved to `components/home-hero.tsx` in 0112, where it became photographic. It is rendered
 * above the composed sections and above the fallback alike, because a visitor needs the search and the doors on
 * the front page whether or not anyone has arranged anything below them.
 */
export default async function HomePage({ params }: PageParams) {
  const { locale } = await params;
  const language: PublicLocale = locale === 'ar' ? 'ar' : 'en';
  const t = await getTranslations({ locale, namespace: 'Homepage' });

  const sections = await lookup(locale);

  // Null is an outage and an empty array is an uncomposed homepage. Both show the opening alone, because a
  // visitor needs somewhere to go either way — but only the outage says so, and only when there is nothing else
  // to show. An uncomposed homepage is not a broken one and must not claim to be.
  if (sections === null || sections.length === 0) {
    return (
      <>
        <HomeHero locale={locale} language={language} />
        {sections === null ? (
          <PageContainer>
            <div className="py-10">
              <Alert tone="warning" title={t('unavailable')} />
            </div>
          </PageContainer>
        ) : null}
      </>
    );
  }

  return (
    <>
      <HomeHero locale={locale} language={language} />
      <HomepageSections locale={language} sections={sections} />
    </>
  );
}
