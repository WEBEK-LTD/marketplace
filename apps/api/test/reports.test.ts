import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  FileReportResponseSchema,
  REPORT_REASON_CODES,
  REPORT_STATUSES,
  REPORT_SUBJECT_TYPES,
  ReporterReportsResponseSchema,
  SESSION_TOKEN_HEADER,
} from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { AuthenticationRequiredError } from '../src/auth/auth-errors.js';
import { DURABLE_THROTTLE_COUNTER, REDIS_THROTTLE_COUNTER } from '../src/auth/login-throttle.service.js';
import { SUPABASE_AUTH_CLIENT } from '../src/auth/login.service.js';
import { REPORT_THROTTLE_BUCKETS } from '../src/reports/reports-throttle.service.js';
import { REPORTS_STORE } from '../src/reports/reports.service.js';
import { CURRENT_USER_STORE } from '../src/users/current-user.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * Reports at the API boundary, the reporter side (Phase 7-M).
 *
 * The properties this suite exists for:
 *
 * **The reporter is the session.** Every attempt below to name somebody else — a body field, a query
 * parameter, a header — is refused or ignored, and the store is asked with the token's own id every time.
 *
 * **There is no subject id to send.** The request names a slug, and a body carrying a `subjectId`,
 * `listingId` or `sellerUserId` is refused by the strict schema rather than filtered. What reaches the store
 * is the slug, unchanged and uninterpreted.
 *
 * **A refusal says nothing about existence.** A subject the caller may not report and one that is not there
 * produce the same status, code and body, compared byte for byte.
 *
 * **Nothing about moderation is accepted or returned.** No request can carry a status, a priority or an
 * assignee, and a history row that arrived with one would fail response validation rather than reach a
 * browser.
 *
 * **Filing counts against one bucket and nothing else.** No support bucket, no messaging bucket, no seller
 * bucket; and the count happens before the subject is resolved, so a refused attempt still counts.
 *
 * Everything is stubbed at the store and counter boundaries: no database, no Redis, no network.
 */

const ACCESS_TOKEN = 'caller-access-token-value-not-a-real-token';
const CALLER = '11111111-1111-4111-8111-111111111111';
const IMPOSTOR = '99999999-9999-4999-8999-999999999999';
const REPORT = 'c0000000-0000-4000-8000-00000000000a';
const SLUG = 'a-real-listing-slug';

const VALID = { subjectType: 'listing', subjectSlug: SLUG, reasonCode: 'counterfeit' } as const;

interface FilingCall {
  userId: string;
  subjectType: string;
  subjectSlug: string;
  reasonCode: string;
  details: string | null;
}

interface HistoryCall {
  userId: string;
  limit: number;
  cursorCreatedAt: Date | null;
  cursorId: string | null;
}

const ROW = {
  id: REPORT,
  subjectType: 'listing',
  subjectSlug: SLUG,
  subjectLabel: 'A real listing',
  reasonCode: 'counterfeit',
  details: 'What they did.',
  status: 'open',
  createdAt: new Date('2026-05-01T09:00:00.000Z'),
};

interface Recorded {
  readonly filings: FilingCall[];
  readonly histories: HistoryCall[];
  readonly buckets: string[];
}

interface Doubles {
  readonly outcome?: string;
  readonly reportId?: string | null;
  readonly storeThrows?: boolean;
  readonly unauthenticated?: boolean;
  readonly overLimit?: readonly string[];
  readonly redisThrows?: boolean;
  readonly durableThrows?: boolean;
  readonly rows?: readonly Record<string, unknown>[];
}

let app: NestFastifyApplication | undefined;

async function start(doubles: Doubles = {}): Promise<Recorded> {
  const recorded: Recorded = { filings: [], histories: [], buckets: [] };

  const redis = {
    hit: async (bucket: string) => {
      if (doubles.redisThrows === true) throw new Error('redis is gone');
      recorded.buckets.push(bucket);
      return !(doubles.overLimit ?? []).includes(bucket);
    },
  };
  const durable = {
    hit: async (bucket: string) => {
      if (doubles.durableThrows === true) throw new Error('the database is gone');
      recorded.buckets.push(`durable:${bucket}`);
      return !(doubles.overLimit ?? []).includes(bucket);
    },
  };

  const store = {
    reportFileForReporter: async (input: FilingCall) => {
      recorded.filings.push(input);
      if (doubles.storeThrows === true) throw new Error('database unavailable');
      const outcome = doubles.outcome ?? 'filed';
      return {
        outcome,
        reportId: doubles.reportId === undefined ? (outcome === 'filed' ? REPORT : null) : doubles.reportId,
      };
    },
    reportsForReporter: async (input: HistoryCall) => {
      recorded.histories.push(input);
      if (doubles.storeThrows === true) throw new Error('database unavailable');
      return doubles.rows ?? [ROW];
    },
  };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(TEST_ENV)] })
    .overrideProvider(SUPABASE_AUTH_CLIENT)
    .useValue({
      getUser: async () => {
        if (doubles.unauthenticated === true) throw new AuthenticationRequiredError();
        return { id: CALLER, phone: null };
      },
      signInWithPassword: async () => {
        throw new Error('filing a report must never sign anyone in');
      },
      revokeAllSessions: async () => {
        throw new Error('filing a report must never revoke a session');
      },
    })
    .overrideProvider(CURRENT_USER_STORE)
    .useValue({ userIdentity: async (userId: string) => ({ id: userId, displayName: 'Nadia' }) })
    .overrideProvider(REDIS_THROTTLE_COUNTER)
    .useValue(redis)
    .overrideProvider(DURABLE_THROTTLE_COUNTER)
    .useValue(durable)
    .overrideProvider(REPORTS_STORE)
    .useValue(store)
    .compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(
    createFastifyAdapter(TEST_ENV, { logStream: { write: () => undefined } }),
    NEST_APP_OPTIONS,
  );
  await configureApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return recorded;
}

interface Result {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly raw: string;
}

async function post(body: unknown, headers: Record<string, string> = {}): Promise<Result> {
  const response = await app!.inject({
    method: 'POST',
    url: '/v1/reports',
    headers: {
      [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL,
      [SESSION_TOKEN_HEADER]: ACCESS_TOKEN,
      ...headers,
    },
    payload: body as never,
  });
  return {
    status: response.statusCode,
    body: response.body.length > 0 ? (JSON.parse(response.body) as Record<string, unknown>) : {},
    raw: response.body,
  };
}

async function get(query = '', headers: Record<string, string> = {}): Promise<Result> {
  const response = await app!.inject({
    method: 'GET',
    url: `/v1/reports${query}`,
    headers: {
      [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL,
      [SESSION_TOKEN_HEADER]: ACCESS_TOKEN,
      ...headers,
    },
  });
  return {
    status: response.statusCode,
    body: response.body.length > 0 ? (JSON.parse(response.body) as Record<string, unknown>) : {},
    raw: response.body,
  };
}

function comparable(body: Record<string, unknown>): string {
  const { instance: _instance, ...rest } = body;
  return JSON.stringify(rest);
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/* ------------------------------------------------------------------------------------------------ */

describe('filing a report', () => {
  it('files one and answers with the report’s id', async () => {
    const recorded = await start();
    const result = await post(VALID);

    expect(result.status).toBe(201);
    expect(FileReportResponseSchema.parse(result.body)).toEqual({ outcome: 'filed', reportId: REPORT });
    expect(recorded.filings).toEqual([
      { userId: CALLER, subjectType: 'listing', subjectSlug: SLUG, reasonCode: 'counterfeit', details: null },
    ]);
  });

  it('passes the reporter’s own words through untouched, and an absent box as nothing', async () => {
    const recorded = await start();
    await post({ ...VALID, details: 'What they did.' });
    await post(VALID);

    expect(recorded.filings[0]!.details).toBe('What they did.');
    expect(recorded.filings[1]!.details).toBeNull();
  });

  it('files against either subject type and every existing reason code', async () => {
    const recorded = await start();
    for (const subjectType of REPORT_SUBJECT_TYPES) {
      for (const reasonCode of REPORT_REASON_CODES) {
        const result = await post({ subjectType, subjectSlug: SLUG, reasonCode });
        expect(result.status, `${subjectType}/${reasonCode}`).toBe(201);
      }
    }
    expect(recorded.filings).toHaveLength(REPORT_SUBJECT_TYPES.length * REPORT_REASON_CODES.length);
  });
});

describe('the reporter is the session', () => {
  it('ignores nothing and refuses everything that tries to name a reporter', async () => {
    const recorded = await start();
    for (const field of ['reporterUserId', 'reporterId', 'userId', 'accountId']) {
      const result = await post({ ...VALID, [field]: IMPOSTOR });
      expect(result.status, field).toBe(400);
    }
    expect(recorded.filings, 'nothing reached the store').toHaveLength(0);
  });

  it('asks the store with the token’s own account even when a header claims another', async () => {
    const recorded = await start();
    await post(VALID, { 'x-user-id': IMPOSTOR, 'x-reporter-id': IMPOSTOR });
    expect(recorded.filings[0]!.userId).toBe(CALLER);
  });

  it('refuses a request with no session, without asking the store anything', async () => {
    const recorded = await start();
    const result = await post(VALID, { [SESSION_TOKEN_HEADER]: '' });
    expect(result.status).toBe(401);
    expect(recorded.filings).toHaveLength(0);
    expect(recorded.buckets, 'and without spending an allowance').toHaveLength(0);
  });

  it('refuses a request whose session the provider rejects', async () => {
    const recorded = await start({ unauthenticated: true });
    const result = await post(VALID);
    expect(result.status).toBe(401);
    expect(recorded.filings).toHaveLength(0);
  });

  it('refuses a request without the internal credential', async () => {
    const recorded = await start();
    const result = await post(VALID, { [INTERNAL_CREDENTIAL_HEADER]: 'not-the-credential' });
    expect(result.status).toBe(403);
    expect(recorded.filings).toHaveLength(0);
  });
});

describe('there is no subject id to send', () => {
  it('refuses a body that names a row instead of a slug', async () => {
    const recorded = await start();
    for (const field of ['subjectId', 'listingId', 'sellerUserId', 'reviewId']) {
      const result = await post({ ...VALID, [field]: '22220000-0000-4000-8000-000000000001' });
      expect(result.status, field).toBe(400);
    }
    expect(recorded.filings).toHaveLength(0);
  });

  it('hands the slug to the store exactly as sent, interpreting nothing', async () => {
    const recorded = await start();
    await post({ ...VALID, subjectSlug: 'some-other-listing' });
    expect(recorded.filings[0]!.subjectSlug).toBe('some-other-listing');
  });

  it('refuses a slug that is not one before anything is read', async () => {
    const recorded = await start();
    for (const subjectSlug of ['Upper', 'has space', '../../etc/passwd', "a'; drop table reports--", '']) {
      const result = await post({ ...VALID, subjectSlug });
      expect(result.status, subjectSlug).toBe(400);
    }
    expect(recorded.filings).toHaveLength(0);
  });
});

describe('what a request cannot say', () => {
  it('refuses a status, a priority, an assignee or a resolution', async () => {
    const recorded = await start();
    for (const field of ['status', 'priority', 'assignedTo', 'resolution', 'resolutionNote', 'resolvedBy']) {
      const result = await post({ ...VALID, [field]: 'actioned' });
      expect(result.status, field).toBe(400);
    }
    expect(recorded.filings).toHaveLength(0);
  });

  it('refuses a subject type this surface does not file, before the store is asked', async () => {
    const recorded = await start();
    for (const subjectType of ['message', 'conversation', 'review', 'review_reply', 'user', 'promotion']) {
      const result = await post({ ...VALID, subjectType });
      expect(result.status, subjectType).toBe(400);
    }
    expect(recorded.filings, 'the contract stops these; the database stops the rest').toHaveLength(0);
  });

  it('refuses a reason the reports table does not allow', async () => {
    const recorded = await start();
    const result = await post({ ...VALID, reasonCode: 'because_i_said' });
    expect(result.status).toBe(400);
    expect(recorded.filings).toHaveLength(0);
  });

  it('refuses details past the column’s own length', async () => {
    const recorded = await start();
    expect((await post({ ...VALID, details: 'x'.repeat(4001) })).status).toBe(400);
    expect((await post({ ...VALID, details: 'x'.repeat(4000) })).status).toBe(201);
    expect(recorded.filings).toHaveLength(1);
  });
});

describe('the outcomes, and what they do not disclose', () => {
  it('answers a hidden subject and an absent one identically, byte for byte', async () => {
    await start({ outcome: 'not_found' });
    const hidden = await post({ ...VALID, subjectSlug: 'a-draft-listing' });
    const absent = await post({ ...VALID, subjectSlug: 'never-existed-at-all' });

    expect(hidden.status).toBe(404);
    expect(absent.status).toBe(404);
    expect(comparable(hidden.body)).toBe(comparable(absent.body));
    expect(hidden.body['code']).toBe('NOT_FOUND');
    // Neither mentions the slug, the subject or why.
    for (const raw of [hidden.raw, absent.raw]) {
      expect(raw).not.toContain('a-draft-listing');
      expect(raw).not.toContain('never-existed-at-all');
      expect(raw).not.toContain('draft');
      expect(raw).not.toContain('suspended');
    }
  });

  it('answers a subject type the database refuses with its own conflict', async () => {
    await start({ outcome: 'invalid' });
    const result = await post(VALID);
    expect(result.status).toBe(409);
    expect(result.body['code']).toBe('REPORT_SUBJECT_NOT_REPORTABLE');
  });

  it('answers reporting yourself with its own conflict, which names no account', async () => {
    await start({ outcome: 'own_subject' });
    const result = await post({ subjectType: 'seller', subjectSlug: 'my-own-shop', reasonCode: 'spam' });
    expect(result.status).toBe(409);
    expect(result.body['code']).toBe('REPORT_SUBJECT_IS_THE_REPORTER');
    expect(result.raw).not.toContain(CALLER);
    expect(result.raw).not.toContain('my-own-shop');
  });

  it('treats a filed outcome with no report id as a refusal rather than a success', async () => {
    await start({ outcome: 'filed', reportId: null });
    const result = await post(VALID);
    expect(result.status).toBe(404);
  });

  it('answers 503 when the database could not be reached, and says nothing else', async () => {
    await start({ storeThrows: true });
    const result = await post(VALID);
    expect(result.status).toBe(503);
    expect(result.raw).not.toContain('database');
    expect(result.raw).not.toContain('app_private');
    expect(result.raw).not.toContain('file_report');
  });
});

describe('the rate limit', () => {
  it('counts one bucket, and it is this surface’s own', async () => {
    const recorded = await start();
    await post(VALID);
    expect(recorded.buckets).toEqual([REPORT_THROTTLE_BUCKETS.fileReport.name]);
    expect(REPORT_THROTTLE_BUCKETS.fileReport.name).toBe('report_file');
    expect(REPORT_THROTTLE_BUCKETS.fileReport.limit).toBe(10);
    expect(REPORT_THROTTLE_BUCKETS.fileReport.windowSeconds).toBe(3600);
  });

  it('touches no support, messaging or seller bucket', async () => {
    const recorded = await start();
    await post(VALID);
    for (const bucket of recorded.buckets) {
      expect(bucket).not.toContain('support');
      expect(bucket).not.toContain('messaging');
      expect(bucket).not.toContain('seller');
    }
  });

  it('refuses over the limit, and files nothing', async () => {
    const recorded = await start({ overLimit: [REPORT_THROTTLE_BUCKETS.fileReport.name] });
    const result = await post(VALID);
    expect(result.status).toBe(429);
    expect(result.body['code']).toBe('THROTTLED');
    expect(recorded.filings).toHaveLength(0);
  });

  it('counts a refused attempt, so probing for slugs is not free', async () => {
    const recorded = await start({ outcome: 'not_found' });
    await post({ ...VALID, subjectSlug: 'not-a-thing-one' });
    await post({ ...VALID, subjectSlug: 'not-a-thing-two' });
    expect(recorded.buckets).toHaveLength(2);
  });

  it('counts before the subject is resolved', async () => {
    const recorded = await start({ overLimit: [REPORT_THROTTLE_BUCKETS.fileReport.name] });
    await post(VALID);
    expect(recorded.buckets).toHaveLength(1);
    expect(recorded.filings, 'the store was never asked').toHaveLength(0);
  });

  it('falls back to the durable counter when Redis cannot answer', async () => {
    const recorded = await start({ redisThrows: true });
    const result = await post(VALID);
    expect(result.status).toBe(201);
    expect(recorded.buckets).toEqual([`durable:${REPORT_THROTTLE_BUCKETS.fileReport.name}`]);
  });

  it('fails closed when neither counter can answer', async () => {
    const recorded = await start({ redisThrows: true, durableThrows: true });
    const result = await post(VALID);
    expect(result.status).toBe(503);
    expect(recorded.filings, 'and nothing is filed on the way past').toHaveLength(0);
  });

  it('does not limit the read', async () => {
    const recorded = await start();
    await get();
    expect(recorded.buckets).toHaveLength(0);
  });
});

describe('the reporter’s own reports', () => {
  it('returns the caller’s page, scoped to the caller', async () => {
    const recorded = await start();
    const result = await get();

    expect(result.status).toBe(200);
    const page = ReporterReportsResponseSchema.parse(result.body);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.id).toBe(REPORT);
    expect(page.items[0]!.createdAt).toBe('2026-05-01T09:00:00.000Z');
    expect(recorded.histories[0]!.userId).toBe(CALLER);
  });

  it('reads with the token’s account even when a query parameter names another', async () => {
    const recorded = await start();
    await get(`?reporterUserId=${IMPOSTOR}&userId=${IMPOSTOR}`);
    expect(recorded.histories[0]!.userId).toBe(CALLER);
  });

  it('refuses a read with no session', async () => {
    const recorded = await start();
    const result = await get('', { [SESSION_TOKEN_HEADER]: '' });
    expect(result.status).toBe(401);
    expect(recorded.histories).toHaveLength(0);
  });

  it('asks for one row more than the page, so the cursor is right at the boundary', async () => {
    const recorded = await start({ rows: [] });
    await get('?limit=5');
    expect(recorded.histories[0]!.limit).toBe(6);
  });

  it('answers a last page with no cursor and a full page with one', async () => {
    const two = [ROW, { ...ROW, id: 'c0000000-0000-4000-8000-00000000000b' }];
    await start({ rows: two });
    const last = await get('?limit=5');
    expect(ReporterReportsResponseSchema.parse(last.body).nextCursor).toBeNull();
    await app?.close();
    app = undefined;

    await start({ rows: two });
    const full = await get('?limit=1');
    const page = ReporterReportsResponseSchema.parse(full.body);
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
  });

  it('refuses a cursor it did not issue, in one way for every way of being wrong', async () => {
    const recorded = await start();
    for (const cursor of [
      'not-base64url!!',
      Buffer.from('rp1|nonsense|x', 'utf8').toString('base64url'),
      // A position from another list: the version tag is checked first.
      Buffer.from(`st1|2026-05-01T09:00:00.000Z|${REPORT}`, 'utf8').toString('base64url'),
      Buffer.from(`rp1|2026-02-31T09:00:00.000Z|${REPORT}`, 'utf8').toString('base64url'),
      Buffer.from(`rp1|2026-05-01T09:00:00.000Z|not-a-uuid`, 'utf8').toString('base64url'),
    ]) {
      const result = await get(`?cursor=${encodeURIComponent(cursor)}`);
      expect(result.status, cursor).toBe(400);
      expect(result.body['code'], cursor).toBe('REPORTS_CURSOR_INVALID');
    }
    expect(recorded.histories, 'nothing was read with a cursor that is not one').toHaveLength(0);
  });

  it('refuses a limit that is not a number, and clamps one that is too large', async () => {
    const recorded = await start({ rows: [] });
    expect((await get('?limit=abc')).status).toBe(400);
    expect((await get('?limit=0')).status).toBe(400);
    expect((await get('?limit=-1')).status).toBe(400);
    expect((await get('?limit=999')).status).toBe(200);
    expect(recorded.histories.at(-1)!.limit).toBe(51);
  });

  it('answers an account with no reports with an empty page rather than a refusal', async () => {
    await start({ rows: [] });
    const result = await get();
    expect(result.status).toBe(200);
    expect(ReporterReportsResponseSchema.parse(result.body)).toEqual({ items: [], nextCursor: null });
  });

  it('answers 503 when the history could not be read', async () => {
    await start({ storeThrows: true });
    const result = await get();
    expect(result.status).toBe(503);
  });
});

describe('no moderation state reaches the reporter', () => {
  it('carries the eight approved fields and no ninth, whatever the store returns', async () => {
    // A drifted reader that returned moderation state: the response must not carry it.
    await start({
      rows: [
        {
          ...ROW,
          subjectId: '22220000-0000-4000-8000-000000000001',
          priority: 'high',
          assignedTo: IMPOSTOR,
          resolution: 'actioned',
          resolutionNote: 'An internal note no reporter may read.',
          resolvedBy: IMPOSTOR,
          duplicateOfReportId: 'c0000000-0000-4000-8000-00000000000c',
          reporterUserId: CALLER,
        },
      ],
    });
    const result = await get();

    expect(result.status).toBe(200);
    expect(Object.keys(ReporterReportsResponseSchema.parse(result.body).items[0]!).sort()).toEqual([
      'createdAt',
      'details',
      'id',
      'reasonCode',
      'status',
      'subjectLabel',
      'subjectSlug',
      'subjectType',
    ]);
    for (const secret of [
      'An internal note no reporter may read.',
      IMPOSTOR,
      '22220000-0000-4000-8000-000000000001',
      'priority',
      'assignedTo',
      'resolutionNote',
      'duplicateOfReportId',
    ]) {
      expect(result.raw, secret).not.toContain(secret);
    }
  });

  it('reports the status in the database’s own vocabulary, for every one of the five', async () => {
    for (const status of REPORT_STATUSES) {
      await start({ rows: [{ ...ROW, status }] });
      const result = await get();
      expect(ReporterReportsResponseSchema.parse(result.body).items[0]!.status, status).toBe(status);
      await app?.close();
      app = undefined;
    }
  });

  it('carries no slug or label for a subject that has left public view', async () => {
    await start({ rows: [{ ...ROW, subjectSlug: null, subjectLabel: null }] });
    const result = await get();
    const row = ReporterReportsResponseSchema.parse(result.body).items[0]!;
    expect(row.subjectSlug).toBeNull();
    expect(row.subjectLabel).toBeNull();
    // And the report is still there, which is the point of a report outliving its subject.
    expect(row.id).toBe(REPORT);
  });
});

describe('what this surface cannot do at all', () => {
  it('has no operation that changes a report', async () => {
    await start();
    for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
      const response = await app!.inject({
        method,
        url: `/v1/reports/${REPORT}`,
        headers: {
          [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL,
          [SESSION_TOKEN_HEADER]: ACCESS_TOKEN,
        },
        payload: { status: 'dismissed' } as never,
      });
      expect(response.statusCode, method).toBe(404);
    }
  });

  it('has no queue, no triage and no other reporter’s reports', async () => {
    await start();
    for (const path of ['/v1/reports/queue', '/v1/reports/all', `/v1/reports/${REPORT}`]) {
      const response = await app!.inject({
        method: 'GET',
        url: path,
        headers: {
          [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL,
          [SESSION_TOKEN_HEADER]: ACCESS_TOKEN,
        },
      });
      expect(response.statusCode, path).toBe(404);
    }
  });
});
