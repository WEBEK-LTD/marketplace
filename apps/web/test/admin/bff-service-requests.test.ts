import { describe, expect, it } from 'vitest';
import { SESSION_COOKIES } from '../../src/admin/server/bff/session-cookies';
import {
  handleAdminServiceRequestDecline,
  readAdminServiceRequest,
  readAdminServiceRequests,
  readServiceRequestPaymentInformation,
} from '../../src/admin/server/bff/service-requests';

/**
 * The BFF half of the Admin Only service request surface — Option 2 (Phase 7-J).
 *
 * What matters at this boundary:
 *
 *   * the caller's token comes from `__Host-mp_admin_access` and never from a body, and the browser's own
 *     `Cookie` header is never forwarded upstream;
 *   * **the payment fields are a separate read from a separate endpoint**, so a page that may not have them
 *     never receives a document containing them — the request read has no field for either value at all;
 *   * **bodies are rebuilt, never forwarded** — a page that added a status, a reason, a permission or a
 *     timestamp has every one of them dropped before anything leaves this origin;
 *   * **answers are validated against the contract, not passed through** — a payment field the API somehow
 *     attached to a request document cannot reach a page;
 *   * a session that ended, a request that is not available, a refused cursor and a service that could not
 *     answer stay four distinct things, because an outage must never be rendered as a refusal;
 *   * the write refuses a cross-site request before it reads anything else.
 */

const ENV = Object.freeze({
  API_BASE_URL: 'https://api.internal.test',
  INTERNAL_BFF_CREDENTIAL: 'test-current-credential-value-not-a-real-se',
});

const SESSION_TOKEN = 'admin-session-token-canary-not-a-real-token';
const COOKIE = `${SESSION_COOKIES.access.name}=${SESSION_TOKEN}`;

const REQUEST = 'd5000000-0000-4000-8000-000000000001';
const PAYMENT_METHOD = 'Bank transfer at month end';
const PAYMENT_NOTE = 'Invoice the company address';

const QUEUE_ITEM = {
  id: REQUEST,
  status: 'open',
  title: 'Build me a shelf',
  budgetMinor: '400000',
  currencyCode: 'EGP',
  currencyMinorUnit: 2,
  neededBy: '2026-06-01',
  buyerName: 'Buyer A',
  hasPaymentNotes: true,
  closedAt: null,
  createdAt: '2026-05-01T09:00:00.000Z',
  updatedAt: '2026-05-01T09:00:00.000Z',
};

const DETAIL = { ...QUEUE_ITEM, brief: 'A brief that is comfortably longer than ten characters.' };

interface Seen {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string;
}

function api(status: number, payload: unknown, seen: Seen[] = []): typeof fetch {
  return (async (input: unknown, init: RequestInit) => {
    seen.push({
      url: String(input),
      method: String(init.method ?? 'GET'),
      headers: new Headers(init.headers),
      body: String(init.body ?? ''),
    });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': status < 400 ? 'application/json' : 'application/problem+json' },
    });
  }) as unknown as typeof fetch;
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://admin.test/api/service-requests/decline', {
    method: 'POST',
    headers: { origin: 'https://admin.test', 'content-type': 'application/json', cookie: COOKIE, ...headers },
    body: JSON.stringify(body),
  });
}

/* ------------------------------------------------------------------------------------------------ */

describe('reading the queue', () => {
  it('presents the caller’s token and the internal credential, and never the browser cookie', async () => {
    const seen: Seen[] = [];
    await readAdminServiceRequests(
      {},
      { env: ENV, cookieHeader: COOKIE, fetch: api(200, { items: [QUEUE_ITEM], nextCursor: null }, seen) },
    );

    expect(seen[0]!.url).toBe('https://api.internal.test/v1/admin/service-requests');
    expect(seen[0]!.headers.get('x-session-token')).toBe(SESSION_TOKEN);
    expect(seen[0]!.headers.get('x-internal-credential')).toBe(ENV.INTERNAL_BFF_CREDENTIAL);
    expect(seen[0]!.headers.get('cookie')).toBeNull();
  });

  it('never reaches the API without an admin session cookie', async () => {
    const seen: Seen[] = [];
    const result = await readAdminServiceRequests({}, { env: ENV, cookieHeader: null, fetch: api(200, {}, seen) });
    expect(result.kind).toBe('unauthenticated');
    expect(seen).toHaveLength(0);
  });

  it('forwards only a status the schema defines, and only a cursor that could be one', async () => {
    const seen: Seen[] = [];
    const options = {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: api(200, { items: [], nextCursor: null }, seen),
    };
    await readAdminServiceRequests({ status: 'open', cursor: 'YXExfGNhbmFyeQ' }, options);
    expect(seen[0]!.url).toContain('status=open');
    expect(seen[0]!.url).toContain('cursor=YXExfGNhbmFyeQ');

    seen.length = 0;
    await readAdminServiceRequests({ status: 'routed', cursor: 'not a cursor' }, options);
    expect(seen[0]!.url).toBe('https://api.internal.test/v1/admin/service-requests');
  });

  it('keeps four outcomes apart', async () => {
    for (const [status, kind] of [
      [401, 'unauthenticated'],
      [404, 'notFound'],
      [400, 'invalid'],
      [503, 'unavailable'],
      [500, 'unavailable'],
    ] as const) {
      const result = await readAdminServiceRequests(
        {},
        { env: ENV, cookieHeader: COOKIE, fetch: api(status, { code: 'NOPE' }) },
      );
      expect(result.kind, String(status)).toBe(kind);
    }
  });

  it('refuses an answer the contract does not describe, rather than passing it on', async () => {
    const drifted = await readAdminServiceRequests(
      {},
      {
        env: ENV,
        cookieHeader: COOKIE,
        // A payment field attached to a queue row is exactly the drift the contract exists to catch.
        fetch: api(200, {
          items: [{ ...QUEUE_ITEM, preferredPaymentMethod: PAYMENT_METHOD }],
          nextCursor: null,
        }),
      },
    );
    expect(drifted.kind).toBe('unavailable');
  });

  it('carries the budget as a decimal string, never a number', async () => {
    const result = await readAdminServiceRequests(
      {},
      {
        env: ENV,
        cookieHeader: COOKIE,
        fetch: api(200, { items: [{ ...QUEUE_ITEM, budgetMinor: 400000 }], nextCursor: null }),
      },
    );
    expect(result.kind).toBe('unavailable');
  });
});

describe('reading one request', () => {
  it('reads it by identifier, lower-cased', async () => {
    const seen: Seen[] = [];
    const result = await readAdminServiceRequest(REQUEST.toUpperCase(), {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: api(200, { request: DETAIL }, seen),
    });
    expect(result.kind).toBe('ok');
    expect(seen[0]!.url).toBe(`https://api.internal.test/v1/admin/service-requests/${REQUEST}`);
  });

  it('answers not-found for an identifier that is not one, without asking', async () => {
    const seen: Seen[] = [];
    for (const id of ['not-a-uuid', '', 'd5000000']) {
      const result = await readAdminServiceRequest(id, {
        env: ENV,
        cookieHeader: COOKIE,
        fetch: api(200, { request: DETAIL }, seen),
      });
      expect(result.kind, id).toBe('notFound');
    }
    expect(seen).toHaveLength(0);
  });

  it('refuses a request document carrying a payment field', async () => {
    const result = await readAdminServiceRequest(REQUEST, {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: api(200, { request: { ...DETAIL, paymentNotes: PAYMENT_NOTE } }),
    });
    expect(result.kind).toBe('unavailable');
  });

  it('returns the brief and nothing about the buyer but their name', async () => {
    const result = await readAdminServiceRequest(REQUEST, {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: api(200, { request: DETAIL }),
    });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.data.brief).toContain('comfortably');
    expect(Object.keys(result.data)).not.toContain('buyerUserId');
    expect(Object.keys(result.data)).not.toContain('preferredPaymentMethod');
    expect(Object.keys(result.data)).not.toContain('paymentNotes');
  });
});

describe('reading the payment information', () => {
  it('is a separate endpoint, addressed separately', async () => {
    const seen: Seen[] = [];
    await readServiceRequestPaymentInformation(REQUEST, {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: api(200, {
        paymentInformation: { preferredPaymentMethod: PAYMENT_METHOD, paymentNotes: PAYMENT_NOTE },
      }, seen),
    });
    expect(seen[0]!.url).toBe(
      `https://api.internal.test/v1/admin/service-requests/${REQUEST}/payment-information`,
    );
  });

  it('returns the two fields when the API allows it', async () => {
    const result = await readServiceRequestPaymentInformation(REQUEST, {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: api(200, {
        paymentInformation: { preferredPaymentMethod: PAYMENT_METHOD, paymentNotes: PAYMENT_NOTE },
      }),
    });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.data.preferredPaymentMethod).toBe(PAYMENT_METHOD);
    expect(Object.keys(result.data).sort()).toEqual(['paymentNotes', 'preferredPaymentMethod']);
  });

  it('is notFound when the API refuses it, which is how the section disappears', async () => {
    const result = await readServiceRequestPaymentInformation(REQUEST, {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: api(404, { code: 'NOT_FOUND' }),
    });
    expect(result.kind).toBe('notFound');
  });

  it('keeps an outage apart from a refusal', async () => {
    const result = await readServiceRequestPaymentInformation(REQUEST, {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: api(503, { code: 'SERVICE_UNAVAILABLE' }),
    });
    expect(result.kind).toBe('unavailable');
  });

  it('accepts two nulls, which is what a purged request reads as', async () => {
    const result = await readServiceRequestPaymentInformation(REQUEST, {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: api(200, { paymentInformation: { preferredPaymentMethod: null, paymentNotes: null } }),
    });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.data).toEqual({ preferredPaymentMethod: null, paymentNotes: null });
  });

  it('refuses a document carrying anything else', async () => {
    const result = await readServiceRequestPaymentInformation(REQUEST, {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: api(200, {
        paymentInformation: {
          preferredPaymentMethod: PAYMENT_METHOD,
          paymentNotes: PAYMENT_NOTE,
          buyerUserId: REQUEST,
        },
      }),
    });
    expect(result.kind).toBe('unavailable');
  });

  it('never reaches the API without a session, or for a malformed identifier', async () => {
    const seen: Seen[] = [];
    expect(
      (await readServiceRequestPaymentInformation(REQUEST, { env: ENV, cookieHeader: null, fetch: api(200, {}, seen) }))
        .kind,
    ).toBe('unauthenticated');
    expect(
      (await readServiceRequestPaymentInformation('nope', { env: ENV, cookieHeader: COOKIE, fetch: api(200, {}, seen) }))
        .kind,
    ).toBe('notFound');
    expect(seen).toHaveLength(0);
  });
});

describe('the staff closure', () => {
  it('sends the identifier in the path and no body at all', async () => {
    const seen: Seen[] = [];
    const response = await handleAdminServiceRequestDecline(post({ requestId: REQUEST }), {
      env: ENV,
      fetch: api(200, { status: 'declined' }, seen),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'declined' });
    expect(seen[0]!.url).toBe(`https://api.internal.test/v1/admin/service-requests/${REQUEST}/decline`);
    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.body).toBe('');
  });

  it('drops everything a page added to the body', async () => {
    const seen: Seen[] = [];
    await handleAdminServiceRequestDecline(
      post({
        requestId: REQUEST,
        status: 'accepted',
        reason: 'because',
        permission: 'service_requests.request.manage',
        closedAt: '2026-05-05T09:00:00.000Z',
        userId: REQUEST,
      }),
      { env: ENV, fetch: api(200, { status: 'declined' }, seen) },
    );
    expect(seen[0]!.body).toBe('');
    expect(seen[0]!.url).not.toContain('status');
    expect(seen[0]!.url).not.toContain('permission');
  });

  it('refuses a malformed or missing identifier without reaching the API', async () => {
    const seen: Seen[] = [];
    for (const body of [{}, { requestId: 'nope' }, { requestId: 123 }, { requestId: null }]) {
      const response = await handleAdminServiceRequestDecline(post(body), {
        env: ENV,
        fetch: api(200, { status: 'declined' }, seen),
      });
      expect(response.status).toBe(400);
    }
    expect(seen).toHaveLength(0);
  });

  it('refuses a body that is not JSON', async () => {
    const seen: Seen[] = [];
    const response = await handleAdminServiceRequestDecline(
      new Request('https://admin.test/api/service-requests/decline', {
        method: 'POST',
        headers: { origin: 'https://admin.test', 'content-type': 'application/json', cookie: COOKIE },
        body: 'not json',
      }),
      { env: ENV, fetch: api(200, { status: 'declined' }, seen) },
    );
    expect(response.status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it('refuses a cross-site request before reading anything', async () => {
    const seen: Seen[] = [];
    const response = await handleAdminServiceRequestDecline(
      new Request('https://admin.test/api/service-requests/decline', {
        method: 'POST',
        headers: { origin: 'https://evil.test', 'content-type': 'application/json', cookie: COOKIE },
        body: JSON.stringify({ requestId: REQUEST }),
      }),
      { env: ENV, fetch: api(200, { status: 'declined' }, seen) },
    );
    expect(response.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it('refuses it without a session', async () => {
    const seen: Seen[] = [];
    const response = await handleAdminServiceRequestDecline(
      new Request('https://admin.test/api/service-requests/decline', {
        method: 'POST',
        headers: { origin: 'https://admin.test', 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: REQUEST }),
      }),
      { env: ENV, fetch: api(200, { status: 'declined' }, seen) },
    );
    expect(response.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it.each([
    [404, 'NOT_FOUND'],
    [409, 'SERVICE_REQUEST_NOT_ACTIONABLE'],
  ])('forwards %i %s so a screen can say what happened', async (status, code) => {
    const response = await handleAdminServiceRequestDecline(post({ requestId: REQUEST }), {
      env: ENV,
      fetch: api(status, { status, code }),
    });
    expect(response.status).toBe(status);
    expect(((await response.json()) as Record<string, unknown>)['code']).toBe(code);
  });

  it('turns a status nobody expected into an outage, never a closure', async () => {
    const response = await handleAdminServiceRequestDecline(post({ requestId: REQUEST }), {
      env: ENV,
      fetch: api(418, { code: 'TEAPOT' }),
    });
    expect(response.status).toBe(503);
    expect(((await response.json()) as Record<string, unknown>)['code']).toBe('SERVICE_UNAVAILABLE');
  });

  it('refuses an answer the contract does not describe', async () => {
    const response = await handleAdminServiceRequestDecline(post({ requestId: REQUEST }), {
      env: ENV,
      fetch: api(200, { status: 'declined', paymentDueAt: '2026-05-05T09:00:00.000Z' }),
    });
    expect(response.status).toBe(503);
  });

  it('turns an unreachable API into an outage', async () => {
    const unreachable = (async () => {
      throw new Error('connection refused');
    }) as unknown as typeof fetch;
    const response = await handleAdminServiceRequestDecline(post({ requestId: REQUEST }), {
      env: ENV,
      fetch: unreachable,
    });
    expect(response.status).toBe(503);
  });

  it('marks its answer no-store', async () => {
    const response = await handleAdminServiceRequestDecline(post({ requestId: REQUEST }), {
      env: ENV,
      fetch: api(200, { status: 'declined' }),
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('the module addresses only its own surface', () => {
  it('exports nothing that quotes, checks out, orders or pays', async () => {
    const surface: Record<string, unknown> = await import('../../src/admin/server/bff/service-requests');
    for (const name of Object.keys(surface)) {
      const lower = name.toLowerCase();
      for (const forbidden of ['quote', 'checkout', 'order', 'refund', 'payout', 'ledger']) {
        expect(lower, `${name} / ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('addresses only /v1/admin/service-requests, on every operation', async () => {
    const seen: Seen[] = [];
    await readAdminServiceRequests({}, { env: ENV, cookieHeader: COOKIE, fetch: api(200, { items: [], nextCursor: null }, seen) });
    await readAdminServiceRequest(REQUEST, { env: ENV, cookieHeader: COOKIE, fetch: api(200, { request: DETAIL }, seen) });
    await readServiceRequestPaymentInformation(REQUEST, {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: api(200, { paymentInformation: { preferredPaymentMethod: null, paymentNotes: null } }, seen),
    });
    await handleAdminServiceRequestDecline(post({ requestId: REQUEST }), {
      env: ENV,
      fetch: api(200, { status: 'declined' }, seen),
    });

    expect(seen).toHaveLength(4);
    for (const request of seen) {
      expect(request.url.startsWith('https://api.internal.test/v1/admin/service-requests')).toBe(true);
    }
  });
});
