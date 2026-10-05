import 'server-only';

/**
 * The password-reset cookie, exactly as the F3 decision defines it.
 *
 * It is a separate cookie from the four session cookies of C-8 and must stay separate: it authorises one
 * operation — setting a new password — and never a session. Using a session cookie name for it would
 * make a half-finished recovery indistinguishable from being signed in.
 *
 * `Max-Age=900` matches the token's own 15-minute life, so the browser forgets it at the same moment the
 * database stops accepting it. Every other attribute is what the `__Host-` prefix requires and what the
 * decision names: `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, no `Domain`.
 *
 * The value is a live reset token. It exists in exactly two places — this module and the `Set-Cookie`
 * header it produces — and is never in a response body, never in HTML, never readable from JavaScript
 * and never logged.
 */
export const RESET_COOKIE = Object.freeze({ name: '__Host-mp_reset', maxAgeSeconds: 15 * 60 });

/**
 * Serialises the cookie with the approved attributes.
 *
 * Fixed list, no options parameter: no call site can drop `Secure`, widen `SameSite` or add a `Domain`.
 */
function serialize(value: string, maxAgeSeconds: number): string {
  return [
    `${RESET_COOKIE.name}=${value}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
  ].join('; ');
}

/** The `Set-Cookie` value that carries a freshly issued reset token. */
export function resetCookie(token: string): string {
  return serialize(token, RESET_COOKIE.maxAgeSeconds);
}

/** The `Set-Cookie` value that clears it: same name, same attributes, empty value, `Max-Age=0`. */
export function clearedResetCookie(): string {
  return serialize('', 0);
}

/** Reads the reset token out of a request's `Cookie` header, or null when it is not there. */
export function readResetCookie(cookieHeader: string | null): string | null {
  if (cookieHeader === null) return null;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== RESET_COOKIE.name) continue;
    const value = part.slice(separator + 1).trim();
    return value === '' ? null : value;
  }
  return null;
}
