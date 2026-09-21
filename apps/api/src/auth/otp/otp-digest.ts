import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * How an OTP is stored (owner decision C-9): `HMAC-SHA-256(server-side pepper, OTP)`.
 *
 * A six-digit code has only a million possible values, so a bare SHA-256 digest would be exhaustible in
 * microseconds by anyone who obtained the table. The pepper is what makes the stored digest useless
 * without the application: it lives only in the API process's configuration, never in the database, and
 * is never written to a log or an error.
 *
 * The digest is computed here, in the application, and only the digest is sent to PostgreSQL. That is
 * deliberate — it means a database compromise yields neither the code nor the means to forge one.
 */
export class OtpPepper {
  readonly #pepper: Buffer;

  constructor(pepper: string) {
    const bytes = Buffer.from(pepper, 'utf8');
    if (bytes.length < 32) {
      // Length only; the value never appears in the message.
      throw new RangeError('OTP pepper must be at least 32 bytes.');
    }
    this.#pepper = bytes;
  }

  /** The value stored in `app_private.otp_challenges.code_hash`. */
  digest(code: string): Buffer {
    return createHmac('sha256', this.#pepper).update(code, 'utf8').digest();
  }

  /**
   * Constant-time digest comparison.
   *
   * Kept for any in-process comparison. The authoritative check runs inside
   * `app_private.verify_otp_challenge` under a row lock, because only the database can make "consume
   * exactly once" atomic against a concurrent request.
   */
  static equal(a: Buffer, b: Buffer): boolean {
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Guards against the pepper reaching a log through an accidental interpolation or serialization. */
  toString(): string {
    return '[redacted]';
  }

  toJSON(): string {
    return '[redacted]';
  }
}
