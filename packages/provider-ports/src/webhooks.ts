import type { ProviderError } from './errors.js';

/**
 * Webhook delivery as it crosses a provider port (Phase 8-C).
 *
 * v5.2 fixes the order and this package cannot change it: *"raw body → `verifyWebhook` → store in
 * `payment_events` (unique on provider + event key) → 2xx → worker processes"*, and *"status is confirmed
 * only by a verified webhook or a server-side `getPaymentStatus`; return URLs are never trusted."*
 *
 * The body is bytes, not a string. A signature is computed over the bytes a provider actually sent, and
 * decoding to text first — re-encoding, normalising a newline, trimming — can change them and break a
 * verification that should have held. `Uint8Array` is also what `payment_events.payload_digest` is
 * computed from; the body itself is never stored, only that digest.
 *
 * **No endpoint exists.** 8-C defines these types and the two port methods that use them. Routing,
 * raw-body handling and the 2xx are a later increment's, and no route is added here.
 */

export interface RawWebhookRequest {
  readonly body: Uint8Array;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * The same bytes, after the adapter has vouched for them.
 *
 * A distinct type from {@link RawWebhookRequest} so `parseWebhook` cannot be handed something unverified:
 * the only way to obtain one is from a successful {@link WebhookVerificationResult}.
 */
export interface VerifiedWebhookRequest {
  readonly body: Uint8Array;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Verified, or rejected with a normalized error.
 *
 * A rejection is a **result**: an unverifiable delivery is an ordinary event on a public endpoint, not an
 * exceptional one, and it must be answerable without unwinding anything. The error carries a coarse code
 * and nothing about the signature scheme, the expected value or the header that failed.
 */
export type WebhookVerificationResult =
  | { readonly outcome: 'verified'; readonly request: VerifiedWebhookRequest }
  | { readonly outcome: 'rejected'; readonly error: ProviderError };

export function isRawWebhookRequest(value: unknown): value is RawWebhookRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const request = value as Partial<RawWebhookRequest>;
  return request.body instanceof Uint8Array && isHeaderMap(request.headers);
}

function isHeaderMap(value: unknown): value is Readonly<Record<string, string>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => typeof entry === 'string');
}

/** The verified form is structurally the raw form; the guard exists so both can be checked by name. */
export const isVerifiedWebhookRequest = (value: unknown): value is VerifiedWebhookRequest =>
  isRawWebhookRequest(value);
