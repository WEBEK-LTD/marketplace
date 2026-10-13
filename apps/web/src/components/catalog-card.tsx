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
  /**
   * The item's photograph, where the surface rendering this card has one (0112).
   *
   * **It is a slot rather than a `src`,** and it is deliberately empty today. `public.listing_media` and
   * `public.media_variants` have existed since 0011, but no public contract field, reader or upload surface
   * addresses them yet, so no caller can pass anything here. The slot exists so that the component the whole
   * catalogue is built from already has the right shape when that increment lands — the composition below is
   * laid out around a 4:3 region at the head of the card, and gaining one later will not be a redesign.
   *
   * **Nothing is passed in the meantime, and nothing stands in for it.** A grey rectangle on every card in a
   * grid of twenty does not read as a card waiting for a photograph; it reads as an outage, which is why the
   * card renders without the region at all when the slot is empty.
   */
  readonly media?: ReactNode;
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
 * **0112 reorders it for property, and that reversal is the point of this revision.** 0110 made the price the
 * largest element on the card and put it in a tinted band at the *head*, on the reasoning that a marketplace is
 * scanned by price. That is true of a marketplace selling typewriters. It is not true of property: nobody
 * shortlists a flat by its price before knowing where it is, and a column of cards that announce "EGP 2,750,000"
 * before saying "Maadi" is answering the second question first. So the card now reads in the order a buyer
 * actually reads one:
 *
 *   * **The media region**, where there is one — see the `media` slot, which is empty until the listing-media
 *     contract lands.
 *   * **Where it is**, as a quiet line, because for property that is the first filter a person applies.
 *   * **The title**, clamped to two lines so a row keeps its rhythm in both scripts, at the larger step: it is
 *     now the strongest *typographic* element on a card that has no photograph.
 *   * **The price, in a tinted well at the foot.** Still prominent, still tabular so a row aligns on its digits,
 *     and still pinned to the bottom so the prices in a row sit on one line however long the titles above them
 *     ran — but reading as the card's closing fact rather than as its headline. The tint moved from the head to
 *     the foot with it, which is also what gives the card a base rather than a cap.
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
  media,
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
      /*
        No minimum height. A card used to need one because its content was a price band and a title, and a row
        of them without it looked ragged; now the grid's own `stretch` makes every card in a row the height of
        the tallest, and the price foot is pinned to the bottom by `mt-auto`. The minimum was adding empty space
        in the middle of every card instead — which is what the screenshots showed.
      */
      {...(listingId === undefined ? {} : { dataListingId: listingId })}
    >
      {/*
        The media region, where the surface passed one. Absent today — see the `media` prop — and absent rather
        than filled with a placeholder, because twenty identical grey rectangles down a grid read as a failure
        and not as a design. `4/3` is the ratio a property photograph is shot and cropped to.
      */}
      {media === undefined ? null : (
        <div className="relative aspect-[4/3] w-full overflow-hidden bg-surface-muted">{media}</div>
      )}

      <div className={cx('flex flex-1 flex-col', size === 'wide' ? 'gap-3 p-6' : 'gap-2.5 p-5')}>
        {/*
          Where it is, first. For property this is the filter a person applies before any other, which is why it
          leads rather than sitting at the foot as it did before 0112. It also gives the card a top edge that is
          not its own border.
        */}
        {place === null && badge === undefined ? null : (
          <div className="flex items-center justify-between gap-2">
            {place ?? <span />}
            {badge === undefined ? null : (
              <span className="relative z-20 shrink-0">
                <Badge tone={badge.tone ?? 'neutral'}>{badge.label}</Badge>
              </span>
            )}
          </div>
        )}

        {/* `dir="auto"` on the title: a listing may be written in either script whatever language the page is in. */}
        <CardTitle size="large">
          <span dir="auto">{title}</span>
        </CardTitle>
        {meta === undefined ? null : <div className={cx(TYPE.metaSmall)}>{meta}</div>}
      </div>

      {/*
        **The price foot.** A tinted well across the base of the card, pushed to the bottom by `mt-auto` so a
        row of cards aligns its prices on one line however long the titles above them ran. The tint sat at the
        head of the card until 0112 and made the price the card's headline; at the foot it reads as the closing
        fact and gives the card a base. It deepens under the pointer, which is also the card's hover state.

        "Negotiable" sits beside the figure rather than under it, and only where there is a figure for it to
        qualify — it shared a line with the price once and was the thing that got clipped at six digits.
      */}
      <div
        className={cx(
          /*
            `flex-wrap`, because a 275px card is a real width. On the category page the grid shares its row
            with the filter panel, and there "EGP 24,000,000.00" and "Negotiable" did not fit on one line —
            the screenshot showed the qualifier clipped to "Negc". Wrapping drops it under the figure instead
            of cutting it off; the price is never the thing that moves.
          */
          'relative mt-auto flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-t border-hairline',
          'bg-surface-sunken transition-colors duration-200 group-hover:bg-surface-brand-soft',
          size === 'wide' ? 'px-6 py-5' : 'px-5 py-4',
        )}
      >
        <PriceLockup
          priceMinor={priceMinor}
          currencyCode={currencyCode}
          currencyMinorUnit={currencyMinorUnit}
          labels={labels}
        />
        {isNegotiable === true && priced ? (
          <span className={cx('shrink-0 font-medium text-ink-brand', TYPE.metaSmall)}>{labels.negotiable}</span>
        ) : null}
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

export interface CategoryRowProps {
  readonly href: string;
  readonly label: string;
  readonly count?: number;
}

/**
 * A category, as a row in an index (0112).
 *
 * **This replaced a tile, and the tile was the thing the owner rejected twice.** 0109 drew categories as 32px
 * pills; 0110 corrected those into tiles, which was better and still produced the exact figure the brief calls
 * out — eight identical white rectangles in a four-by-two grid, each with a chevron, no counts, nothing to tell
 * one from another but the word inside it. A grid of boxes whose only content is a word is a grid that spends
 * all of its space on the boxes.
 *
 * So the block is an index instead: full-width rows, the name set large, a hairline between them, two columns on
 * a wide viewport. The same eight names now carry twice the type size and none of the furniture, and the block
 * reads as a directory somebody composed rather than as a row of empty cards. It is also the shape that survives
 * an odd number of categories, which the mosaic variant did not — a ragged last row of boxes looks broken, a
 * last row of one list item looks like a list.
 *
 * **No icon.** `HomepageCategoryCardSchema` carries an `icon` string, but it is an operator-entered identifier
 * with no icon set behind it anywhere in this application, so rendering it would mean either inventing a set of
 * drawings or printing a slug where a picture should be. The type size is doing that work instead.
 *
 * The chevron is drawn from two logical borders rather than typed as an arrow character, so it points the way
 * the page reads in both scripts and no label ends with "→", which is the commonest piece of template chrome
 * there is.
 */
export function CategoryRow({ href, label, count }: CategoryRowProps) {
  return (
    <li className="border-b border-hairline">
      <a
        href={href}
        className={cx(
          'group flex items-center justify-between gap-4 py-5 ps-1 pe-2 sm:py-6',
          'hover:ps-3',
          INTERACTIVE,
          FOCUS_RING,
        )}
      >
        <span className="flex min-w-0 items-baseline gap-3">
          <span
            className="truncate text-lg font-medium text-ink-strong transition-colors duration-200 group-hover:text-ink-brand sm:text-xl"
            dir="auto"
          >
            {label}
          </span>
          {count === undefined ? null : (
            <span className={cx('shrink-0 tabular-nums', TYPE.metaSmall)}>{count}</span>
          )}
        </span>
        <span
          aria-hidden="true"
          className="size-2 shrink-0 -rotate-45 rtl:rotate-45 border-e-2 border-b-2 border-edge-brand transition-transform duration-200 group-hover:translate-x-1 rtl:group-hover:-translate-x-1"
        />
      </a>
    </li>
  );
}
