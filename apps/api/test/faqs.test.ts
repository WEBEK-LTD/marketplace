import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  CreateFaqResponseSchema,
  FaqDetailResponseSchema,
  FaqPageResponseSchema,
  FaqTopicsResponseSchema,
  FaqWriteResponseSchema,
  PublicFaqsResponseSchema,
  SESSION_TOKEN_HEADER,
} from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { AuthenticationRequiredError } from '../src/auth/auth-errors.js';
import { FAQS_STORE } from '../src/admin/faqs.service.js';
import { FAQS_PUBLIC_STORE } from '../src/cms/faqs-public.service.js';
import { encodeFaqCursor } from '../src/admin/faqs.cursor.js';
import { SUPABASE_AUTH_CLIENT } from '../src/auth/login.service.js';
import { STAFF_CONSOLE_STORE, type StaffConsoleRow } from '../src/admin/staff-console.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * The help centre at the API boundary (0095).
 *
 * The properties this suite exists for:
 *
 * **A topic is required, and a value that is not a topic is a 400.** Owner decision 1 puts the mapping in a page's
 * `page_key`, so a caller that asks for nonsense has a bug and is told so rather than handed an empty answer.
 *
 * **An empty answer is a 200.** Owner decision 2: a topic with nothing published renders no section, and that is
 * not a failure.
 *
 * **An answer crosses the boundary exactly as stored**, blank lines included, because the renderer splits
 * paragraphs and nothing here may normalise them away (owner decision 3).
 *
 * **No write can publish anything.** Owner decision 6, asserted from both ends: `isPublished` in a create or a
 * change body is refused, and the store is asserted never to have been asked to change a state.
 *
 * **Reading and managing are separate keys**, and the split is visible: a caller with only `cms.faq.read` lists the
 * entries, gets `canManage: false`, and every write answers 404 — identical to an entry that does not exist.
 *
 * **The cursor is a position and nothing else.** A forged one is a 400, and a valid one is passed to the store as
 * three typed values.
 *
 * Everything is stubbed at the store boundary: no database, no Redis, no network.
 */

const STAFF = '11111111-1111-4111-8111-111111111111';
const FAQ = 'fe000000-0000-4000-8000-0000000000e1';
const SECOND = 'fe000000-0000-4000-8000-0000000000e2';

function token(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.c2lnbmF0dXJl`;
}

const ACCESS_TOKEN = token({ sub: STAFF, aal: 'aal2' });
const AAL1_TOKEN = token({ sub: STAFF, aal: 'aal1' });

const READ = 'cms.faq.read';
const MANAGE = 'cms.faq.manage';

/** Every other key a console surface uses. Not one of them opens this section. */
const OTHER_KEYS = [
  'sellers.profile.read',
  'users.profile.read',
  'audit.read',
  'moderation.report.read',
  'support.ticket.read',
  'cms.page.read',
  'cms.blog.read',
  'cms.banner.read',
  'cms.homepage.read',
  'cms.navigation.read',
  'seo.metadata.read',
] as const;

const ANSWER = 'Open a listing.\n\nThen press buy.';

const PUBLIC_ROW = {
  faqId: FAQ,
  question: 'How do I buy?',
  answer: ANSWER,
  sortOrder: 10,
};

const LIST_ROW = {
  faqId: FAQ,
  topic: 'faq',
  questionEn: 'How do I buy?',
  questionAr: null,
  answerEn: ANSWER,
  answerAr: null,
  sortOrder: 10,
  isPublished: true,
  isMapped: true,
  pageSlug: 'faq',
  createdAt: '2026-05-01T09:00:00.000Z',
  updatedAt: '2026-05-02T09:00:00.000Z',
  canManage: true,
};

const TOPIC_ROW = {
  topic: 'faq',
  entryCount: 3,
  publishedCount: 2,
  isMapped: true,
  pageSlug: 'faq',
};

interface Seen {
  name: string;
  input: unknown;
}

interface Doubles {
  permissions?: readonly string[];
  unauthenticated?: boolean;
  publicRows?: readonly unknown[];
  publicError?: boolean;
  listRows?: readonly unknown[];
  detailRow?: unknown;
  topicRows?: readonly unknown[];
  saveId?: string | null;
  writeResult?: boolean;
  writeError?: { code: string };
}

let app: NestFastifyApplication | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function sqlError(code: string): Error & { code: string } {
  const error = new Error('the database refused the write') as Error & { code: string };
  error.code = code;
  return error;
}

async function createApp(doubles: Doubles = {}): Promise<Seen[]> {
  const seen: Seen[] = [];

  const publicStore = {
    publicFaqs: async (input: unknown) => {
      seen.push({ name: 'publicFaqs', input });
      if (doubles.publicError === true) throw new Error('the database is unavailable');
      return doubles.publicRows ?? [PUBLIC_ROW];
    },
  };

  const write = async (name: string, input: unknown): Promise<boolean> => {
    seen.push({ name, input });
    if (doubles.writeError !== undefined) throw sqlError(doubles.writeError.code);
    return doubles.writeResult ?? true;
  };

  const adminStore = {
    faqTopicsForStaff: async (input: unknown) => {
      seen.push({ name: 'faqTopicsForStaff', input });
      return doubles.topicRows ?? [TOPIC_ROW];
    },
    faqsForStaff: async (input: unknown) => {
      seen.push({ name: 'faqsForStaff', input });
      return doubles.listRows ?? [LIST_ROW];
    },
    faqForStaff: async (input: unknown) => {
      seen.push({ name: 'faqForStaff', input });
      return doubles.detailRow === undefined ? LIST_ROW : doubles.detailRow;
    },
    faqSaveForStaff: async (input: unknown) => {
      seen.push({ name: 'faqSaveForStaff', input });
      if (doubles.writeError !== undefined) throw sqlError(doubles.writeError.code);
      return doubles.saveId === undefined ? FAQ : doubles.saveId;
    },
    faqStateForStaff: async (input: unknown) => write('faqStateForStaff', input),
    faqsReorderForStaff: async (input: unknown) => {
      seen.push({ name: 'faqsReorderForStaff', input });
      if (doubles.writeError !== undefined) throw sqlError(doubles.writeError.code);
      return 1;
    },
    faqDeleteForStaff: async (input: unknown) => write('faqDeleteForStaff', input),
  };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(TEST_ENV)] })
    .overrideProvider(SUPABASE_AUTH_CLIENT)
    .useValue({
      getUser: async () => {
        if (doubles.unauthenticated === true) throw new AuthenticationRequiredError();
        return { id: STAFF, phone: null };
      },
      signInWithPassword: async () => {
        throw new Error('reading the help centre must never sign anyone in');
      },
      revokeAllSessions: async () => {
        throw new Error('reading the help centre must never revoke a session');
      },
    })
    .overrideProvider(STAFF_CONSOLE_STORE)
    .useValue({
      staffConsoleAccess: async (input: { userId: string; isAal2: boolean }): Promise<StaffConsoleRow> => {
        // The platform's own behaviour, modelled rather than asserted around: a role that requires MFA counts for
        // nothing at aal1, so the effective set is empty.
        const granted = [...(doubles.permissions ?? [READ, MANAGE])];
        return {
          hasConsoleRole: true,
          requiresStepUp: false,
          roles: ['admin'],
          permissions: input.isAal2 ? granted : [],
        };
      },
      buyerProfile: async (userId: string) => ({ id: userId, displayName: 'Nadia', localeCode: 'en' }),
    })
    .overrideProvider(FAQS_PUBLIC_STORE)
    .useValue(publicStore)
    .overrideProvider(FAQS_STORE)
    .useValue(adminStore)
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

function request(options: {
  method: string;
  url: string;
  accessToken?: string;
  payload?: unknown;
  credential?: string;
}) {
  const headers: Record<string, string> = {
    [INTERNAL_CREDENTIAL_HEADER]: options.credential ?? TEST_INTERNAL_CREDENTIAL,
  };
  if (options.accessToken !== undefined) headers[SESSION_TOKEN_HEADER] = options.accessToken;
  if (options.payload !== undefined) headers['content-type'] = 'application/json';
  return app!.inject({
    method: options.method as 'GET',
    url: options.url,
    headers,
    ...(options.payload === undefined ? {} : { payload: JSON.stringify(options.payload) }),
  });
}

/* ------------------------------------------------------------------------------------------------ */
/* The public help centre                                                                            */
/* ------------------------------------------------------------------------------------------------ */

describe('GET /v1/faqs', () => {
  it('answers with no session at all', async () => {
    await createApp();
    const response = await request({ method: 'GET', url: '/v1/faqs?topic=faq' });
    expect(response.statusCode).toBe(200);
    const body = PublicFaqsResponseSchema.parse(response.json());
    expect(body.topic).toBe('faq');
    expect(body.entries[0]?.question).toBe('How do I buy?');
  });

  it('carries an answer exactly as stored, blank lines and all', async () => {
    // Owner decision 3: the renderer splits paragraphs, so nothing here may normalise them away.
    await createApp();
    const response = await request({ method: 'GET', url: '/v1/faqs?topic=faq' });
    expect(PublicFaqsResponseSchema.parse(response.json()).entries[0]?.answer).toBe(ANSWER);
  });

  it('is a 200 with no entries for a topic with nothing published', async () => {
    await createApp({ publicRows: [] });
    const response = await request({ method: 'GET', url: '/v1/faqs?topic=help' });
    expect(response.statusCode).toBe(200);
    expect(PublicFaqsResponseSchema.parse(response.json()).entries).toEqual([]);
  });

  it('refuses a value that could not be a topic rather than answering nothing', async () => {
    for (const topic of ['FAQ', 'faq-help', '1faq', '', 'x'.repeat(61)]) {
      const seen = await createApp();
      const response = await request({ method: 'GET', url: `/v1/faqs?topic=${encodeURIComponent(topic)}` });
      expect(response.statusCode, topic).toBe(400);
      // And the database was never asked.
      expect(seen, topic).toEqual([]);
      await app?.close();
      app = undefined;
    }
  });

  it('refuses a request with no topic at all', async () => {
    await createApp();
    const response = await request({ method: 'GET', url: '/v1/faqs' });
    expect(response.statusCode).toBe(400);
  });

  it('passes the topic and the locale through, and defaults an unrecognised locale', async () => {
    const seen = await createApp();
    await request({ method: 'GET', url: '/v1/faqs?topic=help&locale=ar' });
    await request({ method: 'GET', url: '/v1/faqs?topic=help&locale=de' });
    expect(seen[0]?.input).toEqual({ topic: 'help', locale: 'ar' });
    expect(seen[1]?.input).toEqual({ topic: 'help', locale: 'en' });
  });

  it('is a 503 when the entries could not be read, rather than an empty help centre', async () => {
    await createApp({ publicError: true });
    const response = await request({ method: 'GET', url: '/v1/faqs?topic=faq' });
    expect(response.statusCode).toBe(503);
  });

  it('refuses a caller without the internal credential', async () => {
    await createApp();
    const response = await request({ method: 'GET', url: '/v1/faqs?topic=faq', credential: 'wrong' });
    expect(response.statusCode).toBe(403);
  });

  it('asks the database for nothing but the entries', async () => {
    const seen = await createApp();
    await request({ method: 'GET', url: '/v1/faqs?topic=faq' });
    expect([...new Set(seen.map((entry) => entry.name))]).toEqual(['publicFaqs']);
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* The console                                                                                       */
/* ------------------------------------------------------------------------------------------------ */

describe('GET /v1/admin/faqs', () => {
  it('lists for a caller holding the read key, and reports the manage capability', async () => {
    await createApp({ permissions: [READ] });
    const response = await request({ method: 'GET', url: '/v1/admin/faqs', accessToken: ACCESS_TOKEN });
    expect(response.statusCode).toBe(200);
    const body = FaqPageResponseSchema.parse(response.json());
    expect(body.canManage).toBe(false);
    expect(body.items[0]?.topic).toBe('faq');
    expect(body.items[0]?.isMapped).toBe(true);
    expect(body.nextCursor).toBeNull();
  });

  it('reports an entry under a topic no public address shows', async () => {
    // Owner decision 5's console requirement.
    await createApp({ listRows: [{ ...LIST_ROW, topic: 'shipping', isMapped: false, pageSlug: null }] });
    const response = await request({ method: 'GET', url: '/v1/admin/faqs', accessToken: ACCESS_TOKEN });
    const body = FaqPageResponseSchema.parse(response.json());
    expect(body.items[0]?.isMapped).toBe(false);
    expect(body.items[0]?.pageSlug).toBeNull();
  });

  it('asks for one more row than it returns, and offers a cursor only when there is another page', async () => {
    const seen = await createApp({
      listRows: [LIST_ROW, { ...LIST_ROW, faqId: SECOND, sortOrder: 20 }],
    });
    const response = await request({ method: 'GET', url: '/v1/admin/faqs?limit=1', accessToken: ACCESS_TOKEN });
    const body = FaqPageResponseSchema.parse(response.json());
    expect(body.items).toHaveLength(1);
    expect(body.nextCursor).not.toBeNull();
    expect((seen.find((entry) => entry.name === 'faqsForStaff')?.input as { limit: number }).limit).toBe(2);
  });

  it('passes a cursor to the store as three typed values', async () => {
    const cursor = encodeFaqCursor({ topic: 'faq', sortOrder: 10, id: FAQ });
    const seen = await createApp();
    await request({ method: 'GET', url: `/v1/admin/faqs?cursor=${cursor}`, accessToken: ACCESS_TOKEN });
    expect(seen.find((entry) => entry.name === 'faqsForStaff')?.input).toMatchObject({
      afterTopic: 'faq',
      afterSortOrder: 10,
      afterId: FAQ,
    });
  });

  it('refuses a cursor that is not a position', async () => {
    for (const cursor of ['nonsense', Buffer.from('bp1|x|y', 'utf8').toString('base64url'), '!!!!']) {
      const seen = await createApp();
      const response = await request({
        method: 'GET',
        url: `/v1/admin/faqs?cursor=${encodeURIComponent(cursor)}`,
        accessToken: ACCESS_TOKEN,
      });
      expect(response.statusCode, cursor).toBe(400);
      expect(seen.some((entry) => entry.name === 'faqsForStaff'), cursor).toBe(false);
      await app?.close();
      app = undefined;
    }
  });

  it('refuses a topic filter and a limit that could not be ones', async () => {
    for (const query of ['?topic=NOPE', '?limit=0', '?limit=1000', '?limit=x']) {
      await createApp();
      const response = await request({ method: 'GET', url: `/v1/admin/faqs${query}`, accessToken: ACCESS_TOKEN });
      expect(response.statusCode, query).toBe(400);
      await app?.close();
      app = undefined;
    }
  });

  it('narrows to one topic when asked', async () => {
    const seen = await createApp();
    await request({ method: 'GET', url: '/v1/admin/faqs?topic=help', accessToken: ACCESS_TOKEN });
    expect(seen.find((entry) => entry.name === 'faqsForStaff')?.input).toMatchObject({ topic: 'help' });
  });

  it('is a 404 for every other console key, and for the same caller at aal1', async () => {
    for (const key of OTHER_KEYS) {
      await createApp({ permissions: [key] });
      const response = await request({ method: 'GET', url: '/v1/admin/faqs', accessToken: ACCESS_TOKEN });
      expect(response.statusCode, key).toBe(404);
      await app?.close();
      app = undefined;
    }

    await createApp();
    const atAal1 = await request({ method: 'GET', url: '/v1/admin/faqs', accessToken: AAL1_TOKEN });
    expect(atAal1.statusCode).toBe(404);
  });

  it('needs a session at all', async () => {
    await createApp();
    const response = await request({ method: 'GET', url: '/v1/admin/faqs' });
    expect(response.statusCode).toBe(401);
  });
});

describe('GET /v1/admin/faqs/topics', () => {
  it('reports every topic with both counts and the mapping', async () => {
    await createApp({
      topicRows: [TOPIC_ROW, { topic: 'shipping', entryCount: 1, publishedCount: 0, isMapped: false, pageSlug: null }],
    });
    const response = await request({ method: 'GET', url: '/v1/admin/faqs/topics', accessToken: ACCESS_TOKEN });
    expect(response.statusCode).toBe(200);
    const body = FaqTopicsResponseSchema.parse(response.json());
    expect(body.topics.map((entry) => entry.topic)).toEqual(['faq', 'shipping']);
    expect(body.topics[1]?.isMapped).toBe(false);
  });

  it('is not shadowed by the entry route', async () => {
    const seen = await createApp();
    await request({ method: 'GET', url: '/v1/admin/faqs/topics', accessToken: ACCESS_TOKEN });
    expect(seen.some((entry) => entry.name === 'faqTopicsForStaff')).toBe(true);
    expect(seen.some((entry) => entry.name === 'faqForStaff')).toBe(false);
  });
});

describe('GET /v1/admin/faqs/:faqId', () => {
  it('returns the entry with the manage capability and the mapping', async () => {
    await createApp();
    const response = await request({ method: 'GET', url: `/v1/admin/faqs/${FAQ}`, accessToken: ACCESS_TOKEN });
    expect(response.statusCode).toBe(200);
    const body = FaqDetailResponseSchema.parse(response.json());
    expect(body.faq.canManage).toBe(true);
    expect(body.faq.pageSlug).toBe('faq');
    expect(body.faq.answerEn).toBe(ANSWER);
  });

  it('is the same 404 for an entry that does not exist and a caller who may not read it', async () => {
    await createApp({ detailRow: null });
    const absent = await request({ method: 'GET', url: `/v1/admin/faqs/${FAQ}`, accessToken: ACCESS_TOKEN });
    await app?.close();
    app = undefined;

    await createApp({ permissions: [] });
    const refused = await request({ method: 'GET', url: `/v1/admin/faqs/${FAQ}`, accessToken: ACCESS_TOKEN });
    expect(absent.statusCode).toBe(404);
    expect(refused.statusCode).toBe(404);
    expect(absent.json()).toEqual(refused.json());
  });

  it('refuses an identifier that could not be one', async () => {
    await createApp();
    const response = await request({
      method: 'GET',
      url: '/v1/admin/faqs/not-a-uuid',
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('writing', () => {
  it('creates an entry and never names a publication state', async () => {
    const seen = await createApp();
    const response = await request({
      method: 'POST',
      url: '/v1/admin/faqs',
      accessToken: ACCESS_TOKEN,
      payload: { topic: 'faq', questionEn: 'How do I buy?', answerEn: ANSWER, sortOrder: 20 },
    });
    expect(response.statusCode).toBe(201);
    expect(CreateFaqResponseSchema.parse(response.json()).id).toBe(FAQ);
    const save = seen.find((entry) => entry.name === 'faqSaveForStaff');
    expect(save?.input).toMatchObject({
      faqId: null,
      topic: 'faq',
      questionEn: 'How do I buy?',
      questionAr: null,
      answerEn: ANSWER,
      answerAr: null,
      sortOrder: 20,
    });
    expect(Object.keys(save?.input as object)).not.toContain('isPublished');
  });

  it('refuses a create or a change that tries to publish (owner decision 6)', async () => {
    const seen = await createApp();
    const created = await request({
      method: 'POST',
      url: '/v1/admin/faqs',
      accessToken: ACCESS_TOKEN,
      payload: { topic: 'faq', questionEn: 'Q?', answerEn: 'A.', isPublished: true },
    });
    const changed = await request({
      method: 'PATCH',
      url: `/v1/admin/faqs/${FAQ}`,
      accessToken: ACCESS_TOKEN,
      payload: { questionEn: 'Q?', isPublished: true },
    });
    expect(created.statusCode).toBe(400);
    expect(changed.statusCode).toBe(400);
    // And the state writer was never reached by either.
    expect(seen.some((entry) => entry.name === 'faqStateForStaff')).toBe(false);
  });

  it('refuses a create with no English wording, which is D6', async () => {
    for (const payload of [
      { topic: 'faq', answerEn: 'A.' },
      { topic: 'faq', questionEn: 'Q?' },
      { topic: 'faq', questionEn: '   ', answerEn: 'A.' },
      { topic: 'faq', questionEn: 'Q?', answerEn: '   ' },
    ]) {
      await createApp();
      const response = await request({
        method: 'POST',
        url: '/v1/admin/faqs',
        accessToken: ACCESS_TOKEN,
        payload,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      await app?.close();
      app = undefined;
    }
  });

  it('keeps a null Arabic wording, which clears it, apart from an absent one', async () => {
    const seen = await createApp();
    await request({
      method: 'PATCH',
      url: `/v1/admin/faqs/${FAQ}`,
      accessToken: ACCESS_TOKEN,
      payload: { questionAr: null },
    });
    await request({
      method: 'PATCH',
      url: `/v1/admin/faqs/${FAQ}`,
      accessToken: ACCESS_TOKEN,
      payload: { questionEn: 'How do I buy?' },
    });
    const saves = seen.filter((entry) => entry.name === 'faqSaveForStaff');
    // An empty string is the database's "clear it"; null is its "leave it alone".
    expect(saves[0]?.input).toMatchObject({ questionAr: '' });
    expect(saves[1]?.input).toMatchObject({ questionAr: null, questionEn: 'How do I buy?' });
  });

  it('leaves the position alone when a change does not name one', async () => {
    const seen = await createApp();
    await request({
      method: 'PATCH',
      url: `/v1/admin/faqs/${FAQ}`,
      accessToken: ACCESS_TOKEN,
      payload: { answerEn: 'A longer answer.' },
    });
    expect(seen.find((entry) => entry.name === 'faqSaveForStaff')?.input).toMatchObject({
      sortOrder: null,
      topic: null,
    });
  });

  it('refuses an update with nothing in it', async () => {
    await createApp();
    const response = await request({
      method: 'PATCH',
      url: `/v1/admin/faqs/${FAQ}`,
      accessToken: ACCESS_TOKEN,
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });

  it('publishes and unpublishes through its own route', async () => {
    const seen = await createApp();
    const published = await request({
      method: 'PUT',
      url: `/v1/admin/faqs/${FAQ}/state`,
      accessToken: ACCESS_TOKEN,
      payload: { isPublished: true },
    });
    expect(FaqWriteResponseSchema.parse(published.json()).ok).toBe(true);
    expect(seen.find((entry) => entry.name === 'faqStateForStaff')?.input).toMatchObject({ isPublished: true });
  });

  it('reorders one topic, whole', async () => {
    const seen = await createApp();
    const response = await request({
      method: 'PUT',
      url: '/v1/admin/faqs/reorder',
      accessToken: ACCESS_TOKEN,
      payload: { topic: 'faq', faqIds: [SECOND, FAQ] },
    });
    expect(response.statusCode).toBe(200);
    expect(seen.find((entry) => entry.name === 'faqsReorderForStaff')?.input).toMatchObject({
      topic: 'faq',
      faqIds: [SECOND, FAQ],
    });
  });

  it('removes an entry', async () => {
    const seen = await createApp();
    const response = await request({
      method: 'DELETE',
      url: `/v1/admin/faqs/${FAQ}`,
      accessToken: ACCESS_TOKEN,
    });
    expect(response.statusCode).toBe(200);
    expect(seen.some((entry) => entry.name === 'faqDeleteForStaff')).toBe(true);
  });

  it('is a 404 for every write when the caller holds only the read key', async () => {
    const writes: readonly { method: string; url: string; payload?: unknown }[] = [
      { method: 'POST', url: '/v1/admin/faqs', payload: { topic: 'faq', questionEn: 'Q?', answerEn: 'A.' } },
      { method: 'PATCH', url: `/v1/admin/faqs/${FAQ}`, payload: { questionEn: 'Q?' } },
      { method: 'PUT', url: `/v1/admin/faqs/${FAQ}/state`, payload: { isPublished: true } },
      { method: 'DELETE', url: `/v1/admin/faqs/${FAQ}` },
      { method: 'PUT', url: '/v1/admin/faqs/reorder', payload: { topic: 'faq', faqIds: [FAQ] } },
    ];

    for (const write of writes) {
      // The database refuses a caller without the manage key, and that refusal is a 404 identical to an absence.
      await createApp({ permissions: [READ], writeError: { code: '42501' } });
      const response = await request({ ...write, accessToken: ACCESS_TOKEN });
      expect(response.statusCode, `${write.method} ${write.url}`).toBe(404);
      await app?.close();
      app = undefined;
    }
  });
});

describe('a refused write', () => {
  it('becomes a 409 carrying our own code, never the databases text', async () => {
    for (const code of ['23514', '23502']) {
      await createApp({ writeError: { code } });
      const response = await request({
        method: 'POST',
        url: '/v1/admin/faqs',
        accessToken: ACCESS_TOKEN,
        payload: { topic: 'faq', questionEn: 'Q?', answerEn: 'A.' },
      });
      expect(response.statusCode, code).toBe(409);
      const body = response.json() as { code: string; detail: string };
      expect(body.code).toBe('FAQ_NOT_ALLOWED');
      expect(body.detail).not.toContain('the database refused the write');
      await app?.close();
      app = undefined;
    }
  });

  it('is a 503 for a SQLSTATE nobody mapped', async () => {
    await createApp({ writeError: { code: '08006' } });
    const response = await request({
      method: 'POST',
      url: '/v1/admin/faqs',
      accessToken: ACCESS_TOKEN,
      payload: { topic: 'faq', questionEn: 'Q?', answerEn: 'A.' },
    });
    expect(response.statusCode).toBe(503);
  });

  it('is a 404 when a save named an entry that does not exist', async () => {
    await createApp({ saveId: null });
    const response = await request({
      method: 'PATCH',
      url: `/v1/admin/faqs/${FAQ}`,
      accessToken: ACCESS_TOKEN,
      payload: { questionEn: 'Q?' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('is a 404 when a state change or a delete matched nothing', async () => {
    for (const write of [
      { method: 'PUT', url: `/v1/admin/faqs/${FAQ}/state`, payload: { isPublished: true } },
      { method: 'DELETE', url: `/v1/admin/faqs/${FAQ}` },
    ]) {
      await createApp({ writeResult: false });
      const response = await request({ ...write, accessToken: ACCESS_TOKEN });
      expect(response.statusCode, write.url).toBe(404);
      await app?.close();
      app = undefined;
    }
  });

  it('is still a 200 when a reorder moved nothing, because a stale screen is not a refusal', async () => {
    await createApp({ writeResult: false });
    const response = await request({
      method: 'PUT',
      url: '/v1/admin/faqs/reorder',
      accessToken: ACCESS_TOKEN,
      payload: { topic: 'faq', faqIds: [FAQ] },
    });
    expect(response.statusCode).toBe(200);
  });
});
