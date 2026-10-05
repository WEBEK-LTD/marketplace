import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Phase 8-C — the architectural boundaries around the ports.
 *
 * `pnpm run depcruise` enforces these for real, on every gate run, and each was proven to fire against a
 * planted violation before being committed. What this file pins is that the rules still **exist** and still
 * say what they were written to say: a rule that was quietly deleted or narrowed would otherwise leave the
 * gate green while enforcing nothing.
 */

const CONFIG = readFileSync(new URL('../../../.dependency-cruiser.cjs', import.meta.url), 'utf8');

describe('the dependency-cruiser rules that protect the provider boundary', () => {
  it('forbids domain code from importing a provider adapter (v5.2)', () => {
    expect(CONFIG).toContain('name: "provider-adapters-isolated"');
    // Only a module file may name an adapter directory; everything else in apps and packages may not.
    expect(CONFIG).toContain('to: { path: "(^|/)adapters/" }');
    expect(CONFIG).toContain('pathNot: "((^|/)adapters/|\\\\.module\\\\.ts$)"');
  });

  it('forbids production code from importing the test doubles (G11)', () => {
    expect(CONFIG).toContain('name: "provider-test-doubles-not-in-production"');
    expect(CONFIG).toContain('to: { path: "^packages/provider-ports/(src/testing/|dist/testing/)" }');
  });

  it('keeps the ports standalone: no workspace package, no framework', () => {
    expect(CONFIG).toContain('name: "provider-ports-standalone"');
    expect(CONFIG).toContain('from: { path: "^packages/provider-ports/src/" }');
  });

  it('declares all three as errors, not warnings', () => {
    for (const rule of [
      'provider-adapters-isolated',
      'provider-test-doubles-not-in-production',
      'provider-ports-standalone',
    ]) {
      const index = CONFIG.indexOf(`name: "${rule}"`);
      expect(index, rule).toBeGreaterThan(-1);
      expect(CONFIG.slice(index, index + 200)).toContain('severity: "error"');
    }
  });
});

describe('the package manifest', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as Record<string, unknown>;

  it('is private and declares no dependency at all', () => {
    expect(manifest.private).toBe(true);
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.devDependencies).toBeUndefined();
    expect(manifest.peerDependencies).toBeUndefined();
    expect(manifest.optionalDependencies).toBeUndefined();
  });

  it('exposes the ports and the doubles as two separate entry points', () => {
    const exports = manifest.exports as Record<string, { default: string }>;
    expect(Object.keys(exports).sort()).toEqual(['.', './testing']);
    expect(exports['.']?.default).toBe('./dist/index.js');
    expect(exports['./testing']?.default).toBe('./dist/testing/index.js');
  });
});
