import { describe, expect, it } from 'vitest';
import {
  REVIEW_QUEUE_CURSOR_VERSION,
  decodeReviewQueueCursor,
  encodeReviewQueueCursor,
} from '../src/admin/review-moderation.cursor.js';
import {
  MODERATION_ACTION_READ_FOR_REVIEWS,
  REVIEWS_REVIEW_MODERATE,
  REVIEWS_REVIEW_READ,
} from '../src/admin/review-moderation.service.js';
import { ADMIN_RECOVERY_CURSOR_VERSION } from '../src/admin/admin-operations.cursor.js';

/**
 * The review queue cursor, and the three permission keys beside it (Phase 7-P).
 *
 * The cursor is client text that reaches a query, so what matters is that it decodes to a fixed pair of typed
 * values or to nothing at all. The property specific to this one is that the review queue runs **newest
 * first**, the opposite of the queues that drain — so a position in one of those is the wrong position here,
 * and the version tag is what refuses the confusion.
 */

const ID = 'a9000000-0000-4000-8000-000000000001';
const WHEN = new Date('2026-05-01T09:00:00.000Z');

const encode = (parts: readonly string[]): string =>
  Buffer.from(parts.join('|'), 'utf8').toString('base64url');

describe('a round trip', () => {
  it('returns the same position', () => {
    const decoded = decodeReviewQueueCursor(encodeReviewQueueCursor({ createdAt: WHEN, id: ID }));
    expect(decoded?.createdAt.toISOString()).toBe('2026-05-01T09:00:00.000Z');
    expect(decoded?.id).toBe(ID);
  });

  it('encodes the same position to the same string, every time', () => {
    const once = encodeReviewQueueCursor({ createdAt: WHEN, id: ID });
    const twice = encodeReviewQueueCursor({
      createdAt: new Date(WHEN.getTime()),
      id: ID.toUpperCase(),
    });
    expect(twice).toBe(once);
  });

  it('carries nothing but the tag, the time and the identifier', () => {
    const text = Buffer.from(
      encodeReviewQueueCursor({ createdAt: WHEN, id: ID }),
      'base64url',
    ).toString('utf8');
    expect(text).toBe(`${REVIEW_QUEUE_CURSOR_VERSION}|2026-05-01T09:00:00.000Z|${ID}`);
    // No account, no permission, no assurance level, no signature. A cursor confers nothing, which is why it
    // needs none of them.
    expect(text).not.toContain('reviews.');
    expect(text.split('|')).toHaveLength(3);
  });

  it('is URL-safe, so it survives being a query parameter', () => {
    const cursor = encodeReviewQueueCursor({ createdAt: WHEN, id: ID });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(cursor)).toBe(cursor);
  });
});

describe('what it refuses', () => {
  it('refuses a position from a queue that runs the other way', () => {
    // The recovery queue drains oldest first. Its position is a real position — in the wrong order, over rows
    // behind a different key entirely.
    expect(
      decodeReviewQueueCursor(encode([ADMIN_RECOVERY_CURSOR_VERSION, WHEN.toISOString(), ID])),
    ).toBeNull();
  });

  it('refuses every other list’s tag', () => {
    for (const tag of ['mi1', 'mm1', 'nt1', 'fv1', 'ss1', 'vq1', 'of1', 'sr1', 'aq1', 'st1', 'sm1', 'sq1', 'sa1', 'sn1', 'rp1', 'mr1', 'ml1', 'sp1', 'au1', 'ad1', 'rq1', 'rv2', 'RV1', '']) {
      expect(decodeReviewQueueCursor(encode([tag, WHEN.toISOString(), ID])), tag).toBeNull();
    }
  });

  it('refuses text that is not base64url, rather than decoding it to something', () => {
    // `Buffer.from` ignores characters it does not recognise, which is how a malformed cursor becomes a wrong
    // position instead of a refusal. The alphabet check and the round trip are what prevent it.
    for (const cursor of ['!!!!', 'a b c', 'ab+cd', 'ab/cd', 'abcd=', '']) {
      expect(decodeReviewQueueCursor(cursor), cursor).toBeNull();
    }
  });

  it('refuses the wrong number of fields', () => {
    expect(decodeReviewQueueCursor(encode([REVIEW_QUEUE_CURSOR_VERSION, WHEN.toISOString()]))).toBeNull();
    expect(
      decodeReviewQueueCursor(encode([REVIEW_QUEUE_CURSOR_VERSION, WHEN.toISOString(), ID, 'extra'])),
    ).toBeNull();
    expect(decodeReviewQueueCursor(encode([REVIEW_QUEUE_CURSOR_VERSION]))).toBeNull();
  });

  it('refuses an identifier that is not one', () => {
    for (const id of ['', 'one', ID.toUpperCase(), `${ID}0`, ID.slice(0, -1), '../etc/passwd']) {
      expect(
        decodeReviewQueueCursor(encode([REVIEW_QUEUE_CURSOR_VERSION, WHEN.toISOString(), id])),
        id,
      ).toBeNull();
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
      expect(
        decodeReviewQueueCursor(encode([REVIEW_QUEUE_CURSOR_VERSION, when, ID])),
        when,
      ).toBeNull();
    }
  });

  it('refuses a date that matches the shape and is not a date', () => {
    // `new Date` accepts it and rolls it over, so re-serialising is what catches it.
    for (const when of ['2026-02-31T09:00:00.000Z', '2026-13-01T09:00:00.000Z', '2026-05-01T25:00:00.000Z']) {
      expect(
        decodeReviewQueueCursor(encode([REVIEW_QUEUE_CURSOR_VERSION, when, ID])),
        when,
      ).toBeNull();
    }
  });

  it('builds no SQL fragment out of anything it is handed', () => {
    for (const hostile of [
      encode([REVIEW_QUEUE_CURSOR_VERSION, WHEN.toISOString(), "' or true --"]),
      encode([REVIEW_QUEUE_CURSOR_VERSION, "'; drop table public.reviews; --", ID]),
      encode(['rv1 union select', WHEN.toISOString(), ID]),
    ]) {
      expect(decodeReviewQueueCursor(hostile)).toBeNull();
    }
  });
});

describe('the three keys this surface consumes', () => {
  it('are the ones the database requires, spelled exactly', () => {
    expect(REVIEWS_REVIEW_READ).toBe('reviews.review.read');
    expect(REVIEWS_REVIEW_MODERATE).toBe('reviews.review.moderate');
    // 0027's own key for the trail. Deliberately not a review key: a colleague can hold both of those and
    // not this one.
    expect(MODERATION_ACTION_READ_FOR_REVIEWS).toBe('moderation.action.read');
  });

  it('are three different keys', () => {
    const keys = new Set([
      REVIEWS_REVIEW_READ,
      REVIEWS_REVIEW_MODERATE,
      MODERATION_ACTION_READ_FOR_REVIEWS,
    ]);
    expect(keys.size).toBe(3);
  });

  it('name no role anywhere', () => {
    for (const key of [
      REVIEWS_REVIEW_READ,
      REVIEWS_REVIEW_MODERATE,
      MODERATION_ACTION_READ_FOR_REVIEWS,
    ]) {
      for (const role of ['moderator', 'admin', 'super_admin', 'support_agent']) {
        expect(key, `${key}/${role}`).not.toContain(role);
      }
    }
  });
});
