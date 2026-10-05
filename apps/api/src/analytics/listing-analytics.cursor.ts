/**
 * The listing analytics cursor (0102).
 *
 * The same shape, reasoning and guarantees as every other cursor on this platform, because it is the same kind
 * of value: a cursor names a **position in a total order** and nothing else. It is not a credential and confers
 * no access — the reader behind it re-applies `analytics.listing.read` and the assurance level as parameters, so
 * an edited cursor can only move a colleague who already holds the key around inside rows they may already read.
 * That is why there is no signature.
 *
 * What it *is* protected against is misinterpretation. A cursor is client text, and client text that reaches a
 * query is how injection happens, so nothing here is ever interpolated: a cursor decodes to a fixed pair of
 * typed values or to nothing at all, and the store binds those as query parameters.
 *
 * **`la1`, and its own tag for a reason.** The order is `(day desc, listing_id desc)`, and the leading field is
 * a **calendar day** rather than a timestamp — the only cursor on this platform whose position is a date. A
 * position from any other list would carry a timestamp and a different tag, and is refused before anything else
 * is looked at; that matters because those lists sit behind different permission keys.
 *
 * **Total.** `day` is `not null` and `(listing_id, day)` is the table's primary key, so the pair identifies
 * exactly one row: no row is repeated or skipped at a page boundary, however many listings share a day.
 *
 * **Deterministic.** The day is the ten characters of an ISO calendar date and the uuid is its canonical
 * lower-case form, so the same position always encodes to the same string.
 */

export const LISTING_ANALYTICS_CURSOR_VERSION = 'la1';

const SEPARATOR = '|';

/** An ISO-8601 calendar date and only that: no time, no offset, no partial. */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** base64url with no padding, which is what `Buffer` produces and what a URL can carry unescaped. */
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface ListingAnalyticsPosition {
  /** The calendar day, as the ten characters the database column holds. */
  readonly day: string;
  readonly listingId: string;
}

/**
 * Decodes strictly, in a way `Buffer.from` is not.
 *
 * `Buffer.from` silently ignores characters it does not recognise, so `"!!!!"` would decode to something rather
 * than failing. Checking the alphabet first, then requiring the round trip to reproduce the input, is what turns
 * a malformed cursor into a refusal instead of a wrong position.
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

export function encodeListingAnalyticsCursor(position: ListingAnalyticsPosition): string {
  return Buffer.from(
    [LISTING_ANALYTICS_CURSOR_VERSION, position.day, position.listingId.toLowerCase()].join(SEPARATOR),
    'utf8',
  ).toString('base64url');
}

/**
 * One position, or nothing.
 *
 * Every part is checked: the tag, the field count, the day's shape, the day's validity as a date, and the
 * identifier's shape. Anything that fails returns null, and the caller turns that into one refusal — the reason
 * is never reported, because a client's remedy is the same in every case (drop the cursor and start again) and
 * naming the flaw would only help somebody probing the format.
 */
export function decodeListingAnalyticsCursor(cursor: string): ListingAnalyticsPosition | null {
  const text = decode(cursor);
  if (text === null) return null;

  const parts = text.split(SEPARATOR);
  if (parts.length !== 3) return null;
  const [tag, day, listingId] = parts as [string, string, string];
  if (tag !== LISTING_ANALYTICS_CURSOR_VERSION) return null;
  if (!DAY_PATTERN.test(day)) return null;
  if (!UUID_PATTERN.test(listingId)) return null;

  // `2026-02-31` matches the pattern and is not a day; re-serialising catches it.
  const parsed = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  if (parsed.toISOString().slice(0, 10) !== day) return null;

  return { day, listingId };
}
