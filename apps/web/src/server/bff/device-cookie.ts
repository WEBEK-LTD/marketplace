import 'server-only';
import { DEVICE_ID_COOKIE_NAME, DeviceIdentity } from '@repo/server-config';

/**
 * The C-15 device cookie.
 *
 * A device is a random value this server issues and the browser carries back; the browser cannot read
 * it, and the server stores only its keyed digest. This module owns the cookie half of that: the name,
 * the attributes and the one-year lifetime the owner approved, plus the read that decides whether a
 * request already carries a device.
 *
 * ```
 * __Host-mp_device_id=<43 base64url chars>; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000
 * ```
 *
 * `__Host-` is not decoration: the prefix makes a browser refuse the cookie unless it is `Secure`, has
 * `Path=/` and carries no `Domain`, so a subdomain cannot set a device value for the parent origin. The
 * cookie is written the same way as the C-8 session cookies and the F4 challenge cookie, which is why
 * the attribute list reads identically to theirs apart from the lifetime.
 *
 * A value that is not the shape this server issues is treated as no value at all: the login path then
 * issues a fresh one rather than registering a device from something a client made up.
 */

export const DEVICE_COOKIE = Object.freeze({
  name: DEVICE_ID_COOKIE_NAME,
  /** Owner decision: one year, in seconds. */
  maxAgeSeconds: 31_536_000,
});

function serialize(value: string, maxAgeSeconds: number): string {
  // No Domain attribute, by `__Host-` rule and by C-8's own wording.
  return [
    `${DEVICE_COOKIE.name}=${value}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
  ].join('; ');
}

/** The `Set-Cookie` value that gives this browser a device for a year. */
export function deviceCookie(value: string): string {
  if (!DeviceIdentity.isWellFormed(value)) {
    // Only a value this server issued may ever be written back.
    throw new RangeError('A well-formed device identifier is required to set the device cookie.');
  }
  return serialize(value, DEVICE_COOKIE.maxAgeSeconds);
}

/**
 * Reads the device value a browser sent, or null when it has none.
 *
 * Null covers three cases that are the same thing to the caller: no cookie, an empty one, and one whose
 * value is not the shape this server issues. In all three the browser has no device yet.
 */
export function readDeviceCookie(cookieHeader: string | null): string | null {
  if (cookieHeader === null) return null;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== DEVICE_COOKIE.name) continue;
    const value = part.slice(separator + 1).trim();
    return DeviceIdentity.isWellFormed(value) ? value : null;
  }
  return null;
}
