import { describe, expect, it } from 'vitest';
import {
  OFFERS_CURSOR_VERSION,
  decodeOffersCursor,
  encodeOffersCursor,
} from '../src/offers/offers-cursor.js';
import { encodeFavoritesCursor } from '../src/account/account-cursor.js';
import { encodeVerificationQueueCursor } from '../src/admin/verification-review.cursor.js';

/**
 * The offer list cursor (Phase 7-H).
 *
 * The same properties every other cursor in this project is held to: it round-trips exactly, it is
 * deterministic, it refuses anything it did not produce, and it cannot be confused with a cursor of
 * another kind. What comes out is a `Date` and a uuid — two typed values the store binds as parameters —
 * so no string from a client goes anywhere near a statement.
 */

const POSITION = {
  createdAt: new Date('2026-05-01T09:00:00.000Z'),
  id: 'c0000000-0000-4000-8000-000000000001',
};

describe('the offer list cursor', () => {
  it('round-trips a position exactly', () => {
    const decoded = decodeOffersCursor(encodeOffersCursor(POSITION));
    expect(decoded?.createdAt.toISOString()).toBe(POSITION.createdAt.toISOString());
    expect(decoded?.id).toBe(POSITION.id);
  });

  it('is deterministic, and case-insensitive on the identifier', () => {
    expect(encodeOffersCursor(POSITION)).toBe(encodeOffersCursor(POSITION));
    expect(encodeOffersCursor({ ...POSITION, id: POSITION.id.toUpperCase() })).toBe(
      encodeOffersCursor(POSITION),
    );
  });

  it('is base64url, so it survives a query string unescaped', () => {
    expect(encodeOffersCursor(POSITION)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('carries its own version, and refuses the other kinds of cursor', () => {
    expect(
      decodeOffersCursor(encodeFavoritesCursor({ createdAt: POSITION.createdAt, id: POSITION.id })),
    ).toBeNull();
    expect(
      decodeOffersCursor(
        encodeVerificationQueueCursor({ submittedAt: POSITION.createdAt, id: POSITION.id }),
      ),
    ).toBeNull();
    expect(Buffer.from(encodeOffersCursor(POSITION), 'base64url').toString()).toContain(
      OFFERS_CURSOR_VERSION,
    );
  });

  it.each([
    ['empty', ''],
    ['not base64url', '!!!!'],
    ['padded base64', 'YWJjZA=='],
    ['a truncated payload', Buffer.from('of1|2026-05-01T09:00:00.000Z').toString('base64url')],
    ['an extra field', Buffer.from('of1|2026-05-01T09:00:00.000Z|x|y').toString('base64url')],
    ['a wrong tag', Buffer.from(`zz1|2026-05-01T09:00:00.000Z|${POSITION.id}`).toString('base64url')],
    ['an identifier that is not one', Buffer.from('of1|2026-05-01T09:00:00.000Z|nope').toString('base64url')],
    ['a timestamp without milliseconds', Buffer.from(`of1|2026-05-01T09:00:00Z|${POSITION.id}`).toString('base64url')],
    ['a date that does not exist', Buffer.from(`of1|2026-02-31T09:00:00.000Z|${POSITION.id}`).toString('base64url')],
    ['a statement', Buffer.from(`of1|'; drop table public.offers; --|${POSITION.id}`).toString('base64url')],
  ])('refuses %s', (_name, cursor) => {
    expect(decodeOffersCursor(cursor)).toBeNull();
  });

  it('builds no fragment of a statement: what comes out is a Date and a uuid', () => {
    const decoded = decodeOffersCursor(encodeOffersCursor(POSITION));
    expect(decoded?.createdAt).toBeInstanceOf(Date);
    expect(decoded?.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
