import { describe, expect, it } from 'vitest';
import {
  SUPPORT_ASSIGNED_CURSOR_VERSION,
  SUPPORT_NOTES_CURSOR_VERSION,
  SUPPORT_QUEUE_CURSOR_VERSION,
  decodeSupportAssignedCursor,
  decodeSupportNotesCursor,
  decodeSupportQueueCursor,
  encodeSupportAssignedCursor,
  encodeSupportNotesCursor,
  encodeSupportQueueCursor,
} from '../src/admin/support-console.cursor.js';
import {
  encodeSupportMessagesCursor,
  encodeSupportTicketsCursor,
} from '../src/support/support-cursor.js';

/**
 * The support console's three cursors (Phase 7-L).
 *
 * The same properties every other cursor in this project is held to, plus the one that matters most on a
 * surface with three orders and two audiences: **no cursor can be spent anywhere but where it was issued.**
 * The queue runs oldest-first and the agent's own list newest-first, so a position crossed over would be a
 * plausible wrong place rather than an obvious one; and 7-K's requester cursors must not open a staff list.
 */

const POSITION = {
  createdAt: new Date('2026-05-01T09:00:00.000Z'),
  id: 'd5000000-0000-4000-8000-000000000001',
};

describe('the three console cursors', () => {
  it('each round-trips a position exactly', () => {
    for (const [encode, decode] of [
      [encodeSupportQueueCursor, decodeSupportQueueCursor],
      [encodeSupportAssignedCursor, decodeSupportAssignedCursor],
      [encodeSupportNotesCursor, decodeSupportNotesCursor],
    ] as const) {
      const decoded = decode(encode(POSITION));
      expect(decoded?.createdAt.toISOString()).toBe(POSITION.createdAt.toISOString());
      expect(decoded?.id).toBe(POSITION.id);
    }
  });

  it('are deterministic, base64url and case-insensitive on the identifier', () => {
    for (const encode of [
      encodeSupportQueueCursor,
      encodeSupportAssignedCursor,
      encodeSupportNotesCursor,
    ]) {
      expect(encode(POSITION)).toBe(encode(POSITION));
      expect(encode(POSITION)).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(encode({ ...POSITION, id: POSITION.id.toUpperCase() })).toBe(encode(POSITION));
    }
  });

  it('cannot be spent on each other', () => {
    expect(decodeSupportQueueCursor(encodeSupportAssignedCursor(POSITION))).toBeNull();
    expect(decodeSupportQueueCursor(encodeSupportNotesCursor(POSITION))).toBeNull();
    expect(decodeSupportAssignedCursor(encodeSupportQueueCursor(POSITION))).toBeNull();
    expect(decodeSupportAssignedCursor(encodeSupportNotesCursor(POSITION))).toBeNull();
    expect(decodeSupportNotesCursor(encodeSupportQueueCursor(POSITION))).toBeNull();
    expect(decodeSupportNotesCursor(encodeSupportAssignedCursor(POSITION))).toBeNull();
  });

  it('cannot be opened by a requester’s cursor from 7-K', () => {
    for (const decode of [
      decodeSupportQueueCursor,
      decodeSupportAssignedCursor,
      decodeSupportNotesCursor,
    ]) {
      expect(decode(encodeSupportTicketsCursor(POSITION))).toBeNull();
      expect(decode(encodeSupportMessagesCursor(POSITION))).toBeNull();
    }
  });

  it('carries its own version tag, and the three are distinct', () => {
    const tags = [
      SUPPORT_QUEUE_CURSOR_VERSION,
      SUPPORT_ASSIGNED_CURSOR_VERSION,
      SUPPORT_NOTES_CURSOR_VERSION,
    ];
    expect(new Set(tags).size).toBe(3);
    expect(Buffer.from(encodeSupportQueueCursor(POSITION), 'base64url').toString()).toContain(
      SUPPORT_QUEUE_CURSOR_VERSION,
    );
    expect(Buffer.from(encodeSupportAssignedCursor(POSITION), 'base64url').toString()).toContain(
      SUPPORT_ASSIGNED_CURSOR_VERSION,
    );
    expect(Buffer.from(encodeSupportNotesCursor(POSITION), 'base64url').toString()).toContain(
      SUPPORT_NOTES_CURSOR_VERSION,
    );
  });

  it.each([
    ['empty', ''],
    ['not base64url', '!!!!'],
    ['padded base64', 'YWJjZA=='],
    ['a truncated payload', Buffer.from('sq1|2026-05-01T09:00:00.000Z').toString('base64url')],
    ['an extra field', Buffer.from('sq1|2026-05-01T09:00:00.000Z|x|y').toString('base64url')],
    ['a wrong tag', Buffer.from(`zz1|2026-05-01T09:00:00.000Z|${POSITION.id}`).toString('base64url')],
    [
      'an identifier that is not one',
      Buffer.from('sq1|2026-05-01T09:00:00.000Z|nope').toString('base64url'),
    ],
    [
      'a timestamp without milliseconds',
      Buffer.from(`sq1|2026-05-01T09:00:00Z|${POSITION.id}`).toString('base64url'),
    ],
    [
      'a date that does not exist',
      Buffer.from(`sq1|2026-02-31T09:00:00.000Z|${POSITION.id}`).toString('base64url'),
    ],
    [
      'a statement',
      Buffer.from(`sq1|'; drop table public.support_tickets; --|${POSITION.id}`).toString('base64url'),
    ],
  ])('the queue cursor refuses %s', (_name, cursor) => {
    expect(decodeSupportQueueCursor(cursor)).toBeNull();
  });

  it('builds no fragment of a statement: what comes out is a Date and a uuid', () => {
    for (const decoded of [
      decodeSupportQueueCursor(encodeSupportQueueCursor(POSITION)),
      decodeSupportAssignedCursor(encodeSupportAssignedCursor(POSITION)),
      decodeSupportNotesCursor(encodeSupportNotesCursor(POSITION)),
    ]) {
      expect(decoded?.createdAt).toBeInstanceOf(Date);
      expect(decoded?.id).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});
