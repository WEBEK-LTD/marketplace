import { z } from './zod.js';

/**
 * The password policy (decision D1, approved; maximum revised by N2).
 *
 *   > Minimum 10 characters; maximum 72 UTF-8 bytes (measured in bytes, not characters, so Arabic and
 *   > other multibyte text reaches the limit sooner); validated in UI and API before the password
 *   > reaches the auth provider; no truncation; no normalization that changes meaning; exact
 *   > comparison; no forced character mix
 *
 * The two limits are measured in *different units*, and that is the whole point of the decision. The
 * maximum is 72 **bytes** because bcrypt truncates at 72 bytes; a 72-character Arabic password is 144
 * bytes and would be silently cut in half by the hasher, so it is rejected here instead. The minimum is
 * 10 **characters**, which is a statement about how much the person typed, not about encoding.
 *
 * Deliberately absent, because D1 does not define them and this file must not invent them:
 *
 *   * **Common-password blocking.** D1 requires it but names no list, source or threshold.
 *   * **Leaked-password checking.** D1 defers it to Supabase's feature "if available on the selected
 *     plan (O-3)", and O-3 is OPEN. D1 also warns: "No other breach provider may be substituted
 *     silently." So no provider is wired in here.
 *
 * Both remain owner decisions. Nothing in this file approximates them.
 */

/** D1 minimum, counted in characters. */
export const PASSWORD_MIN_CHARACTERS = 10;

/** D1/N2 maximum, counted in UTF-8 bytes. */
export const PASSWORD_MAX_UTF8_BYTES = 72;

// A module-level encoder: `TextEncoder` is a standard global in both Node and the browser, whereas
// `Buffer` exists only in Node. This rule is consumed by the web and admin apps as well as the API, so
// reaching for `Buffer` here would break exactly half of "validated in UI and API".
const UTF8 = new TextEncoder();

/** Byte length of the UTF-8 encoding — what bcrypt's 72-byte limit actually counts. */
export function utf8ByteLength(value: string): number {
  return UTF8.encode(value).length;
}

/**
 * Length in Unicode code points.
 *
 * Not `value.length`, which counts UTF-16 code units and therefore reports 2 for a single astral
 * character. Measuring "characters" with a JavaScript string length is the same class of mistake as
 * measuring the maximum in characters instead of bytes, so it is avoided in both directions.
 */
export function characterLength(value: string): number {
  return Array.from(value).length;
}

/** Stable identifiers so a caller can tell the two failures apart without parsing a message. */
export const PASSWORD_ISSUE = Object.freeze({
  tooShort: 'password_too_short',
  tooManyBytes: 'password_too_many_utf8_bytes',
});

/**
 * The shared password rule.
 *
 * It validates and returns the value **unchanged**: no `.trim()`, no `.normalize()`, no `.transform()`,
 * no truncation. D1 requires exact comparison and forbids both truncation and meaning-changing
 * normalization, so the string that leaves this schema is byte-for-byte the string that entered it —
 * including leading and trailing whitespace, which is part of the password, not noise to be cleaned up.
 *
 * Messages never contain the value.
 */
export const PasswordSchema = z.string().superRefine((value, ctx) => {
  if (characterLength(value) < PASSWORD_MIN_CHARACTERS) {
    ctx.addIssue({
      code: 'custom',
      message: `Password must be at least ${PASSWORD_MIN_CHARACTERS} characters.`,
      params: { rule: PASSWORD_ISSUE.tooShort },
    });
  }

  if (utf8ByteLength(value) > PASSWORD_MAX_UTF8_BYTES) {
    ctx.addIssue({
      code: 'custom',
      message: `Password must be at most ${PASSWORD_MAX_UTF8_BYTES} bytes when encoded as UTF-8.`,
      params: { rule: PASSWORD_ISSUE.tooManyBytes },
    });
  }
});

export type Password = z.infer<typeof PasswordSchema>;
