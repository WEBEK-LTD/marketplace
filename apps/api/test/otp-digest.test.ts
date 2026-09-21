import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { OtpPepper } from '../src/auth/otp/otp-digest.js';

const PEPPER_A = 'pepper-a-not-a-real-secret-0123456789abcdef';
const PEPPER_B = 'pepper-b-not-a-real-secret-0123456789abcdef';

describe('OTP digests (C-9: HMAC-SHA-256 with a server-side pepper)', () => {
  it('is exactly HMAC-SHA-256 of the code under the pepper', () => {
    const digest = new OtpPepper(PEPPER_A).digest('012345');
    expect(digest).toEqual(createHmac('sha256', Buffer.from(PEPPER_A, 'utf8')).update('012345', 'utf8').digest());
    expect(digest).toHaveLength(32);
  });

  it('is not plain SHA-256 of the code', async () => {
    const { createHash } = await import('node:crypto');
    const digest = new OtpPepper(PEPPER_A).digest('012345');
    expect(digest.equals(createHash('sha256').update('012345', 'utf8').digest())).toBe(false);
  });

  it('is stable for the same code and pepper', () => {
    const pepper = new OtpPepper(PEPPER_A);
    expect(pepper.digest('123456').equals(pepper.digest('123456'))).toBe(true);
  });

  it('differs for a different code', () => {
    const pepper = new OtpPepper(PEPPER_A);
    expect(pepper.digest('123456').equals(pepper.digest('123457'))).toBe(false);
    // Leading zeros are part of the code, so these must not collide.
    expect(pepper.digest('012345').equals(pepper.digest('12345'))).toBe(false);
  });

  it('differs for a different pepper, so a leaked digest is useless without it', () => {
    expect(new OtpPepper(PEPPER_A).digest('123456').equals(new OtpPepper(PEPPER_B).digest('123456'))).toBe(false);
  });

  it('never contains the code or the pepper', () => {
    const digest = new OtpPepper(PEPPER_A).digest('123456');
    expect(digest.toString('utf8')).not.toContain('123456');
    expect(digest.toString('utf8')).not.toContain(PEPPER_A);
    expect(digest.toString('hex')).not.toContain(Buffer.from(PEPPER_A).toString('hex'));
  });

  it('refuses a pepper that is too short to be worth having', () => {
    expect(() => new OtpPepper('short')).toThrow(RangeError);
    // The rejection must not quote the value.
    try {
      new OtpPepper('short-secret-value');
    } catch (error) {
      expect((error as Error).message).not.toContain('short-secret-value');
    }
  });

  it('does not leak the pepper through string or JSON conversion', () => {
    const pepper = new OtpPepper(PEPPER_A);
    expect(String(pepper)).toBe('[redacted]');
    expect(`${pepper}`).not.toContain(PEPPER_A);
    expect(JSON.stringify({ pepper })).not.toContain(PEPPER_A);
    expect(JSON.stringify(pepper)).toBe('"[redacted]"');
  });

  it('compares digests in constant time and rejects mismatched lengths', () => {
    const pepper = new OtpPepper(PEPPER_A);
    const a = pepper.digest('123456');
    expect(OtpPepper.equal(a, pepper.digest('123456'))).toBe(true);
    expect(OtpPepper.equal(a, pepper.digest('654321'))).toBe(false);
    // timingSafeEqual throws on unequal lengths; the wrapper must return false instead.
    expect(OtpPepper.equal(a, Buffer.alloc(8))).toBe(false);
  });
});
