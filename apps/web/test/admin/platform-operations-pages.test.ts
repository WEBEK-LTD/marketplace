import type { ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import arMessages from '../../messages/admin/ar.json';
import enMessages from '../../messages/admin/en.json';
import { startBuiltApp, type RunningApp } from '../support/next-server.js';
import { problem, startStubApi, type StubApi } from '../support/stub-api.js';

/**
 * Where the console is mounted (0108). Every address in this file is console-relative, exactly as it was while the
 * console was an application of its own; this is the one place that turns it into the address the server answers.
 */
const CONSOLE = '/admin';

/**
 * The platform operations screens, over real HTTP against the built app (Phase 7-Q).
 *
 * Run against the built app rather than a unit harness for the reason 7-F's shell test is: what matters is what
 * actually reaches a browser, **including the streamed RSC payload**.
 *
 * The cases this file exists for:
 *
 *   * **a guest, a buyer, staff at `aal1`, a Moderator and a Support Agent receive none of this section** — no
 *     job name, no schedule, no counts — in the markup or in the flight data, and no read is performed. This is
 *     the one section a Moderator and a Support Agent cannot see any part of, because `platform.job.read` is
 *     held by Admin and Super Admin alone;
 *   * **the raw failure text never renders**, whatever the API sends, and the page says it is absent rather
 *     than silently showing less than it has;
 *   * **nothing identifying an outbox event renders** — no event id, no aggregate id, no payload;
 *   * **there is no control anywhere on either page.** No retry, no cancel, no requeue, no replay, no re-run —
 *     asserted by searching the payload for a form and a button, and by driving the routes such controls would
 *     post to;
 *   * **the two standing facts are on the page**: no relay is running, so the pending count is expected to be
 *     large; and the worker's repeatable jobs record no run, so the schedule is the database's only;
 *   * **no verdict is rendered** — an age is an age and a count is a count;
 *   * both languages, the direction that goes with each, and every state: empty, refused, unavailable, a job
 *     that has never run, a schedule with nothing wrong with it.
 *
 * No browser, no Playwright, no live provider, no live storage, no deployment.
 */

const CANARY_CREDENTIAL = 'test-platform-ops-pages-canary-notreal01234';

const EN = enMessages;
const AR = arMessages;

const ACCESS = '__Host-mp_admin_access=canary-admin-access-token-not-a-real-token';
const REFRESH = '__Host-mp_admin_refresh=canary-admin-refresh-token-not-a-real-tok';
const SESSION = `${ACCESS}; ${REFRESH}`;

const STAFF = '11111111-1111-4111-8111-111111111111';
const RUN = 'fc000000-0000-4000-8000-000000000001';

const PLATFORM = 'platform.job.read';

/** An administrator: the key, plus others this surface never consults. */
const ADMIN = [PLATFORM, 'users.profile.read', 'audit.read'].sort();

/** A moderator: everything a moderator holds, and not this. */
const MODERATOR = [
  'moderation.report.read',
  'moderation.action.read',
  'reviews.review.read',
  'users.profile.read',
  'sellers.profile.read',
].sort();

/** A support agent: likewise. */
const SUPPORT_AGENT = ['support.ticket.read', 'users.profile.read', 'security.recovery.review'].sort();

const JOB_KEY = 'offers.expire';
const JOB_PURPOSE = 'Canary purpose recorded for this scheduled job';
const TARGET = 'app_private.expire_due_offers(500)';
const PROBLEM_SENTENCE = 'the job is not active';

/** Values that must never render, whatever the API sends. */
const CANARY_MESSAGE = 'CANARY_SQLERRM_QUOTING_A_ROW_id_42_email_a_at_b';
const CANARY_AGGREGATE = 'CANARY_AGGREGATE_ID_NAMING_AN_ORDER';
const CANARY_PAYLOAD = 'CANARY_PAYLOAD_CONTENTS';

const RUN_ROW = {
  id: RUN,
  jobName: JOB_KEY,
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
  detailJobKey: JOB_KEY,
  cronSchedule: '*/5 * * * *',
  targetSignature: TARGET,
  purpose: JOB_PURPOSE,
};

const SCHEDULED_JOB = {
  jobKey: JOB_KEY,
  cronSchedule: '*/5 * * * *',
  targetSignature: TARGET,
  purpose: JOB_PURPOSE,
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
  pendingCount: 914137,
  dueCount: 914137,
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

type Who =
  | { kind: 'unauthenticated' }
  | { kind: 'buyer' }
  | { kind: 'staff-aal1' }
  | { kind: 'staff'; permissions: readonly string[]; locale?: 'en' | 'ar' };

type Data =
  | 'default'
  | 'empty'
  | 'paged'
  | 'notFound'
  | 'unavailable'
  | 'leaky'
  | 'neverRun'
  | 'clean'
  | 'uncontracted'
  | 'running';

interface Serve {
  readonly who: Who;
  readonly data?: Data;
}

let api: StubApi;
let app: RunningApp;

beforeAll(async () => {
  api = await startStubApi();
  app = await startBuiltApp({ API_BASE_URL: api.baseUrl, INTERNAL_BFF_CREDENTIAL: CANARY_CREDENTIAL });
}, 180_000);

afterAll(async () => {
  await app.stop();
  await api.stop();
});

function json(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function runFor(mode: Data): unknown {
  if (mode === 'uncontracted') {
    return {
      run: {
        ...RUN_DETAIL,
        jobName: 'legacy.retired_job',
        isContracted: false,
        cronSchedule: null,
        targetSignature: null,
        purpose: null,
      },
    };
  }
  if (mode === 'running') {
    return {
      run: {
        ...RUN_DETAIL,
        status: 'running',
        finishedAt: null,
        durationMs: null,
        errorType: null,
        errorSqlstate: null,
      },
    };
  }
  if (mode === 'leaky') {
    // An API that has drifted and sends the raw failure text. The contract is the wall.
    return { run: { ...RUN_DETAIL, details: { message: CANARY_MESSAGE } } };
  }
  return { run: RUN_DETAIL };
}

function apiServes(serve: Serve): void {
  const data: Data = serve.data ?? 'default';
  api.seen.length = 0;
  api.reply((request, response) => {
    const path = request.url.split('?')[0] ?? '';
    const who = serve.who;

    if (path === '/v1/admin/session') {
      if (who.kind === 'unauthenticated') return problem(response, 401, 'AUTHENTICATION_REQUIRED');
      const base = {
        id: STAFF,
        displayName: 'Nadia',
        localeCode: who.kind === 'staff' ? (who.locale ?? 'en') : 'en',
      };
      if (who.kind === 'buyer') {
        return json(response, {
          session: { ...base, isStaff: false, requiresStepUp: false, roles: [], permissions: [] },
        });
      }
      if (who.kind === 'staff-aal1') {
        return json(response, {
          session: { ...base, isStaff: true, requiresStepUp: true, roles: [], permissions: [] },
        });
      }
      return json(response, {
        session: {
          ...base,
          isStaff: true,
          requiresStepUp: false,
          roles: ['admin'],
          permissions: [...who.permissions],
        },
      });
    }

    const held = (key: string): boolean => who.kind === 'staff' && who.permissions.includes(key);

    // The API's own gating, modelled: every operation answers 404 for a caller without the one key.
    if (path === '/v1/admin/platform/job-runs') {
      if (!held(PLATFORM)) return problem(response, 404, 'NOT_FOUND');
      if (data === 'unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      if (data === 'empty') return json(response, { items: [], nextCursor: null });
      if (data === 'uncontracted') {
        return json(response, {
          items: [{ ...RUN_ROW, jobName: 'legacy.retired_job', isContracted: false }],
          nextCursor: null,
        });
      }
      if (data === 'running') {
        return json(response, {
          items: [{ ...RUN_ROW, status: 'running', finishedAt: null, durationMs: null, errorType: null }],
          nextCursor: null,
        });
      }
      return json(response, {
        items: [RUN_ROW],
        nextCursor: data === 'paged' ? 'anIxfGNhbmFyeQ' : null,
      });
    }
    if (path === `/v1/admin/platform/job-runs/${RUN}`) {
      if (!held(PLATFORM)) return problem(response, 404, 'NOT_FOUND');
      if (data === 'notFound') return problem(response, 404, 'NOT_FOUND');
      if (data === 'unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      return json(response, runFor(data));
    }
    if (path === '/v1/admin/platform/scheduled-jobs') {
      if (!held(PLATFORM)) return problem(response, 404, 'NOT_FOUND');
      if (data === 'unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      if (data === 'empty') return json(response, { items: [] });
      if (data === 'neverRun') {
        return json(response, {
          items: [
            {
              ...SCHEDULED_JOB,
              jobKey: 'reservations.release',
              runCount: 0,
              failureCount: 0,
              lastStatus: null,
              lastStartedAt: null,
              lastFinishedAt: null,
              lastDurationMs: null,
              lastErrorType: null,
              lastProcessedCount: null,
            },
          ],
        });
      }
      return json(response, { items: [SCHEDULED_JOB] });
    }
    if (path === '/v1/admin/platform/schedule-problems') {
      if (!held(PLATFORM)) return problem(response, 404, 'NOT_FOUND');
      if (data === 'clean' || data === 'empty') return json(response, { items: [] });
      return json(response, {
        items: [{ object: `marketplace.${JOB_KEY}`, problem: PROBLEM_SENTENCE }],
      });
    }
    if (path === '/v1/admin/platform/outbox') {
      if (!held(PLATFORM)) return problem(response, 404, 'NOT_FOUND');
      if (data === 'unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      if (data === 'empty' || data === 'clean') {
        return json(response, {
          health: {
            ...HEALTH,
            pendingCount: 0,
            dueCount: 0,
            deadLetteredCount: 0,
            oldestPendingAt: null,
            latestDeadLetteredAt: null,
            maxAttempts: null,
          },
          items: [],
        });
      }
      if (data === 'leaky') {
        return json(response, {
          health: { ...HEALTH, aggregateId: CANARY_AGGREGATE },
          items: [{ ...DEAD_LETTER, id: RUN, payload: { secret: CANARY_PAYLOAD } }],
        });
      }
      return json(response, { health: HEALTH, items: [DEAD_LETTER] });
    }

    return problem(response, 404, 'NOT_FOUND');
  });
}

async function get(path: string, cookie = SESSION): Promise<{ status: number; html: string }> {
  const response = await fetch(`${app.baseUrl}${CONSOLE}${path}`, {
    redirect: 'manual',
    headers: cookie === '' ? {} : { cookie },
  });
  return { status: response.status, html: await response.text() };
}

const JOBS_PAGE = '/platform/jobs';
const RUN_PAGE = `/platform/jobs/${RUN}`;
const ALL = [JOBS_PAGE, RUN_PAGE];

/** Everything a refused response must not contain, in markup or flight data. */
/**
 * Everything a refused response must not contain, in markup or flight data.
 *
 * The counts are deliberately a long, arbitrary number rather than a short one. They were `412` until 0108, and a
 * three-digit canary is not a canary: Next.js writes client module ids into the flight payload as bare integers, so
 * `412` appeared in a refused page as a substring of an id and the assertion failed for a reason that had nothing to
 * do with a leak. A six-digit value cannot collide with one by accident, which is what makes a hit meaningful.
 */
const SECRETS = [JOB_PURPOSE, TARGET, PROBLEM_SENTENCE, EN.Platform.pendingLabel, '914137'];

/** Values that must never render on any screen, however they arrive. */
const NEVER = [CANARY_MESSAGE, CANARY_AGGREGATE, CANARY_PAYLOAD];

/* ------------------------------------------------------------------------------------------------ */

describe('who is refused', () => {
  it('a guest with no cookie receives none of either screen, and no read is performed', async () => {
    apiServes({ who: { kind: 'unauthenticated' } });
    for (const path of ALL) {
      const { status, html } = await get(path, '');
      expect(status, path).toBe(200);
      expect(html, path).toContain(EN.Console.signedOutTitle);
      for (const secret of SECRETS) expect(html, `${path} :: ${secret}`).not.toContain(secret);
    }
    expect(api.seen.filter((request) => request.url.includes('/platform/'))).toHaveLength(0);
  });

  it('a buyer and staff at aal1 receive none of either screen', async () => {
    for (const who of [{ kind: 'buyer' } as const, { kind: 'staff-aal1' } as const]) {
      apiServes({ who });
      for (const path of ALL) {
        const { html } = await get(path);
        for (const secret of SECRETS) expect(html, `${path} :: ${secret}`).not.toContain(secret);
      }
      expect(api.seen.filter((request) => request.url.includes('/platform/')), who.kind).toHaveLength(0);
    }
  });

  /**
   * The section nobody but an administrator sees any of. Both of these roles hold real keys and a good deal of
   * the console; this is the one place they are refused outright.
   */
  it('a moderator and a support agent are refused, and no read is performed', async () => {
    for (const permissions of [MODERATOR, SUPPORT_AGENT]) {
      apiServes({ who: { kind: 'staff', permissions } });
      for (const path of ALL) {
        const { html } = await get(path);
        expect(html, path).toContain(EN.Console.forbiddenTitle);
        expect(html, path).not.toContain(EN.Platform.pageIntro);
        for (const secret of SECRETS) expect(html, `${path} :: ${secret}`).not.toContain(secret);
      }
      expect(api.seen.filter((request) => request.url.includes('/platform/'))).toHaveLength(0);
    }
  });

  it('never performs a read outside the gate, so a refusal costs nothing', async () => {
    apiServes({ who: { kind: 'staff', permissions: [] } });
    await get(JOBS_PAGE);
    await get(RUN_PAGE);
    // The gate is a server component inside the page, so a refused subtree is never invoked at all — and this
    // page performs four reads when it does render, so the saving is not incidental.
    expect(api.seen.filter((request) => request.url.includes('/v1/admin/platform'))).toHaveLength(0);
  });
});

describe('what an administrator sees', () => {
  it('renders all four panels', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get(JOBS_PAGE);

    expect(html).toContain(EN.Platform.scheduleHeading);
    expect(html).toContain(EN.Platform.problemsHeading);
    expect(html).toContain(EN.Platform.outboxHeading);
    expect(html).toContain(EN.Platform.runsHeading);
    // And their contents.
    expect(html).toContain(JOB_KEY);
    expect(html).toContain(JOB_PURPOSE);
    expect(html).toContain(TARGET);
    expect(html).toContain(PROBLEM_SENTENCE);
    expect(html).toContain('914137');
  });

  it('states that no relay is running, next to the numbers', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get(JOBS_PAGE);

    // The figures are accurate and would read as a live incident without this.
    expect(html).toContain(EN.Platform.noRelayNote);
  });

  it('states that the worker’s jobs record nothing, beside the schedule', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get(JOBS_PAGE);
    expect(html).toContain(EN.Platform.workerJobsNote);
  });

  it('says why dead letters are grouped rather than listed', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get(JOBS_PAGE);
    expect(html).toContain(EN.Platform.deadLettersGroupedNote);
  });

  it('renders one run with its contract row', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get(RUN_PAGE);

    expect(html).toContain(JOB_KEY);
    expect(html).toContain(EN.Platform.contractHeading);
    expect(html).toContain(TARGET);
    expect(html).toContain(JOB_PURPOSE);
    expect(html).toContain(EN.Platform.failureHeading);
    expect(html).toContain('23514');
  });
});

describe('the raw failure text never renders, and the page says so', () => {
  it('refuses a drifted body outright rather than rendering the part it recognises', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'leaky' });
    // The flight payload escapes its own quotes, so it is unescaped before anything is looked for in it.
    const payload = (await get(RUN_PAGE)).html.replaceAll('\\"', '"');

    for (const value of NEVER) expect(payload, value).not.toContain(value);
    // `.strict()`, so the whole read fails: a stronger property than filtering, because nothing has to
    // remember to filter.
    expect(payload).toContain(EN.Console.unavailableTitle);
  });

  it('says the failure text is absent rather than silently showing less', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get(RUN_PAGE);

    expect(html).toContain(EN.Platform.noMessageNote);
    expect(html).not.toContain('sqlerrm');
    expect(html).not.toContain('"details"');
  });
});

describe('nothing identifying an outbox event renders', () => {
  it('drops the whole outbox panel rather than render a drifted body', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'leaky' });
    const payload = (await get(JOBS_PAGE)).html.replaceAll('\\"', '"');

    for (const value of NEVER) expect(payload, value).not.toContain(value);
    // The panel renders nothing at all when its body does not match the contract, rather than a partial one.
    expect(payload).not.toContain(EN.Platform.deadLettersHeading);
  });

  it('renders counts and classes and no identifier on the good path', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const payload = (await get(JOBS_PAGE)).html.replaceAll('\\"', '"');

    expect(payload).toContain('order.placed');
    expect(payload).toContain('TransportError');
    // Named as the whole JSON key each would be: the framework's own runtime happens to contain the bare word
    // `payload`, so a substring search would assert something other than the property under test.
    for (const forbidden of ['aggregateId', 'aggregate_id', 'payload', 'createdBy', 'created_by']) {
      expect(payload, forbidden).not.toContain(`"${forbidden}":`);
    }
    // And no canary value from the fixture, by any route.
    for (const value of NEVER) expect(payload, value).not.toContain(value);
  });
});

describe('there is no control anywhere on this section', () => {
  it('renders no form and no button on either page', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    for (const path of ALL) {
      const { html } = await get(path);
      // The console shell has its own controls — the section menu and the language switch — so the assertion
      // is about this page's own subtree: no form element at all, which every write control on this console is
      // built from.
      expect(html, path).not.toContain('<form');
      expect(html, path).not.toContain('method="post"');
    }
  });

  it('says the section is read-only, and why', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    for (const path of ALL) {
      const { html } = await get(path);
      expect(html, path).toContain(EN.Platform.readOnlyNote);
    }
  });

  it('serves nothing at any route a retry, replay or re-run control would post to', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    for (const path of [
      '/api/platform/job-runs/retry',
      '/api/platform/outbox/retry',
      '/api/platform/outbox/replay',
      '/api/platform/jobs/run',
      '/api/platform/sweep',
    ]) {
      const response = await fetch(`${app.baseUrl}${CONSOLE}${path}`, {
        method: 'POST',
        headers: { origin: app.baseUrl, 'content-type': 'application/json', cookie: SESSION },
        body: JSON.stringify({ runId: RUN }),
      });
      expect(response.status, path).toBe(404);
    }
  });
});

describe('no verdict is rendered', () => {
  it('shows ages as ages, with nothing calling one of them late', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get(JOBS_PAGE);

    expect(html).toContain(EN.Platform.oldestPendingLabel);
    expect(html).toContain('2026-04-01 09:00');
    // No health verdict of this console's own invention.
    for (const word of ['unhealthy', 'Unhealthy', 'stale', 'Stale', 'overdue', 'Overdue']) {
      expect(html, word).not.toContain(word);
    }
  });
});

describe('every state is a state', () => {
  it('renders a clean schedule as the good answer it is', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'clean' });
    const { html } = await get(JOBS_PAGE);

    expect(html).toContain(EN.Platform.problemsNone);
    expect(html).not.toContain(PROBLEM_SENTENCE);
    expect(html).toContain(EN.Platform.deadLettersNone);
  });

  it('renders a never-run job without inventing a status for it', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'neverRun' });
    const { html } = await get(JOBS_PAGE);

    expect(html).toContain(EN.Platform.neverRun);
    expect(html).not.toContain(EN.Platform.status.succeeded);
  });

  it('renders a running run without a duration', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'running' });
    const { html } = await get(RUN_PAGE);

    expect(html).toContain(EN.Platform.stillRunning);
    expect(html).toContain(EN.Platform.status.running);
    expect(html).not.toContain(EN.Platform.failureHeading);
  });

  it('labels a run whose key the schedule has dropped rather than hiding it', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'uncontracted' });
    const list = await get(JOBS_PAGE);
    expect(list.html).toContain(EN.Platform.uncontractedBadge);

    const detail = await get(RUN_PAGE);
    expect(detail.html).toContain(EN.Platform.uncontractedNote);
    expect(detail.html).not.toContain(EN.Platform.contractHeading);
  });

  it('renders an empty run list as its own answer', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'empty' });
    const { html } = await get(JOBS_PAGE);
    expect(html).toContain(EN.Platform.runsEmptyTitle);
    expect(html).toContain(EN.Platform.scheduleEmptyTitle);
  });

  it('renders a run that is not this caller’s to see as the neutral answer', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'notFound' });
    const { html } = await get(RUN_PAGE);
    expect(html).toContain(EN.Platform.notFoundTitle);
    expect(html).not.toContain(JOB_PURPOSE);
  });

  it('renders an unreadable answer as an outage', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'unavailable' });
    for (const path of ALL) {
      const { html } = await get(path);
      expect(html, path).toContain(EN.Console.unavailableTitle);
    }
  });

  it('offers the next page only when there is one', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'paged' });
    const paged = await get(JOBS_PAGE);
    expect(paged.html).toContain(EN.Platform.nextPage);
    expect(paged.html).toContain('cursor=anIxfGNhbmFyeQ');

    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const last = await get(JOBS_PAGE);
    expect(last.html).not.toContain(EN.Platform.nextPage);
  });

  it('narrows the runs to one job and offers a way back', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get(`${JOBS_PAGE}?jobName=${encodeURIComponent(JOB_KEY)}`);

    expect(html).toContain(EN.Platform.clearFilter);
    expect(new URL(api.seen.find((r) => r.url.includes('job-runs'))!.url, 'http://x').searchParams.get('jobName')).toBe(
      JOB_KEY,
    );
  });
});

describe('both languages', () => {
  it('renders both screens in Arabic, right to left, with none of the English', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN, locale: 'ar' } });
    for (const [path, en, ar] of [
      [JOBS_PAGE, EN.Platform.pageIntro, AR.Platform.pageIntro],
      [RUN_PAGE, EN.Platform.runDetailIntro, AR.Platform.runDetailIntro],
    ] as const) {
      const { html } = await get(path);
      expect(html, path).toContain('dir="rtl"');
      expect(html, path).toContain('lang="ar"');
      expect(html, path).toContain(ar);
      expect(html, path).not.toContain(en);
    }
  });

  it('renders the two standing facts in Arabic too', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN, locale: 'ar' } });
    const { html } = await get(JOBS_PAGE);

    expect(html).toContain(AR.Platform.noRelayNote);
    expect(html).toContain(AR.Platform.workerJobsNote);
    expect(html).toContain(AR.Platform.readOnlyNote);
    expect(html).not.toContain(EN.Platform.noRelayNote);
  });

  it('refuses in Arabic too, with none of the data', async () => {
    apiServes({ who: { kind: 'staff', permissions: [], locale: 'ar' } });
    for (const path of ALL) {
      const { html } = await get(path);
      expect(html, path).toContain('dir="rtl"');
      for (const secret of SECRETS) expect(html, `${path} :: ${secret}`).not.toContain(secret);
    }
  });
});
