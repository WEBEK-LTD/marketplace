import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Device identity (owner decision C-15).
 *
 * A device is a persistent random value this server issues to a browser and stores only as a keyed
 * digest. Nothing about the browser identifies it: not the user agent, not the address. C-15 rules both
 * out as the primary identity, and rightly — a user-agent hash is shared by everyone on the same browser
 * build, and an address changes every time the person moves between networks, so neither answers "is
 * this the same device" without either lumping strangers together or splitting one person into many.
 *
 * So the value is generated here, from the CSPRNG, and the browser only ever carries it back:
 *
 *   __Host-mp_device_id = <256 random bits, base64url>       (HttpOnly, Secure, SameSite=Strict, Path=/)
 *   known_devices.device_hash = HMAC-SHA-256(key, "device-v1:" || cookie value)
 *
 * **Why the stored form is keyed.** The cookie value is high-entropy, so a plain hash would not be
 * brute-forceable — but a keyed digest also means a leaked `known_devices` table cannot be matched
 * against cookie values captured anywhere else, and it keeps the construction consistent with the one
 * other keyed identifier in the system.
 *
 * **Its own key, its own label.** C-15 forbids reusing the C-13 pseudonymous-ID key, and the domain
 * label differs too, so the same input could never produce the same digest under the two schemes even
 * if a key were ever misconfigured into both places.
 *
 * The digest is what the database stores; the raw value exists only in the cookie and in the moment
 * this module reads it. Neither PostgreSQL, Redis, a log, telemetry nor a response body ever sees it.
 */

/** The versioned domain-separation label, distinct from C-13's. Changing it changes every digest. */
export const DEVICE_ID_DOMAIN = 'device-v1:';

/** The cookie the browser carries. C-15 fixes the name; its flags are set by the BFF that writes it. */
export const DEVICE_ID_COOKIE_NAME = '__Host-mp_device_id';

/** Bytes of randomness in a device value. 256 bits: guessing one is not a strategy. */
export const DEVICE_ID_BYTES = 32;

/** A generated value is 43 base64url characters, and only those characters are ever accepted back. */
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Shortest key accepted, matching the C-13 floor: a guard against a misconfigured deployment. */
export const MIN_DEVICE_KEY_LENGTH = 32;

const REDACTED = '[REDACTED]';

/**
 * Issues device values and turns them into the digest `known_devices.device_hash` stores.
 *
 * The key lives in a private field and cannot be read back; `toString`, `toJSON` and the inspect hook
 * all answer `[REDACTED]`, so an instance that reaches a log line or an error message prints nothing.
 */
export class DeviceIdentity {
  readonly #key: Buffer;

  constructor(key: string) {
    if (typeof key !== 'string' || key.length < MIN_DEVICE_KEY_LENGTH) {
      // The value is never named in the message.
      throw new RangeError(`The device identity key must be at least ${MIN_DEVICE_KEY_LENGTH} characters.`);
    }
    this.#key = Buffer.from(key, 'utf8');
  }

  /**
   * A fresh device value, from the CSPRNG (C-15). This is the only place one is created, and the only
   * value that may ever be written into the device cookie.
   */
  static issue(): string {
    return randomBytes(DEVICE_ID_BYTES).toString('base64url');
  }

  /** Whether a value the browser sent back has the shape this server issues. */
  static isWellFormed(value: unknown): value is string {
    return typeof value === 'string' && DEVICE_ID_PATTERN.test(value);
  }

  /**
   * The 32-byte digest for one device value, ready for `known_devices.device_hash`.
   *
   * Throws for anything this server would not have issued: a caller holding a malformed value has no
   * device, and hashing it anyway would create a device record out of a broken cookie.
   */
  digest(deviceId: string): Buffer {
    if (!DeviceIdentity.isWellFormed(deviceId)) {
      throw new RangeError('A well-formed device identifier is required to derive a device digest.');
    }
    return createHmac('sha256', this.#key).update(`${DEVICE_ID_DOMAIN}${deviceId}`, 'utf8').digest();
  }

  /**
   * The same thing for a cookie that may be absent, malformed or simply not there yet. Returns null
   * rather than a placeholder: a request with no usable device value has no device, and the caller
   * issues a new one instead of recording a fake.
   */
  digestOf(deviceId: unknown): Buffer | null {
    return DeviceIdentity.isWellFormed(deviceId) ? this.digest(deviceId) : null;
  }

  /** True when `candidate` is this key's digest for `deviceId`. For tests and nothing else. */
  matches(deviceId: string, candidate: Buffer): boolean {
    const expected = this.digest(deviceId);
    return expected.length === candidate.length && timingSafeEqual(expected, candidate);
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return REDACTED;
  }
}
