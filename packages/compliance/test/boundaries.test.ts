import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The architectural boundary around the provisional layer.
 *
 * `pnpm run depcruise` enforces this for real on every gate run, and the rule was proven to fire against a
 * planted violation before being committed. What this file pins is that the rule still **exists** and still
 * says what it was written to say: a rule quietly deleted or narrowed would leave the gate green while
 * enforcing nothing.
 */

const CONFIG = readFileSync(new URL('../../../.dependency-cruiser.cjs', import.meta.url), 'utf8');

describe('the dependency-cruiser rule that keeps the compliance layer replaceable', () => {
  it('exists and is an error, not a warning', () => {
    const index = CONFIG.indexOf('name: "compliance-standalone"');
    expect(index).toBeGreaterThan(-1);
    expect(CONFIG.slice(index, index + 200)).toContain('severity: "error"');
  });

  it('forbids the layer from importing any workspace package or framework', () => {
    expect(CONFIG).toContain('from: { path: "^packages/compliance/src/" }');
    expect(CONFIG).toContain('to: { path: "(^apps/|^packages/(?!compliance/)|(^|/)node_modules/(?!typescript))" }');
  });
});

describe('the package manifest', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as Record<string, unknown>;

  it('is private and declares no dependency at all', () => {
    expect(manifest.private).toBe(true);
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.devDependencies).toBeUndefined();
    expect(manifest.peerDependencies).toBeUndefined();
    expect(manifest.optionalDependencies).toBeUndefined();
  });

  it('exposes one entry point', () => {
    const exports = manifest.exports as Record<string, { default: string }>;
    expect(Object.keys(exports)).toEqual(['.']);
    expect(exports['.']?.default).toBe('./dist/index.js');
  });
});

describe('the documentation', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

  it('states that the layer is not legal, regulatory or tax approval', () => {
    expect(readme).toContain('not legal advice');
    expect(readme).toContain('not legal approval');
    expect(readme).toContain('not regulatory approval');
    expect(readme).toContain('not tax approval');
  });

  it('records that no primary Egyptian legal text was read', () => {
    expect(readme).toContain('no Egyptian primary legal text had been read');
  });

  it('explains that a counsel finding replaces a rule without rewriting financial code', () => {
    expect(readme).toContain('Their code does not');
    expect(readme).toContain('How a counsel finding replaces a rule');
  });

  it('records that the financial blockers and the posting gate are unchanged', () => {
    expect(readme).toContain('finance.settlement_posting_enabled = FALSE');
    expect(readme).toContain('B1-C OPEN');
    expect(readme).toContain('UB8 OPEN');
  });
});
