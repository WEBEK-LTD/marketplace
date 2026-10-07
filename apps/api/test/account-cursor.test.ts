import { describe, expect, it } from 'vitest';
import {
  BLOCKS_CURSOR_VERSION,
  BLOCK_REFERENCE_VERSION,
  FAVORITES_CURSOR_VERSION,
  SAVED_SEARCHES_CURSOR_VERSION,
  decodeBlockReference,
  decodeBlocksCursor,
  decodeFavoritesCursor,
  decodeSavedSearchesCursor,
  encodeBlockReference,
  encodeBlocksCursor,
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

  it('keeps the three lists apart, even though all three are a timestamp and an identifier', () => {
    const favorites = encodeFavoritesCursor({ createdAt: CREATED, id: ID });
    const searches = encodeSavedSearchesCursor({ createdAt: CREATED, id: ID });
    const blocks = encodeBlocksCursor({ createdAt: CREATED, id: ID });

    expect(new Set([favorites, searches, blocks]).size).toBe(3);
    expect(decodeSavedSearchesCursor(favorites)).toBeNull();
    expect(decodeFavoritesCursor(searches)).toBeNull();
    expect(decodeBlocksCursor(favorites)).toBeNull();
    expect(decodeBlocksCursor(searches)).toBeNull();
    expect(decodeFavoritesCursor(blocks)).toBeNull();
    expect(decodeSavedSearchesCursor(blocks)).toBeNull();
  });

  it('names its version, so a future format is a new tag rather than a misread one', () => {
    expect(FAVORITES_CURSOR_VERSION).toBe('fv1');
    expect(SAVED_SEARCHES_CURSOR_VERSION).toBe('ss1');
    expect(BLOCKS_CURSOR_VERSION).toBe('bl1');
    expect(BLOCK_REFERENCE_VERSION).toBe('br1');
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

  /* ---------------------------------------------------------------------------------------------- */
  /* The block list's position, and the block reference (0103)                                       */
  /* ---------------------------------------------------------------------------------------------- */

  it('round-trips a position in the block list', () => {
    const cursor = encodeBlocksCursor({ createdAt: CREATED, id: ID });
    expect(decodeBlocksCursor(cursor)).toEqual({ createdAt: CREATED, id: ID });
  });

  it('refuses the same malformed shapes under the block tag', () => {
    const bad = [
      '',
      'not base64!',
      'YWJjZA==',
      Buffer.from(`bl1|${CREATED.toISOString()}`, 'utf8').toString('base64url'),
      Buffer.from(`bl1|${CREATED.toISOString()}|${ID}|extra`, 'utf8').toString('base64url'),
      Buffer.from(`bl1|${CREATED.toISOString()}|shop`, 'utf8').toString('base64url'),
      Buffer.from(`bl1|2026-02-31T10:00:00.000Z|${ID}`, 'utf8').toString('base64url'),
      Buffer.from(`bl2|${CREATED.toISOString()}|${ID}`, 'utf8').toString('base64url'),
    ];
    for (const cursor of bad) expect(decodeBlocksCursor(cursor), cursor).toBeNull();
  });

  it('round-trips a block reference', () => {
    expect(decodeBlockReference(encodeBlockReference(ID))).toBe(ID);
  });

  it('is deterministic, and base64url like everything else here', () => {
    const reference = encodeBlockReference(ID);
    expect(encodeBlockReference(ID)).toBe(reference);
    expect(reference).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(reference)).toBe(reference);
  });

  /**
   * A reference names a row and a cursor names a position, so neither is readable as the other even though
   * both are versioned base64url over a uuid.
   */
  it('is not a cursor and cannot be spent as one', () => {
    const reference = encodeBlockReference(ID);
    expect(decodeBlocksCursor(reference)).toBeNull();
    expect(decodeFavoritesCursor(reference)).toBeNull();
    expect(decodeSavedSearchesCursor(reference)).toBeNull();
    expect(decodeBlockReference(encodeBlocksCursor({ createdAt: CREATED, id: ID }))).toBeNull();
  });

  it('refuses a reference that is not exactly a tagged identifier', () => {
    const bad = [
      '',
      'not base64!',
      'YWJjZA==',
      Buffer.from('br1', 'utf8').toString('base64url'),
      Buffer.from(`br1|${ID}|extra`, 'utf8').toString('base64url'),
      Buffer.from(`br1|not-an-id`, 'utf8').toString('base64url'),
      Buffer.from(`br1|${ID.toUpperCase()}`, 'utf8').toString('base64url'),
      Buffer.from(`br2|${ID}`, 'utf8').toString('base64url'),
      Buffer.from(ID, 'utf8').toString('base64url'),
    ];
    for (const reference of bad) expect(decodeBlockReference(reference), reference).toBeNull();
  });

  /**
   * The reference is an opaque name, not a secret: anybody holding it learns a uuid. What stops it being
   * useful is that the remover re-applies its own ownership predicate, which is the database's job and is
   * asserted in the pgTAP suite. What is asserted here is that it is at least not *readable* — so a
   * reference cannot be eyeballed off a screen and turned into an account identifier.
   */
  it('does not carry the identifier in readable form', () => {
    expect(encodeBlockReference(ID)).not.toContain(ID);
    expect(encodeBlockReference(ID)).not.toContain(ID.slice(0, 8));
  });

  it('builds no SQL fragment from its contents', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../src/account/account-cursor.ts', import.meta.url), 'utf8'),
    );
    expect(source).not.toMatch(/\bselect\b|\border by\b|\bwhere\b/i);
  });
});
