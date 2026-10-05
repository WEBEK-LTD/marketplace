import { createHmac, randomBytes } from 'node:crypto';

/**
 * The analytics session identity (0101, owner decision 4).
 *
 * An analytics session is a persistent random value this server issues to a browser and stores only as a
 * keyed digest, in `listing_events.session_hash`. It exists so two events can be known to have come from
 * the same visit without anything about that visit being identifiable: not an address, not a user agent,
 * not an account.
 *
 *   __Host-mp_analytics_session = <256 random bits, base64url>   (HttpOnly, Secure, SameSite=Lax, Path=/)
 *   listing_events.session_hash = HMAC-SHA-256(key, "analytics-session-v1:" || cookie value)
 *
 * **The client never supplies the hash, and could not.** The browser carries an opaque identifier and the
 * digest is computed here, on every event, from that identifier. A caller who sent a precomputed digest
 * would simply have it hashed again like any other string, so there is no input that reaches the stored
 * column unhashed. That is a property of the construction rather than a validation rule that could be
 * forgotten.
 *
 * **Its own key and its own label.** Owner decision 4 forbids reusing `PSEUDONYMOUS_USER_ID_KEY` (C-13)
 * or `DEVICE_IDENTITY_KEY` (C-15), and the domain label differs from both, so the same input could never
 * produce the same digest under any of the three schemes even if one key were misconfigured into two
 * places. An analytics digest can therefore never be correlated with a device row or a log line.
 *
 * **It is not the device identity and must not be used as one.** C-15's device value identifies a browser
 * for security decisions — known devices, step-up — and lives under `SameSite=Strict`. This one is for
 * counting and is deliberately weaker and separate: losing it costs a session boundary in analytics and
 * nothing else.
 *
 * The raw value exists only in the cookie and in the moment this module reads it. Neither PostgreSQL,
 * Redis, a log, telemetry nor a response body ever sees it.
 */

/** The versioned domain-separation label, distinct from C-13's and C-15's. Changing it changes every digest. */
export const ANALYTICS_SESSION_DOMAIN = 'analytics-session-v1:';

/** The cookie the browser carries. Written by the web BFF, never by a client script. */
export const ANALYTICS_SESSION_COOKIE_NAME = '__Host-mp_analytics_session';

/** Bytes of randomness in an analytics session value. 256 bits, like the device value. */
export const ANALYTICS_SESSION_BYTES = 32;

/** A generated value is 43 base64url characters, and only those characters are ever accepted back. */
const ANALYTICS_SESSION_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Shortest key accepted, matching the C-13 and C-15 floor: a guard against a misconfigured deployment. */
export const MIN_ANALYTICS_SESSION_KEY_LENGTH = 32;

/** A fresh analytics session value, from the CSPRNG. */
export function newAnalyticsSessionId(): string {
  return randomBytes(ANALYTICS_SESSION_BYTES).toString('base64url');
}

/** Whether a value has the shape this server issues. Anything else is treated as absent, never as a session. */
export function isAnalyticsSessionId(value: unknown): value is string {
  return typeof value === 'string' && ANALYTICS_SESSION_PATTERN.test(value);
}

/**
 * The digest stored in `listing_events.session_hash`, as lowercase hex.
 *
 * Returns null for a value that is not one this server issued, so a malformed or absent cookie produces an
 * event with no session rather than an event with a digest of some arbitrary string. Counting without a
 * session boundary is a smaller loss than inventing one.
 *
 * @throws when the key is missing or too short — a misconfigured deployment must not silently produce
 *   digests under a weak key.
 */
export function analyticsSessionHash(key: string, sessionId: unknown): string | null {
  if (typeof key !== 'string' || key.length < MIN_ANALYTICS_SESSION_KEY_LENGTH) {
    throw new Error('The analytics session key is missing or too short.');
  }
  if (!isAnalyticsSessionId(sessionId)) return null;
  return createHmac('sha256', key).update(`${ANALYTICS_SESSION_DOMAIN}${sessionId}`).digest('hex');
}
