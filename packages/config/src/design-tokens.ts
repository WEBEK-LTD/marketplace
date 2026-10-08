/**
 * The design tokens the whole product is built from.
 *
 * The two brand colours are placeholders and must be replaced with the owner's final values before the design
 * system is locked for production (D5: brand is an admin branding setting, never hard-coded). Both placeholders
 * are greys, so **the palette is monochrome until the owner supplies those two values** — and 0109's visual
 * system is built for that rather than around it. Hierarchy comes from type, weight, surface layering, border
 * contrast, radius and elevation; the brand slots are an accent the design can adopt without being rebuilt.
 *
 * No gradients and no glows are defined. Elevation is, since 0109: a shadow here is the statement that something
 * floats above the page — a dropdown, a dialog, a drawer, a stuck header — and is never decoration on a surface
 * that sits flat in the document.
 *
 * **There are deliberately no letter-spacing tokens.** Arabic is cursive: negative tracking breaks the joins
 * between letters, and the same components render both languages, so a tracked-out heading would be correct in
 * English and broken in Arabic. The scale carries display type through size and weight instead.
 */

export type HexColor = `#${string}`;

const HEX_COLOR_PATTERN = /^#[0-9A-F]{6}$/;

/** Neutral grey scale (equal red, green and blue values). */
export const neutralColors = {
  '0': '#FFFFFF',
  '50': '#F7F7F7',
  '100': '#EDEDED',
  '200': '#DCDCDC',
  '300': '#C4C4C4',
  '400': '#A3A3A3',
  '500': '#808080',
  '600': '#666666',
  '700': '#4D4D4D',
  '800': '#333333',
  '900': '#1F1F1F',
  '950': '#121212',
  '1000': '#000000',
} as const satisfies Record<string, HexColor>;

/** Exactly two replaceable brand colours. */
export interface BrandColors {
  readonly brandPrimary: HexColor;
  readonly brandSecondary: HexColor;
}

export const BRAND_COLOR_KEYS = ['brandPrimary', 'brandSecondary'] as const;

/** Neutral placeholders until the owner supplies the production brand colours. */
export const PLACEHOLDER_BRAND_COLORS: BrandColors = Object.freeze({
  brandPrimary: '#333333',
  brandSecondary: '#808080',
});

/** The operating system's default font stack; no web fonts are loaded. Covers Arabic. */
export const fontFamily = {
  sans: [
    'system-ui',
    '-apple-system',
    'BlinkMacSystemFont',
    '"Segoe UI"',
    'Roboto',
    '"Noto Sans"',
    '"Noto Sans Arabic"',
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
  /** Display only: the home page's opening line. Nothing else in the product is this large. */
  '5xl': '3rem',
} as const;

/**
 * Line heights, named by the job rather than by a ratio.
 *
 * `normal` and `relaxed` are generous on purpose. Arabic sets taller than Latin at the same point size — its
 * ascenders, descenders and diacritics occupy more vertical space — so body copy that is comfortable in English
 * at 1.45 is cramped in Arabic. One value has to serve both, and the taller one is the one that serves both.
 */
export const lineHeight = {
  /** Display type, where the size itself creates the space. */
  tight: '1.15',
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
  /** A surface that has lifted slightly: a sticky header once the page has scrolled under it. */
  sm: '0 1px 2px 0 rgb(0 0 0 / 0.06)',
  /** A layer anchored to its trigger: dropdown, popover, select menu. */
  md: '0 4px 12px -2px rgb(0 0 0 / 0.10), 0 2px 4px -2px rgb(0 0 0 / 0.06)',
  /** A layer that owns the screen: dialog and drawer. */
  lg: '0 16px 40px -8px rgb(0 0 0 / 0.18), 0 4px 12px -4px rgb(0 0 0 / 0.08)',
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

export const radius = {
  none: '0px',
  sm: '2px',
  md: '4px',
  lg: '8px',
  full: '9999px',
} as const;

export interface DesignTokens {
  readonly color: {
    readonly neutral: typeof neutralColors;
    readonly brand: BrandColors;
  };
  readonly fontFamily: typeof fontFamily;
  readonly fontSize: typeof fontSize;
  readonly lineHeight: typeof lineHeight;
  readonly spacing: typeof spacing;
  readonly radius: typeof radius;
  readonly shadow: typeof shadow;
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
export function createDesignTokens(brand: BrandColors = PLACEHOLDER_BRAND_COLORS): DesignTokens {
  assertBrandColors(brand);
  return deepFreeze({
    color: {
      neutral: { ...neutralColors },
      brand: { brandPrimary: brand.brandPrimary, brandSecondary: brand.brandSecondary },
    },
    fontFamily: { sans: [...fontFamily.sans] },
    fontSize: { ...fontSize },
    lineHeight: { ...lineHeight },
    spacing: { ...spacing },
    radius: { ...radius },
    shadow: { ...shadow },
  }) as DesignTokens;
}

export const designTokens: DesignTokens = createDesignTokens();
