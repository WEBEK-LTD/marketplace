import { Badge, CardFooter, CardOverlayLink, CardTitle, LinkCard, TYPE, cx } from '@repo/ui';
import type { ReactNode } from 'react';
import { formatListingAmount, type ListingPriceLabels } from './listing-price';

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
 *   * **The title**, clamped to two lines so a row keeps its rhythm in both scripts.
 *   * **The price**, bold, `tabular-nums`, and pinned to the bottom of the card by `CardFooter` — so a row of
 *     cards aligns its prices on one line however long the titles above them ran. In a grid that a person scans
 *     by price, that alignment is the difference between comparable and not.
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
}: CatalogCardProps) {
  const amount = formatListingAmount(priceMinor, currencyCode, currencyMinorUnit);
  return (
    <LinkCard
      as="li"
      href={href}
      aria-label={title}
      className="min-h-40"
      {...(listingId === undefined ? {} : { dataListingId: listingId })}
    >
      <div className="flex flex-1 flex-col gap-2 p-4">
        {badge === undefined ? null : (
          <span className="relative z-20 self-start">
            <Badge tone={badge.tone ?? 'neutral'}>{badge.label}</Badge>
          </span>
        )}
        {/* `dir="auto"` on the title: a listing may be written in either script whatever language the page is in. */}
        <CardTitle>
          <span dir="auto">{title}</span>
        </CardTitle>
        {meta === undefined ? null : <div className={TYPE.meta}>{meta}</div>}
      </div>
      <CardFooter>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className={cx(amount === null ? 'text-base font-medium text-neutral-700' : TYPE.price, 'truncate')}>
            {amount ?? labels.contactForPrice}
          </span>
          {isNegotiable === true && amount !== null ? (
            <span className="text-xs text-neutral-600">{labels.negotiable}</span>
          ) : null}
        </span>
        {secondaryLink === undefined ? (
          city === null || city === undefined ? null : (
            <span className="truncate text-sm text-neutral-600">{city}</span>
          )
        ) : (
          <CardOverlayLink href={secondaryLink.href} className="truncate text-sm text-neutral-600">
            {secondaryLink.label}
          </CardOverlayLink>
        )}
      </CardFooter>
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
    <LinkCard as="li" href={href} aria-label={displayName} className="min-h-32">
      <div className="flex flex-1 flex-col gap-2 p-4">
        <div className="flex items-start justify-between gap-3">
          <CardTitle lines={1}>
            <span dir="auto">{displayName}</span>
          </CardTitle>
          {badge === undefined ? null : (
            <span className="relative z-20 shrink-0">
              <Badge tone="solid">{badge}</Badge>
            </span>
          )}
        </div>
        {city === null || city === undefined ? null : <p className={TYPE.meta}>{city}</p>}
        {bio === null || bio === undefined ? null : (
          <p className="line-clamp-3 text-sm leading-normal text-neutral-700" dir="auto">
            {bio}
          </p>
        )}
      </div>
    </LinkCard>
  );
}

export interface CategoryChipProps {
  readonly href: string;
  readonly label: string;
  readonly count?: number;
}

/**
 * A category, as an entry point.
 *
 * A chip rather than a card: a category is a door, not an item, and twenty doors in a card grid would compete
 * with the listings they lead to. They wrap into a dense block instead, which is also how a person scans a
 * category list — by reading across it, not down it.
 */
export function CategoryChip({ href, label, count }: CategoryChipProps) {
  return (
    <li>
      <a
        href={href}
        className={cx(
          'inline-flex items-center gap-2 rounded-full border border-neutral-300 bg-neutral-0 px-4 py-2 text-sm font-medium text-neutral-900',
          'transition-colors duration-150 hover:border-neutral-900 hover:bg-neutral-50',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900',
        )}
      >
        <span dir="auto">{label}</span>
        {count === undefined ? null : <span className="text-xs text-neutral-600 tabular-nums">{count}</span>}
      </a>
    </li>
  );
}
