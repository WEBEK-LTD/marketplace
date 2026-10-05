/**
 * The buyer account list cursors (Phase 7-E).
 *
 * The same shape, the same reasoning and the same guarantees as the messaging cursors of 5-C and the
 * notification cursor of 7-C, because it is the same kind of value: a cursor names a **position in a
 * total order** and nothing else. It is not a credential and confers no access — every reader behind it
 * is scoped to the account the API resolved from the session, so a cursor that has been edited can only
 * move the caller around inside their own rows. That is why there is no signature here.
 *
 * What it *is* protected against is misinterpretation. A cursor is client text, and client text that
 * reaches a query is how injection happens, so nothing here is ever interpolated: a cursor decodes to a
 * fixed pair of typed values or to nothing at all, and those values are bound as query parameters by the
 * store. No branch below builds a SQL fragment, a column name or an ordering direction from its content.
 *
 * **Versioned per kind, and there are three kinds.** `fv1` names a position in the favorites list, `ss1`
 * a position in the saved searches and `bl1` a position in the block list, so one cannot be spent on
 * another even though all three are a timestamp and an identifier. A favorites cursor decoded as a
 * saved-search position would silently name a row that does not exist; refusing it is the only honest
 * answer.
 *
 * **One value here is not a cursor.** A block reference (`br1`, added by 0103) names a *row* rather than a
 * position, and it exists for a reason the other three do not share: `public.user_blocks` has no surrogate
 * key, so the only thing that identifies one of its rows is the blocked account — and that is exactly the
 * value this platform has decided must never cross the boundary. The reference is the row's name without
 * being the account's name. It is still not a credential: the remover re-applies `blocker_id = <caller>`
 * inside its own statement, so a reference lifted from another person's list matches nothing and answers
 * exactly as a reference for a block that was never there. It lives in this file because the reasoning
 * above — strict decoding, no interpolation, a version tag that cannot be spent elsewhere — is the same
 * reasoning, and keeping it beside the cursors is what stops it being reinvented less carefully.
 *
 * **Total.** Both orders are `created_at desc, <id> desc`, both `created_at` columns are `not null`, and
 * both identifiers are unique, so the pair identifies exactly one row. Rows created in one transaction
 * share a timestamp to the microsecond — routine when somebody saves several listings quickly — and a
 * cursor made of the timestamp alone would skip or repeat them. This one cannot.
 *
 * **Deterministic.** The timestamp is ISO-8601 in UTC with milliseconds and the identifier is its
 * canonical lower-case form, so the same position always encodes to the same string.
 */

export const FAVORITES_CURSOR_VERSION = 'fv1';
export const SAVED_SEARCHES_CURSOR_VERSION = 'ss1';
export const BLOCKS_CURSOR_VERSION = 'bl1';
export const BLOCK_REFERENCE_VERSION = 'br1';

const SEPARATOR = '|';

/** ISO-8601, UTC, milliseconds — exactly what `Date.prototype.toISOString` produces, and only that. */
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** base64url with no padding, which is what `Buffer` produces and what a URL can carry unescaped. */
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/** A position: when the row was created, and which row it is. */
export interface AccountPosition {
  readonly createdAt: Date;
  readonly id: string;
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

function encodeFor(version: string, position: AccountPosition): string {
  return encode([version, position.createdAt.toISOString(), position.id].join(SEPARATOR));
}

/**
 * Decodes one position, or refuses.
 *
 * Every part is checked: the tag, the field count, the timestamp shape, the date's validity and the
 * identifier's shape. Anything that fails returns null, and the caller turns that into one refusal — the
 * reason is never reported, because a client's remedy is the same in every case (drop the cursor and
 * start again) and naming the flaw would only help somebody probing the format.
 */
function decodeFor(version: string, cursor: string): AccountPosition | null {
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

export const encodeFavoritesCursor = (position: AccountPosition): string =>
  encodeFor(FAVORITES_CURSOR_VERSION, position);

export const decodeFavoritesCursor = (cursor: string): AccountPosition | null =>
  decodeFor(FAVORITES_CURSOR_VERSION, cursor);

export const encodeSavedSearchesCursor = (position: AccountPosition): string =>
  encodeFor(SAVED_SEARCHES_CURSOR_VERSION, position);

export const decodeSavedSearchesCursor = (cursor: string): AccountPosition | null =>
  decodeFor(SAVED_SEARCHES_CURSOR_VERSION, cursor);

/**
 * A position in the block list: when the block was created, and which blocked account it names.
 *
 * The order is `created_at desc, blocked_id desc`, and `(blocker_id, blocked_id)` is the table's primary
 * key, so within one blocker the pair identifies exactly one row. Blocks made in one transaction share a
 * timestamp to the microsecond, and a cursor made of the timestamp alone would skip or repeat them.
 */
export const encodeBlocksCursor = (position: AccountPosition): string =>
  encodeFor(BLOCKS_CURSOR_VERSION, position);

export const decodeBlocksCursor = (cursor: string): AccountPosition | null =>
  decodeFor(BLOCKS_CURSOR_VERSION, cursor);

/**
 * The opaque name of one block, for the unblock to take.
 *
 * Two fields rather than three: a row, not a position, so there is no timestamp to carry. The decode is
 * the same strict one — alphabet, round trip, tag, field count, identifier shape — and a reference that
 * fails any of those returns null, which the caller turns into the same answer a block that is not there
 * gets. That is deliberate: a malformed reference and an unmatched one are indistinguishable, so trying
 * references cannot be used to find out whose blocks exist.
 */
export function encodeBlockReference(blockedUserId: string): string {
  return encode([BLOCK_REFERENCE_VERSION, blockedUserId].join(SEPARATOR));
}

export function decodeBlockReference(reference: string): string | null {
  const text = decode(reference);
  if (text === null) return null;

  const parts = text.split(SEPARATOR);
  if (parts.length !== 2) return null;
  const [tag, id] = parts as [string, string];
  if (tag !== BLOCK_REFERENCE_VERSION) return null;
  return UUID_PATTERN.test(id) ? id : null;
}
