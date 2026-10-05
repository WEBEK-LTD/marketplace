import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  LIVE_MONEY_WRITERS,
  LiveMoneyBlockedError,
  assertLiveMoneyBlocked,
  isLiveMoneyWriter,
  liveMoneyPermitted,
} from '../src/index.js';

describe('the live-money guard', () => {
  it('refuses every operation while the baseline is provisional', () => {
    expect(() => assertLiveMoneyBlocked('creating a payout')).toThrow(LiveMoneyBlockedError);
    try {
      assertLiveMoneyBlocked('creating a payout');
      expect.unreachable('the guard must never return');
    } catch (error) {
      expect(error).toBeInstanceOf(LiveMoneyBlockedError);
      expect((error as LiveMoneyBlockedError).operation).toBe('creating a payout');
      expect((error as LiveMoneyBlockedError).blockingRuleIds.length).toBeGreaterThan(0);
      expect((error as Error).message).toContain('PROVISIONAL_PENDING_EXTERNAL_COUNSEL');
    }
  });

  it('permits no live money, and offers no counterpart that would', () => {
    expect(liveMoneyPermitted()).toBe(false);
  });

  it('names the writers that create a permanent financial record', () => {
    for (const writer of [
      'app_private.settle_payout',
      'app_private.transition_withdrawal',
      'app_private.reconcile_settlement',
      'app_private.post_ledger_journal',
      'app_private.create_payout',
      'app_private.settle_payout_reversal',
    ]) {
      expect(isLiveMoneyWriter(writer), writer).toBe(true);
    }
    expect(isLiveMoneyWriter('public.site_setting')).toBe(false);
    expect(LIVE_MONEY_WRITERS).toHaveLength(15);
  });

  it('names every writer in the app_private schema, since none of them is a public read', () => {
    for (const writer of LIVE_MONEY_WRITERS) expect(writer, writer).toMatch(/^app_private\./);
  });
});

describe('the package is inert', () => {
  const sources = [
    'status.ts',
    'counsel.ts',
    'policy.ts',
    'sources.ts',
    'register.ts',
    'tax.ts',
    'payments.ts',
    'dataProtection.ts',
    'retention.ts',
    'flags.ts',
    'liveMoney.ts',
    'index.ts',
  ].map((name) => ({ name, text: readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8') }));

  it('reaches no network, reads no environment and holds no credential', () => {
    for (const { name, text } of sources) {
      for (const term of ['fetch(', 'process.env', 'apiKey', 'credential', 'Math.random', 'child_process']) {
        expect(text.toLowerCase().includes(term.toLowerCase()), `${name} mentions ${term}`).toBe(false);
      }
    }
  });

  it('reads no clock, so every recorded date comes from a written source', () => {
    for (const { name, text } of sources) {
      for (const term of ['Date.now', 'new Date(']) {
        expect(text.includes(term), `${name} mentions ${term}`).toBe(false);
      }
    }
  });

  it('imports nothing outside this package', () => {
    for (const { name, text } of sources) {
      for (const match of text.matchAll(/from '([^']+)'/g)) {
        const target = match[1] ?? '';
        expect(target.startsWith('./'), `${name} imports ${target}`).toBe(true);
      }
    }
  });

  it('cannot call a database writer, because it has no database access at all', () => {
    // Precise terms only: a bare "pg" also matches the word "upgraded", and a test that fails on prose
    // rather than on a dependency teaches nothing. The import-relativity test above is what actually
    // proves no driver is reachable.
    for (const { name, text } of sources) {
      for (const term of ['kysely', "from 'pg'", 'sql`', '.query(', '.execute(', 'Pool(', 'Client(']) {
        expect(text.includes(term), `${name} mentions ${term}`).toBe(false);
      }
    }
  });
});
