/**
 * The two moderation queue cursors (Phase 7-N).
 *
 * The same shape, the same reasoning and the same guarantees as every other cursor on this platform, because
 * it is the same kind of value: a cursor names a **position in a total order** and nothing else. It is not a
 * credential and confers no access — both readers behind these re-apply their own permission test with the
 * account and the assurance level as parameters, so a cursor that has been edited can only move a colleague
 * who already holds the key around inside rows they may already read. That is why there is no signature.
 *
 * What it *is* protected against is misinterpretation. A cursor is client text, and client text that reaches
 * a query is how injection happens, so nothing here is ever interpolated: a cursor decodes to a fixed pair of
 * typed values or to nothing at all, and those values are bound as query parameters by the store. No branch
 * below builds a SQL fragment, a column name or an ordering direction from its content.
 *
 * **Two version tags, because there are two queues.** `mr1` is the report queue and `ml1` the listings
 * awaiting review. Both are ordered **oldest first**, which is what a work queue is; a cursor of one kind
 * cannot be spent on the other, and neither can a position from any other list on this platform, because the
 * tag is checked before anything else.
 *
 * **Total.** Both orders are `(created_at, id)`, `created_at` is `not null` on both tables and both
 * identifiers are primary keys, so the pair identifies exactly one row. Rows written in one transaction are
 * ordered by identifier rather than skipped or repeated, which matters because `now()` is transaction-stable.
 *
 * **Deterministic.** The timestamp is ISO-8601 in UTC with milliseconds and the identifier is its canonical
 * lower-case form, so the same position always encodes to the same string.
 */

export const MODERATION_REPORTS_CURSOR_VERSION = 'mr1';
export const MODERATION_LISTINGS_CURSOR_VERSION = 'ml1';

const SEPARATOR = '|';

/** ISO-8601, UTC, milliseconds — exactly what `Date.prototype.toISOString` produces, and only that. */
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** base64url with no padding, which is what `Buffer` produces and what a URL can carry unescaped. */
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/** A position: when the row was created, and which row it is. */
export interface ModerationPosition {
  readonly createdAt: Date;
  readonly id: string;
}

/**
 * Decodes strictly, in a way `Buffer.from` is not.
 *
 * `Buffer.from` silently ignores characters it does not recognise, so `"!!!!"` would decode to something
 * rather than failing. Checking the alphabet first, then requiring the round trip to reproduce the input, is
 * what turns a malformed cursor into a refusal instead of a wrong position.
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

function encode(version: string, position: ModerationPosition): string {
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
function decodePosition(version: string, cursor: string): ModerationPosition | null {
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

export function encodeModerationReportsCursor(position: ModerationPosition): string {
  return encode(MODERATION_REPORTS_CURSOR_VERSION, position);
}

export function decodeModerationReportsCursor(cursor: string): ModerationPosition | null {
  return decodePosition(MODERATION_REPORTS_CURSOR_VERSION, cursor);
}

export function encodeModerationListingsCursor(position: ModerationPosition): string {
  return encode(MODERATION_LISTINGS_CURSOR_VERSION, position);
}

export function decodeModerationListingsCursor(cursor: string): ModerationPosition | null {
  return decodePosition(MODERATION_LISTINGS_CURSOR_VERSION, cursor);
}
