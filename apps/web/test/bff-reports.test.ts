import { describe, expect, it } from 'vitest';
import { handleFileSubjectReport, readOwnReports } from '../src/server/bff/reports';

/**
 * The reporting BFF, on the buyer origin (Phase 7-M).
 *
 * What matters at this boundary:
 *
 *   * the caller's token comes from `__Host-mp_access` and never from a body, and the browser's own `Cookie`
 *     header is never forwarded upstream;
 *   * **the body is rebuilt, never forwarded** — a `reporterUserId`, a `subjectId`, a `status`, a `priority`
 *     or an `assignedTo` never crosses, and a request carrying one is either refused or has it dropped;
 *   * a response is validated against the contract before a byte of it reaches a browser, so a drifted API
 *     that sent moderation state would produce a clean failure rather than a leak;
 *   * a cursor is passed through as opaque text and never parsed here;
 *   * the four refusals a form must act on are forwarded with the API's own problem body, and anything else
 *     becomes one 503.
 *
 * Everything is stubbed at the `fetch` boundary: no API, no database, no network.
 */

const ENV = {
  API_BASE_URL: 'https://api.internal.test',
  PUBLIC_WEB_ORIGIN: 'https://web.test',
  INTERNAL_BFF_CREDENTIAL: 'test-web-reports-canary-credential-notreal1',
} as const;

const SESSION_TOKEN = 'caller-access-token-value-not-a-real-token';
const COOKIE = `__Host-mp_access=${SESSION_TOKEN}; __Host-mp_refresh=refresh-value-not-a-real-token-x`;
const ORIGIN = 'https://buyer.test';
const REPORT = 'c0000000-0000-4000-8000-00000000000a';
const IMPOSTOR = '99999999-9999-4999-8999-999999999999';

const VALID = { subjectType: 'listing', subjectSlug: 'a-real-listing-slug', reasonCode: 'counterfeit' };

const ROW = {
  id: REPORT,
  subjectType: 'listing',
  subjectSlug: 'a-real-listing-slug',
  subjectLabel: 'A real listing',
  reasonCode: 'counterfeit',
  details: 'What they did.',
  status: 'open',
  createdAt: '2026-05-01T09:00:00.000Z',
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
      headers: {
        'content-type':
          status >= 400 ? 'application/problem+json' : 'application/json',
      },
    });
  }) as unknown as typeof fetch;
}

function postRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/reports`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json', cookie: COOKIE, ...headers },
    body: JSON.stringify(body),
  });
}

/* ------------------------------------------------------------------------------------------------ */

describe('the read', () => {
  it('presents the caller’s token and the internal credential, and never the browser cookie', async () => {
    const seen: Seen[] = [];
    await readOwnReports({}, { env: ENV, cookieHeader: COOKIE, fetch: api(200, { items: [ROW], nextCursor: null }, seen) });

    expect(seen[0]!.url).toBe('https://api.internal.test/v1/reports');
    expect(seen[0]!.method).toBe('GET');
    expect(seen[0]!.headers.get('x-session-token')).toBe(SESSION_TOKEN);
    expect(seen[0]!.headers.get('x-internal-credential')).toBe(ENV.INTERNAL_BFF_CREDENTIAL);
    expect(seen[0]!.headers.get('cookie')).toBeNull();
  });

  it('returns the page it validated', async () => {
    const result = await readOwnReports(
      {},
      { env: ENV, cookieHeader: COOKIE, fetch: api(200, { items: [ROW], nextCursor: null }) },
    );
    expect(result.kind).toBe('ok');
    expect(result.kind === 'ok' ? result.data.items[0]!.id : null).toBe(REPORT);
  });

  it('passes a cursor and a limit through without reading either', async () => {
    const seen: Seen[] = [];
    await readOwnReports(
      { limit: '5', cursor: 'cnAxfGNhbmFyeQ' },
      { env: ENV, cookieHeader: COOKIE, fetch: api(200, { items: [], nextCursor: null }, seen) },
    );
    expect(seen[0]!.url).toBe('https://api.internal.test/v1/reports?limit=5&cursor=cnAxfGNhbmFyeQ');
  });

  it('answers unauthenticated without asking the API anything', async () => {
    const seen: Seen[] = [];
    const result = await readOwnReports({}, { env: ENV, cookieHeader: null, fetch: api(200, {}, seen) });
    expect(result.kind).toBe('unauthenticated');
    expect(seen).toHaveLength(0);
  });

  it('keeps the three refusals apart', async () => {
    for (const [status, kind] of [
      [401, 'unauthenticated'],
      [400, 'invalid'],
      [503, 'unavailable'],
      [404, 'unavailable'],
    ] as const) {
      const result = await readOwnReports(
        {},
        { env: ENV, cookieHeader: COOKIE, fetch: api(status, { code: 'X' }) },
      );
      expect(result.kind, String(status)).toBe(kind);
    }
  });

  it('refuses a drifted page rather than forwarding it', async () => {
    // A reader that returned moderation state: this layer is the third wall in front of it.
    const result = await readOwnReports(
      {},
      {
        env: ENV,
        cookieHeader: COOKIE,
        fetch: api(200, {
          items: [{ ...ROW, priority: 'high', assignedTo: IMPOSTOR, resolutionNote: 'internal' }],
          nextCursor: null,
        }),
      },
    );
    expect(result.kind).toBe('unavailable');
  });

  it('refuses a page whose row names the subject by id', async () => {
    const { subjectSlug: _slug, ...withoutSlug } = ROW;
    const result = await readOwnReports(
      {},
      {
        env: ENV,
        cookieHeader: COOKIE,
        fetch: api(200, {
          items: [{ ...withoutSlug, subjectId: '22220000-0000-4000-8000-000000000001' }],
          nextCursor: null,
        }),
      },
    );
    expect(result.kind).toBe('unavailable');
  });

  it('answers unavailable when the API cannot be reached at all', async () => {
    const result = await readOwnReports(
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

describe('the write', () => {
  it('files a report and answers 201 with the validated body', async () => {
    const seen: Seen[] = [];
    const response = await handleFileSubjectReport(postRequest(VALID), {
      env: ENV,
      fetch: api(201, { outcome: 'filed', reportId: REPORT }, seen),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ outcome: 'filed', reportId: REPORT });
    expect(seen[0]!.url).toBe('https://api.internal.test/v1/reports');
    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.headers.get('x-session-token')).toBe(SESSION_TOKEN);
    expect(seen[0]!.headers.get('cookie')).toBeNull();
  });

  it('sends exactly the four contract fields', async () => {
    const seen: Seen[] = [];
    await handleFileSubjectReport(postRequest({ ...VALID, details: 'What they did.' }), {
      env: ENV,
      fetch: api(201, { outcome: 'filed', reportId: REPORT }, seen),
    });
    expect(JSON.parse(seen[0]!.body)).toEqual({
      subjectType: 'listing',
      subjectSlug: 'a-real-listing-slug',
      reasonCode: 'counterfeit',
      details: 'What they did.',
    });
  });

  it('drops everything the contract does not name rather than forwarding it', async () => {
    const seen: Seen[] = [];
    await handleFileSubjectReport(
      postRequest({
        ...VALID,
        reporterUserId: IMPOSTOR,
        userId: IMPOSTOR,
        subjectId: '22220000-0000-4000-8000-000000000001',
        status: 'actioned',
        priority: 'high',
        assignedTo: IMPOSTOR,
        resolution: 'dismissed',
        resolutionNote: 'an internal note',
      }),
      { env: ENV, fetch: api(201, { outcome: 'filed', reportId: REPORT }, seen) },
    );

    expect(JSON.parse(seen[0]!.body)).toEqual(VALID);
    for (const secret of [IMPOSTOR, 'priority', 'assignedTo', 'resolution', 'an internal note', 'subjectId']) {
      expect(seen[0]!.body, secret).not.toContain(secret);
    }
  });

  it('omits an empty details box rather than sending an empty string', async () => {
    const seen: Seen[] = [];
    await handleFileSubjectReport(postRequest({ ...VALID, details: '   ' }), {
      env: ENV,
      fetch: api(201, { outcome: 'filed', reportId: REPORT }, seen),
    });
    expect(JSON.parse(seen[0]!.body)).toEqual(VALID);
    expect(Object.keys(JSON.parse(seen[0]!.body) as object)).not.toContain('details');
  });

  it('trims what it does send', async () => {
    const seen: Seen[] = [];
    await handleFileSubjectReport(postRequest({ ...VALID, details: '  what they said  ' }), {
      env: ENV,
      fetch: api(201, { outcome: 'filed', reportId: REPORT }, seen),
    });
    expect((JSON.parse(seen[0]!.body) as { details: string }).details).toBe('what they said');
  });

  it('refuses a cross-origin request before reading the session', async () => {
    const seen: Seen[] = [];
    const response = await handleFileSubjectReport(
      postRequest(VALID, { origin: 'https://evil.test' }),
      { env: ENV, fetch: api(201, {}, seen) },
    );
    expect(response.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it('refuses a request with no session', async () => {
    const seen: Seen[] = [];
    const request = new Request(`${ORIGIN}/api/reports`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify(VALID),
    });
    const response = await handleFileSubjectReport(request, { env: ENV, fetch: api(201, {}, seen) });
    expect(response.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('refuses a body that is not the contract’s, without asking the API', async () => {
    const seen: Seen[] = [];
    for (const body of [
      {},
      { ...VALID, subjectType: 'message' },
      { ...VALID, subjectType: 'review' },
      { ...VALID, reasonCode: 'because_i_said' },
      { ...VALID, subjectSlug: 'Upper-Case' },
      { ...VALID, subjectSlug: '../../etc/passwd' },
      { ...VALID, details: 'x'.repeat(4001) },
    ]) {
      const response = await handleFileSubjectReport(postRequest(body), {
        env: ENV,
        fetch: api(201, {}, seen),
      });
      expect(response.status, JSON.stringify(body).slice(0, 40)).toBe(400);
    }
    expect(seen).toHaveLength(0);
  });

  it('forwards the four refusals a form must act on, with the API’s own code', async () => {
    for (const [status, code] of [
      [404, 'NOT_FOUND'],
      [409, 'REPORT_SUBJECT_NOT_REPORTABLE'],
      [409, 'REPORT_SUBJECT_IS_THE_REPORTER'],
      [429, 'THROTTLED'],
    ] as const) {
      const response = await handleFileSubjectReport(postRequest(VALID), {
        env: ENV,
        fetch: api(status, { code }),
      });
      expect(response.status, code).toBe(status);
      expect((await response.json())['code'], code).toBe(code);
    }
  });

  it('turns an unexpected upstream status into one 503', async () => {
    for (const status of [200, 201.5 as unknown as number, 302, 418, 500, 502]) {
      const response = await handleFileSubjectReport(postRequest(VALID), {
        env: ENV,
        fetch: api(Number.isInteger(status) ? status : 418, { outcome: 'filed', reportId: REPORT }),
      });
      expect(response.status, String(status)).toBe(503);
    }
  });

  it('refuses a drifted success rather than passing it on', async () => {
    const response = await handleFileSubjectReport(postRequest(VALID), {
      env: ENV,
      fetch: api(201, { outcome: 'filed', reportId: REPORT, reporterUserId: IMPOSTOR }),
    });
    expect(response.status).toBe(503);
  });

  it('answers 503 when the API cannot be reached at all', async () => {
    const response = await handleFileSubjectReport(postRequest(VALID), {
      env: ENV,
      fetch: (async () => {
        throw new Error('connection refused');
      }) as unknown as typeof fetch,
    });
    expect(response.status).toBe(503);
  });

  it('never lets a response be cached', async () => {
    const response = await handleFileSubjectReport(postRequest(VALID), {
      env: ENV,
      fetch: api(201, { outcome: 'filed', reportId: REPORT }),
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
