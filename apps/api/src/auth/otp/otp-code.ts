import { randomInt } from 'node:crypto';

/** The approved OTP shape: exactly six decimal digits. */
export const OTP_DIGITS = 6;
const OTP_UPPER_BOUND = 10 ** OTP_DIGITS;

/**
 * Generates one OTP.
 *
 * `randomInt` draws from the platform CSPRNG and applies rejection sampling, so every value in
 * [0, 1000000) is equally likely — a plain `random % 1000000` would not be, and `Math.random()` is not
 * cryptographic at all.
 *
 * The value is returned as a zero-padded string, never a number: `000731` is a valid code, and a numeric
 * representation would silently turn it into `731`.
 */
export function generateOtpCode(): string {
  return String(randomInt(0, OTP_UPPER_BOUND)).padStart(OTP_DIGITS, '0');
}

/** Whether a submitted value has the shape of an OTP. Shape only — it says nothing about correctness. */
export function isOtpCodeShaped(value: string): boolean {
  return new RegExp(`^[0-9]{${OTP_DIGITS}}$`).test(value);
}
