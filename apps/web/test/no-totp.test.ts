import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import enMessages from '../messages/en.json';
import arMessages from '../messages/ar.json';
import * as bff from '../src/server/bff/index';

/**
 * Ordinary accounts are not mandatory-TOTP accounts (Phase 7-B, requirement 3).
 *
 * The second factor belongs to staff, and staff work on the console. This file asserts the separation from the
 * public side: the public surface has no TOTP route, no TOTP page, no TOTP handler and no TOTP copy, so there is
 * nothing here that could ask a buyer or a seller to enrol — and nothing that could refuse one who has not.
 *
 * The rule itself lives where it always has, in the database: `public.roles.requires_mfa` is false for
 * guest, buyer and seller and true for the four staff roles, and `public.has_role` honours it. Phase 7-B
 * changed neither. `supabase/tests/0101_totp_aal2_step_up.test.sql` proves that half; this proves that
 * the public surface never reaches for it.
 *
 * **Re-rooted in 0108, not weakened** (owner decision DR-5). Until 0108 the console was its own application, so
 * "this app's source tree" and "the public surface" were the same directory and one root was enough. The console now
 * lives in `src/admin/` and `src/app/admin/` inside the same application, where a TOTP page is exactly where it
 * belongs — so scanning the whole of `src/` would fail on the console's own correct code and prove nothing about
 * the public surface. The roots below are therefore the public surface's own directories, enumerated rather than
 * derived, and {@link PUBLIC_ROOTS} is held to the directory listing by its own assertion: a new top-level
 * directory under `src/` is either declared public here or declared part of the console, and cannot simply fall
 * outside the scan unnoticed.
 */

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

/** Every top-level entry under `src/` that belongs to the console rather than the public surface. */
const CONSOLE_ENTRIES = ['admin'] as const;

/** The public surface's own roots. Everything under `src/` that is not the console's. */
const PUBLIC_ROOTS = ['app', 'components', 'i18n', 'server', 'instrumentation.ts', 'proxy.ts', 'proxy-headers.ts'] as const;

/** `src/app/` minus the console's own route subtree. */
const CONSOLE_ROUTE_DIR = 'app/admin';

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? sources(full) : statSync(full).isFile() ? [full] : [];
  });
}

/** Every file on the public surface: the roots above, with the console's route subtree removed. */
function publicSources(): string[] {
  const consoleRoute = join(SRC, CONSOLE_ROUTE_DIR);
  return PUBLIC_ROOTS.flatMap((root) => {
    const full = join(SRC, root);
    const found = statSync(full).isDirectory() ? sources(full) : [full];
    return found.filter((file) => !file.startsWith(`${consoleRoute}/`));
  });
}

describe('the public web app and the second factor', () => {
  it('scans every public root, so a new directory cannot escape the rule by being new', () => {
    // The guard on the guard. `PUBLIC_ROOTS` is a hand-written list, and a hand-written list goes stale silently:
    // a future `src/lib/` would simply never be scanned. Held to the directory listing instead, it cannot.
    const entries = readdirSync(SRC, { withFileTypes: true })
      .map((entry) => entry.name)
      .filter((name) => !name.startsWith('.'))
      .sort();
    const declared = [...PUBLIC_ROOTS, ...CONSOLE_ENTRIES].sort();
    expect(entries).toEqual(declared);
  });

  it('exports no TOTP, MFA or step-up handler', () => {
    for (const name of Object.keys(bff)) {
      const lowered = name.toLowerCase();
      expect(lowered, name).not.toContain('totp');
      expect(lowered, name).not.toContain('mfa');
      expect(lowered, name).not.toContain('stepup');
      expect(lowered, name).not.toContain('step_up');
    }
  });

  it('has no TOTP route and no TOTP page', () => {
    const paths = publicSources().map((file) => file.slice(SRC.length));
    for (const path of paths) {
      const lowered = path.toLowerCase();
      expect(lowered, path).not.toContain('totp');
      expect(lowered, path).not.toContain('authenticator');
      expect(lowered, path).not.toContain('two-factor');
    }
  });

  it('asks a buyer or a seller for a second factor nowhere in its copy', () => {
    // A sentence that does not exist cannot be shown, whatever a future branch might try to render.
    const copy = (JSON.stringify(enMessages) + JSON.stringify(arMessages)).toLowerCase();
    for (const phrase of [
      'authenticator',
      'two-factor',
      'two factor',
      'totp',
      'verification app',
      'المصادقة الثنائية',
    ]) {
      expect(copy, phrase).not.toContain(phrase);
    }
  });

  it('names no admin cookie, so a staff session cannot be made or read here', () => {
    // The two surfaces keep separate sessions under separate cookie names; an `aal2` staff token has no meaning on
    // the public one, and the public surface must not be able to mint or read one even now that they share a host.
    for (const file of publicSources()) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toContain('__Host-mp_admin_access');
      expect(text, file).not.toContain('__Host-mp_admin_totp_challenge');
    }
  });
});
