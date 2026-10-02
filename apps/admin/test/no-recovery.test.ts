import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as bff from '../src/server/bff/index';

/**
 * The admin origin has no part in the password-reset flow (F3, owner decision 15) or in the phone
 * contact change (F4, owner decision 13).
 *
 * The approved flow is the public web app's alone: the admin app gets no recovery route, no recovery
 * page and — the assertion that matters — no `__Host-mp_reset` cookie. A reset cookie on this origin
 * would mean a reset started on the public site could authorise a password change from the admin
 * console, which is exactly the separation the two origins exist to keep.
 *
 * Privileged accounts recover through D10's support-assisted review, which this increment does not
 * touch.
 */

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? sources(full) : statSync(full).isFile() ? [full] : [];
  });
}

describe('the admin origin, password reset and contact change', () => {
  /**
   * 7-O gave D10's support-assisted review its screens, so the admin BFF now legitimately exports readers
   * and writers whose names contain "recovery". That is a different thing from F3's self-service reset, so
   * the name ban is replaced by naming the exports that may exist — a list this test owns, so a fourth one
   * appearing is a failure until somebody says why.
   */
  const RECOVERY_EXPORTS = [
    'handleRecoveryCompletion',
    'handleRecoveryDecision',
    'handleRecoveryReview',
    'readRecoveryEvidence',
    'readRecoveryQueue',
    'readRecoveryRequest',
  ];

  it('exports no reset or contact-change handler, and only D10’s recovery review', () => {
    const exported = Object.keys(bff).sort();
    for (const name of exported) {
      // F3 and F4 remain the public web origin's alone, whatever a name is spelled like.
      expect(name.toLowerCase()).not.toContain('reset');
      expect(name.toLowerCase()).not.toContain('contact');
      expect(name.toLowerCase()).not.toContain('password');
    }
    expect(exported.filter((name) => name.toLowerCase().includes('recovery')).sort()).toEqual(
      RECOVERY_EXPORTS,
    );
    expect(exported).toContain('handleLogin');
  });

  it('mentions the reset cookie nowhere in its source', () => {
    const text = sources(SRC)
      .filter((file) => file.endsWith('.ts') || file.endsWith('.tsx'))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain('__Host-mp_reset');
    expect(text).not.toContain('x-reset-token');
    expect(text).not.toContain('/v1/auth/recovery');
    // F4 lives on the public web origin alone: no route, no session-token header, no contact endpoint.
    expect(text).not.toContain('/v1/users/me/contact');
    expect(text).not.toContain('x-session-token');
  });

  it('has no reset or contact-change route or page', () => {
    const paths = sources(join(SRC, 'app')).map((file) => file.slice(SRC.length));
    for (const path of paths) {
      expect(path).not.toContain('forgot-password');
      expect(path).not.toContain('reset-password');
      expect(path).not.toContain('contact');
      expect(path).not.toContain('settings');
    }
  });

  /**
   * 7-F adds `/security/recovery`: the staff queue for D10's support-assisted review, which this
   * file's own preamble names as how privileged accounts recover. It is a different thing from F3's
   * self-service password reset, so the path guard above no longer forbids the word — and the
   * assertions below are what replace it, stated about behaviour rather than about a filename.
   */
  /**
   * 7-O turned the placeholder into D10's review surface: a queue, one request, and the three write routes
   * its steps post to. The count of pages is no longer the assertion — what they do is.
   */
  it('has only D10’s recovery review pages and routes, and none of them resets anything', () => {
    const paths = sources(join(SRC, 'app'))
      .map((file) => file.slice(SRC.length))
      .filter((path) => path.includes('recovery'))
      .sort();
    expect(paths).toEqual([
      'app/api/recovery/completion/route.ts',
      'app/api/recovery/decision/route.ts',
      'app/api/recovery/review/route.ts',
      'app/security/recovery/[requestId]/page.tsx',
      'app/security/recovery/page.tsx',
    ]);

    for (const path of paths) {
      const text = readFileSync(join(SRC, path), 'utf8').toLowerCase();
      // No password anywhere, no reset token, and nothing that reaches F3's own endpoints. The review
      // surface decides identity; it never sets a credential.
      for (const forbidden of ['password', 'reset-token', 'resettoken', '/v1/auth/', '__host-mp_reset']) {
        expect(text, `${path}: ${forbidden}`).not.toContain(forbidden);
      }
    }

    // The two pages read; only the three routes write, and each one delegates to the shared handler.
    for (const page of ['app/security/recovery/page.tsx', 'app/security/recovery/[requestId]/page.tsx']) {
      const text = readFileSync(join(SRC, page), 'utf8');
      expect(text, page).toContain('RequireStaff');
      expect(text, page).not.toContain('fetch');
    }
  });
});
