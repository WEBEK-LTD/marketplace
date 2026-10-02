import { z } from './zod.js';

/**
 * Session continuity (Phase 5-A): `POST /v1/auth/refresh`, `POST /v1/auth/logout` and
 * `GET /v1/users/me`.
 *
 * F2 established the session and stopped there: the access cookie lives fifteen minutes (C-8) and
 * nothing renewed it, so every signed-in surface was fifteen minutes long. These three operations are
 * the minimum that makes a signed-in surface usable, and they change nothing about how a session is
 * *created* — login is untouched.
 *
 * Two rules shape every schema in this file.
 *
 * **No token is ever a browser-visible field.** A refresh returns `{ status: 'ok' }` and a new pair of
 * `Set-Cookie` headers, exactly as login does. The tokens cross one server-to-server hop, from the API
 * to the BFF, in an envelope the BFF never forwards; the envelope is a transport shape declared next to
 * the controller that produces it, not a public contract, which is why it is absent here.
 *
 * **The account is never named by the request.** `GET /v1/users/me` accepts no identifier: the caller is
 * resolved from their own access token, so there is no schema here in which a user id could be supplied.
 */

/**
 * The header the BFF presents the caller's **refresh** token in.
 *
 * Deliberately not the access-token header: the two tokens have different lifetimes, different cookies
 * and different powers, and a route that accepts either one would be a route where an access token can
 * be spent as a refresh token. The BFF reads `__Host-mp_refresh`, which JavaScript cannot see, and
 * presents it here on the single internal hop.
 */
export const REFRESH_TOKEN_HEADER = 'x-refresh-token';

/** The browser-visible body of a successful refresh. The session travels as Set-Cookie. */
export const SessionRefreshResponseSchema = z
  .object({
    status: z.literal('ok'),
  })
  .strict()
  .openapi('SessionRefreshResponse');

/**
 * The browser-visible body of a logout.
 *
 * Success says only that it succeeded, and it says that whether or not there was a session to end: a
 * logout is idempotent, so a second one is not an error and must not read as one.
 */
export const LogoutResponseSchema = z
  .object({
    status: z.literal('ok'),
  })
  .strict()
  .openapi('LogoutResponse');

/**
 * The minimum identity a signed-in surface needs.
 *
 * Two fields, by owner decision: the account id and the display name. There is deliberately no email,
 * no phone, no role, no verification state and no seller record — a surface that needs one of those
 * needs its own approved contract, and widening this one would make every page that renders a name a
 * page that could leak contact details.
 *
 * `displayName` is nullable because `profiles.display_name` is: an account can exist before anybody has
 * chosen a name for it, and the surfaces render a fallback rather than the API inventing one.
 */
export const CurrentUserSchema = z
  .object({
    id: z.string().uuid(),
    displayName: z.string().nullable(),
  })
  .strict()
  .openapi('CurrentUser');

export const CurrentUserResponseSchema = z
  .object({
    user: CurrentUserSchema,
  })
  .strict()
  .openapi('CurrentUserResponse');

export type SessionRefreshResponse = z.infer<typeof SessionRefreshResponseSchema>;
export type LogoutResponse = z.infer<typeof LogoutResponseSchema>;
export type CurrentUser = z.infer<typeof CurrentUserSchema>;
export type CurrentUserResponse = z.infer<typeof CurrentUserResponseSchema>;
