import { describe, expect, it } from 'vitest';
import {
  readJobRun,
  readJobRuns,
  readOutbox,
  readScheduleProblems,
  readScheduledJobs,
} from '../src/server/bff/platform-operations';

/**
 * The platform operations BFF, on the admin origin (Phase 7-Q).
 *
 * What matters at this boundary:
 *
 *   * the caller's token comes from `__Host-mp_admin_access` and never from a body, and the browser's own
 *     `Cookie` header is never forwarded upstream;
 *   * **there is no write path in the module at all** — no handler taking a `Request`, no origin check, no
 *     POST — which is asserted on the module's own export list, because that is the shape a missing writer
 *     takes at this layer;
 *   * a run is named by its id in the **route**, from a value checked for shape here;
 *   * responses are validated against the contract before a byte reaches a browser, so a drifted API that sent
 *     the raw failure text or an outbox event's identifiers would produce a clean failure rather than a leak;
 *   * a status, a job name and a limit are checked against the schema's own formats and dropped rather than
 *     forwarded when they could not match;
 *   * every upstream status becomes the one state a screen renders.
 *
 * Everything is stubbed at the `fetch` boundary: no API, no database, no network.
 */

const ENV = {
  API_BASE_URL: 'https://api.internal.test',
  INTERNAL_BFF_CREDENTIAL: 'test-platform-operations-canary-credentials',
} as const;

const SESSION_TOKEN = 'canary-admin-access-token-not-a-real-token';
const COOKIE = `__Host-mp_admin_access=${SESSION_TOKEN}; __Host-mp_admin_refresh=canary-refresh-not-real`;

const RUN = 'fc000000-0000-4000-8000-000000000001';

/** What the job runner stores under `details.message`. If this reaches a browser, the wall failed. */
const CANARY_MESSAGE = 'CANARY_SQLERRM_QUOTING_A_ROW';

const RUN_ROW = {
  id: RUN,
  jobName: 'offers.expire',
  status: 'failed',
  scheduledFor: null,
  startedAt: '2026-05-01T09:00:00.000Z',
  finishedAt: '2026-05-01T09:00:00.120Z',
  durationMs: 120,
  errorType: 'sqlstate_23514',
  processedCount: null,
  isContracted: true,
};

const RUN_DETAIL = {
  ...RUN_ROW,
  errorSqlstate: '23514',
  detailJobKey: 'offers.expire',
  cronSchedule: '*/5 * * * *',
  targetSignature: 'app_private.expire_due_offers(500)',
  purpose: 'closes offers whose window has passed',
};

const SCHEDULED_JOB = {
  jobKey: 'offers.expire',
  cronSchedule: '*/5 * * * *',
  targetSignature: 'app_private.expire_due_offers(500)',
  purpose: 'closes offers whose window has passed',
  runCount: 4,
  failureCount: 1,
  lastStatus: 'succeeded',
  lastStartedAt: '2026-05-01T09:00:00.000Z',
  lastFinishedAt: '2026-05-01T09:00:00.250Z',
  lastDurationMs: 250,
  lastErrorType: null,
  lastProcessedCount: 7,
};

const HEALTH = {
  pendingCount: 412,
  dueCount: 412,
  inFlightCount: 0,
  completedCount: 0,
  deadLetteredCount: 3,
  oldestPendingAt: '2026-04-01T09:00:00.000Z',
  oldestInFlightAt: null,
  latestDeadLetteredAt: '2026-05-01T09:00:00.000Z',
  maxAttempts: 6,
};

const DEAD_LETTER = {
  eventType: 'order.placed',
  lastErrorType: 'TransportError',
  eventCount: 2,
  firstDeadLetteredAt: '2026-05-01T07:00:00.000Z',
  lastDeadLetteredAt: '2026-05-01T09:00:00.000Z',
  maxAttempts: 6,
};

interface Seen {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string;
}

function api(status: number, payload: unknown, seen: Seen[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers as HeadersInit),
      body: typeof init?.body === 'string' ? init.body : '',
    });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
    });
  }) as unknown as typeof fetch;
}

const OPTIONS = { env: ENV, cookieHeader: COOKIE } as const;
const OUTBOX_BODY = { health: HEALTH, items: [DEAD_LETTER] };

/* ------------------------------------------------------------------------------------------------ */

describe('the five reads', () => {
  it('present the caller’s token and the internal credential, and never the browser cookie', async () => {
    const seen: Seen[] = [];
    await readJobRuns({}, { ...OPTIONS, fetch: api(200, { items: [RUN_ROW], nextCursor: null }, seen) });

    expect(seen[0]!.url).toBe('https://api.internal.test/v1/admin/platform/job-runs');
    expect(seen[0]!.method).toBe('GET');
    expect(seen[0]!.headers.get('x-session-token')).toBe(SESSION_TOKEN);
    expect(seen[0]!.headers.get('x-internal-credential')).toBe(ENV.INTERNAL_BFF_CREDENTIAL);
    expect(seen[0]!.headers.get('cookie')).toBeNull();
  });

  it('address every read at the path the contract names, with the identifier lower-cased', async () => {
    const seen: Seen[] = [];
    await readJobRuns({}, { ...OPTIONS, fetch: api(200, { items: [], nextCursor: null }, seen) });
    await readJobRun(RUN.toUpperCase(), { ...OPTIONS, fetch: api(200, { run: RUN_DETAIL }, seen) });
    await readScheduledJobs({ ...OPTIONS, fetch: api(200, { items: [] }, seen) });
    await readScheduleProblems({ ...OPTIONS, fetch: api(200, { items: [] }, seen) });
    await readOutbox({ ...OPTIONS, fetch: api(200, OUTBOX_BODY, seen) });

    expect(seen.map((entry) => entry.url.replace('https://api.internal.test', ''))).toEqual([
      '/v1/admin/platform/job-runs',
      `/v1/admin/platform/job-runs/${RUN}`,
      '/v1/admin/platform/scheduled-jobs',
      '/v1/admin/platform/schedule-problems',
      '/v1/admin/platform/outbox',
    ]);
    // Every one a GET with no body: there is nothing on this surface to submit.
    expect(seen.every((entry) => entry.method === 'GET' && entry.body === '')).toBe(true);
  });

  it('answer notFound to a malformed address without calling the API at all', async () => {
    const seen: Seen[] = [];
    const fetcher = api(200, {}, seen);
    expect((await readJobRun('not-a-uuid', { ...OPTIONS, fetch: fetcher })).kind).toBe('notFound');
    expect((await readJobRun(undefined, { ...OPTIONS, fetch: fetcher })).kind).toBe('notFound');
    expect((await readJobRun('', { ...OPTIONS, fetch: fetcher })).kind).toBe('notFound');
    expect(seen).toHaveLength(0);
  });

  it('answer unauthenticated without a session cookie, and never call the API', async () => {
    const seen: Seen[] = [];
    const fetcher = api(200, {}, seen);
    const options = { env: ENV, cookieHeader: null, fetch: fetcher };
    expect((await readJobRuns({}, options)).kind).toBe('unauthenticated');
    expect((await readScheduledJobs(options)).kind).toBe('unauthenticated');
    expect((await readOutbox(options)).kind).toBe('unauthenticated');
    expect(seen).toHaveLength(0);
  });

  it('turn each upstream status into the one state a screen renders', async () => {
    for (const [status, kind] of [
      [401, 'unauthenticated'],
      [404, 'notFound'],
      [400, 'invalid'],
      [403, 'unavailable'],
      [500, 'unavailable'],
      [503, 'unavailable'],
    ] as const) {
      const result = await readJobRuns({}, { ...OPTIONS, fetch: api(status, {}) });
      expect(result.kind, String(status)).toBe(kind);
    }
  });

  it('turn a fetch that throws into one outage', async () => {
    const thrower = (async () => {
      throw new Error('network');
    }) as unknown as typeof fetch;
    expect((await readJobRuns({}, { ...OPTIONS, fetch: thrower })).kind).toBe('unavailable');
    expect((await readOutbox({ ...OPTIONS, fetch: thrower })).kind).toBe('unavailable');
  });

  it('unwrap what the contract wraps', async () => {
    const detail = await readJobRun(RUN, { ...OPTIONS, fetch: api(200, { run: RUN_DETAIL }) });
    expect(detail.kind === 'ok' && detail.data.id).toBe(RUN);

    const outbox = await readOutbox({ ...OPTIONS, fetch: api(200, OUTBOX_BODY) });
    expect(outbox.kind === 'ok' && outbox.data.health.pendingCount).toBe(412);
    expect(outbox.kind === 'ok' && outbox.data.items).toHaveLength(1);

    const jobs = await readScheduledJobs({ ...OPTIONS, fetch: api(200, { items: [SCHEDULED_JOB] }) });
    expect(jobs.kind === 'ok' && jobs.data.items[0]?.jobKey).toBe('offers.expire');
    // The target signature crosses: it is what tells somebody reading a failure which function failed.
    expect(jobs.kind === 'ok' && jobs.data.items[0]?.targetSignature).toBe(
      'app_private.expire_due_offers(500)',
    );

    const problems = await readScheduleProblems({
      ...OPTIONS,
      fetch: api(200, { items: [{ object: 'marketplace.offers.expire', problem: 'the job is not active' }] }),
    });
    expect(problems.kind === 'ok' && problems.data.items[0]?.problem).toBe('the job is not active');
  });
});

describe('the contract is the third wall', () => {
  it('refuses a body carrying the raw failure text rather than passing it along', async () => {
    const drifted = { run: { ...RUN_DETAIL, details: { message: CANARY_MESSAGE } } };
    const result = await readJobRun(RUN, { ...OPTIONS, fetch: api(200, drifted) });

    // `.strict()`, so the whole read fails rather than the extra field being quietly dropped — which is the
    // stronger property, because nothing has to remember to drop it.
    expect(result.kind).toBe('unavailable');
  });

  it('refuses an outbox body carrying an event identifier or a payload', async () => {
    for (const drifted of [
      { health: { ...HEALTH, aggregateId: 'CANARY' }, items: [DEAD_LETTER] },
      { health: HEALTH, items: [{ ...DEAD_LETTER, id: RUN }] },
      { health: HEALTH, items: [{ ...DEAD_LETTER, payload: { secret: CANARY_MESSAGE } }] },
    ]) {
      const result = await readOutbox({ ...OPTIONS, fetch: api(200, drifted) });
      expect(result.kind, JSON.stringify(drifted).slice(0, 60)).toBe('unavailable');
    }
  });

  it('refuses an outbox body missing either half', async () => {
    // Health without the groups says something is wrong and not what; groups without health give no scale.
    expect((await readOutbox({ ...OPTIONS, fetch: api(200, { health: HEALTH }) })).kind).toBe(
      'unavailable',
    );
    expect((await readOutbox({ ...OPTIONS, fetch: api(200, { items: [DEAD_LETTER] }) })).kind).toBe(
      'unavailable',
    );
  });

  it('refuses a run row whose error class could not be one', async () => {
    // 0007 constrains `error_type` to a class name. Free text there would mean a message had got in.
    const drifted = {
      items: [{ ...RUN_ROW, errorType: 'could not insert row (id=42, email=a@b.test)' }],
      nextCursor: null,
    };
    expect((await readJobRuns({}, { ...OPTIONS, fetch: api(200, drifted) })).kind).toBe('unavailable');
  });

  it('refuses a job name the column’s own format would not allow', async () => {
    const drifted = { items: [{ ...RUN_ROW, jobName: 'Offers Expire!' }], nextCursor: null };
    expect((await readJobRuns({}, { ...OPTIONS, fetch: api(200, drifted) })).kind).toBe('unavailable');
  });
});

describe('the run list’s query string', () => {
  it('forwards a cursor as opaque text and never parses it', async () => {
    const seen: Seen[] = [];
    const cursor = 'anIxfDIwMjYtMDUtMDFUMDk6MDA6MDAuMDAwWnxmYw';
    await readJobRuns({ cursor }, { ...OPTIONS, fetch: api(200, { items: [], nextCursor: null }, seen) });
    expect(seen[0]!.url).toBe(
      `https://api.internal.test/v1/admin/platform/job-runs?cursor=${cursor}`,
    );
  });

  it('drops a cursor that could not be one', async () => {
    const seen: Seen[] = [];
    for (const cursor of ['!!!', 'a b', 'x'.repeat(513), '']) {
      await readJobRuns({ cursor }, { ...OPTIONS, fetch: api(200, { items: [], nextCursor: null }, seen) });
    }
    expect(seen.every((entry) => !entry.url.includes('cursor='))).toBe(true);
  });

  it('forwards one of the four run statuses and drops anything else', async () => {
    const seen: Seen[] = [];
    for (const status of ['running', 'succeeded', 'failed', 'skipped']) {
      await readJobRuns({ status }, { ...OPTIONS, fetch: api(200, { items: [], nextCursor: null }, seen) });
    }
    expect(seen.map((entry) => new URL(entry.url).searchParams.get('status'))).toEqual([
      'running',
      'succeeded',
      'failed',
      'skipped',
    ]);

    const dropped: Seen[] = [];
    for (const status of ['approved', 'FAILED', 'pending', "failed' or true"]) {
      await readJobRuns(
        { status },
        { ...OPTIONS, fetch: api(200, { items: [], nextCursor: null }, dropped) },
      );
    }
    expect(dropped.every((entry) => !entry.url.includes('status='))).toBe(true);
  });

  it('forwards a job name the column’s format allows and drops anything else', async () => {
    const seen: Seen[] = [];
    await readJobRuns(
      { jobName: 'offers.expire' },
      { ...OPTIONS, fetch: api(200, { items: [], nextCursor: null }, seen) },
    );
    expect(new URL(seen[0]!.url).searchParams.get('jobName')).toBe('offers.expire');

    const dropped: Seen[] = [];
    for (const jobName of ['Offers.Expire', 'offers expire', "offers'--", '1offers', 'a'.repeat(201)]) {
      await readJobRuns(
        { jobName },
        { ...OPTIONS, fetch: api(200, { items: [], nextCursor: null }, dropped) },
      );
    }
    expect(dropped.every((entry) => !entry.url.includes('jobName='))).toBe(true);
  });

  it('forwards a numeric limit and drops anything else', async () => {
    const seen: Seen[] = [];
    for (const limit of ['25', 'ten', '-1', '1.5', '']) {
      await readJobRuns({ limit }, { ...OPTIONS, fetch: api(200, { items: [], nextCursor: null }, seen) });
    }
    expect(seen.map((entry) => new URL(entry.url).searchParams.get('limit'))).toEqual([
      '25',
      null,
      null,
      null,
      null,
    ]);
  });
});

describe('there is no write path in this module', () => {
  it('exports five reads and nothing else', async () => {
    const surface: Record<string, unknown> = await import('../src/server/bff/platform-operations');
    const names = Object.keys(surface).sort();

    expect(names).toEqual([
      'readJobRun',
      'readJobRuns',
      'readOutbox',
      'readScheduleProblems',
      'readScheduledJobs',
    ]);
    // Every other BFF module on this origin exports at least one `handle…`. This one exports none, because
    // there is no writer upstream for it to call.
    for (const name of names) {
      expect(name.startsWith('read'), name).toBe(true);
      expect(name.toLowerCase(), name).not.toContain('handle');
      for (const verb of ['retry', 'cancel', 'requeue', 'replay', 'rerun', 'sweep']) {
        expect(name.toLowerCase(), `${name}/${verb}`).not.toContain(verb);
      }
    }
  });

  it('never issues a request with a method other than GET', async () => {
    const seen: Seen[] = [];
    const fetcher = api(200, { items: [], nextCursor: null }, seen);
    await readJobRuns({}, { ...OPTIONS, fetch: fetcher });
    await readJobRun(RUN, { ...OPTIONS, fetch: api(200, { run: RUN_DETAIL }, seen) });
    await readScheduledJobs({ ...OPTIONS, fetch: api(200, { items: [] }, seen) });
    await readScheduleProblems({ ...OPTIONS, fetch: api(200, { items: [] }, seen) });
    await readOutbox({ ...OPTIONS, fetch: api(200, OUTBOX_BODY, seen) });

    expect(seen.every((entry) => entry.method === 'GET')).toBe(true);
    expect(seen.every((entry) => entry.body === '')).toBe(true);
  });
});
