import type { ReactNode } from 'react';
import { CARD_HOVER, cx, FOCUS_RING, FOCUS_WITHIN, INTERACTIVE, SURFACE_CARD, SURFACE_CARD_INK, TYPE } from './recipes.js';

export interface CardProps {
  readonly children: ReactNode;
  readonly as?: 'div' | 'article' | 'li' | 'section';
  readonly padding?: 'none' | 'sm' | 'md' | 'lg';
  /** `ink` is the same card on an inverted band. */
  readonly tone?: 'default' | 'ink';
  readonly className?: string;
}

const PADDING = { none: '', sm: 'p-4', md: 'p-5 sm:p-6', lg: 'p-6 sm:p-8' } as const;

/**
 * A surface separated from what is behind it by **value**, not by a drawn rectangle.
 *
 * This is the central correction 0110 makes. 0109 gave every card a 1px `neutral-200` border on all four sides;
 * twenty of those down a grid is a table, and it is why the catalogue read as an internal tool. A card here is
 * white on a recessed band with the faintest lift, so the grid reads as objects resting on a surface. The
 * border survives only for the job it is good at — dividing two regions *inside* one card.
 *
 * `tone="ink"` is the same card on an ink band, where the lift has to come from a top-edge highlight instead:
 * a shadow under a dark object on a dark ground is invisible, and a hairline of white along the top edge is how
 * material actually reads there.
 *
 * {@link LinkCard} is the interactive version.
 */
export function Card({ children, as: Tag = 'div', padding = 'md', tone = 'default', className }: CardProps) {
  return <Tag className={cx(tone === 'ink' ? SURFACE_CARD_INK : SURFACE_CARD, PADDING[padding], className)}>{children}</Tag>;
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
 * typographic, and 0110 makes that a deliberate composition rather than a consolation: the **price is the
 * largest element**, the title is second, and the metadata is a quiet line above both. A marketplace is scanned
 * by price, so setting the price at 28px tabular and the title at 18px is simply the honest hierarchy; 0109 had
 * it the other way round and the card had no focal point at all. When a media field is added to the contract,
 * this is the component that gains it.
 *
 * **The whole card is the target, but only one element is the link.** The anchor is stretched over the card with
 * an absolutely positioned overlay, so a person can click anywhere, while the accessibility tree still sees a
 * single link with the title as its name. The alternative — wrapping everything in one `<a>` — makes a screen
 * reader read the price, the location and the seller as part of the link's name, which is unusable, and it
 * forbids a second link inside the card.
 *
 * **Hover is a small genuine lift.** Two pixels up and one step of elevation, on the product's single shared
 * transition. 0109 moved a border colour instead, on the reasoning that a lifting card makes a grid twitch —
 * which was over-corrected: 2px over 200ms reads as the card responding, and it is the affordance that tells a
 * person the whole tile is clickable. The press nudge is shared with every other control.
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
        INTERACTIVE,
        CARD_HOVER,
        FOCUS_WITHIN,
        className,
      )}
    >
      {children}
      <a
        href={href}
        className="absolute inset-0 z-10 rounded-xl"
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
  /** `large` is for the two-up service grid, where the card has the width to carry it. */
  readonly size?: 'default' | 'large';
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
export function CardTitle({ children, as: Tag = 'h3', size = 'default', lines = 2 }: CardTitleProps) {
  return (
    <Tag
      className={cx(
        size === 'large' ? TYPE.cardTitleLarge : TYPE.cardTitle,
        'text-ink-strong',
        lines === 1 ? 'truncate' : 'line-clamp-2',
        'decoration-edge underline-offset-4 group-hover:underline',
      )}
    >
      {children}
    </Tag>
  );
}

/** A card's body: the padding and the vertical rhythm every catalogue card shares. */
export function CardBody({ children, className }: { readonly children: ReactNode; readonly className?: string }) {
  return <div className={cx('flex flex-1 flex-col gap-2.5 p-5', className)}>{children}</div>;
}

/**
 * A card's footer: the price, the location, whatever anchors the bottom of the unit.
 *
 * Pushed to the bottom with `mt-auto` so every card in a row aligns its price on the same line however long the
 * titles above them ran. In a grid that a person scans by price, that alignment is the difference between
 * comparable and not.
 */
export function CardFooter({ children, className }: { readonly children: ReactNode; readonly className?: string }) {
  return (
    <div className={cx('mt-auto flex items-end justify-between gap-3 px-5 pt-4 pb-5', className)}>{children}</div>
  );
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
