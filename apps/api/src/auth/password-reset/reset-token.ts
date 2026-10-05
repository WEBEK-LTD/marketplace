import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * How a password-reset token is made and stored (C-18).
 *
 * The approved design is a "single-use hashed reset token (15 min)". Two properties follow, and this
 * module exists to make both of them impossible to get wrong.
 *
 * **The token is unguessable.** 256 bits from the platform CSPRNG, rendered as 43 URL-safe base64
 * characters — the same shape and the same source as the internal BFF credential. A reset link carries
 * this value, so it has to survive a URL untouched and resist offline guessing on its own; there is no
 * attempt counter behind a reset token the way there is behind a six-digit OTP.
 *
 * **Only its digest is stored.** Because the token has full entropy, a plain SHA-256 digest is enough:
 * unlike a six-digit OTP, there is no small space to enumerate, which is why this does not need — and
 * does not use — the OTP pepper. Reusing the OTP pepper or the OTP tables here would also tie two
 * unrelated credentials together, which C-18 forbids.
 */

/** Bytes of randomness behind one token. 256 bits, matching the digest width. */
export const RESET_TOKEN_BYTES = 32;

/** Length of the base64url rendering of {@link RESET_TOKEN_BYTES} bytes. */
export const RESET_TOKEN_LENGTH = 43;

const TOKEN_SHAPE = new RegExp(`^[A-Za-z0-9_-]{${RESET_TOKEN_LENGTH}}$`);

/**
 * One clear reset token, wrapped so it cannot leak by accident.
 *
 * The value is a private field, and `toString`, `toJSON` and the Node inspection hook all return
 * `[redacted]`. That is what stands between the token and a log line, an error payload, a JSON response
 * or a captured exception that happens to include the object holding it. Reading the real value takes
 * an explicit {@link reveal} call, which exists for exactly one purpose: building the reset link or
 * message that goes to the person, in the same call that created the token.
 *
 * The clear value is never persisted, never sent to PostgreSQL, never put on a queue and never logged.
 */
export class ResetToken {
  readonly #value: string;

  constructor(value: string) {
    if (!TOKEN_SHAPE.test(value)) {
      // Shape only. The value never appears in the message.
      throw new RangeError(`Reset token must be ${RESET_TOKEN_LENGTH} URL-safe base64 characters.`);
    }
    this.#value = value;
  }

  /** The clear token, for building the reset URL or message and nothing else. */
  reveal(): string {
    return this.#value;
  }

  /** What `app_private.password_reset_tokens.token_hash` stores. */
  digest(): Buffer {
    return resetTokenDigest(this.#value);
  }

  toString(): string {
    return '[redacted]';
  }

  toJSON(): string {
    return '[redacted]';
  }

  /** `console.log`, `util.inspect` and most log formatters go through this. */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return '[redacted]';
  }
}

/** A fresh token. The only place a clear reset token comes into existence. */
export function generateResetToken(): ResetToken {
  return new ResetToken(randomBytes(RESET_TOKEN_BYTES).toString('base64url'));
}

/**
 * The digest of a submitted token.
 *
 * Takes the clear string rather than a {@link ResetToken} because this is the side that receives one
 * back from a person: whatever arrives is hashed and looked up, and a value of the wrong shape is
 * rejected before it reaches the database — a lookup for a malformed value could only ever miss, and
 * refusing here keeps `consume_password_reset_token`'s digest-width guard from being the first line of
 * defence.
 */
export function resetTokenDigest(token: string): Buffer {
  if (!TOKEN_SHAPE.test(token)) throw new RangeError('Submitted reset token has the wrong shape.');
  return createHash('sha256').update(token, 'utf8').digest();
}

/** Whether a submitted value could be a reset token at all. Shape only; it says nothing about validity. */
export function isResetTokenShaped(value: string): boolean {
  return TOKEN_SHAPE.test(value);
}

/**
 * Constant-time digest comparison.
 *
 * Kept for any in-process comparison. The authoritative check runs inside
 * `app_private.consume_password_reset_token` under a row lock, because only the database can make
 * "consumed exactly once" atomic against a simultaneous request.
 */
export function resetDigestsEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
