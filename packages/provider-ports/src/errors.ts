/**
 * The normalized provider error (Phase 8-C).
 *
 * **A provider failure is a result, not an exception.** That is the shape `EmailTransport` already uses
 * in this repository — *"must never throw for an ordinary delivery failure — a rejected send is a
 * `failed` outcome, not an exception"* — and the reason is the same here: a thrown error abandons work
 * the database has already moved forward, while a result can be recorded. An adapter that catches an
 * HTTP timeout, a TLS failure or a parse error normalizes it **inside itself** and returns it; nothing
 * transport-shaped crosses the port.
 *
 * Two fields, and only two:
 *
 *   * `code` — a coarse slug. The pattern is the database's own: `payment_attempts.failure_code` and
 *     `payouts.failure_code` are both constrained to `^[a-z][a-z0-9_.]*$`, so a code that does not match
 *     could not be stored even if it reached this far.
 *   * `retryable` — whether the adapter believes another attempt could succeed. *How many* attempts and
 *     *how long* to wait are not an adapter's business: `queue/policy.ts` decides that, exactly as it
 *     does for email.
 *
 * **What never appears here, and never in any type in this package:** the provider's own message, its
 * response body, its HTTP status, a stack trace, a request or correlation id, a header, an endpoint, a
 * credential. Those may exist inside an adapter and may be logged by it under the repository's logging
 * rules; they are not fields of a domain contract.
 */
export interface ProviderError {
  readonly code: string;
  readonly retryable: boolean;
}

/** `payment_attempts_failure_code_format`, `payouts_failure_code_format` (0019, 0022). */
export const PROVIDER_ERROR_CODE_PATTERN = /^[a-z][a-z0-9_.]*$/;

/** The longest a `failure_code` may usefully be; the columns are unbounded `text`, so this is a sanity cap. */
export const PROVIDER_ERROR_CODE_MAX_LENGTH = 100;

/**
 * The code for a failure an adapter could not classify.
 *
 * The same slug 7-D already uses for exactly this case, so one value means one thing across the
 * repository rather than two spellings meaning the same thing.
 */
export const UNCLASSIFIED_PROVIDER_ERROR_CODE = 'provider_error_unclassified';

export function isProviderErrorCode(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= PROVIDER_ERROR_CODE_MAX_LENGTH &&
    PROVIDER_ERROR_CODE_PATTERN.test(value)
  );
}

export function isProviderError(value: unknown): value is ProviderError {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'code' || keys[1] !== 'retryable') return false;
  const { code, retryable } = value as { code: unknown; retryable: unknown };
  return isProviderErrorCode(code) && typeof retryable === 'boolean';
}

/**
 * Builds a normalized error, degrading an unusable code rather than refusing.
 *
 * An adapter reporting a failure is already on an unhappy path, and throwing there would turn a
 * recordable outcome into an abandoned operation. So a code the database would reject becomes
 * {@link UNCLASSIFIED_PROVIDER_ERROR_CODE}: the failure is still reported, and still storable.
 */
export function providerError(code: string, retryable: boolean): ProviderError {
  return Object.freeze({
    code: isProviderErrorCode(code) ? code : UNCLASSIFIED_PROVIDER_ERROR_CODE,
    retryable: retryable === true,
  });
}
