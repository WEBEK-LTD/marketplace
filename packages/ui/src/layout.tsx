import type { ReactNode } from 'react';
import { ACCENT_BAR, BAND, BAND_SPACE, cx, TYPE, type BandTone } from './recipes.js';

export interface BandProps {
  readonly children: ReactNode;
  /** Which of the three page surfaces this band is. */
  readonly tone?: BandTone;
  /** The band's vertical rhythm. */
  readonly space?: keyof typeof BAND_SPACE;
  readonly as?: 'section' | 'div' | 'header' | 'footer';
  readonly className?: string;
  readonly id?: string;
  readonly 'aria-labelledby'?: string;
}

/**
 * A full-bleed horizontal band — the unit a public page is composed from (0110).
 *
 * This is the change that most separates the redesign from what it replaced. 0109 built a page as a column of
 * sections separated by hairlines, all on the same white, which is the shape of a document rather than of a
 * product. Here a page is a stack of bands that alternate between the canvas, a recessed surface and ink, so
 * the eye is given a structure before it reads a word.
 *
 * The band reaches both edges of the viewport while its content stays on the page's measure. That is done by
 * `.mp-band` in `globals.css` rather than by nesting a second container in every section, because the margin
 * trick needs `dvw` arithmetic that no utility expresses — and because a page with two wrapper elements per
 * section is how a layout becomes impossible to change later.
 */
export function Band({ children, tone = 'canvas', space = 'normal', as: Tag = 'section', className, id, ...aria }: BandProps) {
  return (
    <Tag id={id} className={cx('mp-band', BAND[tone], BAND_SPACE[space], className)} {...aria}>
      {children}
    </Tag>
  );
}

export interface SectionProps {
  readonly children: ReactNode;
  /** The vertical rhythm between the page's sections. */
  readonly space?: 'sm' | 'md' | 'lg';
  readonly as?: 'section' | 'div';
  readonly className?: string;
  readonly id?: string;
  readonly 'aria-labelledby'?: string;
}

/**
 * A section *within* a band, for the inner rhythm of a page that is not banded — a detail page, an account
 * surface. Pages that are composed of bands use {@link Band} instead.
 */
export function Section({ children, space = 'md', as: Tag = 'section', className, id, ...aria }: SectionProps) {
  const SPACE = { sm: 'py-8', md: 'py-10 sm:py-14', lg: 'py-14 sm:py-20' } as const;
  return (
    <Tag id={id} className={cx(SPACE[space], className)} {...aria}>
      {children}
    </Tag>
  );
}

export interface SectionHeaderProps {
  readonly title: string;
  /** One line of context under the title. */
  readonly description?: string;
  /** A link to the full surface this section is a window onto. */
  readonly action?: ReactNode;
  readonly as?: 'h1' | 'h2' | 'h3';
  /** On an ink band the text roles invert. */
  readonly tone?: 'default' | 'ink';
  readonly id?: string;
  readonly className?: string;
}

/**
 * A section's title, its line of context, and the link to the whole of it.
 *
 * **The accent rule is the one piece of ornament in the product**, and it earns its place by doing a job no
 * amount of spacing does: it marks where a section begins, so a band of content has a visible top edge rather
 * than starting wherever the text happens to.
 *
 * It is a hairline across the full measure with a short heavier segment at the inline start, which is a
 * different thing from the floating 40px dash this started as — that read as a stray hyphen above the heading.
 * The segment is filled with the brand accent: a neutral tick today, the brand the day two colours are
 * supplied. Both parts are positioned logically, so the segment sits at the right-hand end in Arabic without a
 * second rule.
 *
 * **There is still no tracked-out capitalised eyebrow.** It is the commonest piece of template chrome there is,
 * and Arabic has no letter case, so an `uppercase` utility changes nothing in half the product's pages and the
 * two languages immediately stop matching. Where a section needs a word above its title, `TYPE.eyebrow` sets it
 * in sentence case at the muted role.
 *
 * The action drops under the title on narrow viewports rather than being squeezed beside it; a truncated "View
 * all products" is worse than one on its own line.
 */
export function SectionHeader({
  title,
  description,
  action,
  as: Tag = 'h2',
  tone = 'default',
  id,
  className,
}: SectionHeaderProps) {
  const SIZES = { h1: TYPE.h1, h2: TYPE.h2, h3: TYPE.h3 } as const;
  const ink = tone === 'ink';
  return (
    <div className={className}>
      <span
        aria-hidden="true"
        className={cx('relative block h-px w-full', ink ? 'bg-edge-on-ink' : 'bg-edge')}
      >
        <span
          className={cx('absolute inset-y-[-1px] start-0 block w-16 rounded-full', ink ? 'bg-on-ink' : ACCENT_BAR)}
        />
      </span>
      <div className="flex flex-col gap-4 pt-6 sm:flex-row sm:items-end sm:justify-between sm:gap-8">
        <div className="min-w-0 space-y-3">
          <Tag id={id} className={cx(SIZES[Tag], ink ? 'text-on-ink' : 'text-ink-strong')}>
            {title}
          </Tag>
          {description === undefined ? null : (
            <p className={cx('max-w-prose', ink ? 'text-base leading-normal text-on-ink-muted' : TYPE.body)}>
              {description}
            </p>
          )}
        </div>
        {action === undefined ? null : <div className="shrink-0">{action}</div>}
      </div>
    </div>
  );
}

/**
 * The catalogue grid.
 *
 * One definition of the column counts, used by the listing grid, the service grid, the seller's own listings and
 * every skeleton that stands in for them — which is what stops a service page being three columns where the
 * products page is four.
 *
 * `wide` is the two-up variant, and it exists so that the two catalogues do not look like the same catalogue.
 * A service carries facts a product does not — a delivery time, a revision count — and giving it a wider card
 * lets those be read rather than truncated. That difference is deliberate composition, not inconsistency.
 */
export function CardGrid({
  children,
  variant = 'compact',
  className,
}: {
  readonly children: ReactNode;
  readonly variant?: 'compact' | 'wide';
  readonly className?: string;
}) {
  return (
    <ul
      className={cx(
        'grid list-none grid-cols-1 gap-4 sm:gap-5',
        variant === 'wide' ? 'sm:grid-cols-2' : 'sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4',
        className,
      )}
    >
      {children}
    </ul>
  );
}

/**
 * A detail page: the content, and an aside that sticks.
 *
 * The aside holds the thing a person came to act on — the price, the seller, the contact button — and stays in
 * view while they read down a long description. It is `position: sticky` only from `lg`, because on a phone a
 * sticky panel would eat a third of the viewport; there it simply sits first in the source order instead, which
 * is also the right reading order: a buyer on a phone wants the price before the paragraph.
 */
export function DetailLayout({
  main,
  aside,
  className,
}: {
  readonly main: ReactNode;
  readonly aside: ReactNode;
  readonly className?: string;
}) {
  return (
    <div className={cx('grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-16', className)}>
      <div className="order-2 min-w-0 lg:order-1">{main}</div>
      <aside className="order-1 lg:sticky lg:top-24 lg:order-2 lg:self-start">{aside}</aside>
    </div>
  );
}

/**
 * A label and its value, as a description list.
 *
 * A real `<dl>` rather than two spans joined by a middle dot. The dot pattern — "Cairo · 3 days ago · Used" — is
 * both a design cliché and a loss of structure: a screen reader reads it as one run of text, and the separators
 * have to be mirrored by hand in Arabic. Here the relationship is in the markup, so assistive technology
 * announces "Condition, used", and the layout mirrors itself.
 *
 * Rows are separated by a hairline rather than boxed, which is the one job a border in this system is good at:
 * dividing two regions inside a single surface.
 */
export function DetailList({
  items,
  className,
}: {
  readonly items: readonly { readonly label: string; readonly value: ReactNode }[];
  readonly className?: string;
}) {
  return (
    <dl className={cx('grid grid-cols-1 gap-x-10 sm:grid-cols-2', className)}>
      {items.map((item) => (
        <div key={item.label} className="flex items-baseline justify-between gap-4 border-b border-hairline py-3">
          <dt className={TYPE.meta}>{item.label}</dt>
          <dd className="text-end text-sm font-medium text-ink-strong">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Secondary facts about an item, as a row that stays structured.
 *
 * Same reasoning as {@link DetailList}, in the compact form a card needs: the pairs are visually a row of meta,
 * but they are still a description list underneath, so neither the mirroring nor the semantics depend on a
 * punctuation character.
 */
export function MetaRow({
  items,
  className,
}: {
  readonly items: readonly { readonly label: string; readonly value: ReactNode }[];
  readonly className?: string;
}) {
  return (
    <dl className={cx('flex flex-wrap items-center gap-x-4 gap-y-1', TYPE.metaSmall, className)}>
      {items.map((item) => (
        <div key={item.label} className="flex items-center gap-1.5">
          <dt className="sr-only">{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
