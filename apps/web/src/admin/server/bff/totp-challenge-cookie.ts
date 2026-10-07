import 'server-only';

/**
 * The TOTP challenge cookie, on the admin origin.
 *
 * A raised challenge is server state: which factor it belongs to, which challenge it is, and — when one
 * was asked for — which protected operation a correct code will authorise. None of that may be the
 * browser's, so none of it is. The BFF writes this cookie from the API's internal-hop answer and reads
 * it back itself; the page in between is told only that a challenge was raised.
 *
 * **The operation is sealed here, before the code is typed.** The page chooses it when it asks for the
 * challenge; from that moment it lives in a cookie JavaScript cannot read, and the verification the BFF
 * sends carries the operation from *this* value rather than from the request. So nothing can decide,
 * after seeing a code accepted, that the code should have authorised something else.
 *
 * `Max-Age` is 600 seconds, which is the ten minutes a step-up grant lives and rather longer than a
 * provider challenge does — the cookie expiring is never the reason a challenge fails, and the authority
 * that matters is the challenge itself. Every other attribute is what the `__Host-` prefix requires:
 * `Secure`, `Path=/`, no `Domain`. `SameSite=Strict` matches the admin session cookies beside it.
 */
export const TOTP_CHALLENGE_COOKIE = Object.freeze({
  name: '__Host-mp_admin_totp_challenge',
  maxAgeSeconds: 10 * 60,
});

/** What the cookie carries, and the only three things it may. */
export interface TotpChallengeState {
  readonly factorId: string;
  readonly challengeId: string;
  /** The operation a correct code will authorise, or null when the challenge authorises none. */
  readonly operation: string | null;
}

/**
 * The shapes each part must have.
 *
 * Identifiers are the provider's, so the pattern is deliberately conservative rather than a claim about
 * its format: alphanumerics, hyphen and underscore, which covers a UUID and refuses anything carrying a
 * separator, a quote or a space. The operation is the shape `step_up_grants.operation` itself requires.
 * A colon is in none of them, which is what makes it safe as the delimiter.
 */
const ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;
const OPERATION_SHAPE = /^[a-z][a-z0-9_.]{0,63}$/;

/**
 * Serialises the cookie with the approved attributes.
 *
 * Fixed list, no options parameter: no call site can drop `Secure`, widen `SameSite` or add a `Domain`.
 */
function serialize(value: string, maxAgeSeconds: number): string {
  return [
    `${TOTP_CHALLENGE_COOKIE.name}=${value}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
  ].join('; ');
}

/**
 * The `Set-Cookie` value carrying a freshly raised challenge.
 *
 * A state whose parts do not have the shapes above is refused rather than written: a cookie this module
 * would not read back is a cookie it must not create, and writing one would turn a provider surprise
 * into a challenge nobody can ever answer.
 */
export function totpChallengeCookie(state: TotpChallengeState): string | null {
  if (!ID_SHAPE.test(state.factorId) || !ID_SHAPE.test(state.challengeId)) return null;
  if (state.operation !== null && !OPERATION_SHAPE.test(state.operation)) return null;
  return serialize(`${state.factorId}:${state.challengeId}:${state.operation ?? ''}`, TOTP_CHALLENGE_COOKIE.maxAgeSeconds);
}

/** The `Set-Cookie` value that clears it: same name, same attributes, empty value, `Max-Age=0`. */
export function clearedTotpChallengeCookie(): string {
  return serialize('', 0);
}

/**
 * Reads the challenge out of a request's `Cookie` header.
 *
 * Anything that is not exactly three well-shaped parts is treated as no cookie at all. That is the line
 * that keeps a value a browser could put there from reaching the API as a factor, a challenge or — the
 * one that would matter most — an operation to authorise.
 */
export function readTotpChallengeCookie(cookieHeader: string | null): TotpChallengeState | null {
  if (cookieHeader === null) return null;

  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== TOTP_CHALLENGE_COOKIE.name) continue;

    const parts = part.slice(separator + 1).trim().split(':');
    if (parts.length !== 3) return null;
    const [factorId, challengeId, operation] = parts as [string, string, string];
    if (!ID_SHAPE.test(factorId) || !ID_SHAPE.test(challengeId)) return null;
    if (operation !== '' && !OPERATION_SHAPE.test(operation)) return null;
    return { factorId, challengeId, operation: operation === '' ? null : operation };
  }
  return null;
}
