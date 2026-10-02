import { describe, expect, it } from 'vitest';
import {
  FAVORITES_CURSOR_VERSION,
  SAVED_SEARCHES_CURSOR_VERSION,
  decodeFavoritesCursor,
  decodeSavedSearchesCursor,
  encodeFavoritesCursor,
  encodeSavedSearchesCursor,
} from '../src/account/account-cursor.js';

/**
 * The buyer account cursors (Phase 7-E).
 *
 * A cursor names a position and confers no access, so what is tested here is not secrecy but strictness:
 * a value that is not exactly a position must decode to nothing, and a position from one list must never
 * be readable as a position in another.
 */

const CREATED = new Date('2026-09-01T10:00:00.000Z');
const ID = 'aaaaaaaa-0000-4000-8000-000000000001';

describe('7-E cursors', () => {
  it('round-trips a position', () => {
    const cursor = encodeFavoritesCursor({ createdAt: CREATED, id: ID });
    expect(decodeFavoritesCursor(cursor)).toEqual({ createdAt: CREATED, id: ID });
  });

  it('is deterministic', () => {
    expect(encodeFavoritesCursor({ createdAt: CREATED, id: ID })).toBe(
      encodeFavoritesCursor({ createdAt: new Date(CREATED.getTime()), id: ID }),
    );
  });

  it('is base64url, so it survives a query string unescaped', () => {
    const cursor = encodeSavedSearchesCursor({ createdAt: CREATED, id: ID });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(cursor)).toBe(cursor);
  });

  it('keeps the two lists apart, even though both are a timestamp and an identifier', () => {
    const favorites = encodeFavoritesCursor({ createdAt: CREATED, id: ID });
    const searches = encodeSavedSearchesCursor({ createdAt: CREATED, id: ID });
    expect(favorites).not.toBe(searches);
    expect(decodeSavedSearchesCursor(favorites)).toBeNull();
    expect(decodeFavoritesCursor(searches)).toBeNull();
  });

  it('names its version, so a future format is a new tag rather than a misread one', () => {
    expect(FAVORITES_CURSOR_VERSION).toBe('fv1');
    expect(SAVED_SEARCHES_CURSOR_VERSION).toBe('ss1');
    const decoded = Buffer.from(encodeFavoritesCursor({ createdAt: CREATED, id: ID }), 'base64url').toString('utf8');
    expect(decoded.startsWith('fv1|')).toBe(true);
    expect(decodeFavoritesCursor(Buffer.from(`fv2|${CREATED.toISOString()}|${ID}`, 'utf8').toString('base64url'))).toBeNull();
  });

  it.each([
    ['empty', ''],
    ['not base64url', 'not base64!'],
    ['padded base64', 'YWJjZA=='],
    ['decodes to nothing meaningful', Buffer.from('hello', 'utf8').toString('base64url')],
    ['too few fields', Buffer.from(`fv1|${CREATED.toISOString()}`, 'utf8').toString('base64url')],
    ['too many fields', Buffer.from(`fv1|${CREATED.toISOString()}|${ID}|extra`, 'utf8').toString('base64url')],
    ['identifier is not one', Buffer.from(`fv1|${CREATED.toISOString()}|sofa`, 'utf8').toString('base64url')],
    ['timestamp has no milliseconds', Buffer.from(`fv1|2026-09-01T10:00:00Z|${ID}`, 'utf8').toString('base64url')],
    ['timestamp is not UTC', Buffer.from(`fv1|2026-09-01T10:00:00.000+02:00|${ID}`, 'utf8').toString('base64url')],
    ['date does not exist', Buffer.from(`fv1|2026-02-31T10:00:00.000Z|${ID}`, 'utf8').toString('base64url')],
  ])('refuses a cursor that is %s', (_name, cursor) => {
    expect(decodeFavoritesCursor(cursor)).toBeNull();
  });

  it('builds no SQL fragment from its contents', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../src/account/account-cursor.ts', import.meta.url), 'utf8'),
    );
    expect(source).not.toMatch(/\bselect\b|\border by\b|\bwhere\b/i);
  });
});
