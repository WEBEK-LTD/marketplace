import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  JobRunDetailResponseSchema,
  JobRunPageResponseSchema,
  OutboxResponseSchema,
  PLATFORM_DEAD_LETTER_LIMIT,
  PLATFORM_OPS_MAX_LIMIT,
  SESSION_TOKEN_HEADER,
  ScheduleProblemsResponseSchema,
  ScheduledJobCatalogueResponseSchema,
} from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { AuthenticationRequiredError } from '../src/auth/auth-errors.js';
import { PLATFORM_OPERATIONS_STORE } from '../src/admin/platform-operations.service.js';
import { encodeJobRunCursor } from '../src/admin/platform-operations.cursor.js';
import { SUPABASE_AUTH_CLIENT } from '../src/auth/login.service.js';
import { STAFF_CONSOLE_STORE, type StaffConsoleRow } from '../src/admin/staff-console.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * Platform job runs and outbox health at the API boundary (Phase 7-Q).
 *
 * The properties this suite exists for:
 *
 * **Every route requires `platform.job.read`, and it is the narrowest key in the console.** Each of the five is
 * driven by a caller holding it, and by callers holding each of the other admin keys instead — the seller,
 * user, role, security, recovery, audit, review and moderation keys — and every one of those is refused. That
 * matters because Moderator and Support Agent hold none of them in this direction: this is the one section they
 * cannot see any part of.
 *
 * **The assurance level is read from the validated token, not from the request.** A caller whose token is not
 * `aal2` reaches nothing, because both roles holding the key require MFA.
 *
 * **There is no route that writes anything, and that is asserted rather than assumed.** Every verb other than
 * GET is driven against every address, including the ones a retry or cancel control would plausibly live at,
 * and each answers 404. A reported capability gap should fail loudly if somebody later fills it.
 *
 * **The raw error message cannot cross.** The store double returns a `details`-shaped object carrying a canary
 * string in a `message` field, and every response body is searched for it — proving the service reads the row
 * fields it is given and never a blob.
 *
 * **Nothing identifying an outbox event crosses.** The double returns rows carrying an aggregate id and a
 * payload; neither reaches a response.
 *
 * **A refusal says nothing about existence.** A run a caller may not read and one that is not there produce the
 * same status, code and body, compared byte for byte — and so does outbox health, which is the case a row of
 * zeros would have broken.
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
const RUN = 'fc000000-0000-4000-8000-000000000001';

const PLATFORM = 'platform.job.read';

/** Every other key an admin console surface uses. Not one of them opens this section. */
const OTHER_KEYS = [
  'sellers.profile.read',
  'sellers.profile.manage',
  'users.profile.read',
  'users.role.read',
  'users.security.read',
  'security.recovery.review',
  'audit.read',
  'reviews.review.read',
  'reviews.review.moderate',
  'moderation.action.read',
  'moderation.report.read',
  'support.ticket.read',
] as const;

/** The canary: what the job runner stores under `details.message`, which is `left(sqlerrm, 500)`. */
const CANARY_MESSAGE = 'CANARY_SQLERRM_QUOTING_A_ROW_THAT_MUST_NOT_SHIP';
/** And what an outbox row would carry if anything here selected one. */
const CANARY_AGGREGATE = 'CANARY_AGGREGATE_ID';

const RUN_ROW = {
  id: RUN,
  jobName: 'offers.expire',
  status: 'failed',
  scheduledFor: null,
  startedAt: new Date('2026-05-01T09:00:00.000Z'),
  finishedAt: new Date('2026-05-01T09:00:00.120Z'),
  durationMs: '120',
  errorType: 'sqlstate_23514',
  processedCount: null,
  isContracted: true,
  // Not part of the row interface. Present so that a service reaching for a blob would ship it.
  details: { job_key: 'offers.expire', sqlstate: '23514', message: CANARY_MESSAGE },
};

const RUN_DETAIL = {
  outcome: 'found',
  id: RUN,
  jobName: 'offers.expire',
  status: 'failed',
  scheduledFor: null,
  startedAt: new Date('2026-05-01T09:00:00.000Z'),
  finishedAt: new Date('2026-05-01T09:00:00.120Z'),
  durationMs: '120',
  errorType: 'sqlstate_23514',
  errorSqlstate: '23514',
  detailJobKey: 'offers.expire',
  processedCount: null,
  isContracted: true,
  cronSchedule: '*/5 * * * *',
  targetSignature: 'app_private.expire_due_offers(500)',
  purpose: 'closes offers whose window has passed',
  details: { message: CANARY_MESSAGE },
};

const SCHEDULED_JOB = {
  jobKey: 'offers.expire',
  cronSchedule: '*/5 * * * *',
  targetSignature: 'app_private.expire_due_offers(500)',
  purpose: 'closes offers whose window has passed',
  runCount: '4',
  failureCount: '1',
  lastStatus: 'succeeded',
  lastStartedAt: new Date('2026-05-01T09:00:00.000Z'),
  lastFinishedAt: new Date('2026-05-01T09:00:00.250Z'),
  lastDurationMs: '250',
  lastErrorType: null,
  lastProcessedCount: 7,
};

const HEALTH = {
  outcome: 'found',
  pendingCount: '412',
  dueCount: '412',
  inFlightCount: '0',
  completedCount: '0',
  deadLetteredCount: '3',
  oldestPendingAt: new Date('2026-04-01T09:00:00.000Z'),
  oldestInFlightAt: null,
  latestDeadLetteredAt: new Date('2026-05-01T09:00:00.000Z'),
  maxAttempts: 6,
  // Not part of the row interface, for the same reason as above.
  aggregateId: CANARY_AGGREGATE,
  payload: { secret: CANARY_MESSAGE },
};

const DEAD_LETTER = {
  eventType: 'order.placed',
  lastErrorType: 'TransportError',
  eventCount: '2',
  firstDeadLetteredAt: new Date('2026-05-01T07:00:00.000Z'),
  lastDeadLetteredAt: new Date('2026-05-01T09:00:00.000Z'),
  maxAttempts: 6,
  aggregateId: CANARY_AGGREGATE,
  payload: { secret: CANARY_MESSAGE },
};

const PROBLEM_ROW = { object: 'marketplace.offers.expire', problem: 'the job is not active' };

interface Seen {
  readonly name: string;
  readonly input: Record<string, unknown>;
}

interface Doubles {
  readonly permissions?: readonly string[];
  readonly detailOutcome?: string;
  readonly healthOutcome?: string;
  readonly storeThrows?: boolean;
  readonly unauthenticated?: boolean;
  readonly runRows?: readonly unknown[];
  readonly jobRows?: readonly unknown[];
  readonly deadRows?: readonly unknown[];
  readonly problemRows?: readonly unknown[];
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
    jobRunPage: async (input: Record<string, unknown>) => {
      note('runs')(input);
      return doubles.runRows ?? [RUN_ROW];
    },
    jobRunDetail: async (input: Record<string, unknown>) => {
      note('run')(input);
      const outcome = doubles.detailOutcome ?? 'found';
      return outcome === 'found' ? RUN_DETAIL : { ...RUN_DETAIL, outcome, id: null };
    },
    scheduledJobCatalogue: async (input: Record<string, unknown>) => {
      note('scheduledJobs')(input);
      return doubles.jobRows ?? [SCHEDULED_JOB];
    },
    outboxHealth: async (input: Record<string, unknown>) => {
      note('health')(input);
      const outcome = doubles.healthOutcome ?? 'found';
      return outcome === 'found' ? HEALTH : { ...HEALTH, outcome, pendingCount: null };
    },
    outboxDeadLetters: async (input: Record<string, unknown>) => {
      note('deadLetters')(input);
      return doubles.deadRows ?? [DEAD_LETTER];
    },
    platformScheduleProblems: async (input: Record<string, unknown>) => {
      note('problems')(input);
      return doubles.problemRows ?? [PROBLEM_ROW];
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
        throw new Error('reading a job run must never sign anyone in');
      },
      revokeAllSessions: async () => {
        throw new Error('reading a job run must never revoke a session');
      },
    })
    .overrideProvider(STAFF_CONSOLE_STORE)
    .useValue({
      staffConsoleAccess: async (input: { userId: string; isAal2: boolean }): Promise<StaffConsoleRow> => {
        seen.push({ name: 'console-access', input });
        // The platform's own behaviour, modelled rather than asserted around: a role that requires MFA counts
        // for nothing at aal1, so the effective set is empty. Both roles holding this key require MFA, which
        // is why an aal1 caller is refused without any separate assurance test in the service.
        const granted = [...(doubles.permissions ?? [PLATFORM])];
        return {
          hasConsoleRole: true,
          requiresStepUp: false,
          roles: ['admin'],
          permissions: input.isAal2 ? granted : [],
        };
      },
      buyerProfile: async (userId: string) => ({ id: userId, displayName: 'Nadia', localeCode: 'en' }),
    })
    .overrideProvider(PLATFORM_OPERATIONS_STORE)
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
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH' | 'PUT',
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<Result> {
  const response = await app!.inject({
    method,
    url: `/v1/admin/platform${path}`,
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

/** Every address this surface serves. */
const ALL = ['/job-runs', `/job-runs/${RUN}`, '/scheduled-jobs', '/schedule-problems', '/outbox'] as const;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/* ------------------------------------------------------------------------------------------------ */

describe('the shapes the contracts promise', () => {
  it('answers every read with a body its own schema accepts', async () => {
    await start();

    expect(JobRunPageResponseSchema.safeParse((await call('GET', '/job-runs')).body).success).toBe(true);
    expect(
      JobRunDetailResponseSchema.safeParse((await call('GET', `/job-runs/${RUN}`)).body).success,
    ).toBe(true);
    expect(
      ScheduledJobCatalogueResponseSchema.safeParse((await call('GET', '/scheduled-jobs')).body).success,
    ).toBe(true);
    expect(
      ScheduleProblemsResponseSchema.safeParse((await call('GET', '/schedule-problems')).body).success,
    ).toBe(true);
    expect(OutboxResponseSchema.safeParse((await call('GET', '/outbox')).body).success).toBe(true);
  });

  it('turns the counts the database sends as strings into numbers', async () => {
    await start();
    const outbox = (await call('GET', '/outbox')).body as {
      health: Record<string, unknown>;
      items: readonly Record<string, unknown>[];
    };

    // `count(*)` and `extract(epoch …)::bigint` arrive as strings from pg. A screen doing arithmetic on
    // "412" would concatenate rather than add.
    expect(outbox.health['pendingCount']).toBe(412);
    expect(outbox.health['deadLetteredCount']).toBe(3);
    expect(outbox.items[0]?.['eventCount']).toBe(2);

    const runs = (await call('GET', '/job-runs')).body as { items: readonly Record<string, unknown>[] };
    expect(runs.items[0]?.['durationMs']).toBe(120);

    const jobs = (await call('GET', '/scheduled-jobs')).body as {
      items: readonly Record<string, unknown>[];
    };
    expect(jobs.items[0]?.['runCount']).toBe(4);
    expect(jobs.items[0]?.['lastDurationMs']).toBe(250);
  });

  it('keeps a null processed count distinct from a zero', async () => {
    await start({ runRows: [RUN_ROW, { ...RUN_ROW, id: 'fc000000-0000-4000-8000-000000000002', processedCount: 0 }] });
    const runs = (await call('GET', '/job-runs')).body as { items: readonly Record<string, unknown>[] };

    // A run that failed recorded no count; a run that succeeded and did nothing recorded zero. Collapsing
    // them would be this layer inventing a fact.
    expect(runs.items[0]?.['processedCount']).toBeNull();
    expect(runs.items[1]?.['processedCount']).toBe(0);
  });
});

describe('the raw error message never crosses', () => {
  it('is absent from every response, although the store hands it over', async () => {
    await start();
    for (const path of ALL) {
      const result = await call('GET', path);
      expect(result.raw, path).not.toContain(CANARY_MESSAGE);
      expect(result.raw, path).not.toContain('sqlerrm');
      expect(result.raw, path).not.toContain('"details"');
      expect(result.raw, path).not.toContain('"message"');
    }
  });

  it('reports a failure by its class and its SQLSTATE instead', async () => {
    await start();
    const run = (await call('GET', `/job-runs/${RUN}`)).body as { run: Record<string, unknown> };

    expect(run.run['errorType']).toBe('sqlstate_23514');
    expect(run.run['errorSqlstate']).toBe('23514');
    expect(run.run['detailJobKey']).toBe('offers.expire');
  });
});

describe('nothing identifying an outbox event crosses', () => {
  it('leaves out the aggregate id and the payload, although the store hands both over', async () => {
    await start();
    const result = await call('GET', '/outbox');

    expect(result.raw).not.toContain(CANARY_AGGREGATE);
    for (const forbidden of ['aggregateId', 'aggregate_id', 'payload', 'createdBy', 'created_by']) {
      expect(result.raw, forbidden).not.toContain(forbidden);
    }
  });

  it('carries no event identifier of any kind', async () => {
    await start();
    const outbox = (await call('GET', '/outbox')).body as {
      health: Record<string, unknown>;
      items: readonly Record<string, unknown>[];
    };

    expect(Object.keys(outbox.health)).not.toContain('id');
    expect(Object.keys(outbox.items[0] ?? {})).not.toContain('id');
    // What is there instead: the two constrained columns and counts.
    expect(outbox.items[0]?.['eventType']).toBe('order.placed');
    expect(outbox.items[0]?.['lastErrorType']).toBe('TransportError');
  });
});

describe('every route requires platform.job.read, and no other key opens it', () => {
  it('reads all five with the key', async () => {
    await start({ permissions: [PLATFORM] });
    for (const path of ALL) {
      expect((await call('GET', path)).status, path).toBe(200);
    }
  });

  it('refuses all five to a caller holding every other admin key instead', async () => {
    await start({ permissions: [...OTHER_KEYS] });
    for (const path of ALL) {
      expect((await call('GET', path)).status, path).toBe(404);
    }
  });

  it('refuses all five to a caller holding each other key on its own', async () => {
    for (const key of OTHER_KEYS) {
      await start({ permissions: [key] });
      for (const path of ALL) {
        expect((await call('GET', path)).status, `${key} :: ${path}`).toBe(404);
      }
      await app?.close();
      app = undefined;
    }
  });

  it('never consults the store for a caller who does not hold the key', async () => {
    const seen = await start({ permissions: [] });
    for (const path of ALL) await call('GET', path);

    // The permission test is the first thing that happens, so a refused caller costs no read at all.
    expect(seen.filter((entry) => entry.name !== 'console-access')).toHaveLength(0);
  });
});

describe('the assurance level comes from the validated token', () => {
  it('refuses a caller at aal1 on every route', async () => {
    await start();
    const headers = { [SESSION_TOKEN_HEADER]: AAL1_TOKEN };
    for (const path of ALL) {
      expect((await call('GET', path, { headers })).status, path).toBe(404);
    }
  });

  it('asks the database with the assurance level it read, never one a request claimed', async () => {
    const seen = await start();
    await call('GET', '/job-runs');
    await call('GET', '/job-runs', { headers: { [SESSION_TOKEN_HEADER]: AAL1_TOKEN } });

    const access = seen.filter((entry) => entry.name === 'console-access');
    expect(access[0]?.input).toEqual({ userId: STAFF, isAal2: true });
    expect(access[1]?.input).toEqual({ userId: STAFF, isAal2: false });
  });

  it('passes the caller’s own account and assurance level to every reader', async () => {
    const seen = await start();
    for (const path of ALL) await call('GET', path);

    for (const entry of seen.filter((item) => item.name !== 'console-access')) {
      expect(entry.input['userId'], entry.name).toBe(STAFF);
      expect(entry.input['isAal2'], entry.name).toBe(true);
    }
  });

  it('refuses a request with no session at all', async () => {
    await start();
    const response = await app!.inject({
      method: 'GET',
      url: '/v1/admin/platform/job-runs',
      headers: { [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL },
    });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a session the provider will not vouch for', async () => {
    await start({ unauthenticated: true });
    expect((await call('GET', '/job-runs')).status).toBe(401);
  });
});

describe('nothing on this surface writes, and no verb but GET is served', () => {
  it('serves no POST, PUT, PATCH or DELETE at any address it does serve', async () => {
    await start();
    for (const path of ALL) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
        const result = await call(method, path, { body: {} });
        expect(result.status, `${method} ${path}`).toBe(404);
      }
    }
  });

  it('serves nothing at any address a retry, cancel or replay control would live at', async () => {
    await start();
    // A reported capability gap should fail loudly if somebody later fills one of these in without a writer.
    for (const path of [
      `/job-runs/${RUN}/retry`,
      `/job-runs/${RUN}/re-run`,
      `/job-runs/${RUN}/cancel`,
      '/job-runs',
      '/outbox/retry',
      '/outbox/replay',
      '/outbox/dead-letters/retry',
      '/outbox/sweep',
      '/scheduled-jobs/run',
      `/scheduled-jobs/offers.expire/run`,
    ]) {
      const result = await call('POST', path, { body: {} });
      expect(result.status, path).toBe(404);
    }
  });

  it('never reaches the store for anything but the six readers', async () => {
    const seen = await start();
    for (const path of ALL) await call('GET', path);

    const names = [...new Set(seen.filter((e) => e.name !== 'console-access').map((e) => e.name))].sort();
    expect(names).toEqual([
      'deadLetters',
      'health',
      'problems',
      'run',
      'runs',
      'scheduledJobs',
    ]);
  });
});

describe('a refusal says nothing about existence', () => {
  it('answers a missing run and a missing permission identically, byte for byte', async () => {
    await start({ detailOutcome: 'not_found' });
    const absent = await call('GET', `/job-runs/${RUN}`);
    await app?.close();
    app = undefined;

    await start({ permissions: [] });
    const unauthorized = await call('GET', `/job-runs/${RUN}`);

    expect(absent.status).toBe(404);
    expect(unauthorized.status).toBe(404);
    expect(absent.raw).toBe(unauthorized.raw);
  });

  /**
   * The defect the aggregate reader's outcome column exists to prevent. A count over rows the authorization
   * removed is one row of zeros, not a refusal — so an unauthorized caller would have been shown a health panel
   * reading zero everywhere instead of the neutral not-found.
   */
  it('refuses outbox health rather than reporting an outbox of zeros', async () => {
    await start({ healthOutcome: 'not_found' });
    const result = await call('GET', '/outbox');

    expect(result.status).toBe(404);
    expect(result.body['code']).toBe('NOT_FOUND');
    expect(result.raw).not.toContain('pendingCount');
  });

  it('never answers 403 on any of the five', async () => {
    await start({ permissions: [] });
    for (const path of ALL) {
      expect((await call('GET', path)).status, path).not.toBe(403);
    }
  });

  it('answers an empty schedule-problem list as the good answer it is', async () => {
    await start({ problemRows: [] });
    const result = await call('GET', '/schedule-problems');

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ items: [] });
  });

  it('turns a store that throws into an outage on every route', async () => {
    await start({ storeThrows: true });
    for (const path of ALL) {
      expect((await call('GET', path)).status, path).toBe(503);
    }
  });
});

describe('the run list pages deterministically', () => {
  it('asks for one row more than it will return', async () => {
    const seen = await start();
    await call('GET', '/job-runs?limit=5');

    expect(seen.find((entry) => entry.name === 'runs')?.input['limit']).toBe(6);
  });

  it('emits a cursor only when there is another page', async () => {
    const rows = Array.from({ length: 3 }, (_, index) => ({
      ...RUN_ROW,
      id: `fc000000-0000-4000-8000-00000000000${index + 1}`,
    }));

    await start({ runRows: rows });
    const full = await call('GET', '/job-runs?limit=2');
    expect((full.body['items'] as unknown[]).length).toBe(2);
    expect(full.body['nextCursor']).toBeTypeOf('string');

    await app?.close();
    app = undefined;
    await start({ runRows: rows.slice(0, 2) });
    const last = await call('GET', '/job-runs?limit=2');
    expect(last.body['nextCursor']).toBeNull();
  });

  it('decodes its own cursor into the position the reader is asked for', async () => {
    const seen = await start();
    const cursor = encodeJobRunCursor({
      startedAt: new Date('2026-05-01T09:00:00.000Z'),
      id: RUN,
    });
    await call('GET', `/job-runs?cursor=${encodeURIComponent(cursor)}`);

    const read = seen.find((entry) => entry.name === 'runs');
    expect((read?.input['cursorStartedAt'] as Date).toISOString()).toBe('2026-05-01T09:00:00.000Z');
    expect(read?.input['cursorId']).toBe(RUN);
  });

  it('refuses a cursor that is not one, and a position from another list', async () => {
    await start();
    const foreign = Buffer.from(`rq1|2026-05-01T09:00:00.000Z|${RUN}`, 'utf8').toString('base64url');
    const review = Buffer.from(`rv1|2026-05-01T09:00:00.000Z|${RUN}`, 'utf8').toString('base64url');
    for (const cursor of ['!!!!', 'abc', foreign, review, Buffer.from('jr1|x|y').toString('base64url')]) {
      const result = await call('GET', `/job-runs?cursor=${encodeURIComponent(cursor)}`);
      expect(result.status, cursor).toBe(400);
      expect(result.body['code']).toBe('VALIDATION_FAILED');
    }
  });

  it('refuses a limit that is not one and clamps one that is too large', async () => {
    const seen = await start();
    for (const limit of ['0', '-1', 'ten', '1.5', '10000']) {
      expect((await call('GET', `/job-runs?limit=${limit}`)).status, limit).toBe(400);
    }
    await call('GET', `/job-runs?limit=${PLATFORM_OPS_MAX_LIMIT + 1}`);
    expect(seen.find((entry) => entry.name === 'runs')?.input['limit']).toBe(
      PLATFORM_OPS_MAX_LIMIT + 1,
    );
  });

  it('passes an unknown status filter through rather than refusing it', async () => {
    const seen = await start();
    // The database compares it as a parameter, so a stale bookmark shows an empty page rather than an error.
    expect((await call('GET', '/job-runs?status=approved')).status).toBe(200);
    expect(seen.find((entry) => entry.name === 'runs')?.input['status']).toBe('approved');
  });

  it('passes a well-formed job name through and refuses a malformed one', async () => {
    const seen = await start();
    expect((await call('GET', '/job-runs?jobName=no.such_job')).status).toBe(200);
    expect(seen.find((entry) => entry.name === 'runs')?.input['jobName']).toBe('no.such_job');

    // A malformed name could not name a run at all, so it is a malformed request rather than a stale filter.
    for (const jobName of ['Offers.Expire', 'offers expire', "offers'--", '1offers', 'a'.repeat(201)]) {
      const result = await call('GET', `/job-runs?jobName=${encodeURIComponent(jobName)}`);
      expect(result.status, jobName).toBe(400);
    }
  });

  it('refuses a run identifier that is not one', async () => {
    await start();
    for (const value of ['not-a-uuid', '1', `${RUN}x`, 'null']) {
      expect((await call('GET', `/job-runs/${value}`)).status, value).toBe(400);
    }
  });

  it('asks the dead-letter grouping for its fixed page', async () => {
    const seen = await start();
    await call('GET', '/outbox');

    expect(seen.find((entry) => entry.name === 'deadLetters')?.input['limit']).toBe(
      PLATFORM_DEAD_LETTER_LIMIT,
    );
  });
});

describe('the schedule is reported as the database holds it', () => {
  it('carries the cron expression, the target and the purpose', async () => {
    await start();
    const jobs = (await call('GET', '/scheduled-jobs')).body as {
      items: readonly Record<string, unknown>[];
    };

    expect(jobs.items[0]?.['cronSchedule']).toBe('*/5 * * * *');
    expect(jobs.items[0]?.['targetSignature']).toBe('app_private.expire_due_offers(500)');
    expect(jobs.items[0]?.['purpose']).toBe('closes offers whose window has passed');
  });

  it('keeps a never-run job’s nulls as nulls rather than zeros', async () => {
    await start({
      jobRows: [
        {
          ...SCHEDULED_JOB,
          jobKey: 'reservations.release',
          runCount: '0',
          failureCount: '0',
          lastStatus: null,
          lastStartedAt: null,
          lastFinishedAt: null,
          lastDurationMs: null,
          lastProcessedCount: null,
        },
      ],
    });
    const jobs = (await call('GET', '/scheduled-jobs')).body as {
      items: readonly Record<string, unknown>[];
    };

    expect(jobs.items[0]?.['runCount']).toBe(0);
    expect(jobs.items[0]?.['lastStatus']).toBeNull();
    expect(jobs.items[0]?.['lastStartedAt']).toBeNull();
    expect(jobs.items[0]?.['lastProcessedCount']).toBeNull();
  });

  it('forwards the guard’s own sentence without paraphrasing it', async () => {
    await start();
    const problems = (await call('GET', '/schedule-problems')).body as {
      items: readonly Record<string, unknown>[];
    };

    expect(problems.items[0]).toEqual({
      object: 'marketplace.offers.expire',
      problem: 'the job is not active',
    });
  });
});
