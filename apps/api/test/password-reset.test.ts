import { createHash } from 'node:crypto';
import { inspect as utilInspect } from 'node:util';
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PasswordResetService,
  type ConsumeResetTokenInput,
  type ConsumeResetTokenRow,
  type IssueResetTokenInput,
  type IssueResetTokenRow,
  type PasswordResetTokenStore,
} from '../src/auth/password-reset/password-reset.service.js';
import {
  RESET_TOKEN_LENGTH,
  ResetToken,
  generateResetToken,
  isResetTokenShaped,
  resetDigestsEqual,
  resetTokenDigest,
} from '../src/auth/password-reset/reset-token.js';

/**
 * The C-18 reset-token lifecycle, on the application side.
 *
 * The database owns atomicity and is tested in pgTAP; what is proved here is everything the API is
 * responsible for: that the token is unguessable and URL-safe, that only its digest ever leaves this
 * process, that every refusal looks the same from outside, and that the clear value cannot reach a log,
 * an error or a response by accident.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';

interface StubCalls {
  readonly issued: IssueResetTokenInput[];
  readonly consumed: ConsumeResetTokenInput[];
}

function store(
  behaviour: {
    issue?: (input: IssueResetTokenInput) => Promise<IssueResetTokenRow> | IssueResetTokenRow;
    consume?: (input: ConsumeResetTokenInput) => Promise<ConsumeResetTokenRow> | ConsumeResetTokenRow;
  } = {},
): PasswordResetTokenStore & StubCalls {
  const issued: IssueResetTokenInput[] = [];
  const consumed: ConsumeResetTokenInput[] = [];
  return {
    issued,
    consumed,
    async issuePasswordResetToken(input) {
      issued.push(input);
      return (
        behaviour.issue?.(input) ?? {
          outcome: 'issued' as const,
          tokenId: 'aaaaaaaa-0000-4000-8000-000000000001',
          expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        }
      );
    },
    async consumePasswordResetToken(input) {
      consumed.push(input);
      return (
        behaviour.consume?.(input) ?? {
          outcome: 'consumed' as const,
          userId: USER,
          tokenId: 'aaaaaaaa-0000-4000-8000-000000000001',
        }
      );
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the reset token itself', () => {
  it('is 256 bits of randomness rendered URL-safe', () => {
    const token = generateResetToken().reveal();
    expect(token).toHaveLength(RESET_TOKEN_LENGTH);
    // Nothing that a URL would have to escape, because this value travels in a reset link.
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(token)).toBe(token);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
  });

  it('is different every time', () => {
    const tokens = new Set(Array.from({ length: 500 }, () => generateResetToken().reveal()));
    expect(tokens.size).toBe(500);
  });

  it('is stored as the SHA-256 digest of the clear value, and nothing else', () => {
    const token = generateResetToken();
    const clear = token.reveal();
    expect(token.digest()).toEqual(createHash('sha256').update(clear, 'utf8').digest());
    expect(token.digest()).toHaveLength(32);
    // The digest is not the token: it does not contain it and cannot be read back into it.
    expect(token.digest().toString('base64url')).not.toBe(clear);
  });

  it('hashes a submitted token to the same value, and refuses one of the wrong shape', () => {
    const token = generateResetToken();
    expect(resetDigestsEqual(resetTokenDigest(token.reveal()), token.digest())).toBe(true);
    expect(resetDigestsEqual(resetTokenDigest(token.reveal()), generateResetToken().digest())).toBe(false);

    for (const bad of ['', 'short', `${token.reveal()}x`, `${token.reveal().slice(0, 42)}+`, 'a'.repeat(44)]) {
      expect(isResetTokenShaped(bad)).toBe(false);
      expect(() => resetTokenDigest(bad)).toThrow(RangeError);
    }
    expect(isResetTokenShaped(token.reveal())).toBe(true);
  });

  it('redacts itself everywhere a value normally leaks', () => {
    const token = generateResetToken();
    const clear = token.reveal();

    expect(String(token)).toBe('[redacted]');
    expect(`${token}`).not.toContain(clear);
    expect(JSON.stringify(token)).toBe('"[redacted]"');
    expect(JSON.stringify({ token })).not.toContain(clear);
    expect(utilInspect(token)).not.toContain(clear);
    expect(utilInspect({ nested: { token } }, { depth: 5 })).not.toContain(clear);
    // Even an error that happens to carry the object.
    const error = new Error(`reset failed: ${String(token)}`);
    expect(`${error.stack ?? ''}${error.message}`).not.toContain(clear);
    expect(() => new ResetToken('not-a-token')).toThrow(RangeError);
    // And the constructor's own complaint names no value.
    expect(() => new ResetToken('not-a-token')).toThrow(/URL-safe base64 characters/);
  });
});

describe('issuing a reset token', () => {
  it('sends only the digest to the database, never the token', async () => {
    const db = store();
    const result = await new PasswordResetService(db).issue({ userId: USER, requestIp: '203.0.113.7' });

    expect(result.status).toBe('issued');
    if (result.status !== 'issued') return;

    expect(db.issued).toHaveLength(1);
    const input = db.issued[0];
    expect(input?.userId).toBe(USER);
    expect(input?.requestIp).toBe('203.0.113.7');
    expect(input?.tokenHash).toEqual(result.token.digest());
    // The clear token appears nowhere in what was sent.
    expect(JSON.stringify(input)).not.toContain(result.token.reveal());
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('answers a missing account exactly as it answers a real one, without touching the database', async () => {
    const db = store();
    const result = await new PasswordResetService(db).issue({ userId: null });

    expect(result).toEqual({ status: 'not_issued', reason: 'unknown_user' });
    expect(db.issued).toHaveLength(0);
  });

  it('treats an unknown account reported by the database the same way', async () => {
    const db = store({ issue: () => ({ outcome: 'unknown_user', tokenId: null, expiresAt: null }) });
    const result = await new PasswordResetService(db).issue({ userId: USER });

    expect(result).toEqual({ status: 'not_issued', reason: 'unknown_user' });
  });

  it('does not issue anything when the database fails, and says nothing about the failure outwardly', async () => {
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const db = store({
      issue: () => Promise.reject(new Error('connection terminated: insert into app_private...')),
    });

    const result = await new PasswordResetService(db).issue({ userId: USER });

    expect(result).toEqual({ status: 'not_issued', reason: 'store_unavailable' });
    // Shape-identical to the unknown-account answer: one field, one of two internal reasons, no token.
    expect(Object.keys(result).sort()).toEqual(['reason', 'status']);
    // What was logged carries the error's type, not the statement it failed on.
    expect(logged).toHaveBeenCalledWith('Issuing a password reset token failed.', 'Error');
  });

  it('never puts the clear token in anything it logs', async () => {
    const lines: unknown[] = [];
    for (const level of ['log', 'error', 'warn', 'debug', 'verbose'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        lines.push(...args);
      });
    }

    const service = new PasswordResetService(store());
    const issued = await service.issue({ userId: USER });
    await service.consume({ token: issued.status === 'issued' ? issued.token.reveal() : 'x' });

    expect(issued.status).toBe('issued');
    if (issued.status !== 'issued') return;
    const printed = lines.map((line) => utilInspect(line)).join('\n');
    expect(printed).not.toContain(issued.token.reveal());
  });
});

describe('consuming a reset token', () => {
  const service = (db: PasswordResetTokenStore) => new PasswordResetService(db);

  it('accepts a valid token and returns the account it is bound to', async () => {
    const db = store();
    const token = generateResetToken();
    const result = await service(db).consume({ token: token.reveal(), expectedUserId: USER });

    expect(result).toEqual({ status: 'consumed', userId: USER, tokenId: 'aaaaaaaa-0000-4000-8000-000000000001' });
    expect(db.consumed[0]?.tokenHash).toEqual(token.digest());
    expect(db.consumed[0]?.expectedUserId).toBe(USER);
  });

  it.each([
    ['expired', 'expired'],
    ['already consumed', 'already_consumed'],
    ['for another account', 'wrong_user'],
    ['unknown', 'not_found'],
  ] as const)('refuses a token that is %s', async (_label, outcome) => {
    const db = store({ consume: () => ({ outcome, userId: null, tokenId: null }) });
    const result = await service(db).consume({ token: generateResetToken().reveal(), expectedUserId: USER });

    expect(result).toEqual({ status: 'rejected', reason: outcome });
    // Every refusal has the same shape, and none of them names an account.
    expect(Object.keys(result).sort()).toEqual(['reason', 'status']);
    expect(JSON.stringify(result)).not.toContain(USER);
    expect(JSON.stringify(result)).not.toContain(OTHER_USER);
  });

  it('never sends a malformed token to the database', async () => {
    const db = store();
    const result = await service(db).consume({ token: 'obviously-not-a-reset-token' });

    expect(result).toEqual({ status: 'rejected', reason: 'malformed' });
    expect(db.consumed).toHaveLength(0);
  });

  it('refuses when the database fails, rather than assuming the token was good', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const db = store({ consume: () => Promise.reject(new Error('connection terminated')) });

    const result = await service(db).consume({ token: generateResetToken().reveal() });

    expect(result).toEqual({ status: 'rejected', reason: 'store_unavailable' });
  });

  it('refuses a success the database reports without an account', async () => {
    const db = store({ consume: () => ({ outcome: 'consumed', userId: null, tokenId: null }) });
    const result = await service(db).consume({ token: generateResetToken().reveal() });

    expect(result).toEqual({ status: 'rejected', reason: 'store_unavailable' });
  });

  it('lets exactly one of several simultaneous consumptions win', async () => {
    // The stub stands in for the row lock: the first call through takes the token, the rest are told it
    // is already consumed. What is proved here is that the service reports one winner and does not
    // decide for itself which caller succeeded.
    let taken = false;
    const db = store({
      consume: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (taken) return { outcome: 'already_consumed' as const, userId: null, tokenId: null };
        taken = true;
        return { outcome: 'consumed' as const, userId: USER, tokenId: 'aaaaaaaa-0000-4000-8000-000000000001' };
      },
    });

    const token = generateResetToken().reveal();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => service(db).consume({ token, expectedUserId: USER })),
    );

    expect(results.filter((result) => result.status === 'consumed')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(7);
    expect(db.consumed).toHaveLength(8);
    // Every attempt presented the same digest; none of them presented a token.
    for (const call of db.consumed) expect(call.tokenHash).toEqual(resetTokenDigest(token));
  });

  it('puts no token in a result a response could be built from', async () => {
    const db = store();
    const token = generateResetToken();
    const result = await service(db).consume({ token: token.reveal() });

    expect(JSON.stringify(result)).not.toContain(token.reveal());
    expect(utilInspect(result, { depth: 5 })).not.toContain(token.reveal());
  });
});

describe('the new password', () => {
  const service = new PasswordResetService(store());

  it('is judged by the approved policy, not by one invented here', () => {
    expect(service.validateNewPassword('correct horse battery staple')).toEqual({ valid: true, issues: [] });
    expect(service.validateNewPassword('short')).toEqual({ valid: false, issues: ['password_too_short'] });
    // D1 measures the maximum in UTF-8 bytes, so 40 Arabic characters are already over it.
    expect(service.validateNewPassword('ا'.repeat(40))).toEqual({
      valid: false,
      issues: ['password_too_many_utf8_bytes'],
    });
  });

  it('is never echoed back in the issues it reports', () => {
    const result = service.validateNewPassword('secret');
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});
