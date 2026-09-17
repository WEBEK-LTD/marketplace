import { describe, expect, it } from 'vitest';
import { BRAND_COLOR_KEYS, createDesignTokens, designTokens, PLACEHOLDER_BRAND_COLORS } from '../src/index.js';

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

  it('uses neutral grey placeholders for the brand colours', () => {
    expect(isGrey(PLACEHOLDER_BRAND_COLORS.brandPrimary)).toBe(true);
    expect(isGrey(PLACEHOLDER_BRAND_COLORS.brandSecondary)).toBe(true);
    expect(designTokens.color.brand).toEqual(PLACEHOLDER_BRAND_COLORS);
  });

  it('has a neutral grey scale only', () => {
    const values = Object.values(designTokens.color.neutral);
    expect(values.length).toBeGreaterThan(5);
    for (const hex of values) {
      expect(hex).toMatch(/^#[0-9A-F]{6}$/);
      expect(isGrey(hex)).toBe(true);
    }
  });

  it('replaces the brand colours without touching anything else', () => {
    const tokens = createDesignTokens({ brandPrimary: '#1A2B3C', brandSecondary: '#D4E5F6' });
    expect(tokens.color.brand).toEqual({ brandPrimary: '#1A2B3C', brandSecondary: '#D4E5F6' });
    expect(tokens.color.neutral).toEqual(designTokens.color.neutral);
    expect(tokens.spacing).toEqual(designTokens.spacing);
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
