import { describe, expect, it } from 'vitest';
import {
  handleModerationListingAction,
  handleModerationReportResolution,
  readListingModerationHistory,
  readModerationListing,
  readModerationListings,
  readModerationReport,
  readModerationReportActions,
  readModerationReports,
} from '../src/server/bff/moderation';

/**
 * The moderation console's BFF, on the admin origin (Phase 7-N).
 *
 * What matters at this boundary:
 *
 *   * the caller's token comes from `__Host-mp_admin_access` and never from a body, and the browser's own
 *     `Cookie` header is never forwarded upstream;
 *   * **bodies are rebuilt, never forwarded** — a `moderatorUserId`, a `status` on a listing decision, a
 *     `priority`, an `expiresAt` or a `reversesActionId` never crosses;
 *   * a report and a listing are named in the **route**, from an identifier checked for shape here;
 *   * responses are validated against the contract before a byte reaches a browser, so a drifted API that
 *     sent an account would produce a clean failure rather than a leak;
 *   * the four conflicts a screen must act on are forwarded with the API's own problem body, and anything
 *     else becomes one 503.
 *
 * Everything is stubbed at the `fetch` boundary: no API, no database, no network.
 */

const ENV = {
  API_BASE_URL: 'https://api.internal.test',
  INTERNAL_BFF_CREDENTIAL: 'test-admin-moderation-canary-credential-not',
} as const;

const SESSION_TOKEN = 'canary-admin-access-token-not-a-real-token';
const COOKIE = `__Host-mp_admin_access=${SESSION_TOKEN}; __Host-mp_admin_refresh=canary-refresh-not-real`;
const ORIGIN = 'https://admin.test';

const REPORT = 'c0000000-0000-4000-8000-00000000000a';
const OTHER_REPORT = 'c0000000-0000-4000-8000-00000000000b';
const LISTING = '22220000-0000-4000-8000-000000000001';
const IMPOSTOR = '99999999-9999-4999-8999-999999999999';

const REPORT_ROW = {
  id: REPORT,
  subjectType: 'listing',
  subjectLabel: 'A listing',
  reasonCode: 'counterfeit',
  status: 'open',
  priority: 'normal',
  isOwnReport: false,
  actionCount: 0,
  createdAt: '2026-05-01T09:00:00.000Z',
};

const REPORT_DETAIL = {
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
  createdAt: '2026-05-01T09:00:00.000Z',
  updatedAt: '2026-05-01T09:00:00.000Z',
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
  reportCount: 0,
  createdAt: '2026-05-01T09:00:00.000Z',
};

const LISTING_DETAIL = {
  id: LISTING,
  slug: 'a-listing',
  title: 'A listing',
  description: 'A description.',
  contentLanguage: 'en',
  status: 'pending_review',
  listingTypeCode: 'product',
  currencyCode: 'EGP',
  priceMinor: '150000',
  city: 'Cairo',
  sellerSlug: 'a-shop',
  sellerDisplayName: 'A Shop',
  isOwnListing: false,
  canModerate: true,
  openReportCount: 0,
  createdAt: '2026-05-01T09:00:00.000Z',
  approvedAt: null,
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
  createdAt: '2026-05-02T09:00:00.000Z',
};

const TRAIL_ROW = {
  id: 'e0000000-0000-4000-8000-00000000000a',
  action: 'suspend',
  fromStatus: 'active',
  toStatus: 'suspended',
  reason: 'A reason.',
  reportId: null,
  isOwnAction: false,
  createdAt: '2026-05-02T09:00:00.000Z',
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
  return new Request(`${ORIGIN}/api/moderation/${path}`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json', cookie: COOKIE, ...headers },
    body: JSON.stringify(body),
  });
}

const RESOLVE = { reportId: REPORT, status: 'actioned', resolutionNote: 'A reason.' };
const MODERATE = { listingId: LISTING, action: 'suspend', reason: 'A reason.' };

/* ------------------------------------------------------------------------------------------------ */

describe('the six reads', () => {
  it('present the caller’s token and the internal credential, and never the browser cookie', async () => {
    const seen: Seen[] = [];
    await readModerationReports(
      {},
      { env: ENV, cookieHeader: COOKIE, fetch: api(200, { items: [REPORT_ROW], nextCursor: null }, seen) },
    );

    expect(seen[0]!.url).toBe('https://api.internal.test/v1/admin/moderation/reports');
    expect(seen[0]!.method).toBe('GET');
    expect(seen[0]!.headers.get('x-session-token')).toBe(SESSION_TOKEN);
    expect(seen[0]!.headers.get('x-internal-credential')).toBe(ENV.INTERNAL_BFF_CREDENTIAL);
    expect(seen[0]!.headers.get('cookie')).toBeNull();
  });

  it('address every read at the path the contract names, with the identifier lower-cased', async () => {
    const seen: Seen[] = [];
    const options = { env: ENV, cookieHeader: COOKIE };
    await readModerationReports({}, { ...options, fetch: api(200, { items: [], nextCursor: null }, seen) });
    await readModerationReport(REPORT.toUpperCase(), {
      ...options,
      fetch: api(200, { report: REPORT_DETAIL }, seen),
    });
    await readModerationReportActions(REPORT, { ...options, fetch: api(200, { items: [] }, seen) });
    await readModerationListings({}, { ...options, fetch: api(200, { items: [], nextCursor: null }, seen) });
    await readModerationListing(LISTING, {
      ...options,
      fetch: api(200, { listing: LISTING_DETAIL }, seen),
    });
    await readListingModerationHistory(LISTING, { ...options, fetch: api(200, { items: [] }, seen) });

    expect(seen.map((request) => request.url)).toEqual([
      'https://api.internal.test/v1/admin/moderation/reports',
      `https://api.internal.test/v1/admin/moderation/reports/${REPORT}`,
      `https://api.internal.test/v1/admin/moderation/reports/${REPORT}/actions`,
      'https://api.internal.test/v1/admin/moderation/listings',
      `https://api.internal.test/v1/admin/moderation/listings/${LISTING}`,
      `https://api.internal.test/v1/admin/moderation/listings/${LISTING}/history`,
    ]);
    for (const request of seen) {
      expect(request.url).not.toContain('userId');
      expect(request.url).not.toContain('permission');
      expect(request.url).not.toContain('isAal2');
    }
  });

  it('pass a cursor and a limit through, and a status only if the database has it', async () => {
    const seen: Seen[] = [];
    await readModerationReports(
      { limit: '5', cursor: 'bXIxfGNhbmFyeQ', status: 'triaged' },
      { env: ENV, cookieHeader: COOKIE, fetch: api(200, { items: [], nextCursor: null }, seen) },
    );
    expect(seen[0]!.url).toContain('limit=5');
    expect(seen[0]!.url).toContain('status=triaged');
    expect(seen[0]!.url).toContain('cursor=bXIxfGNhbmFyeQ');

    // An invented status is dropped rather than forwarded, so a mistyped bookmark shows the whole queue.
    await readModerationReports(
      { status: 'not_a_status' },
      { env: ENV, cookieHeader: COOKIE, fetch: api(200, { items: [], nextCursor: null }, seen) },
    );
    expect(seen[1]!.url).toBe('https://api.internal.test/v1/admin/moderation/reports');
  });

  it('refuse a cursor that is not base64url rather than forwarding it', async () => {
    const seen: Seen[] = [];
    await readModerationReports(
      { cursor: 'not base64url!!' },
      { env: ENV, cookieHeader: COOKIE, fetch: api(200, { items: [], nextCursor: null }, seen) },
    );
    expect(seen[0]!.url).not.toContain('cursor');
  });

  it('answer notFound for an identifier that is not one, without asking', async () => {
    const seen: Seen[] = [];
    const options = { env: ENV, cookieHeader: COOKIE, fetch: api(200, {}, seen) };
    expect((await readModerationReport('nope', options)).kind).toBe('notFound');
    expect((await readModerationReportActions('nope', options)).kind).toBe('notFound');
    expect((await readModerationListing('nope', options)).kind).toBe('notFound');
    expect((await readListingModerationHistory('nope', options)).kind).toBe('notFound');
    expect(seen).toHaveLength(0);
  });

  it('answer unauthenticated with no session, without asking', async () => {
    const seen: Seen[] = [];
    const options = { env: ENV, cookieHeader: null, fetch: api(200, {}, seen) };
    expect((await readModerationReports({}, options)).kind).toBe('unauthenticated');
    expect((await readModerationListings({}, options)).kind).toBe('unauthenticated');
    expect((await readModerationReport(REPORT, options)).kind).toBe('unauthenticated');
    expect(seen).toHaveLength(0);
  });

  it('keep the four refusals apart', async () => {
    for (const [status, kind] of [
      [401, 'unauthenticated'],
      [404, 'notFound'],
      [400, 'invalid'],
      [503, 'unavailable'],
      [500, 'unavailable'],
    ] as const) {
      const result = await readModerationReports(
        {},
        { env: ENV, cookieHeader: COOKIE, fetch: api(status, { code: 'X' }) },
      );
      expect(result.kind, String(status)).toBe(kind);
    }
  });

  it('return the rows each queue carries', async () => {
    const reports = await readModerationReports(
      {},
      { env: ENV, cookieHeader: COOKIE, fetch: api(200, { items: [REPORT_ROW], nextCursor: null }) },
    );
    expect(reports.kind === 'ok' ? reports.data.items[0]!.subjectLabel : null).toBe('A listing');

    const listings = await readModerationListings(
      {},
      { env: ENV, cookieHeader: COOKIE, fetch: api(200, { items: [LISTING_ROW], nextCursor: null }) },
    );
    expect(listings.kind === 'ok' ? listings.data.items[0]!.slug : null).toBe('a-listing');
    // A minor amount crosses as the decimal string the contract carries, never as a number.
    expect(listings.kind === 'ok' ? listings.data.items[0]!.priceMinor : null).toBe('150000');
  });

  it('unwrap the two envelopes the contract wraps', async () => {
    const report = await readModerationReport(REPORT, {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: api(200, { report: REPORT_DETAIL }),
    });
    expect(report.kind === 'ok' ? report.data.id : null).toBe(REPORT);

    const listing = await readModerationListing(LISTING, {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: api(200, { listing: LISTING_DETAIL }),
    });
    expect(listing.kind === 'ok' ? listing.data.canModerate : null).toBe(true);
  });

  it('refuse a drifted answer rather than forwarding it', async () => {
    const options = { env: ENV, cookieHeader: COOKIE };
    // Each of these is an API that has started sending an account. The contract is the wall.
    expect(
      (
        await readModerationReports(
          {},
          { ...options, fetch: api(200, { items: [{ ...REPORT_ROW, reporterUserId: IMPOSTOR }], nextCursor: null }) },
        )
      ).kind,
    ).toBe('unavailable');
    expect(
      (
        await readModerationReport(REPORT, {
          ...options,
          fetch: api(200, { report: { ...REPORT_DETAIL, resolvedBy: IMPOSTOR } }),
        })
      ).kind,
    ).toBe('unavailable');
    expect(
      (
        await readModerationListing(LISTING, {
          ...options,
          fetch: api(200, { listing: { ...LISTING_DETAIL, sellerUserId: IMPOSTOR } }),
        })
      ).kind,
    ).toBe('unavailable');
    expect(
      (
        await readModerationReportActions(REPORT, {
          ...options,
          fetch: api(200, { items: [{ ...ACTION_ROW, moderatorUserId: IMPOSTOR }] }),
        })
      ).kind,
    ).toBe('unavailable');
    expect(
      (
        await readListingModerationHistory(LISTING, {
          ...options,
          fetch: api(200, { items: [{ ...TRAIL_ROW, moderatorUserId: IMPOSTOR }] }),
        })
      ).kind,
    ).toBe('unavailable');
  });

  it('answer unavailable when the API cannot be reached at all', async () => {
    const result = await readModerationReports(
      {},
      {
        env: ENV,
        cookieHeader: COOKIE,
        fetch: (async () => {
          throw new Error('connection refused');
        }) as unknown as typeof fetch,
      },
    );
    expect(result.kind).toBe('unavailable');
  });
});

describe('recording a decision on a report', () => {
  it('sends exactly the contract’s fields, to the report in the route', async () => {
    const seen: Seen[] = [];
    const response = await handleModerationReportResolution(
      postRequest('reports/resolution', RESOLVE),
      { env: ENV, fetch: api(200, { outcome: 'resolved', status: 'actioned' }, seen) },
    );

    expect(response.status).toBe(200);
    expect(seen[0]!.url).toBe(
      `https://api.internal.test/v1/admin/moderation/reports/${REPORT}/resolution`,
    );
    expect(JSON.parse(seen[0]!.body)).toEqual({ status: 'actioned', resolutionNote: 'A reason.' });
    expect(seen[0]!.headers.get('cookie')).toBeNull();
  });

  it('drops everything the contract does not name', async () => {
    const seen: Seen[] = [];
    await handleModerationReportResolution(
      postRequest('reports/resolution', {
        ...RESOLVE,
        moderatorUserId: IMPOSTOR,
        userId: IMPOSTOR,
        resolvedBy: IMPOSTOR,
        priority: 'high',
        assignedTo: IMPOSTOR,
        permission: 'moderation.report.manage',
        isAal2: true,
      }),
      { env: ENV, fetch: api(200, { outcome: 'resolved', status: 'actioned' }, seen) },
    );
    expect(JSON.parse(seen[0]!.body)).toEqual({ status: 'actioned', resolutionNote: 'A reason.' });
    for (const secret of [IMPOSTOR, 'priority', 'assignedTo', 'permission', 'isAal2']) {
      expect(seen[0]!.body, secret).not.toContain(secret);
    }
  });

  it('sends the original only for a duplicate', async () => {
    const seen: Seen[] = [];
    await handleModerationReportResolution(
      postRequest('reports/resolution', {
        reportId: REPORT,
        status: 'duplicate',
        resolutionNote: 'A reason.',
        duplicateOfReportId: OTHER_REPORT.toUpperCase(),
      }),
      { env: ENV, fetch: api(200, { outcome: 'resolved', status: 'duplicate' }, seen) },
    );
    expect(JSON.parse(seen[0]!.body)).toEqual({
      status: 'duplicate',
      resolutionNote: 'A reason.',
      duplicateOfReportId: OTHER_REPORT,
    });
  });

  it('refuses a body the contract does not accept, without asking the API', async () => {
    const seen: Seen[] = [];
    for (const body of [
      { reportId: REPORT },
      { reportId: REPORT, status: 'open' },
      { reportId: REPORT, status: 'reopened', resolutionNote: 'A reason.' },
      { reportId: REPORT, status: 'actioned' },
      { reportId: REPORT, status: 'duplicate', resolutionNote: 'A reason.' },
      { reportId: 'nope', status: 'actioned', resolutionNote: 'A reason.' },
      { status: 'actioned', resolutionNote: 'A reason.' },
    ]) {
      const response = await handleModerationReportResolution(postRequest('reports/resolution', body), {
        env: ENV,
        fetch: api(200, {}, seen),
      });
      expect(response.status, JSON.stringify(body).slice(0, 48)).toBe(400);
    }
    expect(seen).toHaveLength(0);
  });

  it('trims the note and drops an empty one', async () => {
    const seen: Seen[] = [];
    await handleModerationReportResolution(
      postRequest('reports/resolution', { reportId: REPORT, status: 'triaged', resolutionNote: '   ' }),
      { env: ENV, fetch: api(200, { outcome: 'resolved', status: 'triaged' }, seen) },
    );
    expect(JSON.parse(seen[0]!.body)).toEqual({ status: 'triaged' });
  });

  it('forwards the refusals a screen must act on, with the API’s own code', async () => {
    for (const [status, code] of [
      [404, 'NOT_FOUND'],
      [409, 'REPORT_ALREADY_FINAL'],
      [409, 'REPORT_IS_OWN'],
    ] as const) {
      const response = await handleModerationReportResolution(
        postRequest('reports/resolution', RESOLVE),
        { env: ENV, fetch: api(status, { code }) },
      );
      expect(response.status, code).toBe(status);
      expect((await response.json())['code'], code).toBe(code);
    }
  });
});

describe('moderating a listing', () => {
  it('sends exactly the contract’s fields, to the listing in the route', async () => {
    const seen: Seen[] = [];
    const response = await handleModerationListingAction(postRequest('listings/action', MODERATE), {
      env: ENV,
      fetch: api(200, { outcome: 'moderated', status: 'suspended' }, seen),
    });

    expect(response.status).toBe(200);
    expect(seen[0]!.url).toBe(
      `https://api.internal.test/v1/admin/moderation/listings/${LISTING}/actions`,
    );
    expect(JSON.parse(seen[0]!.body)).toEqual({ action: 'suspend', reason: 'A reason.' });
  });

  it('drops a status, an expiry, a reversal and anything that names an account', async () => {
    const seen: Seen[] = [];
    await handleModerationListingAction(
      postRequest('listings/action', {
        ...MODERATE,
        status: 'deleted',
        toStatus: 'deleted',
        expiresAt: '2026-06-01T09:00:00.000Z',
        reversesActionId: OTHER_REPORT,
        moderatorUserId: IMPOSTOR,
        sellerUserId: IMPOSTOR,
        objectPath: 'listing-media/x.png',
      }),
      { env: ENV, fetch: api(200, { outcome: 'moderated', status: 'suspended' }, seen) },
    );
    expect(JSON.parse(seen[0]!.body)).toEqual({ action: 'suspend', reason: 'A reason.' });
    for (const secret of [IMPOSTOR, 'expiresAt', 'reversesActionId', 'objectPath', 'deleted']) {
      expect(seen[0]!.body, secret).not.toContain(secret);
    }
  });

  it('may cite the report that prompted it', async () => {
    const seen: Seen[] = [];
    await handleModerationListingAction(
      postRequest('listings/action', { ...MODERATE, reportId: REPORT.toUpperCase() }),
      { env: ENV, fetch: api(200, { outcome: 'moderated', status: 'suspended' }, seen) },
    );
    expect(JSON.parse(seen[0]!.body)).toEqual({
      action: 'suspend',
      reason: 'A reason.',
      reportId: REPORT,
    });
  });

  it('refuses a body the contract does not accept, without asking the API', async () => {
    const seen: Seen[] = [];
    for (const body of [
      { listingId: LISTING },
      { listingId: LISTING, action: 'remove', reason: 'A reason.' },
      { listingId: LISTING, action: 'suspend' },
      { listingId: LISTING, action: 'suspend', reason: '   ' },
      { listingId: LISTING, action: 'suspend', reason: 'x'.repeat(501) },
      { listingId: 'nope', action: 'suspend', reason: 'A reason.' },
      { action: 'suspend', reason: 'A reason.' },
    ]) {
      const response = await handleModerationListingAction(postRequest('listings/action', body), {
        env: ENV,
        fetch: api(200, {}, seen),
      });
      expect(response.status, JSON.stringify(body).slice(0, 48)).toBe(400);
    }
    expect(seen).toHaveLength(0);
  });

  it('forwards the three refusals a screen must act on', async () => {
    for (const [status, code] of [
      [404, 'NOT_FOUND'],
      [409, 'LISTING_MODERATION_NO_CHANGE'],
      [409, 'LISTING_MODERATION_NOT_APPLICABLE'],
      [409, 'LISTING_IS_OWN'],
    ] as const) {
      const response = await handleModerationListingAction(postRequest('listings/action', MODERATE), {
        env: ENV,
        fetch: api(status, { code }),
      });
      expect(response.status, code).toBe(status);
      expect((await response.json())['code'], code).toBe(code);
    }
  });
});

describe('both writes', () => {
  it('refuse a cross-origin request before reading the session', async () => {
    const seen: Seen[] = [];
    for (const handler of [handleModerationReportResolution, handleModerationListingAction]) {
      const response = await handler(
        postRequest('reports/resolution', RESOLVE, { origin: 'https://evil.test' }),
        { env: ENV, fetch: api(200, {}, seen) },
      );
      expect(response.status).toBe(403);
    }
    expect(seen).toHaveLength(0);
  });

  it('refuse a request with no session', async () => {
    const seen: Seen[] = [];
    const request = new Request(`${ORIGIN}/api/moderation/reports/resolution`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify(RESOLVE),
    });
    const response = await handleModerationReportResolution(request, { env: ENV, fetch: api(200, {}, seen) });
    expect(response.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('turn an unexpected upstream status into one 503', async () => {
    for (const status of [201, 302, 418, 500, 502]) {
      const response = await handleModerationReportResolution(
        postRequest('reports/resolution', RESOLVE),
        { env: ENV, fetch: api(status, { outcome: 'resolved', status: 'actioned' }) },
      );
      expect(response.status, String(status)).toBe(503);
    }
  });

  it('refuse a drifted success rather than passing it on', async () => {
    const response = await handleModerationListingAction(postRequest('listings/action', MODERATE), {
      env: ENV,
      fetch: api(200, { outcome: 'moderated', status: 'suspended', moderatorUserId: IMPOSTOR }),
    });
    expect(response.status).toBe(503);
  });

  it('never let a response be cached', async () => {
    const response = await handleModerationListingAction(postRequest('listings/action', MODERATE), {
      env: ENV,
      fetch: api(200, { outcome: 'moderated', status: 'suspended' }),
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
