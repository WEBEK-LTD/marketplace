import type { ListingDetail, ListingSummary } from '@repo/contracts';
import type { ReactNode } from 'react';
import {
  Alert,
  Badge,
  Card,
  CardGrid,
  DetailLayout,
  DetailList,
  EmptyState,
  Heading,
  SkeletonCardGrid,
  TYPE,
  cx,
} from '@repo/ui';
import { CatalogCard } from './catalog-card';
import { ListingGallery, type ListingGalleryLabels } from './listing-gallery';
import { CARD_PHOTO_SIZES, ListingPhoto, anyPhotographed } from './listing-photo';
import { ListingPrice, formatListingAmount, type ListingPriceLabels, PriceLockup } from './listing-price';

/**
 * The public listing surfaces (Phase 4-B, restyled in 0109).
 *
 * Everything renders on the server: a listing is content, and a crawler and a visitor with no JavaScript should
 * both see it. **0116 gave `ListingSummarySchema` its `primaryImage`**, so a card now carries its photograph
 * where the seller has uploaded one — three pre-sized WebP variants from a public bucket, named by plain URLs.
 * 0109's reasoning survives for the case that has not changed: a grid in which *no* card has a photograph gets
 * no picture frames at all rather than twenty empty ones, because that reads as an outage and not as a design.
 * See {@link anyPhotographed}, which is where that decision is taken, once per grid.
 *
 * Direction is never hard-coded. Spacing and alignment use logical properties, so the same markup reads correctly
 * in English and in Arabic with nothing but `dir` changing.
 */

export interface ListingCardLabels extends ListingPriceLabels {
  readonly noLongerAvailable?: string;
}

/**
 * One card in the browse list.
 *
 * A thin wrapper over {@link CatalogCard}, which is the one card the whole product uses — the home page, the
 * marketplace landing, the services list, a category's feed and the search results all render the same component.
 * This exists only to map a `ListingSummary` onto it, so the mapping lives in one place.
 */
export function ListingCard({
  listing,
  href,
  labels,
  withPhoto = false,
}: {
  readonly listing: ListingSummary;
  readonly href: string;
  readonly labels: ListingCardLabels;
  /**
   * Whether this card gets a picture region.
   *
   * The grid decides it, not the card — see {@link anyPhotographed}. False by default so a surface that has
   * not been taught about photographs keeps the typographic card it had rather than growing empty frames.
   */
  readonly withPhoto?: boolean;
}) {
  return (
    <CatalogCard
      href={href}
      title={listing.title}
      city={listing.city}
      priceMinor={listing.priceMinor}
      currencyCode={listing.currencyCode}
      currencyMinorUnit={listing.currencyMinorUnit}
      isNegotiable={listing.isNegotiable}
      labels={labels}
      listingId={listing.id}
      /*
        The picture region, where the grid decided there is one. `alt=""`: this card is one link labelled with
        the listing's title, and describing the photograph would make a screen reader read it twice.
      */
      {...(withPhoto === false
        ? {}
        : {
            media: <ListingPhoto alt="" image={listing.primaryImage} sizes={CARD_PHOTO_SIZES} />,
          })}
    />
  );
}

/** The browse list, on the catalogue's shared responsive rhythm. */
export function ListingGrid({
  listings,
  hrefFor,
  labels,
}: {
  readonly listings: readonly ListingSummary[];
  readonly hrefFor: (slug: string) => string;
  readonly labels: ListingCardLabels;
}) {
  // One decision for the whole grid, taken here: either every card has a picture region or none does.
  const withPhoto = anyPhotographed(listings);

  return (
    <CardGrid className="mt-8">
      {listings.map((listing) => (
        <ListingCard
          key={listing.id}
          listing={listing}
          href={hrefFor(listing.slug)}
          labels={labels}
          withPhoto={withPhoto}
        />
      ))}
    </CardGrid>
  );
}

/**
 * The loading state.
 *
 * Placeholders shaped exactly like the real cards, so the grid does not move when the data arrives — which is
 * the entire reason a catalogue uses skeletons rather than a spinner. The grid announces the wait once, with its
 * label, rather than once per card.
 */
export function ListingGridSkeleton({ label }: { readonly label: string }) {
  return (
    <div className="mt-8">
      <SkeletonCardGrid count={8} label={label} />
    </div>
  );
}

/**
 * The empty, error and not-found states.
 *
 * An empty catalogue is ordinary and is drawn as a space waiting to be filled; a failure is a recessed surface
 * that announces itself. The distinction matters because a person's next move differs: narrowing filters found
 * nothing, and an outage found nothing *yet*.
 */
export function ListingMessage({
  title,
  description,
  tone,
}: {
  readonly title: string;
  readonly description: string;
  readonly tone: 'empty' | 'error';
}) {
  return (
    <div className="mt-8">
      <EmptyState title={title} description={description} tone={tone === 'error' ? 'unavailable' : 'empty'} />
    </div>
  );
}

export interface ListingDetailLabels extends ListingPriceLabels, ListingGalleryLabels {
  readonly noLongerAvailable: string;
  readonly sellerHeading: string;
  readonly categoryHeading: string;
  readonly detailsHeading: string;
  readonly tagsHeading: string;
  readonly descriptionHeading: string;
  readonly yes: string;
  readonly no: string;
}

/** Renders one attribute's value in the shape the attribute actually has. */
function attributeValue(attribute: ListingDetail['attributes'][number], labels: ListingDetailLabels): string {
  if (attribute.options.length > 0) return attribute.options.join(', ');
  if (attribute.boolean !== null) return attribute.boolean ? labels.yes : labels.no;
  if (attribute.text === null) return '';
  return attribute.unit === null ? attribute.text : `${attribute.text} ${attribute.unit}`;
}

/**
 * The detail page's body.
 *
 * **`contentLanguage` is set on the title and the description**, because seller content is stored in its own
 * writing language and never translated (D7): a page in Arabic may carry an English listing, and a screen reader
 * should switch voice for it rather than read it in the page's language. `dir="auto"` goes with it, so an English
 * title inside an Arabic page is laid out left-to-right where it belongs.
 *
 * **The price is the aside's first element, and the aside sticks.** A person reading a long description still has
 * the amount, the seller and the category in view — which is what they came to the page to judge. On a phone the
 * aside is not sticky and sits first in the source order instead, so the price is the first thing after the title
 * rather than something to scroll past the description for.
 */
export function ListingDetailView({
  listing,
  labels,
  actions,
}: {
  readonly listing: ListingDetail;
  readonly labels: ListingDetailLabels;
  /**
   * What a person came here to do, rendered under the price.
   *
   * A slot rather than markup, because the actions are the page's: they need a session, a listing id and a
   * client component, none of which belong in a presentational view. 0109 left them stranded at the foot of
   * the main column, half a screen below the price and under the description — the two halves of one decision
   * separated by everything else on the page. Here the price, the seller and the actions are one block.
   */
  readonly actions?: ReactNode;
}) {
  const unavailable = listing.availability === 'no_longer_available';
  const amount = formatListingAmount(listing.priceMinor, listing.currencyCode, listing.currencyMinorUnit);

  return (
    <article className="pt-6 pb-12">
      {unavailable ? (
        <div className="mb-6">
          <Alert tone="warning" announce="polite" title={labels.noLongerAvailable} />
        </div>
      ) : null}

      <header className="mb-8">
        <Heading level={1}>
          <span lang={listing.contentLanguage} dir="auto">
            {listing.title}
          </span>
        </Heading>
        {listing.city === null ? null : <p className={cx('mt-2', TYPE.meta)}>{listing.city}</p>}
      </header>

      <DetailLayout
        main={
          <div className="space-y-10">
            {/*
              The photographs, first in the main column (0116). Above the description because that is the order
              a person reads a property listing in — they look, then they read — and in the main column rather
              than full width so the buy box beside it stays on the first screen.

              Nothing renders at all when there are none: see {@link ListingGallery}.
            */}
            <ListingGallery images={listing.images} title={listing.title} labels={labels} />

            <section>
              <h2 className={TYPE.h3}>{labels.descriptionHeading}</h2>
              <p
                lang={listing.contentLanguage}
                dir="auto"
                className={cx('mt-3 max-w-prose whitespace-pre-line', TYPE.prose)}
              >
                {listing.description}
              </p>
            </section>

            {listing.attributes.length > 0 ? (
              <section>
                <h2 className={TYPE.h3}>{labels.detailsHeading}</h2>
                <DetailList
                  className="mt-4"
                  items={listing.attributes.map((attribute) => ({
                    label: attribute.label,
                    value: attributeValue(attribute, labels),
                  }))}
                />
              </section>
            ) : null}
          </div>
        }
        aside={
          <div className="space-y-4">
            {/*
              The buy box carries the brand surface and a brand edge. Everything else on a detail page is
              something to read; this is the one region that is something to do, and on a page of white
              panels it was indistinguishable from the panel of tags beneath it.
            */}
            <Card padding="lg" className="bg-surface-brand-soft ring-edge-brand">
              <PriceLockup
                priceMinor={listing.priceMinor}
                currencyCode={listing.currencyCode}
                currencyMinorUnit={listing.currencyMinorUnit}
                labels={labels}
                size="detail"
              />
              {listing.isNegotiable && amount !== null ? (
                <p className="mt-1 text-sm text-ink-muted">{labels.negotiable}</p>
              ) : null}

              {actions === undefined ? null : <div className="mt-6 flex flex-col gap-3">{actions}</div>}
              <dl className="mt-5 space-y-4 border-t border-hairline pt-5">
                <div>
                  <dt className={TYPE.label}>{labels.sellerHeading}</dt>
                  <dd className="mt-0.5 text-sm text-ink-body" dir="auto">
                    {listing.seller.displayName}
                  </dd>
                </div>
                <div>
                  <dt className={TYPE.label}>{labels.categoryHeading}</dt>
                  <dd className="mt-0.5 text-sm text-ink-body" dir="auto">
                    {listing.category.name}
                  </dd>
                </div>
              </dl>
            </Card>

            {listing.tags.length > 0 ? (
              <Card padding="lg">
                <h2 className={TYPE.label}>{labels.tagsHeading}</h2>
                <ul className="mt-3 flex list-none flex-wrap gap-2">
                  {listing.tags.map((tag) => (
                    <li key={tag.slug}>
                      <Badge tone="neutral">{tag.name}</Badge>
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null}
          </div>
        }
      />
    </article>
  );
}

/** Re-exported so a page that only needs the price words does not import two modules. */
export { ListingPrice };
