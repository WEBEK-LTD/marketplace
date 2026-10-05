import { describe, expect, it } from 'vitest';
import {
  LISTING_ANALYTICS_CURSOR_VERSION,
  decodeListingAnalyticsCursor,
  encodeListingAnalyticsCursor,
} from '../src/analytics/listing-analytics.cursor.js';
import {
  encodeAdminAuditCursor,
  encodeAdminSellersCursor,
  encodeAdminUsersCursor,
} from '../src/admin/admin-operations.cursor.js';

/**
 * The listing analytics cursor (0102).
 *
 * The property that matters is **refusal**, not round-tripping. A cursor is client text; a cursor that decoded
 * loosely would move a reader to a position nobody issued, and a cursor that could be interpolated would be an
 * injection. So everything below asks what happens to a value this API did not produce.
 *
 * It is also the only cursor on this platform whose leading field is a **calendar day** rather than a timestamp,
 * which is why a position from any other list must be rejected before anything else is looked at.
 */

const DAY = '2026-10-03';
const LISTING = '11111111-1111-4111-8111-111111111111';

describe('a position this API issued', () => {
  it('round-trips exactly', () => {
    const cursor = encodeListingAnalyticsCursor({ day: DAY, listingId: LISTING });
    expect(decodeListingAnalyticsCursor(cursor)).toEqual({ day: DAY, listingId: LISTING });
  });

  it('encodes deterministically, so the same position is always the same string', () => {
    expect(encodeListingAnalyticsCursor({ day: DAY, listingId: LISTING })).toBe(
      encodeListingAnalyticsCursor({ day: DAY, listingId: LISTING }),
    );
  });

  it('is base64url, so a URL can carry it unescaped', () => {
    expect(encodeListingAnalyticsCursor({ day: DAY, listingId: LISTING })).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('normalises an upper-case identifier, because the column holds one form', () => {
    const cursor = encodeListingAnalyticsCursor({ day: DAY, listingId: LISTING.toUpperCase() });
    expect(decodeListingAnalyticsCursor(cursor)?.listingId).toBe(LISTING);
  });

  it('carries its own version tag', () => {
    const text = Buffer.from(
      encodeListingAnalyticsCursor({ day: DAY, listingId: LISTING }),
      'base64url',
    ).toString('utf8');
    expect(text.startsWith(`${LISTING_ANALYTICS_CURSOR_VERSION}|`)).toBe(true);
    expect(LISTING_ANALYTICS_CURSOR_VERSION).toBe('la1');
  });

  /** Nothing but the position. A cursor is not a credential and carries no account and no permission. */
  it('carries nothing but the day and the listing', () => {
    const text = Buffer.from(
      encodeListingAnalyticsCursor({ day: DAY, listingId: LISTING }),
      'base64url',
    ).toString('utf8');
    expect(text.split('|')).toHaveLength(3);
    expect(text).not.toMatch(/user|seller|aal|permission|analytics\./i);
  });
});

describe('anything else', () => {
  it('is refused when it is not base64url at all', () => {
    for (const cursor of ['', ' ', '!!!!', 'a b', 'ab=', 'YWJj+', 'YWJj/']) {
      expect(decodeListingAnalyticsCursor(cursor), JSON.stringify(cursor)).toBeNull();
    }
  });

  /**
   * `Buffer.from` ignores characters it does not recognise, so a value that is *nearly* base64url would
   * otherwise decode to something. Requiring the round trip to reproduce the input is what stops that.
   */
  it('is refused when it only looks like base64url', () => {
    const valid = encodeListingAnalyticsCursor({ day: DAY, listingId: LISTING });
    expect(decodeListingAnalyticsCursor(`${valid}=`)).toBeNull();
    expect(decodeListingAnalyticsCursor(`${valid}!`)).toBeNull();
  });

  it('is refused when the field count is wrong', () => {
    for (const text of ['la1', 'la1|2026-10-03', `la1|${DAY}|${LISTING}|extra`, '|||']) {
      expect(decodeListingAnalyticsCursor(Buffer.from(text, 'utf8').toString('base64url')), text).toBeNull();
    }
  });

  it('is refused when the tag is not this list’s', () => {
    for (const tag of ['la2', 'LA1', 'ad1', 'sp1', 'au1', 'rq1', '']) {
      const cursor = Buffer.from(`${tag}|${DAY}|${LISTING}`, 'utf8').toString('base64url');
      expect(decodeListingAnalyticsCursor(cursor), tag).toBeNull();
    }
  });

  it('is refused when the day is not a calendar day', () => {
    for (const day of [
      '2026-10-03T00:00:00.000Z',
      '2026-10-3',
      '26-10-03',
      '2026/10/03',
      '2026-10',
      '',
      'yesterday',
    ]) {
      const cursor = Buffer.from(`la1|${day}|${LISTING}`, 'utf8').toString('base64url');
      expect(decodeListingAnalyticsCursor(cursor), day).toBeNull();
    }
  });

  /** `2026-02-31` matches the shape and is not a day. Re-serialising is what catches it. */
  it('is refused when the day is shaped right and does not exist', () => {
    for (const day of ['2026-02-31', '2026-13-01', '2026-00-10', '2026-10-32']) {
      const cursor = Buffer.from(`la1|${day}|${LISTING}`, 'utf8').toString('base64url');
      expect(decodeListingAnalyticsCursor(cursor), day).toBeNull();
    }
  });

  it('is refused when the identifier is not a uuid', () => {
    for (const id of ['', 'nope', LISTING.slice(0, -1), `${LISTING}0`, '1'.repeat(32)]) {
      const cursor = Buffer.from(`la1|${DAY}|${id}`, 'utf8').toString('base64url');
      expect(decodeListingAnalyticsCursor(cursor), id).toBeNull();
    }
  });

  /** A cursor from another list sits behind a different permission key; it must not be spendable here. */
  it('is refused when it is another list’s position', () => {
    const at = new Date('2026-10-03T12:00:00.000Z');
    for (const cursor of [
      encodeAdminAuditCursor({ at, id: 42n }),
      encodeAdminSellersCursor({ at, slug: 'good-shop' }),
      encodeAdminUsersCursor({ at, id: LISTING }),
    ]) {
      expect(decodeListingAnalyticsCursor(cursor)).toBeNull();
    }
  });

  it('never throws, whatever it is handed', () => {
    for (const cursor of ['', '!!!', 'YQ', Buffer.from('la1||', 'utf8').toString('base64url')]) {
      expect(() => decodeListingAnalyticsCursor(cursor)).not.toThrow();
    }
  });
});
