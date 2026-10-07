import 'server-only';

/**
 * The browser session, exactly as owner decision C-8 defines it for the admin origin.
 *
 * Every attribute here is approved, not chosen. The `__Host-` prefix is the reason the rest of them are
 * not negotiable: a browser accepts a `__Host-` cookie only when it is `Secure`, has `Path=/` and has no
 * `Domain`, so the prefix turns three conventions into a rule the browser enforces. Host-only means the
 * cookie cannot be set or read by a sibling subdomain, which is what keeps the public origin's session
 * and this one genuinely separate.
 *
 * `SameSite=Strict` means the cookie is not sent on any cross-site navigation. That is stricter than the
 * usual `Lax`, and it is the approved value.
 *
 * The values are Supabase tokens, and they exist in exactly two places: this module, and the `Set-Cookie`
 * header it produces. They are never in a response body, never in `localStorage`, never readable from
 * JavaScript (`HttpOnly`), and never logged.
 */
export const SESSION_COOKIES = Object.freeze({
  access: Object.freeze({ name: '__Host-mp_admin_access', maxAgeSeconds: 15 * 60 }),
  refresh: Object.freeze({ name: '__Host-mp_admin_refresh', maxAgeSeconds: 30 * 24 * 60 * 60 }),
});

export interface SessionTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
}

interface CookieSpec {
  readonly name: string;
  readonly maxAgeSeconds: number;
}

/**
 * Serialises one cookie with the approved attributes.
 *
 * The attribute list is fixed on purpose: there is no options parameter, so no call site can quietly
 * drop `Secure` or widen `SameSite`.
 */
function serialize(spec: CookieSpec, value: string, maxAgeSeconds: number): string {
  return [
    `${spec.name}=${value}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
  ].join('; ');
}

/** The two `Set-Cookie` values that establish a session (C-8 lifetimes). */
export function sessionCookies(tokens: SessionTokens): readonly string[] {
  return [
    serialize(SESSION_COOKIES.access, tokens.accessToken, SESSION_COOKIES.access.maxAgeSeconds),
    serialize(SESSION_COOKIES.refresh, tokens.refreshToken, SESSION_COOKIES.refresh.maxAgeSeconds),
  ];
}

/**
 * The two `Set-Cookie` values that clear a session.
 *
 * Same name, same attributes, empty value and `Max-Age=0`: a browser only replaces a cookie when the
 * name, path and host all match, so clearing has to repeat the attributes rather than simplify them.
 * C-8 requires a failed refresh to clear the session, which is what this is for.
 */
export function clearedSessionCookies(): readonly string[] {
  return [
    serialize(SESSION_COOKIES.access, '', 0),
    serialize(SESSION_COOKIES.refresh, '', 0),
  ];
}
