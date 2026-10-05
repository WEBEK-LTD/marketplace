import { z } from './zod.js';

/**
 * The phone contact change (F4): `POST /v1/users/me/contact/phone/start` and `/verify`.
 *
 * V1 changes a phone and nothing else — no email contact change and no second channel — and it is an
 * authenticated operation throughout: the account comes from the caller's own session, never from the
 * request, which is why neither schema has a field for a user.
 *
 * The code itself goes to the *new* number over WhatsApp, and the number becomes the account's confirmed
 * phone only once that code comes back. Nothing in these schemas carries a code, a destination or an
 * account identifier.
 */

/**
 * E.164, matching the constraint `profiles_phone_format` that migration 0005 already enforces.
 *
 * The rule is the database's, restated here so the API refuses a malformed number before it reaches a
 * provider rather than after. No country is imposed: D17 allows any supported country code for a buyer's
 * phone, and narrowing it here would be a policy this file does not own.
 */
export const PhoneE164Schema = z
  .string()
  .regex(/^\+[1-9][0-9]{6,14}$/, { message: 'The phone number must be in E.164 format, such as +201234567890.' });

export const ContactPhoneStartRequestSchema = z
  .object({
    phone: PhoneE164Schema,
  })
  .strict()
  .openapi('ContactPhoneStartRequest');

/**
 * The start response.
 *
 * It says only that the request was accepted. It carries no destination, no masked number, no expiry and
 * no account detail — the person already knows the number they typed, and anything else here would be a
 * detail the server has no reason to hand back.
 */
export const ContactPhoneStartResponseSchema = z
  .object({
    status: z.literal('ok'),
  })
  .strict()
  .openapi('ContactPhoneStartResponse');

/** The six-digit code as approved: shape only, never a statement about correctness. */
export const ContactOtpSchema = z
  .string()
  .regex(/^[0-9]{6}$/, { message: 'The code must be six digits.' });

export const ContactPhoneVerifyRequestSchema = z
  .object({
    challengeId: z.string().uuid(),
    otp: ContactOtpSchema,
  })
  .strict()
  .openapi('ContactPhoneVerifyRequest');

/** Success says only that it succeeded. The new number is already the account's; nothing is echoed. */
export const ContactPhoneVerifyResponseSchema = z
  .object({
    status: z.literal('ok'),
  })
  .strict()
  .openapi('ContactPhoneVerifyResponse');

/**
 * The header the BFF presents the caller's access token in.
 *
 * The browser never puts a token in a body and never holds one it can read: the session lives in the
 * `__Host-mp_access` cookie, and the BFF — the only component that can read it — presents it here on the
 * one internal hop to the API.
 */
export const SESSION_TOKEN_HEADER = 'x-session-token';

export type ContactPhoneStartRequest = z.infer<typeof ContactPhoneStartRequestSchema>;
export type ContactPhoneStartResponse = z.infer<typeof ContactPhoneStartResponseSchema>;
export type ContactPhoneVerifyRequest = z.infer<typeof ContactPhoneVerifyRequestSchema>;
export type ContactPhoneVerifyResponse = z.infer<typeof ContactPhoneVerifyResponseSchema>;
