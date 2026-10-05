import { describe, expect, it } from 'vitest';
import {
  INBOX_CURSOR_VERSION,
  MESSAGES_CURSOR_VERSION,
  decodeInboxCursor,
  decodeMessagesCursor,
  encodeInboxCursor,
  encodeMessagesCursor,
} from '../src/messaging/messaging-cursor.js';

/**
 * The messaging cursors (Phase 5-C), on their own.
 *
 * A cursor is the one piece of the API a client hands straight back, so it is the one piece most worth
 * testing in isolation. What these assertions protect:
 *
 *   * encoding is **deterministic** — the same position always produces the same string, which is what
 *     lets a page be compared, cached and asserted on;
 *   * a round trip is lossless, including the undated tail of the inbox order, which is exactly the
 *     position a naive format loses;
 *   * every structural failure is a refusal rather than a guess — a wrong version, a wrong field count,
 *     a non-canonical encoding, a date that does not exist, an id that is not a uuid, a sequence that
 *     is not digits;
 *   * the two cursors are not interchangeable: an inbox cursor is refused by the message reader and the
 *     other way round, because they carry different positions in different orders.
 */

const TIMESTAMP = new Date('2026-09-24T18:30:00.000Z');
const CONVERSATION = 'e0000000-0000-4000-8000-000000000001';

function payloadOf(cursor: string): string {
  return Buffer.from(cursor, 'base64url').toString('utf8');
}

function tamper(cursor: string, change: (payload: string) => string): string {
  return Buffer.from(change(payloadOf(cursor)), 'utf8').toString('base64url');
}

describe('the inbox cursor', () => {
  it('encodes deterministically', () => {
    const first = encodeInboxCursor({ lastMessageAt: TIMESTAMP, conversationId: CONVERSATION });
    const second = encodeInboxCursor({ lastMessageAt: new Date(TIMESTAMP), conversationId: CONVERSATION });
    expect(first).toBe(second);
  });

  it('round trips a dated position exactly', () => {
    const cursor = encodeInboxCursor({ lastMessageAt: TIMESTAMP, conversationId: CONVERSATION });
    expect(decodeInboxCursor(cursor)).toEqual({ lastMessageAt: TIMESTAMP, conversationId: CONVERSATION });
  });

  it('round trips the undated tail, which is a position too', () => {
    const cursor = encodeInboxCursor({ lastMessageAt: null, conversationId: CONVERSATION });
    expect(decodeInboxCursor(cursor)).toEqual({ lastMessageAt: null, conversationId: CONVERSATION });
  });

  it('is base64url, so it survives a query string unescaped', () => {
    const cursor = encodeInboxCursor({ lastMessageAt: TIMESTAMP, conversationId: CONVERSATION });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(cursor)).toBe(cursor);
  });

  it('carries its version, and only the two ordering values', () => {
    const payload = payloadOf(encodeInboxCursor({ lastMessageAt: TIMESTAMP, conversationId: CONVERSATION }));
    expect(payload.split('|')).toEqual([INBOX_CURSOR_VERSION, TIMESTAMP.toISOString(), CONVERSATION]);
  });

  it('refuses a cursor from another version', () => {
    const cursor = encodeInboxCursor({ lastMessageAt: TIMESTAMP, conversationId: CONVERSATION });
    for (const version of ['mi0', 'mi2', 'v1', 'mm1', '']) {
      expect(decodeInboxCursor(tamper(cursor, (p) => p.replace(INBOX_CURSOR_VERSION, version))), version).toBeNull();
    }
  });

  it('refuses a message cursor, which names a different kind of position', () => {
    expect(decodeInboxCursor(encodeMessagesCursor({ seq: '42' }))).toBeNull();
  });

  it('refuses a tampered timestamp that is not a real instant', () => {
    const cursor = encodeInboxCursor({ lastMessageAt: TIMESTAMP, conversationId: CONVERSATION });
    for (const bad of ['2026-02-31T00:00:00.000Z', '2026-13-01T00:00:00.000Z', '2026-09-24T25:00:00.000Z']) {
      expect(decodeInboxCursor(tamper(cursor, (p) => p.replace(TIMESTAMP.toISOString(), bad))), bad).toBeNull();
    }
  });

  it('refuses a timestamp in any other shape', () => {
    const cursor = encodeInboxCursor({ lastMessageAt: TIMESTAMP, conversationId: CONVERSATION });
    for (const bad of ['2026-09-24T18:30:00Z', '2026-09-24 18:30:00.000Z', '1758738600000', 'now']) {
      expect(decodeInboxCursor(tamper(cursor, (p) => p.replace(TIMESTAMP.toISOString(), bad))), bad).toBeNull();
    }
  });

  it('refuses an identifier that is not a uuid', () => {
    const cursor = encodeInboxCursor({ lastMessageAt: TIMESTAMP, conversationId: CONVERSATION });
    for (const bad of ['not-a-uuid', '1', `${CONVERSATION}x`, 'E0000000-0000-4000-8000-000000000001']) {
      expect(decodeInboxCursor(tamper(cursor, (p) => p.replace(CONVERSATION, bad))), bad).toBeNull();
    }
  });

  it('refuses the wrong number of fields', () => {
    const cursor = encodeInboxCursor({ lastMessageAt: TIMESTAMP, conversationId: CONVERSATION });
    expect(decodeInboxCursor(tamper(cursor, (p) => `${p}|extra`))).toBeNull();
    expect(decodeInboxCursor(tamper(cursor, (p) => p.split('|').slice(0, 2).join('|')))).toBeNull();
  });

  it('refuses text that is not base64url at all', () => {
    for (const bad of ['', '!!!!', 'not base64', 'AAAA===', 'a+b/c']) {
      expect(decodeInboxCursor(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('refuses a non-canonical encoding rather than normalising it', () => {
    const cursor = encodeInboxCursor({ lastMessageAt: TIMESTAMP, conversationId: CONVERSATION });
    // Padding is not produced by this encoder, so a padded copy did not come from it.
    expect(decodeInboxCursor(`${cursor}=`)).toBeNull();
  });

  it('refuses arbitrary text that happens to decode', () => {
    for (const payload of ['drop table messages', 'mi1|', '|||', 'mi1|-|', 'mi1']) {
      const cursor = Buffer.from(payload, 'utf8').toString('base64url');
      expect(decodeInboxCursor(cursor), payload).toBeNull();
    }
  });
});

describe('the messages cursor', () => {
  it('encodes deterministically and round trips', () => {
    expect(encodeMessagesCursor({ seq: '42' })).toBe(encodeMessagesCursor({ seq: '42' }));
    expect(decodeMessagesCursor(encodeMessagesCursor({ seq: '42' }))).toEqual({ seq: '42' });
  });

  it('carries its version and only the sequence', () => {
    expect(payloadOf(encodeMessagesCursor({ seq: '42' })).split('|')).toEqual([MESSAGES_CURSOR_VERSION, '42']);
  });

  it('keeps a sequence a double could not hold, because seq is a bigint', () => {
    const huge = '9223372036854775807';
    expect(decodeMessagesCursor(encodeMessagesCursor({ seq: huge }))).toEqual({ seq: huge });
  });

  it('refuses a cursor from another version', () => {
    const cursor = encodeMessagesCursor({ seq: '42' });
    for (const version of ['mm0', 'mm2', 'mi1', 'v1', '']) {
      expect(decodeMessagesCursor(tamper(cursor, (p) => p.replace(MESSAGES_CURSOR_VERSION, version))), version).toBeNull();
    }
  });

  it('refuses an inbox cursor', () => {
    expect(decodeMessagesCursor(encodeInboxCursor({ lastMessageAt: TIMESTAMP, conversationId: CONVERSATION }))).toBeNull();
  });

  it('refuses a sequence that is not a positive whole number', () => {
    const cursor = encodeMessagesCursor({ seq: '42' });
    for (const bad of ['0', '-1', '4.2', '042', '4 2', '', 'forty-two', '1e3']) {
      expect(decodeMessagesCursor(tamper(cursor, (p) => p.replace('42', bad))), JSON.stringify(bad)).toBeNull();
    }
  });

  it('refuses the wrong number of fields', () => {
    const cursor = encodeMessagesCursor({ seq: '42' });
    expect(decodeMessagesCursor(tamper(cursor, (p) => `${p}|extra`))).toBeNull();
    expect(decodeMessagesCursor(tamper(cursor, () => MESSAGES_CURSOR_VERSION))).toBeNull();
  });

  it('refuses text that is not base64url', () => {
    for (const bad of ['', '!!!!', 'a+b/c']) {
      expect(decodeMessagesCursor(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('a cursor carries no instruction', () => {
  it('decodes only into typed values, never into anything a query could interpret', () => {
    // Whatever a caller writes, a decoded cursor is either a Date plus a uuid, a digit string, or null.
    for (const attempt of [
      "mi1|2026-09-24T18:30:00.000Z|' or 1=1 --",
      'mm1|1; drop table messages',
      'mm1|1 union select 1',
      'mi1|2026-09-24T18:30:00.000Z|*',
    ]) {
      const cursor = Buffer.from(attempt, 'utf8').toString('base64url');
      expect(decodeInboxCursor(cursor), attempt).toBeNull();
      expect(decodeMessagesCursor(cursor), attempt).toBeNull();
    }
  });

  it('and a well-formed one yields exactly the two declared fields, nothing more', () => {
    const decoded = decodeInboxCursor(encodeInboxCursor({ lastMessageAt: TIMESTAMP, conversationId: CONVERSATION }));
    expect(Object.keys(decoded ?? {}).sort()).toEqual(['conversationId', 'lastMessageAt']);
    expect(Object.keys(decodeMessagesCursor(encodeMessagesCursor({ seq: '7' })) ?? {})).toEqual(['seq']);
  });
});
