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
 * The second factor belongs to staff, and staff work on the admin origin. This file asserts the
 * separation from the public side: the web app has no TOTP route, no TOTP page, no TOTP handler and no
 * TOTP copy, so there is nothing here that could ask a buyer or a seller to enrol — and nothing that
 * could refuse one who has not.
 *
 * The rule itself lives where it always has, in the database: `public.roles.requires_mfa` is false for
 * guest, buyer and seller and true for the four staff roles, and `public.has_role` honours it. Phase 7-B
 * changed neither. `supabase/tests/0101_totp_aal2_step_up.test.sql` proves that half; this proves that
 * the public application never reaches for it.
 */

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? sources(full) : statSync(full).isFile() ? [full] : [];
  });
}

describe('the public web app and the second factor', () => {
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
    const paths = sources(SRC).map((file) => file.slice(SRC.length));
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
    // The two origins keep separate sessions; an `aal2` staff token has no meaning on the public one.
    for (const file of sources(SRC)) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toContain('__Host-mp_admin_access');
      expect(text, file).not.toContain('__Host-mp_admin_totp_challenge');
    }
  });
});
