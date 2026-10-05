import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  FileMessagingReportResponseSchema,
  REPORT_REASON_CODES,
  SESSION_TOKEN_HEADER,
} from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { AuthenticationRequiredError } from '../src/auth/auth-errors.js';
import { DURABLE_THROTTLE_COUNTER, REDIS_THROTTLE_COUNTER } from '../src/auth/login-throttle.service.js';
import { SUPABASE_AUTH_CLIENT } from '../src/auth/login.service.js';
import { MESSAGING_THROTTLE_BUCKETS } from '../src/messaging/messaging-throttle.service.js';
import { MESSAGING_WRITE_STORE } from '../src/messaging/messaging-write.service.js';
import { MESSAGING_STORE } from '../src/messaging/messaging.service.js';
import { CURRENT_USER_STORE } from '../src/users/current-user.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * Reporting at the API boundary (Phase 5-H).
 *
 * The properties this suite exists for:
 *
 * **The reporter is the session.** Every attempt below to name somebody else — a body field, a query
 * parameter — is refused or ignored, and the store is asked with the token's own id every time.
 *
 * **A refusal says nothing about existence.** A message the caller may not report and one that is not
 * there produce the same status, code and body, compared byte for byte.
 *
 * **Nothing else happens.** The store is asked to file a report and nothing else: no close, no mute, no
 * membership change, no moderation call exists to make.
 *
 * Everything is stubbed at the store and counter boundaries: no database, no Redis, no network.
 */

const ACCESS_TOKEN = 'caller-access-token-value-not-a-real-token';
const CALLER = '11111111-1111-4111-8111-111111111111';
const IMPOSTOR = '99999999-9999-4999-8999-999999999999';
const MESSAGE = 'a1000000-0000-4000-8000-000000000005';
const CONVERSATION = 'e0000000-0000-4000-8000-000000000001';
const REPORT = 'c0000000-0000-4000-8000-00000000000a';

interface ReportCall {
  userId: string;
  subjectType: string;
  subjectId: string;
  reasonCode: string;
}

interface Recorded {
  readonly reports: ReportCall[];
  readonly buckets: string[];
  readonly otherCalls: string[];
}

interface Doubles {
  readonly outcome?: string;
  readonly reportId?: string | null;
  readonly storeThrows?: boolean;
  readonly unauthenticated?: boolean;
  readonly overLimit?: readonly string[];
  readonly redisThrows?: boolean;
  readonly durableThrows?: boolean;
}

let app: NestFastifyApplication | undefined;

async function start(doubles: Doubles = {}): Promise<Recorded> {
  const recorded: Recorded = { reports: [], buckets: [], otherCalls: [] };

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

  const note = (name: string) => () => {
    recorded.otherCalls.push(name);
    throw new Error(`${name} must not be called while filing a report`);
  };

  const store = {
    messagingFileReport: async (input: ReportCall) => {
      recorded.reports.push(input);
      if (doubles.storeThrows === true) throw new Error('database unavailable');
      const outcome = doubles.outcome ?? 'filed';
      return {
        outcome,
        reportId: doubles.reportId === undefined ? (outcome === 'filed' ? REPORT : null) : doubles.reportId,
      };
    },
    messagingStartConversation: note('start'),
    messagingSendMessage: note('send'),
    messagingMarkRead: note('markRead'),
    messagingSetMuted: note('setMuted'),
    messagingLeaveConversation: note('leave'),
    messagingCloseConversation: note('close'),
    messagingConversationMessages: note('readBack'),
    messagingInbox: note('inbox'),
    messagingUnreadCount: note('unread'),
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
    .overrideProvider(MESSAGING_STORE)
    .useValue(store)
    .overrideProvider(MESSAGING_WRITE_STORE)
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

async function post(
  body: unknown,
  headers: Record<string, string> = {},
  path = '/v1/messaging/reports',
): Promise<Result> {
  const response = await app!.inject({
    method: 'POST',
    url: path,
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

function comparable(body: Record<string, unknown>): string {
  const { instance: _instance, ...rest } = body;
  return JSON.stringify(rest);
}

const MESSAGE_REPORT = { subjectType: 'message', subjectId: MESSAGE, reasonCode: 'harassment' };
const CONVERSATION_REPORT = { subjectType: 'conversation', subjectId: CONVERSATION, reasonCode: 'spam' };

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('authentication and the internal credential', () => {
  it('refuses a report with no session, without asking the store', async () => {
    const recorded = await start();
    const response = await app!.inject({
      method: 'POST',
      url: '/v1/messaging/reports',
      headers: { [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL },
      payload: MESSAGE_REPORT as never,
    });

    expect(response.statusCode).toBe(401);
    expect(recorded.reports).toHaveLength(0);
  });

  it('refuses a report whose token the provider will not accept', async () => {
    const recorded = await start({ unauthenticated: true });
    const response = await post(MESSAGE_REPORT);

    expect(response.status).toBe(401);
    expect(recorded.reports).toHaveLength(0);
  });

  it('refuses a report with no internal credential', async () => {
    const recorded = await start();
    const response = await app!.inject({
      method: 'POST',
      url: '/v1/messaging/reports',
      headers: { [SESSION_TOKEN_HEADER]: ACCESS_TOKEN },
      payload: MESSAGE_REPORT as never,
    });

    expect(response.statusCode).toBe(403);
    expect(recorded.reports).toHaveLength(0);
  });
});

describe('filing a report', () => {
  it('reports a message and answers with the report that is now open', async () => {
    const recorded = await start();
    const response = await post(MESSAGE_REPORT);

    expect(response.status).toBe(200);
    expect(FileMessagingReportResponseSchema.safeParse(response.body).success).toBe(true);
    expect(response.body).toEqual({ outcome: 'filed', reportId: REPORT });
    expect(recorded.reports).toEqual([
      { userId: CALLER, subjectType: 'message', subjectId: MESSAGE, reasonCode: 'harassment' },
    ]);
  });

  it('reports a conversation', async () => {
    const recorded = await start();
    const response = await post(CONVERSATION_REPORT);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ outcome: 'filed', reportId: REPORT });
    expect(recorded.reports).toEqual([
      { userId: CALLER, subjectType: 'conversation', subjectId: CONVERSATION, reasonCode: 'spam' },
    ]);
  });

  it('maps the two subject types exactly, and refuses every other one', async () => {
    const recorded = await start();
    for (const subjectType of ['seller', 'user', 'listing', 'review', 'promotion', 'Message', '']) {
      const response = await post({ subjectType, subjectId: MESSAGE, reasonCode: 'spam' });
      expect(response.status, subjectType).toBe(400);
      expect(response.body['code'], subjectType).toBe('VALIDATION_FAILED');
    }
    expect(recorded.reports).toHaveLength(0);
  });

  it('accepts every reason the platform already has, and no invented one', async () => {
    const recorded = await start();
    for (const reasonCode of REPORT_REASON_CODES) {
      const response = await post({ subjectType: 'message', subjectId: MESSAGE, reasonCode });
      expect(response.status, reasonCode).toBe(200);
    }
    expect(recorded.reports).toHaveLength(REPORT_REASON_CODES.length);

    await app?.close();
    await start();
    for (const reasonCode of ['rude_messages', 'other_stuff', '', 'OTHER']) {
      const response = await post({ subjectType: 'message', subjectId: MESSAGE, reasonCode });
      expect(response.status, reasonCode).toBe(400);
    }
  });

  it('refuses an identifier that is not a uuid', async () => {
    const recorded = await start();
    for (const subjectId of ['not-a-uuid', '', '12345', `${MESSAGE} `]) {
      const response = await post({ subjectType: 'message', subjectId, reasonCode: 'spam' });
      expect(response.status, subjectId).toBe(400);
    }
    expect(recorded.reports).toHaveLength(0);
  });

  it('refuses a body that names a reporter, and one that carries details', async () => {
    const recorded = await start();
    for (const extra of [
      { reporterUserId: IMPOSTOR },
      { userId: IMPOSTOR },
      { details: 'He said: <the whole message>' },
      { status: 'actioned' },
      { priority: 'high' },
    ]) {
      const response = await post({ ...MESSAGE_REPORT, ...extra });
      expect(response.status, JSON.stringify(extra)).toBe(400);
    }
    expect(recorded.reports).toHaveLength(0);
  });

  it('ignores a reporter named in the query string', async () => {
    const recorded = await start();
    const response = await post(MESSAGE_REPORT, {}, `/v1/messaging/reports?userId=${IMPOSTOR}`);

    expect(response.status).toBe(200);
    expect(recorded.reports[0]?.userId).toBe(CALLER);
  });

  it('answers the same report id when the same thing is reported again', async () => {
    const recorded = await start();
    const first = await post(MESSAGE_REPORT);
    const second = await post(MESSAGE_REPORT);

    expect(first.body).toEqual(second.body);
    expect(second.body['reportId']).toBe(REPORT);
    // Two requests, two calls, one report: the deduplication is the database's, not a cache here.
    expect(recorded.reports).toHaveLength(2);
  });

  it('asks the store for nothing but the report', async () => {
    const recorded = await start();
    await post(MESSAGE_REPORT);
    expect(recorded.otherCalls).toEqual([]);
  });
});

describe('refusals', () => {
  it('gives an inaccessible target and a nonexistent one the same answer, byte for byte', async () => {
    await start({ outcome: 'not_found', reportId: null });
    const inaccessible = await post(MESSAGE_REPORT);
    const missing = await post({
      subjectType: 'message',
      subjectId: 'a1000000-0000-4000-8000-0000000000ff',
      reasonCode: 'harassment',
    });

    expect(inaccessible.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(inaccessible.body['code']).toBe('MESSAGING_REPORT_TARGET_NOT_FOUND');
    expect(comparable(inaccessible.body)).toBe(comparable(missing.body));
  });

  it('never answers 403 for a target that is not the caller’s', async () => {
    await start({ outcome: 'not_found', reportId: null });
    const response = await post(CONVERSATION_REPORT);

    expect(response.status).not.toBe(403);
    expect(response.status).toBe(404);
    expect(response.body['detail']).toBe('The reported item could not be found.');
  });

  it('answers the same way for a subject the database calls invalid', async () => {
    await start({ outcome: 'invalid', reportId: null });
    const response = await post(MESSAGE_REPORT);

    expect(response.status).toBe(404);
    expect(response.body['code']).toBe('MESSAGING_REPORT_TARGET_NOT_FOUND');
  });

  it('answers 503 when the store cannot be reached, and never a success', async () => {
    await start({ storeThrows: true });
    const response = await post(MESSAGE_REPORT);

    expect(response.status).toBe(503);
    expect(response.body['code']).toBe('SERVICE_UNAVAILABLE');
  });

  it('uses the problem-details envelope for every refusal', async () => {
    await start({ outcome: 'not_found', reportId: null });
    const response = await post(MESSAGE_REPORT);

    expect(response.body).toMatchObject({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      code: 'MESSAGING_REPORT_TARGET_NOT_FOUND',
      instance: '/v1/messaging/reports',
    });
  });

  it('leaks no token and no internal detail in any answer', async () => {
    for (const doubles of [{}, { outcome: 'not_found', reportId: null }, { storeThrows: true }]) {
      await app?.close();
      await start(doubles);
      const response = await post(MESSAGE_REPORT);
      for (const secret of [ACCESS_TOKEN, TEST_INTERNAL_CREDENTIAL, 'database', 'app_private', 'file_report']) {
        expect(response.raw, secret).not.toContain(secret);
      }
    }
  });
});

describe('the rate limit', () => {
  it('counts one attempt in the approved bucket, whose numbers are 10 per hour', async () => {
    const recorded = await start();
    await post(MESSAGE_REPORT);

    expect(recorded.buckets).toEqual([MESSAGING_THROTTLE_BUCKETS.report.name]);
    expect(MESSAGING_THROTTLE_BUCKETS.report).toMatchObject({ limit: 10, windowSeconds: 3600 });
  });

  it('allows the tenth and refuses the eleventh', async () => {
    // The counter answers for the first ten and refuses after that, which is the boundary itself.
    let calls = 0;
    const recorded = await start();
    void recorded;
    await app?.close();

    const counter = {
      hit: async () => {
        calls += 1;
        return calls <= 10;
      },
    };
    const store = {
      messagingFileReport: async () => ({ outcome: 'filed', reportId: REPORT }),
    };
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(TEST_ENV)] })
      .overrideProvider(SUPABASE_AUTH_CLIENT)
      .useValue({
        getUser: async () => ({ id: CALLER, phone: null }),
        signInWithPassword: async () => {
          throw new Error('no');
        },
        revokeAllSessions: async () => {
          throw new Error('no');
        },
      })
      .overrideProvider(CURRENT_USER_STORE)
      .useValue({ userIdentity: async (userId: string) => ({ id: userId, displayName: 'Nadia' }) })
      .overrideProvider(REDIS_THROTTLE_COUNTER)
      .useValue(counter)
      .overrideProvider(DURABLE_THROTTLE_COUNTER)
      .useValue(counter)
      .overrideProvider(MESSAGING_STORE)
      .useValue(store)
      .overrideProvider(MESSAGING_WRITE_STORE)
      .useValue(store)
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      createFastifyAdapter(TEST_ENV, { logStream: { write: () => undefined } }),
      NEST_APP_OPTIONS,
    );
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const response = await post(MESSAGE_REPORT);
      expect(response.status, `attempt ${attempt}`).toBe(200);
    }
    const eleventh = await post(MESSAGE_REPORT);
    expect(eleventh.status).toBe(429);
    expect(eleventh.body['code']).toBe('THROTTLED');
  });

  it('refuses without asking the store once the bucket is full', async () => {
    const recorded = await start({ overLimit: [MESSAGING_THROTTLE_BUCKETS.report.name] });
    const response = await post(MESSAGE_REPORT);

    expect(response.status).toBe(429);
    expect(recorded.reports).toHaveLength(0);
  });

  it('falls back to the durable counter when Redis cannot answer', async () => {
    const recorded = await start({ redisThrows: true });
    const response = await post(MESSAGE_REPORT);

    expect(response.status).toBe(200);
    expect(recorded.buckets).toEqual([`durable:${MESSAGING_THROTTLE_BUCKETS.report.name}`]);
  });

  it('fails closed when neither counter can answer', async () => {
    const recorded = await start({ redisThrows: true, durableThrows: true });
    const response = await post(MESSAGE_REPORT);

    expect(response.status).toBe(503);
    expect(recorded.reports).toHaveLength(0);
  });
});

describe('the operations reporting does not have', () => {
  it('offers no way to list, read, edit or withdraw a report', async () => {
    await start();
    for (const [method, path] of [
      ['GET', '/v1/messaging/reports'],
      ['GET', `/v1/messaging/reports/${REPORT}`],
      ['PUT', `/v1/messaging/reports/${REPORT}`],
      ['PATCH', `/v1/messaging/reports/${REPORT}`],
      ['DELETE', `/v1/messaging/reports/${REPORT}`],
      ['POST', `/v1/messaging/reports/${REPORT}/resolve`],
      ['POST', '/v1/messaging/moderation'],
    ] as const) {
      const response = await app!.inject({
        method,
        url: path,
        headers: {
          [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL,
          [SESSION_TOKEN_HEADER]: ACCESS_TOKEN,
        },
      });
      expect(response.statusCode, `${method} ${path}`).toBe(404);
    }
  });
});
