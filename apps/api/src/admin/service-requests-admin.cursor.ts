/**
 * The Admin Only queue cursor (Phase 7-J).
 *
 * The same shape and the same reasoning as every other cursor in this project — a cursor names a **position in
 * a total order** and nothing else. It is not a credential and confers no access: the reader behind it refuses
 * every caller who does not hold `service_requests.request.read` in a strong enough session, before any cursor
 * is looked at, so a cursor that has been edited can only move an authorized reviewer around inside a queue
 * they may already read in full. That is why there is no signature here.
 *
 * What it *is* protected against is misinterpretation. A cursor is client text, and client text that reaches a
 * query is how injection happens, so nothing here is ever interpolated: a cursor decodes to a fixed pair of
 * typed values or to nothing at all, and those values are bound as query parameters by the store. No branch
 * below builds a SQL fragment, a column name or an ordering direction from its content.
 *
 * **Its own version, `aq1`, and not 7-I's `sr1`.** A position is a position *in an order*, and this queue's
 * order is the opposite of the buyer's list: oldest first, `created_at asc, id asc`, over 0073's partial
 * index. A cursor from one list spent on the other would name a real row and page the wrong way, so the two
 * cannot be confused — the tag refuses it.
 *
 * **Total.** `created_at` is `not null` and the identifier is unique, so the pair identifies exactly one row.
 * Two requests created in the same microsecond are ordered by identifier rather than skipped or repeated.
 *
 * **Deterministic.** ISO-8601 in UTC with milliseconds, and the identifier in its canonical lower-case form.
 */

export const ADMIN_SERVICE_REQUESTS_CURSOR_VERSION = 'aq1';

/** The permission the queue and the detail require. A literal, so it cannot be passed in. */
export const ADMIN_SERVICE_REQUEST_READ_PERMISSION = 'service_requests.request.read';
/** The permission the approved staff closure requires. */
export const ADMIN_SERVICE_REQUEST_MANAGE_PERMISSION = 'service_requests.request.manage';
/** The permission the two descriptive payment fields require, and nothing else does. */
export const SERVICE_REQUEST_PAYMENT_INFO_PERMISSION = 'service_requests.payment_info.read';

const SEPARATOR = '|';

/** ISO-8601, UTC, milliseconds — exactly what `Date.prototype.toISOString` produces, and only that. */
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** base64url with no padding, which is what `Buffer` produces and what a URL can carry unescaped. */
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/** A position: when the request was created, and which request it is. */
export interface AdminServiceRequestsPosition {
  readonly createdAt: Date;
  readonly id: string;
}

/**
 * Decodes strictly, in a way `Buffer.from` is not.
 *
 * `Buffer.from` silently ignores characters it does not recognise, so `"!!!!"` would decode to something rather
 * than failing. Checking the alphabet first, then requiring the round trip to reproduce the input, is what
 * turns a malformed cursor into a refusal instead of a wrong position.
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

export function encodeAdminServiceRequestsCursor(position: AdminServiceRequestsPosition): string {
  return Buffer.from(
    [
      ADMIN_SERVICE_REQUESTS_CURSOR_VERSION,
      position.createdAt.toISOString(),
      position.id.toLowerCase(),
    ].join(SEPARATOR),
    'utf8',
  ).toString('base64url');
}

/**
 * Decodes one position, or refuses.
 *
 * Every part is checked: the tag, the field count, the timestamp shape, the date's validity and the
 * identifier's shape. Anything that fails returns null, and the caller turns that into one refusal — the reason
 * is never reported, because a client's remedy is the same in every case and naming the flaw would only help
 * somebody probing the format.
 */
export function decodeAdminServiceRequestsCursor(cursor: string): AdminServiceRequestsPosition | null {
  const text = decode(cursor);
  if (text === null) return null;

  const parts = text.split(SEPARATOR);
  if (parts.length !== 3) return null;
  const [tag, timestamp, id] = parts as [string, string, string];
  if (tag !== ADMIN_SERVICE_REQUESTS_CURSOR_VERSION) return null;
  if (!UUID_PATTERN.test(id)) return null;
  if (!TIMESTAMP_PATTERN.test(timestamp)) return null;

  const createdAt = new Date(timestamp);
  if (Number.isNaN(createdAt.getTime())) return null;
  // `2026-02-31T…` matches the pattern and is not a date; re-serialising catches it.
  if (createdAt.toISOString() !== timestamp) return null;
  return { createdAt, id };
}
