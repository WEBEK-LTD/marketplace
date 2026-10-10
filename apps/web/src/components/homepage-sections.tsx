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
import { CatalogCard, CategoryTile, SellerCard } from './catalog-card';
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
 * **No section renders an image.** A banner strip is not served at all, and a seller's logo and a category's image
 * are absent from the contract, because this platform has no media origin to address one with.
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

/** A composed section's own heading and subheading, where it has them. */
function ComposedHeader({
  title,
  subtitle,
  tone,
  action,
}: {
  readonly title: string | null;
  readonly subtitle: string | null;
  readonly tone?: 'default' | 'ink';
  readonly action?: React.ReactNode;
}) {
  if (title === null && subtitle === null) return null;
  return (
    <SectionHeader
      title={title ?? ''}
      {...(subtitle === null ? {} : { description: subtitle })}
      {...(tone === undefined ? {} : { tone })}
      {...(action === undefined ? {} : { action })}
      as="h2"
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

        switch (section.sectionType) {
          case 'hero':
            /*
              A composed hero, which is a different thing from the page's opening band: the opening is the
              product's own, this is whatever an administrator wrote. It is set one step down the display scale
              so the two do not compete for the same job on the same page.
            */
            /*
              A composed hero sits on the accent wash and splits: the administrator's headline on the left,
              their supporting line and call to action on the right. The single left-aligned column this
              replaced was a thin strip of mostly empty space between two strong bands — it read as a gap in
              the page rather than as a statement in it.
            */
            return (
              <Band tone={tone} space="normal" key={key}>
                <PageContainer>
                  <div className="grid grid-cols-1 items-end gap-8 lg:grid-cols-12 lg:gap-12">
                    <div className="lg:col-span-7">
                      {section.title === null ? null : (
                        <Heading level={2} className={cx(TYPE.displaySm, ink && 'text-on-ink')}>
                          {section.title}
                        </Heading>
                      )}
                      {section.subtitle === null ? null : (
                        <p className={cx('mt-5 max-w-xl', ink ? 'text-lg leading-normal text-on-ink-muted' : TYPE.lead)}>
                          {section.subtitle}
                        </p>
                      )}
                    </div>
                    <div className="lg:col-span-4 lg:col-start-9">
                      {section.hero.lead === null ? null : (
                        <p
                          className={cx(
                            'border-s-2 ps-5',
                            ink ? 'border-accent-400 text-base text-on-ink-muted' : 'border-accent-400',
                            !ink && TYPE.body,
                          )}
                        >
                          {section.hero.lead}
                        </p>
                      )}
                      {section.hero.ctaPath === null || section.hero.ctaLabel === null ? null : (
                        <p className="mt-7">
                          <ButtonLink href={section.hero.ctaPath} size="lg" variant={ink ? 'onInk' : 'primary'}>
                            {section.hero.ctaLabel}
                          </ButtonLink>
                        </p>
                      )}
                    </div>
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
                  <ComposedHeader title={section.title} subtitle={section.subtitle} />
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
                      />
                    ))}
                  </CardGrid>
                </PageContainer>
              </Band>
            );
          }

          case 'featured_categories':
            /*
              Tiles, not a row of pills. A category is a door, and 0109 drew twenty identical 32px-tall chips
              that read as leftover form controls — the most important navigation on the home page given less
              presence than a button. A tile is large enough to aim at on a phone and to carry a count.

              They are deliberately uniform. A mosaic with a double-width first tile was tried and produced a
              ragged last row — one orphan tile beside a gap — which reads as a layout that broke rather than
              as composition. The page's asymmetry lives where it is robust: the opening band's 7/5 split.
            */
            return (
              <Band tone={tone} space="normal" key={key}>
                <PageContainer>
                  <ComposedHeader title={section.title} subtitle={section.subtitle} />
                  <ul className="grid list-none grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4">
                    {section.categories.map((category) => (
                      <CategoryTile
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
