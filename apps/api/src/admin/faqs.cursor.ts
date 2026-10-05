/**
 * The FAQ-entry cursor.
 *
 * The same shape, the same reasoning and the same guarantees as every other cursor on this platform: a cursor
 * names a **position in a total order** and nothing else. It is not a credential and confers no access — the
 * reader behind it re-applies its own permission test with the account and the assurance level as parameters, so
 * a cursor that has been edited can only move somebody who already holds `cms.faq.read` around inside rows they
 * may already read. That is why there is no signature.
 *
 * What it *is* protected against is misinterpretation. A cursor is client text, and client text that reaches a
 * query is how injection happens, so nothing here is ever interpolated: a cursor decodes to a fixed triple of
 * typed values or to nothing at all, and those values are bound as query parameters by the store.
 *
 * **One version tag, `fq1`.** Every other tag in use is refused before anything else is looked at. This one
 * carries a shape no other tag carries — a topic, a position and an identifier — and the help centre is ordered
 * by the operator's own arrangement rather than by a timestamp, so a position in any other list would be a real
 * position in the wrong one.
 *
 * **Total.** `faqs.topic` and `faqs.sort_order` are both `not null` and `id` is the primary key, so the triple
 * identifies exactly one row. That totality is load-bearing rather than theoretical: several entries in one topic
 * share a `sort_order` freely — nothing stops an operator giving two entries the same position — and the
 * identifier is the only thing separating them.
 *
 * **Deterministic.** The topic is stored lower-case by its own format, the position is an integer in its plainest
 * form and the identifier is its canonical lower-case form, so the same position always encodes to the same
 * string.
 */

export const FAQ_CURSOR_VERSION = 'fq1';

const SEPARATOR = '|';

const TOPIC_PATTERN = /^[a-z][a-z0-9_]{0,59}$/;

/** A non-negative integer with no leading zeros, no sign and no exponent. */
const POSITION_PATTERN = /^(0|[1-9][0-9]{0,8})$/;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** base64url with no padding, which is what `Buffer` produces and what a URL can carry unescaped. */
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/** A position: which topic, where in it, and which entry. */
export interface FaqPosition {
  readonly topic: string;
  readonly sortOrder: number;
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

export function encodeFaqCursor(position: FaqPosition): string {
  return Buffer.from(
    [FAQ_CURSOR_VERSION, position.topic, String(position.sortOrder), position.id.toLowerCase()].join(SEPARATOR),
    'utf8',
  ).toString('base64url');
}

/**
 * Decodes one position, or refuses.
 *
 * Every part is checked: the tag, the field count, the topic's shape, the position's shape and the identifier's
 * shape. Anything that fails returns null, and the caller turns that into one refusal — the reason is never
 * reported, because a client's remedy is the same in every case (drop the cursor and start again) and naming the
 * flaw would only help somebody probing the format.
 */
export function decodeFaqCursor(cursor: string): FaqPosition | null {
  const text = decode(cursor);
  if (text === null) return null;

  const parts = text.split(SEPARATOR);
  if (parts.length !== 4) return null;
  const [tag, topic, position, id] = parts as [string, string, string, string];
  if (tag !== FAQ_CURSOR_VERSION) return null;
  if (!TOPIC_PATTERN.test(topic)) return null;
  if (!POSITION_PATTERN.test(position)) return null;
  if (!UUID_PATTERN.test(id)) return null;

  return { topic, sortOrder: Number(position), id };
}
