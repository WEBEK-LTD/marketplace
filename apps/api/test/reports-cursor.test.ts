import { describe, expect, it } from 'vitest';
import {
  REPORTS_CURSOR_VERSION,
  decodeReportsCursor,
  encodeReportsCursor,
} from '../src/reports/reports-cursor.js';
import { decodeSupportTicketsCursor } from '../src/support/support-cursor.js';

/**
 * The reporter history cursor (Phase 7-M).
 *
 * The same properties the other cursors on this platform are held to, because it is the same kind of value:
 * it round-trips, it is deterministic, it decodes strictly rather than leniently, and it cannot be spent as
 * another list's position.
 */

const AT = new Date('2026-05-01T09:00:00.000Z');
const ID = 'c0000000-0000-4000-8000-00000000000a';

const encoded = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');

describe('the reports cursor', () => {
  it('round-trips a position', () => {
    const cursor = encodeReportsCursor({ createdAt: AT, id: ID });
    expect(decodeReportsCursor(cursor)).toEqual({ createdAt: AT, id: ID });
  });

  it('is deterministic, so the same position is always the same string', () => {
    expect(encodeReportsCursor({ createdAt: AT, id: ID })).toBe(
      encodeReportsCursor({ createdAt: new Date(AT.getTime()), id: ID }),
    );
  });

  it('normalises an identifier to its canonical form', () => {
    expect(encodeReportsCursor({ createdAt: AT, id: ID.toUpperCase() })).toBe(
      encodeReportsCursor({ createdAt: AT, id: ID }),
    );
  });

  it('carries its own version tag', () => {
    expect(REPORTS_CURSOR_VERSION).toBe('rp1');
    expect(Buffer.from(encodeReportsCursor({ createdAt: AT, id: ID }), 'base64url').toString('utf8')).toBe(
      `rp1|2026-05-01T09:00:00.000Z|${ID}`,
    );
  });

  it('is base64url, so it survives a query string unescaped', () => {
    const cursor = encodeReportsCursor({ createdAt: AT, id: ID });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(encodeURIComponent(cursor)).toBe(cursor);
  });
});

describe('what it refuses', () => {
  it('refuses anything that is not base64url, rather than decoding it loosely', () => {
    // `Buffer.from` ignores characters it does not recognise, which is exactly what must not happen here.
    for (const cursor of ['!!!!', 'has space', 'padded==', '', 'a+b/c']) {
      expect(decodeReportsCursor(cursor), cursor).toBeNull();
    }
  });

  it('refuses another list’s position, because the tag is checked first', () => {
    for (const tag of ['st1', 'sm1', 'sq1', 'sa1', 'sn1', 'of1', 'sr1', 'nt1', 'mi1', 'mm1']) {
      expect(decodeReportsCursor(encoded(`${tag}|2026-05-01T09:00:00.000Z|${ID}`)), tag).toBeNull();
    }
  });

  it('is refused by another list in turn, so a position cannot cross either way', () => {
    expect(decodeSupportTicketsCursor(encodeReportsCursor({ createdAt: AT, id: ID }))).toBeNull();
  });

  it('refuses the wrong number of fields', () => {
    expect(decodeReportsCursor(encoded('rp1'))).toBeNull();
    expect(decodeReportsCursor(encoded(`rp1|2026-05-01T09:00:00.000Z`))).toBeNull();
    expect(decodeReportsCursor(encoded(`rp1|2026-05-01T09:00:00.000Z|${ID}|extra`))).toBeNull();
  });

  it('refuses a timestamp that is not the one shape', () => {
    for (const timestamp of [
      '2026-05-01T09:00:00Z',
      '2026-05-01T09:00:00.000+03:00',
      '2026-05-01 09:00:00.000Z',
      '1746090000000',
      'now',
    ]) {
      expect(decodeReportsCursor(encoded(`rp1|${timestamp}|${ID}`)), timestamp).toBeNull();
    }
  });

  it('refuses a date that matches the shape and is not a date', () => {
    expect(decodeReportsCursor(encoded(`rp1|2026-02-31T09:00:00.000Z|${ID}`))).toBeNull();
    expect(decodeReportsCursor(encoded(`rp1|2026-13-01T09:00:00.000Z|${ID}`))).toBeNull();
  });

  it('refuses an identifier that is not one, including anything that could be SQL', () => {
    for (const id of [
      'not-a-uuid',
      ID.toUpperCase(),
      `${ID} or 1=1`,
      "'; drop table reports--",
      '11111111-1111-4111-8111',
    ]) {
      expect(decodeReportsCursor(encoded(`rp1|2026-05-01T09:00:00.000Z|${id}`)), id).toBeNull();
    }
  });

  it('refuses a non-string without throwing', () => {
    for (const value of [undefined, null, 0, {}, []]) {
      expect(decodeReportsCursor(value as unknown as string)).toBeNull();
    }
  });
});

describe('the order it names is total', () => {
  it('distinguishes two reports filed at the same instant', () => {
    // `now()` is transaction-stable, so this is not a hypothetical: two reports can share a timestamp.
    const other = 'c0000000-0000-4000-8000-00000000000b';
    expect(encodeReportsCursor({ createdAt: AT, id: ID })).not.toBe(
      encodeReportsCursor({ createdAt: AT, id: other }),
    );
    expect(decodeReportsCursor(encodeReportsCursor({ createdAt: AT, id: other }))!.id).toBe(other);
  });
});
