import { describe, expect, it } from 'vitest';
import {
  VERIFICATION_QUEUE_CURSOR_VERSION,
  decodeVerificationQueueCursor,
  encodeVerificationQueueCursor,
} from '../src/admin/verification-review.cursor.js';
import { encodeFavoritesCursor } from '../src/account/account-cursor.js';

/**
 * The verification queue cursor (Phase 7-G).
 *
 * The same properties the other cursors in this project are held to, because it is the same kind of
 * value: it round-trips exactly, it is deterministic, it refuses anything it did not produce, and it
 * cannot be confused with a cursor of another kind.
 *
 * The decoded value is a `Date` and a uuid — two typed values the store binds as parameters — so there
 * is no string from a client anywhere near a statement.
 */

const POSITION = {
  submittedAt: new Date('2026-05-01T09:00:00.000Z'),
  id: 'f0000000-0000-4000-8000-000000000001',
};

describe('the verification queue cursor', () => {
  it('round-trips a position exactly', () => {
    const decoded = decodeVerificationQueueCursor(encodeVerificationQueueCursor(POSITION));
    expect(decoded?.submittedAt.toISOString()).toBe(POSITION.submittedAt.toISOString());
    expect(decoded?.id).toBe(POSITION.id);
  });

  it('is deterministic: the same position always encodes to the same string', () => {
    expect(encodeVerificationQueueCursor(POSITION)).toBe(encodeVerificationQueueCursor(POSITION));
    expect(encodeVerificationQueueCursor({ ...POSITION, id: POSITION.id.toUpperCase() })).toBe(
      encodeVerificationQueueCursor(POSITION),
    );
  });

  it('is base64url, so it survives a query string unescaped', () => {
    expect(encodeVerificationQueueCursor(POSITION)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('carries its own version, and refuses another kind of cursor', () => {
    const favorites = encodeFavoritesCursor({ createdAt: POSITION.submittedAt, id: POSITION.id });
    expect(decodeVerificationQueueCursor(favorites)).toBeNull();
    expect(Buffer.from(encodeVerificationQueueCursor(POSITION), 'base64url').toString()).toContain(
      VERIFICATION_QUEUE_CURSOR_VERSION,
    );
  });

  it.each([
    ['empty', ''],
    ['not base64url', '!!!!'],
    ['padded base64', 'YWJjZA=='],
    ['a truncated payload', Buffer.from('vq1|2026-05-01T09:00:00.000Z').toString('base64url')],
    ['an extra field', Buffer.from('vq1|2026-05-01T09:00:00.000Z|x|y').toString('base64url')],
    ['a wrong tag', Buffer.from(`zz1|2026-05-01T09:00:00.000Z|${POSITION.id}`).toString('base64url')],
    ['an identifier that is not one', Buffer.from('vq1|2026-05-01T09:00:00.000Z|nope').toString('base64url')],
    ['a timestamp without milliseconds', Buffer.from(`vq1|2026-05-01T09:00:00Z|${POSITION.id}`).toString('base64url')],
    ['a date that does not exist', Buffer.from(`vq1|2026-02-31T09:00:00.000Z|${POSITION.id}`).toString('base64url')],
    ['a statement', Buffer.from(`vq1|'; drop table x; --|${POSITION.id}`).toString('base64url')],
  ])('refuses %s', (_name, cursor) => {
    expect(decodeVerificationQueueCursor(cursor)).toBeNull();
  });

  it('builds no fragment of a statement: what comes out is a Date and a uuid', () => {
    const decoded = decodeVerificationQueueCursor(encodeVerificationQueueCursor(POSITION));
    expect(decoded?.submittedAt).toBeInstanceOf(Date);
    expect(decoded?.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
