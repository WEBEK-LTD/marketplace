import { describe, expect, it } from 'vitest';
import {
  TotpChallengeRequestSchema,
  TotpProviderIdSchema,
  TotpChallengeResponseSchema,
  TotpCodeSchema,
  TotpEnrolmentResponseSchema,
  TotpOperationSchema,
  TotpStatusResponseSchema,
  TotpVerifyRequestSchema,
  TotpVerifyResponseSchema,
  generateOpenApiDocument,
} from '../src/index.js';

/**
 * The TOTP contracts (Phase 7-B).
 *
 * These tests hold the contract to the promises that make a second factor worth having, and almost all of
 * them are absences: **no request may name the factor or the challenge it is answering**, **no response
 * may carry a session or a token**, and **the secret appears in exactly one place**. So the assertions
 * check what cannot be expressed as carefully as what can.
 */

const CHALLENGE = '22222222-2222-4222-8222-222222222222';
const FACTOR = '33333333-3333-4333-8333-333333333333';

describe('the status', () => {
  it('has two values and nothing else', () => {
    expect(TotpStatusResponseSchema.safeParse({ status: 'not_enrolled' }).success).toBe(true);
    expect(TotpStatusResponseSchema.safeParse({ status: 'enrolled' }).success).toBe(true);
    for (const status of ['pending', 'unverified', 'disabled', '']) {
      expect(TotpStatusResponseSchema.safeParse({ status }).success, status).toBe(false);
    }
  });

  it('carries no identifier, no count and no date', () => {
    for (const field of ['factorId', 'factors', 'count', 'createdAt', 'verifiedAt', 'userId']) {
      expect(
        TotpStatusResponseSchema.safeParse({ status: 'enrolled', [field]: 'x' }).success,
        field,
      ).toBe(false);
    }
  });
});

const VERIFY_FOR_SECRET = { factorId: FACTOR, challengeId: CHALLENGE, code: '123456' };

describe('the enrolment response', () => {
  const VALID = {
    status: 'ok',
    secret: 'JBSWY3DPEHPK3PXP',
    otpauthUri: 'otpauth://totp/Marketplace:person%40example.test?secret=JBSWY3DPEHPK3PXP&issuer=Marketplace',
    qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
  };

  it('accepts the material a setup screen needs, with or without a QR', () => {
    expect(TotpEnrolmentResponseSchema.safeParse(VALID).success).toBe(true);
    expect(TotpEnrolmentResponseSchema.safeParse({ ...VALID, qrSvg: null }).success).toBe(true);
    // The QR is nullable, never absent: a page must not have to tell "no QR" from "field forgotten".
    const { qrSvg: _unused, ...withoutQr } = VALID;
    expect(TotpEnrolmentResponseSchema.safeParse(withoutQr).success).toBe(false);
  });

  it('requires the secret, because a setup screen without one cannot be completed', () => {
    expect(TotpEnrolmentResponseSchema.safeParse({ ...VALID, secret: '' }).success).toBe(false);
    const { secret: _unused, ...withoutSecret } = VALID;
    expect(TotpEnrolmentResponseSchema.safeParse(withoutSecret).success).toBe(false);
  });

  it('carries no factor identifier, no session and no token', () => {
    for (const field of [
      'factorId',
      'challengeId',
      'session',
      'accessToken',
      'refreshToken',
      'token',
      'userId',
      'recoveryCodes',
      'backupCodes',
    ]) {
      expect(TotpEnrolmentResponseSchema.safeParse({ ...VALID, [field]: 'x' }).success, field).toBe(
        false,
      );
    }
  });

  it('is the only schema in this package that carries a secret', () => {
    // Stated as a property so that a future schema growing a secret field has to face this test. The
    // enrolment response is the one place a shared secret is allowed to appear, and it appears once.
    const carriesSecret = [
      TotpStatusResponseSchema,
      TotpChallengeRequestSchema,
      TotpChallengeResponseSchema,
      TotpVerifyRequestSchema,
      TotpVerifyResponseSchema,
    ].filter((schema) =>
      [
        { status: 'ok', secret: 'JBSWY3DPEHPK3PXP' },
        { status: 'ok', challenge: { factorId: FACTOR, challengeId: CHALLENGE }, secret: 'JBSWY3DPEHPK3PXP' },
        { ...VERIFY_FOR_SECRET, secret: 'JBSWY3DPEHPK3PXP' },
      ].some((candidate) => schema.safeParse(candidate).success),
    );
    expect(carriesSecret).toEqual([]);
  });
});

describe('raising a challenge', () => {
  it('takes an optional operation and nothing else', () => {
    expect(TotpChallengeRequestSchema.safeParse({}).success).toBe(true);
    expect(TotpChallengeRequestSchema.safeParse({ operation: 'payout.details.change' }).success).toBe(
      true,
    );
  });

  it('never accepts the factor or the challenge it is answering for', () => {
    for (const field of ['factorId', 'challengeId', 'userId', 'accessToken', 'code']) {
      expect(
        TotpChallengeRequestSchema.safeParse({ operation: 'account.delete', [field]: CHALLENGE })
          .success,
        field,
      ).toBe(false);
    }
  });

  it('hands the two identifiers to the BFF and nothing more', () => {
    const envelope = { status: 'ok', challenge: { factorId: FACTOR, challengeId: CHALLENGE } };
    expect(TotpChallengeResponseSchema.safeParse(envelope).success).toBe(true);
    // No expiry, so nothing reports how long a challenge on this account lives.
    for (const field of ['expiresAt', 'expiresIn', 'operation', 'secret']) {
      expect(
        TotpChallengeResponseSchema.safeParse({
          ...envelope,
          challenge: { ...envelope.challenge, [field]: 'x' },
        }).success,
        field,
      ).toBe(false);
    }
  });

  it('refuses an identifier that is not one', () => {
    for (const value of [
      '',
      ' ',
      '../../etc/passwd',
      "a'or 1=1",
      'a b',
      'a%2f',
      'a/b',
      'a'.repeat(65),
    ]) {
      expect(TotpProviderIdSchema.safeParse(value).success, value).toBe(false);
    }
    for (const value of [CHALLENGE, FACTOR, 'abc123', 'a_b-c']) {
      expect(TotpProviderIdSchema.safeParse(value).success, value).toBe(true);
    }
  });

  it('bounds the operation to what step_up_grants can store', () => {
    for (const operation of [
      'payout.details.change',
      'password.change',
      'account.delete',
      'sessions.revoke_all',
    ]) {
      expect(TotpOperationSchema.safeParse(operation).success, operation).toBe(true);
    }
    for (const operation of [
      '',
      ' ',
      'Payout.Details.Change',
      '1payout',
      '.payout',
      'payout details',
      'payout;drop',
      "payout'--",
      'a'.repeat(65),
    ]) {
      expect(TotpOperationSchema.safeParse(operation).success, operation).toBe(false);
    }
  });

  it('keeps the identifiers inside the envelope, where only the BFF sees them', () => {
    const envelope = { status: 'ok', challenge: { factorId: FACTOR, challengeId: CHALLENGE } };
    // Never at the top level, so the shape itself says these are the BFF's and not the browser's.
    for (const field of ['challengeId', 'factorId', 'expiresAt', 'operation', 'grantId']) {
      expect(TotpChallengeResponseSchema.safeParse({ ...envelope, [field]: 'x' }).success, field).toBe(
        false,
      );
    }
    // And the envelope is required: an answer without one would leave the BFF nothing to store.
    expect(TotpChallengeResponseSchema.safeParse({ status: 'ok' }).success).toBe(false);
  });
});

describe('satisfying a challenge', () => {
  const VERIFY = { factorId: FACTOR, challengeId: CHALLENGE, code: '123456' };

  it('takes the BFF’s two identifiers and the person’s six-digit code', () => {
    expect(TotpVerifyRequestSchema.safeParse(VERIFY).success).toBe(true);
    for (const code of ['12345', '1234567', 'abcdef', '12 34 56', '', '12345a']) {
      expect(TotpCodeSchema.safeParse(code).success, code).toBe(false);
    }
    // A code typed with the spacing some authenticators show is trimmed, not rejected.
    expect(TotpVerifyRequestSchema.safeParse({ ...VERIFY, code: ' 123456 ' }).success).toBe(true);
  });

  it('is strict, so nothing rides along with the code', () => {
    for (const field of ['userId', 'grantId', 'accessToken', 'secret', 'aal', 'session']) {
      expect(TotpVerifyRequestSchema.safeParse({ ...VERIFY, [field]: 'x' }).success, field).toBe(false);
    }
  });

  it('carries the operation the challenge was raised for, under the same rules', () => {
    // The BFF supplies it from the cookie it wrote at challenge time, which is what binds a code to what
    // it authorises. It is bounded exactly as it is when the challenge is raised, so a value that could
    // not be stored in a grant cannot be requested here either.
    expect(TotpVerifyRequestSchema.safeParse({ ...VERIFY, operation: 'payout.details.change' }).success).toBe(
      true,
    );
    for (const operation of ['', 'Payout.Change', 'a b', 'a'.repeat(65)]) {
      expect(TotpVerifyRequestSchema.safeParse({ ...VERIFY, operation }).success, operation).toBe(false);
    }
  });

  it('returns no session, no token, no account and no grant', () => {
    expect(TotpVerifyResponseSchema.safeParse({ status: 'verified' }).success).toBe(true);
    for (const field of [
      'session',
      'accessToken',
      'refreshToken',
      'token',
      'userId',
      'grantId',
      'grantExpiresAt',
      'aal',
      'expiresAt',
    ]) {
      expect(
        TotpVerifyResponseSchema.safeParse({ status: 'verified', [field]: 'x' }).success,
        field,
      ).toBe(false);
    }
  });
});

describe('the documented operations', () => {
  const doc = generateOpenApiDocument();
  const paths = ['/v1/auth/totp', '/v1/auth/totp/enrol', '/v1/auth/totp/challenge', '/v1/auth/totp/verify'];

  it('documents exactly four, one read and three writes', () => {
    expect(Object.keys(doc.paths?.['/v1/auth/totp'] ?? {})).toEqual(['get']);
    for (const path of paths.slice(1)) {
      expect(Object.keys(doc.paths?.[path] ?? {}), path).toEqual(['post']);
    }
    expect(Object.keys(doc.paths ?? {}).filter((path) => path.startsWith('/v1/auth/totp'))).toHaveLength(
      4,
    );
  });

  it('documents no way to remove a factor and no backup codes', () => {
    // D9's recovery path is gated by the specification on O-1 tests 4 and 5, which have not been run.
    // Its absence is asserted rather than assumed, so adding one has to be a deliberate act.
    for (const path of paths) {
      expect(Object.keys(doc.paths?.[path] ?? {}), path).not.toContain('delete');
    }
    const all = Object.keys(doc.paths ?? {}).join(' ');
    expect(all).not.toContain('backup');
    expect(all).not.toContain('recovery-codes');
  });

  it('requires the caller’s session on every one of them', () => {
    for (const path of paths) {
      const operation = doc.paths?.[path]?.get ?? doc.paths?.[path]?.post;
      const responses = Object.keys(operation?.responses ?? {});
      expect(responses, path).toContain('401');
      expect(responses, path).toContain('403');
      expect(responses, path).toContain('503');
    }
  });

  it('declares 409 only where the caller’s own state is reported', () => {
    expect(Object.keys(doc.paths?.['/v1/auth/totp/enrol']?.post?.responses ?? {})).toContain('409');
    expect(Object.keys(doc.paths?.['/v1/auth/totp/challenge']?.post?.responses ?? {})).toContain('409');
    // Verification never reports state: every refusal there is the one generic 401.
    expect(Object.keys(doc.paths?.['/v1/auth/totp/verify']?.post?.responses ?? {})).not.toContain('409');
    expect(Object.keys(doc.paths?.['/v1/auth/totp']?.get?.responses ?? {})).not.toContain('409');
  });

  it('says in its own prose what it never returns', () => {
    const prose = paths
      .map((path) => {
        const operation = doc.paths?.[path]?.get ?? doc.paths?.[path]?.post;
        return `${operation?.summary ?? ''} ${operation?.description ?? ''}`;
      })
      .join(' ');
    expect(prose).toMatch(/carries no session, no token and no account/i);
    expect(prose).toMatch(/a page can neither choose which factor it answers for nor replay a challenge/i);
    expect(prose).toMatch(/refused identically/i);
  });
});
