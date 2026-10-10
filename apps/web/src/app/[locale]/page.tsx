import { Alert, Band, Heading, PageContainer, cx } from '@repo/ui';
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
 * **0110 inverts it.** The opening is now an ink band: near-black, full-bleed, with the site's name set at the
 * top of the type scale and the search field at the largest size the system has. That is where the product's
 * first impression comes from, and it costs no colour — which matters, because the two brand slots are still
 * placeholders. A white page that opens with a 30px heading and a 40px input is a document; the same content on
 * an inverted band at 72px and 60px is a front page.
 *
 * **It is asymmetric**, 7 columns of opening against 5 of doors on a wide viewport, because a centred stack is
 * the layout every generated page arrives at. On a phone the two stack and the doors become a row.
 *
 * It appears above the composed sections as well as above the fallback, because search is wanted on the front
 * page whether or not anyone has arranged anything below it.
 */
async function HomeOpening({ locale, language }: { readonly locale: string; readonly language: PublicLocale }) {
  const t = await getTranslations({ locale, namespace: 'Homepage' });
  const site = await getTranslations({ locale, namespace: 'Site' });
  const search = await getTranslations({ locale, namespace: 'Search' });
  const prefix = language === 'ar' ? '/ar' : '';

  const doors = [
    { href: `${prefix}/listings`, label: t('browseListings') },
    { href: `${prefix}/services`, label: t('browseServices') },
    { href: `${prefix}/categories`, label: t('browseCategories') },
  ];

  return (
    <Band tone="ink" space="opening" as="div">
      {/*
        There is deliberately no decorative field behind the opening.

        One was built — a soft radial of the brand, off-centre and clipped by the band — and removed, for two
        reasons that agreed. It put a `radial-gradient` into the shipped stylesheet, which a structural test
        forbids on the grounds that a gradient is where a colour nobody tokenised gets in; the colour here did
        come from a token, but weakening a rule to admit decoration is a bad trade. And it was decoration: a
        soft wash behind a headline is the first thing a generated page reaches for, it was barely visible at
        the alpha that did not muddy the type, and the band reads perfectly well without it. The opening's
        presence comes from the inversion, the scale of the name and the size of the search field.
      */}
      <PageContainer>
        <div className="max-w-3xl">
          {/*
            A short accent rule and nothing else above the name. An eyebrow was tried here and removed: the
            only text available for one is the navigation's own labels, which made it a slogan assembled from
            menu items — and the same three labels sit as doors a few lines below. A page should not say the
            same thing twice to fill a line.
          */}
          <span aria-hidden="true" className="block h-0.5 w-16 rounded-full bg-accent-400" />

          <Heading level={1} display className="mt-8 text-on-ink">
            {site('name')}
          </Heading>
          <p className="mt-6 max-w-xl text-lg leading-normal text-on-ink-muted sm:text-xl">{t('fallbackIntro')}</p>

          <div className="mt-10">
            <SiteSearchForm
              action={`${prefix}/search`}
              placeholder={search('placeholder')}
              submitLabel={search('submit')}
              id="home-search"
              tone="ink"
            />
          </div>

          {/*
            The catalogue doors as a row of quiet pills under the search, rather than the stacked directory
            column this replaced. They are secondary to the search field — a visitor who knows what they want
            types it — so they are sized and weighted as what they are: three shortcuts, not a menu.
          */}
          <ul className="mt-8 flex list-none flex-wrap gap-2.5">
            {doors.map((door) => (
              <li key={door.href}>
                <a
                  href={door.href}
                  className={cx(
                    'group inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium text-on-ink',
                    'bg-surface-ink-muted ring-1 ring-edge-on-ink transition-colors duration-200',
                    'hover:bg-state-hover-on-ink hover:ring-edge-on-ink-strong',
                    'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-on-ink',
                  )}
                >
                  {door.label}
                  <span
                    aria-hidden="true"
                    className="size-1.5 -rotate-45 rtl:rotate-45 border-e border-b border-on-ink-muted transition-transform duration-200 group-hover:translate-x-0.5 rtl:group-hover:-translate-x-0.5"
                  />
                </a>
              </li>
            ))}
          </ul>
        </div>
      </PageContainer>
    </Band>
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
      <>
        <HomeOpening locale={locale} language={language} />
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
      <HomeOpening locale={locale} language={language} />
      <HomepageSections locale={language} sections={sections} />
    </>
  );
}
