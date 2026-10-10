/**
 * The marketplace's visual grammar (rewritten in 0110).
 *
 * Every primitive composes from this file, which is the mechanism by which fourteen public routes look like one
 * product. 0109 had the same mechanism and the wrong grammar: two surfaces, two text colours and a border drawn
 * round everything, which produced a wireframe. What changed here is not the amount of styling but its
 * structure.
 *
 * **Four ideas carry the whole design, and none of them is colour.**
 *
 * 1. **Bands.** A public page is a stack of full-bleed horizontal bands that alternate between the canvas, a
 *    recessed surface and ink. A band is the unit of composition; a `div` with a heading in it is not. This is
 *    what stops a long page reading as one undifferentiated document, and it is the single largest change from
 *    0109.
 * 2. **A surface ladder instead of borders.** A card is distinguished from what is behind it by *value* — it is
 *    white on a grey band — plus the faintest lift. 0109 distinguished it with a 1px `neutral-200` rectangle on
 *    all four sides, repeated twenty times down a grid, which is why it looked like a table. Borders survive
 *    here for the two jobs they are actually good at: edging a control a person must aim at, and dividing two
 *    regions *inside* one surface.
 * 3. **Scale contrast.** The type scale now spans 0.75rem to 4.5rem. A page whose largest element is six times
 *    its smallest reads as composed; a page that runs from 14px to 30px reads as a form. Most of the premium
 *    feel in a hueless palette comes from this and from the air around it.
 * 4. **The price is the hero datum.** A marketplace is scanned by price, so on a card the price is the largest
 *    thing and the title is second. 0109 had that backwards. {@link PRICE} sets the lockup.
 *
 * **On colour.** The two brand slots are owner-supplied and both are still grey placeholders (D5), so this
 * grammar carries no hue. It is built so that it does not need one and so that it gains one cleanly: the accent
 * role is wired through `brand-primary` in {@link ACCENT_BAR} and the focus ring, and resolves to a neutral mark
 * today. Nothing here hard-codes a colour, and nothing would have to be rewritten the day two real values
 * arrive.
 *
 * **On direction.** Every spacing and alignment utility in this file is logical — `ps`/`pe`, `ms`/`me`,
 * `start`/`end`, `border-s`/`border-e`. A test scans every file in this package for a physical one. The Arabic
 * face, its leading, and Latin-only display tracking are set in the application's `globals.css`, because they
 * key off `[lang]` and `[dir]`, which no utility class can reach.
 */

/**
 * The one focus ring in the product.
 *
 * An `outline` rather than a `box-shadow`, so no ancestor's `overflow` can clip it, and offset so it reads as a
 * ring around the control rather than a thicker border on it. It takes the brand accent, which means the day the
 * owner supplies brand colours the keyboard ring becomes branded everywhere at once.
 */
export const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary';

/** The same ring where the background is ink: white, because the accent may not have the contrast there. */
export const FOCUS_RING_INVERTED =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-on-ink';

/** The ring applied to a container when something inside it takes focus — a card with a stretched link. */
export const FOCUS_WITHIN =
  'focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-brand-primary';

/* ------------------------------------------------------------------------------------------------ */
/* Bands — the unit of page composition                                                              */
/* ------------------------------------------------------------------------------------------------ */

/**
 * A band's background. The page alternates between these, and that alternation is the composition.
 *
 * `ink` is the dramatic one and the reason a hueless product can still have a first impression: a near-black
 * band at the top of a page, and another at the bottom, gives a white page two anchors and a middle. It is used
 * sparingly — the opening of the home page and the closing band — because a page that inverts five times is a
 * zebra, not a composition.
 */
export const BAND = Object.freeze({
  canvas: 'bg-surface-canvas text-ink-strong',
  /** A pale wash of the brand, not a grey: this is what stops an alternating page reading as a table. */
  sunken: 'bg-surface-sunken text-ink-strong',
  /** The accent's wash, for the one band on a page that marks value rather than structure. */
  accent: 'bg-surface-accent-soft text-ink-strong',
  ink: 'bg-surface-ink text-on-ink',
});
export type BandTone = keyof typeof BAND;

/**
 * The vertical rhythm of a band, which is most of what "editorial spacing" means in practice.
 *
 * Three steps, and the gap between them is deliberately large. A band of content gets `normal`; the opening of a
 * page gets `opening`; a band that is one short statement gets `tight`. Scaling up at `sm` and again at `lg` is
 * what keeps a phone from receiving desktop proportions.
 */
export const BAND_SPACE = Object.freeze({
  tight: 'py-12 sm:py-16',
  normal: 'py-16 sm:py-20 lg:py-28',
  opening: 'py-16 sm:py-24 lg:py-32',
});

/* ------------------------------------------------------------------------------------------------ */
/* Surfaces                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

/**
 * A card.
 *
 * A hairline **ring** plus the faintest lift — not a four-sided border, and not a shadow alone. Both halves are
 * load-bearing and each was got wrong once. 0109 drew a 1px `neutral-200` rectangle around every card, and
 * twenty of those down a grid is a table. 0110 first replaced it with value alone — white on a grey band — which
 * is correct on a recessed band and *invisible* on the canvas, where white on white left the catalogue looking
 * like a bare list. A ring at `hairline` — two steps lighter than the border it replaced — reads as an edge on
 * the canvas and disappears into the lift on a recessed band, so one card is right on both.
 *
 * A ring rather than a border because a ring is painted outside the box and takes no part in layout: a card can
 * gain or lose its edge on hover without the content inside it moving by a pixel.
 */
export const SURFACE_CARD = 'rounded-xl bg-surface-raised ring-1 ring-hairline shadow-xs';

/** A quiet filled region inside a card: a facts panel, a disabled field, a code sample. */
export const SURFACE_WELL = 'rounded-lg bg-surface-sunken';

/** A card on an ink band. The inset top highlight is what makes a dark surface read as material. */
export const SURFACE_CARD_INK = 'rounded-xl bg-surface-ink-raised shadow-ink-edge';

/** A layer anchored to its trigger: dropdown, popover, select menu. */
export const SURFACE_POPOVER = 'rounded-xl bg-surface-raised ring-1 ring-edge shadow-md';

/** A layer that owns the screen: dialog, drawer. */
export const SURFACE_OVERLAY = 'rounded-2xl bg-surface-raised shadow-lg';

/** The dimming behind a modal layer. */
export const SCRIM = 'fixed inset-0 bg-surface-ink/55';

/**
 * The accent mark.
 *
 * A short rule set at the inline start of a section heading. It is the one place the design points at the brand,
 * it mirrors automatically because it is drawn with a logical border, and at today's placeholder it reads as a
 * neutral tick. When the owner supplies the two colours, every section heading on the public site gains the
 * brand in the same gesture, from this one line.
 */
export const ACCENT_BAR = 'bg-brand-primary';

/* ------------------------------------------------------------------------------------------------ */
/* Type                                                                                              */
/* ------------------------------------------------------------------------------------------------ */

/**
 * The type scale, by the job rather than by the size.
 *
 * The span is the point: `metaSmall` is 0.75rem and `display` reaches 4.5rem, a six-fold range. 0109's scale ran
 * from 0.875rem to 3rem and almost everything in it sat between 1rem and 1.5rem, which is why every page looked
 * like the same page.
 *
 * `mp-display` and `mp-display-sm` are not utilities but hooks: `globals.css` attaches Latin display tracking to
 * them under `[lang="en"]` only, so Arabic can never receive negative tracking and have its joins broken.
 */
export const TYPE = Object.freeze({
  /** The opening line of the home page, and nothing else. */
  display: 'mp-display text-4xl font-medium leading-tight sm:text-6xl lg:text-7xl',
  /** The opening line of an inner page. */
  displaySm: 'mp-display-sm text-3xl font-medium leading-tight sm:text-4xl lg:text-5xl',
  h1: 'mp-display-sm text-3xl font-semibold leading-tight sm:text-4xl',
  h2: 'mp-display-sm text-2xl font-semibold leading-snug sm:text-3xl',
  h3: 'text-xl font-semibold leading-snug',
  h4: 'text-lg font-semibold leading-snug',
  /** A card's title: the second thing read, after the price. */
  cardTitle: 'text-base font-medium leading-snug sm:text-lg',
  /** A large card's title, on a two-up grid. */
  cardTitleLarge: 'text-lg font-medium leading-snug sm:text-xl',
  lead: 'text-lg leading-normal text-ink-body sm:text-xl',
  body: 'text-base leading-normal text-ink-body',
  prose: 'text-base leading-relaxed text-ink-body',
  meta: 'text-sm leading-normal text-ink-muted',
  metaSmall: 'text-xs leading-normal text-ink-muted',
  label: 'text-sm font-medium leading-snug text-ink-strong',
  hint: 'text-sm leading-normal text-ink-muted',
  /**
   * The section eyebrow: a short word above a heading, in the muted role at body weight.
   *
   * Deliberately **not** tracked-out capitals. That treatment is the commonest tell of a templated page, and it
   * is also wrong here for a concrete reason: this product renders Arabic through the same component, and Arabic
   * has no case distinction at all, so an `uppercase` utility does nothing to it and the two languages stop
   * matching.
   */
  eyebrow: 'text-sm font-medium leading-snug text-ink-muted',
});

/**
 * The price lockup — the product's signature typographic detail.
 *
 * A price is the one number a person scans a marketplace for, so it is set larger than the title it sits with,
 * tight, and in tabular figures so a column of prices aligns on its digits. The currency code is set as a small
 * raised mark by `.mp-currency` in `globals.css` rather than as part of the number, which is what turns
 * "EGP 2500.00" from a string into a composed figure.
 *
 * Tabular figures matter in both scripts: Arabic pages in this product use Western digits, and a grid of prices
 * that do not align on the decimal looks careless in either language.
 */
export const PRICE = Object.freeze({
  /**
   * On a card.
   *
   * `whitespace-nowrap` is not cosmetic. The lockup keeps a real space between the currency code and the
   * amount — the text has to read "EGP 2500.00" to a screen reader and to anyone who copies it — and that
   * space is a wrap opportunity, which in a narrow card broke the figure across two lines with the code
   * stranded above the number. The price is one word as far as line-breaking is concerned.
   */
  card: 'whitespace-nowrap text-2xl font-semibold leading-none tabular-nums text-ink-strong sm:text-[1.75rem]',
  /** On a detail page, where the price is the largest thing on the screen after the title. */
  detail: 'whitespace-nowrap text-4xl font-semibold leading-none tabular-nums text-ink-strong sm:text-5xl',
  /** Where there is no amount: "Contact for price" is prose, not a figure, so it is not set as one. */
  absent: 'text-base font-medium leading-snug text-ink-muted',
});

/* ------------------------------------------------------------------------------------------------ */
/* Interaction                                                                                       */
/* ------------------------------------------------------------------------------------------------ */

/**
 * The product's one transition.
 *
 * Everything that answers a pointer or a keypress uses this duration and this curve, which is what makes the
 * interface feel like one piece of software. Nothing animates on load, on scroll or on its own: the reduced
 * motion block in `globals.css` disables what remains for anyone who asks.
 */
export const INTERACTIVE = 'transition-[background-color,border-color,color,box-shadow,transform] duration-200 ease-out';

/** A card under the pointer: a small genuine lift, not a colour change. */
export const CARD_HOVER = 'hover:-translate-y-0.5 hover:shadow-md hover:ring-edge';

export const DISABLED =
  'disabled:pointer-events-none disabled:bg-surface-muted disabled:text-ink-faint disabled:shadow-none';

/** A link in running text. Underlined from the start, because an underline is what makes a link a link. */
export const LINK = `rounded-sm underline decoration-edge underline-offset-2 hover:decoration-ink-strong ${FOCUS_RING}`;

/** The same link on an ink band. */
export const LINK_INVERTED = `rounded-sm underline decoration-edge-on-ink underline-offset-2 hover:decoration-on-ink ${FOCUS_RING_INVERTED}`;

/* ------------------------------------------------------------------------------------------------ */

/** Joins class names, dropping anything falsy. The only reason this exists is to keep `clsx` out of the tree. */
export function cx(...parts: readonly (string | false | null | undefined)[]): string {
  return parts.filter((part): part is string => typeof part === 'string' && part.length > 0).join(' ');
}
