import {
  ButtonLink,
  CardGrid,
  Heading,
  LinkCard,
  CardTitle,
  Section,
  SectionHeader,
  TYPE,
  cx,
} from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import { publicBlogIndexPath, publicBlogPostPath, type PublicLocale } from '@repo/config';
import type { HomepageListingCard, PublicHomepageSection } from '@repo/contracts';
import { CatalogCard, CategoryChip, SellerCard } from './catalog-card';
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
 * What 0109 changed is only how it looks. Every card is now {@link CatalogCard} — the same component the browse
 * lists and the search results use — so a listing on the front page is visually the same object as the same
 * listing anywhere else in the product. Before this increment the home page drew its own card, which is why a
 * featured listing looked nothing like the one a person then clicked through to.
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
function ComposedHeader({ title, subtitle }: { readonly title: string | null; readonly subtitle: string | null }) {
  if (title === null && subtitle === null) return null;
  return (
    <SectionHeader
      title={title ?? ''}
      {...(subtitle === null ? {} : { description: subtitle })}
      as="h2"
      className="mb-6"
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
      {sections.map((section) => {
        /** Each band is separated by a hairline rather than by a change of background. */
        const band = 'border-t border-neutral-200 first:border-t-0';

        switch (section.sectionType) {
          case 'hero':
            return (
              <Section space="lg" className={band} key={section.sectionKey}>
                {section.title === null ? null : (
                  <Heading level={1} display>
                    {section.title}
                  </Heading>
                )}
                {section.subtitle === null ? null : (
                  <p className={cx('mt-4 max-w-2xl text-lg leading-normal text-neutral-700')}>{section.subtitle}</p>
                )}
                {section.hero.lead === null ? null : (
                  <p className={cx('mt-3 max-w-2xl', TYPE.body)}>{section.hero.lead}</p>
                )}
                {section.hero.ctaPath === null || section.hero.ctaLabel === null ? null : (
                  <p className="mt-8">
                    <ButtonLink href={section.hero.ctaPath} size="lg">
                      {section.hero.ctaLabel}
                    </ButtonLink>
                  </p>
                )}
              </Section>
            );

          case 'featured_listings':
          case 'latest_listings':
            return (
              <Section space="lg" className={band} key={section.sectionKey}>
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
              </Section>
            );

          case 'featured_categories':
            return (
              <Section space="lg" className={band} key={section.sectionKey}>
                <ComposedHeader title={section.title} subtitle={section.subtitle} />
                <ul className="flex list-none flex-wrap gap-2">
                  {section.categories.map((category) => (
                    <CategoryChip
                      key={category.slug}
                      href={categoryPath(locale, category.slug)}
                      label={category.name}
                    />
                  ))}
                </ul>
              </Section>
            );

          case 'featured_sellers':
            return (
              <Section space="lg" className={band} key={section.sectionKey}>
                <ComposedHeader title={section.title} subtitle={section.subtitle} />
                <CardGrid className="xl:grid-cols-3">
                  {section.sellers.map((seller) => (
                    <SellerCard
                      key={seller.slug}
                      href={sellerPath(locale, seller.slug)}
                      displayName={seller.displayName}
                      city={seller.city}
                      bio={seller.bio}
                    />
                  ))}
                </CardGrid>
              </Section>
            );

          case 'blog_highlights':
            return (
              <Section space="lg" className={band} key={section.sectionKey}>
                <ComposedHeader title={section.title} subtitle={section.subtitle} />
                <ul className="grid list-none grid-cols-1 gap-4 md:grid-cols-3">
                  {section.posts.map((post) => (
                    <LinkCard as="li" key={post.slug} href={publicBlogPostPath(locale, post.slug)} aria-label={post.title}>
                      {/* `lang` and `dir` on the content itself: a post may come back in the other language when
                          the one that was asked for has not been written. */}
                      <div
                        className="flex flex-1 flex-col gap-2 p-4"
                        dir={post.resolvedLocale === 'ar' ? 'rtl' : 'ltr'}
                        lang={post.resolvedLocale}
                      >
                        <CardTitle>{post.title}</CardTitle>
                        {post.excerpt === null ? null : (
                          <p className="line-clamp-3 text-sm leading-normal text-neutral-700">{post.excerpt}</p>
                        )}
                      </div>
                      {/*
                        A description list, not two spans joined by a middle dot. The dot was both a cliché and a
                        loss of structure: a screen reader read "date · category" as one run of text, and the
                        separator had to be mirrored by hand in Arabic. Here the relationship is in the markup.
                      */}
                      <dl className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1 px-4 pb-4 text-sm text-neutral-600">
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
                    </LinkCard>
                  ))}
                </ul>
                <p className="mt-6">
                  <ButtonLink href={publicBlogIndexPath(locale)} variant="secondary" size="sm">
                    {t('allPosts')}
                  </ButtonLink>
                </p>
              </Section>
            );

          case 'value_props':
            return (
              <Section space="lg" className={band} key={section.sectionKey}>
                <ComposedHeader title={section.title} subtitle={section.subtitle} />
                {/*
                  No numbered markers. `01 / 02 / 03` is only right when the content is a sequence, and a set of
                  value propositions is not one — they are parallel, and numbering them would invent an order the
                  administrator did not arrange.
                */}
                <ul className="grid list-none grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
                  {section.items.map((item) => (
                    <li key={item.title} className="border-s-2 border-neutral-200 ps-4">
                      <h3 className={TYPE.h4}>{item.title}</h3>
                      <p className={cx('mt-2', TYPE.body)}>{item.body}</p>
                    </li>
                  ))}
                </ul>
              </Section>
            );

          case 'rich_text':
            return (
              <Section space="lg" className={band} key={section.sectionKey}>
                <ComposedHeader title={section.title} subtitle={section.subtitle} />
                {/* Plain text, by owner decision D. The author's line breaks are kept and nothing here interprets
                    the string as markup. */}
                <div className={cx('max-w-prose whitespace-pre-wrap', TYPE.prose)}>{section.body}</div>
              </Section>
            );
        }
      })}
    </>
  );
}
