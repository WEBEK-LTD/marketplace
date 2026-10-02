import { describe, expect, it } from 'vitest';
import {
  PASSWORD_MAX_UTF8_BYTES,
  PASSWORD_MIN_CHARACTERS,
  RegisterRequestSchema,
  RegisterResendRequestSchema,
  RegisterResendResponseSchema,
  RegisterResponseSchema,
  RegisterVerifyRequestSchema,
  RegisterVerifyResponseSchema,
  generateOpenApiDocument,
} from '../src/index.js';

/**
 * The registration contracts (Phase 7-A).
 *
 * These tests hold the contract to the two promises that make registration safe: **it discloses nothing
 * about who already has an account**, and **it creates no session**. So they check absences as carefully
 * as presences — no field in which an existing address could be reported, no token or session anywhere in
 * either response, and no second password rule.
 */

const VALID = {
  email: 'new.person@example.test',
  phone: '+201000000001',
  password: 'a-sufficiently-long-password',
  displayName: 'Nadia',
};

describe('the registration request', () => {
  it('accepts a complete registration, and one without the optional name', () => {
    expect(RegisterRequestSchema.safeParse(VALID).success).toBe(true);
    const { displayName: _unused, ...withoutName } = VALID;
    expect(RegisterRequestSchema.safeParse(withoutName).success).toBe(true);
  });

  it('normalises the email the way the login identifier is normalised', () => {
    const parsed = RegisterRequestSchema.parse({ ...VALID, email: '  New.Person@Example.TEST  ' });
    // Trimmed and case-folded: the same person on a day they hold shift and a day they do not.
    expect(parsed.email).toBe('new.person@example.test');
  });

  it('refuses an address that is not an email', () => {
    for (const email of ['not-an-email', '@example.test', 'a@', '', ' ']) {
      expect(RegisterRequestSchema.safeParse({ ...VALID, email }).success, email).toBe(false);
    }
  });

  it('requires the phone in E.164 and guesses no country', () => {
    expect(RegisterRequestSchema.safeParse({ ...VALID, phone: '+201234567890' }).success).toBe(true);
    for (const phone of ['01000000001', '00201000000001', '+0100000', '+', 'not-a-phone', '']) {
      expect(RegisterRequestSchema.safeParse({ ...VALID, phone }).success, phone).toBe(false);
    }
  });

  it('applies the shared password policy and defines no second one', () => {
    // Too short by the shared rule, and too many bytes by it — both refused here without this file
    // restating either number.
    expect(
      RegisterRequestSchema.safeParse({ ...VALID, password: 'a'.repeat(PASSWORD_MIN_CHARACTERS - 1) })
        .success,
    ).toBe(false);
    expect(
      RegisterRequestSchema.safeParse({ ...VALID, password: 'a'.repeat(PASSWORD_MIN_CHARACTERS) }).success,
    ).toBe(true);
    expect(
      RegisterRequestSchema.safeParse({ ...VALID, password: 'a'.repeat(PASSWORD_MAX_UTF8_BYTES + 1) })
        .success,
    ).toBe(false);
  });

  it('is strict, so nothing can be smuggled alongside the four fields', () => {
    for (const field of [
      'userId',
      'id',
      'role',
      'roleKey',
      'emailConfirm',
      'phoneConfirm',
      'emailConfirmedAt',
      'phoneConfirmedAt',
      'isAdmin',
      'sellerUserId',
      'challengeId',
    ]) {
      expect(RegisterRequestSchema.safeParse({ ...VALID, [field]: 'x' }).success, field).toBe(false);
    }
  });
});

describe('the registration response discloses nothing', () => {
  it('is a literal status and a challenge id, and nothing else', () => {
    const response = { status: 'ok', challengeId: '11111111-1111-4111-8111-111111111111' };
    expect(RegisterResponseSchema.safeParse(response).success).toBe(true);
    // There is no field in which "this address already exists" could be reported...
    for (const field of [
      'created',
      'exists',
      'alreadyRegistered',
      'accountExists',
      'userId',
      'email',
      'phone',
      'destination',
      'channel',
      'maskedPhone',
      'expiresAt',
      'reason',
    ]) {
      expect(RegisterResponseSchema.safeParse({ ...response, [field]: 'x' }).success, field).toBe(
        false,
      );
    }
  });

  it('cannot carry a different status for a taken address', () => {
    // `status` is a literal, so the two paths cannot even differ in it.
    for (const status of ['exists', 'created', 'taken', 'pending']) {
      expect(
        RegisterResponseSchema.safeParse({
          status,
          challengeId: '11111111-1111-4111-8111-111111111111',
        }).success,
        status,
      ).toBe(false);
    }
  });

  it('requires the challenge id to be a uuid, so a synthetic one is indistinguishable', () => {
    expect(
      RegisterResponseSchema.safeParse({ status: 'ok', challengeId: 'not-a-uuid' }).success,
    ).toBe(false);
  });
});

describe('the verification step', () => {
  it('takes a challenge and a six-digit code, and no account', () => {
    const valid = { challengeId: '11111111-1111-4111-8111-111111111111', otp: '123456' };
    expect(RegisterVerifyRequestSchema.safeParse(valid).success).toBe(true);
    for (const otp of ['12345', '1234567', 'abcdef', '12 34 56', '']) {
      expect(RegisterVerifyRequestSchema.safeParse({ ...valid, otp }).success, otp).toBe(false);
    }
    for (const field of ['userId', 'email', 'phone', 'password']) {
      expect(RegisterVerifyRequestSchema.safeParse({ ...valid, [field]: 'x' }).success, field).toBe(
        false,
      );
    }
  });

  it('returns no session, no token and no account', () => {
    expect(RegisterVerifyResponseSchema.safeParse({ status: 'verified' }).success).toBe(true);
    for (const field of [
      'accessToken',
      'refreshToken',
      'token',
      'session',
      'userId',
      'expiresAt',
      'email',
      'phone',
    ]) {
      expect(
        RegisterVerifyResponseSchema.safeParse({ status: 'verified', [field]: 'x' }).success,
        field,
      ).toBe(false);
    }
  });
});

describe('asking for the code again', () => {
  it('takes the challenge and nothing that could aim it somewhere else', () => {
    const valid = { challengeId: '11111111-1111-4111-8111-111111111111' };
    expect(RegisterResendRequestSchema.safeParse(valid).success).toBe(true);
    // No phone, no email, no account: the destination is the account's own number, decided in the
    // database, and there is deliberately no field in which a caller could propose a different one.
    for (const field of ['phone', 'email', 'to', 'destination', 'userId', 'toPhoneE164']) {
      expect(RegisterResendRequestSchema.safeParse({ ...valid, [field]: 'x' }).success, field).toBe(
        false,
      );
    }
    expect(RegisterResendRequestSchema.safeParse({ challengeId: 'not-a-uuid' }).success).toBe(false);
  });

  it('answers with the fresh challenge and nothing that counts down', () => {
    const response = { status: 'ok', challengeId: '11111111-1111-4111-8111-111111111111' };
    expect(RegisterResendResponseSchema.safeParse(response).success).toBe(true);
    // A resend issues a new challenge, so it has a new identifier; nothing else may ride along. A field
    // saying how many sends are left would report on somebody else's number.
    for (const field of ['retryAfter', 'sendsLeft', 'sendCount', 'expiresAt', 'destination', 'maskedPhone']) {
      expect(RegisterResendResponseSchema.safeParse({ ...response, [field]: 'x' }).success, field).toBe(
        false,
      );
    }
    expect(
      RegisterResendResponseSchema.safeParse({ status: 'ok', challengeId: 'not-a-uuid' }).success,
    ).toBe(false);
    // The same shape as the start response, which is what keeps the BFF's handling of the two identical.
    expect(Object.keys(RegisterResendResponseSchema.parse(response)).sort()).toEqual(
      ['challengeId', 'status'],
    );
  });
});

describe('the documented operations', () => {
  const doc = generateOpenApiDocument();

  it('documents exactly three registration operations, all POST', () => {
    for (const path of ['/v1/auth/register', '/v1/auth/register/resend', '/v1/auth/register/verify']) {
      expect(Object.keys(doc.paths?.[path] ?? {}), path).toEqual(['post']);
    }
    expect(doc.paths?.['/v1/auth/register']?.post?.operationId).toBe('postV1AuthRegister');
    expect(doc.paths?.['/v1/auth/register/resend']?.post?.operationId).toBe(
      'postV1AuthRegisterResend',
    );
    expect(doc.paths?.['/v1/auth/register/verify']?.post?.operationId).toBe(
      'postV1AuthRegisterVerify',
    );
  });

  it('declares no GET, PUT, PATCH or DELETE anywhere under registration', () => {
    const paths = Object.keys(doc.paths ?? {}).filter((path) => path.startsWith('/v1/auth/register'));
    expect(paths).toHaveLength(3);
    for (const path of paths) {
      expect(Object.keys(doc.paths?.[path] ?? {}), path).toEqual(['post']);
    }
  });

  it('declares the same refusals the rest of the auth surface declares', () => {
    const start = Object.keys(doc.paths?.['/v1/auth/register']?.post?.responses ?? {}).sort();
    expect(start).toEqual(['200', '400', '403', '429', '500', '503']);
    // No 401 and no 409 on start: an address already taken is not reported, so there is no status for it.
    expect(start).not.toContain('409');
    expect(start).not.toContain('401');
    const verify = Object.keys(
      doc.paths?.['/v1/auth/register/verify']?.post?.responses ?? {},
    ).sort();
    expect(verify).toEqual(['200', '400', '401', '403', '429', '500', '503']);
    const resend = Object.keys(
      doc.paths?.['/v1/auth/register/resend']?.post?.responses ?? {},
    ).sort();
    expect(resend).toEqual(['200', '400', '401', '403', '429', '500', '503']);
  });

  it('never names an existing account in its own prose', () => {
    const prose = ['/v1/auth/register', '/v1/auth/register/resend', '/v1/auth/register/verify']
      .map((path) => {
        const operation = doc.paths?.[path]?.post;
        return `${operation?.summary ?? ''} ${operation?.description ?? ''}`;
      })
      .join(' ');
    expect(prose).toMatch(/identical whether/i);
    expect(prose).toMatch(/No session is created/i);
    // The prose describes the indistinguishability rather than a branch a client could act on.
    expect(prose).not.toMatch(/returns 409|conflict status|already registered error/i);
  });
});
