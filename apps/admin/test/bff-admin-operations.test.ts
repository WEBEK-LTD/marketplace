import { describe, expect, it } from 'vitest';
import {
  handleRecoveryCompletion,
  handleRecoveryDecision,
  handleRecoveryReview,
  readAdminAudit,
  readAdminRoleCatalogue,
  readAdminSeller,
  readAdminSellers,
  readAdminUser,
  readAdminUserRoles,
  readAdminUserSecurityEvents,
  readAdminUsers,
  readRecoveryEvidence,
  readRecoveryQueue,
  readRecoveryRequest,
  handleSellerStatusChange,
} from '../src/server/bff/admin-operations';

/**
 * The seller, user, recovery and audit BFF, on the admin origin (Phase 7-O).
 *
 * What matters at this boundary:
 *
 *   * the caller's token comes from `__Host-mp_admin_access` and never from a body, and the browser's own
 *     `Cookie` header is never forwarded upstream;
 *   * **bodies are rebuilt, never forwarded** — a `reviewerUserId`, an `approverUserId`, a `status`, a
 *     `holdUntil`, a `sessionsRevokedAt` or an `mfaResetAt` never crosses;
 *   * a storefront is named by slug and an account and a request by their ids, all in the **route**, from a
 *     value checked for shape here;
 *   * responses are validated against the contract before a byte reaches a browser, so a drifted API that
 *     sent a legal name, a contact digest, an object path or an audited row's values would produce a clean
 *     failure rather than a leak;
 *   * the refusals a screen must act on are forwarded with the API's own problem body, and anything else
 *     becomes one 503;
 *   * **there is no handler here that grants a role or changes a storefront's status**, which is asserted
 *     rather than assumed, because both are reported capability gaps.
 *
 * Everything is stubbed at the `fetch` boundary: no API, no database, no network.
 */

const ENV = {
  API_BASE_URL: 'https://api.internal.test',
  INTERNAL_BFF_CREDENTIAL: 'test-admin-operations-canary-credential-abc',
} as const;

const SESSION_TOKEN = 'canary-admin-access-token-not-a-real-token';
const COOKIE = `__Host-mp_admin_access=${SESSION_TOKEN}; __Host-mp_admin_refresh=canary-refresh-not-real`;
const ORIGIN = 'https://admin.test';

const TARGET = '22222222-2222-4222-8222-222222222222';
const REQUEST = 'a8000000-0000-4000-8000-000000000001';
const SLUG = 'a-shop';

const SELLER_ROW = {
  slug: SLUG,
  displayName: 'A Shop',
  status: 'active',
  verificationStatus: 'verified',
  countryCode: 'EG',
  city: 'Cairo',
  listingCount: 3,
  openReportCount: 1,
  createdAt: '2026-05-01T09:00:00.000Z',
};

const SELLER_DETAIL = {
  ...SELLER_ROW,
  bio: 'We sell things.',
  contentLanguage: 'en',
  suspendedAt: null,
  suspensionReason: null,
  closedAt: null,
  verifiedAt: '2026-04-01T09:00:00.000Z',
  governorate: 'Cairo',
  liveListingCount: 2,
  isOwnStorefront: false,
  canManage: true,
};

const USER_ROW = {
  id: TARGET,
  displayName: 'Nadia',
  status: 'active',
  localeCode: 'en',
  hasVerifiedEmail: true,
  hasVerifiedPhone: false,
  isStaff: false,
  isSeller: true,
  isSelf: false,
  createdAt: '2026-05-01T09:00:00.000Z',
};

const USER_DETAIL = {
  ...USER_ROW,
  timezone: 'Africa/Cairo',
  sellerSlug: SLUG,
  lastSeenAt: '2026-05-02T09:00:00.000Z',
};

const ROLE_ROW = {
  roleKey: 'moderator',
  nameEn: 'Moderator',
  nameAr: 'مشرف',
  requiresMfa: true,
  isAdminConsole: true,
  grantedAt: '2026-04-01T09:00:00.000Z',
  expiresAt: null,
  revokedAt: null,
  isEffective: true,
  permissionCount: 7,
};

/**
 * The catalogue's own shape, written out rather than spread from the grant above: the two are different
 * schemas, and a spread would have carried `grantedAt` and `isEffective` into a row that has no place for
 * them. The strict schema refuses that, which is the point of it.
 */
const CATALOGUE_ROW = {
  roleKey: 'moderator',
  nameEn: 'Moderator',
  nameAr: 'مشرف',
  requiresMfa: true,
  isAdminConsole: true,
  isAssignable: true,
  permissionCount: 7,
  holderCount: 2,
};

const EVENT_ROW = {
  id: '42',
  eventType: 'auth.login_failed',
  details: { attempt: 1 },
  occurredAt: '2026-05-03T09:00:00.000Z',
};

const QUEUE_ROW = {
  id: REQUEST,
  status: 'submitted',
  claimedContactChannel: 'email',
  newContactChannel: null,
  matchedAnAccount: true,
  isOwnRequest: false,
  isTheReviewer: false,
  hasBeenReviewed: false,
  contactVerified: false,
  evidenceCount: 2,
  expiresAt: '2026-06-01T09:00:00.000Z',
  createdAt: '2026-05-01T09:00:00.000Z',
};

const REQUEST_DETAIL = {
  id: REQUEST,
  status: 'submitted',
  claimedContactChannel: 'email',
  newContactChannel: null,
  matchedAnAccount: true,
  isOwnRequest: false,
  isTheReviewer: false,
  reviewedByMe: false,
  reviewNote: null,
  reviewedAt: null,
  approvedAt: null,
  rejectionReason: null,
  contactVerifiedAt: null,
  sessionsRevokedAt: null,
  mfaResetAt: null,
  holdUntil: null,
  completedAt: null,
  closedAt: null,
  expiresAt: '2026-06-01T09:00:00.000Z',
  createdAt: '2026-05-01T09:00:00.000Z',
};

const EVIDENCE_ROW = {
  id: 'e8000000-0000-4000-8000-000000000001',
  evidenceType: 'national_id',
  originalFilename: 'id.jpg',
  contentType: 'image/jpeg',
  byteSize: 120000,
  uploadedAt: '2026-05-01T09:05:00.000Z',
};

const AUDIT_ROW = {
  id: '7',
  occurredAt: '2026-05-04T09:00:00.000Z',
  actorType: 'user',
  isOwnAction: false,
  action: 'update',
  tableSchema: 'public',
  tableName: 'listings',
  recordId: '88880000-0000-4000-8000-000000000001',
  changedColumns: ['status'],
  requestId: 'req-one',
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

function postRequest(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/recovery/${path}`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json', cookie: COOKIE, ...headers },
    body: JSON.stringify(body),
  });
}

const OPTIONS = { env: ENV, cookieHeader: COOKIE } as const;

/* ------------------------------------------------------------------------------------------------ */

describe('the eleven reads', () => {
  it('present the caller’s token and the internal credential, and never the browser cookie', async () => {
    const seen: Seen[] = [];
    await readAdminSellers(
      {},
      { ...OPTIONS, fetch: api(200, { items: [SELLER_ROW], nextCursor: null }, seen) },
    );

    expect(seen[0]!.url).toBe('https://api.internal.test/v1/admin/sellers');
    expect(seen[0]!.method).toBe('GET');
    expect(seen[0]!.headers.get('x-session-token')).toBe(SESSION_TOKEN);
    expect(seen[0]!.headers.get('x-internal-credential')).toBe(ENV.INTERNAL_BFF_CREDENTIAL);
    expect(seen[0]!.headers.get('cookie')).toBeNull();
  });

  it('address every read at the path the contract names, with the identifier lower-cased', async () => {
    const seen: Seen[] = [];
    await readAdminSellers({}, { ...OPTIONS, fetch: api(200, { items: [], nextCursor: null }, seen) });
    await readAdminSeller(SLUG, { ...OPTIONS, fetch: api(200, { seller: SELLER_DETAIL }, seen) });
    await readAdminUsers({}, { ...OPTIONS, fetch: api(200, { items: [], nextCursor: null }, seen) });
    await readAdminUser(TARGET.toUpperCase(), {
      ...OPTIONS,
      fetch: api(200, { user: USER_DETAIL }, seen),
    });
    await readAdminUserRoles(TARGET, { ...OPTIONS, fetch: api(200, { items: [] }, seen) });
    await readAdminUserSecurityEvents(TARGET, { ...OPTIONS, fetch: api(200, { items: [] }, seen) });
    await readAdminRoleCatalogue({ ...OPTIONS, fetch: api(200, { items: [] }, seen) });
    await readRecoveryQueue({}, { ...OPTIONS, fetch: api(200, { items: [], nextCursor: null }, seen) });
    await readRecoveryRequest(REQUEST, { ...OPTIONS, fetch: api(200, { request: REQUEST_DETAIL }, seen) });
    await readRecoveryEvidence(REQUEST, { ...OPTIONS, fetch: api(200, { items: [] }, seen) });
    await readAdminAudit({}, { ...OPTIONS, fetch: api(200, { items: [], nextCursor: null }, seen) });

    expect(seen.map((entry) => entry.url.replace('https://api.internal.test', ''))).toEqual([
      '/v1/admin/sellers',
      `/v1/admin/sellers/${SLUG}`,
      '/v1/admin/users',
      `/v1/admin/users/${TARGET}`,
      `/v1/admin/users/${TARGET}/roles`,
      `/v1/admin/users/${TARGET}/security-events`,
      '/v1/admin/roles',
      '/v1/admin/recovery/requests',
      `/v1/admin/recovery/requests/${REQUEST}`,
      `/v1/admin/recovery/requests/${REQUEST}/evidence`,
      '/v1/admin/audit',
    ]);
    expect(seen.every((entry) => entry.method === 'GET' && entry.body === '')).toBe(true);
  });

  it('answer notFound to a malformed address without calling the API at all', async () => {
    const seen: Seen[] = [];
    const fetcher = api(200, {}, seen);
    expect((await readAdminSeller('Not_A_Slug', { ...OPTIONS, fetch: fetcher })).kind).toBe('notFound');
    expect((await readAdminUser('not-a-uuid', { ...OPTIONS, fetch: fetcher })).kind).toBe('notFound');
    expect((await readAdminUserRoles(undefined, { ...OPTIONS, fetch: fetcher })).kind).toBe('notFound');
    expect((await readRecoveryRequest('nope', { ...OPTIONS, fetch: fetcher })).kind).toBe('notFound');
    expect((await readRecoveryEvidence('', { ...OPTIONS, fetch: fetcher })).kind).toBe('notFound');
    expect(seen).toHaveLength(0);
  });

  it('answer unauthenticated without a session cookie, and never call the API', async () => {
    const seen: Seen[] = [];
    const result = await readAdminSellers({}, { env: ENV, cookieHeader: null, fetch: api(200, {}, seen) });
    expect(result.kind).toBe('unauthenticated');
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
      const result = await readAdminSellers({}, { ...OPTIONS, fetch: api(status, {}) });
      expect(result.kind, String(status)).toBe(kind);
    }
  });

  it('refuse a body the contract does not describe rather than passing it on', async () => {
    const result = await readAdminSeller(SLUG, {
      ...OPTIONS,
      // A drifted API that added the owner's account, legal name and contact details.
      fetch: api(200, { seller: { ...SELLER_DETAIL, userId: TARGET, legalName: 'A Shop LLC' } }),
    });
    expect(result.kind).toBe('unavailable');
  });

  it('refuse an audit row carrying the values it must never carry', async () => {
    const result = await readAdminAudit(
      {},
      {
        ...OPTIONS,
        fetch: api(200, {
          items: [{ ...AUDIT_ROW, oldValues: { status: 'pending' }, newValues: { status: 'active' } }],
          nextCursor: null,
        }),
      },
    );
    expect(result.kind).toBe('unavailable');
  });

  it('refuse a recovery row carrying a contact digest or an account', async () => {
    for (const extra of [
      { claimedContactHash: 'abc' },
      { userId: TARGET },
      { reviewerUserId: TARGET },
      { requestIp: '198.51.100.1' },
    ]) {
      const result = await readRecoveryRequest(REQUEST, {
        ...OPTIONS,
        fetch: api(200, { request: { ...REQUEST_DETAIL, ...extra } }),
      });
      expect(result.kind, JSON.stringify(extra)).toBe('unavailable');
    }
  });

  it('refuse an evidence row carrying an object path', async () => {
    const result = await readRecoveryEvidence(REQUEST, {
      ...OPTIONS,
      fetch: api(200, { items: [{ ...EVIDENCE_ROW, objectPath: 'recovery-evidence/a/id.jpg' }] }),
    });
    expect(result.kind).toBe('unavailable');
  });

  it('return the rows the contract describes, unchanged', async () => {
    const sellers = await readAdminSellers(
      {},
      { ...OPTIONS, fetch: api(200, { items: [SELLER_ROW], nextCursor: null }) },
    );
    expect(sellers).toEqual({ kind: 'ok', data: { items: [SELLER_ROW], nextCursor: null } });

    const users = await readAdminUsers(
      {},
      { ...OPTIONS, fetch: api(200, { items: [USER_ROW], nextCursor: null }) },
    );
    expect(users).toEqual({ kind: 'ok', data: { items: [USER_ROW], nextCursor: null } });

    const roles = await readAdminUserRoles(TARGET, { ...OPTIONS, fetch: api(200, { items: [ROLE_ROW] }) });
    expect(roles).toEqual({ kind: 'ok', data: { items: [ROLE_ROW] } });

    const catalogue = await readAdminRoleCatalogue({
      ...OPTIONS,
      fetch: api(200, { items: [CATALOGUE_ROW] }),
    });
    expect(catalogue).toEqual({ kind: 'ok', data: { items: [CATALOGUE_ROW] } });

    const events = await readAdminUserSecurityEvents(TARGET, {
      ...OPTIONS,
      fetch: api(200, { items: [EVENT_ROW] }),
    });
    expect(events).toEqual({ kind: 'ok', data: { items: [EVENT_ROW] } });

    const queue = await readRecoveryQueue(
      {},
      { ...OPTIONS, fetch: api(200, { items: [QUEUE_ROW], nextCursor: null }) },
    );
    expect(queue).toEqual({ kind: 'ok', data: { items: [QUEUE_ROW], nextCursor: null } });

    const audit = await readAdminAudit(
      {},
      { ...OPTIONS, fetch: api(200, { items: [AUDIT_ROW], nextCursor: null }) },
    );
    expect(audit).toEqual({ kind: 'ok', data: { items: [AUDIT_ROW], nextCursor: null } });
  });
});

describe('what reaches the query string', () => {
  it('passes a cursor along as text, without parsing it', async () => {
    const seen: Seen[] = [];
    await readAdminSellers(
      { cursor: 'c3AxfDIwMjYtMDUtMDE' },
      { ...OPTIONS, fetch: api(200, { items: [], nextCursor: null }, seen) },
    );
    expect(seen[0]!.url).toContain('cursor=c3AxfDIwMjYtMDUtMDE');
  });

  it('drops a cursor that is not base64url rather than forwarding it', async () => {
    const seen: Seen[] = [];
    await readAdminSellers(
      { cursor: "'; drop table users; --" },
      { ...OPTIONS, fetch: api(200, { items: [], nextCursor: null }, seen) },
    );
    expect(seen[0]!.url).not.toContain('cursor');
  });

  it('drops a status that is not one the database has', async () => {
    const seen: Seen[] = [];
    await readAdminSellers(
      { status: 'not_a_status' },
      { ...OPTIONS, fetch: api(200, { items: [], nextCursor: null }, seen) },
    );
    await readAdminSellers(
      { status: 'suspended', verificationStatus: 'verified' },
      { ...OPTIONS, fetch: api(200, { items: [], nextCursor: null }, seen) },
    );
    await readAdminUsers(
      { status: 'not_a_status' },
      { ...OPTIONS, fetch: api(200, { items: [], nextCursor: null }, seen) },
    );
    await readRecoveryQueue(
      { status: 'not_a_status' },
      { ...OPTIONS, fetch: api(200, { items: [], nextCursor: null }, seen) },
    );

    expect(seen[0]!.url).not.toContain('status');
    expect(seen[1]!.url).toContain('status=suspended');
    expect(seen[1]!.url).toContain('verificationStatus=verified');
    expect(seen[2]!.url).not.toContain('status');
    expect(seen[3]!.url).not.toContain('status');
  });

  it('sends an audit record only alongside the table it belongs to', async () => {
    const seen: Seen[] = [];
    await readAdminAudit(
      { recordId: 'abc' },
      { ...OPTIONS, fetch: api(200, { items: [], nextCursor: null }, seen) },
    );
    await readAdminAudit(
      { tableSchema: 'public', tableName: 'listings', recordId: 'abc' },
      { ...OPTIONS, fetch: api(200, { items: [], nextCursor: null }, seen) },
    );
    expect(seen[0]!.url).not.toContain('recordId');
    expect(seen[1]!.url).toContain('tableSchema=public');
    expect(seen[1]!.url).toContain('recordId=abc');
  });

  it('drops an audit filter that is not a name', async () => {
    const seen: Seen[] = [];
    for (const filter of ['public; drop', 'PUBLIC', 'public.listings', "public'--", '']) {
      await readAdminAudit(
        { tableSchema: filter, tableName: 'listings' },
        { ...OPTIONS, fetch: api(200, { items: [], nextCursor: null }, seen) },
      );
    }
    expect(seen.every((entry) => !entry.url.includes('tableSchema'))).toBe(true);
  });
});

describe('the seller status write', () => {
  function statusRequest(body: unknown, headers: Record<string, string> = {}): Request {
    return new Request(`${ORIGIN}/api/sellers/status`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json', cookie: COOKIE, ...headers },
      body: JSON.stringify(body),
    });
  }

  it('rebuilds the body from the contract’s two fields', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerStatusChange(
      statusRequest({
        slug: SLUG,
        status: 'suspended',
        reason: '  Selling counterfeits.  ',
        // Every one of these is dropped here, and the API's strict schema would refuse it anyway.
        suspendedAt: '2026-06-01T00:00:00.000Z',
        closedAt: '2026-06-01T00:00:00.000Z',
        verificationStatus: 'verified',
        verifiedAt: '2026-06-01T00:00:00.000Z',
        sellerUserId: TARGET,
        listingStatus: 'archived',
        holdPayouts: true,
      }),
      { ...OPTIONS, fetch: api(200, { outcome: 'updated', status: 'suspended' }, seen) },
    );

    expect(response.status).toBe(200);
    expect(JSON.parse(seen[0]!.body)).toEqual({ status: 'suspended', reason: 'Selling counterfeits.' });
    expect(seen[0]!.url).toBe(`https://api.internal.test/v1/admin/sellers/${SLUG}/status`);
  });

  it('sends no reason when none was given', async () => {
    const seen: Seen[] = [];
    await handleSellerStatusChange(statusRequest({ slug: SLUG, status: 'closed' }), {
      ...OPTIONS,
      fetch: api(200, { outcome: 'updated', status: 'closed' }, seen),
    });
    expect(JSON.parse(seen[0]!.body)).toEqual({ status: 'closed' });
  });

  it('refuses a suspension with no reason without calling the API', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerStatusChange(
      statusRequest({ slug: SLUG, status: 'suspended' }),
      { ...OPTIONS, fetch: api(200, {}, seen) },
    );
    expect(response.status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it('refuses a malformed slug and an unknown status without calling the API', async () => {
    const seen: Seen[] = [];
    const fetcher = api(200, {}, seen);
    expect(
      (await handleSellerStatusChange(statusRequest({ slug: 'Not_A_Slug', status: 'closed' }), {
        ...OPTIONS,
        fetch: fetcher,
      })).status,
    ).toBe(400);
    expect(
      (await handleSellerStatusChange(statusRequest({ slug: SLUG, status: 'archived' }), {
        ...OPTIONS,
        fetch: fetcher,
      })).status,
    ).toBe(400);
    expect(seen).toHaveLength(0);
  });

  /**
   * The transition matrix is the database's. This layer forwards all four of 0009's values and expresses no
   * rule about which pairs are legal, so it cannot get one wrong.
   */
  it('forwards every one of the four statuses rather than judging the transition', async () => {
    const seen: Seen[] = [];
    for (const status of ['pending', 'active', 'suspended', 'closed'] as const) {
      await handleSellerStatusChange(
        statusRequest({ slug: SLUG, status, ...(status === 'suspended' ? { reason: 'A reason.' } : {}) }),
        { ...OPTIONS, fetch: api(200, { outcome: 'updated', status }, seen) },
      );
    }
    expect(seen.map((entry) => JSON.parse(entry.body).status)).toEqual([
      'pending',
      'active',
      'suspended',
      'closed',
    ]);
  });

  it('refuses a request from another origin, before reading the cookie', async () => {
    const seen: Seen[] = [];
    const response = await handleSellerStatusChange(
      statusRequest({ slug: SLUG, status: 'closed' }, { origin: 'https://evil.test' }),
      { ...OPTIONS, fetch: api(200, {}, seen) },
    );
    expect(response.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it('forwards each refusal with the API’s own body', async () => {
    for (const code of [
      'SELLER_STATUS_NOT_ALLOWED',
      'SELLER_STATUS_NO_CHANGE',
      'SELLER_STATUS_NOT_VERIFIED',
      'SELLER_STATUS_ALREADY_VERIFIED',
    ]) {
      const response = await handleSellerStatusChange(statusRequest({ slug: SLUG, status: 'closed' }), {
        ...OPTIONS,
        fetch: api(409, { code, status: 409 }),
      });
      expect(response.status, code).toBe(409);
      expect(((await response.json()) as { code: string }).code, code).toBe(code);
    }
  });

  it('turns a success the contract does not describe into an outage', async () => {
    const response = await handleSellerStatusChange(statusRequest({ slug: SLUG, status: 'closed' }), {
      ...OPTIONS,
      fetch: api(200, { outcome: 'updated', status: 'archived' }),
    });
    expect(response.status).toBe(503);
  });
});

describe('the three recovery writes', () => {
  it('rebuild the review body from the contract’s one field', async () => {
    const seen: Seen[] = [];
    const response = await handleRecoveryReview(
      postRequest('review', {
        requestId: REQUEST,
        note: '  Checked.  ',
        // Every one of these is dropped here, and the API's strict schema would refuse it anyway.
        reviewerUserId: TARGET,
        actorUserId: TARGET,
        status: 'under_review',
        isAal2: true,
        permission: 'security.recovery.review',
      }),
      { ...OPTIONS, fetch: api(200, { outcome: 'reviewed', status: 'under_review' }, seen) },
    );

    expect(response.status).toBe(200);
    expect(JSON.parse(seen[0]!.body)).toEqual({ note: 'Checked.' });
    expect(seen[0]!.url).toBe(`https://api.internal.test/v1/admin/recovery/requests/${REQUEST}/review`);
  });

  it('rebuild the decision body from the contract’s two fields', async () => {
    const seen: Seen[] = [];
    await handleRecoveryDecision(
      postRequest('decision', {
        requestId: REQUEST,
        decision: 'rejected',
        note: 'A reason.',
        approverUserId: TARGET,
        status: 'rejected',
        holdUntil: '2026-06-01T00:00:00.000Z',
      }),
      { ...OPTIONS, fetch: api(200, { outcome: 'decided', status: 'rejected' }, seen) },
    );
    expect(JSON.parse(seen[0]!.body)).toEqual({ decision: 'rejected', note: 'A reason.' });
  });

  it('rebuild the completion body from the contract’s one boolean', async () => {
    const seen: Seen[] = [];
    await handleRecoveryCompletion(
      postRequest('completion', {
        requestId: REQUEST,
        mfaWasReset: true,
        holdUntil: '2026-06-01T00:00:00.000Z',
        sessionsRevokedAt: '2026-06-01T00:00:00.000Z',
        mfaResetAt: '2026-06-01T00:00:00.000Z',
        holdHours: 1,
      }),
      {
        ...OPTIONS,
        fetch: api(200, { outcome: 'completed', holdUntil: '2026-05-10T09:00:00.000Z' }, seen),
      },
    );
    // One field. Nothing that could shorten the hold or claim what the writer records.
    expect(JSON.parse(seen[0]!.body)).toEqual({ mfaWasReset: true });
  });

  it('treat a missing mfaWasReset as false rather than passing whatever arrived', async () => {
    const seen: Seen[] = [];
    await handleRecoveryCompletion(postRequest('completion', { requestId: REQUEST, mfaWasReset: 'yes' }), {
      ...OPTIONS,
      fetch: api(200, { outcome: 'completed', holdUntil: null }, seen),
    });
    expect(JSON.parse(seen[0]!.body)).toEqual({ mfaWasReset: false });
  });

  it('refuse a request from another origin, before reading the cookie', async () => {
    const seen: Seen[] = [];
    const response = await handleRecoveryReview(
      postRequest('review', { requestId: REQUEST }, { origin: 'https://evil.test' }),
      { ...OPTIONS, fetch: api(200, {}, seen) },
    );
    expect(response.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it('refuse a request with no session cookie', async () => {
    const seen: Seen[] = [];
    const request = new Request(`${ORIGIN}/api/recovery/review`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: REQUEST }),
    });
    const response = await handleRecoveryReview(request, { env: ENV, cookieHeader: null, fetch: api(200, {}, seen) });
    expect(response.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('refuse a malformed identifier and a malformed decision without calling the API', async () => {
    const seen: Seen[] = [];
    const fetcher = api(200, {}, seen);
    expect((await handleRecoveryReview(postRequest('review', { requestId: 'nope' }), { ...OPTIONS, fetch: fetcher })).status).toBe(400);
    expect(
      (
        await handleRecoveryDecision(postRequest('decision', { requestId: REQUEST, decision: 'maybe' }), {
          ...OPTIONS,
          fetch: fetcher,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await handleRecoveryDecision(postRequest('decision', { requestId: REQUEST, decision: 'rejected' }), {
          ...OPTIONS,
          fetch: fetcher,
        })
      ).status,
    ).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it('forward the refusals a screen must act on, with the API’s own body', async () => {
    for (const [status, code] of [
      [409, 'RECOVERY_NEEDS_ANOTHER_PERSON'],
      [409, 'RECOVERY_IS_OWN'],
      [409, 'RECOVERY_NOT_REVIEWABLE'],
      [404, 'NOT_FOUND'],
      [401, 'AUTHENTICATION_REQUIRED'],
    ] as const) {
      const response = await handleRecoveryReview(postRequest('review', { requestId: REQUEST }), {
        ...OPTIONS,
        fetch: api(status, { code, status }),
      });
      expect(response.status, code).toBe(status);
      expect(((await response.json()) as { code: string }).code, code).toBe(code);
    }
  });

  it('turn an unrecognised upstream status into one outage', async () => {
    for (const status of [418, 500, 502]) {
      const response = await handleRecoveryReview(postRequest('review', { requestId: REQUEST }), {
        ...OPTIONS,
        fetch: api(status, { code: 'SOMETHING' }),
      });
      expect(response.status, String(status)).toBe(503);
    }
  });

  it('turn a success the contract does not describe into an outage', async () => {
    const response = await handleRecoveryCompletion(
      postRequest('completion', { requestId: REQUEST, mfaWasReset: false }),
      { ...OPTIONS, fetch: api(200, { outcome: 'completed', holdUntil: 'not-a-time' }) },
    );
    expect(response.status).toBe(503);
  });

  it('never let a response be cached', async () => {
    const response = await handleRecoveryReview(postRequest('review', { requestId: REQUEST }), {
      ...OPTIONS,
      fetch: api(200, { outcome: 'reviewed', status: 'under_review' }),
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('role assignment has no handler, and seller status has exactly one', () => {
  it('exports nothing that grants a role, and no separate suspend, close or reinstate', async () => {
    const bff = (await import('../src/server/bff/admin-operations')) as Record<string, unknown>;
    const exported = Object.keys(bff).sort();
    for (const name of exported) {
      const lower = name.toLowerCase();
      // Role words: the deferred writer has no handler here. And no per-transition seller handler either —
      // the matrix is the database's, so one status handler carries all of it.
      for (const forbidden of ['grant', 'revoke', 'assign', 'suspend', 'close', 'reinstate']) {
        expect(lower, `${name}: ${forbidden}`).not.toContain(forbidden);
      }
    }
    // What it does export: eleven reads, three recovery writes and the one seller status write.
    expect(exported.filter((name) => name.startsWith('handle')).sort()).toEqual([
      'handleRecoveryCompletion',
      'handleRecoveryDecision',
      'handleRecoveryReview',
      'handleSellerStatusChange',
    ]);
  });

  it('addresses no upstream path that writes a role or a seller', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../src/server/bff/admin-operations.ts', import.meta.url), 'utf8'),
    );
    // What matters is what it can *address* and what it can *send*, not which tables its prose names —
    // the module's own comments explain at length that no writer for `user_roles` exists, and saying so
    // is the opposite of writing one.
    for (const forbidden of [
      "method: 'POST'",
      'roleKey:',
      'permissionKey',
      '/suspension',
      '/reinstatement',
      '/closure',
      'verificationStatus:',
      'suspendedAt:',
      'closedAt:',
    ]) {
      const occurrences = source.split(forbidden).length - 1;
      // One POST: the shared `callWrite`, which the three recovery steps and the one status write reach.
      expect(occurrences, forbidden).toBe(forbidden === "method: 'POST'" ? 1 : 0);
    }
    // The only POSTs it can make are the three recovery steps.
    const posts = [...source.matchAll(/\/v1\/admin\/[^`$]*\/\$\{encodeURIComponent\([a-zA-Z]+\)\}\/([\w-]+)/g)].map(
      (match) => match[1],
    );
    expect([...new Set(posts)].sort()).toEqual([
      'completion',
      'decision',
      'evidence',
      'review',
      'roles',
      'security-events',
      'status',
    ]);
  });
});
