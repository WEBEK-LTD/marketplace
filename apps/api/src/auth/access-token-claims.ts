/**
 * The assurance level of an access token the provider has already validated (Phase 7-F).
 *
 * **Why this exists.** `public.is_aal2()` reads the `aal` claim of the caller's verified JWT, and that
 * works for an `authenticated` session talking to PostgREST. The API is not that caller: it connects as
 * `app_system`, which carries no claims, so nothing on the database side can observe the assurance level
 * of the session a request came from. The admin console has to know it — "nothing privileged at aal1" is
 * the authorization matrix's rule — so the API reads it here and passes it to the one reader that
 * applies the rule.
 *
 * **Why reading it without checking a signature is sound, and what makes it so.** This function does not
 * decide that a token is genuine and must never be called as though it did. The caller's contract is
 * strict: {@link readAssuranceLevel} is invoked **only on a token the provider has just validated**, in
 * the same request, on the same string. `SupabaseAuthClient.getUser` presents the token to GoTrue, which
 * refuses a forged, altered, expired or revoked one with a 401 that becomes
 * `AuthenticationRequiredError` before this is reached. So by the time the claims are read, the provider
 * has vouched for the bytes they are read from — the `aal` value is GoTrue's own statement about the
 * session, not an assertion a browser made. A token whose signature did not hold never gets here.
 *
 * That is the whole of the argument, and it is why the order in {@link StaffConsoleService} is fixed:
 * validate, then read. Reading first would be reading an attacker's JSON.
 *
 * **Everything ambiguous is aal1.** A token that is not three segments, a payload that is not JSON, a
 * payload that is not an object, an `aal` that is missing, is not a string, or is not exactly `aal1` or
 * `aal2` — every one of those returns `'aal1'`. There is no branch in which an unreadable token produces
 * a privileged answer, which is the property worth having: a future provider change that renamed the
 * claim would lock staff out of the console rather than let anybody in.
 *
 * **Nothing else is read.** Not `sub` — the account comes from the provider's own answer, never from the
 * token body, so a token whose claims disagreed with the provider could not name a different person.
 * Not `exp`, not `amr`, not `role`. One claim, one purpose.
 */

export type AssuranceLevel = 'aal1' | 'aal2';

/** base64url, which is what a JWT segment is; padding and the standard alphabet are both refused. */
const SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * The assurance level the provider recorded in this token, or `'aal1'` when it says nothing usable.
 *
 * **Call this only on a token the provider has already validated in the same request.**
 */
export function readAssuranceLevel(accessToken: string): AssuranceLevel {
  if (typeof accessToken !== 'string') return 'aal1';

  const segments = accessToken.split('.');
  if (segments.length !== 3) return 'aal1';

  const payload = segments[1];
  if (payload === undefined || payload === '' || !SEGMENT_PATTERN.test(payload)) return 'aal1';

  let text: string;
  try {
    text = Buffer.from(payload, 'base64url').toString('utf8');
  } catch {
    return 'aal1';
  }

  let claims: unknown;
  try {
    claims = JSON.parse(text);
  } catch {
    return 'aal1';
  }
  if (typeof claims !== 'object' || claims === null || Array.isArray(claims)) return 'aal1';

  const aal = (claims as { aal?: unknown }).aal;
  return aal === 'aal2' ? 'aal2' : 'aal1';
}

/** Convenience for the one question every caller actually asks. */
export function isAal2(accessToken: string): boolean {
  return readAssuranceLevel(accessToken) === 'aal2';
}
