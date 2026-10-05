/**
 * The four cursors of the seller, user, recovery and audit surfaces (Phase 7-O).
 *
 * The same shape, the same reasoning and the same guarantees as every other cursor on this platform, because
 * it is the same kind of value: a cursor names a **position in a total order** and nothing else. It is not a
 * credential and confers no access — every reader behind these re-applies its own permission test with the
 * account and the assurance level as parameters, so a cursor that has been edited can only move a colleague
 * who already holds the key around inside rows they may already read. That is why there is no signature.
 *
 * What it *is* protected against is misinterpretation. A cursor is client text, and client text that reaches
 * a query is how injection happens, so nothing here is ever interpolated: a cursor decodes to a fixed pair of
 * typed values or to nothing at all, and those values are bound as query parameters by the store. No branch
 * below builds a SQL fragment, a column name or an ordering direction from its content.
 *
 * **Four version tags, because there are four lists, and they are not interchangeable.**
 *
 *   * `sp1` — storefronts, `(created_at desc, slug desc)`. The tie-break is the **slug**, because that is
 *     what identifies a storefront on this surface; no account identifier appears in a seller cursor any
 *     more than it appears in a seller response.
 *   * `au1` — accounts, `(created_at desc, id desc)`.
 *   * `rq1` — recovery requests, `(created_at asc, id asc)`. The one **ascending** order here: a queue of
 *     people locked out of their accounts is worked oldest first.
 *   * `ad1` — the audit trail, `(occurred_at desc, id desc)`, where the identifier is the table's `bigint`
 *     identity rather than a uuid.
 *
 * A cursor of one kind cannot be spent on another, and neither can a position from any other list on this
 * platform, because the tag is checked before anything else. That matters more here than elsewhere: these
 * four lists sit behind four different permission keys, and a cursor that crossed between them would be a
 * position from a list the holder of the other key may not read.
 *
 * **Total.** Every order is over a timestamp that is `not null` paired with a key that is unique, so each
 * pair identifies exactly one row. Rows written in one transaction are ordered by that key rather than
 * skipped or repeated, which matters because `now()` is transaction-stable.
 *
 * **Deterministic.** The timestamp is ISO-8601 in UTC with milliseconds and a uuid is its canonical
 * lower-case form, so the same position always encodes to the same string.
 */

export const ADMIN_SELLERS_CURSOR_VERSION = 'sp1';
export const ADMIN_USERS_CURSOR_VERSION = 'au1';
export const ADMIN_RECOVERY_CURSOR_VERSION = 'rq1';
export const ADMIN_AUDIT_CURSOR_VERSION = 'ad1';

const SEPARATOR = '|';

/** ISO-8601, UTC, milliseconds — exactly what `Date.prototype.toISOString` produces, and only that. */
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `seller_profiles_slug_format`, restated so a cursor cannot carry anything the column could not hold. */
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$/;

/** A positive decimal integer with no leading zero, sign, separator or exponent. */
const BIGINT_PATTERN = /^(?:0|[1-9][0-9]{0,18})$/;

/** base64url with no padding, which is what `Buffer` produces and what a URL can carry unescaped. */
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface AdminUuidPosition {
  readonly at: Date;
  readonly id: string;
}

export interface AdminSlugPosition {
  readonly at: Date;
  readonly slug: string;
}

export interface AdminAuditPosition {
  readonly at: Date;
  readonly id: bigint;
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

function encode(version: string, at: Date, key: string): string {
  return Buffer.from([version, at.toISOString(), key].join(SEPARATOR), 'utf8').toString('base64url');
}

/**
 * Splits one cursor into its tag, its timestamp and its key, or refuses.
 *
 * Every part is checked: the tag, the field count, the timestamp shape and the date's validity. Anything
 * that fails returns null, and the caller turns that into one refusal — the reason is never reported,
 * because a client's remedy is the same in every case (drop the cursor and start again) and naming the flaw
 * would only help somebody probing the format.
 */
function split(version: string, cursor: string): { at: Date; key: string } | null {
  const text = decode(cursor);
  if (text === null) return null;

  const parts = text.split(SEPARATOR);
  if (parts.length !== 3) return null;
  const [tag, timestamp, key] = parts as [string, string, string];
  if (tag !== version) return null;
  if (!TIMESTAMP_PATTERN.test(timestamp)) return null;

  const at = new Date(timestamp);
  if (Number.isNaN(at.getTime())) return null;
  // `2026-02-31T…` matches the pattern and is not a date; re-serialising catches it.
  if (at.toISOString() !== timestamp) return null;
  return { at, key };
}

export function encodeAdminSellersCursor(position: AdminSlugPosition): string {
  return encode(ADMIN_SELLERS_CURSOR_VERSION, position.at, position.slug);
}

export function decodeAdminSellersCursor(cursor: string): AdminSlugPosition | null {
  const parts = split(ADMIN_SELLERS_CURSOR_VERSION, cursor);
  if (parts === null || !SLUG_PATTERN.test(parts.key)) return null;
  return { at: parts.at, slug: parts.key };
}

export function encodeAdminUsersCursor(position: AdminUuidPosition): string {
  return encode(ADMIN_USERS_CURSOR_VERSION, position.at, position.id.toLowerCase());
}

export function decodeAdminUsersCursor(cursor: string): AdminUuidPosition | null {
  const parts = split(ADMIN_USERS_CURSOR_VERSION, cursor);
  if (parts === null || !UUID_PATTERN.test(parts.key)) return null;
  return { at: parts.at, id: parts.key };
}

export function encodeAdminRecoveryCursor(position: AdminUuidPosition): string {
  return encode(ADMIN_RECOVERY_CURSOR_VERSION, position.at, position.id.toLowerCase());
}

export function decodeAdminRecoveryCursor(cursor: string): AdminUuidPosition | null {
  const parts = split(ADMIN_RECOVERY_CURSOR_VERSION, cursor);
  if (parts === null || !UUID_PATTERN.test(parts.key)) return null;
  return { at: parts.at, id: parts.key };
}

export function encodeAdminAuditCursor(position: AdminAuditPosition): string {
  return encode(ADMIN_AUDIT_CURSOR_VERSION, position.at, position.id.toString());
}

export function decodeAdminAuditCursor(cursor: string): AdminAuditPosition | null {
  const parts = split(ADMIN_AUDIT_CURSOR_VERSION, cursor);
  if (parts === null || !BIGINT_PATTERN.test(parts.key)) return null;
  // The pattern already bounds the digits, so this never throws and never loses precision.
  return { at: parts.at, id: BigInt(parts.key) };
}
