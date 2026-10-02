import { PasswordSchema } from './password.js';
import { z } from './zod.js';

/**
 * Registration and contact verification (Phase 7-A): `POST /v1/auth/register` and `/register/verify`.
 *
 * The approved decision is **VERIFY FIRST** — a new account verifies its contact before it can sign in —
 * and this file is shaped by that and by F3's enumeration rules, which it follows rather than reinvents.
 *
 * Four shapes here are security decisions rather than conveniences.
 *
 *   * **Start returns a challenge id whatever happens.** F3's recovery start already works this way, and
 *     for the same reason: the verify step needs an id, and a response that carried one only when the
 *     account was new would be an account-existence oracle in a single field. So registration answers with
 *     an identifier of the same shape whether it created an account or found the address already taken,
 *     and an id that belongs to nothing simply fails verification like a wrong code.
 *   * **The response says nothing else.** No destination, no channel, no masked number, no expiry, no
 *     reason, and above all no statement about whether the account existed. `status` is a literal, so
 *     there is not even a field in which a difference could appear.
 *   * **Verify returns no session.** Verification confirms a contact; it does not sign anyone in. The
 *     person goes to the existing login page afterwards, which is what makes VERIFY FIRST observable
 *     rather than merely stated.
 *   * **The contact is the phone.** That is this repository's canonical verified contact —
 *     `verified_contact_for_user` and `password_reset_contact` both require `phone_confirmed_at`, and the
 *     only contact-change surface is the phone pair — so registration verifies it over the established
 *     WhatsApp OTP path. The email is the sign-in identifier; it is not what gets verified here.
 */

/**
 * The email address, as the account's sign-in identifier.
 *
 * Trimmed and case-folded on the way in, matching F2's identifier handling: a person who capitalises
 * their address on one day and not the next is the same person. Length is bounded so an absurd value is
 * refused before it reaches the provider.
 */
export const RegisterEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(254)
  .email({ message: 'Enter a valid email address.' });

/**
 * The phone number, in E.164.
 *
 * Required at registration, because it is the contact that gets verified. The format is the one the OTP
 * path already expects — `issue_otp_challenge` takes `p_to_phone_e164` — so nothing here normalises or
 * guesses a country: a number is either already E.164 or it is refused.
 */
export const RegisterPhoneSchema = z
  .string()
  .trim()
  .regex(/^\+[1-9][0-9]{7,14}$/, {
    message: 'Enter your phone number in international format, starting with +.',
  });

/** The display name, optional, bounded by the profiles table's own 80-character rule. */
export const RegisterDisplayNameSchema = z.string().trim().min(1).max(80);

export const RegisterRequestSchema = z
  .object({
    email: RegisterEmailSchema,
    phone: RegisterPhoneSchema,
    /** D1's password policy, unchanged and shared with every other password surface. */
    password: PasswordSchema,
    displayName: RegisterDisplayNameSchema.optional(),
  })
  .strict()
  .openapi('RegisterRequest');

/**
 * The start response, which must be identical for every request that validates.
 *
 * `challengeId` is a UUID whether or not an account was created. Nothing distinguishes the two paths.
 */
export const RegisterResponseSchema = z
  .object({
    status: z.literal('ok'),
    challengeId: z.string().uuid(),
  })
  .strict()
  .openapi('RegisterResponse');

/** The six-digit code as approved: shape only, never a statement about correctness. */
export const RegisterOtpSchema = z
  .string()
  .regex(/^[0-9]{6}$/, { message: 'The code must be six digits.' });

export const RegisterVerifyRequestSchema = z
  .object({
    challengeId: z.string().uuid(),
    otp: RegisterOtpSchema,
  })
  .strict()
  .openapi('RegisterVerifyRequest');

/**
 * Success says only that it succeeded.
 *
 * No session, no token, no account identifier, no contact. The person signs in afterwards through the
 * existing login flow, with the password they chose.
 */
export const RegisterVerifyResponseSchema = z
  .object({
    status: z.literal('verified'),
  })
  .strict()
  .openapi('RegisterVerifyResponse');

/**
 * Asking for the code again.
 *
 * Only the challenge, because only the challenge may decide where a code goes. There is no phone field
 * here and none in the database function behind it: the number a resend reaches is the one the account
 * already holds, and a caller cannot name a different one. The browser does not fill this in either — the
 * BFF holds the challenge in an `HttpOnly` cookie and supplies it on the internal hop.
 */
export const RegisterResendRequestSchema = z
  .object({
    challengeId: z.string().uuid(),
  })
  .strict()
  .openapi('RegisterResendRequest');

/**
 * The resend response: the same two fields the start response has, and for the same reason.
 *
 * A resend issues a fresh challenge, so it has a fresh identifier, and the BFF needs it to replace what
 * its cookie holds. Nothing else is here — no destination, no masked number, no expiry, and no count of
 * sends left, which would tell a caller how close to the limit somebody else's number is. The browser is
 * given neither field: the BFF answers it with a literal.
 */
export const RegisterResendResponseSchema = z
  .object({
    status: z.literal('ok'),
    challengeId: z.string().uuid(),
  })
  .strict()
  .openapi('RegisterResendResponse');

export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;
export type RegisterResponse = z.infer<typeof RegisterResponseSchema>;
export type RegisterVerifyRequest = z.infer<typeof RegisterVerifyRequestSchema>;
export type RegisterVerifyResponse = z.infer<typeof RegisterVerifyResponseSchema>;
export type RegisterResendRequest = z.infer<typeof RegisterResendRequestSchema>;
export type RegisterResendResponse = z.infer<typeof RegisterResendResponseSchema>;
