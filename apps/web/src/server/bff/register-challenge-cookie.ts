import 'server-only';

/**
 * The registration challenge cookie.
 *
 * The browser never learns which challenge it is answering. The identifier the verification step needs is
 * opaque, but it is still server state, so it travels the way every other piece of server state in this
 * project does: an `HttpOnly` cookie the page cannot read, set by the BFF and read back by the BFF.
 *
 * Its own cookie, separate from the contact change's, and that separation is the point: a challenge issued
 * to finish a registration must not be spendable by the authenticated contact-change page, and the
 * reverse. Sharing one cookie between the two flows would make each one a way into the other.
 *
 * It holds the challenge identifier and nothing else — no code, no email, no phone number, no account.
 * `Max-Age` is 900 seconds, so the browser forgets it at about the point the challenge stops being useful,
 * and every other attribute is what the `__Host-` prefix requires: `Secure`, `Path=/`, no `Domain`.
 */
export const REGISTER_CHALLENGE_COOKIE = Object.freeze({
  name: '__Host-mp_register_challenge',
  maxAgeSeconds: 15 * 60,
});

/** A challenge identifier is a UUID; nothing else is ever written into this cookie. */
const CHALLENGE_SHAPE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Serialises the cookie with the approved attributes.
 *
 * Fixed list, no options parameter: no call site can drop `Secure`, widen `SameSite` or add a `Domain`.
 */
function serialize(value: string, maxAgeSeconds: number): string {
  return [
    `${REGISTER_CHALLENGE_COOKIE.name}=${value}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
  ].join('; ');
}

/** The `Set-Cookie` value that carries a freshly issued challenge identifier. */
export function registerChallengeCookie(challengeId: string): string {
  return serialize(challengeId, REGISTER_CHALLENGE_COOKIE.maxAgeSeconds);
}

/** The `Set-Cookie` value that clears it: same name, same attributes, empty value, `Max-Age=0`. */
export function clearedRegisterChallengeCookie(): string {
  return serialize('', 0);
}

/**
 * Reads the challenge identifier out of a request's `Cookie` header.
 *
 * A value that is not a challenge identifier is treated as no cookie at all, so nothing a browser could
 * put there reaches the API as a challenge.
 */
export function readRegisterChallengeCookie(cookieHeader: string | null): string | null {
  if (cookieHeader === null) return null;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== REGISTER_CHALLENGE_COOKIE.name) continue;
    const value = part.slice(separator + 1).trim();
    return CHALLENGE_SHAPE.test(value) ? value : null;
  }
  return null;
}
