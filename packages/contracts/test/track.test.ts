import { describe, expect, it } from 'vitest';
import {
  TRACK_EVENT_TYPES,
  TRACK_MAX_EVENTS,
  TRACK_REFERRER_HOST_MAX,
  TRACK_SOURCES,
  TrackRequestSchema,
  TrackResponseSchema,
} from '../src/index.js';

/**
 * The ingestion contract (0101).
 *
 * Two properties carry the owner's decisions, and both are structural rather than enforced by a rule
 * somewhere else: there is **no field** for an account or for a session digest, so neither can be supplied;
 * and `impression` and `view` are **not in the enum**, so nothing can start collecting them under a
 * definition Phase 9 has not made.
 */

const LISTING = '11111111-1111-4111-8111-111111111111';
const EVENT = '22222222-2222-4222-8222-222222222222';

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { eventId: EVENT, listingId: LISTING, eventType: 'click', ...overrides };
}

describe('the event types', () => {
  it('are exactly the four this increment ingests', () => {
    expect([...TRACK_EVENT_TYPES]).toEqual(['click', 'contact', 'favorite', 'share']);
  });

  it('accepts each of them', () => {
    for (const eventType of TRACK_EVENT_TYPES) {
      expect(
        TrackRequestSchema.safeParse({ events: [event({ eventType })] }).success,
        eventType,
      ).toBe(true);
    }
  });

  /** Owner decision 2, and the reason for it: their definitions are a Phase 9 decision. */
  it('refuses impression and view, which the database would otherwise accept', () => {
    for (const eventType of ['impression', 'view']) {
      expect(
        TrackRequestSchema.safeParse({ events: [event({ eventType })] }).success,
        eventType,
      ).toBe(false);
    }
  });

  it('refuses an invented type', () => {
    for (const eventType of ['purchase', 'CLICK', 'click ', '', null, 42]) {
      expect(
        TrackRequestSchema.safeParse({ events: [event({ eventType })] }).success,
        JSON.stringify(eventType),
      ).toBe(false);
    }
  });
});

describe('the batch', () => {
  it('requires at least one event', () => {
    expect(TrackRequestSchema.safeParse({ events: [] }).success).toBe(false);
    expect(TrackRequestSchema.safeParse({}).success).toBe(false);
  });

  it('accepts exactly the approved ceiling', () => {
    const events = Array.from({ length: TRACK_MAX_EVENTS }, (_, index) =>
      event({ eventId: `3${index.toString().padStart(7, '0')}-2222-4222-8222-222222222222` }),
    );
    expect(TRACK_MAX_EVENTS).toBe(50);
    expect(TrackRequestSchema.safeParse({ events }).success).toBe(true);
  });

  it('refuses one event more, whole rather than truncated', () => {
    const events = Array.from({ length: TRACK_MAX_EVENTS + 1 }, (_, index) =>
      event({ eventId: `4${index.toString().padStart(7, '0')}-2222-4222-8222-222222222222` }),
    );
    const parsed = TrackRequestSchema.safeParse({ events });
    expect(parsed.success).toBe(false);
  });

  it('refuses a payload that is not a batch at all', () => {
    for (const events of ['click', 42, {}, null, [{}], [null]]) {
      expect(TrackRequestSchema.safeParse({ events }).success, JSON.stringify(events)).toBe(false);
    }
  });
});

describe('what an event may say', () => {
  it('requires a uuid event id and a uuid listing id', () => {
    expect(TrackRequestSchema.safeParse({ events: [event({ eventId: 'nope' })] }).success).toBe(false);
    expect(TrackRequestSchema.safeParse({ events: [event({ listingId: 'nope' })] }).success).toBe(false);
    expect(TrackRequestSchema.safeParse({ events: [{ eventId: EVENT, eventType: 'click' }] }).success).toBe(
      false,
    );
  });

  it('accepts every source 0013 allows, and nothing else', () => {
    expect([...TRACK_SOURCES]).toEqual(['search', 'category', 'listing', 'seller', 'home', 'external']);
    for (const source of TRACK_SOURCES) {
      expect(TrackRequestSchema.safeParse({ events: [event({ source })] }).success, source).toBe(true);
    }
    expect(TrackRequestSchema.safeParse({ events: [event({ source: 'email' })] }).success).toBe(false);
  });

  it('accepts a timestamp and a promotion, and refuses a malformed one', () => {
    expect(
      TrackRequestSchema.safeParse({ events: [event({ occurredAt: '2026-10-03T19:00:00.000Z' })] }).success,
    ).toBe(true);
    expect(TrackRequestSchema.safeParse({ events: [event({ occurredAt: 'yesterday' })] }).success).toBe(
      false,
    );
    expect(TrackRequestSchema.safeParse({ events: [event({ promotionId: LISTING })] }).success).toBe(true);
    expect(TrackRequestSchema.safeParse({ events: [event({ promotionId: 'nope' })] }).success).toBe(false);
  });

  it('bounds the referrer host at the limit 0013 sets', () => {
    expect(
      TrackRequestSchema.safeParse({ events: [event({ referrerHost: 'a'.repeat(TRACK_REFERRER_HOST_MAX) })] })
        .success,
    ).toBe(true);
    expect(
      TrackRequestSchema.safeParse({
        events: [event({ referrerHost: 'a'.repeat(TRACK_REFERRER_HOST_MAX + 1) })],
      }).success,
    ).toBe(false);
  });

  /**
   * The structural half of owner decisions 4 and 6. None of these fields exists, and each is something a
   * crafted beacon might try: claiming an account, choosing the stored digest, or asserting whose listing
   * it is.
   */
  it('has no field for an account, a digest, or another person identity', () => {
    for (const extra of [
      { userId: LISTING },
      { user_id: LISTING },
      { sessionHash: 'ab'.repeat(32) },
      { session_hash: 'ab'.repeat(32) },
      { sellerUserId: LISTING },
      { seller_user_id: LISTING },
      { ip: '203.0.113.9' },
      { requestIp: '203.0.113.9' },
    ]) {
      expect(
        TrackRequestSchema.safeParse({ events: [event(extra)] }).success,
        JSON.stringify(extra),
      ).toBe(false);
    }
  });

  it('refuses an unknown field at the top level too', () => {
    expect(TrackRequestSchema.safeParse({ events: [event()], userId: LISTING }).success).toBe(false);
    expect(TrackRequestSchema.safeParse({ events: [event()], sessionHash: 'ab' }).success).toBe(false);
  });
});

describe('the session identifier', () => {
  it('is optional, and may be an explicit null for a browser that has none', () => {
    expect(TrackRequestSchema.safeParse({ events: [event()] }).success).toBe(true);
    expect(TrackRequestSchema.safeParse({ events: [event()], sessionId: null }).success).toBe(true);
  });

  it('is an opaque bounded string, never a digest the caller chose', () => {
    expect(TrackRequestSchema.safeParse({ events: [event()], sessionId: 'a'.repeat(43) }).success).toBe(true);
    expect(TrackRequestSchema.safeParse({ events: [event()], sessionId: '' }).success).toBe(false);
    expect(TrackRequestSchema.safeParse({ events: [event()], sessionId: 'a'.repeat(65) }).success).toBe(
      false,
    );
  });
});

describe('the response', () => {
  it('reports a count and nothing else', () => {
    expect(TrackResponseSchema.safeParse({ accepted: 3 }).success).toBe(true);
    expect(TrackResponseSchema.safeParse({ accepted: 0 }).success).toBe(true);
    expect(TrackResponseSchema.safeParse({ accepted: -1 }).success).toBe(false);
  });

  /** Nothing about a listing, a duplicate or a row count: the beacon is not a read surface. */
  it('cannot carry a row count, an identifier or a duplicate flag', () => {
    for (const extra of [{ inserted: 3 }, { duplicates: 1 }, { listingId: LISTING }, { sessionHash: 'ab' }]) {
      expect(TrackResponseSchema.safeParse({ accepted: 3, ...extra }).success, JSON.stringify(extra)).toBe(
        false,
      );
    }
  });
});
