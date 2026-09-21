import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateOtpCode, isOtpCodeShaped, OTP_DIGITS } from '../src/auth/otp/otp-code.js';

describe('OTP generation', () => {
  it('is exactly six decimal digits', () => {
    expect(OTP_DIGITS).toBe(6);
    for (let i = 0; i < 500; i += 1) {
      const code = generateOtpCode();
      expect(code).toHaveLength(6);
      expect(code).toMatch(/^[0-9]{6}$/);
    }
  });

  it('preserves leading zeros by returning a string', () => {
    // The failure mode this guards: a numeric 731 rendering as "731" instead of "000731".
    const codes = Array.from({ length: 4000 }, () => generateOtpCode());
    expect(codes.every((code) => code.length === 6)).toBe(true);
    // With 4000 draws, seeing no code below 100000 would mean padding is broken.
    expect(codes.some((code) => code.startsWith('0'))).toBe(true);
  });

  it('covers the whole range, so no digit position is fixed', () => {
    const codes = Array.from({ length: 2000 }, () => generateOtpCode());
    expect(new Set(codes).size).toBeGreaterThan(1900); // no meaningful repetition
    expect(codes.some((code) => Number(code) < 500000)).toBe(true);
    expect(codes.some((code) => Number(code) >= 500000)).toBe(true);
  });

  it('uses the crypto RNG and never Math.random', () => {
    const source = readFileSync(new URL('../src/auth/otp/otp-code.ts', import.meta.url), 'utf8');
    // Strip comments first: the file explains *why* Math.random is unsuitable, and prose about a
    // forbidden call must not be mistaken for the call itself.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).toContain("from 'node:crypto'");
    expect(code).toContain('randomInt');
    expect(code).not.toContain('Math.random');
    expect(code).not.toMatch(/Date\.now|getTime/);
  });

  it('recognises the OTP shape without judging correctness', () => {
    expect(isOtpCodeShaped('000731')).toBe(true);
    expect(isOtpCodeShaped('12345')).toBe(false);
    expect(isOtpCodeShaped('1234567')).toBe(false);
    expect(isOtpCodeShaped('12345a')).toBe(false);
    expect(isOtpCodeShaped(' 123456')).toBe(false);
  });
});
