import { Heading } from '@repo/ui';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { publicBlogIndexPath, publicBlogPostPath, type PublicLocale } from '@repo/config';
import type {
  HomepageListingCard,
  PublicHomepageSection,
} from '@repo/contracts';
import { ListingPrice, type ListingPriceLabels } from './listing-price';

/**
 * The homepage's sections, rendered (0093).
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
 * Server components throughout: the homepage is content, and the HTML has to carry it for a crawler and for a
 * visitor with no JavaScript.
 */

const SECTION_CLASS = 'border-t border-neutral-200 py-10 first:border-t-0';
const GRID_CLASS = 'mt-6 grid gap-6 sm:grid-cols-2 lg:grid-cols-3';
const CARD_CLASS = 'rounded-lg border border-neutral-200 p-4';

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

/** A section's own heading and subheading, where it has them. */
function SectionHeader({ title, subtitle }: { readonly title: string | null; readonly subtitle: string | null }) {
  if (title === null && subtitle === null) return null;
  return (
    <div>
      {title === null ? null : <Heading level={2}>{title}</Heading>}
      {subtitle === null ? null : <p className="mt-2 max-w-prose text-neutral-600">{subtitle}</p>}
    </div>
  );
}

function ListingGrid({
  locale,
  cards,
  priceLabels,
}: {
  readonly locale: PublicLocale;
  readonly cards: readonly HomepageListingCard[];
  readonly priceLabels: ListingPriceLabels;
}) {
  return (
    <ul className={GRID_CLASS}>
      {cards.map((card) => (
        <li className={CARD_CLASS} key={card.slug}>
          <Link className="font-medium text-neutral-900 underline" href={listingPath(locale, card)}>
            {card.title}
          </Link>
          {/* The same price component every other card on this site uses, so the front page cannot format money its
              own way: the amount comes from `@repo/money` at the currency's declared minor unit, a listing with no
              amount says "contact for price" rather than showing a zero, and "negotiable" appears only where there
              is an amount for it to qualify. `isNegotiable` is null for a service, which is not a negotiable one. */}
          <ListingPrice
            currencyCode={card.currencyCode}
            currencyMinorUnit={card.currencyMinorUnit}
            isNegotiable={card.isNegotiable === true}
            labels={priceLabels}
            priceMinor={card.priceMinor}
          />
          {card.city === null ? null : <p className="mt-1 text-sm text-neutral-500">{card.city}</p>}
        </li>
      ))}
    </ul>
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
        switch (section.sectionType) {
          case 'hero':
            return (
              <section className={SECTION_CLASS} key={section.sectionKey}>
                {section.title === null ? null : <Heading level={1}>{section.title}</Heading>}
                {section.subtitle === null ? null : (
                  <p className="mt-3 max-w-prose text-lg text-neutral-700">{section.subtitle}</p>
                )}
                {section.hero.lead === null ? null : (
                  <p className="mt-3 max-w-prose text-neutral-600">{section.hero.lead}</p>
                )}
                {section.hero.ctaPath === null || section.hero.ctaLabel === null ? null : (
                  <p className="mt-6">
                    <Link
                      className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white"
                      href={section.hero.ctaPath}
                    >
                      {section.hero.ctaLabel}
                    </Link>
                  </p>
                )}
              </section>
            );

          case 'featured_listings':
          case 'latest_listings':
            return (
              <section className={SECTION_CLASS} key={section.sectionKey}>
                <SectionHeader title={section.title} subtitle={section.subtitle} />
                <ListingGrid cards={section.listings} locale={locale} priceLabels={priceLabels} />
              </section>
            );

          case 'featured_categories':
            return (
              <section className={SECTION_CLASS} key={section.sectionKey}>
                <SectionHeader title={section.title} subtitle={section.subtitle} />
                <ul className="mt-6 flex flex-wrap gap-3">
                  {section.categories.map((category) => (
                    <li key={category.slug}>
                      <Link
                        className="rounded-full border border-neutral-300 px-4 py-2 text-sm text-neutral-900"
                        href={categoryPath(locale, category.slug)}
                      >
                        {category.name}
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            );

          case 'featured_sellers':
            return (
              <section className={SECTION_CLASS} key={section.sectionKey}>
                <SectionHeader title={section.title} subtitle={section.subtitle} />
                <ul className={GRID_CLASS}>
                  {section.sellers.map((seller) => (
                    <li className={CARD_CLASS} key={seller.slug}>
                      <Link
                        className="font-medium text-neutral-900 underline"
                        href={sellerPath(locale, seller.slug)}
                      >
                        {seller.displayName}
                      </Link>
                      {seller.city === null ? null : (
                        <p className="mt-1 text-sm text-neutral-500">{seller.city}</p>
                      )}
                      {seller.bio === null ? null : <p className="mt-2 text-sm text-neutral-700">{seller.bio}</p>}
                    </li>
                  ))}
                </ul>
              </section>
            );

          case 'blog_highlights':
            return (
              <section className={SECTION_CLASS} key={section.sectionKey}>
                <SectionHeader title={section.title} subtitle={section.subtitle} />
                <ul className="mt-6 space-y-6">
                  {section.posts.map((post) => (
                    <li key={post.slug}>
                      {/* `lang` and `dir` on the content itself: a post may come back in the other language when
                          the one that was asked for has not been written. */}
                      <div dir={post.resolvedLocale === 'ar' ? 'rtl' : 'ltr'} lang={post.resolvedLocale}>
                        <Heading level={3}>
                          <Link
                            className="text-neutral-900 underline"
                            href={publicBlogPostPath(locale, post.slug)}
                          >
                            {post.title}
                          </Link>
                        </Heading>
                        {post.excerpt === null ? null : (
                          <p className="mt-2 text-neutral-700">{post.excerpt}</p>
                        )}
                      </div>
                      <p className="mt-1 text-sm text-neutral-500">
                        <time dateTime={post.publishedAt}>{post.publishedAt.slice(0, 10)}</time>
                        {post.categoryName === null ? null : <> · {post.categoryName}</>}
                      </p>
                    </li>
                  ))}
                </ul>
                <p className="mt-6">
                  <Link className="text-neutral-900 underline" href={publicBlogIndexPath(locale)}>
                    {t('allPosts')}
                  </Link>
                </p>
              </section>
            );

          case 'value_props':
            return (
              <section className={SECTION_CLASS} key={section.sectionKey}>
                <SectionHeader title={section.title} subtitle={section.subtitle} />
                <ul className={GRID_CLASS}>
                  {section.items.map((item) => (
                    <li key={item.title}>
                      <Heading level={3}>{item.title}</Heading>
                      <p className="mt-2 text-neutral-700">{item.body}</p>
                    </li>
                  ))}
                </ul>
              </section>
            );

          case 'rich_text':
            return (
              <section className={SECTION_CLASS} key={section.sectionKey}>
                <SectionHeader title={section.title} subtitle={section.subtitle} />
                {/* Plain text, by owner decision D. The author's line breaks are kept and nothing here interprets
                    the string as markup. */}
                <div className="mt-4 max-w-prose whitespace-pre-wrap text-neutral-900">{section.body}</div>
              </section>
            );
        }
      })}
    </>
  );
}
