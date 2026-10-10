import { FOCUS_RING, FOCUS_RING_INVERTED, INTERACTIVE, SURFACE_CARD, cx } from '@repo/ui';

/**
 * The console's visual grammar (OD-A-admin).
 *
 * **Why the console gets its own module rather than `packages/ui`'s recipes alone.** A console is not a
 * marketplace. The public pages are built from bands — an opening, a wash, an ink close — because a visitor
 * reads them once, in order, and the rhythm is the design. A console is read by somebody doing a job: the
 * same person, many times a day, scanning for one row. What it needs is density, an unmistakable chrome so
 * nobody mistakes it for the storefront, and a table that is quiet enough to read for an hour. So the shared
 * grammar is imported — the focus ring, the card, the transition, all of them exactly the public ones, which
 * is what keeps the two surfaces one product — and only the console-specific parts are stated here.
 *
 * **Everything is a semantic role.** Not one raw `neutral-*` utility and not one hex literal, which is the
 * rule `packages/ui` has always been held to and which the console was exempt from until now. That exemption
 * is what left it grey when the owner's brand arrived: a surface written against `neutral-200` cannot inherit
 * a brand, because `neutral-200` is not a decision about anything. The pinned test in
 * `test/admin/admin-tokens.test.ts` holds the whole admin tree to it from here.
 *
 * **The chrome is the owner's emerald, and deliberately so.** A dark bar across the top is the oldest signal
 * in interface design for "this is the tool, not the product", and it costs nothing: `surface.ink` is already
 * the brand at its own lightness. A member of staff who has both open in two tabs can tell them apart without
 * reading a word, which is the thing a shared origin (0108) otherwise makes harder.
 */

/* ------------------------------------------------------------------------------------------------ */
/* Chrome                                                                                             */
/* ------------------------------------------------------------------------------------------------ */

/** The masthead: the one inverted surface in the console, and what names it as the console. */
export const ADMIN_HEADER = 'bg-surface-ink text-on-ink';

/** The wordmark inside it. The section name is lighter rather than smaller, so the two read as one phrase. */
export const ADMIN_WORDMARK = 'text-lg font-semibold tracking-normal text-on-ink';
export const ADMIN_WORDMARK_SECTION = 'font-normal text-on-ink-muted';

/** The section bar below the masthead, on canvas so the working area starts immediately. */
export const ADMIN_NAV = 'border-b border-hairline bg-surface-canvas';

/** A section link, and the one the reader is on. Weight and surface, never colour alone. */
export const ADMIN_NAV_LINK = cx(
  'block rounded-md px-3 py-2 text-sm underline-offset-4',
  INTERACTIVE,
  FOCUS_RING,
);
export const ADMIN_NAV_LINK_IDLE = 'text-ink-body hover:bg-surface-sunken hover:text-ink-strong';
export const ADMIN_NAV_LINK_ACTIVE = 'bg-surface-brand-soft font-semibold text-ink-brand';

/** The footer line. */
export const ADMIN_FOOTER = 'mt-auto border-t border-hairline';

/* ------------------------------------------------------------------------------------------------ */
/* Working surfaces                                                                                   */
/* ------------------------------------------------------------------------------------------------ */

/** A panel of content. The public card exactly, because a card is a card. */
export const ADMIN_PANEL = SURFACE_CARD;

/** The padding a panel takes. Stated once so panels cannot drift apart from each other. */
export const ADMIN_PANEL_SPACE = 'p-5 sm:p-6';

/** A quiet filled region inside a panel: a summary line, an empty state, a note. */
export const ADMIN_WELL = 'rounded-lg bg-surface-sunken p-4';

/** The rule between rows of a list that is not a table. */
export const ADMIN_DIVIDER = 'divide-y divide-hairline';

/* ------------------------------------------------------------------------------------------------ */
/* Tables                                                                                             */
/* ------------------------------------------------------------------------------------------------ */

/**
 * A queue table.
 *
 * Horizontal rules only, and a header that is a label rather than a band: a console table read for an hour
 * should not be a grid of boxes. The header stays legible because it is `ink-muted` at a smaller size, not
 * because it sits on a different colour.
 */
export const ADMIN_TABLE = 'w-full border-collapse text-sm';
export const ADMIN_TABLE_HEAD = 'border-b border-edge text-start text-xs font-semibold text-ink-muted';
export const ADMIN_TABLE_CELL = 'border-b border-hairline py-3 pe-4 text-start align-top text-ink-body';
export const ADMIN_TABLE_ROW = cx('hover:bg-surface-sunken', INTERACTIVE);

/* ------------------------------------------------------------------------------------------------ */
/* Controls                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

const CONTROL_BASE = cx(
  'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium',
  INTERACTIVE,
);

/** The action a screen exists for. One per screen, in the brand. */
export const ADMIN_BUTTON = cx(
  CONTROL_BASE,
  'bg-brand-600 text-on-ink hover:bg-brand-700 active:bg-brand-800',
  FOCUS_RING,
);

/** Everything else: present, legible, and not competing with the action above. */
export const ADMIN_BUTTON_QUIET = cx(
  CONTROL_BASE,
  'border border-edge bg-surface-raised text-ink-strong hover:bg-surface-sunken',
  FOCUS_RING,
);

/** An action on the inverted chrome. */
export const ADMIN_BUTTON_ON_INK = cx(
  CONTROL_BASE,
  'border border-edge-on-ink text-on-ink hover:bg-surface-ink-muted',
  FOCUS_RING_INVERTED,
);

/** A destructive or state-changing step that should read as deliberate rather than dangerous-looking. */
export const ADMIN_BUTTON_STRONG = cx(
  CONTROL_BASE,
  'bg-surface-ink text-on-ink hover:bg-brand-800',
  FOCUS_RING,
);

/** A text field, select or textarea. */
export const ADMIN_FIELD = cx(
  'w-full rounded-lg border border-edge bg-surface-raised px-3 py-2 text-sm text-ink-strong',
  'placeholder:text-ink-faint',
  INTERACTIVE,
  FOCUS_RING,
);

/** The label above one. */
export const ADMIN_LABEL = 'block text-sm font-medium text-ink-strong';

/** The hint below one. */
export const ADMIN_HINT = 'mt-1 text-sm text-ink-muted';

/* ------------------------------------------------------------------------------------------------ */
/* Marks                                                                                              */
/* ------------------------------------------------------------------------------------------------ */

/** A status pill. Tone carries meaning, and the text carries it too — never the colour alone. */
export const ADMIN_BADGE = 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium';
export const ADMIN_BADGE_TONE = Object.freeze({
  neutral: 'bg-surface-muted text-ink-body',
  brand: 'bg-surface-brand-soft text-ink-brand',
  ink: 'bg-surface-ink text-on-ink',
});
export type AdminBadgeTone = keyof typeof ADMIN_BADGE_TONE;
