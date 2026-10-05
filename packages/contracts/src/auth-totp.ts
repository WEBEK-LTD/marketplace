import { z } from './zod.js';

/**
 * TOTP enrolment and the AAL2 challenge (Phase 7-B): the four `/v1/auth/totp` operations.
 *
 * Five shapes here are security decisions rather than conveniences, and every one of them is an absence.
 *
 *   * **No *browser* names a factor or a challenge.** Both are server state, and they travel the way F4's
 *     contact-change challenge already does: the API hands them to the BFF on the internal hop, the BFF
 *     holds them in an `HttpOnly` cookie, and the BFF supplies them again on the next internal call. They
 *     are therefore fields of the verify request — the BFF fills them — and a page that put its own
 *     values there would be dropped before the request ever left this origin. If a page could choose the
 *     factor it answers for, it could answer for one that is not the caller's; if it could choose the
 *     challenge, it could replay a spent one.
 *   * **No response carries a session or a token.** The provider's `aal2` session crosses one
 *     server-to-server hop and stops at the BFF, which turns it into the staff cookies — the same wall
 *     the login envelope already has. The browser's body says only that verification succeeded.
 *   * **The secret appears in exactly one response and never again.** `TotpEnrolmentResponseSchema` is
 *     the only schema in this package with a secret in it. It is returned once, to the screen the person
 *     is reading, under `no-store`; the surface offers no way to ask for it a second time, and a caller
 *     who already has a verified authenticator cannot reach it at all.
 *   * **The status has two values and no detail.** Not how many factors, not when one was created, not an
 *     identifier — only whether there is an authenticator to challenge.
 *   * **The operation a grant will cover is a bounded token, not free text.** It names a protected
 *     operation and can be nothing else, so it cannot become a place to smuggle a value into a database
 *     row that authorises something.
 */

/**
 * Whether the caller has an authenticator, in two words.
 *
 * A factor that exists but was never verified reads as `not_enrolled`: that is what it means to the
 * person, and offering them enrolment is the right next step.
 */
export const TotpStatusResponseSchema = z
  .object({
    status: z.enum(['not_enrolled', 'enrolled']),
  })
  .strict()
  .openapi('TotpStatusResponse');

/**
 * The enrolment material, returned once.
 *
 * `secret` is the shared secret in Base32, for manual entry. `otpauthUri` is the Key URI this project
 * builds from that secret rather than passing the provider's through, so its contents — the issuer, the
 * account label, the algorithm, the digits, the period — are decided here and are the same every time.
 * `qrSvg` is the provider's QR document when it supplied one, and null otherwise; the page renders it as
 * an `<img>` data URL, where SVG cannot execute script, and falls back to manual entry when it is null.
 */
export const TotpEnrolmentResponseSchema = z
  .object({
    status: z.literal('ok'),
    secret: z.string().min(1),
    otpauthUri: z.string().min(1),
    qrSvg: z.string().min(1).nullable(),
  })
  .strict()
  .openapi('TotpEnrolmentResponse');

/**
 * The protected operation a satisfied challenge will authorise.
 *
 * Bounded to the shape `step_up_grants.operation` already requires, so a value that could not be stored
 * cannot be requested. It is optional: a challenge raised to finish enrolment, or simply to raise the
 * caller's assurance level, authorises no particular operation and records no grant.
 */
export const TotpOperationSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_.]*$/, {
    message: 'An operation is a lower-case name, such as payout.details.change.',
  });

export const TotpChallengeRequestSchema = z
  .object({
    operation: TotpOperationSchema.optional(),
  })
  .strict()
  .openapi('TotpChallengeRequest');

/**
 * An identifier minted by the identity provider: a factor or a challenge.
 *
 * Bounded and character-restricted rather than pinned to a UUID. These values are the provider's to
 * shape, and this project has no way to verify their exact format without calling a live service, so the
 * schema accepts what an opaque identifier can reasonably be and refuses anything carrying a path
 * separator, a quote, a space or a percent sign. It is a wall against a value being used as something
 * other than an identifier, not a claim about the provider's format.
 */
export const TotpProviderIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, { message: 'That is not an identifier this API issues.' });

/**
 * A raised challenge, as the BFF receives it. **This is not the browser's response.**
 *
 * The two identifiers cross exactly one server-to-server hop, the same way a session does at login and a
 * contact-change challenge does in F4: the BFF puts them in the `__Host-mp_admin_totp_challenge` cookie
 * and answers the browser with `{ status: 'ok' }`. There is no expiry here — that would tell a page, and
 * anyone watching it, how long a challenge on this account lives.
 */
export const TotpChallengeResponseSchema = z
  .object({
    status: z.literal('ok'),
    challenge: z
      .object({
        factorId: TotpProviderIdSchema,
        challengeId: TotpProviderIdSchema,
      })
      .strict(),
  })
  .strict()
  .openapi('TotpChallengeResponse');

/** The six-digit code as every authenticator produces it: shape only, never a statement about truth. */
export const TotpCodeSchema = z
  .string()
  .trim()
  .regex(/^[0-9]{6}$/, { message: 'The code from your authenticator is six digits.' });

/**
 * The verification, as the BFF sends it.
 *
 * The code is the person's. The other three fields are the BFF's, read back from the cookie it wrote when
 * the challenge was raised; a `factorId`, `challengeId` or `operation` a page tried to send is dropped at
 * the BFF rather than forwarded, so the API can never receive one that came from a browser.
 *
 * `operation` carrying through from the challenge is what binds a code to what it authorises. The page
 * chooses it **before** the code is typed, when it asks for the challenge; by the time the code arrives
 * the choice is already sealed in an `HttpOnly` cookie, so nothing can decide after the fact that this
 * particular code should authorise something else.
 */
export const TotpVerifyRequestSchema = z
  .object({
    factorId: TotpProviderIdSchema,
    challengeId: TotpProviderIdSchema,
    code: TotpCodeSchema,
    operation: TotpOperationSchema.optional(),
  })
  .strict()
  .openapi('TotpVerifyRequest');

/**
 * Success says only that it succeeded.
 *
 * No session, no token, no account, no grant identifier and no expiry. The session stops at the BFF; the
 * grant is the server's record of what the caller may now do, and a page that held its identifier could
 * only mis-state it.
 */
export const TotpVerifyResponseSchema = z
  .object({
    status: z.literal('verified'),
  })
  .strict()
  .openapi('TotpVerifyResponse');

export type TotpProviderId = z.infer<typeof TotpProviderIdSchema>;
export type TotpStatusResponse = z.infer<typeof TotpStatusResponseSchema>;
export type TotpEnrolmentResponse = z.infer<typeof TotpEnrolmentResponseSchema>;
export type TotpChallengeRequest = z.infer<typeof TotpChallengeRequestSchema>;
export type TotpChallengeResponse = z.infer<typeof TotpChallengeResponseSchema>;
export type TotpVerifyRequest = z.infer<typeof TotpVerifyRequestSchema>;
export type TotpVerifyResponse = z.infer<typeof TotpVerifyResponseSchema>;
