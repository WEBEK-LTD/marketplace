/**
 * The support console's cursors (Phase 7-L).
 *
 * The same shape, the same reasoning and the same guarantees as every other cursor in this project: a
 * cursor names a **position in a total order** and nothing else. It is not a credential and confers no
 * access — every reader behind these is scoped, inside the statement, to the permission the caller holds
 * and to the tickets they may work on, so a cursor that has been edited can only move somebody around
 * inside rows they could already see. That is why there is no signature here.
 *
 * What it *is* protected against is misinterpretation. A cursor is client text, and client text that
 * reaches a query is how injection happens, so nothing here is ever interpolated: a cursor decodes to a
 * fixed pair of typed values or to nothing at all, and those values are bound as query parameters by the
 * store. No branch below builds a SQL fragment, a column name or an ordering direction from its content.
 *
 * **Three version tags, because there are three orders.** `sq1` is the shared queue, oldest first; `sa1` is
 * the agent's own list, newest first; `sn1` is a ticket's internal notes, read backwards from the newest.
 * A cursor of one kind cannot be spent on another — the tag is checked before anything else — and none of
 * them can be spent on 7-K's requester cursors either, which is what keeps two opposite orders from
 * quietly becoming one wrong place.
 *
 * **The conversation deliberately reuses 7-K's `sm1`.** The agent reads the same table in the same total
 * order as the requester, so a position in one is exactly a position in the other; what differs is the
 * predicate, which is fixed in the database and not in the cursor. Minting a second tag for an identical
 * order would be two names for one thing, which is how they drift.
 *
 * **Total.** Every order is `(created_at, id)`, `created_at` is `not null` on all three tables and the
 * identifiers are unique, so the pair identifies exactly one row. Rows written in the same transaction —
 * which happens on every new ticket — are ordered by identifier rather than skipped or repeated.
 *
 * **Deterministic.** The timestamp is ISO-8601 in UTC with milliseconds and the identifier is its canonical
 * lower-case form, so the same position always encodes to the same string.
 */

export const SUPPORT_QUEUE_CURSOR_VERSION = 'sq1';
export const SUPPORT_ASSIGNED_CURSOR_VERSION = 'sa1';
export const SUPPORT_NOTES_CURSOR_VERSION = 'sn1';

const SEPARATOR = '|';

/** ISO-8601, UTC, milliseconds — exactly what `Date.prototype.toISOString` produces, and only that. */
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** base64url with no padding, which is what `Buffer` produces and what a URL can carry unescaped. */
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/** A position: when the row was created, and which row it is. */
export interface SupportConsolePosition {
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

function encode(version: string, position: SupportConsolePosition): string {
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
 * reason is never reported, because a client's remedy is the same in every case and naming the flaw would
 * only help somebody probing the format.
 */
function decodePosition(version: string, cursor: string): SupportConsolePosition | null {
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

export function encodeSupportQueueCursor(position: SupportConsolePosition): string {
  return encode(SUPPORT_QUEUE_CURSOR_VERSION, position);
}

export function decodeSupportQueueCursor(cursor: string): SupportConsolePosition | null {
  return decodePosition(SUPPORT_QUEUE_CURSOR_VERSION, cursor);
}

export function encodeSupportAssignedCursor(position: SupportConsolePosition): string {
  return encode(SUPPORT_ASSIGNED_CURSOR_VERSION, position);
}

export function decodeSupportAssignedCursor(cursor: string): SupportConsolePosition | null {
  return decodePosition(SUPPORT_ASSIGNED_CURSOR_VERSION, cursor);
}

export function encodeSupportNotesCursor(position: SupportConsolePosition): string {
  return encode(SUPPORT_NOTES_CURSOR_VERSION, position);
}

export function decodeSupportNotesCursor(cursor: string): SupportConsolePosition | null {
  return decodePosition(SUPPORT_NOTES_CURSOR_VERSION, cursor);
}
