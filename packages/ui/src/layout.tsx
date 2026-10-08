import type { ReactNode } from 'react';
import { cx, TYPE } from './recipes.js';

export interface SectionProps {
  readonly children: ReactNode;
  /** The vertical rhythm between the page's bands. */
  readonly space?: 'sm' | 'md' | 'lg';
  readonly as?: 'section' | 'div';
  readonly className?: string;
  readonly id?: string;
  readonly 'aria-labelledby'?: string;
}

/**
 * One band of a page, with the product's vertical rhythm.
 *
 * Three steps, used consistently: `sm` inside a panel, `md` between a page's sections, `lg` between the major
 * bands of the home page. The point of naming them is that a page's spacing then comes from a decision about
 * what kind of break it is, rather than from whichever margin someone reached for — which is how a site ends up
 * with eleven different gaps and no rhythm.
 */
export function Section({ children, space = 'md', as: Tag = 'section', className, id, ...aria }: SectionProps) {
  const SPACE = { sm: 'py-6', md: 'py-8 sm:py-10', lg: 'py-10 sm:py-14' } as const;
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
  readonly id?: string;
  readonly className?: string;
}

/**
 * A section's title, its one line of context, and the link to the whole of it.
 *
 * **There is no eyebrow label.** A small tracked-out word above every heading is the single most recognisable
 * piece of template chrome, and in Arabic — which has no letter case — it would be a size change with no meaning
 * at all. The heading is the heading.
 *
 * The action sits on the inline-end edge on wide viewports and drops under the title on narrow ones, rather than
 * being squeezed beside it; a truncated "View all products" is worse than one on its own line.
 */
export function SectionHeader({ title, description, action, as: Tag = 'h2', id, className }: SectionHeaderProps) {
  const SIZES = { h1: TYPE.h1, h2: TYPE.h2, h3: TYPE.h3 } as const;
  return (
    <div className={cx('flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between', className)}>
      <div className="space-y-1.5">
        <Tag id={id} className={SIZES[Tag]}>
          {title}
        </Tag>
        {description === undefined ? null : <p className={cx(TYPE.body, 'max-w-prose')}>{description}</p>}
      </div>
      {action === undefined ? null : <div className="shrink-0">{action}</div>}
    </div>
  );
}

/**
 * The catalogue grid.
 *
 * One definition of the column counts, used by the listing grid, the service grid, the seller's own listings and
 * every skeleton that stands in for them — which is what stops a service page from being three columns where the
 * products page is four. Four columns at `xl` keeps a card wide enough for a two-line title in Arabic.
 */
export function CardGrid({ children, className }: { readonly children: ReactNode; readonly className?: string }) {
  return (
    <ul className={cx('grid list-none grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4', className)}>
      {children}
    </ul>
  );
}

/**
 * A detail page: the content, and an aside that sticks.
 *
 * The aside holds the thing a person came to act on — a price, a seller, a contact button — and stays in view
 * while they read down a long description. It is `position: sticky` only from `lg`, because on a phone a sticky
 * panel would eat a third of the viewport; there it simply sits first in the source order instead, which is also
 * the right reading order.
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
    <div className={cx('grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-10', className)}>
      <div className="min-w-0 order-2 lg:order-1">{main}</div>
      <aside className="order-1 lg:order-2 lg:sticky lg:top-24 lg:self-start">{aside}</aside>
    </div>
  );
}

/**
 * A label and its value, as a description list.
 *
 * A real `<dl>` rather than two spans joined by a middle dot. The dot pattern — "Cairo · 3 days ago · Used" —
 * is both a design cliché and a loss of structure: a screen reader reads it as one run of text, and the
 * separators have to be mirrored by hand in Arabic. Here the relationship is in the markup, so assistive
 * technology announces "Condition, used", and the layout mirrors itself.
 */
export function DetailList({ items, className }: { readonly items: readonly { readonly label: string; readonly value: ReactNode }[]; readonly className?: string }) {
  return (
    <dl className={cx('grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2', className)}>
      {items.map((item) => (
        <div key={item.label} className="flex flex-col gap-0.5 border-b border-neutral-100 pb-2">
          <dt className="text-sm text-neutral-600">{item.label}</dt>
          <dd className="text-sm font-medium text-neutral-900">{item.value}</dd>
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
export function MetaRow({ items, className }: { readonly items: readonly { readonly label: string; readonly value: ReactNode }[]; readonly className?: string }) {
  return (
    <dl className={cx('flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-neutral-600', className)}>
      {items.map((item) => (
        <div key={item.label} className="flex items-center gap-1.5">
          <dt className="sr-only">{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
