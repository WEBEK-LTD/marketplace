import type { ReactNode } from 'react';
import { cx, FOCUS_RING } from './recipes.js';

export interface TabItem {
  readonly href: string;
  readonly label: string;
  readonly current: boolean;
  /** A count beside the label — results, messages, open requests. */
  readonly count?: number;
}

export interface TabsProps {
  readonly items: readonly TabItem[];
  /** Names the set for a screen reader: "Catalogue surfaces", "Account sections". */
  readonly label: string;
  readonly className?: string;
}

/**
 * A set of sibling surfaces, as links.
 *
 * **Links, not buttons with state**, because in this product every tab is a different address: products and
 * services are separate catalogue routes, an account's sections are separate pages. Making them links means they
 * are shareable, they work without JavaScript, the browser's back button does what a person expects, and the
 * current one can be marked server-side with `aria-current` — which is the correct semantic for navigation, where
 * `role="tab"` would be a lie about a widget that is not there.
 *
 * The selected tab is marked by a 2px border on the block edge and a weight change, not by colour. Both matter:
 * the weight survives a monochrome palette, and the border gives the set an obvious baseline that the row sits on.
 *
 * Horizontally scrollable on a narrow viewport rather than wrapped, so the row never becomes two rows and shift
 * the content under it. The scrollbar is left visible — hiding it is how a person fails to discover there is more.
 */
export function Tabs({ items, label, className }: TabsProps) {
  return (
    <nav aria-label={label} className={cx('border-b border-neutral-200', className)}>
      <ul className="-mb-px flex gap-1 overflow-x-auto">
        {items.map((item) => (
          <li key={item.href} className="shrink-0">
            <a
              href={item.href}
              aria-current={item.current ? 'page' : undefined}
              className={cx(
                'inline-flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm whitespace-nowrap transition-colors duration-150',
                FOCUS_RING,
                item.current
                  ? 'border-neutral-900 font-semibold text-neutral-900'
                  : 'border-transparent font-medium text-neutral-600 hover:border-neutral-300 hover:text-neutral-900',
              )}
            >
              {item.label}
              {item.count === undefined ? null : (
                <span
                  className={cx(
                    'rounded-full px-1.5 py-0.5 text-xs tabular-nums',
                    item.current ? 'bg-neutral-900 text-neutral-0' : 'bg-neutral-100 text-neutral-600',
                  )}
                >
                  {item.count}
                </span>
              )}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * A segmented control: two or three mutually exclusive views of the same data, as links.
 *
 * Distinct from {@link Tabs} by shape and by job. Tabs are the page's primary navigation and sit on a baseline;
 * a segmented control is a small inline switch — grid or list, open or closed — and sits in a recessed well so it
 * reads as one object rather than as separate links.
 */
export function SegmentedLinks({ items, label }: { readonly items: readonly TabItem[]; readonly label: string }) {
  return (
    <nav aria-label={label} className="inline-flex rounded-md border border-neutral-200 bg-neutral-50 p-0.5">
      {items.map((item) => (
        <a
          key={item.href}
          href={item.href}
          aria-current={item.current ? 'page' : undefined}
          className={cx(
            'rounded-sm px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors duration-150',
            FOCUS_RING,
            item.current
              ? 'border border-neutral-300 bg-neutral-0 text-neutral-900'
              : 'border border-transparent text-neutral-600 hover:text-neutral-900',
          )}
        >
          {item.label}
        </a>
      ))}
    </nav>
  );
}

/** A tab panel's wrapper, for the spacing below the row. */
export function TabPanel({ children }: { readonly children: ReactNode }) {
  return <div className="pt-6">{children}</div>;
}
