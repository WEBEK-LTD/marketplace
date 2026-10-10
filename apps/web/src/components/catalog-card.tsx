import { Badge, CardOverlayLink, CardTitle, FOCUS_RING, INTERACTIVE, LinkCard, TYPE, cx } from '@repo/ui';
import type { ReactNode } from 'react';
import { PriceLockup, formatListingAmountParts, type ListingPriceLabels } from './listing-price';

export interface CatalogCardProps {
  readonly href: string;
  readonly title: string;
  /** The seller's city, where the listing names one. */
  readonly city?: string | null;
  readonly priceMinor: string | null;
  readonly currencyCode: string;
  readonly currencyMinorUnit: number;
  /** Null for a service, which is not a negotiable thing. */
  readonly isNegotiable?: boolean | null;
  readonly labels: ListingPriceLabels;
  /** A state the platform is asserting about this item — promoted, verified, no longer available. */
  readonly badge?: { readonly label: string; readonly tone?: 'neutral' | 'solid' | 'outline' };
  /** A second line of facts: a service's delivery time, a listing's condition. */
  readonly meta?: ReactNode;
  /** A separately clickable link inside the card — a seller, a category. */
  readonly secondaryLink?: { readonly href: string; readonly label: string };
  /** The listing's id, for 0101's click beacon. Passed through to the card's own anchor. */
  readonly listingId?: string;
  /**
   * `wide` is the two-up variant the services grid uses.
   *
   * The two catalogues are deliberately not the same shape. A service carries facts a product does not — a
   * delivery time, a revision count — and a wider card lets those be read rather than truncated. That is the
   * "clearly differentiated marketplace sections" the design asks for, done with composition rather than with
   * a different colour.
   */
  readonly size?: 'default' | 'wide';
}

/**
 * One item in the catalogue — **the single card every browsing surface renders.**
 *
 * The home page, the marketplace landing, the listings and services lists, a category's feed and the search
 * results all use this one component. That is the whole mechanism by which a card looks the same wherever a
 * person meets it: before 0109 the home page drew its own card, the listings list drew another, and services
 * drew a third, so the same listing looked like three different products depending on the route that showed it.
 *
 * **It is typographic, with no image.** `ListingSummarySchema` is `.strict()` and carries eight fields, none of
 * them media — the platform has no media origin to address a picture with. So the layout spends its space on the
 * two things a person actually compares across a grid:
 *
 *   * **The price**, which 0110 makes the largest element on the card. A marketplace is scanned by price, so
 *     that is the honest hierarchy; 0109 set the price at 18px under an 18px title and the card had no focal
 *     point, which is most of why the catalogue read as rows of identical boxes. It is pinned to the bottom of
 *     the card so a row aligns its prices on one line however long the titles above them ran, and set in
 *     tabular figures so they align on their digits.
 *   * **The title**, second, clamped to two lines so a row keeps its rhythm in both scripts.
 *   * **A quiet line of metadata above both** — the city, a state badge — rather than a middle-dot string
 *     beneath them. Putting it first gives the card a top edge that is not its own border.
 *
 * The price words come from the `Listings` namespace, which is where they already lived, so a card on the front
 * page reads exactly as the same card reads on the browse list — including "contact for price" where there is no
 * amount, rather than a zero.
 */
export function CatalogCard({
  href,
  title,
  city,
  priceMinor,
  currencyCode,
  currencyMinorUnit,
  isNegotiable,
  labels,
  badge,
  meta,
  secondaryLink,
  listingId,
  size = 'default',
}: CatalogCardProps) {
  const priced = formatListingAmountParts(priceMinor, currencyCode, currencyMinorUnit) !== null;
  const place =
    secondaryLink !== undefined ? (
      <CardOverlayLink href={secondaryLink.href} className={cx('truncate', TYPE.metaSmall)}>
        {secondaryLink.label}
      </CardOverlayLink>
    ) : city === null || city === undefined ? null : (
      <span className={cx('truncate', TYPE.metaSmall)}>{city}</span>
    );

  return (
    <LinkCard
      as="li"
      href={href}
      aria-label={title}
      className={size === 'wide' ? 'min-h-48' : 'min-h-44'}
      {...(listingId === undefined ? {} : { dataListingId: listingId })}
    >
      {/*
        **The price band.** A marketplace card without a photograph has one thing a person's eye can land on,
        and it should be the number they came to compare — so the price is given its own tinted region at the
        head of the card rather than a line at the foot of it. That is the composition this revision turns on:
        a grid of these reads as a run of priced objects, where a grid of white tiles with a price line reads
        as a table. The tint deepens under the pointer, which is also the card's hover state.
      */}
      <div
        className={cx(
          'relative bg-surface-sunken transition-colors duration-200 group-hover:bg-surface-brand-soft',
          size === 'wide' ? 'px-6 pt-6 pb-5' : 'px-5 pt-5 pb-4',
        )}
      >
        {/*
          The price alone on this line. "Negotiable" shared it at first and was the thing that got clipped
          when a price ran to six figures — the longest price and the longest qualifier competing for one
          row. It belongs with the other facts about the listing, at the foot.
        */}
        <PriceLockup
          priceMinor={priceMinor}
          currencyCode={currencyCode}
          currencyMinorUnit={currencyMinorUnit}
          labels={labels}
        />
      </div>

      <div className={cx('flex flex-1 flex-col', size === 'wide' ? 'gap-3 p-6' : 'gap-2.5 p-5')}>
        {/* `dir="auto"` on the title: a listing may be written in either script whatever language the page is in. */}
        <CardTitle size={size === 'wide' ? 'large' : 'default'}>
          <span dir="auto">{title}</span>
        </CardTitle>
        {meta === undefined ? null : <div className={cx(TYPE.metaSmall)}>{meta}</div>}

        {/*
          The foot: where the thing is, and anything the platform is asserting about it. Pushed down by
          `mt-auto`, so a row of cards aligns on this line however long the titles above them ran.
        */}
        {place === null && badge === undefined && !(isNegotiable === true && priced) ? null : (
          <div className="mt-auto flex items-center justify-between gap-2 pt-3">
            {place}
            <span className="flex shrink-0 items-center gap-2">
              {isNegotiable === true && priced ? (
                <span className={cx('font-medium text-ink-brand', TYPE.metaSmall)}>{labels.negotiable}</span>
              ) : null}
              {badge === undefined ? null : (
                <span className="relative z-20">
                  <Badge tone={badge.tone ?? 'neutral'}>{badge.label}</Badge>
                </span>
              )}
            </span>
          </div>
        )}
      </div>
    </LinkCard>
  );
}

export interface SellerCardProps {
  readonly href: string;
  readonly displayName: string;
  readonly city?: string | null;
  readonly bio?: string | null;
  readonly badge?: string;
}

/**
 * A seller, as a card.
 *
 * The avatar is deliberately absent: the public seller contract carries no image either, and a column of
 * identical initial-chips beside identical names adds nothing a person can use. The name leads, the city places
 * it, and the bio — the only thing that distinguishes one seller from another at this size — gets the room.
 */
export function SellerCard({ href, displayName, city, bio, badge }: SellerCardProps) {
  return (
    <LinkCard as="li" href={href} aria-label={displayName} className="min-h-44">
      <div className="flex flex-1 flex-col gap-3 p-6">
        <div className="flex items-start justify-between gap-3">
          {city === null || city === undefined ? <span /> : <span className={TYPE.metaSmall}>{city}</span>}
          {badge === undefined ? null : (
            <span className="relative z-20 shrink-0">
              <Badge tone="solid">{badge}</Badge>
            </span>
          )}
        </div>
        <CardTitle size="large" lines={1}>
          <span dir="auto">{displayName}</span>
        </CardTitle>
        {bio === null || bio === undefined ? null : (
          <p className={cx('line-clamp-3', TYPE.meta)} dir="auto">
            {bio}
          </p>
        )}
      </div>
    </LinkCard>
  );
}

export interface CategoryTileProps {
  readonly href: string;
  readonly label: string;
  readonly count?: number;
  /** The first tile in a mosaic spans two columns, which is what gives the block a composition. */
  readonly wide?: boolean;
}

/**
 * A category, as a door.
 *
 * **A tile, not a chip.** 0109 drew categories as a wrapped row of 32px pills, which read as leftover form
 * controls and gave the most important navigation on the home page less presence than a button. A tile is big
 * enough to aim at on a phone, big enough to carry a count, and — because the first one in a mosaic spans two
 * columns — produces a block with a composition rather than a uniform rhythm.
 *
 * The chevron is drawn from two logical borders rather than typed as an arrow character, so it points the way
 * the page reads in both scripts and no label ends with "→", which is the commonest piece of template chrome
 * there is.
 */
export function CategoryTile({ href, label, count, wide = false }: CategoryTileProps) {
  return (
    <li className={wide ? 'col-span-2' : ''}>
      <a
        href={href}
        className={cx(
          'group relative flex h-full min-h-28 flex-col justify-between gap-4 overflow-hidden rounded-xl p-5 sm:min-h-32 sm:p-6',
          // Inverts under the pointer rather than nudging a border. A category is a destination, and a tile
          // that commits to the brand when you aim at it says so far better than a grey hover does.
          'bg-surface-raised ring-1 ring-edge-brand hover:bg-surface-ink hover:ring-transparent',
          INTERACTIVE,
          FOCUS_RING,
        )}
      >
        <span className="flex items-start justify-between gap-3">
          <span
            className={cx(
              'font-medium text-ink-strong transition-colors duration-200 group-hover:text-on-ink',
              wide ? 'text-lg sm:text-xl' : 'text-base sm:text-lg',
            )}
            dir="auto"
          >
            {label}
          </span>
          <span
            aria-hidden="true"
            className="mt-1.5 size-2 shrink-0 -rotate-45 rtl:rotate-45 border-e-2 border-b-2 border-edge-brand transition-all duration-200 group-hover:translate-x-0.5 group-hover:border-accent-400 rtl:group-hover:-translate-x-0.5"
          />
        </span>
        {count === undefined ? null : (
          <span className={cx('tabular-nums transition-colors duration-200 group-hover:text-on-ink-muted', TYPE.metaSmall)}>
            {count}
          </span>
        )}
      </a>
    </li>
  );
}
