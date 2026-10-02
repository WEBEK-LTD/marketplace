import { describe, expect, it } from 'vitest';
import {
  MODERATION_LISTINGS_CURSOR_VERSION,
  MODERATION_REPORTS_CURSOR_VERSION,
  decodeModerationListingsCursor,
  decodeModerationReportsCursor,
  encodeModerationListingsCursor,
  encodeModerationReportsCursor,
} from '../src/admin/moderation.cursor.js';
import { decodeReportsCursor } from '../src/reports/reports-cursor.js';

/**
 * The two moderation queue cursors (Phase 7-N).
 *
 * The same properties every other cursor on this platform is held to, and one that matters more here than
 * elsewhere: the two queues are two different tables, so a position from one must decode to nothing in the
 * other rather than to a plausible wrong place.
 */

const AT = new Date('2026-05-01T09:00:00.000Z');
const ID = 'c0000000-0000-4000-8000-00000000000a';

const encoded = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');

describe('both cursors', () => {
  it('round-trip a position', () => {
    expect(decodeModerationReportsCursor(encodeModerationReportsCursor({ createdAt: AT, id: ID }))).toEqual({
      createdAt: AT,
      id: ID,
    });
    expect(decodeModerationListingsCursor(encodeModerationListingsCursor({ createdAt: AT, id: ID }))).toEqual(
      { createdAt: AT, id: ID },
    );
  });

  it('are deterministic and normalise an identifier', () => {
    expect(encodeModerationReportsCursor({ createdAt: AT, id: ID.toUpperCase() })).toBe(
      encodeModerationReportsCursor({ createdAt: AT, id: ID }),
    );
    expect(encodeModerationListingsCursor({ createdAt: new Date(AT.getTime()), id: ID })).toBe(
      encodeModerationListingsCursor({ createdAt: AT, id: ID }),
    );
  });

  it('carry their own version tags', () => {
    expect(MODERATION_REPORTS_CURSOR_VERSION).toBe('mr1');
    expect(MODERATION_LISTINGS_CURSOR_VERSION).toBe('ml1');
    expect(
      Buffer.from(encodeModerationReportsCursor({ createdAt: AT, id: ID }), 'base64url').toString('utf8'),
    ).toBe(`mr1|2026-05-01T09:00:00.000Z|${ID}`);
  });

  it('are base64url, so they survive a query string unescaped', () => {
    for (const cursor of [
      encodeModerationReportsCursor({ createdAt: AT, id: ID }),
      encodeModerationListingsCursor({ createdAt: AT, id: ID }),
    ]) {
      expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/u);
      expect(encodeURIComponent(cursor)).toBe(cursor);
    }
  });
});

describe('what they refuse', () => {
  it('cannot be spent on each other', () => {
    const reports = encodeModerationReportsCursor({ createdAt: AT, id: ID });
    const listings = encodeModerationListingsCursor({ createdAt: AT, id: ID });
    expect(decodeModerationListingsCursor(reports)).toBeNull();
    expect(decodeModerationReportsCursor(listings)).toBeNull();
  });

  it('refuse a position from any other list on this platform', () => {
    for (const tag of ['rp1', 'st1', 'sm1', 'sq1', 'sa1', 'sn1', 'of1', 'sr1', 'nt1', 'mi1', 'mm1']) {
      expect(decodeModerationReportsCursor(encoded(`${tag}|2026-05-01T09:00:00.000Z|${ID}`)), tag).toBeNull();
      expect(decodeModerationListingsCursor(encoded(`${tag}|2026-05-01T09:00:00.000Z|${ID}`)), tag).toBeNull();
    }
  });

  it('are refused by another list in turn', () => {
    expect(decodeReportsCursor(encodeModerationReportsCursor({ createdAt: AT, id: ID }))).toBeNull();
  });

  it('refuse anything that is not base64url, rather than decoding it loosely', () => {
    for (const cursor of ['!!!!', 'has space', 'padded==', '', 'a+b/c']) {
      expect(decodeModerationReportsCursor(cursor), cursor).toBeNull();
      expect(decodeModerationListingsCursor(cursor), cursor).toBeNull();
    }
  });

  it('refuse the wrong number of fields', () => {
    expect(decodeModerationReportsCursor(encoded('mr1'))).toBeNull();
    expect(decodeModerationReportsCursor(encoded('mr1|2026-05-01T09:00:00.000Z'))).toBeNull();
    expect(decodeModerationReportsCursor(encoded(`mr1|2026-05-01T09:00:00.000Z|${ID}|extra`))).toBeNull();
  });

  it('refuse a timestamp that is not the one shape, and a date that is not a date', () => {
    for (const timestamp of ['2026-05-01T09:00:00Z', '2026-05-01T09:00:00.000+03:00', 'now', '1746090000000']) {
      expect(decodeModerationReportsCursor(encoded(`mr1|${timestamp}|${ID}`)), timestamp).toBeNull();
    }
    expect(decodeModerationReportsCursor(encoded(`mr1|2026-02-31T09:00:00.000Z|${ID}`))).toBeNull();
  });

  it('refuse an identifier that is not one, including anything that could be SQL', () => {
    for (const id of ['not-a-uuid', ID.toUpperCase(), `${ID} or 1=1`, "'; drop table reports--"]) {
      expect(decodeModerationReportsCursor(encoded(`mr1|2026-05-01T09:00:00.000Z|${id}`)), id).toBeNull();
      expect(decodeModerationListingsCursor(encoded(`ml1|2026-05-01T09:00:00.000Z|${id}`)), id).toBeNull();
    }
  });

  it('refuse a non-string without throwing', () => {
    for (const value of [undefined, null, 0, {}, []]) {
      expect(decodeModerationReportsCursor(value as unknown as string)).toBeNull();
      expect(decodeModerationListingsCursor(value as unknown as string)).toBeNull();
    }
  });
});

describe('the order they name is total', () => {
  it('distinguishes two rows created at the same instant', () => {
    // `now()` is transaction-stable, so this is not hypothetical.
    const other = 'c0000000-0000-4000-8000-00000000000b';
    expect(encodeModerationReportsCursor({ createdAt: AT, id: ID })).not.toBe(
      encodeModerationReportsCursor({ createdAt: AT, id: other }),
    );
  });
});
