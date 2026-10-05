/**
 * The CMS media cursor.
 *
 * The same shape, the same reasoning and the same guarantees as every other cursor on this platform: a cursor names
 * a **position in a total order** and nothing else. It is not a credential and confers no access — the reader behind
 * it re-applies its own permission test with the account and the assurance level as parameters, so a cursor that has
 * been edited can only move somebody who already holds `cms.media.manage` around inside rows they may already read.
 * That is why there is no signature.
 *
 * What it *is* protected against is misinterpretation. A cursor is client text, and client text that reaches a query
 * is how injection happens, so nothing here is ever interpolated: a cursor decodes to a fixed pair of typed values
 * or to nothing at all, and those values are bound as query parameters by the store.
 *
 * **One version tag, `cm1`.** Every other tag in use is refused before anything else is looked at. The library is
 * ordered newest first, which is a different order from every list that shares this shape, so a position in one of
 * those would be a real position in the wrong list.
 *
 * **Total.** `cms_media.created_at` is `not null` and `id` is the primary key, so the pair identifies exactly one
 * row. That totality is load-bearing rather than theoretical: several entries uploaded in one batch can share a
 * timestamp, and the identifier is the only thing separating them.
 *
 * **Deterministic.** The timestamp is its canonical ISO form with milliseconds and the identifier its canonical
 * lower-case form, so the same position always encodes to the same string.
 */

export const CMS_MEDIA_CURSOR_VERSION = 'cm1';

const SEPARATOR = '|';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** An ISO instant in exactly the form `toISOString` produces, which is the only form this encodes. */
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** base64url with no padding, which is what `Buffer` produces and what a URL can carry unescaped. */
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/** A position: when the entry was uploaded, and which entry. */
export interface CmsMediaPosition {
  readonly createdAt: string;
  readonly id: string;
}

/**
 * Decodes strictly, in a way `Buffer.from` is not.
 *
 * `Buffer.from` silently ignores characters it does not recognise, so `"!!!!"` would decode to something rather than
 * failing. Checking the alphabet first, then requiring the round trip to reproduce the input, is what turns a
 * malformed cursor into a refusal instead of a wrong position.
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

export function encodeCmsMediaCursor(position: CmsMediaPosition): string {
  return Buffer.from(
    [CMS_MEDIA_CURSOR_VERSION, position.createdAt, position.id.toLowerCase()].join(SEPARATOR),
    'utf8',
  ).toString('base64url');
}

/**
 * Decodes one position, or refuses.
 *
 * Every part is checked: the tag, the field count, the instant's shape and the identifier's shape. Anything that
 * fails returns null, and the caller turns that into one refusal — the reason is never reported, because a client's
 * remedy is the same in every case (drop the cursor and start again) and naming the flaw would only help somebody
 * probing the format.
 */
export function decodeCmsMediaCursor(cursor: string): CmsMediaPosition | null {
  const text = decode(cursor);
  if (text === null) return null;

  const parts = text.split(SEPARATOR);
  if (parts.length !== 3) return null;
  const [tag, createdAt, id] = parts as [string, string, string];
  if (tag !== CMS_MEDIA_CURSOR_VERSION) return null;
  if (!INSTANT_PATTERN.test(createdAt)) return null;
  if (Number.isNaN(Date.parse(createdAt))) return null;
  if (!UUID_PATTERN.test(id)) return null;

  return { createdAt, id };
}
