import { describe, expect, it } from 'vitest';
import {
  SUPPORT_MESSAGES_CURSOR_VERSION,
  SUPPORT_TICKETS_CURSOR_VERSION,
  decodeSupportMessagesCursor,
  decodeSupportTicketsCursor,
  encodeSupportMessagesCursor,
  encodeSupportTicketsCursor,
} from '../src/support/support-cursor.js';
import { encodeServiceRequestsCursor } from '../src/services/service-requests-cursor.js';

/**
 * The two support cursors (Phase 7-K).
 *
 * The same properties every other cursor in this project is held to: each round-trips exactly, each is
 * deterministic, each refuses anything it did not produce, and **neither can be confused with the other**
 * — which matters more here than anywhere else so far, because the two orders are opposite: the ticket list
 * runs newest-first and a conversation is read backwards from its newest end, so a position spent on the
 * wrong reader would be a plausible wrong place rather than an obvious one.
 *
 * What comes out is a `Date` and a uuid — two typed values the store binds as parameters — so no string
 * from a client goes anywhere near a statement.
 */

const POSITION = {
  createdAt: new Date('2026-05-01T09:00:00.000Z'),
  id: 'd4000000-0000-4000-8000-000000000001',
};

describe('the support cursors', () => {
  it('each round-trips a position exactly', () => {
    const tickets = decodeSupportTicketsCursor(encodeSupportTicketsCursor(POSITION));
    expect(tickets?.createdAt.toISOString()).toBe(POSITION.createdAt.toISOString());
    expect(tickets?.id).toBe(POSITION.id);

    const messages = decodeSupportMessagesCursor(encodeSupportMessagesCursor(POSITION));
    expect(messages?.createdAt.toISOString()).toBe(POSITION.createdAt.toISOString());
    expect(messages?.id).toBe(POSITION.id);
  });

  it('are deterministic, and case-insensitive on the identifier', () => {
    expect(encodeSupportTicketsCursor(POSITION)).toBe(encodeSupportTicketsCursor(POSITION));
    expect(encodeSupportTicketsCursor({ ...POSITION, id: POSITION.id.toUpperCase() })).toBe(
      encodeSupportTicketsCursor(POSITION),
    );
    expect(encodeSupportMessagesCursor({ ...POSITION, id: POSITION.id.toUpperCase() })).toBe(
      encodeSupportMessagesCursor(POSITION),
    );
  });

  it('are base64url, so they survive a query string unescaped', () => {
    expect(encodeSupportTicketsCursor(POSITION)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeSupportMessagesCursor(POSITION)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('cannot be spent on each other, because the two orders are opposite', () => {
    expect(decodeSupportTicketsCursor(encodeSupportMessagesCursor(POSITION))).toBeNull();
    expect(decodeSupportMessagesCursor(encodeSupportTicketsCursor(POSITION))).toBeNull();
  });

  it('carry their own versions, and refuse the other surfaces’ cursors', () => {
    // The offers cursor was named here too until 0110 closed the offers surface (OD-A4) and its module
    // went with it. What this assertion is for — a cursor minted by one surface is refused by another, so
    // the version prefix is doing its job — is unchanged, and the service-request cursor still proves it.
    expect(decodeSupportTicketsCursor(encodeServiceRequestsCursor(POSITION))).toBeNull();
    expect(decodeSupportMessagesCursor(encodeServiceRequestsCursor(POSITION))).toBeNull();
    expect(Buffer.from(encodeSupportTicketsCursor(POSITION), 'base64url').toString()).toContain(
      SUPPORT_TICKETS_CURSOR_VERSION,
    );
    expect(Buffer.from(encodeSupportMessagesCursor(POSITION), 'base64url').toString()).toContain(
      SUPPORT_MESSAGES_CURSOR_VERSION,
    );
  });

  it.each([
    ['empty', ''],
    ['not base64url', '!!!!'],
    ['padded base64', 'YWJjZA=='],
    ['a truncated payload', Buffer.from('st1|2026-05-01T09:00:00.000Z').toString('base64url')],
    ['an extra field', Buffer.from('st1|2026-05-01T09:00:00.000Z|x|y').toString('base64url')],
    ['a wrong tag', Buffer.from(`zz1|2026-05-01T09:00:00.000Z|${POSITION.id}`).toString('base64url')],
    [
      'an identifier that is not one',
      Buffer.from('st1|2026-05-01T09:00:00.000Z|nope').toString('base64url'),
    ],
    [
      'a timestamp without milliseconds',
      Buffer.from(`st1|2026-05-01T09:00:00Z|${POSITION.id}`).toString('base64url'),
    ],
    [
      'a date that does not exist',
      Buffer.from(`st1|2026-02-31T09:00:00.000Z|${POSITION.id}`).toString('base64url'),
    ],
    [
      'a statement',
      Buffer.from(`st1|'; drop table public.support_tickets; --|${POSITION.id}`).toString('base64url'),
    ],
  ])('the ticket cursor refuses %s', (_name, cursor) => {
    expect(decodeSupportTicketsCursor(cursor)).toBeNull();
  });

  it.each([
    ['empty', ''],
    ['not base64url', '~~~~'],
    ['a truncated payload', Buffer.from('sm1|2026-05-01T09:00:00.000Z').toString('base64url')],
    [
      'an identifier that is not one',
      Buffer.from('sm1|2026-05-01T09:00:00.000Z|nope').toString('base64url'),
    ],
    [
      'a statement',
      Buffer.from(`sm1|'; drop table public.support_messages; --|${POSITION.id}`).toString('base64url'),
    ],
  ])('the conversation cursor refuses %s', (_name, cursor) => {
    expect(decodeSupportMessagesCursor(cursor)).toBeNull();
  });

  it('build no fragment of a statement: what comes out is a Date and a uuid', () => {
    for (const decoded of [
      decodeSupportTicketsCursor(encodeSupportTicketsCursor(POSITION)),
      decodeSupportMessagesCursor(encodeSupportMessagesCursor(POSITION)),
    ]) {
      expect(decoded?.createdAt).toBeInstanceOf(Date);
      expect(decoded?.id).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});
