import { designTokens, type DesignTokens } from './design-tokens.js';

/** CSS custom property names used by the applications' Tailwind `@theme` blocks. */
export function tokenVariables(tokens: DesignTokens = designTokens): Readonly<Record<string, string>> {
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(tokens.color.neutral)) vars[`--token-color-neutral-${key}`] = value;
  vars['--token-color-brand-primary'] = tokens.color.brand.brandPrimary;
  vars['--token-color-brand-secondary'] = tokens.color.brand.brandSecondary;
  vars['--token-font-sans'] = tokens.fontFamily.sans.join(', ');
  for (const [key, value] of Object.entries(tokens.fontSize)) vars[`--token-text-${key}`] = value;
  for (const [key, value] of Object.entries(tokens.spacing)) vars[`--token-spacing-${key}`] = value;
  for (const [key, value] of Object.entries(tokens.radius)) vars[`--token-radius-${key}`] = value;
  return Object.freeze(vars);
}

/** Emits the tokens as a `:root` CSS block (written to dist/tokens.css at build time). */
export function tokensToCss(tokens: DesignTokens = designTokens): string {
  const lines = Object.entries(tokenVariables(tokens)).map(([name, value]) => `  ${name}: ${value};`);
  return `/* Generated from @repo/config design tokens. Do not edit. */\n:root {\n${lines.join('\n')}\n}\n`;
}
