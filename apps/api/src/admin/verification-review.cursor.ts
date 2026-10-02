/**
 * The verification review queue cursor (Phase 7-G).
 *
 * The same shape, the same reasoning and the same guarantees as the messaging cursors of 5-C, the
 * notification cursor of 7-C and the account cursors of 7-E, because it is the same kind of value: a
 * cursor names a **position in a total order** and nothing else. It is not a credential and confers no
 * access — every reader behind it re-applies the reviewer permission test in the database, so a cursor
 * that has been edited can only move an authorized reviewer around inside the queue they may already
 * read, and does nothing at all for anybody else. That is why there is no signature here.
 *
 * What it *is* protected against is misinterpretation. A cursor is client text, and client text that
 * reaches a query is how injection happens, so nothing here is ever interpolated: a cursor decodes to a
 * fixed pair of typed values or to nothing at all, and those values are bound as query parameters by the
 * store. No branch below builds a SQL fragment, a column name or an ordering direction from its content.
 *
 * **Versioned.** `vq1` names a position in the verification queue, so a favorites or notification cursor
 * cannot be spent here even though all three are a timestamp and an identifier.
 *
 * **Total.** The order is `submitted_at asc, id asc`; every row this queue can return has been submitted
 * — 0009's `seller_verifications_submitted_has_time` guarantees that for every non-draft row — and the
 * identifier is unique, so the pair identifies exactly one row. Two applications submitted in the same
 * microsecond are ordered by identifier rather than skipped or repeated.
 *
 * **Deterministic.** The timestamp is ISO-8601 in UTC with milliseconds and the identifier is its
 * canonical lower-case form, so the same position always encodes to the same string.
 */

/** The seeded permission key this whole surface is gated on. One spelling, in one place. */
export const REVIEW_PERMISSION = 'sellers.verification.review';

export const VERIFICATION_QUEUE_CURSOR_VERSION = 'vq1';

const SEPARATOR = '|';

/** ISO-8601, UTC, milliseconds — exactly what `Date.prototype.toISOString` produces, and only that. */
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** base64url with no padding, which is what `Buffer` produces and what a URL can carry unescaped. */
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/** A position: when the application was submitted, and which application it is. */
export interface VerificationQueuePosition {
  readonly submittedAt: Date;
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

export function encodeVerificationQueueCursor(position: VerificationQueuePosition): string {
  return Buffer.from(
    [
      VERIFICATION_QUEUE_CURSOR_VERSION,
      position.submittedAt.toISOString(),
      position.id.toLowerCase(),
    ].join(SEPARATOR),
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
export function decodeVerificationQueueCursor(cursor: string): VerificationQueuePosition | null {
  const text = decode(cursor);
  if (text === null) return null;

  const parts = text.split(SEPARATOR);
  if (parts.length !== 3) return null;
  const [tag, timestamp, id] = parts as [string, string, string];
  if (tag !== VERIFICATION_QUEUE_CURSOR_VERSION) return null;
  if (!UUID_PATTERN.test(id)) return null;
  if (!TIMESTAMP_PATTERN.test(timestamp)) return null;

  const submittedAt = new Date(timestamp);
  if (Number.isNaN(submittedAt.getTime())) return null;
  // `2026-02-31T…` matches the pattern and is not a date; re-serialising catches it.
  if (submittedAt.toISOString() !== timestamp) return null;
  return { submittedAt, id };
}
