/**
 * The redirect-map cursor.
 *
 * The same shape, the same reasoning and the same guarantees as every other cursor on this platform: a cursor
 * names a **position in a total order** and nothing else. It is not a credential and confers no access — the
 * reader behind it re-applies its own permission test with the account and the assurance level as parameters, so
 * a cursor that has been edited can only move somebody who already holds `seo.redirect.read` around inside rows
 * they may already read. That is why there is no signature.
 *
 * What it *is* protected against is misinterpretation. A cursor is client text, and client text that reaches a
 * query is how injection happens, so nothing here is ever interpolated: a cursor decodes to a fixed pair of
 * typed values or to nothing at all, and those values are bound as query parameters by the store.
 *
 * **One version tag, `rd1`.** Every other tag in use is refused before anything else is looked at, which matters
 * most for the tags carrying this very same `(timestamp, uuid)` pair over different rows behind different keys —
 * the authored pages' `cp1`, the job runs' `jr1`, the recovery queue's `rq1`. A position in one of those is a
 * real position in the wrong list.
 *
 * **Total.** `redirects.updated_at` is `not null` with a default and `id` is the primary key, so the pair
 * identifies exactly one row. That totality is load-bearing rather than theoretical: `updated_at` is set from
 * `now()`, which is transaction-stable, so several entries created in one transaction share a timestamp exactly
 * and the identifier is the only thing separating them.
 *
 * **Deterministic.** The timestamp is ISO-8601 in UTC with milliseconds and the identifier is its canonical
 * lower-case form, so the same position always encodes to the same string.
 */

export const SEO_REDIRECT_CURSOR_VERSION = 'rd1';

const SEPARATOR = '|';

/** ISO-8601, UTC, milliseconds — exactly what `Date.prototype.toISOString` produces, and only that. */
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** base64url with no padding, which is what `Buffer` produces and what a URL can carry unescaped. */
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/** A position: when the entry was last changed, and which entry it is. */
export interface SeoRedirectPosition {
  readonly updatedAt: Date;
  readonly id: string;
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

export function encodeSeoRedirectCursor(position: SeoRedirectPosition): string {
  return Buffer.from(
    [SEO_REDIRECT_CURSOR_VERSION, position.updatedAt.toISOString(), position.id.toLowerCase()].join(SEPARATOR),
    'utf8',
  ).toString('base64url');
}

/**
 * Decodes one position, or refuses.
 *
 * Every part is checked: the tag, the field count, the timestamp shape, the date's validity and the identifier's
 * shape. Anything that fails returns null, and the caller turns that into one refusal — the reason is never
 * reported, because a client's remedy is the same in every case (drop the cursor and start again) and naming the
 * flaw would only help somebody probing the format.
 */
export function decodeSeoRedirectCursor(cursor: string): SeoRedirectPosition | null {
  const text = decode(cursor);
  if (text === null) return null;

  const parts = text.split(SEPARATOR);
  if (parts.length !== 3) return null;
  const [tag, timestamp, id] = parts as [string, string, string];
  if (tag !== SEO_REDIRECT_CURSOR_VERSION) return null;
  if (!UUID_PATTERN.test(id)) return null;
  if (!TIMESTAMP_PATTERN.test(timestamp)) return null;

  const updatedAt = new Date(timestamp);
  if (Number.isNaN(updatedAt.getTime())) return null;
  // `2026-02-31T…` matches the pattern and is not a date; re-serialising catches it.
  if (updatedAt.toISOString() !== timestamp) return null;
  return { updatedAt, id };
}
