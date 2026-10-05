import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { SESSION_TOKEN_HEADER, TrackResponseSchema } from '@repo/contracts';
import { ANALYTICS_SESSION_DOMAIN, analyticsSessionHash, newAnalyticsSessionId } from '@repo/server-config';
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import {
  LISTING_EVENT_STORE,
  TRACK_THROTTLE_BUCKETS,
  LISTING_EVENT_BACKDATE_LIMIT_MS,
} from '../src/analytics/listing-events.service.js';
import { LISTING_EVENT_STREAM_PORT } from '../src/analytics/listing-events.stream.js';
import { DURABLE_THROTTLE_COUNTER, REDIS_THROTTLE_COUNTER } from '../src/auth/login-throttle.service.js';
import { SUPABASE_AUTH_CLIENT } from '../src/auth/login.service.js';
import { CURRENT_USER_STORE } from '../src/users/current-user.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * `POST /v1/track` — listing event ingestion (0101).
 *
 * The properties under test are the owner's decisions at the boundary, and most of them are about what a
 * caller **cannot** cause: it cannot claim an account, it cannot choose the stored session digest, it cannot
 * exceed the batch ceiling, and it cannot remove the rate limit by taking Redis away. The two ingestion paths
 * O-21 approves are both exercised, in both orders, including the case where neither is available.
 *
 * What a caller *can* do is describe what happened to which listing, without a session. That is the one
 * relaxation this route carries, and the internal credential is still required — "unauthenticated" here means
 * no account, never no caller.
 */

const LISTING = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const TOKEN = 'a-test-access-token-not-a-real-one';
const KEY = TEST_ENV.analyticsSessionKey;

function uuid(n: number): string {
  return `${n.toString(16).padStart(8, '0')}-2222-4222-8222-222222222222`;
}

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { eventId: uuid(1), listingId: LISTING, eventType: 'click', ...overrides };
}

interface Doubles {
  /** No stream provider at all: a deployment without Redis. */
  readonly noStream?: boolean;
  readonly streamThrows?: boolean;
  readonly storeThrows?: boolean;
  /** How many rows the database says it wrote. De-duplication makes this legitimately lower. */
  readonly storeWrites?: number;
  readonly redisCounter?: 'allow' | 'refuse' | 'throw' | 'absent';
  readonly durableCounter?: 'allow' | 'refuse' | 'throw';
  /** The provider refuses the token, as it would for an expired one. */
  readonly tokenInvalid?: boolean;
  /** The account exists to the provider but has no profile row. */
  readonly profileMissing?: boolean;
}

interface Recorded {
  readonly published: Array<readonly Record<string, unknown>[]>;
  readonly stored: Array<readonly Record<string, unknown>[]>;
  readonly counted: Array<{ bucket: string; subject: string; windowSeconds: number; limit: number }>;
  readonly tokens: string[];
}

let app: NestFastifyApplication | undefined;

async function start(doubles: Doubles = {}): Promise<Recorded> {
  const recorded: Recorded = { published: [], stored: [], counted: [], tokens: [] };

  const counter = (mode: 'allow' | 'refuse' | 'throw') => ({
    hit: async (bucket: string, subject: Buffer, windowSeconds: number, limit: number) => {
      recorded.counted.push({ bucket, subject: subject.toString('hex'), windowSeconds, limit });
      if (mode === 'throw') throw new Error('the counter is unavailable');
      return mode === 'allow';
    },
  });

  const builder = Test.createTestingModule({ imports: [AppModule.forRoot(TEST_ENV)] })
    .overrideProvider(LISTING_EVENT_STREAM_PORT)
    .useValue(
      doubles.noStream === true
        ? null
        : {
            publish: async (rows: readonly Record<string, unknown>[]) => {
              if (doubles.streamThrows === true) throw new Error('redis is unreachable');
              recorded.published.push(rows);
            },
          },
    )
    .overrideProvider(LISTING_EVENT_STORE)
    .useValue({
      recordListingEvents: async (rows: readonly Record<string, unknown>[]) => {
        if (doubles.storeThrows === true) throw new Error('the database is unavailable');
        recorded.stored.push(rows);
        return doubles.storeWrites ?? rows.length;
      },
    })
    .overrideProvider(REDIS_THROTTLE_COUNTER)
    .useValue(doubles.redisCounter === 'absent' ? null : counter(doubles.redisCounter ?? 'allow'))
    .overrideProvider(DURABLE_THROTTLE_COUNTER)
    .useValue(counter(doubles.durableCounter ?? 'allow'))
    .overrideProvider(SUPABASE_AUTH_CLIENT)
    .useValue({
      getUser: async (accessToken: string) => {
        recorded.tokens.push(accessToken);
        if (doubles.tokenInvalid === true) throw new Error('the token is not valid');
        return { id: ACCOUNT };
      },
    })
    .overrideProvider(CURRENT_USER_STORE)
    .useValue({
      userIdentity: async (userId: string) =>
        doubles.profileMissing === true ? null : { id: userId, displayName: 'A buyer' },
    });

  const moduleRef = await builder.compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(
    createFastifyAdapter(TEST_ENV, { logStream: { write: () => undefined } }),
    NEST_APP_OPTIONS,
  );
  await configureApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return recorded;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

interface Sent {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly raw: string;
}

async function post(
  payload: unknown,
  options: { readonly token?: string; readonly credential?: string | null } = {},
): Promise<Sent> {
  const credential = options.credential === undefined ? TEST_INTERNAL_CREDENTIAL : options.credential;
  const response = await app!.inject({
    method: 'POST',
    url: '/v1/track',
    headers: {
      'content-type': 'application/json',
      ...(credential === null ? {} : { [INTERNAL_CREDENTIAL_HEADER]: credential }),
      ...(options.token === undefined ? {} : { [SESSION_TOKEN_HEADER]: options.token }),
    },
    payload: JSON.stringify(payload),
  });
  return {
    status: response.statusCode,
    body: response.payload === '' ? {} : (JSON.parse(response.payload) as Record<string, unknown>),
    raw: response.payload,
  };
}

/** The single row a one-event batch produced, from whichever path took it. */
function onlyRow(recorded: Recorded): Record<string, unknown> {
  const batches = [...recorded.published, ...recorded.stored];
  expect(batches).toHaveLength(1);
  expect(batches[0]).toHaveLength(1);
  return batches[0]![0]!;
}

describe('the route', () => {
  it('answers 202 with a count that matches the contract', async () => {
    await start();
    const result = await post({ events: [event()] });
    expect(result.status).toBe(202);
    expect(TrackResponseSchema.safeParse(result.body).success).toBe(true);
    expect(result.body).toEqual({ accepted: 1 });
  });

  /**
   * The relaxation is about the *account*, not about the caller. Every `/v1` route needs the internal BFF
   * credential, and nothing skips the guard for this one.
   */
  it('still requires the internal credential, with no session anywhere in the request', async () => {
    await start();
    expect((await post({ events: [event()] }, { credential: null })).status).toBe(403);
    expect((await post({ events: [event()] }, { credential: 'not-the-credential' })).status).toBe(403);
    expect((await post({ events: [event()] })).status).toBe(202);
  });

  it('reports what it took responsibility for, not what the database wrote', async () => {
    // A retried batch de-duplicates to nothing downstream. The caller is still told 2, because it has
    // nothing useful to do with a row count and a zero would invite it to retry.
    await start({ noStream: true, storeWrites: 0 });
    const result = await post({ events: [event(), event({ eventId: uuid(2) })] });
    expect(result.status).toBe(202);
    expect(result.body).toEqual({ accepted: 2 });
  });

  it('answers nothing about the listing, the session or the rows', async () => {
    await start();
    const result = await post({ events: [event()] });
    expect(Object.keys(result.body)).toEqual(['accepted']);
    for (const leak of [LISTING, 'session', 'hash', 'duplicate', 'inserted']) {
      expect(result.raw.toLowerCase()).not.toContain(leak.toLowerCase());
    }
  });
});

describe('the account', () => {
  /** Owner decision 6, the anonymous half — the normal case for a public catalogue. */
  it('is absent for a request with no session token, and the provider is never asked', async () => {
    const recorded = await start();
    await post({ events: [event()] });
    expect(onlyRow(recorded)['user_id']).toBeNull();
    expect(recorded.tokens).toEqual([]);
  });

  /** Owner decision 6, the authenticated half: derived from the request context, never from the body. */
  it('comes from the session token when there is one', async () => {
    const recorded = await start();
    await post({ events: [event()] }, { token: TOKEN });
    expect(recorded.tokens).toEqual([TOKEN]);
    expect(onlyRow(recorded)['user_id']).toBe(ACCOUNT);
  });

  it('cannot be claimed in the body, under any spelling', async () => {
    await start();
    for (const extra of [{ userId: ACCOUNT }, { user_id: ACCOUNT }, { sellerUserId: ACCOUNT }]) {
      const result = await post({ events: [event(extra)] });
      expect(result.status, JSON.stringify(extra)).toBe(400);
      expect(result.body['code']).toBe('VALIDATION_FAILED');
    }
    for (const extra of [{ userId: ACCOUNT }, { sessionHash: 'ab'.repeat(32) }]) {
      expect((await post({ events: [event()], ...extra })).status, JSON.stringify(extra)).toBe(400);
    }
  });

  /**
   * A beacon fires after a page has been open for a while, so an expired token is ordinary. Losing the
   * batch over it would teach the client nothing and cost the events.
   */
  it('is absent rather than refused when the token cannot be used', async () => {
    const refused = await start({ tokenInvalid: true });
    const result = await post({ events: [event()] }, { token: TOKEN });
    expect(result.status).toBe(202);
    expect(onlyRow(refused)['user_id']).toBeNull();
  });

  it('is absent when the token resolves to an account with no profile', async () => {
    const recorded = await start({ profileMissing: true });
    expect((await post({ events: [event()] }, { token: TOKEN })).status).toBe(202);
    expect(onlyRow(recorded)['user_id']).toBeNull();
  });

  it('is absent for an empty token header, which is not a session', async () => {
    const recorded = await start();
    expect((await post({ events: [event()] }, { token: '' })).status).toBe(202);
    expect(onlyRow(recorded)['user_id']).toBeNull();
    expect(recorded.tokens).toEqual([]);
  });
});

describe('the session digest', () => {
  /** Owner decision 4: the server computes it, under its own key, from the opaque identifier. */
  it('is the keyed hash of the identifier the request carried', async () => {
    const recorded = await start();
    const sessionId = newAnalyticsSessionId();
    await post({ events: [event()], sessionId });
    expect(onlyRow(recorded)['session_hash']).toBe(analyticsSessionHash(KEY, sessionId));
    expect(onlyRow(recorded)['session_hash']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is never the identifier itself, and never under another scheme’s label', async () => {
    const recorded = await start();
    const sessionId = newAnalyticsSessionId();
    await post({ events: [event()], sessionId });
    const stored = onlyRow(recorded)['session_hash'] as string;
    expect(stored).not.toContain(sessionId);
    // The same key under a different domain label gives a different digest, which is the whole point of
    // separating the three schemes: an analytics digest cannot be matched against a device row.
    expect(stored).not.toBe(createHmac('sha256', KEY).update(`device-v1:${sessionId}`).digest('hex'));
    expect(stored).toBe(createHmac('sha256', KEY).update(`${ANALYTICS_SESSION_DOMAIN}${sessionId}`).digest('hex'));
  });

  /** A caller cannot choose what is stored: hand the route a digest and it is hashed, or rejected. */
  it('cannot be supplied by the caller', async () => {
    const recorded = await start();
    const digest = 'ab'.repeat(32);
    // Not a value this server issues, so it is treated as no session at all.
    expect((await post({ events: [event()], sessionId: digest })).status).toBe(202);
    expect(onlyRow(recorded)['session_hash']).toBeNull();
    // And there is no field for a digest, so it cannot be named directly either.
    expect((await post({ events: [event()], sessionHash: digest })).status).toBe(400);
  });

  it('is null when the browser has no session, which a batch still does not need', async () => {
    const recorded = await start();
    expect((await post({ events: [event()] })).status).toBe(202);
    expect(onlyRow(recorded)['session_hash']).toBeNull();
    await app!.close();
    app = undefined;

    const explicit = await start();
    expect((await post({ events: [event()], sessionId: null })).status).toBe(202);
    expect(onlyRow(explicit)['session_hash']).toBeNull();
  });

  it('is shared by every event in one batch, because a batch is one visit', async () => {
    const recorded = await start();
    const sessionId = newAnalyticsSessionId();
    await post({ events: [event(), event({ eventId: uuid(2) })], sessionId });
    const rows = recorded.published[0]!;
    expect(rows).toHaveLength(2);
    expect(rows[0]!['session_hash']).toBe(rows[1]!['session_hash']);
    expect(rows[0]!['session_hash']).toBe(analyticsSessionHash(KEY, sessionId));
  });
});

describe('the batch', () => {
  it('accepts the approved ceiling of fifty', async () => {
    const recorded = await start();
    const events = Array.from({ length: 50 }, (_, index) => event({ eventId: uuid(index + 1) }));
    const result = await post({ events });
    expect(result.status).toBe(202);
    expect(result.body).toEqual({ accepted: 50 });
    expect(recorded.published[0]).toHaveLength(50);
  });

  /** Whole, not truncated: a client that oversends must learn that it did. */
  it('refuses fifty-one entirely, writing nothing', async () => {
    const recorded = await start();
    const events = Array.from({ length: 51 }, (_, index) => event({ eventId: uuid(index + 1) }));
    const result = await post({ events });
    expect(result.status).toBe(400);
    expect(result.body['code']).toBe('VALIDATION_FAILED');
    expect(recorded.published).toEqual([]);
    expect(recorded.stored).toEqual([]);
  });

  it('refuses an empty batch and a body that is not a batch', async () => {
    const recorded = await start();
    for (const payload of [{ events: [] }, {}, { events: 'click' }, { events: [{}] }, [], 'click', null]) {
      expect((await post(payload)).status, JSON.stringify(payload)).toBe(400);
    }
    expect(recorded.published).toEqual([]);
  });

  it('refuses a malformed body rather than treating it as empty', async () => {
    await start();
    const response = await app!.inject({
      method: 'POST',
      url: '/v1/track',
      headers: {
        'content-type': 'application/json',
        [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL,
      },
      payload: '{"events":[',
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses one bad event among good ones, so nothing is partially accepted', async () => {
    const recorded = await start();
    const result = await post({
      events: [event(), event({ eventId: uuid(2), eventType: 'impression' }), event({ eventId: uuid(3) })],
    });
    expect(result.status).toBe(400);
    expect(recorded.published).toEqual([]);
    expect(recorded.stored).toEqual([]);
  });
});

describe('what an event may say', () => {
  /** Owner decision 2. 0013's constraint permits both; the definitions are a Phase 9 decision. */
  it('refuses impression and view, which the database would otherwise store', async () => {
    await start();
    for (const eventType of ['impression', 'view']) {
      expect((await post({ events: [event({ eventType })] })).status, eventType).toBe(400);
    }
  });

  it('accepts each of the four this increment ingests', async () => {
    const recorded = await start();
    for (const eventType of ['click', 'contact', 'favorite', 'share']) {
      expect((await post({ events: [event({ eventType })] })).status, eventType).toBe(202);
    }
    expect(recorded.published.map((batch) => batch[0]!['event_type'])).toEqual([
      'click',
      'contact',
      'favorite',
      'share',
    ]);
  });

  it('carries the source, referrer host and promotion through unchanged', async () => {
    const recorded = await start();
    await post({
      events: [event({ source: 'search', referrerHost: 'example.test', promotionId: uuid(9) })],
    });
    const row = onlyRow(recorded);
    expect(row['source']).toBe('search');
    expect(row['referrer_host']).toBe('example.test');
    expect(row['promotion_id']).toBe(uuid(9));
  });

  it('leaves the optional columns null rather than inventing values', async () => {
    const recorded = await start();
    await post({ events: [event()] });
    const row = onlyRow(recorded);
    expect(row['source']).toBeNull();
    expect(row['referrer_host']).toBeNull();
    expect(row['promotion_id']).toBeNull();
  });

  /** The seller of a listing is a fact the database holds; a browser is not asked to assert it. */
  it('never carries a seller, in the row or in the request', async () => {
    const recorded = await start();
    await post({ events: [event()] });
    expect(Object.keys(onlyRow(recorded))).not.toContain('seller_user_id');
    expect((await post({ events: [event({ sellerUserId: ACCOUNT })] })).status).toBe(400);
  });

  it('keeps a timestamp from the recent past, which is what batching produces', async () => {
    const recorded = await start();
    const occurredAt = new Date(Date.now() - 30_000).toISOString();
    await post({ events: [event({ occurredAt })] });
    expect(onlyRow(recorded)['occurred_at']).toBe(occurredAt);
  });

  /**
   * Clamped rather than refused: one odd timestamp must not cost a batch of otherwise good events, and
   * both directions would otherwise target a partition that does not exist — the future's is not created
   * yet, and the distant past's has been dropped by retention.
   */
  it('clamps a future timestamp and a very old one to now', async () => {
    const recorded = await start();
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const ancient = new Date(Date.now() - LISTING_EVENT_BACKDATE_LIMIT_MS - 60_000).toISOString();
    const before = Date.now();
    await post({ events: [event({ occurredAt: future }), event({ eventId: uuid(2), occurredAt: ancient })] });
    const after = Date.now();

    for (const row of recorded.published[0]!) {
      const at = Date.parse(row['occurred_at'] as string);
      expect(at).toBeGreaterThanOrEqual(before - 1_000);
      expect(at).toBeLessThanOrEqual(after + 1_000);
    }
  });

  it('supplies a timestamp when the event has none', async () => {
    const recorded = await start();
    await post({ events: [event()] });
    expect(Date.parse(onlyRow(recorded)['occurred_at'] as string)).toBeGreaterThan(0);
  });
});

describe('the rate limit', () => {
  /** Owner decision 5: both approved buckets, counted on every request. */
  it('counts the per-minute bucket and the burst bucket on every request', async () => {
    const recorded = await start();
    await post({ events: [event()] });
    expect(recorded.counted.map((entry) => entry.bucket)).toEqual([
      TRACK_THROTTLE_BUCKETS.ip.name,
      TRACK_THROTTLE_BUCKETS.ipBurst.name,
    ]);
    expect(recorded.counted[0]).toMatchObject({ windowSeconds: 60, limit: 30 });
    expect(recorded.counted[1]).toMatchObject({ windowSeconds: 10, limit: 10 });
  });

  it('counts a digest of the address, never the address itself', async () => {
    const recorded = await start();
    await post({ events: [event()] });
    for (const entry of recorded.counted) {
      expect(entry.subject).toMatch(/^[0-9a-f]{64}$/);
      expect(Buffer.from(entry.subject, 'hex')).toHaveLength(32);
      expect(entry.subject).not.toContain('127.0.0.1');
    }
  });

  it('refuses with 429 when the per-minute bucket is over', async () => {
    const recorded = await start({ redisCounter: 'refuse' });
    const result = await post({ events: [event()] });
    expect(result.status).toBe(429);
    expect(result.body['code']).toBe('TOO_MANY_REQUESTS');
    expect(recorded.published).toEqual([]);
    expect(recorded.stored).toEqual([]);
  });

  /** Both buckets are counted even once one has refused, so a burst cannot shelter the minute count. */
  it('counts both buckets even when the first has already refused', async () => {
    const recorded = await start({ redisCounter: 'refuse' });
    await post({ events: [event()] });
    expect(recorded.counted).toHaveLength(2);
  });

  it('falls back to the durable counter when Redis cannot answer', async () => {
    const recorded = await start({ redisCounter: 'throw', durableCounter: 'allow' });
    expect((await post({ events: [event()] })).status).toBe(202);
    // Two buckets, each asked of Redis and then of the durable counter.
    expect(recorded.counted).toHaveLength(4);
  });

  it('uses the durable counter when no Redis counter is configured at all', async () => {
    const recorded = await start({ redisCounter: 'absent' });
    expect((await post({ events: [event()] })).status).toBe(202);
    expect(recorded.counted).toHaveLength(2);
  });

  /**
   * The security property. An attacker who can take both counters down must not thereby remove the limit,
   * so a counter that cannot be read is never read as zero.
   */
  it('fails closed with 429 when neither counter can answer', async () => {
    const recorded = await start({ redisCounter: 'throw', durableCounter: 'throw' });
    const result = await post({ events: [event()] });
    expect(result.status).toBe(429);
    expect(recorded.published).toEqual([]);
    expect(recorded.stored).toEqual([]);
  });

  it('fails closed when Redis is absent and the durable counter cannot answer', async () => {
    const recorded = await start({ redisCounter: 'absent', durableCounter: 'throw' });
    expect((await post({ events: [event()] })).status).toBe(429);
    expect(recorded.stored).toEqual([]);
  });

  it('refuses before the account is resolved, so a flood costs no provider calls', async () => {
    const recorded = await start({ redisCounter: 'refuse' });
    expect((await post({ events: [event()] }, { token: TOKEN })).status).toBe(429);
    expect(recorded.tokens).toEqual([]);
  });
});

describe('the two ingestion paths', () => {
  /** O-21: the stream absorbs the burst, so it is tried first and the database is left alone. */
  it('publishes to the stream and does not touch the database', async () => {
    const recorded = await start();
    expect((await post({ events: [event()] })).status).toBe(202);
    expect(recorded.published).toHaveLength(1);
    expect(recorded.stored).toEqual([]);
  });

  /** The approved fallback. Durable, so this is a change of route rather than an incident. */
  it('writes directly to the database when the stream refuses the batch', async () => {
    const recorded = await start({ streamThrows: true });
    const result = await post({ events: [event()] });
    expect(result.status).toBe(202);
    expect(result.body).toEqual({ accepted: 1 });
    expect(recorded.published).toEqual([]);
    expect(recorded.stored).toHaveLength(1);
  });

  it('writes directly when no stream is configured, with the same rows', async () => {
    const recorded = await start({ noStream: true });
    expect((await post({ events: [event()] })).status).toBe(202);
    expect(recorded.stored).toHaveLength(1);
    expect(onlyRow(recorded)['event_id']).toBe(uuid(1));
  });

  /**
   * A 503, not a silent success. A client told its events were accepted will not retry, and the events
   * cannot be backfilled from anywhere.
   */
  it('answers 503 when neither path can take the batch', async () => {
    await start({ streamThrows: true, storeThrows: true });
    const result = await post({ events: [event()] });
    expect(result.status).toBe(503);
    expect(result.body['code']).toBe('SERVICE_UNAVAILABLE');
  });

  it('answers 503 when there is no stream and the database is unavailable', async () => {
    await start({ noStream: true, storeThrows: true });
    expect((await post({ events: [event()] })).status).toBe(503);
  });

  it('hands both paths the same row shape, in the keys the database writer reads', async () => {
    const streamed = await start();
    const sessionId = newAnalyticsSessionId();
    await post({ events: [event({ source: 'listing' })], sessionId });
    const fromStream = onlyRow(streamed);
    await app!.close();
    app = undefined;

    const direct = await start({ streamThrows: true });
    await post({ events: [event({ source: 'listing' })], sessionId });
    const fromStore = onlyRow(direct);

    expect(Object.keys(fromStream).sort()).toEqual([
      'event_id',
      'event_type',
      'listing_id',
      'occurred_at',
      'promotion_id',
      'referrer_host',
      'session_hash',
      'source',
      'user_id',
    ]);
    expect(Object.keys(fromStore).sort()).toEqual(Object.keys(fromStream).sort());
    expect(fromStore['session_hash']).toBe(fromStream['session_hash']);
  });
});

describe('de-duplication', () => {
  /**
   * The event identifier is the idempotency key and is passed through untouched. That is what makes the
   * at-least-once delivery of both paths safe: 0013's writer de-duplicates on it, so a retried batch
   * inserts nothing the second time.
   */
  it('passes the client identifier through as the de-duplication key', async () => {
    const recorded = await start({ noStream: true });
    await post({ events: [event({ eventId: uuid(7) })] });
    expect(onlyRow(recorded)['event_id']).toBe(uuid(7));
  });

  it('accepts a resent batch, leaving the duplicate to the database', async () => {
    const recorded = await start({ noStream: true, storeWrites: 0 });
    const batch = { events: [event({ eventId: uuid(7) })] };
    expect((await post(batch)).status).toBe(202);
    expect((await post(batch)).status).toBe(202);
    expect(recorded.stored).toHaveLength(2);
    expect(recorded.stored[0]![0]!['event_id']).toBe(recorded.stored[1]![0]!['event_id']);
  });

  /**
   * The re-stamping this layer performs, and why the de-duplication key had to move.
   *
   * `occurredAt` is replaced by a fresh server `now()` whenever the client's value is **missing, unparseable,
   * in the future, or older than seven days** — four of the five input cases. So two deliveries of one event
   * reach the writer with two different `occurred_at` values, and the `(event_id, occurred_at)` index that was
   * supposed to de-duplicate them matched nothing. 0107 moved the guarantee onto `event_id` alone.
   *
   * This asserts the cause from this side: the timestamp differs between deliveries while the identifier does
   * not. The database half — that the same `event_id` yields one row whatever the timestamp — is proved in
   * `supabase/tests/0107_analytics_event_identity.test.sql`, against a real table.
   */
  /**
   * The unparseable case is **not** reachable here, and that is worth stating rather than assuming.
   *
   * `occurredAt` is `z.string().datetime()`, so a value this layer cannot parse is refused with 400 before
   * `ListingEventIngestionService.occurredAt` is ever called. Its `Number.isFinite` branch is defensive depth
   * for a non-HTTP caller, not a path a request can take — which is why it is asserted here as a refusal and
   * excluded from the re-stamping cases below.
   */
  it('refuses an unparseable occurredAt outright, so that branch is not a reachable re-stamp', async () => {
    const recorded = await start({ noStream: true });
    for (const occurredAt of ['not-a-timestamp', '2026-13-45', '', 'yesterday']) {
      expect((await post({ events: [event({ occurredAt })] })).status, occurredAt).toBe(400);
    }
    expect(recorded.stored).toHaveLength(0);
  });

  it.each([
    ['missing', undefined],
    ['in the future', new Date(Date.now() + 60_000).toISOString()],
    ['older than the backdate window', new Date(Date.now() - 8 * 86_400_000).toISOString()],
  ])('re-stamps an occurredAt that is %s, keeping the identifier it is deduplicated on', async (_label, occurredAt) => {
    const recorded = await start({ noStream: true, storeWrites: 0 });
    const one = event({ eventId: uuid(8), ...(occurredAt === undefined ? {} : { occurredAt }) });

    expect((await post({ events: [one] })).status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await post({ events: [one] })).status).toBe(202);

    const first = recorded.stored[0]![0]!;
    const second = recorded.stored[1]![0]!;

    // The identifier survives both deliveries, which is the only thing the ledger needs.
    expect(first['event_id']).toBe(uuid(8));
    expect(second['event_id']).toBe(uuid(8));

    // And the timestamp does not, which is why it could never have carried the guarantee. Not asserted as
    // "differs" by luck: the supplied value is one this layer is documented to discard.
    expect(first['occurred_at']).not.toBe(second['occurred_at']);
    if (occurredAt !== undefined) {
      expect(first['occurred_at']).not.toBe(new Date(occurredAt).toISOString());
    }
  });

  it('keeps an occurredAt it has no reason to discard, so a compliant retry is identical', async () => {
    const recorded = await start({ noStream: true, storeWrites: 0 });
    const occurredAt = new Date(Date.now() - 3_600_000).toISOString();
    const one = event({ eventId: uuid(9), occurredAt });

    expect((await post({ events: [one] })).status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await post({ events: [one] })).status).toBe(202);

    expect(recorded.stored[0]![0]!['occurred_at']).toBe(occurredAt);
    expect(recorded.stored[1]![0]!['occurred_at']).toBe(occurredAt);
  });

  it('refuses a batch whose identifiers are not identifiers', async () => {
    await start();
    for (const eventId of ['', 'not-a-uuid', uuid(1).slice(0, -1), 42, null]) {
      expect((await post({ events: [event({ eventId })] })).status, JSON.stringify(eventId)).toBe(400);
    }
  });
});
