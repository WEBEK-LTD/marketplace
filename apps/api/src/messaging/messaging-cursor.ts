/**
 * The messaging cursors (Phase 5-C).
 *
 * A cursor names a **position in a total order** and nothing else. It is not a credential and confers
 * no access: every reader in migration 0053 is scoped by the caller id the API resolved from the
 * session, so a cursor that has been edited can only move the caller around inside their own data. That
 * is why there is no signature here — a MAC would protect a value that grants nothing, at the cost of a
 * new secret in an environment inventory that deliberately admits none.
 *
 * What it *is* protected against is misinterpretation, which is the real risk: a cursor is client text,
 * and client text that reaches a query is how injection happens. So nothing here is ever interpolated.
 * A cursor decodes to a fixed set of typed values or to nothing at all, and those values are bound as
 * query parameters by the store. There is no branch anywhere below that builds a SQL fragment, a column
 * name or an ordering direction from cursor content.
 *
 * **Versioned, and versioned per kind.** Every cursor starts with a tag that names both the format and
 * the list it belongs to. A future format change becomes `mi2`/`mm2` and old cursors are refused
 * cleanly instead of being read with the wrong field order; and an inbox cursor cannot be spent on a
 * message list, because the tags do not match. An unrecognised tag is refused, never guessed at.
 *
 * **Deterministic.** The same position always encodes to the same string: the timestamp is ISO-8601 in
 * UTC with milliseconds, the sequence is its digits, and nothing else varies. Two calls that mean the
 * same page produce the same cursor, which is what makes a page cacheable and a test able to compare
 * them.
 */

/** The inbox order is `last_message_at desc nulls last, id desc`, so a position is that pair. */
export const INBOX_CURSOR_VERSION = 'mi1';

/** A conversation is traversed by `seq` alone. */
export const MESSAGES_CURSOR_VERSION = 'mm1';

/** How a null `last_message_at` is written: the undated tail of the order needs a position too. */
const NULL_TIMESTAMP = '-';

const SEPARATOR = '|';

/** ISO-8601, UTC, milliseconds — exactly what `Date.prototype.toISOString` produces, and only that. */
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A PostgreSQL `bigint` identity value: digits, no leading zero, never zero itself. */
const SEQUENCE_PATTERN = /^[1-9][0-9]*$/;

export interface InboxPosition {
  /** Null for a conversation with no messages, which sorts into the tail of the order. */
  readonly lastMessageAt: Date | null;
  readonly conversationId: string;
}

export interface MessagesPosition {
  /** Kept as digits, never as a number: `seq` is a bigint and a double cannot promise to hold one. */
  readonly seq: string;
}

/**
 * base64url with no padding, which is what `Buffer` produces and what a URL can carry unescaped.
 *
 * The decode is strict in a way `Buffer.from` is not: `Buffer.from` silently ignores characters it does
 * not recognise, so `"!!!!"` would decode to something rather than failing. Checking the alphabet first
 * is what turns a malformed cursor into a refusal instead of a wrong position.
 */
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

function encode(payload: string): string {
  return Buffer.from(payload, 'utf8').toString('base64url');
}

function decode(cursor: string): string | null {
  if (typeof cursor !== 'string' || cursor === '' || !BASE64URL_PATTERN.test(cursor)) return null;
  let text: string;
  try {
    text = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  // A round trip that does not reproduce the input means the input was not canonical base64url.
  return Buffer.from(text, 'utf8').toString('base64url') === cursor ? text : null;
}

/** Encodes one inbox position. The undated tail is written with an explicit marker, never an empty field. */
export function encodeInboxCursor(position: InboxPosition): string {
  const timestamp = position.lastMessageAt === null ? NULL_TIMESTAMP : position.lastMessageAt.toISOString();
  return encode([INBOX_CURSOR_VERSION, timestamp, position.conversationId].join(SEPARATOR));
}

/**
 * Decodes one inbox position, or refuses.
 *
 * Every part is checked: the tag, the field count, the timestamp shape, the date's validity and the
 * uuid's shape. Anything that fails returns null, and the caller turns that into one refusal — the
 * reason is never reported, because a client's remedy is the same in every case (drop the cursor and
 * start again) and naming the flaw would only help somebody probing the format.
 */
export function decodeInboxCursor(cursor: string): InboxPosition | null {
  const text = decode(cursor);
  if (text === null) return null;

  const parts = text.split(SEPARATOR);
  if (parts.length !== 3) return null;
  const [version, timestamp, conversationId] = parts as [string, string, string];
  if (version !== INBOX_CURSOR_VERSION) return null;
  if (!UUID_PATTERN.test(conversationId)) return null;

  if (timestamp === NULL_TIMESTAMP) return { lastMessageAt: null, conversationId };
  if (!TIMESTAMP_PATTERN.test(timestamp)) return null;
  const lastMessageAt = new Date(timestamp);
  if (Number.isNaN(lastMessageAt.getTime())) return null;
  // `2026-02-31T…` matches the pattern and is not a date; re-serialising catches it.
  if (lastMessageAt.toISOString() !== timestamp) return null;
  return { lastMessageAt, conversationId };
}

export function encodeMessagesCursor(position: MessagesPosition): string {
  return encode([MESSAGES_CURSOR_VERSION, position.seq].join(SEPARATOR));
}

export function decodeMessagesCursor(cursor: string): MessagesPosition | null {
  const text = decode(cursor);
  if (text === null) return null;

  const parts = text.split(SEPARATOR);
  if (parts.length !== 2) return null;
  const [version, seq] = parts as [string, string];
  if (version !== MESSAGES_CURSOR_VERSION) return null;
  return SEQUENCE_PATTERN.test(seq) ? { seq } : null;
}
