import { LISTING_SLUG_PATTERN } from '@repo/contracts';

/**
 * The seller listings cursor (Phase 6-F).
 *
 * The same idea as the public catalogue's cursor and deliberately not the same function: that one's
 * tie-breaker is a listing uuid, and the seller surface carries no uuid anywhere. This one's tie-breaker is
 * the slug, which is the column the database reader orders by, so the two cannot be interchanged by accident
 * and neither has to be loosened to accommodate the other.
 *
 * It encodes the exact keyset position — the sort key and the tie-breaker of the last row of the page the
 * caller actually received — because that is what a keyset query needs in order to resume without skipping
 * or repeating a row. It is base64url so that it survives a query string untouched, and opaque because its
 * shape is this service's business: a client that parsed it would be depending on the sort order, which is
 * not part of the contract.
 *
 * **Nothing in it is a secret, and nothing in it is trusted.** Both halves are values the caller already
 * received in the same response, so there is nothing to protect by signing it. What matters is that a cursor
 * cannot become a way to say something else: the decoder accepts only an ISO timestamp that parses and a slug
 * that matches the listings table's own format, and every other string — a truncated one, an edited one, one
 * carrying SQL, one from an older format — is refused rather than half-read. Even a cursor that passed would
 * be harmless, because the reader it feeds is scoped to the caller's own rows by the database.
 */

const CURSOR_PATTERN = /^([0-9T:.\-Z]+)\|([a-z0-9-]{3,120})$/;

export interface SellerListingCursor {
  readonly createdAt: Date;
  readonly slug: string;
}

export function encodeSellerListingCursor(createdAt: Date, slug: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${slug}`, 'utf8').toString('base64url');
}

export function decodeSellerListingCursor(cursor: string): SellerListingCursor | null {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const match = CURSOR_PATTERN.exec(decoded);
  if (match === null) return null;
  const slug = match[2]!;
  if (!LISTING_SLUG_PATTERN.test(slug)) return null;
  const createdAt = new Date(match[1]!);
  return Number.isNaN(createdAt.getTime()) ? null : { createdAt, slug };
}
