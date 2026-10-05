import { describe, expect, it } from 'vitest';
import {
  DISPUTE_QUEUE_CURSOR_VERSION,
  decodeDisputeQueueCursor,
  encodeDisputeQueueCursor,
} from '../src/admin/dispute-management.cursor.js';
import {
  DISPUTES_DISPUTE_MANAGE,
  DISPUTES_DISPUTE_READ,
} from '../src/admin/dispute-management.service.js';
import { ADMIN_RECOVERY_CURSOR_VERSION } from '../src/admin/admin-operations.cursor.js';
import { REVIEW_QUEUE_CURSOR_VERSION } from '../src/admin/review-moderation.cursor.js';
import { JOB_RUN_CURSOR_VERSION } from '../src/admin/platform-operations.cursor.js';

/**
 * The dispute queue cursor, and the two permission keys beside it (Phase 7-R).
 *
 * The cursor is client text that reaches a query, so what matters is that it decodes to a fixed pair of typed
 * values or to nothing at all.
 *
 * The property specific to this one is that its tag is **distinct from every other tag in use**, which matters
 * because several of them carry the very same `(timestamp, uuid)` pair over different rows behind different
 * keys. A recovery-queue position and a review-queue position are both real positions — in the wrong list — and
 * the tag is the only thing that refuses them.
 */

const ID = 'fe000000-0000-4000-8000-000000000001';
const WHEN = new Date('2026-05-01T09:00:00.000Z');

const encode = (parts: readonly string[]): string =>
  Buffer.from(parts.join('|'), 'utf8').toString('base64url');

describe('a round trip', () => {
  it('returns the same position', () => {
    const decoded = decodeDisputeQueueCursor(encodeDisputeQueueCursor({ createdAt: WHEN, id: ID }));
    expect(decoded?.createdAt.toISOString()).toBe('2026-05-01T09:00:00.000Z');
    expect(decoded?.id).toBe(ID);
  });

  it('encodes the same position to the same string, every time', () => {
    const once = encodeDisputeQueueCursor({ createdAt: WHEN, id: ID });
    const twice = encodeDisputeQueueCursor({ createdAt: new Date(WHEN.getTime()), id: ID.toUpperCase() });
    expect(twice).toBe(once);
  });

  it('carries nothing but the tag, the time and the identifier', () => {
    const text = Buffer.from(encodeDisputeQueueCursor({ createdAt: WHEN, id: ID }), 'base64url').toString(
      'utf8',
    );
    expect(text).toBe(`${DISPUTE_QUEUE_CURSOR_VERSION}|2026-05-01T09:00:00.000Z|${ID}`);
    // No account, no permission, no assurance level, no signature. A cursor confers nothing, which is why it
    // needs none of them.
    expect(text).not.toContain('disputes.');
    expect(text.split('|')).toHaveLength(3);
  });

  it('is URL-safe, so it survives being a query parameter', () => {
    const cursor = encodeDisputeQueueCursor({ createdAt: WHEN, id: ID });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(cursor)).toBe(cursor);
  });
});

describe('its tag is its own', () => {
  it('differs from every other tag in use', () => {
    const tags = [
      'mi1', 'mm1', 'nt1', 'fv1', 'ss1', 'vq1', 'of1', 'sr1', 'aq1', 'st1', 'sm1', 'sq1', 'sa1',
      'sn1', 'rp1', 'mr1', 'ml1', 'sp1', 'au1', 'ad1', 'rq1', 'rv1', 'jr1',
    ];
    expect(tags).not.toContain(DISPUTE_QUEUE_CURSOR_VERSION);
    // Named explicitly as well: these two carry exactly this cursor's pair of fields, so a collision between
    // them would be a position silently accepted from the wrong list.
    expect(DISPUTE_QUEUE_CURSOR_VERSION).not.toBe(ADMIN_RECOVERY_CURSOR_VERSION);
    expect(DISPUTE_QUEUE_CURSOR_VERSION).not.toBe(REVIEW_QUEUE_CURSOR_VERSION);
    expect(DISPUTE_QUEUE_CURSOR_VERSION).not.toBe(JOB_RUN_CURSOR_VERSION);
  });

  it('refuses a position from every other list that carries the same pair of fields', () => {
    for (const tag of [
      ADMIN_RECOVERY_CURSOR_VERSION,
      REVIEW_QUEUE_CURSOR_VERSION,
      JOB_RUN_CURSOR_VERSION,
    ]) {
      expect(decodeDisputeQueueCursor(encode([tag, WHEN.toISOString(), ID])), tag).toBeNull();
    }
  });

  it('refuses every other list’s tag', () => {
    for (const tag of [
      'mi1', 'mm1', 'nt1', 'fv1', 'ss1', 'vq1', 'of1', 'sr1', 'aq1', 'st1', 'sm1', 'sq1', 'sa1',
      'sn1', 'rp1', 'mr1', 'ml1', 'sp1', 'au1', 'ad1', 'jr1', 'rq1', 'rv1', 'dq2', 'DQ1', '',
    ]) {
      expect(decodeDisputeQueueCursor(encode([tag, WHEN.toISOString(), ID])), tag).toBeNull();
    }
  });
});

describe('what it refuses', () => {
  it('refuses text that is not base64url, rather than decoding it to something', () => {
    // `Buffer.from` ignores characters it does not recognise, which is how a malformed cursor becomes a wrong
    // position instead of a refusal. The alphabet check and the round trip are what prevent it.
    for (const cursor of ['!!!!', 'a b c', 'ab+cd', 'ab/cd', 'abcd=', '']) {
      expect(decodeDisputeQueueCursor(cursor), cursor).toBeNull();
    }
  });

  it('refuses the wrong number of fields', () => {
    expect(decodeDisputeQueueCursor(encode([DISPUTE_QUEUE_CURSOR_VERSION, WHEN.toISOString()]))).toBeNull();
    expect(
      decodeDisputeQueueCursor(encode([DISPUTE_QUEUE_CURSOR_VERSION, WHEN.toISOString(), ID, 'extra'])),
    ).toBeNull();
    expect(decodeDisputeQueueCursor(encode([DISPUTE_QUEUE_CURSOR_VERSION]))).toBeNull();
  });

  it('refuses an identifier that is not one', () => {
    for (const id of ['', 'one', ID.toUpperCase(), `${ID}0`, ID.slice(0, -1), '../etc/passwd']) {
      expect(decodeDisputeQueueCursor(encode([DISPUTE_QUEUE_CURSOR_VERSION, WHEN.toISOString(), id])), id).toBeNull();
    }
  });

  it('refuses a timestamp that is not the one shape it writes', () => {
    for (const when of [
      '2026-05-01 09:00:00',
      '2026-05-01T09:00:00Z',
      '2026-05-01T09:00:00.000+02:00',
      '2026-05-01T09:00:00.000',
      'now()',
      '',
    ]) {
      expect(decodeDisputeQueueCursor(encode([DISPUTE_QUEUE_CURSOR_VERSION, when, ID])), when).toBeNull();
    }
  });

  it('refuses a date that matches the shape and is not a date', () => {
    // `new Date` accepts it and rolls it over, so re-serialising is what catches it.
    for (const when of ['2026-02-31T09:00:00.000Z', '2026-13-01T09:00:00.000Z', '2026-05-01T25:00:00.000Z']) {
      expect(decodeDisputeQueueCursor(encode([DISPUTE_QUEUE_CURSOR_VERSION, when, ID])), when).toBeNull();
    }
  });

  it('builds no SQL fragment out of anything it is handed', () => {
    for (const hostile of [
      encode([DISPUTE_QUEUE_CURSOR_VERSION, WHEN.toISOString(), "' or true --"]),
      encode([DISPUTE_QUEUE_CURSOR_VERSION, "'; drop table public.disputes; --", ID]),
      encode(['dq1 union select', WHEN.toISOString(), ID]),
    ]) {
      expect(decodeDisputeQueueCursor(hostile)).toBeNull();
    }
  });
});

describe('the two keys this surface consumes', () => {
  it('are the ones the database requires, spelled exactly', () => {
    expect(DISPUTES_DISPUTE_READ).toBe('disputes.dispute.read');
    expect(DISPUTES_DISPUTE_MANAGE).toBe('disputes.dispute.manage');
  });

  it('are two different keys, one for reading and one for acting', () => {
    expect(DISPUTES_DISPUTE_READ).not.toBe(DISPUTES_DISPUTE_MANAGE);
  });

  /**
   * The keys this surface must never consume. Issuing a refund is Phase 8's, with its own permissions; a
   * dispute console that reached for one of these would have crossed the boundary.
   */
  it('are neither of the payments keys, which belong to a later phase', () => {
    for (const key of [DISPUTES_DISPUTE_READ, DISPUTES_DISPUTE_MANAGE]) {
      expect(key).not.toContain('payments.');
      expect(key).not.toContain('refund');
      expect(key).not.toContain('payout');
      expect(key).not.toContain('ledger');
    }
  });

  it('name no role', () => {
    for (const key of [DISPUTES_DISPUTE_READ, DISPUTES_DISPUTE_MANAGE]) {
      for (const role of ['moderator', 'admin', 'super_admin', 'support_agent']) {
        expect(key, `${key}/${role}`).not.toContain(role);
      }
    }
  });
});
