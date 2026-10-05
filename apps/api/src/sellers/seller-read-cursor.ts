/**
 * The seller read-surface cursors (Phase 6-J).
 *
 * Two kinds, because the three paginated surfaces have two different tie-breakers, and a single loosened
 * decoder that accepted either would be a decoder that accepted more than any one surface needs.
 *
 * **The reference cursor** — orders and reviews. Its tie-breaker is `order_number`, the unique human
 * reference the orders table already generates (`MP-26-001001`), so these two cursors carry **no uuid at
 * all**, exactly as 6-F's listing cursor carries a slug rather than a listing id. Reviews can use it because
 * `reviews` is UNIQUE(order_id): one order number identifies at most one review.
 *
 * **The id cursor** — promotions. `promotions` has no human reference and no unique non-uuid column, so its
 * tie-breaker is the promotion's own id. That is the same tie-breaker the public catalogue cursor has carried
 * since 4-B, so it is this repository's established convention rather than a new one — and it is used here on
 * a private surface rather than a public one. The uuid lives inside the opaque cursor and is projected as no
 * field.
 *
 * **Nothing in either is a secret, and nothing in either is trusted.** Both halves are values the caller
 * already received in the same response, so there is nothing to protect by signing. What matters is that a
 * cursor cannot become a way to say something else: each decoder accepts only an ISO timestamp that parses
 * and a tie-breaker of exactly its own shape, and every other string — truncated, edited, carrying SQL, from
 * an older format — is refused rather than half-read. Even a cursor that passed would be harmless, because
 * the reader it feeds is scoped to the caller's own rows by the database.
 */

/** `MP-26-001001` — the shape `app_private.next_reference` produces, and nothing looser. */
const REFERENCE_PATTERN = /^[A-Z]{2,8}-[0-9]{2}-[0-9]{6,12}$/;
const REFERENCE_CURSOR_PATTERN = /^([0-9T:.\-Z]+)\|([A-Z0-9-]{8,32})$/;
const ID_CURSOR_PATTERN =
  /^([0-9T:.\-Z]+)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export interface SellerReferenceCursor {
  readonly at: Date;
  readonly reference: string;
}

export interface SellerIdCursor {
  readonly at: Date;
  readonly id: string;
}

function decodeBase64url(cursor: string): string | null {
  try {
    return Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

export function encodeSellerReferenceCursor(at: Date, reference: string): string {
  return Buffer.from(`${at.toISOString()}|${reference}`, 'utf8').toString('base64url');
}

export function decodeSellerReferenceCursor(cursor: string): SellerReferenceCursor | null {
  const decoded = decodeBase64url(cursor);
  if (decoded === null) return null;
  const match = REFERENCE_CURSOR_PATTERN.exec(decoded);
  if (match === null) return null;
  const reference = match[2]!;
  if (!REFERENCE_PATTERN.test(reference)) return null;
  const at = new Date(match[1]!);
  return Number.isNaN(at.getTime()) ? null : { at, reference };
}

export function encodeSellerIdCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`, 'utf8').toString('base64url');
}

export function decodeSellerIdCursor(cursor: string): SellerIdCursor | null {
  const decoded = decodeBase64url(cursor);
  if (decoded === null) return null;
  const match = ID_CURSOR_PATTERN.exec(decoded);
  if (match === null) return null;
  const at = new Date(match[1]!);
  return Number.isNaN(at.getTime()) ? null : { at, id: match[2]! };
}
