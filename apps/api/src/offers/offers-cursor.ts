/**
 * The offer list cursor (Phase 7-H).
 *
 * The same shape, the same reasoning and the same guarantees as the messaging cursors of 5-C, the
 * notification cursor of 7-C, the account cursors of 7-E and the verification queue cursor of 7-G,
 * because it is the same kind of value: a cursor names a **position in a total order** and nothing else.
 * It is not a credential and confers no access — both readers behind it are scoped to the caller's own
 * side of a negotiation inside the statement, so a cursor that has been edited can only move somebody
 * around inside their own rows. That is why there is no signature here.
 *
 * What it *is* protected against is misinterpretation. A cursor is client text, and client text that
 * reaches a query is how injection happens, so nothing here is ever interpolated: a cursor decodes to a
 * fixed pair of typed values or to nothing at all, and those values are bound as query parameters by the
 * store. No branch below builds a SQL fragment, a column name or an ordering direction from its content.
 *
 * **One version, `of1`, for both sides.** The two lists are the same order over the same table, and a
 * position in one is a position in the other; what differs is the predicate, which is fixed in the
 * database and not in the cursor. So a buyer's cursor spent on the seller's list names a real position
 * and still cannot show them a row that is not theirs.
 *
 * **Total.** The order is `created_at desc, id desc`, `created_at` is `not null`, and the identifier is
 * unique, so the pair identifies exactly one row. Two offers created in the same microsecond are ordered
 * by identifier rather than skipped or repeated.
 *
 * **Deterministic.** The timestamp is ISO-8601 in UTC with milliseconds and the identifier is its
 * canonical lower-case form, so the same position always encodes to the same string.
 */

export const OFFERS_CURSOR_VERSION = 'of1';

const SEPARATOR = '|';

/** ISO-8601, UTC, milliseconds — exactly what `Date.prototype.toISOString` produces, and only that. */
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** base64url with no padding, which is what `Buffer` produces and what a URL can carry unescaped. */
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/** A position: when the offer was created, and which offer it is. */
export interface OffersPosition {
  readonly createdAt: Date;
  readonly id: string;
}

/**
 * Decodes strictly, in a way `Buffer.from` is not.
 *
 * `Buffer.from` silently ignores characters it does not recognise, so `"!!!!"` would decode to something
 * rather than failing. Checking the alphabet first, then requiring the round trip to reproduce the input,
 * is what turns a malformed cursor into a refusal instead of a wrong position.
 */
function decode(cursor: string): string | null {
  if (typeof cursor !== 'string' || cursor === '' || !BASE64URL_PATTERN.test(cursor)) return null;
  let text: string;
  try {
    text = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  return Buffer.from(text, 'utf8').toString('base64url') === cursor ? text : null;
}

export function encodeOffersCursor(position: OffersPosition): string {
  return Buffer.from(
    [OFFERS_CURSOR_VERSION, position.createdAt.toISOString(), position.id.toLowerCase()].join(SEPARATOR),
    'utf8',
  ).toString('base64url');
}

/**
 * Decodes one position, or refuses.
 *
 * Every part is checked: the tag, the field count, the timestamp shape, the date's validity and the
 * identifier's shape. Anything that fails returns null, and the caller turns that into one refusal — the
 * reason is never reported, because a client's remedy is the same in every case (drop the cursor and
 * start again) and naming the flaw would only help somebody probing the format.
 */
export function decodeOffersCursor(cursor: string): OffersPosition | null {
  const text = decode(cursor);
  if (text === null) return null;

  const parts = text.split(SEPARATOR);
  if (parts.length !== 3) return null;
  const [tag, timestamp, id] = parts as [string, string, string];
  if (tag !== OFFERS_CURSOR_VERSION) return null;
  if (!UUID_PATTERN.test(id)) return null;
  if (!TIMESTAMP_PATTERN.test(timestamp)) return null;

  const createdAt = new Date(timestamp);
  if (Number.isNaN(createdAt.getTime())) return null;
  // `2026-02-31T…` matches the pattern and is not a date; re-serialising catches it.
  if (createdAt.toISOString() !== timestamp) return null;
  return { createdAt, id };
}
