import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createDesignTokens, designTokens, tokensToCss, tokenVariables } from '../src/index.js';

describe('design tokens as CSS variables', () => {
  it('exposes every token, including exactly two brand colours', () => {
    const vars = tokenVariables();
    expect(vars['--token-color-brand-primary']).toBe(designTokens.color.brand.brandPrimary);
    expect(vars['--token-color-brand-secondary']).toBe(designTokens.color.brand.brandSecondary);
    expect(Object.keys(vars).filter((name) => name.startsWith('--token-color-brand-'))).toHaveLength(2);
    expect(Object.keys(vars).filter((name) => name.startsWith('--token-color-neutral-'))).toHaveLength(
      Object.keys(designTokens.color.neutral).length,
    );
    expect(vars['--token-font-sans']?.startsWith('system-ui')).toBe(true);
    expect(vars['--token-spacing-1']).toBe('0.25rem');
  });

  it('follows replaced brand colours', () => {
    const css = tokensToCss(createDesignTokens({ brandPrimary: '#1A2B3C', brandSecondary: '#D4E5F6' }));
    expect(css).toContain('--token-color-brand-primary: #1A2B3C;');
    expect(css).toContain('--token-color-brand-secondary: #D4E5F6;');
  });

  it('writes a :root block with no gradients or glows', () => {
    const css = tokensToCss();
    expect(css.startsWith('/* Generated from @repo/config design tokens. Do not edit. */\n:root {')).toBe(true);
    expect(css.toLowerCase()).not.toMatch(/gradient|glow|shadow|url\(/);
  });

  it('the built dist/tokens.css matches the generator', () => {
    const built = readFileSync(new URL('../dist/tokens.css', import.meta.url), 'utf8');
    expect(built).toBe(tokensToCss());
  });
});
