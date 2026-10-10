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
 * **The RTL rotation is `+45`, and the arithmetic is worth writing down** — it was got wrong twice before a
 * screenshot settled it. Measuring clockwise from "up": in LTR `border-e` is the right edge, so the corner
 * bisects at 135° and `-rotate-45` lands on 90°, pointing inline-end. In RTL `border-e` is the *left* edge, so
 * the same corner bisects at 225°; `-rotate-45` lands on 180° (straight down) and `rotate-135` on 360°
 * (straight up). The inline-end direction there is 270°, which is `+45`. So the glyph needs both a base
 * rotation and an RTL one, and neither is the mirror of the other.
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
                  className="size-1.5 shrink-0 -rotate-45 rtl:rotate-45 border-e border-b border-edge"
                />
              ) : null}
              {last || item.href === undefined ? (
                <span aria-current="page" className="font-medium text-ink-strong">
                  {item.label}
                </span>
              ) : (
                <a
                  href={item.href}
                  className={cx('rounded-sm text-ink-muted hover:text-ink-strong hover:underline hover:underline-offset-2', FOCUS_RING)}
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
