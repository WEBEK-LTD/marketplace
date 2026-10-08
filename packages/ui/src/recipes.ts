/**
 * The visual grammar, in one place (0109).
 *
 * Every primitive in this package composes its classes from these constants, and the applications use them for
 * the handful of one-off surfaces a primitive would be overkill for. That is the whole mechanism by which the
 * product looks like one product: a focus ring is defined once, so it cannot be 2px here and 1px there, and a
 * card's radius is defined once, so it cannot drift from a dialog's.
 *
 * **The palette is monochrome.** The two brand colours are owner-supplied placeholders and both are currently
 * grey (D5), so nothing here may lean on hue to carry meaning. Hierarchy comes from four devices instead:
 *
 *   * **Weight and size** — a price is bold where a title is semibold and a label is medium.
 *   * **Surface layering** — the page is `neutral-0`, a recessed well is `neutral-50`, a raised card is
 *     `neutral-0` again but separated by a hairline border rather than by colour.
 *   * **Border contrast** — a border moving 200 → 300 → 400 is this system's hover, and 2px is its emphasis.
 *   * **Elevation** — reserved for the three things that genuinely leave the page.
 *
 * **Radius means something.** One radius for everything is the commonest tell of a templated design, so there
 * are three and each belongs to a role: controls are `md`, surfaces are `lg`, and anything pill-shaped is
 * `full`. A badge is a pill; a button is a control; a card is a surface.
 *
 * **Everything is logical, never physical.** `ps`/`pe`, `ms`/`me`, `start`/`end`, `text-start`/`text-end`. The
 * same components render Arabic right-to-left, and a single `pl-4` is a layout that is subtly wrong in half the
 * product. `packages/ui/test/components.test.tsx` fails on a physical-direction class in any primitive.
 */

/* ------------------------------------------------------------------------------------------------ focus */

/**
 * One focus ring, product-wide.
 *
 * An outline rather than a ring built from a box-shadow: an outline is not clipped by an ancestor's `overflow`,
 * which matters because half of these primitives live inside scrolling panels and cards. `focus-visible` rather
 * than `focus`, so a pointer click does not leave a ring behind, while keyboard navigation always shows one.
 *
 * `neutral-900` at 2px with a 2px offset is legible on every surface in the system, including the inverted
 * primary button, where the offset puts the ring on the page rather than on the dark fill.
 */
export const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900';

/** For a control whose own background is dark: the ring sits outside, so the offset carries it onto the page. */
export const FOCUS_RING_INVERTED = FOCUS_RING;

/* --------------------------------------------------------------------------------------------- surfaces */

/** A surface that sits flat in the document and is separated by a hairline, not a shadow. */
export const SURFACE_CARD = 'rounded-lg border border-neutral-200 bg-neutral-0';

/** A recessed area: a filter panel, a summary block, a disabled field's backdrop. */
export const SURFACE_WELL = 'rounded-lg border border-neutral-200 bg-neutral-50';

/** A layer anchored to its trigger. The only place `shadow-md` appears. */
export const SURFACE_POPOVER = 'rounded-lg border border-neutral-200 bg-neutral-0 shadow-md';

/** A layer that owns the screen. The only place `shadow-lg` appears. */
export const SURFACE_OVERLAY = 'rounded-lg border border-neutral-200 bg-neutral-0 shadow-lg';

/** The scrim behind an overlay. Black at low alpha, so it reads the same whatever the brand becomes. */
export const SCRIM = 'fixed inset-0 bg-neutral-1000/40';

/* ------------------------------------------------------------------------------------------ typography */

/**
 * The type scale, by job rather than by size.
 *
 * No letter-spacing anywhere, at any size. Arabic is cursive and negative tracking breaks the joins between its
 * letters; the same components render both languages, so a display line that is crisp in English would be broken
 * in Arabic. Size and weight do the work instead — which also keeps the tracked-out label, a design cliché, out
 * of the product.
 */
export const TYPE = Object.freeze({
  /** The home page's opening line, and nothing else. */
  display: 'text-4xl font-semibold leading-tight text-neutral-900 sm:text-5xl',
  h1: 'text-3xl font-semibold leading-snug text-neutral-900',
  h2: 'text-2xl font-semibold leading-snug text-neutral-900',
  h3: 'text-xl font-semibold leading-snug text-neutral-900',
  h4: 'text-lg font-semibold leading-snug text-neutral-900',
  /** A card's title: short, holds together, clamps rather than wraps forever. */
  cardTitle: 'text-base font-medium leading-snug text-neutral-900',
  body: 'text-base leading-normal text-neutral-700',
  /** Long-form prose: the CMS pages and the blog, where a taller measure reads better in both languages. */
  prose: 'text-base leading-relaxed text-neutral-700',
  /** Secondary information: a location, a date, a count. */
  meta: 'text-sm leading-normal text-neutral-600',
  /** A form label, a column header, a filter group's name. */
  label: 'text-sm font-medium leading-snug text-neutral-900',
  /** Help text under a field. */
  hint: 'text-sm leading-normal text-neutral-600',
  /**
   * A price. `tabular-nums` so a column of them aligns on the digits, which is the one piece of a listing a
   * person compares across cards — and bold, because in a monochrome system weight is the only emphasis there is.
   */
  price: 'text-lg font-bold leading-snug text-neutral-900 tabular-nums',
  priceLarge: 'text-2xl font-bold leading-snug text-neutral-900 tabular-nums',
});

/* ----------------------------------------------------------------------------------------------- states */

/** A control a person can operate: the shared transition and the pressed nudge. */
export const INTERACTIVE = 'transition-colors duration-150 active:translate-y-px';

/** A control that cannot be operated. Stated on the element, never implied by opacity alone. */
export const DISABLED =
  'disabled:pointer-events-none disabled:border-neutral-200 disabled:bg-neutral-50 disabled:text-neutral-400';

/** A link inside running text. Underlined always — colour cannot distinguish it here. */
export const LINK = `rounded-sm underline decoration-neutral-400 underline-offset-2 hover:decoration-neutral-900 ${FOCUS_RING}`;

/* ------------------------------------------------------------------------------------------------- misc */

/** Joins class names, dropping anything falsy, so a conditional class never emits "undefined". */
export function cx(...parts: readonly (string | false | null | undefined)[]): string {
  return parts.filter((part) => typeof part === 'string' && part !== '').join(' ');
}
