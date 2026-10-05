import { describe, expect, it } from 'vitest';
import {
  ADMIN_AUDIT_CURSOR_VERSION,
  ADMIN_RECOVERY_CURSOR_VERSION,
  ADMIN_SELLERS_CURSOR_VERSION,
  ADMIN_USERS_CURSOR_VERSION,
  decodeAdminAuditCursor,
  decodeAdminRecoveryCursor,
  decodeAdminSellersCursor,
  decodeAdminUsersCursor,
  encodeAdminAuditCursor,
  encodeAdminRecoveryCursor,
  encodeAdminSellersCursor,
  encodeAdminUsersCursor,
} from '../src/admin/admin-operations.cursor.js';

/**
 * The four cursors of 7-O's lists.
 *
 * What is held to account here:
 *
 * **A cursor round-trips, deterministically.** The same position always encodes to the same string, and
 * decoding it returns the position it named.
 *
 * **The four are not interchangeable.** Each tag is checked before anything else, so a position from one
 * list cannot be spent on another — which matters more here than elsewhere, because these four lists sit
 * behind four different permission keys.
 *
 * **Decoding is strict in a way `Buffer.from` is not.** The alphabet is checked, the round trip is required,
 * and every part is validated: the field count, the timestamp's shape, the date's validity, and the key's
 * own shape. Nothing that is not a position decodes to one.
 *
 * **Nothing ever becomes a SQL fragment.** A decoded cursor is a `Date` and a typed key, which is all a
 * caller can do with one.
 */

const AT = new Date('2026-05-01T09:00:00.000Z');
const ID = 'a8000000-0000-4000-8000-000000000001';
const SLUG = 'a-shop';

describe('round trips', () => {
  it('returns the position it was given, for each of the four', () => {
    expect(decodeAdminSellersCursor(encodeAdminSellersCursor({ at: AT, slug: SLUG }))).toEqual({
      at: AT,
      slug: SLUG,
    });
    expect(decodeAdminUsersCursor(encodeAdminUsersCursor({ at: AT, id: ID }))).toEqual({ at: AT, id: ID });
    expect(decodeAdminRecoveryCursor(encodeAdminRecoveryCursor({ at: AT, id: ID }))).toEqual({
      at: AT,
      id: ID,
    });
    expect(decodeAdminAuditCursor(encodeAdminAuditCursor({ at: AT, id: 7n }))).toEqual({ at: AT, id: 7n });
  });

  it('encodes the same position to the same string every time', () => {
    expect(encodeAdminUsersCursor({ at: AT, id: ID })).toBe(encodeAdminUsersCursor({ at: AT, id: ID }));
    expect(encodeAdminUsersCursor({ at: AT, id: ID.toUpperCase() })).toBe(
      encodeAdminUsersCursor({ at: AT, id: ID }),
    );
  });

  it('produces base64url, which a URL carries unescaped', () => {
    for (const cursor of [
      encodeAdminSellersCursor({ at: AT, slug: SLUG }),
      encodeAdminUsersCursor({ at: AT, id: ID }),
      encodeAdminRecoveryCursor({ at: AT, id: ID }),
      encodeAdminAuditCursor({ at: AT, id: 7n }),
    ]) {
      expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(encodeURIComponent(cursor)).toBe(cursor);
    }
  });

  it('carries a bigint identifier without losing it', () => {
    const big = 9007199254740993n;
    expect(decodeAdminAuditCursor(encodeAdminAuditCursor({ at: AT, id: big }))?.id).toBe(big);
  });
});

describe('the four are not interchangeable', () => {
  it('refuses a position from any of the other three', () => {
    const sellers = encodeAdminSellersCursor({ at: AT, slug: SLUG });
    const users = encodeAdminUsersCursor({ at: AT, id: ID });
    const recovery = encodeAdminRecoveryCursor({ at: AT, id: ID });
    const audit = encodeAdminAuditCursor({ at: AT, id: 7n });

    expect(decodeAdminUsersCursor(sellers)).toBeNull();
    expect(decodeAdminRecoveryCursor(sellers)).toBeNull();
    expect(decodeAdminAuditCursor(sellers)).toBeNull();

    expect(decodeAdminSellersCursor(users)).toBeNull();
    // The users and recovery lists carry the same shape of key and different tags, which is the only thing
    // keeping a position from one out of the other.
    expect(decodeAdminRecoveryCursor(users)).toBeNull();
    expect(decodeAdminAuditCursor(users)).toBeNull();

    expect(decodeAdminUsersCursor(recovery)).toBeNull();
    expect(decodeAdminSellersCursor(recovery)).toBeNull();

    expect(decodeAdminUsersCursor(audit)).toBeNull();
    expect(decodeAdminSellersCursor(audit)).toBeNull();
  });

  it('gives each list its own tag', () => {
    const tags = [
      ADMIN_SELLERS_CURSOR_VERSION,
      ADMIN_USERS_CURSOR_VERSION,
      ADMIN_RECOVERY_CURSOR_VERSION,
      ADMIN_AUDIT_CURSOR_VERSION,
    ];
    expect(new Set(tags).size).toBe(4);
  });

  it('refuses a position from another surface on this platform', () => {
    for (const tag of ['mr1', 'ml1', 'st1', 'sq1', 'nt1', 'rp1']) {
      const forged = Buffer.from([tag, AT.toISOString(), ID].join('|'), 'utf8').toString('base64url');
      expect(decodeAdminUsersCursor(forged), tag).toBeNull();
      expect(decodeAdminRecoveryCursor(forged), tag).toBeNull();
    }
  });
});

describe('decoding is strict', () => {
  it('refuses anything that is not base64url', () => {
    for (const bad of ['', '!!!!', 'has spaces', 'a+b/c=', '../../etc/passwd']) {
      expect(decodeAdminUsersCursor(bad), bad).toBeNull();
    }
  });

  it('refuses padded base64, which is not what this produces', () => {
    const padded = Buffer.from([ADMIN_USERS_CURSOR_VERSION, AT.toISOString(), ID].join('|')).toString(
      'base64',
    );
    if (padded.includes('=') || padded.includes('+') || padded.includes('/')) {
      expect(decodeAdminUsersCursor(padded)).toBeNull();
    }
  });

  it('refuses the wrong number of fields', () => {
    for (const text of [
      ADMIN_USERS_CURSOR_VERSION,
      `${ADMIN_USERS_CURSOR_VERSION}|${AT.toISOString()}`,
      `${ADMIN_USERS_CURSOR_VERSION}|${AT.toISOString()}|${ID}|extra`,
    ]) {
      expect(decodeAdminUsersCursor(Buffer.from(text, 'utf8').toString('base64url')), text).toBeNull();
    }
  });

  it('refuses a timestamp that is not the one shape it accepts', () => {
    for (const stamp of [
      '2026-05-01T09:00:00Z',
      '2026-05-01T09:00:00.000+02:00',
      '2026-05-01 09:00:00.000Z',
      '2026-13-01T09:00:00.000Z',
      '2026-02-31T09:00:00.000Z',
      'not-a-date',
    ]) {
      const forged = Buffer.from([ADMIN_USERS_CURSOR_VERSION, stamp, ID].join('|'), 'utf8').toString(
        'base64url',
      );
      expect(decodeAdminUsersCursor(forged), stamp).toBeNull();
    }
  });

  it('refuses a key that is not the shape its list uses', () => {
    const forge = (tag: string, key: string): string =>
      Buffer.from([tag, AT.toISOString(), key].join('|'), 'utf8').toString('base64url');

    for (const key of ['not-a-uuid', ID.toUpperCase(), '', `${ID} `]) {
      expect(decodeAdminUsersCursor(forge(ADMIN_USERS_CURSOR_VERSION, key)), key).toBeNull();
    }
    // The slug check is the storefront column's own format and nothing more.
    for (const key of ['A-Shop', 'a', 'a_shop', 'shop-', '-shop', 'shop name', 'shop/../']) {
      expect(decodeAdminSellersCursor(forge(ADMIN_SELLERS_CURSOR_VERSION, key)), key).toBeNull();
    }
    // A uuid is a syntactically valid slug — lower-case hex and hyphens, within the length — so this
    // check does not reject one, and it is not meant to. What keeps a caller from reaching a storefront
    // is the lookup and the permission behind it, never the shape of the handle.
    expect(decodeAdminSellersCursor(forge(ADMIN_SELLERS_CURSOR_VERSION, ID))?.slug).toBe(ID);
    for (const key of ['007', '-1', '1.5', '1e3', ' 7', '', 'abc']) {
      expect(decodeAdminAuditCursor(forge(ADMIN_AUDIT_CURSOR_VERSION, key)), key).toBeNull();
    }
  });

  it('accepts a legitimate slug and a legitimate zero', () => {
    const forge = (tag: string, key: string): string =>
      Buffer.from([tag, AT.toISOString(), key].join('|'), 'utf8').toString('base64url');
    expect(decodeAdminSellersCursor(forge(ADMIN_SELLERS_CURSOR_VERSION, 'a-shop-2'))?.slug).toBe(
      'a-shop-2',
    );
    expect(decodeAdminAuditCursor(forge(ADMIN_AUDIT_CURSOR_VERSION, '0'))?.id).toBe(0n);
  });

  it('never returns anything but a date and a typed key', () => {
    const position = decodeAdminAuditCursor(encodeAdminAuditCursor({ at: AT, id: 7n }));
    expect(position?.at).toBeInstanceOf(Date);
    expect(typeof position?.id).toBe('bigint');
    expect(Object.keys(position ?? {}).sort()).toEqual(['at', 'id']);
  });
});
