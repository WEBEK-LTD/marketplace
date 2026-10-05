/**
 * The review queue cursor (Phase 7-P).
 *
 * The same shape, the same reasoning and the same guarantees as every other cursor on this platform, because
 * it is the same kind of value: a cursor names a **position in a total order** and nothing else. It is not a
 * credential and confers no access — the reader behind it re-applies its own permission test with the account
 * and the assurance level as parameters, so a cursor that has been edited can only move a colleague who
 * already holds the key around inside rows they may already read. That is why there is no signature.
 *
 * What it *is* protected against is misinterpretation. A cursor is client text, and client text that reaches
 * a query is how injection happens, so nothing here is ever interpolated: a cursor decodes to a fixed pair of
 * typed values or to nothing at all, and those values are bound as query parameters by the store. No branch
 * below builds a SQL fragment, a column name or an ordering direction from its content.
 *
 * **One version tag, `rv1`.** The review queue is ordered `(created_at desc, id desc)` — **newest first**,
 * unlike the support and recovery queues, because a review is published immediately rather than arriving in a
 * state that needs draining. A position from any other list on this platform is refused, because the tag is
 * checked before anything else — including the recovery queue's `rq1`, which carries the very same pair of
 * fields in the opposite order and would otherwise decode here as a perfectly valid position.
 *
 * **Total.** `reviews.created_at` is `not null` and `id` is the primary key, so the pair identifies exactly
 * one row. Rows written in one transaction are ordered by identifier rather than skipped or repeated, which
 * matters because `now()` is transaction-stable.
 *
 * **Deterministic.** The timestamp is ISO-8601 in UTC with milliseconds and the identifier is its canonical
 * lower-case form, so the same position always encodes to the same string.
 */

export const REVIEW_QUEUE_CURSOR_VERSION = 'rv1';

const SEPARATOR = '|';

/** ISO-8601, UTC, milliseconds — exactly what `Date.prototype.toISOString` produces, and only that. */
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** base64url with no padding, which is what `Buffer` produces and what a URL can carry unescaped. */
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/** A position: when the review was created, and which review it is. */
export interface ReviewQueuePosition {
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

export function encodeReviewQueueCursor(position: ReviewQueuePosition): string {
  return Buffer.from(
    [REVIEW_QUEUE_CURSOR_VERSION, position.createdAt.toISOString(), position.id.toLowerCase()].join(
      SEPARATOR,
    ),
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
export function decodeReviewQueueCursor(cursor: string): ReviewQueuePosition | null {
  const text = decode(cursor);
  if (text === null) return null;

  const parts = text.split(SEPARATOR);
  if (parts.length !== 3) return null;
  const [tag, timestamp, id] = parts as [string, string, string];
  if (tag !== REVIEW_QUEUE_CURSOR_VERSION) return null;
  if (!UUID_PATTERN.test(id)) return null;
  if (!TIMESTAMP_PATTERN.test(timestamp)) return null;

  const createdAt = new Date(timestamp);
  if (Number.isNaN(createdAt.getTime())) return null;
  // `2026-02-31T…` matches the pattern and is not a date; re-serialising catches it.
  if (createdAt.toISOString() !== timestamp) return null;
  return { createdAt, id };
}
