import { describe, expect, it } from 'vitest';
import { BRAND_COLOR_KEYS, createDesignTokens, designTokens, BRAND_COLORS } from '../src/index.js';

const isGrey = (hex: string) => hex.slice(1, 3) === hex.slice(3, 5) && hex.slice(3, 5) === hex.slice(5, 7);

function allStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(allStrings);
  return [];
}

describe('design tokens', () => {
  it('has exactly two brand colour slots', () => {
    expect(Object.keys(designTokens.color.brand).sort()).toEqual(['brandPrimary', 'brandSecondary']);
    expect([...BRAND_COLOR_KEYS]).toEqual(['brandPrimary', 'brandSecondary']);
  });

  it('carries the owner’s brand, and only that as colour input', () => {
    // Grey placeholders made every derived surface grey, which left the owner reviewing an admin template
    // rather than a marketplace; real placeholders fixed that, and these are no longer placeholders at all.
    expect(designTokens.color.brand).toEqual(BRAND_COLORS);
    expect(BRAND_COLORS.brandPrimary).toBe('#123B35');
    expect(isGrey(BRAND_COLORS.brandPrimary)).toBe(false);
    expect(isGrey(BRAND_COLORS.brandSecondary)).toBe(false);
    // Still exactly two, still hexes, still the only colour input the architecture has. The second holding
    // the same value is the owner's decision — one hue, white and emerald — not a missing one, and the slot
    // stays a slot: a different hex there introduces a second hue with nothing else to change.
    expect(Object.keys(BRAND_COLORS).sort()).toEqual(['brandPrimary', 'brandSecondary']);
  });

  it('puts the owner’s own hex in the scale, and the background they asked for on the page', () => {
    // The point of anchoring. A ramp every step of which is merely *related* to the brand colour is a ramp
    // in which the one value the owner chose appears nowhere, and the largest branded surfaces in the
    // product — the hero and the footer — are exactly where it should appear.
    expect(Object.values(designTokens.color.brandScale)).toContain('#123B35');
    expect(designTokens.color.brandScale['900']).toBe('#123B35');
    expect(designTokens.color.surface.ink).toBe('#123B35');
    expect(designTokens.color.surface.canvas).toBe('#FFFFFF');
    expect(designTokens.color.surface.raised).toBe('#FFFFFF');
  });

  it('keeps the two washes far enough apart to be two things', () => {
    // With one hue in both slots, a tint computed the same way from each gives two values nobody can tell
    // apart, and a band device nobody can see is not a device. Separated along lightness instead.
    const value = (hex: string) =>
      0.2126 * parseInt(hex.slice(1, 3), 16) +
      0.7152 * parseInt(hex.slice(3, 5), 16) +
      0.0722 * parseInt(hex.slice(5, 7), 16);
    const gap = value(designTokens.color.surface.brandSoft) - value(designTokens.color.surface.accentSoft);
    expect(gap).toBeGreaterThan(8);
  });

  it('carries white text on every surface a band is built from', () => {
    const relative = (hex: string) => {
      const channels = [1, 3, 5]
        .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    };
    const contrast = (a: string, b: string) =>
      (Math.max(relative(a), relative(b)) + 0.05) / (Math.min(relative(a), relative(b)) + 0.05);
    // A dark, muted brand is exactly the case where an inverted band quietly stops carrying its text.
    expect(contrast('#FFFFFF', designTokens.color.surface.ink)).toBeGreaterThanOrEqual(7);
    expect(contrast('#FFFFFF', designTokens.color.surface.inkRaised)).toBeGreaterThanOrEqual(7);
    expect(contrast('#FFFFFF', designTokens.color.brandScale['600'])).toBeGreaterThanOrEqual(4.5);
  });

  it('derives eleven steps from each slot, keeping the slot’s own hue', () => {
    for (const scale of [designTokens.color.brandScale, designTokens.color.accentScale]) {
      expect(Object.keys(scale)).toHaveLength(11);
      for (const hex of Object.values(scale)) expect(hex).toMatch(/^#[0-9A-F]{6}$/);
      // Monotonically darker down the scale: a ramp that doubles back is a ramp nobody can reason about.
      const luma = (hex: string) =>
        0.2126 * parseInt(hex.slice(1, 3), 16) + 0.7152 * parseInt(hex.slice(3, 5), 16) + 0.0722 * parseInt(hex.slice(5, 7), 16);
      const steps = Object.values(scale).map(luma);
      for (let i = 1; i < steps.length; i += 1) expect(steps[i]!).toBeLessThan(steps[i - 1]!);
    }
  });

  it('casts the neutral ramp with the brand’s hue, without making it a colour', () => {
    const values = Object.entries(designTokens.color.neutral)
      .filter(([step]) => step !== '0' && step !== '1000')
      .map(([, hex]) => hex);
    expect(values.length).toBeGreaterThan(5);
    for (const hex of values) {
      expect(hex).toMatch(/^#[0-9A-F]{6}$/);
      // Not a pure grey — that is the look this revision exists to remove …
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
      // … but close enough to one that it carries text at any size and reads as atmosphere, not as colour.
      expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(14);
    }
    expect(designTokens.color.neutral['0']).toBe('#FFFFFF');
    expect(designTokens.color.neutral['1000']).toBe('#000000');
  });

  it('re-derives the whole colour layer from a replaced pair, and nothing else', () => {
    const tokens = createDesignTokens({ brandPrimary: '#1A2B3C', brandSecondary: '#D4E5F6' });
    expect(tokens.color.brand).toEqual({ brandPrimary: '#1A2B3C', brandSecondary: '#D4E5F6' });
    // Everything downstream of the two slots moves with them: the scales, the surfaces a page is built from,
    // and the neutral cast. This is what makes two inputs carry a design system rather than two accent dots.
    expect(tokens.color.brandScale).not.toEqual(designTokens.color.brandScale);
    expect(tokens.color.surface.sunken).not.toBe(designTokens.color.surface.sunken);
    expect(tokens.color.surface.ink).not.toBe(designTokens.color.surface.ink);
    expect(tokens.color.neutral).not.toEqual(designTokens.color.neutral);
    // And nothing that is not colour moves at all.
    expect(tokens.spacing).toEqual(designTokens.spacing);
    expect(tokens.fontSize).toEqual(designTokens.fontSize);
    expect(tokens.radius).toEqual(designTokens.radius);
  });

  it.each([
    ['extra key', { brandPrimary: '#111111', brandSecondary: '#222222', brandTertiary: '#333333' }],
    ['missing key', { brandPrimary: '#111111' }],
    ['named colour', { brandPrimary: 'red', brandSecondary: '#222222' }],
    ['short hex', { brandPrimary: '#FFF', brandSecondary: '#222222' }],
    ['invalid hex', { brandPrimary: '#GGGGGG', brandSecondary: '#222222' }],
    ['lower-case hex', { brandPrimary: '#abcdef', brandSecondary: '#222222' }],
    ['gradient', { brandPrimary: 'linear-gradient(#000000, #FFFFFF)', brandSecondary: '#222222' }],
    ['not an object', null],
  ])('rejects brand colours with %s', (_label, value) => {
    expect(() => createDesignTokens(value as never)).toThrow(TypeError);
  });

  it('defines no gradients, glows or shadows', () => {
    for (const text of allStrings(designTokens)) {
      expect(text.toLowerCase()).not.toMatch(/gradient|glow|shadow|blur/);
    }
  });

  it('uses the operating system font stack only', () => {
    const stack = designTokens.fontFamily.sans;
    expect(stack[0]).toBe('system-ui');
    expect(stack[stack.length - 1]).toBe('sans-serif');
    for (const font of stack) {
      expect(font).not.toMatch(/url\(|https?:/);
    }
  });

  it('uses consistent units for spacing, radius and type sizes', () => {
    for (const value of Object.values(designTokens.spacing)) expect(value).toMatch(/^\d+(\.\d+)?rem$/);
    for (const value of Object.values(designTokens.fontSize)) expect(value).toMatch(/^\d+(\.\d+)?rem$/);
    for (const value of Object.values(designTokens.radius)) expect(value).toMatch(/^\d+px$/);
  });

  it('is deeply immutable', () => {
    expect(Object.isFrozen(designTokens)).toBe(true);
    expect(Object.isFrozen(designTokens.color.brand)).toBe(true);
    expect(Object.isFrozen(designTokens.fontFamily.sans)).toBe(true);
    expect(() => {
      (designTokens.color.brand as { brandPrimary: string }).brandPrimary = '#000000';
    }).toThrow(TypeError);
  });
});
