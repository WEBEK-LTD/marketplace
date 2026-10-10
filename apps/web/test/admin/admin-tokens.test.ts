import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The console is built from the design system, not from greys that happen to match.
 *
 * **Why this file exists.** `packages/ui` has been held to this rule since the visual system was built: a
 * component asking for `neutral-200` has made a value judgement that belongs in the token file, while one
 * asking for `border-hairline` has named a role. The console was exempt, because 0109 was told to leave it
 * alone and visually isolated — and the exemption had a consequence nobody predicted until the owner's brand
 * arrived. A surface written against `neutral-200` and `bg-neutral-900` **cannot inherit a brand**: those are
 * not decisions about anything, so there is nothing for a brand colour to flow into. The public site turned
 * emerald the moment the two slots changed and the console stayed grey, which is the whole reason this rule
 * now covers both.
 *
 * The rule is on the *statements*, not on the prose: comments are stripped first, because a comment that
 * explains why a grey was replaced is not a grey. That false-positive class has broken six detectors in this
 * repository and will not break a seventh.
 */

const ADMIN = join(import.meta.dirname, '..', '..', 'src', 'admin');
const ADMIN_PAGES = join(import.meta.dirname, '..', '..', 'src', 'app', 'admin');

function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sources(join(dir, entry.name))
      : /\.tsx?$/.test(entry.name)
        ? [join(dir, entry.name)]
        : [],
  );
}

const files = [...sources(ADMIN), ...sources(ADMIN_PAGES)];

describe('the console speaks to the semantic ladder', () => {
  it('reads a console worth checking, so the rule cannot pass by finding nothing', () => {
    expect(files.length).toBeGreaterThan(60);
  });

  it('asks for no raw neutral step anywhere', () => {
    for (const file of files) {
      const text = withoutComments(readFileSync(file, 'utf8'));
      expect(
        /\b(?:bg|text|border|divide|ring|fill|decoration|accent|outline|placeholder)-neutral-\d/.test(text),
        `${file}: raw ramp`,
      ).toBe(false);
    }
  });

  it('asks for no bare white or black either', () => {
    // `bg-white` is the same mistake in a shorter word: the page's own surface is `surface-canvas` and a
    // panel's is `surface-raised`, and those are the two that move when a brand says the product is not
    // built on pure white after all.
    for (const file of files) {
      const text = withoutComments(readFileSync(file, 'utf8'));
      expect(
        /\b(?:bg|text|border|divide|ring|outline)-(?:white|black)\b/.test(text),
        `${file}: bare white or black`,
      ).toBe(false);
    }
  });

  it('hard-codes no colour of any kind, which is D5', () => {
    for (const file of files) {
      const text = withoutComments(readFileSync(file, 'utf8'));
      expect(/#[0-9a-fA-F]{3,8}\b|\brgb\(|\bhsl\(|\boklch\(/.test(text), `${file}: hard-coded colour`).toBe(
        false,
      );
    }
  });

  it('gives the console one inverted masthead, defined once', () => {
    // The console's identity is that bar. Defined in two places it would drift; defined in none it would be
    // a grey document indistinguishable from the storefront it shares an origin with (0108).
    const ui = readFileSync(join(ADMIN, 'ui.ts'), 'utf8');
    expect(ui).toContain("ADMIN_HEADER = 'bg-surface-ink text-on-ink'");
    // Its definition and exactly one use. A second use would mean a second masthead.
    const usages = files.filter((file) => /ADMIN_HEADER\b/.test(readFileSync(file, 'utf8')));
    expect(usages.map((file) => file.slice(ADMIN.length + 1)).sort()).toEqual([
      'components/admin-document.tsx',
      'ui.ts',
    ]);
  });
});
