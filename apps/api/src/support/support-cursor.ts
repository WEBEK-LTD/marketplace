/**
 * The two support cursors (Phase 7-K).
 *
 * The same shape, the same reasoning and the same guarantees as the messaging cursors of 5-C, the
 * notification cursor of 7-C, the account cursors of 7-E, the verification queue cursor of 7-G, the offer
 * cursor of 7-H and the service request cursors of 7-I and 7-J, because it is the same kind of value: a
 * cursor names a **position in a total order** and nothing else. It is not a credential and confers no
 * access — both readers behind these are scoped to the caller's own tickets inside the statement, so a
 * cursor that has been edited can only move somebody around inside their own rows. That is why there is no
 * signature here.
 *
 * What it *is* protected against is misinterpretation. A cursor is client text, and client text that
 * reaches a query is how injection happens, so nothing here is ever interpolated: a cursor decodes to a
 * fixed pair of typed values or to nothing at all, and those values are bound as query parameters by the
 * store. No branch below builds a SQL fragment, a column name or an ordering direction from its content.
 *
 * **Two version tags, because there are two orders.** `st1` is the ticket list, newest first; `sm1` is a
 * conversation, which is read backwards from its newest end. A cursor of one kind cannot be spent on the
 * other: the tag is checked before anything else, so a ticket position handed to the message reader
 * decodes to nothing rather than to a plausible wrong place.
 *
 * **Total.** Both orders are `(created_at, id)`, `created_at` is `not null` on both tables and both
 * identifiers are unique, so the pair identifies exactly one row. Two rows written in the same transaction
 * — which happens on every new ticket, since the first message is posted inside it — are ordered by
 * identifier rather than skipped or repeated.
 *
 * **Deterministic.** The timestamp is ISO-8601 in UTC with milliseconds and the identifier is its
 * canonical lower-case form, so the same position always encodes to the same string.
 */

export const SUPPORT_TICKETS_CURSOR_VERSION = 'st1';
export const SUPPORT_MESSAGES_CURSOR_VERSION = 'sm1';

const SEPARATOR = '|';

/** ISO-8601, UTC, milliseconds — exactly what `Date.prototype.toISOString` produces, and only that. */
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** base64url with no padding, which is what `Buffer` produces and what a URL can carry unescaped. */
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/** A position: when the row was created, and which row it is. */
export interface SupportPosition {
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

function encode(version: string, position: SupportPosition): string {
  return Buffer.from(
    [version, position.createdAt.toISOString(), position.id.toLowerCase()].join(SEPARATOR),
    'utf8',
  ).toString('base64url');
}

/**
 * Decodes one position, or refuses.
 *
 * Every part is checked: the tag, the field count, the timestamp shape, the date's validity and the
 * identifier's shape. Anything that fails returns null, and the caller turns that into one refusal — the
 * reason is never reported, because a client's remedy is the same in every case (drop the cursor and start
 * again) and naming the flaw would only help somebody probing the format.
 */
function decodePosition(version: string, cursor: string): SupportPosition | null {
  const text = decode(cursor);
  if (text === null) return null;

  const parts = text.split(SEPARATOR);
  if (parts.length !== 3) return null;
  const [tag, timestamp, id] = parts as [string, string, string];
  if (tag !== version) return null;
  if (!UUID_PATTERN.test(id)) return null;
  if (!TIMESTAMP_PATTERN.test(timestamp)) return null;

  const createdAt = new Date(timestamp);
  if (Number.isNaN(createdAt.getTime())) return null;
  // `2026-02-31T…` matches the pattern and is not a date; re-serialising catches it.
  if (createdAt.toISOString() !== timestamp) return null;
  return { createdAt, id };
}

export function encodeSupportTicketsCursor(position: SupportPosition): string {
  return encode(SUPPORT_TICKETS_CURSOR_VERSION, position);
}

export function decodeSupportTicketsCursor(cursor: string): SupportPosition | null {
  return decodePosition(SUPPORT_TICKETS_CURSOR_VERSION, cursor);
}

export function encodeSupportMessagesCursor(position: SupportPosition): string {
  return encode(SUPPORT_MESSAGES_CURSOR_VERSION, position);
}

export function decodeSupportMessagesCursor(cursor: string): SupportPosition | null {
  return decodePosition(SUPPORT_MESSAGES_CURSOR_VERSION, cursor);
}
