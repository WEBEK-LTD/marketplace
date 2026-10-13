import {
  Band,
  ButtonLink,
  CardGrid,
  CardTitle,
  Heading,
  LinkCard,
  PageContainer,
  SectionHeader,
  TYPE,
  cx,
  type BandTone,
} from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import { publicBlogIndexPath, publicBlogPostPath, type PublicLocale } from '@repo/config';
import type { HomepageListingCard, PublicHomepageSection } from '@repo/contracts';
import { CatalogCard, CategoryRow, SellerCard } from './catalog-card';
import { CARD_PHOTO_SIZES, ListingPhoto, anyPhotographed } from './listing-photo';
import type { ListingPriceLabels } from './listing-price';

/**
 * The homepage's sections, rendered (0093, restyled in 0109).
 *
 * **Nothing here decides what to show.** Which sections exist, in what order, and what content each one still has
 * are all settled before this renders: the API composes the homepage and drops any section with nothing left to
 * show, so every section that reaches this file has content and no branch here handles an empty one.
 *
 * **`rich_text` is rendered as text** — owner decision D. `whitespace-pre-wrap` keeps the author's line breaks and
 * nothing interprets the string as markup.
 *
 * **A listing shelf renders its photographs (0116); nothing else on this page renders an image.** A banner strip
 * is not served at all, and a seller's logo and a category's image are still absent from the contract — there is
 * no upload surface for either, so there is nothing to address. A listing card's own photograph is different:
 * `HomepageListingCardSchema` carries `primaryImage`, and a shelf of listings on the front page shows the same
 * picture the same listing shows on the browse list.
 *
 * Every card is {@link CatalogCard} — the same component the browse lists and the search results use — so a
 * listing on the front page is visually the same object as the same listing anywhere else in the product.
 *
 * **0110 makes each section a band.** A composed homepage is now a stack of full-bleed horizontal bands that
 * alternate between the canvas and a recessed surface, with the value propositions closing on ink. That is the
 * difference between a page that was designed and one that was assembled: 0109 rendered every section on the
 * same white with a hairline between them, so eight sections read as one undifferentiated document however good
 * each one was on its own.
 *
 * **The two catalogues are drawn differently on purpose.** A section whose cards are all services gets the
 * two-up wide card, because a service carries a delivery time and a revision count that a compact card
 * truncates; a section of products gets the four-up compact card. The difference is decided from the content
 * rather than from a new section type, so nothing was invented upstream to get it.
 *
 * Server components throughout: the homepage is content, and the HTML has to carry it for a crawler and for a
 * visitor with no JavaScript.
 */

function listingPath(locale: PublicLocale, card: HomepageListingCard): string {
  const prefix = card.resultType === 'service' ? '/service/' : '/listing/';
  return `${locale === 'ar' ? '/ar' : ''}${prefix}${encodeURIComponent(card.slug)}`;
}

function categoryPath(locale: PublicLocale, slug: string): string {
  return `${locale === 'ar' ? '/ar' : ''}/category/${encodeURIComponent(slug)}`;
}

function sellerPath(locale: PublicLocale, slug: string): string {
  return `${locale === 'ar' ? '/ar' : ''}/seller/${encodeURIComponent(slug)}`;
}

/**
 * A composed section's own heading and subheading, where it has them.
 *
 * **No accent rule** (0112). `SectionHeader`'s hairline-and-tick is the right device on a page whose sections
 * share one surface, and the wrong one here: these sections are bands, and the change of surface between one band
 * and the next already says where a section begins. Drawing the rule as well meant the identical ornament above
 * the identical heading size eight times down the page, which is what made a composed home page read as one
 * template run eight times rather than as a composition.
 *
 * **The first section gets the step above.** With every heading at the same size a page had no hierarchy below
 * its `<h1>`; the opening shelf now leads at `TYPE.h1` and the ones after it sit at `h2`. The heading *level* is
 * `h2` either way — the outline is a separate question from the type size.
 */
function ComposedHeader({
  title,
  subtitle,
  tone,
  action,
  size,
}: {
  readonly title: string | null;
  readonly subtitle: string | null;
  readonly tone?: 'default' | 'ink';
  readonly action?: React.ReactNode;
  readonly size?: 'default' | 'lead';
}) {
  if (title === null && subtitle === null) return null;
  return (
    <SectionHeader
      title={title ?? ''}
      {...(subtitle === null ? {} : { description: subtitle })}
      {...(tone === undefined ? {} : { tone })}
      {...(action === undefined ? {} : { action })}
      {...(size === undefined ? {} : { size })}
      as="h2"
      ornament="none"
      className="mb-10 sm:mb-12"
    />
  );
}

export async function HomepageSections({
  locale,
  sections,
}: {
  readonly locale: PublicLocale;
  readonly sections: readonly PublicHomepageSection[];
}) {
  const t = await getTranslations({ locale, namespace: 'Homepage' });
  // The catalogue's own price words, not new ones: a card on the front page must read exactly as the same card
  // reads on the browse list.
  const tListings = await getTranslations({ locale, namespace: 'Listings' });
  const priceLabels: ListingPriceLabels = {
    contactForPrice: tListings('contactForPrice'),
    negotiable: tListings('negotiable'),
  };

  return (
    <>
      {sections.map((section, index) => {
        /*
          The band's surface follows what the section *is*, and then alternates within that.
          
          A section full of cards goes on a recessed band, because a card is defined partly by having something
          to lift off; a statement — a hero, a block of prose — goes on the canvas, where nothing competes with
          the words. `value_props` always closes on ink: it is the one type that is an argument rather than a
          catalogue, and inverting it gives the foot of the page the weight the opening has.

          Two card sections in a row would otherwise merge into one long grey field, so consecutive ones
          alternate back to the canvas — the card's hairline ring is what lets it work on either.
        */
        const CARD_SECTIONS = new Set([
          'featured_listings',
          'latest_listings',
          'featured_sellers',
          'blog_highlights',
          'featured_categories',
        ]);
        const cardIndex = sections.slice(0, index).filter((s) => CARD_SECTIONS.has(s.sectionType)).length;
        const tone: BandTone =
          section.sectionType === 'value_props'
            ? 'ink'
            : section.sectionType === 'hero'
              ? 'accent'
              : CARD_SECTIONS.has(section.sectionType) && cardIndex % 2 === 0
                ? 'sunken'
                : 'canvas';
        const ink = tone === 'ink';
        const key = section.sectionKey;
        // The page's opening shelf takes the step above, so the stack below the `<h1>` has a hierarchy. A
        // composed `hero` is not a shelf and sets its own scale, so the first shelf after it is still the lead.
        const lead = sections.slice(0, index).every((s) => s.sectionType === 'hero');

        switch (section.sectionType) {
          case 'hero':
            /*
              A composed hero, which is a different thing from the page's opening band: the opening is the
              product's own, this is whatever an administrator wrote. It is set one step down the display scale
              so the two do not compete for the same job on the same page.
            */
            /*
              **One column, centred on the measure** (0112). This was a 7/4 split with the headline on one side
              and the lead plus the call to action in a narrow column on the other, separated by a vertical rule.
              The screenshots showed what that actually produces: a wide heading beside a 280px strip of two
              short lines and a button, which reads as a column that did not fit rather than as a statement.

              A composed hero is a statement, and a statement is one block. The headline, the lead under it and
              the action under that, on the reading measure — which is also the only arrangement that is correct
              whether the administrator filled one of those three fields or all of them.
            */
            return (
              <Band tone={tone} space="normal" key={key}>
                <PageContainer>
                  <div className="max-w-3xl">
                    {section.title === null ? null : (
                      <Heading level={2} className={cx(TYPE.displaySm, ink && 'text-on-ink')}>
                        {section.title}
                      </Heading>
                    )}
                    {section.subtitle === null ? null : (
                      <p className={cx('mt-6', ink ? 'text-lg leading-normal text-on-ink-muted' : TYPE.lead)}>
                        {section.subtitle}
                      </p>
                    )}
                    {section.hero.lead === null ? null : (
                      <p className={cx('mt-5', ink ? 'text-base text-on-ink-muted' : TYPE.body)}>
                        {section.hero.lead}
                      </p>
                    )}
                    {section.hero.ctaPath === null || section.hero.ctaLabel === null ? null : (
                      <p className="mt-9">
                        <ButtonLink href={section.hero.ctaPath} size="lg" variant={ink ? 'onInk' : 'primary'}>
                          {section.hero.ctaLabel}
                        </ButtonLink>
                      </p>
                    )}
                  </div>
                </PageContainer>
              </Band>
            );

          case 'featured_listings':
          case 'latest_listings': {
            /*
              Compact cards, even for a shelf of services. `HomepageListingCardSchema` is strict and carries no
              delivery time and no revision count — those live on the service contract, not this one — so the
              wide card has nothing extra to put in the room it gains and renders as empty space. The two
              catalogues are differentiated on `/listings` and `/services`, where the data supports it.
            */
            return (
              <Band tone={tone} space="normal" key={key}>
                <PageContainer>
                  <ComposedHeader
                    title={section.title}
                    subtitle={section.subtitle}
                    {...(lead ? { size: 'lead' as const } : {})}
                  />
                  <CardGrid>
                    {section.listings.map((card) => (
                      <CatalogCard
                        key={`${card.resultType}-${card.slug}`}
                        href={listingPath(locale, card)}
                        title={card.title}
                        city={card.city}
                        priceMinor={card.priceMinor}
                        currencyCode={card.currencyCode}
                        currencyMinorUnit={card.currencyMinorUnit}
                        isNegotiable={card.isNegotiable}
                        labels={priceLabels}
                        /*
                          One decision for the shelf, taken once above: either every card on it has a picture
                          region or none does. `alt=""` — the card is one link already labelled with the title.
                        */
                        {...(anyPhotographed(section.listings)
                          ? {
                              media: (
                                <ListingPhoto alt="" image={card.primaryImage} sizes={CARD_PHOTO_SIZES} />
                              ),
                            }
                          : {})}
                      />
                    ))}
                  </CardGrid>
                </PageContainer>
              </Band>
            );
          }

          case 'featured_categories':
            /*
              **An index, not a grid of tiles** (0112). See `CategoryRow` for the whole argument; in short, the
              four-by-two grid of identical white rectangles is the figure the brief rejects, and the same eight
              names set large in two columns of hairline-separated rows carry twice the type and none of the
              furniture.

              `columns-*` rather than a CSS grid: a multi-column flow fills the first column before the second,
              so an index reads down and then across the way a directory does, and an odd count leaves a short
              second column instead of an orphan box in a ragged row. `break-inside-avoid` on the rows keeps a
              name and its rule together at a column break. The top rule closes the list at its head, so the
              first row is edged like every row after it.
            */
            return (
              <Band tone={tone} space="normal" key={key}>
                <PageContainer>
                  <ComposedHeader title={section.title} subtitle={section.subtitle} />
                  <ul className="list-none border-t border-hairline sm:columns-2 sm:gap-x-16 [&>li]:break-inside-avoid">
                    {section.categories.map((category) => (
                      <CategoryRow
                        key={category.slug}
                        href={categoryPath(locale, category.slug)}
                        label={category.name}
                      />
                    ))}
                  </ul>
                </PageContainer>
              </Band>
            );

          case 'featured_sellers':
            return (
              <Band tone={tone} space="normal" key={key}>
                <PageContainer>
                  <ComposedHeader title={section.title} subtitle={section.subtitle} />
                  <ul className="grid list-none grid-cols-1 gap-4 sm:gap-5 md:grid-cols-3">
                    {section.sellers.map((seller) => (
                      <SellerCard
                        key={seller.slug}
                        href={sellerPath(locale, seller.slug)}
                        displayName={seller.displayName}
                        city={seller.city}
                        bio={seller.bio}
                      />
                    ))}
                  </ul>
                </PageContainer>
              </Band>
            );

          case 'blog_highlights':
            return (
              <Band tone={tone} space="normal" key={key}>
                <PageContainer>
                  <ComposedHeader
                    title={section.title}
                    subtitle={section.subtitle}
                    action={
                      <ButtonLink href={publicBlogIndexPath(locale)} variant="secondary" size="sm">
                        {t('allPosts')}
                      </ButtonLink>
                    }
                  />
                  <ul className="grid list-none grid-cols-1 gap-4 sm:gap-5 md:grid-cols-3">
                    {section.posts.map((post) => (
                      <LinkCard
                        as="li"
                        key={post.slug}
                        href={publicBlogPostPath(locale, post.slug)}
                        aria-label={post.title}
                      >
                        {/* `lang` and `dir` on the content itself: a post may come back in the other language
                            when the one that was asked for has not been written. */}
                        <div
                          className="flex flex-1 flex-col gap-3 p-6"
                          dir={post.resolvedLocale === 'ar' ? 'rtl' : 'ltr'}
                          lang={post.resolvedLocale}
                        >
                          {/*
                            A description list, not two spans joined by a middle dot. The dot was both a cliché
                            and a loss of structure: a screen reader read "date · category" as one run of text,
                            and the separator had to be mirrored by hand in Arabic.
                          */}
                          <dl className={cx('flex flex-wrap items-center gap-x-4 gap-y-1', TYPE.metaSmall)}>
                            <div className="flex items-center gap-1.5">
                              <dt className="sr-only">{t('allPosts')}</dt>
                              <dd>
                                <time dateTime={post.publishedAt}>{post.publishedAt.slice(0, 10)}</time>
                              </dd>
                            </div>
                            {post.categoryName === null ? null : (
                              <div className="flex items-center gap-1.5">
                                <dt className="sr-only">{post.categoryName}</dt>
                                <dd className="truncate">{post.categoryName}</dd>
                              </div>
                            )}
                          </dl>
                          <CardTitle size="large">{post.title}</CardTitle>
                          {post.excerpt === null ? null : (
                            <p className={cx('line-clamp-3', TYPE.meta)}>{post.excerpt}</p>
                          )}
                        </div>
                      </LinkCard>
                    ))}
                  </ul>
                </PageContainer>
              </Band>
            );

          case 'value_props':
            return (
              <Band tone={tone} space="normal" key={key}>
                <PageContainer>
                  <ComposedHeader title={section.title} subtitle={section.subtitle} tone="ink" />
                  {/*
                    No numbered markers. `01 / 02 / 03` is only right when the content is a sequence, and a set
                    of value propositions is not one — they are parallel, and numbering them would invent an
                    order the administrator did not arrange. A rule above each one marks the column instead.
                  */}
                  <ul className="grid list-none grid-cols-1 gap-10 sm:grid-cols-2 lg:grid-cols-3 lg:gap-14">
                    {section.items.map((item) => (
                      <li key={item.title} className="border-t border-edge-on-ink pt-6">
                        <h3 className={cx(TYPE.h4, 'text-on-ink')}>{item.title}</h3>
                        <p className="mt-3 text-base leading-relaxed text-on-ink-muted">{item.body}</p>
                      </li>
                    ))}
                  </ul>
                </PageContainer>
              </Band>
            );

          case 'rich_text':
            return (
              <Band tone={tone} space="normal" key={key}>
                <PageContainer>
                  <ComposedHeader title={section.title} subtitle={section.subtitle} />
                  {/* Plain text, by owner decision D. The author's line breaks are kept and nothing here
                      interprets the string as markup. */}
                  <div className={cx('max-w-prose whitespace-pre-wrap', TYPE.prose)}>{section.body}</div>
                </PageContainer>
              </Band>
            );
        }
      })}
    </>
  );
}
