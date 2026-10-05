import 'server-only';
import {
  ANALYTICS_SESSION_COOKIE_NAME,
  isAnalyticsSessionId,
  newAnalyticsSessionId,
} from '@repo/server-config';

/**
 * The analytics session cookie (0101, owner decision 4).
 *
 * An opaque random value this server issues so two events can be known to belong to one visit. The browser
 * carries it and cannot read it; the API stores only its keyed digest, computed under a dedicated
 * domain-separated key. Nothing identifiable is involved at any point.
 *
 * ```
 * __Host-mp_analytics_session=<43 base64url chars>; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400
 * ```
 *
 * **`SameSite=Lax`, and `Strict` for the device cookie, on purpose.** The device value answers a security
 * question — is this the same browser — so it must not travel on a cross-site navigation. A visit that
 * arrives from a search engine is exactly the case analytics most needs to count as one session, so `Lax`
 * is right here and would be wrong there. The two cookies are separate values under separate keys for the
 * same reason.
 *
 * **A day, not a year.** A session is a visit. The device cookie's year would turn every returning visitor
 * into one endless session and make the boundary meaningless; a day is long enough to survive a page being
 * left open over lunch and short enough that the digest stops being a durable handle on anybody.
 */

export const ANALYTICS_SESSION_COOKIE = Object.freeze({
  name: ANALYTICS_SESSION_COOKIE_NAME,
  /** One day, in seconds. A session is a visit, not a relationship. */
  maxAgeSeconds: 86_400,
});

/** The `Set-Cookie` value that gives this browser an analytics session for a day. */
export function analyticsSessionCookie(value: string): string {
  if (!isAnalyticsSessionId(value)) {
    // Only a value this server issued may ever be written back.
    throw new RangeError('A well-formed analytics session identifier is required to set the cookie.');
  }
  return [
    `${ANALYTICS_SESSION_COOKIE.name}=${value}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${ANALYTICS_SESSION_COOKIE.maxAgeSeconds}`,
  ].join('; ');
}

/**
 * Reads the analytics session a browser sent, or null when it has none.
 *
 * Null covers no cookie, an empty one, and one whose value is not the shape this server issues. In all three
 * the browser has no session yet and the route issues a fresh one.
 */
export function readAnalyticsSessionCookie(cookieHeader: string | null): string | null {
  if (cookieHeader === null) return null;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== ANALYTICS_SESSION_COOKIE.name) continue;
    const value = part.slice(separator + 1).trim();
    return isAnalyticsSessionId(value) ? value : null;
  }
  return null;
}

/** The session for this request, and whether it has to be written back. */
export function resolveAnalyticsSession(cookieHeader: string | null): {
  readonly sessionId: string;
  readonly isNew: boolean;
} {
  const existing = readAnalyticsSessionCookie(cookieHeader);
  if (existing !== null) return { sessionId: existing, isNew: false };
  return { sessionId: newAnalyticsSessionId(), isNew: true };
}
