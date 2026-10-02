import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  ModerateReviewResponseSchema,
  REVIEW_MODERATION_HISTORY_LIMIT,
  REVIEW_MODERATION_MAX_LIMIT,
  ReviewDetailResponseSchema,
  ReviewModerationActionsResponseSchema,
  ReviewQueueResponseSchema,
  SESSION_TOKEN_HEADER,
} from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { AuthenticationRequiredError } from '../src/auth/auth-errors.js';
import { REVIEW_MODERATION_STORE } from '../src/admin/review-moderation.service.js';
import { encodeReviewQueueCursor } from '../src/admin/review-moderation.cursor.js';
import { SUPABASE_AUTH_CLIENT } from '../src/auth/login.service.js';
import { STAFF_CONSOLE_STORE, type StaffConsoleRow } from '../src/admin/staff-console.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * Review moderation at the API boundary (Phase 7-P).
 *
 * The properties this suite exists for:
 *
 * **Each route requires exactly one key, and the right one.** The three are deliberately not held together
 * and two of them are easy to confuse: the queue and one review need `reviews.review.read`, the decision
 * needs `reviews.review.moderate`, and the trail needs `moderation.action.read` — 0027's own key, which is
 * neither review key. Every operation is driven by a caller holding each key in turn, and each refuses every
 * key but its own.
 *
 * **The assurance level is read from the validated token, not from the request.** A caller whose token is not
 * `aal2` reaches nothing, because every role holding a review key requires MFA and 0068 therefore reports an
 * empty effective set — which is what makes the permission test the assurance test.
 *
 * **Nothing about authority is accepted from a browser.** Every attempt to name a moderator, a time, an
 * automatic hiding reason, a publication time, a rating or a reply is refused by the strict schema, and the
 * store is asked with the token's own account every time.
 *
 * **A refusal says nothing about existence.** A review a caller may not read and one that is not there
 * produce the same status, code and body, compared byte for byte.
 *
 * **Every outcome the database can return maps to one approved answer**, including 0026's refusal of a
 * moderator who is a party to the review, and an outcome this service does not understand becomes a 503
 * rather than a success.
 *
 * **There is no route that moderates a reply.** Asserted by driving the addresses one would have, because a
 * reported capability gap should fail loudly if somebody later fills it without an owner decision.
 *
 * Everything is stubbed at the store boundary: no database, no Redis, no network.
 */

const STAFF = '11111111-1111-4111-8111-111111111111';

/** An unsigned token whose claims can be read, which is all `isAal2` does with one it has been handed. */
function token(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.c2lnbmF0dXJl`;
}

const ACCESS_TOKEN = token({ sub: STAFF, aal: 'aal2' });
const AAL1_TOKEN = token({ sub: STAFF, aal: 'aal1' });
const REVIEW = 'a9000000-0000-4000-8000-000000000001';

const READ = 'reviews.review.read';
const MODERATE = 'reviews.review.moderate';
const ACTIONS = 'moderation.action.read';
const ALL_KEYS = [READ, MODERATE, ACTIONS] as const;

const QUEUE_ROW = {
  id: REVIEW,
  rating: 2,
  title: 'Late and damaged',
  status: 'published',
  hasBody: true,
  autoHiddenReason: null,
  isModerated: false,
  moderatedByMe: false,
  isParty: false,
  sellerSlug: 'a-shop',
  sellerDisplayName: 'A Shop',
  hasReply: true,
  replyStatus: 'published',
  createdAt: new Date('2026-05-01T09:00:00.000Z'),
};

const DETAIL_ROW = {
  outcome: 'found',
  id: REVIEW,
  rating: 2,
  title: 'Late and damaged',
  body: 'It arrived a week late.',
  status: 'published',
  autoHiddenReason: null,
  moderationReason: null,
  moderatedAt: null,
  moderatedByMe: false,
  isParty: false,
  canModerate: true,
  publicationBlock: 'order_refunded',
  sellerSlug: 'a-shop',
  sellerDisplayName: 'A Shop',
  sellerStatus: 'active',
  replyBody: 'We are sorry.',
  replyStatus: 'published',
  replyModerationReason: null,
  replyCreatedAt: new Date('2026-05-02T09:00:00.000Z'),
  createdAt: new Date('2026-05-01T09:00:00.000Z'),
  updatedAt: new Date('2026-05-01T09:00:00.000Z'),
};

const ACTION_ROW = {
  id: 'b9000000-0000-4000-8000-000000000001',
  action: 'hide',
  reason: 'Names another buyer.',
  notes: null,
  reportId: null,
  isOwnAction: false,
  createdAt: new Date('2026-05-03T09:00:00.000Z'),
};

interface Seen {
  readonly name: string;
  readonly input: Record<string, unknown>;
}

interface Doubles {
  readonly permissions?: readonly string[];
  readonly detailOutcome?: string;
  readonly writeOutcome?: string;
  readonly storeThrows?: boolean;
  readonly unauthenticated?: boolean;
  readonly queueRows?: readonly unknown[];
  readonly actionRows?: readonly unknown[];
}

let app: NestFastifyApplication | undefined;

async function start(doubles: Doubles = {}): Promise<Seen[]> {
  const seen: Seen[] = [];
  const note = (name: string) => (input: Record<string, unknown>) => {
    seen.push({ name, input });
    if (doubles.storeThrows === true) throw new Error('database unavailable');
    return undefined;
  };

  const store = {
    reviewQueueForStaff: async (input: Record<string, unknown>) => {
      note('queue')(input);
      return doubles.queueRows ?? [QUEUE_ROW];
    },
    reviewForStaff: async (input: Record<string, unknown>) => {
      note('detail')(input);
      const outcome = doubles.detailOutcome ?? 'found';
      return outcome === 'found' ? DETAIL_ROW : { ...DETAIL_ROW, outcome, id: null };
    },
    reviewModerationActions: async (input: Record<string, unknown>) => {
      note('actions')(input);
      return doubles.actionRows ?? [ACTION_ROW];
    },
    reviewModerateForStaff: async (input: Record<string, unknown>) => {
      note('moderate')(input);
      const outcome = doubles.writeOutcome ?? 'moderated';
      return { outcome, status: outcome === 'moderated' ? 'hidden' : null };
    },
  };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(TEST_ENV)] })
    .overrideProvider(SUPABASE_AUTH_CLIENT)
    .useValue({
      getUser: async () => {
        if (doubles.unauthenticated === true) throw new AuthenticationRequiredError();
        return { id: STAFF, phone: null };
      },
      signInWithPassword: async () => {
        throw new Error('moderating must never sign anyone in');
      },
      revokeAllSessions: async () => {
        throw new Error('moderating a review must never revoke a session');
      },
    })
    .overrideProvider(STAFF_CONSOLE_STORE)
    .useValue({
      staffConsoleAccess: async (input: { userId: string; isAal2: boolean }): Promise<StaffConsoleRow> => {
        seen.push({ name: 'console-access', input });
        // 0068's own behaviour, modelled rather than asserted around: a role that requires MFA counts for
        // nothing at aal1, so the effective set is empty. All three roles holding a review key require MFA,
        // which is why an aal1 caller is refused without any separate assurance test in the service.
        const granted = [...(doubles.permissions ?? ALL_KEYS)];
        return {
          hasConsoleRole: true,
          requiresStepUp: false,
          roles: ['moderator'],
          permissions: input.isAal2 ? granted : [],
        };
      },
      buyerProfile: async (userId: string) => ({ id: userId, displayName: 'Nadia', localeCode: 'en' }),
    })
    .overrideProvider(REVIEW_MODERATION_STORE)
    .useValue(store)
    .compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(
    createFastifyAdapter(TEST_ENV, { logStream: { write: () => undefined } }),
    NEST_APP_OPTIONS,
  );
  await configureApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return seen;
}

interface Result {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly raw: string;
}

async function call(
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH',
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<Result> {
  const response = await app!.inject({
    method,
    url: `/v1/admin${path}`,
    headers: {
      [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL,
      [SESSION_TOKEN_HEADER]: ACCESS_TOKEN,
      ...options.headers,
    },
    ...(options.body === undefined ? {} : { payload: options.body as never }),
  });
  return {
    status: response.statusCode,
    body: response.body.length > 0 ? (JSON.parse(response.body) as Record<string, unknown>) : {},
    raw: response.body,
  };
}

const DECISION = { status: 'hidden', reason: 'Names another buyer.' } as const;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/* ------------------------------------------------------------------------------------------------ */

describe('the shapes the contracts promise', () => {
  it('answers every operation with a body its own schema accepts', async () => {
    await start();

    expect(ReviewQueueResponseSchema.safeParse((await call('GET', '/reviews')).body).success).toBe(true);
    expect(
      ReviewDetailResponseSchema.safeParse((await call('GET', `/reviews/${REVIEW}`)).body).success,
    ).toBe(true);
    expect(
      ReviewModerationActionsResponseSchema.safeParse(
        (await call('GET', `/reviews/${REVIEW}/actions`)).body,
      ).success,
    ).toBe(true);
    expect(
      ModerateReviewResponseSchema.safeParse(
        (await call('POST', `/reviews/${REVIEW}/moderation`, { body: DECISION })).body,
      ).success,
    ).toBe(true);
  });

  it('returns the status the writer reached rather than the one asked for', async () => {
    await start();
    const result = await call('POST', `/reviews/${REVIEW}/moderation`, {
      body: { status: 'removed', reason: 'Names another buyer.' },
    });

    // The double's writer lands on `hidden`. The response carries what the database reached, because the
    // writer is what decides and a body echoing the request would be the console's own guess.
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ outcome: 'moderated', status: 'hidden' });
  });

  it('names nobody: no buyer, no seller account, no colleague and no order', async () => {
    await start();
    const queue = (await call('GET', '/reviews')).raw;
    const detail = (await call('GET', `/reviews/${REVIEW}`)).raw;
    const actions = (await call('GET', `/reviews/${REVIEW}/actions`)).raw;

    for (const raw of [queue, detail, actions]) {
      // Named as the whole JSON key each would be, because `moderatedBy` is a prefix of the capability
      // `moderatedByMe` that legitimately *is* there — a bare substring would assert the wrong property.
      for (const forbidden of [
        'buyerUserId',
        'sellerUserId',
        'moderatedBy',
        'moderatorUserId',
        'orderId',
        'buyer_user_id',
        'seller_user_id',
        'order_id',
      ]) {
        expect(raw, forbidden).not.toContain(`"${forbidden}":`);
      }
    }
    // What replaces them: the reader's own relationship, and the storefront's public handle.
    expect(detail).toContain('moderatedByMe');
    expect(detail).toContain('isParty');
    expect(detail).toContain('sellerSlug');
    expect(actions).toContain('isOwnAction');
  });

  it('reports the capability rather than the permission', async () => {
    await start();
    const raw = (await call('GET', `/reviews/${REVIEW}`)).raw;

    expect(raw).toContain('canModerate');
    // The key itself never crosses. A screen that received it could compose its own authorization rule.
    expect(raw).not.toContain(MODERATE);
    expect(raw).not.toContain(READ);
    expect(raw).not.toContain('permission');
  });
});

describe('each route requires exactly one key, and it is the right one', () => {
  it('reads the queue and one review on the read key alone', async () => {
    await start({ permissions: [READ] });

    expect((await call('GET', '/reviews')).status).toBe(200);
    expect((await call('GET', `/reviews/${REVIEW}`)).status).toBe(200);
    // Not the trail, which is 0027's key, and not the decision.
    expect((await call('GET', `/reviews/${REVIEW}/actions`)).status).toBe(404);
    expect(
      (await call('POST', `/reviews/${REVIEW}/moderation`, { body: DECISION })).status,
    ).toBe(404);
  });

  it('records a decision on the moderate key alone, and reads nothing with it', async () => {
    await start({ permissions: [MODERATE] });

    expect(
      (await call('POST', `/reviews/${REVIEW}/moderation`, { body: DECISION })).status,
    ).toBe(200);
    expect((await call('GET', '/reviews')).status).toBe(404);
    expect((await call('GET', `/reviews/${REVIEW}`)).status).toBe(404);
    expect((await call('GET', `/reviews/${REVIEW}/actions`)).status).toBe(404);
  });

  it('reads the trail on 0027’s key alone, which is neither review key', async () => {
    await start({ permissions: [ACTIONS] });

    expect((await call('GET', `/reviews/${REVIEW}/actions`)).status).toBe(200);
    expect((await call('GET', '/reviews')).status).toBe(404);
    expect((await call('GET', `/reviews/${REVIEW}`)).status).toBe(404);
    expect(
      (await call('POST', `/reviews/${REVIEW}/moderation`, { body: DECISION })).status,
    ).toBe(404);
  });

  it('refuses everything to a colleague holding neither review key nor 0027’s', async () => {
    await start({ permissions: ['support.ticket.read', 'sellers.profile.read', 'users.profile.read'] });

    for (const path of ['/reviews', `/reviews/${REVIEW}`, `/reviews/${REVIEW}/actions`]) {
      expect((await call('GET', path)).status, path).toBe(404);
    }
    expect(
      (await call('POST', `/reviews/${REVIEW}/moderation`, { body: DECISION })).status,
    ).toBe(404);
  });

  it('never consults the store for a caller who does not hold the key', async () => {
    const seen = await start({ permissions: [] });
    await call('GET', '/reviews');
    await call('GET', `/reviews/${REVIEW}`);
    await call('GET', `/reviews/${REVIEW}/actions`);
    await call('POST', `/reviews/${REVIEW}/moderation`, { body: DECISION });

    // The permission test is the first thing that happens, so a refused caller costs no read at all.
    expect(seen.filter((entry) => entry.name !== 'console-access')).toHaveLength(0);
  });
});

describe('the assurance level comes from the validated token', () => {
  it('refuses a caller at aal1 on every route', async () => {
    await start();
    const headers = { [SESSION_TOKEN_HEADER]: AAL1_TOKEN };

    for (const path of ['/reviews', `/reviews/${REVIEW}`, `/reviews/${REVIEW}/actions`]) {
      expect((await call('GET', path, { headers })).status, path).toBe(404);
    }
    expect(
      (await call('POST', `/reviews/${REVIEW}/moderation`, { body: DECISION, headers })).status,
    ).toBe(404);
  });

  it('asks the database with the assurance level it read, never one a request claimed', async () => {
    const seen = await start();
    await call('GET', '/reviews');
    await call('GET', '/reviews', { headers: { [SESSION_TOKEN_HEADER]: AAL1_TOKEN } });

    const access = seen.filter((entry) => entry.name === 'console-access');
    expect(access[0]?.input).toEqual({ userId: STAFF, isAal2: true });
    expect(access[1]?.input).toEqual({ userId: STAFF, isAal2: false });
  });

  it('passes the caller’s own account and assurance level to every reader', async () => {
    const seen = await start();
    await call('GET', '/reviews');
    await call('GET', `/reviews/${REVIEW}`);
    await call('GET', `/reviews/${REVIEW}/actions`);
    await call('POST', `/reviews/${REVIEW}/moderation`, { body: DECISION });

    for (const entry of seen.filter((item) => item.name !== 'console-access')) {
      expect(entry.input['userId'], entry.name).toBe(STAFF);
      expect(entry.input['isAal2'], entry.name).toBe(true);
    }
  });

  it('refuses a request with no session at all', async () => {
    await start();
    const response = await app!.inject({
      method: 'GET',
      url: '/v1/admin/reviews',
      headers: { [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL },
    });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a session the provider will not vouch for', async () => {
    await start({ unauthenticated: true });
    expect((await call('GET', '/reviews')).status).toBe(401);
  });
});

describe('nothing about authority is accepted from a browser', () => {
  it('refuses a body naming a moderator, a time, a publication or the automation', async () => {
    await start();
    for (const extra of [
      { moderatorUserId: STAFF },
      { moderatedBy: STAFF },
      { moderatedAt: '2026-05-05T09:00:00.000Z' },
      { publishedAt: '2026-05-05T09:00:00.000Z' },
      { autoHiddenReason: 'order_refunded' },
      { isParty: false },
      { canModerate: true },
      { permission: MODERATE },
      { aal: 'aal2' },
      { isAal2: true },
    ]) {
      const result = await call('POST', `/reviews/${REVIEW}/moderation`, {
        body: { ...DECISION, ...extra },
      });
      expect(result.status, JSON.stringify(extra)).toBe(400);
    }
  });

  it('refuses a body reaching for the review itself, the reply or the order', async () => {
    await start();
    for (const extra of [
      { rating: 5 },
      { title: 'Something else' },
      { body: 'Rewritten.' },
      { replyStatus: 'hidden' },
      { replyBody: 'Rewritten.' },
      { replyModerationReason: 'Abusive.' },
      { orderId: 'a9000000-0000-4000-8000-000000000009' },
      { reviewId: REVIEW },
    ]) {
      const result = await call('POST', `/reviews/${REVIEW}/moderation`, {
        body: { ...DECISION, ...extra },
      });
      expect(result.status, JSON.stringify(extra)).toBe(400);
    }
  });

  it('requires a reason on every decision, including one that re-affirms the current state', async () => {
    await start();
    for (const body of [
      { status: 'published' },
      { status: 'published', reason: '' },
      { status: 'published', reason: '   ' },
      { status: 'hidden', reason: null },
    ]) {
      expect((await call('POST', `/reviews/${REVIEW}/moderation`, { body })).status).toBe(400);
    }
  });

  it('accepts only 0026’s four statuses', async () => {
    await start();
    for (const status of ['approved', 'deleted', 'pending', 'PUBLISHED', '', 'published ']) {
      const result = await call('POST', `/reviews/${REVIEW}/moderation`, {
        body: { status, reason: 'Because.' },
      });
      expect(result.status, status).toBe(400);
    }
    for (const status of ['published', 'pending_moderation', 'hidden', 'removed']) {
      const result = await call('POST', `/reviews/${REVIEW}/moderation`, {
        body: { status, reason: 'Because.' },
      });
      expect(result.status, status).toBe(200);
    }
  });

  it('sends the writer the trimmed reason and nothing else', async () => {
    const seen = await start();
    await call('POST', `/reviews/${REVIEW}/moderation`, {
      body: { status: 'removed', reason: '  Names another buyer.  ' },
    });

    const write = seen.find((entry) => entry.name === 'moderate');
    expect(write?.input).toEqual({
      userId: STAFF,
      isAal2: true,
      reviewId: REVIEW,
      status: 'removed',
      reason: 'Names another buyer.',
    });
  });

  it('refuses a review identifier that is not one', async () => {
    await start();
    for (const value of ['not-a-uuid', '1', `${REVIEW}x`, 'null']) {
      expect((await call('GET', `/reviews/${value}`)).status, value).toBe(400);
      expect((await call('GET', `/reviews/${value}/actions`)).status, value).toBe(400);
      expect(
        (await call('POST', `/reviews/${value}/moderation`, { body: DECISION })).status,
        value,
      ).toBe(400);
    }
  });
});

describe('a refusal says nothing about existence', () => {
  it('answers a missing review and a missing permission identically, byte for byte', async () => {
    await start({ detailOutcome: 'not_found' });
    const absent = await call('GET', `/reviews/${REVIEW}`);
    await app?.close();
    app = undefined;

    await start({ permissions: [] });
    const unauthorized = await call('GET', `/reviews/${REVIEW}`);

    expect(absent.status).toBe(404);
    expect(unauthorized.status).toBe(404);
    expect(absent.raw).toBe(unauthorized.raw);
  });

  it('answers a caller at aal1 with the same body as an absent review', async () => {
    await start({ detailOutcome: 'not_found' });
    const absent = await call('GET', `/reviews/${REVIEW}`);
    const aal1 = await call('GET', `/reviews/${REVIEW}`, {
      headers: { [SESSION_TOKEN_HEADER]: AAL1_TOKEN },
    });

    expect(absent.raw).toBe(aal1.raw);
  });

  it('never answers 403 on any of the four', async () => {
    await start({ permissions: [] });
    for (const path of ['/reviews', `/reviews/${REVIEW}`, `/reviews/${REVIEW}/actions`]) {
      expect((await call('GET', path)).status, path).not.toBe(403);
    }
    expect(
      (await call('POST', `/reviews/${REVIEW}/moderation`, { body: DECISION })).status,
    ).not.toBe(403);
  });

  it('answers an empty trail exactly as a review nobody has acted on', async () => {
    await start({ actionRows: [] });
    const empty = await call('GET', `/reviews/${REVIEW}/actions`);

    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ items: [] });
  });
});

describe('every outcome the database can return maps to one approved answer', () => {
  it('refuses a moderator who is a party to the review, and says why', async () => {
    await start({ writeOutcome: 'is_party' });
    const result = await call('POST', `/reviews/${REVIEW}/moderation`, { body: DECISION });

    expect(result.status).toBe(409);
    expect(result.body['code']).toBe('REVIEW_IS_PARTY');
    // The refusal concerns only the caller's own relationship to a review they are already reading, so
    // naming it discloses nothing — and it is what tells them a colleague has to take this one.
    expect(result.body['detail']).toBe('Nobody moderates a review they are a party to.');
  });

  it('maps a reason the database refused to its own code', async () => {
    await start({ writeOutcome: 'reason_required' });
    const result = await call('POST', `/reviews/${REVIEW}/moderation`, { body: DECISION });

    expect(result.status).toBe(409);
    expect(result.body['code']).toBe('REVIEW_REASON_REQUIRED');
  });

  it('maps an unusable request to a validation failure', async () => {
    await start({ writeOutcome: 'invalid' });
    const result = await call('POST', `/reviews/${REVIEW}/moderation`, { body: DECISION });

    expect(result.status).toBe(400);
    expect(result.body['code']).toBe('VALIDATION_FAILED');
  });

  it('maps a review the writer could not find to the neutral answer', async () => {
    await start({ writeOutcome: 'not_found' });
    const result = await call('POST', `/reviews/${REVIEW}/moderation`, { body: DECISION });

    expect(result.status).toBe(404);
    expect(result.body['code']).toBe('NOT_FOUND');
  });

  it('turns an outcome it does not understand into an outage, never a success', async () => {
    await start({ writeOutcome: 'approved' });
    const result = await call('POST', `/reviews/${REVIEW}/moderation`, { body: DECISION });

    expect(result.status).toBe(503);
    expect(result.body['code']).toBe('SERVICE_UNAVAILABLE');
  });

  it('turns a store that throws into an outage on every route', async () => {
    await start({ storeThrows: true });

    for (const path of ['/reviews', `/reviews/${REVIEW}`, `/reviews/${REVIEW}/actions`]) {
      expect((await call('GET', path)).status, path).toBe(503);
    }
    expect(
      (await call('POST', `/reviews/${REVIEW}/moderation`, { body: DECISION })).status,
    ).toBe(503);
  });
});

describe('the queue pages deterministically', () => {
  it('asks for one row more than it will return', async () => {
    const seen = await start();
    await call('GET', '/reviews?limit=5');

    expect(seen.find((entry) => entry.name === 'queue')?.input['limit']).toBe(6);
  });

  it('emits a cursor only when there is another page', async () => {
    const rows = Array.from({ length: 3 }, (_, index) => ({
      ...QUEUE_ROW,
      id: `a9000000-0000-4000-8000-00000000000${index + 1}`,
    }));

    await start({ queueRows: rows });
    const full = await call('GET', '/reviews?limit=2');
    expect((full.body['items'] as unknown[]).length).toBe(2);
    expect(full.body['nextCursor']).toBeTypeOf('string');

    await app?.close();
    app = undefined;
    await start({ queueRows: rows.slice(0, 2) });
    const last = await call('GET', '/reviews?limit=2');
    expect((last.body['items'] as unknown[]).length).toBe(2);
    expect(last.body['nextCursor']).toBeNull();
  });

  it('decodes its own cursor into the position the reader is asked for', async () => {
    const seen = await start();
    const cursor = encodeReviewQueueCursor({
      createdAt: new Date('2026-05-01T09:00:00.000Z'),
      id: REVIEW,
    });
    await call('GET', `/reviews?cursor=${encodeURIComponent(cursor)}`);

    const read = seen.find((entry) => entry.name === 'queue');
    expect((read?.input['cursorCreatedAt'] as Date).toISOString()).toBe('2026-05-01T09:00:00.000Z');
    expect(read?.input['cursorId']).toBe(REVIEW);
  });

  it('refuses a cursor that is not one, and a position from another list', async () => {
    await start();
    const foreign = Buffer.from('sr1|2026-05-01T09:00:00.000Z|' + REVIEW, 'utf8').toString('base64url');
    for (const cursor of ['!!!!', 'abc', foreign, Buffer.from('rv1|x|y').toString('base64url')]) {
      const result = await call('GET', `/reviews?cursor=${encodeURIComponent(cursor)}`);
      expect(result.status, cursor).toBe(400);
      expect(result.body['code']).toBe('VALIDATION_FAILED');
    }
  });

  it('refuses a limit that is not one', async () => {
    await start();
    for (const limit of ['0', '-1', 'ten', '1.5', ' 5', '10000']) {
      expect((await call('GET', `/reviews?limit=${limit}`)).status, limit).toBe(400);
    }
  });

  it('clamps a limit above the maximum instead of refusing it, and defaults without one', async () => {
    const seen = await start();
    // The platform's own bound, applied the same way on every paged surface: a number too large is the
    // maximum rather than an error, and the database clamps again on its own.
    await call('GET', `/reviews?limit=${REVIEW_MODERATION_MAX_LIMIT + 1}`);
    expect(seen.find((entry) => entry.name === 'queue')?.input['limit']).toBe(
      REVIEW_MODERATION_MAX_LIMIT + 1,
    );

    await call('GET', '/reviews');
    expect(seen.filter((entry) => entry.name === 'queue').at(-1)?.input['limit']).toBe(21);
  });

  it('passes an unknown status filter through rather than refusing it', async () => {
    const seen = await start();
    // The database compares it as a parameter, so a stale bookmark shows an empty page rather than an error.
    expect((await call('GET', '/reviews?status=approved')).status).toBe(200);
    expect(seen.find((entry) => entry.name === 'queue')?.input['status']).toBe('approved');
  });

  it('asks the trail for its fixed page', async () => {
    const seen = await start();
    await call('GET', `/reviews/${REVIEW}/actions`);

    expect(seen.find((entry) => entry.name === 'actions')?.input['limit']).toBe(
      REVIEW_MODERATION_HISTORY_LIMIT,
    );
  });
});

describe('the reply has no writer, and no route pretends otherwise', () => {
  it('serves nothing at any address that would moderate a reply', async () => {
    await start();
    for (const path of [
      `/reviews/${REVIEW}/reply`,
      `/reviews/${REVIEW}/reply/moderation`,
      `/reviews/${REVIEW}/replies`,
      `/review-replies/${REVIEW}/moderation`,
    ]) {
      const result = await call('POST', path, { body: DECISION });
      expect(result.status, path).toBe(404);
      expect(result.body['code'], path).toBe('NOT_FOUND');
    }
  });

  it('reads the reply and never writes it', async () => {
    const seen = await start();
    const detail = await call('GET', `/reviews/${REVIEW}`);
    expect((detail.body['review'] as Record<string, unknown>)['replyBody']).toBe('We are sorry.');

    // The store this service is given has four methods and not one of them touches `review_replies`.
    await call('POST', `/reviews/${REVIEW}/moderation`, { body: DECISION });
    for (const entry of seen) {
      expect(JSON.stringify(entry.input)).not.toContain('reply');
    }
  });
});
