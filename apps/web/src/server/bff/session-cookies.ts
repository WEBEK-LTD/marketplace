import 'server-only';

/**
 * The browser session, exactly as owner decision C-8 defines it for the public web origin.
 *
 * Every attribute here is approved, not chosen. The `__Host-` prefix is the reason the rest of them are
 * not negotiable: a browser accepts a `__Host-` cookie only when it is `Secure`, has `Path=/` and has no
 * `Domain`, so the prefix turns three conventions into a rule the browser enforces. Host-only means the
 * cookie cannot be set or read by a sibling subdomain, which is what keeps the admin origin's session
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
  access: Object.freeze({ name: '__Host-mp_access', maxAgeSeconds: 15 * 60 }),
  refresh: Object.freeze({ name: '__Host-mp_refresh', maxAgeSeconds: 30 * 24 * 60 * 60 }),
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

/**
 * Reads one named cookie out of a `Cookie` header.
 *
 * Deliberately not a general cookie parser: it walks the header, matches the name exactly and returns
 * the raw value. An empty value reads as absent, because a cleared cookie (`name=; Max-Age=0`) can still
 * be presented by a browser mid-flight and is not a session.
 */
function readCookie(cookieHeader: string | null, name: string): string | null {
  if (cookieHeader === null) return null;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    return value === '' ? null : value;
  }
  return null;
}

/**
 * The caller's access token, from the session cookie the browser cannot read.
 *
 * This and {@link readRefreshToken} are the only supported way to reach a session value on this origin.
 * Nothing else may read these cookies, and nothing outside this module may serialise them.
 */
export function readAccessToken(cookieHeader: string | null): string | null {
  return readCookie(cookieHeader, SESSION_COOKIES.access.name);
}

/**
 * The caller's refresh token.
 *
 * Kept separate from the access token for the same reason the API takes them in different headers: the
 * two have different lifetimes and different powers, and a call site that could confuse them is a call
 * site where a fifteen-minute token could be spent as a thirty-day one.
 */
export function readRefreshToken(cookieHeader: string | null): string | null {
  return readCookie(cookieHeader, SESSION_COOKIES.refresh.name);
}
