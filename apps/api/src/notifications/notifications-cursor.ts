/**
 * The notification list cursor (Phase 7-C).
 *
 * The same shape, the same reasoning and the same guarantees as the messaging cursors of 5-C, because it
 * is the same kind of value: a cursor names a **position in a total order** and nothing else. It is not a
 * credential and confers no access — `app_private.notifications_inbox` is scoped by the account the API
 * resolved from the session, so a cursor that has been edited can only move the caller around inside
 * their own notifications. That is why there is no signature here.
 *
 * What it *is* protected against is misinterpretation. A cursor is client text, and client text that
 * reaches a query is how injection happens, so nothing here is ever interpolated: a cursor decodes to a
 * fixed pair of typed values or to nothing at all, and those values are bound as query parameters by the
 * store. No branch below builds a SQL fragment, a column name or an ordering direction from its content.
 *
 * **Versioned, and versioned per kind.** `nt1` names both the format and the list it belongs to, so a
 * messaging cursor cannot be spent here and a future format change becomes `nt2` rather than being read
 * with the wrong field order.
 *
 * **Total, which matters more here than in messaging.** The order is `created_at desc, id desc`, and
 * `created_at` has no null case — the column is `not null` — so unlike the inbox cursor there is no
 * undated tail to place. Both halves are always present, and `id` is unique, so the pair identifies
 * exactly one row. Notifications created in one transaction share a timestamp to the microsecond, which
 * is routine: a message to several recipients writes them together. A cursor made of the timestamp alone
 * would skip or repeat those rows; this one cannot.
 *
 * **Deterministic.** The timestamp is ISO-8601 in UTC with milliseconds and the identifier is its
 * canonical lower-case form, so the same position always encodes to the same string.
 */

/** The notification order is `created_at desc, id desc`, so a position is that pair. */
export const NOTIFICATIONS_CURSOR_VERSION = 'nt1';

const SEPARATOR = '|';

/** ISO-8601, UTC, milliseconds — exactly what `Date.prototype.toISOString` produces, and only that. */
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** base64url with no padding, which is what `Buffer` produces and what a URL can carry unescaped. */
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface NotificationsPosition {
  /** Never null: `notifications.created_at` is `not null`, so every row has a place in the order. */
  readonly createdAt: Date;
  readonly notificationId: string;
}

function encode(payload: string): string {
  return Buffer.from(payload, 'utf8').toString('base64url');
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

export function encodeNotificationsCursor(position: NotificationsPosition): string {
  return encode(
    [NOTIFICATIONS_CURSOR_VERSION, position.createdAt.toISOString(), position.notificationId].join(
      SEPARATOR,
    ),
  );
}

/**
 * Decodes one position, or refuses.
 *
 * Every part is checked: the tag, the field count, the timestamp shape, the date's validity and the
 * identifier's shape. Anything that fails returns null, and the caller turns that into one refusal — the
 * reason is never reported, because a client's remedy is the same in every case (drop the cursor and
 * start again) and naming the flaw would only help somebody probing the format.
 */
export function decodeNotificationsCursor(cursor: string): NotificationsPosition | null {
  const text = decode(cursor);
  if (text === null) return null;

  const parts = text.split(SEPARATOR);
  if (parts.length !== 3) return null;
  const [version, timestamp, notificationId] = parts as [string, string, string];
  if (version !== NOTIFICATIONS_CURSOR_VERSION) return null;
  if (!UUID_PATTERN.test(notificationId)) return null;
  if (!TIMESTAMP_PATTERN.test(timestamp)) return null;

  const createdAt = new Date(timestamp);
  if (Number.isNaN(createdAt.getTime())) return null;
  // `2026-02-31T…` matches the pattern and is not a date; re-serialising catches it.
  if (createdAt.toISOString() !== timestamp) return null;
  return { createdAt, notificationId };
}
