import { cx, FOCUS_RING } from './recipes.js';

export interface BreadcrumbItem {
  readonly label: string;
  /** Absent on the last item: a person is already there, so it is not a link. */
  readonly href?: string;
}

export interface BreadcrumbProps {
  readonly items: readonly BreadcrumbItem[];
  /** "Breadcrumb" in the reader's language. */
  readonly label: string;
  readonly className?: string;
}

/**
 * Where a page sits in the catalogue.
 *
 * **The separator is a chevron drawn from borders, not a "/" or a "·".** Two reasons, and the second is the one
 * that matters: a slash and a middle dot both have to be flipped by hand in Arabic or they point the wrong way,
 * and a meta string joined with middle dots is a design cliché this product avoids elsewhere too. A rotated
 * border mirrors automatically with the writing direction, because `border-e` is a logical edge.
 *
 * Separators are `aria-hidden` and the list is an ordered list, so a screen reader hears the trail as a
 * structured list rather than as "Home slash Electronics slash Phones". The current page is marked with
 * `aria-current="page"` and is not a link.
 *
 * Scrolls rather than wraps on a narrow viewport: a two-line breadcrumb pushes the page's title down and is the
 * first thing to look broken on a phone.
 */
export function Breadcrumb({ items, label, className }: BreadcrumbProps) {
  return (
    <nav aria-label={label} className={cx('w-full', className)}>
      <ol className="flex items-center gap-1.5 overflow-x-auto text-sm whitespace-nowrap">
        {items.map((item, index) => {
          const last = index === items.length - 1;
          return (
            <li key={`${item.label}-${index}`} className="flex shrink-0 items-center gap-1.5">
              {index > 0 ? (
                <span
                  aria-hidden="true"
                  className="size-1.5 shrink-0 -rotate-45 border-e border-b border-neutral-400 rtl:rotate-135"
                />
              ) : null}
              {last || item.href === undefined ? (
                <span aria-current="page" className="font-medium text-neutral-900">
                  {item.label}
                </span>
              ) : (
                <a
                  href={item.href}
                  className={cx('rounded-sm text-neutral-600 hover:text-neutral-900 hover:underline hover:underline-offset-2', FOCUS_RING)}
                >
                  {item.label}
                </a>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
