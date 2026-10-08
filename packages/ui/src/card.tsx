import type { ReactNode } from 'react';
import { cx, FOCUS_RING, SURFACE_CARD, TYPE } from './recipes.js';

export interface CardProps {
  readonly children: ReactNode;
  readonly as?: 'div' | 'article' | 'li' | 'section';
  readonly padding?: 'none' | 'sm' | 'md' | 'lg';
  readonly className?: string;
}

const PADDING = { none: '', sm: 'p-3', md: 'p-4', lg: 'p-6' } as const;

/**
 * A flat surface, separated from the page by a hairline rather than a shadow.
 *
 * That is the system's central structural decision. Identical rounded cards each wearing the same soft grey
 * shadow is the look every generated interface arrives at, and it also flattens hierarchy: when everything is
 * raised, nothing is. Here a border says "this content is a unit" and elevation is saved for the three things
 * that genuinely float — a stuck header, a popover, an overlay.
 *
 * `padding: 'none'` is for a card whose first child is edge-to-edge, which on this product means a listing's
 * media. {@link LinkCard} is the interactive version.
 */
export function Card({ children, as: Tag = 'div', padding = 'md', className }: CardProps) {
  return <Tag className={cx(SURFACE_CARD, PADDING[padding], className)}>{children}</Tag>;
}

export interface LinkCardProps {
  readonly href: string;
  readonly children: ReactNode;
  readonly as?: 'article' | 'li' | 'div';
  readonly className?: string;
  /** Labels the whole card for a screen reader when its visible title is not enough on its own. */
  readonly 'aria-label'?: string;
  /**
   * The listing this card names, for 0101's click beacon, which reads the attribute off the clicked anchor.
   *
   * It has to land on the stretched link rather than on the card, because the beacon listens for clicks on
   * anchors — and the stretched link is the anchor a person actually clicks. One attribute rather than a client
   * component per card: the card stays a server component and a page of fifty results ships one handler.
   */
  readonly dataListingId?: string;
}

/**
 * A card that is entirely one link — the catalogue's unit, and the component the browsing experience rests on.
 *
 * **It carries no image, and that is the data contract rather than an omission.** `ListingSummarySchema` is
 * `.strict()` with eight approved fields and no media among them, because the platform has no media origin to
 * address a picture with yet. A card built around a picture would therefore show a placeholder on every single
 * one, and a grid where nothing has an image does not read as a design — it reads as an outage. So the card is
 * typographic: the title leads, the price anchors, and the space a photograph would have taken goes to making
 * both legible. When a media field is added to the contract this is the component that gains it.
 *
 * **The whole card is the target, but only one element is the link.** The anchor is stretched over the card with
 * an absolutely positioned overlay, so a person can click anywhere, while the accessibility tree still sees a
 * single link with the title as its name. The alternative — wrapping everything in one `<a>` — makes a screen
 * reader read the price, the location and the seller as part of the link's name, which is unusable, and it
 * forbids a second link inside the card.
 *
 * **Hover is a border, not a lift.** The border steps 200 → 400 and the title's underline appears. A card that
 * rises on hover is the default treatment and it makes a grid of twenty of them twitch; moving the border is
 * quieter, reads instantly, and costs no layout. The press nudge is shared with every other control.
 *
 * `focus-within` carries the ring to the whole card, so keyboard navigation of a grid shows the same target the
 * pointer gets.
 */
export function LinkCard({ href, children, as: Tag = 'article', className, dataListingId, ...aria }: LinkCardProps) {
  return (
    <Tag
      className={cx(
        'group relative isolate flex flex-col overflow-hidden',
        SURFACE_CARD,
        'transition-colors duration-150 hover:border-neutral-400',
        'focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-neutral-900',
        className,
      )}
    >
      {children}
      <a
        href={href}
        className="absolute inset-0 z-10 rounded-lg"
        {...(dataListingId === undefined ? {} : { 'data-listing-id': dataListingId })}
        {...aria}
      >
        <span className="sr-only">{aria['aria-label'] ?? ''}</span>
      </a>
    </Tag>
  );
}

export interface CardTitleProps {
  readonly children: ReactNode;
  readonly as?: 'h2' | 'h3' | 'h4';
  /** Lines to show before truncating. Catalogue titles are long and the grid must stay on its rhythm. */
  readonly lines?: 1 | 2;
}

/**
 * A card's title.
 *
 * Clamped rather than left to wrap: listing titles in a marketplace run long and in two scripts, and a grid
 * whose rows are different heights because one title wrapped to four lines reads as broken. Two lines is the
 * default because one is too tight for Arabic, which sets wider than Latin at the same size.
 *
 * The underline appears on the parent {@link LinkCard}'s hover, which is why the decoration classes are
 * `group-hover:` rather than `hover:` — the target is the card, not the text.
 */
export function CardTitle({ children, as: Tag = 'h3', lines = 2 }: CardTitleProps) {
  return (
    <Tag
      className={cx(
        TYPE.cardTitle,
        lines === 1 ? 'truncate' : 'line-clamp-2',
        'group-hover:underline group-hover:decoration-neutral-400 group-hover:underline-offset-2',
      )}
    >
      {children}
    </Tag>
  );
}

/** A card's body: the padding and the vertical rhythm every catalogue card shares. */
export function CardBody({ children, className }: { readonly children: ReactNode; readonly className?: string }) {
  return <div className={cx('flex flex-1 flex-col gap-2 p-4', className)}>{children}</div>;
}

/**
 * A card's footer: the price, the location, whatever anchors the bottom of the unit.
 *
 * Pushed to the bottom with `mt-auto` so every card in a row aligns its price on the same line however long the
 * titles above them ran. In a grid that a person scans by price, that alignment is the difference between
 * comparable and not.
 */
export function CardFooter({ children, className }: { readonly children: ReactNode; readonly className?: string }) {
  return <div className={cx('mt-auto flex items-end justify-between gap-3 px-4 pb-4', className)}>{children}</div>;
}

/**
 * A link that must stay clickable inside a {@link LinkCard}.
 *
 * The card's stretched anchor sits at `z-10`, so anything a person is meant to be able to click separately — a
 * seller's name, a category — has to sit above it. Stated as its own component because "add z-20" is exactly the
 * kind of detail that gets left off the next card someone writes.
 */
export function CardOverlayLink({
  href,
  children,
  className,
}: {
  readonly href: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <a href={href} className={cx('relative z-20 rounded-sm hover:underline hover:underline-offset-2', FOCUS_RING, className)}>
      {children}
    </a>
  );
}
