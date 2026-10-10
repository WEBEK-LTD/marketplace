import { designTokens, type DesignTokens } from './design-tokens.js';

/** CSS custom property names used by the applications' Tailwind `@theme` blocks. */
export function tokenVariables(tokens: DesignTokens = designTokens): Readonly<Record<string, string>> {
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(tokens.color.neutral)) vars[`--token-color-neutral-${key}`] = value;
  vars['--token-color-brand-primary'] = tokens.color.brand.brandPrimary;
  vars['--token-color-brand-secondary'] = tokens.color.brand.brandSecondary;
  // The eleven derived steps per slot. These are what components actually reference.
  for (const [step, value] of Object.entries(tokens.color.brandScale)) vars[`--token-brand-${step}`] = value;
  for (const [step, value] of Object.entries(tokens.color.accentScale)) vars[`--token-accent-${step}`] = value;
  for (const [key, value] of Object.entries(tokens.color.surface)) vars[`--token-surface-${key}`] = value;
  for (const [key, value] of Object.entries(tokens.color.text)) vars[`--token-text-color-${key}`] = value;
  for (const [key, value] of Object.entries(tokens.color.border)) vars[`--token-border-${key}`] = value;
  for (const [key, value] of Object.entries(tokens.color.state)) vars[`--token-state-${key}`] = value;
  vars['--token-font-sans'] = tokens.fontFamily.sans.join(', ');
  vars['--token-font-arabic'] = tokens.fontFamily.arabic.join(', ');
  for (const [key, value] of Object.entries(tokens.fontSize)) vars[`--token-text-${key}`] = value;
  for (const [key, value] of Object.entries(tokens.fontWeight)) vars[`--token-weight-${key}`] = value;
  for (const [key, value] of Object.entries(tokens.letterSpacing)) vars[`--token-tracking-${key}`] = value;
  for (const [key, value] of Object.entries(tokens.spacing)) vars[`--token-spacing-${key}`] = value;
  for (const [key, value] of Object.entries(tokens.radius)) vars[`--token-radius-${key}`] = value;
  for (const [key, value] of Object.entries(tokens.lineHeight)) vars[`--token-leading-${key}`] = value;
  for (const [key, value] of Object.entries(tokens.shadow)) vars[`--token-shadow-${key}`] = value;
  return Object.freeze(vars);
}

/** Emits the tokens as a `:root` CSS block (written to dist/tokens.css at build time). */
export function tokensToCss(tokens: DesignTokens = designTokens): string {
  const lines = Object.entries(tokenVariables(tokens)).map(([name, value]) => `  ${name}: ${value};`);
  return `/* Generated from @repo/config design tokens. Do not edit. */\n:root {\n${lines.join('\n')}\n}\n`;
}
