import {
  deriveColorScale,
  deriveNeutralScale,
  tintSurface,
  withAlpha,
  type ScaleStep,
} from './color-scale.js';

/**
 * The design tokens the whole product is built from.
 *
 * The two brand colours are placeholders and must be replaced with the owner's final values before the design
 * system is locked for production (D5: brand is an admin branding setting, never hard-coded). Both placeholders
 * are greys, so **the palette carries no hue until the owner supplies those two values.** 0110 does not treat
 * that as a reason for the product to look grey: the richness comes from a semantic ladder instead of from
 * colour.
 *
 * **The semantic layer is the point of this file.** Components never reach for `neutral-200`; they ask for
 * `surface.sunken` or `border.hairline` or `text.muted`, and the ladder decides. That is what makes a hueless
 * palette read as designed rather than as absent: six surfaces at distinct values, four text roles with real
 * contrast steps between them, and three border weights for three different jobs. Chief among the surfaces is
 * `ink` — a near-black band the public pages invert into. A page that alternates light and ink has drama that
 * no amount of grey-on-white can produce, and it costs no hue at all.
 *
 * **The accent role is wired through the brand slots.** The active navigation marker, the focus ring and the
 * price rule all resolve to `brand.primary`. At today's placeholder they read as neutral marks, so nothing looks
 * unfinished; the day the owner supplies two values, the accent appears across every public surface from this
 * one file. Nothing anywhere hard-codes a colour.
 *
 * No gradients and no glows are defined. Elevation is: a shadow here states that something sits above what is
 * behind it — a card lifted off a recessed band, a dropdown, a dialog, a stuck header.
 *
 * **Letter-spacing is Latin-only and display-only.** Arabic is cursive: negative tracking breaks the joins
 * between letters, and the same components render both scripts. 0109 resolved that by having no tracking tokens
 * at all, which left Latin display type set loose at 4rem. The tokens exist now, and `globals.css` applies them
 * only under `[lang="en"]`, so an Arabic heading can never receive them.
 */

export type HexColor = `#${string}`;

const HEX_COLOR_PATTERN = /^#[0-9A-F]{6}$/;

/** Exactly two replaceable brand colours. The architecture's one colour input, unchanged. */
export interface BrandColors {
  readonly brandPrimary: HexColor;
  readonly brandSecondary: HexColor;
}

export const BRAND_COLOR_KEYS = ['brandPrimary', 'brandSecondary'] as const;

/**
 * The owner's brand, supplied 10 October 2026.
 *
 * Two values, and the architecture has always had room for exactly two (D5). What is in them now is the
 * production brand rather than a stand-in:
 *
 *   * **`#123B35` — a deep emerald.** The owner's own description is the brief: stability, confidence, and the
 *     register that luxury property and property investment are sold in. It is dark and deliberately muted —
 *     a chroma of 0.047 at a lightness of 0.32 — which is why {@link deriveColorScale} anchors the ramp on it
 *     rather than reading numbers off it. Taken literally at mid-scale that chroma is a grey-green; anchored,
 *     the hex itself appears in the product and every other step carries the intensity it implies.
 *   * **The same value in the second slot**, which is the owner's decision and not an omission. They supplied
 *     white and one colour, and asked for the accent to come out of the emerald rather than from a second hue.
 *     So the system has one hue and finds its variety in lightness and surface instead — canvas, a soft
 *     emerald wash, and a near-black emerald ground — which is a more disciplined composition than two hues
 *     and a harder one to make look cheap. The slot stays a slot: putting a different hex in it introduces a
 *     second hue everywhere the accent roles are used, with nothing else to change.
 *
 * The background the owner specified, `#FFFFFF`, is `surface.canvas` below and was already exactly that: the
 * page is pure white, and the tinted surfaces sit on top of it rather than replacing it.
 *
 * Nothing downstream knows these particular values. Change the hexes and the whole system re-derives.
 */
export const BRAND_COLORS: BrandColors = Object.freeze({
  brandPrimary: '#123B35',
  brandSecondary: '#123B35',
});

/**
 * The neutral ramp, carrying a trace of the brand's hue.
 *
 * Derived rather than listed, and deliberately so: pure greys are what make an interface look like an admin
 * template. A few percent of the brand's chroma in every grey is the cheapest thing a design system can do to
 * look considered — the page stops being built from #F7F7F7 and starts being built from *this product's* pale
 * surface. Because it is derived, an owner who supplies a warm brand gets warm greys rather than inheriting
 * the previous brand's cool ones. {@link deriveNeutralScale} shows how little chroma is involved.
 */
export const neutralColors: Record<string, string> = {
  '0': '#FFFFFF',
  ...deriveNeutralScale(BRAND_COLORS.brandPrimary),
  '1000': '#000000',
};

/**
 * Type faces. No web fonts are loaded — the product ships none and fetches none — so the work here is choosing
 * the platform faces deliberately and giving each script its own stack.
 *
 * `sans` is Latin-first. `arabic` is a separate stack applied by `globals.css` under `[lang="ar"]` and
 * `[dir="rtl"]`, because the Latin stack's Arabic fallback is whatever the platform happens to pick: on Windows
 * that is usually Tahoma, a face with cramped Naskh proportions and no real weight range. Naming the Arabic
 * faces in preference order — the Noto and SF Arabic families first, then Geeza Pro, then Tahoma as the floor —
 * is the difference between Arabic that was designed and Arabic that merely rendered.
 */
export const fontFamily = {
  sans: [
    'system-ui',
    '-apple-system',
    'BlinkMacSystemFont',
    '"Segoe UI Variable Display"',
    '"Segoe UI"',
    'Inter',
    'Roboto',
    '"Helvetica Neue"',
    '"Noto Sans"',
    'Arial',
    'sans-serif',
  ],
  arabic: [
    '"SF Arabic"',
    '"Noto Sans Arabic"',
    '"Noto Naskh Arabic"',
    '"Geeza Pro"',
    '"Segoe UI"',
    'Tahoma',
    'Arial',
    'sans-serif',
  ],
} as const;

export const fontSize = {
  xs: '0.75rem',
  sm: '0.875rem',
  base: '1rem',
  lg: '1.125rem',
  xl: '1.25rem',
  '2xl': '1.5rem',
  '3xl': '1.875rem',
  '4xl': '2.25rem',
  '5xl': '3rem',
  '6xl': '3.75rem',
  /**
   * Display only, and only at the top of a band: the home page's opening line and a price lockup on a detail
   * page. The jump from `xs` metadata to `7xl` display is a 6× ratio, and that span is most of what makes a
   * hueless page read as composed rather than as uniform.
   */
  '7xl': '4.5rem',
} as const;

/**
 * Weights, named rather than numbered.
 *
 * `light` exists for display sizes only. A platform sans set at 4rem in 300 has a precision that the same face
 * at 600 does not, and it is one of the few premium signals available without a licensed typeface. It is never
 * used below `2xl`, where it would simply look thin.
 */
export const fontWeight = {
  light: '300',
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
} as const;

/**
 * Tracking. Latin display type only — see the note at the top of this file about Arabic's joins.
 *
 * A platform sans at 3rem and above sets too loose by default, because its metrics are tuned for interface text
 * at 13–17px. These two steps close that up. There is no positive step: tracked-out capitals are a convention
 * this product does not use.
 */
export const letterSpacing = {
  /** `6xl` and `7xl`. */
  tight: '-0.03em',
  /** `3xl` to `5xl`. */
  snug: '-0.018em',
} as const;

/**
 * Line heights, named by the job rather than by a ratio.
 *
 * `normal` and `relaxed` are generous on purpose. Arabic sets taller than Latin at the same point size — its
 * ascenders, descenders and diacritics occupy more vertical space — so body copy that is comfortable in English
 * at 1.45 is cramped in Arabic. One value has to serve both, and the taller one is the one that serves both.
 */
export const lineHeight = {
  /** A single line that must not gain any: a large price lockup, a numeral standing alone. */
  none: '1',
  /** Display type, where the size itself creates the space. */
  tight: '1.08',
  /** Headings and card titles, which are short and want to hold together. */
  snug: '1.3',
  /** Body copy and anything a person reads a paragraph of. */
  normal: '1.6',
  /** Long-form prose: the CMS static pages and the blog. */
  relaxed: '1.75',
} as const;

/**
 * Elevation: what floats, and how far.
 *
 * Pure black at low alpha, so the scale is hueless and stays correct whatever the two brand colours become.
 * Three steps and no more, because there are only three things in this product that leave the page: a surface
 * that has stuck to the viewport, a layer that opens next to its trigger, and a layer that takes over the screen.
 *
 * A flat surface gets a hairline border instead. That is the system's main structural device, and the reason this
 * scale can stay this small.
 */
export const shadow = {
  /**
   * A card resting on a recessed band. Barely there on purpose: the lift comes mostly from the value difference
   * between the card and the band under it, and the shadow only confirms it. This is the step that replaces
   * 0109's four-sided border, which is what made a grid of cards read as a table.
   */
  xs: '0 1px 1px 0 rgb(0 0 0 / 0.03), 0 1px 3px -1px rgb(0 0 0 / 0.05)',
  /** A surface that has lifted slightly: a sticky header once the page has scrolled under it. */
  sm: '0 1px 2px 0 rgb(0 0 0 / 0.06)',
  /** A card under the pointer, and a layer anchored to its trigger: dropdown, popover, select menu. */
  md: '0 4px 12px -2px rgb(0 0 0 / 0.10), 0 2px 4px -2px rgb(0 0 0 / 0.06)',
  /** A layer that owns the screen: dialog and drawer. */
  lg: '0 16px 40px -8px rgb(0 0 0 / 0.18), 0 4px 12px -4px rgb(0 0 0 / 0.08)',
  /**
   * The top-edge highlight that makes a dark surface read as material rather than as a hole. One inset hairline
   * of white at 6%, which is how a card on an ink band gets an edge without a border drawn around it.
   */
  inkEdge: 'inset 0 1px 0 0 rgb(255 255 255 / 0.06)',
} as const;

export const spacing = {
  '0': '0rem',
  '1': '0.25rem',
  '2': '0.5rem',
  '3': '0.75rem',
  '4': '1rem',
  '5': '1.25rem',
  '6': '1.5rem',
  '8': '2rem',
  '10': '2.5rem',
  '12': '3rem',
  '16': '4rem',
  '20': '5rem',
  '24': '6rem',
} as const;

/**
 * Radii, by the size of the thing rather than by taste.
 *
 * A 14px corner on a 320px card and a 4px corner on a 40px control are the same gesture at two scales; using one
 * value for both is what makes an interface look like a template. `md` is for controls, `lg` for small surfaces,
 * `xl` for cards and panels, `2xl` for a full band or a hero figure, `full` for pills.
 */
export const radius = {
  none: '0px',
  sm: '2px',
  md: '6px',
  lg: '10px',
  xl: '14px',
  '2xl': '20px',
  full: '9999px',
} as const;

/**
 * The semantic ladder: the layer every component actually speaks to.
 *
 * Each value is a neutral from the ramp above, or black/white at an alpha where a translucent overlay is the
 * correct answer. A component asks for a role — "the band behind this card", "the quietest text on an ink
 * surface", "the hairline inside a card" — and never for a step number. Two things follow. The product can be
 * re-valued from one file without touching a component, and, more importantly, a reviewer can see at a glance
 * whether the design has enough distinct steps to hold a hierarchy. 0109's did not: it had two surfaces and two
 * text colours, which is why it looked flat.
 */
/**
 * The brand's own eleven steps, and the accent's.
 *
 * Generated from the two slots at module load. A component asks for `brand-600` or `accent-100`; it never
 * learns what hue that is, and swapping the two hexes re-skins the product without a component changing.
 */
export const brandScale = deriveColorScale(BRAND_COLORS.brandPrimary);
export const accentScale = deriveColorScale(BRAND_COLORS.brandSecondary);

/**
 * The semantic ladder: the layer every component actually speaks to.
 *
 * A component asks for a role — "the band behind this card", "the quietest text on an ink surface" — and never
 * for a step number. Two things follow: the product can be re-valued from one file, and a reviewer can see at
 * a glance whether the design has enough distinct steps to hold a hierarchy.
 *
 * **What this revision changed is that the roles are no longer all grey.** The recessed band is a pale wash of
 * the brand rather than #F7F7F7; the inverted band is the brand at `950` rather than near-black; the accent
 * surfaces are real. The structure is the same and the atmosphere is not, which is the whole point: a page
 * alternating white against a tinted wash reads as a designed surface, and the identical page alternating
 * white against grey reads as a table with a header row.
 */
export const surface = {
  /** The page itself. */
  canvas: '#FFFFFF',
  /** A band recessed into the page: almost white, and only just not grey. See `tintSurface`. */
  sunken: tintSurface(BRAND_COLORS.brandPrimary, 0.984, 0.1),
  /** A card or panel sitting on a recessed band. */
  raised: '#FFFFFF',
  /** A quiet filled area inside a card: a well, a disabled field. */
  muted: neutralColors['100'] as string,
  /** A tinted panel that belongs to the brand: a buy box, a card's price region. */
  brandSoft: tintSurface(BRAND_COLORS.brandPrimary, 0.96, 0.22),
  /**
   * The accent's own wash, for the places that mark value rather than structure.
   *
   * **Deeper than `brandSoft`, not a different hue.** With one colour in both slots a tint computed the same
   * way from each would produce two values a person cannot tell apart, and a band device nobody can see is
   * not a device. So the two washes are separated along the axis this system actually has: `brandSoft` is a
   * breath of colour and `accentSoft` is a visible one, and a page alternating them has a rhythm.
   */
  accentSoft: tintSurface(BRAND_COLORS.brandSecondary, 0.932, 0.3),
  /**
   * The inverted band. The public pages open on this and close on it.
   *
   * **This is the owner's own hex**, which is the point of it. The hero and the footer are the largest
   * branded surfaces in the product, and a brand colour that appears everywhere except the places people
   * actually look at is not the brand they chose. `950` sat here first — a near-black derived *from* the
   * emerald, correct by construction and anonymous in practice.
   */
  ink: brandScale['900'],
  /** A card or panel sitting on an ink band: one step lighter, so it lifts off the ground it sits on. */
  inkRaised: brandScale['800'],
  /** A quiet filled area on an ink band. */
  inkMuted: withAlpha('#FFFFFF', 0.07),
} as const;

/** Text roles, at contrast steps chosen to be distinguishable rather than merely different. */
export const textColor = {
  /** Headings, prices, anything a person reads to decide. */
  strong: neutralColors['950'] as string,
  /** Body copy. */
  body: neutralColors['700'] as string,
  /** Metadata, hints, captions. */
  muted: neutralColors['600'] as string,
  /** Disabled, and placeholder text. */
  faint: neutralColors['400'] as string,
  /** A link or a label that belongs to the brand, on a light surface. */
  brand: brandScale['700'],
  /** The accent in text, used only where something is being marked rather than said. */
  accent: accentScale['700'],
  /** On an ink band. */
  onInk: '#FFFFFF',
  onInkMuted: brandScale['300'],
} as const;

/**
 * Borders, at four weights for four jobs — and lighter than a grey system needs.
 *
 * `hairline` is the inside-a-card divider and is nearly invisible, which is the point. `edge` is for a control
 * a person must be able to aim at. `brand` edges a surface that belongs to the brand. `strong` is the only
 * border meant to be noticed.
 */
export const borderColor = {
  hairline: neutralColors['100'] as string,
  edge: neutralColors['200'] as string,
  brand: brandScale['200'],
  strong: neutralColors['900'] as string,
  onInk: withAlpha('#FFFFFF', 0.14),
  onInkStrong: withAlpha('#FFFFFF', 0.28),
} as const;

/**
 * Interaction states as translucent overlays rather than as a second set of solid colours.
 *
 * An overlay works on any surface in the ladder, which is what lets one `hover` value be correct on a white
 * card, a tinted band and an ink panel alike. Solid hover colours need one per surface, and that is how a
 * design system ends up with forty colour tokens and no hierarchy. The light-surface overlays carry the
 * brand's hue, so a hover is a hint of the brand rather than a smear of grey.
 */
export const stateOverlay = {
  hover: withAlpha(BRAND_COLORS.brandPrimary, 0.06),
  active: withAlpha(BRAND_COLORS.brandPrimary, 0.12),
  hoverOnInk: withAlpha('#FFFFFF', 0.08),
  activeOnInk: withAlpha('#FFFFFF', 0.14),
} as const;

export interface DesignTokens {
  readonly color: {
    readonly neutral: typeof neutralColors;
    readonly brand: BrandColors;
    /** Eleven steps derived from each slot. */
    readonly brandScale: Record<ScaleStep, string>;
    readonly accentScale: Record<ScaleStep, string>;
    /** The semantic ladder. Components speak to this, never to the ramp. */
    readonly surface: typeof surface;
    readonly text: typeof textColor;
    readonly border: typeof borderColor;
    readonly state: typeof stateOverlay;
  };
  readonly fontFamily: typeof fontFamily;
  readonly fontSize: typeof fontSize;
  readonly fontWeight: typeof fontWeight;
  readonly letterSpacing: typeof letterSpacing;
  readonly lineHeight: typeof lineHeight;
  readonly spacing: typeof spacing;
  readonly radius: typeof radius;
  readonly shadow: typeof shadow;
}

/**
 * The whole colour layer, for one pair of brand colours.
 *
 * Everything — the neutral ramp, both scales, the surfaces, the text roles, the borders and the state
 * overlays — is a function of the two slots. That is what makes the two-slot architecture carry a real design
 * system rather than two accent dots on a grey page: supplying a different pair re-derives all of it, and no
 * component anywhere had to know.
 */
function buildColors(brand: BrandColors): DesignTokens['color'] {
  const scale = deriveColorScale(brand.brandPrimary);
  const accent = deriveColorScale(brand.brandSecondary);
  const neutral: Record<string, string> = {
    '0': '#FFFFFF',
    ...deriveNeutralScale(brand.brandPrimary),
    '1000': '#000000',
  };
  return {
    neutral,
    brand: { brandPrimary: brand.brandPrimary, brandSecondary: brand.brandSecondary },
    brandScale: scale,
    accentScale: accent,
    surface: {
      canvas: '#FFFFFF',
      // Not `scale['50']`: at band scale that reads as a wash of mint. See `tintSurface`.
      sunken: tintSurface(brand.brandPrimary, 0.984, 0.1),
      raised: '#FFFFFF',
      muted: neutral['100'] as string,
      brandSoft: tintSurface(brand.brandPrimary, 0.96, 0.22),
      accentSoft: tintSurface(brand.brandSecondary, 0.932, 0.3),
      ink: scale['900'],
      inkRaised: scale['800'],
      inkMuted: withAlpha('#FFFFFF', 0.07),
    },
    text: {
      strong: neutral['950'] as string,
      body: neutral['700'] as string,
      muted: neutral['600'] as string,
      faint: neutral['400'] as string,
      brand: scale['700'],
      accent: accent['700'],
      onInk: '#FFFFFF',
      onInkMuted: scale['300'],
    },
    border: {
      hairline: neutral['100'] as string,
      edge: neutral['200'] as string,
      brand: scale['200'],
      strong: neutral['900'] as string,
      onInk: withAlpha('#FFFFFF', 0.14),
      onInkStrong: withAlpha('#FFFFFF', 0.28),
    },
    state: {
      hover: withAlpha(brand.brandPrimary, 0.06),
      active: withAlpha(brand.brandPrimary, 0.12),
      hoverOnInk: withAlpha('#FFFFFF', 0.08),
      activeOnInk: withAlpha('#FFFFFF', 0.14),
    },
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

function assertBrandColors(value: unknown): asserts value is BrandColors {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Brand colours must be an object.');
  }
  const keys = Object.keys(value).sort();
  const expected = [...BRAND_COLOR_KEYS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError('Brand colours must contain exactly brandPrimary and brandSecondary.');
  }
  for (const key of BRAND_COLOR_KEYS) {
    const color = (value as Record<string, unknown>)[key];
    if (typeof color !== 'string' || !HEX_COLOR_PATTERN.test(color)) {
      throw new TypeError(`${key} must be a six-digit upper-case hex colour such as #1A2B3C.`);
    }
  }
}

/** Builds the token set with the given brand colours (placeholders by default). */
export function createDesignTokens(brand: BrandColors = BRAND_COLORS): DesignTokens {
  assertBrandColors(brand);
  return deepFreeze({
    color: {
      ...buildColors(brand),
    },
    fontFamily: { sans: [...fontFamily.sans], arabic: [...fontFamily.arabic] },
    fontSize: { ...fontSize },
    fontWeight: { ...fontWeight },
    letterSpacing: { ...letterSpacing },
    lineHeight: { ...lineHeight },
    spacing: { ...spacing },
    radius: { ...radius },
    shadow: { ...shadow },
  }) as DesignTokens;
}

export const designTokens: DesignTokens = createDesignTokens();
