import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  LISTING_MODERATION_ACTIONS,
  ListingModerationHistoryResponseSchema,
  ModerateListingResponseSchema,
  ModerationActionsResponseSchema,
  ModerationListingDetailResponseSchema,
  ModerationListingQueueResponseSchema,
  ModerationReportDetailResponseSchema,
  ModerationReportQueueResponseSchema,
  REPORT_RESOLUTIONS,
  ResolveReportResponseSchema,
  SESSION_TOKEN_HEADER,
} from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp, createFastifyAdapter, NEST_APP_OPTIONS } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { AuthenticationRequiredError } from '../src/auth/auth-errors.js';
import { MODERATION_STORE } from '../src/admin/moderation.service.js';
import { SUPABASE_AUTH_CLIENT } from '../src/auth/login.service.js';
import { STAFF_CONSOLE_STORE, type StaffConsoleRow } from '../src/admin/staff-console.service.js';
import { INTERNAL_CREDENTIAL_HEADER } from '../src/v1/internal-credential.guard.js';
import { TEST_ENV, TEST_INTERNAL_CREDENTIAL } from './support/app.js';

/**
 * Listing moderation and report management at the API boundary (Phase 7-N).
 *
 * The properties this suite exists for:
 *
 * **Each route requires exactly one key, and the right one.** Every operation is driven by a caller holding
 * each of the five keys in turn, and each refuses every key but its own — including the pair that are easy to
 * confuse: either moderation trail needs `moderation.action.read`, **not** the report read key, because that
 * is what the existing policy gates those tables on.
 *
 * **The assurance level is read from the validated token, not from the request.** A caller whose token is not
 * aal2 reaches the store with `isAal2: false`, and the database is what refuses them.
 *
 * **Nothing about authority is accepted from a browser.** Every attempt to name a moderator, a permission, an
 * assurance level or a listing status is refused by the strict schema, and the store is asked with the
 * token's own account every time.
 *
 * **A refusal says nothing about existence.** A row a caller may not read and one that is not there produce
 * the same status, code and body, compared byte for byte.
 *
 * **Every outcome the database can return maps to one approved answer**, including the four conflicts, and an
 * outcome this service does not understand becomes a 503 rather than a success.
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
const IMPOSTOR = '99999999-9999-4999-8999-999999999999';
const REPORT = 'c0000000-0000-4000-8000-00000000000a';
const OTHER_REPORT = 'c0000000-0000-4000-8000-00000000000b';
const LISTING = '22220000-0000-4000-8000-000000000001';

const READ = 'moderation.report.read';
const MANAGE = 'moderation.report.manage';
const ACTIONS = 'moderation.action.read';
const CATALOG = 'catalog.listing.read';
const MODERATE = 'catalog.listing.moderate';
const ALL_KEYS = [READ, MANAGE, ACTIONS, CATALOG, MODERATE] as const;

const REPORT_ROW = {
  id: REPORT,
  subjectType: 'listing',
  subjectLabel: 'A listing',
  reasonCode: 'counterfeit',
  status: 'open',
  priority: 'normal',
  isOwnReport: false,
  actionCount: 0,
  createdAt: new Date('2026-05-01T09:00:00.000Z'),
};

const REPORT_DETAIL = {
  outcome: 'found',
  id: REPORT,
  subjectType: 'listing',
  subjectSlug: 'a-listing',
  subjectLabel: 'A listing',
  subjectStatus: 'active',
  subjectIsResolvable: true,
  reasonCode: 'counterfeit',
  details: 'What they said.',
  status: 'open',
  priority: 'normal',
  isOwnReport: false,
  resolution: null,
  resolutionNote: null,
  resolvedAt: null,
  resolvedByMe: false,
  duplicateOfReportId: null,
  createdAt: new Date('2026-05-01T09:00:00.000Z'),
  updatedAt: new Date('2026-05-01T09:00:00.000Z'),
};

const ACTION_ROW = {
  id: 'd0000000-0000-4000-8000-00000000000a',
  action: 'suspend',
  reason: 'A reason.',
  notes: null,
  reportId: REPORT,
  expiresAt: null,
  reversesActionId: null,
  isOwnAction: true,
  createdAt: new Date('2026-05-02T09:00:00.000Z'),
};

const LISTING_ROW = {
  id: LISTING,
  slug: 'a-listing',
  title: 'A listing',
  status: 'pending_review',
  listingTypeCode: 'product',
  currencyCode: 'EGP',
  priceMinor: '150000',
  isOwnListing: false,
  reportCount: 1,
  createdAt: new Date('2026-05-01T09:00:00.000Z'),
};

const LISTING_DETAIL = {
  outcome: 'found',
  ...LISTING_ROW,
  description: 'A description.',
  contentLanguage: 'en',
  city: 'Cairo',
  sellerSlug: 'a-shop',
  sellerDisplayName: 'A Shop',
  canModerate: true,
  openReportCount: 1,
  approvedAt: null,
  reportCount: undefined,
};

const TRAIL_ROW = {
  id: 'e0000000-0000-4000-8000-00000000000a',
  action: 'suspend',
  fromStatus: 'active',
  toStatus: 'suspended',
  reason: 'A reason.',
  reportId: null,
  isOwnAction: false,
  createdAt: new Date('2026-05-02T09:00:00.000Z'),
};

interface Seen {
  readonly name: string;
  readonly input: Record<string, unknown>;
}

interface Doubles {
  readonly permissions?: readonly string[];
  readonly isAal2?: boolean;
  readonly reportOutcome?: string;
  readonly listingOutcome?: string;
  readonly writeOutcome?: string;
  readonly storeThrows?: boolean;
  readonly unauthenticated?: boolean;
  readonly reportRows?: readonly unknown[];
  readonly listingRows?: readonly unknown[];
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
    moderationReportQueue: async (input: Record<string, unknown>) => {
      note('reportQueue')(input);
      return doubles.reportRows ?? [REPORT_ROW];
    },
    moderationReportForStaff: async (input: Record<string, unknown>) => {
      note('report')(input);
      const outcome = doubles.reportOutcome ?? 'found';
      return outcome === 'found' ? REPORT_DETAIL : { ...REPORT_DETAIL, outcome, id: null };
    },
    moderationActionsForSubject: async (input: Record<string, unknown>) => {
      note('actionsForSubject')(input);
      return doubles.actionRows ?? [ACTION_ROW];
    },
    moderationActionsForReport: async (input: Record<string, unknown>) => {
      note('actionsForReport')(input);
      return doubles.actionRows ?? [ACTION_ROW];
    },
    listingModerationHistory: async (input: Record<string, unknown>) => {
      note('listingHistory')(input);
      return [TRAIL_ROW];
    },
    moderationListingQueue: async (input: Record<string, unknown>) => {
      note('listingQueue')(input);
      return doubles.listingRows ?? [LISTING_ROW];
    },
    moderationListingForStaff: async (input: Record<string, unknown>) => {
      note('listing')(input);
      const outcome = doubles.listingOutcome ?? 'found';
      return outcome === 'found' ? LISTING_DETAIL : { ...LISTING_DETAIL, outcome, id: null };
    },
    moderationReportResolve: async (input: Record<string, unknown>) => {
      note('resolve')(input);
      const outcome = doubles.writeOutcome ?? 'resolved';
      return { outcome, status: outcome === 'resolved' ? 'actioned' : null };
    },
    moderationListingModerate: async (input: Record<string, unknown>) => {
      note('moderate')(input);
      const outcome = doubles.writeOutcome ?? 'moderated';
      return { outcome, status: outcome === 'moderated' ? 'suspended' : null };
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
        throw new Error('moderating must never revoke a session');
      },
    })
    .overrideProvider(STAFF_CONSOLE_STORE)
    .useValue({
      staffConsoleAccess: async (input: { userId: string; isAal2: boolean }): Promise<StaffConsoleRow> => {
        seen.push({ name: 'console-access', input });
        // 0068's own behaviour, modelled rather than asserted around: a role that requires MFA counts for
        // nothing at aal1, so the effective set is empty. Every role holding a moderation key requires MFA,
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
    .overrideProvider(MODERATION_STORE)
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
  method: 'GET' | 'POST',
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<Result> {
  const response = await app!.inject({
    method,
    url: `/v1/admin/moderation${path}`,
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

const get = (path: string, headers?: Record<string, string>): Promise<Result> =>
  call('GET', path, headers === undefined ? {} : { headers });
const post = (path: string, body: unknown, headers?: Record<string, string>): Promise<Result> =>
  call('POST', path, headers === undefined ? { body } : { body, headers });

/** What the store was asked, with the session lookup every request makes filtered out. */
const asked = (seen: readonly Seen[]): readonly Seen[] =>
  seen.filter((entry) => entry.name !== 'console-access');
const askedFor = (seen: readonly Seen[], name: string): Seen =>
  seen.find((entry) => entry.name === name)!;

function comparable(body: Record<string, unknown>): string {
  const { instance: _instance, ...rest } = body;
  return JSON.stringify(rest);
}

const RESOLVE = { status: 'actioned', resolutionNote: 'A reason.' } as const;
const MODERATE_BODY = { action: 'suspend', reason: 'A reason.' } as const;

/** Every operation, with the one key it needs and the request that exercises it. */
type Headers = Record<string, string> | undefined;

const OPERATIONS = [
  { name: 'report queue', key: READ, run: (h?: Headers) => get('/reports', h) },
  { name: 'report detail', key: READ, run: (h?: Headers) => get(`/reports/${REPORT}`, h) },
  {
    name: 'report resolution',
    key: MANAGE,
    run: (h?: Headers) => post(`/reports/${REPORT}/resolution`, RESOLVE, h),
  },
  { name: 'report actions', key: ACTIONS, run: (h?: Headers) => get(`/reports/${REPORT}/actions`, h) },
  { name: 'listing queue', key: CATALOG, run: (h?: Headers) => get('/listings', h) },
  { name: 'listing detail', key: CATALOG, run: (h?: Headers) => get(`/listings/${LISTING}`, h) },
  { name: 'listing history', key: ACTIONS, run: (h?: Headers) => get(`/listings/${LISTING}/history`, h) },
  {
    name: 'listing action',
    key: MODERATE,
    run: (h?: Headers) => post(`/listings/${LISTING}/actions`, MODERATE_BODY, h),
  },
] as const;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/* ------------------------------------------------------------------------------------------------ */

describe('each operation requires exactly one key, and the right one', () => {
  it('succeeds with the key it needs', async () => {
    for (const operation of OPERATIONS) {
      await start({ permissions: [operation.key] });
      const result = await operation.run();
      expect(result.status, operation.name).toBe(200);
      await app?.close();
      app = undefined;
    }
  });

  it('refuses every other key, with the same neutral answer', async () => {
    for (const operation of OPERATIONS) {
      for (const key of ALL_KEYS.filter((candidate) => candidate !== operation.key)) {
        await start({ permissions: [key] });
        const result = await operation.run();
        expect(result.status, `${operation.name} with ${key}`).toBe(404);
        expect(result.body['code'], `${operation.name} with ${key}`).toBe('NOT_FOUND');
        await app?.close();
        app = undefined;
      }
    }
  });

  it('refuses a caller with no permissions at all', async () => {
    for (const operation of OPERATIONS) {
      const seen = await start({ permissions: [] });
      const result = await operation.run();
      expect(result.status, operation.name).toBe(404);
      expect(asked(seen), `${operation.name} asked the store nothing`).toHaveLength(0);
      await app?.close();
      app = undefined;
    }
  });

  it('needs the action key for either trail, not the report read key', async () => {
    // The pair that is easy to confuse, asserted on its own: 0027 gates both action tables on
    // `moderation.action.read` and nothing else.
    await start({ permissions: [READ, MANAGE, CATALOG, MODERATE] });
    expect((await get(`/reports/${REPORT}/actions`)).status).toBe(404);
    expect((await get(`/listings/${LISTING}/history`)).status).toBe(404);
    expect((await get(`/reports/${REPORT}`)).status, 'while the report itself is readable').toBe(200);
  });

  it('needs the moderate key for a decision, not the catalogue read key', async () => {
    await start({ permissions: [CATALOG] });
    expect((await post(`/listings/${LISTING}/actions`, MODERATE_BODY)).status).toBe(404);
    expect((await get(`/listings/${LISTING}`)).status, 'while the listing is readable').toBe(200);
  });

  it('needs the manage key for a decision, not the report read key', async () => {
    await start({ permissions: [READ] });
    expect((await post(`/reports/${REPORT}/resolution`, RESOLVE)).status).toBe(404);
    expect((await get('/reports')).status, 'while the queue is readable').toBe(200);
  });
});

describe('authority comes from the session and nowhere else', () => {
  it('asks the store with the token’s own account, whatever a header or body claims', async () => {
    const seen = await start();
    await get('/reports', { 'x-user-id': IMPOSTOR, 'x-moderator-id': IMPOSTOR });
    await post(`/listings/${LISTING}/actions`, MODERATE_BODY, { 'x-user-id': IMPOSTOR });
    for (const entry of asked(seen)) expect(entry.input['userId'], entry.name).toBe(STAFF);
  });

  it('reads the assurance level from the validated token and passes it on', async () => {
    const seen = await start();
    await get('/reports');
    expect(seen.find((entry) => entry.name === 'reportQueue')!.input['isAal2']).toBe(true);
  });

  it('refuses every operation for staff at aal1, and passes the level on rather than assuming it', async () => {
    // 0068 gives an aal1 caller an empty effective set because every role holding these keys requires MFA,
    // so this is the assurance test and the permission test at once — there is no separate check to forget.
    for (const operation of OPERATIONS) {
      const seen = await start();
      const result = await operation.run({ [SESSION_TOKEN_HEADER]: AAL1_TOKEN });
      expect(result.status, operation.name).toBe(404);
      expect(askedFor(seen, 'console-access').input['isAal2'], operation.name).toBe(false);
      expect(asked(seen), `${operation.name} reached no reader`).toHaveLength(0);
      await app?.close();
      app = undefined;
    }
  });

  it('refuses a body that names a moderator, a permission or an assurance level', async () => {
    const seen = await start();
    for (const field of ['moderatorUserId', 'userId', 'permission', 'isAal2', 'resolvedBy']) {
      const result = await post(`/reports/${REPORT}/resolution`, { ...RESOLVE, [field]: IMPOSTOR });
      expect(result.status, field).toBe(400);
    }
    for (const field of ['moderatorUserId', 'status', 'sellerUserId', 'objectPath', 'reversesActionId']) {
      const result = await post(`/listings/${LISTING}/actions`, { ...MODERATE_BODY, [field]: 'x' });
      expect(result.status, field).toBe(400);
    }
    expect(asked(seen), 'nothing reached the store').toHaveLength(0);
  });

  it('refuses a request with no session or the wrong internal credential', async () => {
    const seen = await start();
    expect((await get('/reports', { [SESSION_TOKEN_HEADER]: '' })).status).toBe(401);
    expect((await get('/reports', { [INTERNAL_CREDENTIAL_HEADER]: 'nope' })).status).toBe(403);
    expect(asked(seen)).toHaveLength(0);
  });

  it('refuses a caller whose session the provider rejects', async () => {
    const seen = await start({ unauthenticated: true });
    expect((await get('/reports')).status).toBe(401);
    expect(asked(seen)).toHaveLength(0);
  });
});

describe('the report queue and one report', () => {
  it('returns a page and the row the contract allows', async () => {
    await start();
    const result = await get('/reports');
    expect(result.status).toBe(200);
    const page = ModerationReportQueueResponseSchema.parse(result.body);
    expect(page.items[0]!.id).toBe(REPORT);
    expect(page.items[0]!.createdAt).toBe('2026-05-01T09:00:00.000Z');
  });

  it('passes a status filter through as text without interpreting it', async () => {
    const seen = await start();
    await get('/reports?status=triaged');
    await get('/reports?status=not_a_status');
    expect(asked(seen)[0]!.input['status']).toBe('triaged');
    expect(asked(seen)[1]!.input['status']).toBe('not_a_status');
  });

  it('asks for one row more than the page, so the cursor lands at the boundary', async () => {
    const seen = await start({ reportRows: [] });
    await get('/reports?limit=5');
    expect(askedFor(seen, 'reportQueue').input['limit']).toBe(6);
  });

  it('answers a full page with a cursor and a last page without one', async () => {
    const two = [REPORT_ROW, { ...REPORT_ROW, id: OTHER_REPORT }];
    await start({ reportRows: two });
    expect(ModerationReportQueueResponseSchema.parse((await get('/reports?limit=5')).body).nextCursor)
      .toBeNull();
    const paged = ModerationReportQueueResponseSchema.parse((await get('/reports?limit=1')).body);
    expect(paged.items).toHaveLength(1);
    expect(paged.nextCursor).not.toBeNull();
  });

  it('refuses a cursor it did not issue, including one from the listing queue', async () => {
    const seen = await start();
    for (const cursor of [
      'not-base64url!!',
      Buffer.from(`ml1|2026-05-01T09:00:00.000Z|${REPORT}`, 'utf8').toString('base64url'),
      Buffer.from(`mr1|2026-02-31T09:00:00.000Z|${REPORT}`, 'utf8').toString('base64url'),
      Buffer.from(`mr1|2026-05-01T09:00:00.000Z|nope`, 'utf8').toString('base64url'),
    ]) {
      const result = await get(`/reports?cursor=${encodeURIComponent(cursor)}`);
      expect(result.status, cursor).toBe(400);
    }
    expect(asked(seen)).toHaveLength(0);
  });

  it('refuses a limit that is not one, and clamps one that is too large', async () => {
    const seen = await start({ reportRows: [] });
    expect((await get('/reports?limit=abc')).status).toBe(400);
    expect((await get('/reports?limit=0')).status).toBe(400);
    expect((await get('/reports?limit=999')).status).toBe(200);
    expect(asked(seen).at(-1)!.input['limit']).toBe(51);
  });

  it('returns one report with its subject’s current status', async () => {
    await start();
    const result = await get(`/reports/${REPORT}`);
    const { report } = ModerationReportDetailResponseSchema.parse(result.body);
    expect(report.subjectStatus).toBe('active');
    expect(report.details).toBe('What they said.');
    expect(report.subjectIsResolvable).toBe(true);
  });

  it('refuses a malformed report identifier before asking anything', async () => {
    const seen = await start();
    expect((await get('/reports/not-a-uuid')).status).toBe(400);
    expect((await post('/reports/not-a-uuid/resolution', RESOLVE)).status).toBe(400);
    expect(asked(seen)).toHaveLength(0);
  });

  it('answers a report a caller may not read exactly like one that is not there', async () => {
    await start({ reportOutcome: 'not_found' });
    const missing = await get(`/reports/${REPORT}`);
    await app?.close();
    app = undefined;
    await start({ permissions: [MANAGE] });
    const refused = await get(`/reports/${REPORT}`);

    expect(missing.status).toBe(404);
    expect(refused.status).toBe(404);
    expect(comparable(missing.body)).toBe(comparable(refused.body));
  });
});

describe('recording a decision on a report', () => {
  it('records each of the four statuses the writer accepts', async () => {
    for (const status of REPORT_RESOLUTIONS) {
      const seen = await start();
      const body =
        status === 'duplicate'
          ? { status, resolutionNote: 'A reason.', duplicateOfReportId: OTHER_REPORT }
          : { status, resolutionNote: 'A reason.' };
      const result = await post(`/reports/${REPORT}/resolution`, body);
      expect(result.status, status).toBe(200);
      expect(asked(seen).at(-1)!.input['status'], status).toBe(status);
      await app?.close();
      app = undefined;
    }
  });

  it('refuses open, because the writer refuses it', async () => {
    const seen = await start();
    expect((await post(`/reports/${REPORT}/resolution`, { status: 'open' })).status).toBe(400);
    expect((await post(`/reports/${REPORT}/resolution`, { status: 'reopened' })).status).toBe(400);
    expect(asked(seen)).toHaveLength(0);
  });

  it('refuses a close with no reason and a duplicate with no original', async () => {
    const seen = await start();
    expect((await post(`/reports/${REPORT}/resolution`, { status: 'actioned' })).status).toBe(400);
    expect(
      (await post(`/reports/${REPORT}/resolution`, { status: 'duplicate', resolutionNote: 'A reason.' }))
        .status,
    ).toBe(400);
    expect(asked(seen)).toHaveLength(0);
  });

  it('answers the status the report now holds', async () => {
    await start();
    const result = await post(`/reports/${REPORT}/resolution`, RESOLVE);
    expect(ResolveReportResponseSchema.parse(result.body)).toEqual({
      outcome: 'resolved',
      status: 'actioned',
    });
  });

  it('maps each refusal the database returns to its own answer', async () => {
    for (const [outcome, status, code] of [
      ['not_found', 404, 'NOT_FOUND'],
      ['own_report', 409, 'REPORT_IS_OWN'],
      ['already_final', 409, 'REPORT_ALREADY_FINAL'],
      ['invalid', 400, 'VALIDATION_FAILED'],
    ] as const) {
      await start({ writeOutcome: outcome });
      const result = await post(`/reports/${REPORT}/resolution`, RESOLVE);
      expect(result.status, outcome).toBe(status);
      expect(result.body['code'], outcome).toBe(code);
      await app?.close();
      app = undefined;
    }
  });

  it('turns an outcome it does not understand into a 503 rather than a success', async () => {
    await start({ writeOutcome: 'something_new' });
    expect((await post(`/reports/${REPORT}/resolution`, RESOLVE)).status).toBe(503);
  });
});

describe('the listing queue, one listing and its decision', () => {
  it('returns the queue and one listing', async () => {
    await start();
    const queue = ModerationListingQueueResponseSchema.parse((await get('/listings')).body);
    expect(queue.items[0]!.slug).toBe('a-listing');
    expect(queue.items[0]!.priceMinor).toBe('150000');

    const { listing } = ModerationListingDetailResponseSchema.parse(
      (await get(`/listings/${LISTING}`)).body,
    );
    expect(listing.canModerate).toBe(true);
    expect(listing.sellerSlug).toBe('a-shop');
    expect(listing.openReportCount).toBe(1);
  });

  it('records each of the five actions the writer defines', async () => {
    for (const action of LISTING_MODERATION_ACTIONS) {
      const seen = await start();
      const result = await post(`/listings/${LISTING}/actions`, { action, reason: 'A reason.' });
      expect(result.status, action).toBe(200);
      expect(asked(seen).at(-1)!.input['action'], action).toBe(action);
      await app?.close();
      app = undefined;
    }
  });

  it('refuses an action the writer does not define', async () => {
    const seen = await start();
    for (const action of ['remove', 'hide', 'delete', 'unpublish', 'escalate']) {
      expect((await post(`/listings/${LISTING}/actions`, { action, reason: 'A reason.' })).status, action)
        .toBe(400);
    }
    expect(asked(seen)).toHaveLength(0);
  });

  it('refuses a decision with no reason or one past the length both tables allow', async () => {
    const seen = await start();
    expect((await post(`/listings/${LISTING}/actions`, { action: 'suspend' })).status).toBe(400);
    expect(
      (await post(`/listings/${LISTING}/actions`, { action: 'suspend', reason: 'x'.repeat(501) })).status,
    ).toBe(400);
    expect(asked(seen)).toHaveLength(0);
  });

  it('answers the status the listing now holds', async () => {
    await start();
    const result = await post(`/listings/${LISTING}/actions`, MODERATE_BODY);
    expect(ModerateListingResponseSchema.parse(result.body)).toEqual({
      outcome: 'moderated',
      status: 'suspended',
    });
  });

  it('maps each refusal the database returns to its own answer', async () => {
    for (const [outcome, status, code] of [
      ['not_found', 404, 'NOT_FOUND'],
      ['own_listing', 409, 'LISTING_IS_OWN'],
      ['no_change', 409, 'LISTING_MODERATION_NO_CHANGE'],
      ['not_applicable', 409, 'LISTING_MODERATION_NOT_APPLICABLE'],
      ['invalid', 400, 'VALIDATION_FAILED'],
    ] as const) {
      await start({ writeOutcome: outcome });
      const result = await post(`/listings/${LISTING}/actions`, MODERATE_BODY);
      expect(result.status, outcome).toBe(status);
      expect(result.body['code'], outcome).toBe(code);
      await app?.close();
      app = undefined;
    }
  });

  it('reports a repeat as a conflict, which is what a second colleague receives', async () => {
    // `listing_moderation_actions_status_moved` refuses an action that would move nothing, and that is the
    // whole of the concurrency answer: the loser of two colleagues acting at once lands here.
    await start({ writeOutcome: 'no_change' });
    const first = await post(`/listings/${LISTING}/actions`, MODERATE_BODY);
    const second = await post(`/listings/${LISTING}/actions`, MODERATE_BODY);
    expect(first.status).toBe(409);
    expect(second.status).toBe(409);
    expect(comparable(first.body)).toBe(comparable(second.body));
  });

  it('may cite the report that prompted it', async () => {
    const seen = await start();
    await post(`/listings/${LISTING}/actions`, { ...MODERATE_BODY, reportId: REPORT });
    expect(asked(seen).at(-1)!.input['reportId']).toBe(REPORT);
  });
});

describe('the two trails', () => {
  it('returns the actions citing one report', async () => {
    await start();
    const result = await get(`/reports/${REPORT}/actions`);
    const page = ModerationActionsResponseSchema.parse(result.body);
    expect(page.items[0]!.action).toBe('suspend');
    expect(page.items[0]!.isOwnAction).toBe(true);
  });

  it('returns one listing’s trail with the status move', async () => {
    await start();
    const result = await get(`/listings/${LISTING}/history`);
    const page = ListingModerationHistoryResponseSchema.parse(result.body);
    expect(page.items[0]!.fromStatus).toBe('active');
    expect(page.items[0]!.toStatus).toBe('suspended');
  });

  it('names no moderator on either, whatever the store returns', async () => {
    await start({
      actionRows: [{ ...ACTION_ROW, moderatorUserId: IMPOSTOR, moderator: 'Nadia' }],
    });
    const result = await get(`/reports/${REPORT}/actions`);
    expect(result.status).toBe(200);
    expect(Object.keys(ModerationActionsResponseSchema.parse(result.body).items[0]!).sort()).toEqual([
      'action',
      'createdAt',
      'expiresAt',
      'id',
      'isOwnAction',
      'notes',
      'reason',
      'reportId',
      'reversesActionId',
    ]);
    expect(result.raw).not.toContain(IMPOSTOR);
    expect(result.raw).not.toContain('moderatorUserId');
  });
});

describe('what never reaches a response', () => {
  it('names no account on any operation, whatever the store returns', async () => {
    await start({
      reportRows: [{ ...REPORT_ROW, reporterUserId: IMPOSTOR, assignedTo: IMPOSTOR }],
      listingRows: [{ ...LISTING_ROW, sellerUserId: IMPOSTOR }],
    });
    for (const path of ['/reports', '/listings', `/reports/${REPORT}`, `/listings/${LISTING}`]) {
      const result = await get(path);
      expect(result.status, path).toBe(200);
      expect(result.raw, path).not.toContain(IMPOSTOR);
      expect(result.raw, path).not.toContain('reporterUserId');
      expect(result.raw, path).not.toContain('sellerUserId');
      expect(result.raw, path).not.toContain('assignedTo');
    }
  });

  it('leaks nothing about the database when a read fails', async () => {
    await start({ storeThrows: true });
    for (const path of ['/reports', '/listings']) {
      const result = await get(path);
      expect(result.status, path).toBe(503);
      for (const secret of ['app_private', 'resolve_report', 'moderate_listing', 'database']) {
        expect(result.raw, `${path} :: ${secret}`).not.toContain(secret);
      }
    }
  });

  it('has no operation that edits, reverses or deletes a decision', async () => {
    await start();
    for (const [method, path] of [
      ['PUT', `/reports/${REPORT}`],
      ['PATCH', `/reports/${REPORT}/resolution`],
      ['DELETE', `/reports/${REPORT}`],
      ['POST', `/reports/${REPORT}/assignment`],
      ['POST', `/listings/${LISTING}/actions/reverse`],
      ['DELETE', `/listings/${LISTING}/actions`],
    ] as const) {
      const response = await app!.inject({
        method,
        url: `/v1/admin/moderation${path}`,
        headers: {
          [INTERNAL_CREDENTIAL_HEADER]: TEST_INTERNAL_CREDENTIAL,
          [SESSION_TOKEN_HEADER]: ACCESS_TOKEN,
        },
        payload: {} as never,
      });
      expect(response.statusCode, `${method} ${path}`).toBe(404);
    }
  });
});
