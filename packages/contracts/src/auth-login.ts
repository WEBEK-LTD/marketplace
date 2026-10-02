import { PasswordSchema } from './password.js';
import { z } from './zod.js';

/**
 * `POST /v1/auth/login` — the first authenticated flow (F2).
 *
 * The shape of this contract is a security decision, not a convenience. Two things are deliberately
 * absent from the response:
 *
 *   * **Any token.** Owner decision C-8 puts the browser session in `__Host-` cookies set by the BFF.
 *     The browser is never handed an access or refresh token it could read from JavaScript, so there is
 *     nowhere in this schema for one to live.
 *   * **Anything that varies by outcome.** A success says `{ "status": "ok" }` and nothing else — no
 *     user id, no email, no role, no session id. A failure is problem details with a single code
 *     (`AUTHENTICATION_FAILED`). A caller cannot tell a wrong password from an unknown identifier from
 *     a locked account, which is what "no account enumeration" actually requires.
 *
 * The request carries the identifier exactly as typed apart from trimming and case folding, because the
 * value is hashed for the durable counters and must hash the same way every time.
 */

/** Longest identifier accepted. Generous for an email address, short enough to bound the hash input. */
export const LOGIN_IDENTIFIER_MAX_LENGTH = 320;

/**
 * The login identifier: an email address or a phone number, normalised for stable hashing.
 *
 * Normalisation is lower-casing and trimming only. It deliberately does **not** attempt E.164
 * conversion: that belongs to registration, where the country is known, and guessing it here would make
 * the same person hash to two different subjects depending on how they typed their number.
 */
export const LoginIdentifierSchema = z
  .string()
  .min(1)
  .max(LOGIN_IDENTIFIER_MAX_LENGTH)
  .transform((value) => value.trim().toLowerCase())
  .refine((value) => value.length > 0, { message: 'Identifier is required.' });

export const LoginRequestSchema = z
  .object({
    identifier: LoginIdentifierSchema,
    // The same D1 rule the UI applies. Rejecting a too-short password here means the provider is never
    // called for a value that could not be a valid password anyway (F2 requirement: policy before
    // provider).
    password: PasswordSchema,
  })
  .strict()
  .openapi('LoginRequest');

/**
 * The success response. It says only that the request succeeded.
 *
 * The session itself travels as `Set-Cookie`; see C-8. A client that wants to know who it is asks a
 * separate endpoint once one exists.
 */
export const LoginResponseSchema = z
  .object({
    status: z.literal('ok'),
  })
  .strict()
  .openapi('LoginResponse');

export type LoginRequest = z.infer<typeof LoginRequestSchema>;
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

/**
 * The header that carries the C-15 device value on the one internal hop from the BFF to the API.
 *
 * It is a header rather than a body field on purpose: the login request schema is the approved F2
 * contract, and device registration is an observation about the browser, not a login credential. The
 * value never reaches the browser's own request or response — it lives in the `__Host-mp_device_id`
 * cookie, which JavaScript cannot read, and only the BFF puts it on this hop.
 */
export const DEVICE_ID_HEADER = 'x-device-id';

/**
 * The header the API answers with when the device the request presented was revoked (C-15).
 *
 * It carries the fresh device value the BFF must write into the cookie, and it exists only on the one
 * internal hop: the browser's response is still `{ status: 'ok' }` and the login response schema is
 * unchanged. A body field would have put a device value one forwarding mistake away from the browser.
 */
export const DEVICE_ROTATED_HEADER = 'x-device-id-rotated';
