import { Alert, ButtonLink, Heading, PageContainer, Section, cx } from '@repo/ui';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { cache } from 'react';
import type { PublicLocale } from '@repo/config';
import { HomepageSections } from '../../components/homepage-sections';
import { SiteSearchForm } from '../../components/site-search-form';
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
      index: true,
      follow: true,
    },
  );
}

/**
 * The page's opening, and the one thing it leads with (0109).
 *
 * **A working search field, not a headline.** Two reasons, and the second is binding. The first is that a
 * marketplace's characteristic action is looking for something, so the most useful thing `/` can put first is the
 * means to do it — a big number with a small label, or a headline over a gradient, is the default treatment and
 * says nothing about this product. The second is that this page promised, before 0109, to compose what an
 * administrator arranged and to invent no marketing copy of its own. A function is not copy. So the band is built
 * from the site's name, the intro line that was already approved, the search form, and the three catalogue doors
 * that exist in code — and not one word of it is new.
 *
 * It appears above the composed sections as well as above the fallback, because search is wanted on the front
 * page whether or not anyone has arranged anything below it.
 */
async function HomeOpening({ locale, language }: { readonly locale: string; readonly language: PublicLocale }) {
  const t = await getTranslations({ locale, namespace: 'Homepage' });
  const site = await getTranslations({ locale, namespace: 'Site' });
  const search = await getTranslations({ locale, namespace: 'Search' });
  const prefix = language === 'ar' ? '/ar' : '';

  return (
    <Section space="lg" as="div" className="border-b border-neutral-200">
      <Heading level={1} display>
        {site('name')}
      </Heading>
      <p className={cx('mt-4 max-w-2xl text-lg leading-normal text-neutral-700')}>{t('fallbackIntro')}</p>
      <div className="mt-8">
        <SiteSearchForm
          action={`${prefix}/search`}
          placeholder={search('placeholder')}
          submitLabel={search('submit')}
          id="home-search"
        />
      </div>
      <ul className="mt-6 flex list-none flex-wrap gap-2">
        {[
          { href: `${prefix}/listings`, label: t('browseListings') },
          { href: `${prefix}/services`, label: t('browseServices') },
          { href: `${prefix}/categories`, label: t('browseCategories') },
        ].map((entry) => (
          <li key={entry.href}>
            <ButtonLink href={entry.href} variant="secondary" size="sm">
              {entry.label}
            </ButtonLink>
          </li>
        ))}
      </ul>
    </Section>
  );
}

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
      <PageContainer>
        <HomeOpening locale={locale} language={language} />
        {sections === null ? (
          <div className="py-8">
            <Alert tone="warning" title={t('unavailable')} />
          </div>
        ) : null}
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <HomeOpening locale={locale} language={language} />
      <HomepageSections locale={language} sections={sections} />
    </PageContainer>
  );
}
