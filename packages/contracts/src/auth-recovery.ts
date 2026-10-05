import { LoginIdentifierSchema } from './auth-login.js';
import { PasswordSchema } from './password.js';
import { z } from './zod.js';

/**
 * The password-reset recovery flow (F3): `POST /v1/auth/recovery/start`, `/verify` and `/reset`.
 *
 * This is the privileged-account flow's namesake and not its relative: D10's support-assisted recovery
 * stays at `/v1/account-recovery/*` with its own tables, its own OTP purpose and its own approvals.
 *
 * Three shapes in this file are security decisions rather than conveniences.
 *
 *   * **Start returns a challenge id whatever happens.** The verify step needs one, and a response that
 *     carried an id only for accounts that exist would be an account-existence oracle in a single
 *     field. So the API answers with an identifier of the same shape either way, and an id that belongs
 *     to nothing simply fails verification like a wrong code.
 *   * **Verify returns no token.** The reset token crosses exactly one server-to-server hop to the BFF,
 *     which turns it into the `__Host-mp_reset` cookie. There is nowhere in this schema for it.
 *   * **Reset takes only the new password.** The token arrives at the API from the cookie through the
 *     BFF, never from the browser's JSON, so the browser-facing body cannot carry one.
 */

/** The identifier normalisation is F2's, unchanged: trim and case-fold, no E.164 guessing. */
export const RecoveryStartRequestSchema = z
  .object({
    identifier: LoginIdentifierSchema,
  })
  .strict()
  .openapi('RecoveryStartRequest');

/**
 * The start response, which must be identical for every account.
 *
 * `challengeId` is a UUID whether or not an OTP was sent. For an account with a verified contact it is
 * the real challenge; otherwise it is a value that matches nothing. Nothing else is returned: no
 * destination, no channel, no masked phone number, no expiry, no reason.
 */
export const RecoveryStartResponseSchema = z
  .object({
    status: z.literal('ok'),
    challengeId: z.string().uuid(),
  })
  .strict()
  .openapi('RecoveryStartResponse');

/** The six-digit code as approved: shape only, never a statement about correctness. */
export const RecoveryOtpSchema = z
  .string()
  .regex(/^[0-9]{6}$/, { message: 'The code must be six digits.' });

export const RecoveryVerifyRequestSchema = z
  .object({
    challengeId: z.string().uuid(),
    otp: RecoveryOtpSchema,
  })
  .strict()
  .openapi('RecoveryVerifyRequest');

/** Success says only that it succeeded. The reset token never appears in a browser-visible body. */
export const RecoveryVerifyResponseSchema = z
  .object({
    status: z.literal('ok'),
  })
  .strict()
  .openapi('RecoveryVerifyResponse');

export const RecoveryResetRequestSchema = z
  .object({
    // The approved D1 policy, applied before the token is validated and long before it is consumed.
    newPassword: PasswordSchema,
  })
  .strict()
  .openapi('RecoveryResetRequest');

export const RecoveryResetResponseSchema = z
  .object({
    status: z.literal('ok'),
  })
  .strict()
  .openapi('RecoveryResetResponse');

/**
 * The header the BFF presents the reset token in.
 *
 * A header rather than a body field, so that "the token comes from the cookie boundary" is visible in
 * the shape of the request: the browser's JSON body has no field for it, and the BFF reads the value
 * from `__Host-mp_reset` and sets this header itself.
 */
export const RESET_TOKEN_HEADER = 'x-reset-token';

export type RecoveryStartRequest = z.infer<typeof RecoveryStartRequestSchema>;
export type RecoveryStartResponse = z.infer<typeof RecoveryStartResponseSchema>;
export type RecoveryVerifyRequest = z.infer<typeof RecoveryVerifyRequestSchema>;
export type RecoveryVerifyResponse = z.infer<typeof RecoveryVerifyResponseSchema>;
export type RecoveryResetRequest = z.infer<typeof RecoveryResetRequestSchema>;
export type RecoveryResetResponse = z.infer<typeof RecoveryResetResponseSchema>;
