import { describe, expect, it } from 'vitest';
import {
  CMS_PAGE_CURSOR_VERSION,
  decodeCmsPageCursor,
  encodeCmsPageCursor,
} from '../src/admin/cms-pages.cursor.js';
import { encodeJobRunCursor } from '../src/admin/platform-operations.cursor.js';

/**
 * The authored-page cursor.
 *
 * What matters is that it is **total, deterministic and unmistakable for any other cursor on this platform**.
 * The last of those is the one with teeth: several lists here carry a `(timestamp, uuid)` pair, so a position
 * in one of them is a syntactically perfect position in the wrong list, and only the version tag separates
 * them.
 */

const ID = 'fc000000-0000-4000-8000-00000000c115';
const WHEN = new Date('2026-05-02T09:00:00.000Z');

describe('round trip', () => {
  it('returns the same position it was given', () => {
    const decoded = decodeCmsPageCursor(encodeCmsPageCursor({ updatedAt: WHEN, id: ID }));
    expect(decoded?.updatedAt.toISOString()).toBe(WHEN.toISOString());
    expect(decoded?.id).toBe(ID);
  });

  it('is deterministic: the same position always encodes to the same string', () => {
    expect(encodeCmsPageCursor({ updatedAt: WHEN, id: ID })).toBe(
      encodeCmsPageCursor({ updatedAt: new Date(WHEN.getTime()), id: ID }),
    );
  });

  it('normalises the identifier so one position has one encoding', () => {
    expect(encodeCmsPageCursor({ updatedAt: WHEN, id: ID.toUpperCase() })).toBe(
      encodeCmsPageCursor({ updatedAt: WHEN, id: ID }),
    );
  });

  it('carries a timestamp with milliseconds, because pages edited together share a second', () => {
    // `pages.updated_at` comes from `now()`, which is transaction-stable, so milliseconds alone do not
    // separate two pages written in one transaction — the identifier does. The format still has to survive.
    const decoded = decodeCmsPageCursor(
      encodeCmsPageCursor({ updatedAt: new Date('2026-05-02T09:00:00.123Z'), id: ID }),
    );
    expect(decoded?.updatedAt.toISOString()).toBe('2026-05-02T09:00:00.123Z');
  });
});

describe('refusals', () => {
  it('refuses a cursor from any other list on this platform', () => {
    // Identical pair, different list. This is the case the version tag exists for.
    expect(decodeCmsPageCursor(encodeJobRunCursor({ startedAt: WHEN, id: ID }))).toBeNull();
  });

  it('refuses an unknown version tag', () => {
    const foreign = Buffer.from(['zz9', WHEN.toISOString(), ID].join('|'), 'utf8').toString('base64url');
    expect(decodeCmsPageCursor(foreign)).toBeNull();
  });

  it('names its own version', () => {
    expect(CMS_PAGE_CURSOR_VERSION).toBe('cp1');
    expect(Buffer.from(encodeCmsPageCursor({ updatedAt: WHEN, id: ID }), 'base64url').toString('utf8')).toMatch(
      /^cp1\|/,
    );
  });

  it('refuses the wrong number of fields', () => {
    for (const text of ['cp1', `cp1|${WHEN.toISOString()}`, `cp1|${WHEN.toISOString()}|${ID}|extra`]) {
      expect(decodeCmsPageCursor(Buffer.from(text, 'utf8').toString('base64url')), text).toBeNull();
    }
  });

  it('refuses a malformed identifier', () => {
    for (const id of ['not-a-uuid', ID.toUpperCase(), `${ID}0`, '']) {
      const text = ['cp1', WHEN.toISOString(), id].join('|');
      expect(decodeCmsPageCursor(Buffer.from(text, 'utf8').toString('base64url')), id).toBeNull();
    }
  });

  it('refuses a timestamp that is not the one format it accepts', () => {
    for (const when of ['2026-05-02T09:00:00Z', '2026-05-02 09:00:00.000Z', '2026-05-02', '']) {
      const text = ['cp1', when, ID].join('|');
      expect(decodeCmsPageCursor(Buffer.from(text, 'utf8').toString('base64url')), when).toBeNull();
    }
  });

  it('refuses a date that matches the shape and is not a date', () => {
    const text = ['cp1', '2026-02-31T09:00:00.000Z', ID].join('|');
    expect(decodeCmsPageCursor(Buffer.from(text, 'utf8').toString('base64url'))).toBeNull();
  });

  it('refuses anything that is not base64url, instead of decoding it loosely', () => {
    // `Buffer.from` ignores characters it does not recognise, so without the alphabet check and the round
    // trip these would decode to something rather than failing.
    for (const cursor of ['!!!!', 'a b c', 'cp1|x|y', '', '===']) {
      expect(decodeCmsPageCursor(cursor), cursor).toBeNull();
    }
  });

  it('refuses a cursor whose encoding is not canonical', () => {
    const canonical = encodeCmsPageCursor({ updatedAt: WHEN, id: ID });
    expect(decodeCmsPageCursor(`${canonical}=`)).toBeNull();
  });
});
