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

  it('writes a :root block with no gradients, glows or fetched assets', () => {
    const css = tokensToCss();
    expect(css.startsWith('/* Generated from @repo/config design tokens. Do not edit. */\n:root {')).toBe(true);
    expect(css.toLowerCase()).not.toMatch(/gradient|glow|url\(/);

    // 0109 made elevation part of the token contract, so `shadow` is no longer forbidden outright — but it is
    // allowed in exactly three places. The rule this assertion protects is that nothing else in the sheet
    // carries a shadow, and that each of the three is a real `box-shadow` value rather than a glow in disguise.
    const shadowLines = css
      .split('\n')
      .filter((line) => line.toLowerCase().includes('shadow'))
      .map((line) => line.trim());
    expect(shadowLines.map((line) => line.split(':')[0])).toEqual([
      '--token-shadow-xs',
      '--token-shadow-sm',
      '--token-shadow-md',
      '--token-shadow-lg',
      '--token-shadow-inkEdge',
    ]);
    for (const line of shadowLines) {
      if (line.startsWith('--token-shadow-inkEdge')) {
        // The one inset: a top-edge highlight in white, which is how a dark surface gets an edge without a
        // border drawn round it. It is a hairline by construction — no blur and no spread.
        expect(line).toBe('--token-shadow-inkEdge: inset 0 1px 0 0 rgb(255 255 255 / 0.06);');
        continue;
      }
      // An offset-and-blur triple in `rgb(... / alpha)`. A glow would have no vertical offset.
      expect(line).toMatch(/^--token-shadow-(?:xs|sm|md|lg): .*rgb\(0 0 0 \/ 0\.\d+\);$/);
      expect(line).not.toMatch(/ 0 0 \d+px/);
    }
  });

  it('the built dist/tokens.css matches the generator', () => {
    const built = readFileSync(new URL('../dist/tokens.css', import.meta.url), 'utf8');
    expect(built).toBe(tokensToCss());
  });
});
