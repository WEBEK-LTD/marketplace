/**
 * Neutral placeholder design tokens for Phase 1.
 * The two brand colours are placeholders and must be replaced with the owner's
 * final values before the design system is locked for production.
 * No gradients, glows or decorative effects are defined.
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
  readonly spacing: typeof spacing;
  readonly radius: typeof radius;
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
    spacing: { ...spacing },
    radius: { ...radius },
  }) as DesignTokens;
}

export const designTokens: DesignTokens = createDesignTokens();
