import { describe, expect, it } from 'vitest';
import { ANALYTICS_SESSION_COOKIE_NAME, isAnalyticsSessionId, newAnalyticsSessionId } from '@repo/server-config';
import { handleTrack } from '../src/server/bff/track';

/**
 * `POST /api/track` — the analytics beacon on the buyer origin (0101).
 *
 * What matters at this boundary:
 *
 *   * **it works without a session**, which no other write route on this origin does, and the same-origin
 *     check and the internal credential still apply;
 *   * **the analytics session is this server's**, carried in its own `__Host-` cookie and issued here when the
 *     browser has none; a `sessionId` in the body is dropped rather than forwarded, so a page script cannot
 *     choose which session its events belong to;
 *   * **the browser's own `Cookie` header never crosses** — the caller's access token is read from it and
 *     presented as a session token, and nothing else goes upstream;
 *   * **a failure is silent to the page**: a rate limit, an unavailable API or an unreachable one all read as
 *     nothing accepted, because a beacon has nothing to show a visitor and retrying would make a flood worse.
 *     The one exception is a malformed body, which is the page's own bug.
 *
 * Everything is stubbed at the `fetch` boundary: no API, no database, no network.
 */

const ENV = {
  API_BASE_URL: 'https://api.internal.test',
  PUBLIC_WEB_ORIGIN: 'https://web.test',
  INTERNAL_BFF_CREDENTIAL: 'test-web-track-canary-credential-notreal123',
} as const;

const ORIGIN = 'https://buyer.test';
const LISTING = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ACCESS_TOKEN = 'caller-access-token-value-not-a-real-token';
const SESSION_COOKIE = `__Host-mp_access=${ACCESS_TOKEN}`;

function uuid(n: number): string {
  return `${n.toString(16).padStart(8, '0')}-2222-4222-8222-222222222222`;
}

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { eventId: uuid(1), listingId: LISTING, eventType: 'click', ...overrides };
}

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

const unreachable = (async () => {
  throw new Error('the API is unreachable');
}) as unknown as typeof fetch;

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/track`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function send(
  body: unknown,
  options: { readonly headers?: Record<string, string>; readonly fetch?: typeof fetch; readonly seen?: Seen[] } = {},
): Promise<{ status: number; payload: Record<string, unknown>; setCookie: string | null; response: Response }> {
  const response = await handleTrack(request(body, options.headers), {
    env: ENV,
    fetch: options.fetch ?? api(202, { accepted: Array.isArray((body as { events?: unknown[] })?.events) ? (body as { events: unknown[] }).events.length : 0 }, options.seen),
  });
  const text = await response.text();
  return {
    status: response.status,
    payload: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
    setCookie: response.headers.get('set-cookie'),
    response,
  };
}

/** The `sessionId` the handler forwarded, from the body it built. */
function forwarded(seen: Seen[]): Record<string, unknown> {
  expect(seen).toHaveLength(1);
  return JSON.parse(seen[0]!.body) as Record<string, unknown>;
}

/* ------------------------------------------------------------------------------------------------ */

describe('the hop upstream', () => {
  it('posts the batch to /v1/track with the internal credential', async () => {
    const seen: Seen[] = [];
    const result = await send({ events: [event()] }, { seen });

    expect(result.status).toBe(202);
    expect(result.payload).toEqual({ accepted: 1 });
    expect(seen[0]!.url).toBe('https://api.internal.test/v1/track');
    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.headers.get('x-internal-credential')).toBe(ENV.INTERNAL_BFF_CREDENTIAL);
  });

  /** The one route here that needs no session, so most requests carry no token at all. */
  it('presents no session token when the visitor is signed out', async () => {
    const seen: Seen[] = [];
    await send({ events: [event()] }, { seen });
    expect(seen[0]!.headers.get('x-session-token')).toBeNull();
  });

  it('presents the caller’s token when they have one, and never the browser cookie', async () => {
    const seen: Seen[] = [];
    await send({ events: [event()] }, { headers: { cookie: SESSION_COOKIE }, seen });

    expect(seen[0]!.headers.get('x-session-token')).toBe(ACCESS_TOKEN);
    expect(seen[0]!.headers.get('cookie')).toBeNull();
    expect(seen[0]!.body).not.toContain(ACCESS_TOKEN);
  });

  it('forwards the events exactly as the contract validates them', async () => {
    const seen: Seen[] = [];
    await send(
      { events: [event({ source: 'search', referrerHost: 'example.test', promotionId: uuid(9) })] },
      { seen },
    );
    const sent = forwarded(seen);
    expect(sent['events']).toEqual([
      {
        eventId: uuid(1),
        listingId: LISTING,
        eventType: 'click',
        source: 'search',
        referrerHost: 'example.test',
        promotionId: uuid(9),
      },
    ]);
  });

  it('answers with no-store, so a beacon response is never cached', async () => {
    const result = await send({ events: [event()] });
    expect(result.response.headers.get('cache-control')).toBe('no-store');
    expect(result.response.headers.get('content-type')).toBe('application/json');
  });
});

describe('the analytics session', () => {
  it('is issued when the browser has none, as a __Host- cookie for a day', async () => {
    const seen: Seen[] = [];
    const result = await send({ events: [event()] }, { seen });

    expect(result.setCookie).not.toBeNull();
    const cookie = result.setCookie!;
    expect(cookie.startsWith(`${ANALYTICS_SESSION_COOKIE_NAME}=`)).toBe(true);
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=86400');

    const issued = cookie.slice(`${ANALYTICS_SESSION_COOKIE_NAME}=`.length).split(';')[0]!;
    expect(isAnalyticsSessionId(issued)).toBe(true);
    // The value the browser is given is the value forwarded, so the first batch of a visit is not orphaned.
    expect(forwarded(seen)['sessionId']).toBe(issued);
  });

  it('is reused when the browser already has one, and not re-issued', async () => {
    const existing = newAnalyticsSessionId();
    const seen: Seen[] = [];
    const result = await send(
      { events: [event()] },
      { headers: { cookie: `${ANALYTICS_SESSION_COOKIE_NAME}=${existing}` }, seen },
    );

    expect(result.setCookie).toBeNull();
    expect(forwarded(seen)['sessionId']).toBe(existing);
  });

  it('is issued fresh when the cookie holds something this server did not issue', async () => {
    for (const value of ['', 'not-a-session', 'ab'.repeat(32), `${'a'.repeat(42)}=`]) {
      const seen: Seen[] = [];
      const result = await send(
        { events: [event()] },
        { headers: { cookie: `${ANALYTICS_SESSION_COOKIE_NAME}=${value}` }, seen },
      );
      expect(result.setCookie, value).not.toBeNull();
      expect(forwarded(seen)['sessionId'], value).not.toBe(value);
      expect(isAnalyticsSessionId(forwarded(seen)['sessionId'])).toBe(true);
    }
  });

  /**
   * The property owner decision 4 rests on at this layer: the session is the server's, so a page cannot
   * attribute its events to a session it chose — or to another visitor's.
   */
  it('is never taken from the body', async () => {
    const existing = newAnalyticsSessionId();
    const impostor = newAnalyticsSessionId();
    const seen: Seen[] = [];
    await send(
      { events: [event()], sessionId: impostor },
      { headers: { cookie: `${ANALYTICS_SESSION_COOKIE_NAME}=${existing}` }, seen },
    );

    expect(forwarded(seen)['sessionId']).toBe(existing);
    expect(seen[0]!.body).not.toContain(impostor);
  });

  it('is this server’s even when the body names one and the browser has none', async () => {
    const impostor = newAnalyticsSessionId();
    const seen: Seen[] = [];
    await send({ events: [event()], sessionId: impostor }, { seen });
    expect(forwarded(seen)['sessionId']).not.toBe(impostor);
    expect(isAnalyticsSessionId(forwarded(seen)['sessionId'])).toBe(true);
  });

  it('is sent as one cookie only, alongside the events of that request', async () => {
    const result = await send({ events: [event(), event({ eventId: uuid(2) })] });
    expect(result.response.headers.getSetCookie()).toHaveLength(1);
    expect(result.payload).toEqual({ accepted: 2 });
  });
});

describe('what a page cannot send', () => {
  /** The body is rebuilt from two fields, so a top-level extra never reaches the API. */
  it('drops a top-level field the contract does not name', async () => {
    const seen: Seen[] = [];
    const result = await send({ events: [event()], userId: ACCOUNT, sessionHash: 'ab'.repeat(32) }, { seen });

    expect(result.status).toBe(202);
    expect(Object.keys(forwarded(seen)).sort()).toEqual(['events', 'sessionId']);
    expect(seen[0]!.body).not.toContain(ACCOUNT);
  });

  it('refuses an event carrying an account, a digest or a seller', async () => {
    for (const extra of [
      { userId: ACCOUNT },
      { user_id: ACCOUNT },
      { sessionHash: 'ab'.repeat(32) },
      { sellerUserId: ACCOUNT },
    ]) {
      const result = await send({ events: [event(extra)] }, { fetch: unreachable });
      expect(result.status, JSON.stringify(extra)).toBe(400);
      expect(result.payload['code']).toBe('VALIDATION_FAILED');
    }
  });

  it('refuses impression and view, which Phase 9 has not defined', async () => {
    for (const eventType of ['impression', 'view']) {
      const result = await send({ events: [event({ eventType })] }, { fetch: unreachable });
      expect(result.status, eventType).toBe(400);
    }
  });

  it('refuses a batch over the ceiling, an empty one and a malformed body', async () => {
    const over = Array.from({ length: 51 }, (_, index) => event({ eventId: uuid(index + 1) }));
    expect((await send({ events: over }, { fetch: unreachable })).status).toBe(400);
    expect((await send({ events: [] }, { fetch: unreachable })).status).toBe(400);
    expect((await send({}, { fetch: unreachable })).status).toBe(400);
    expect((await send('{"events":[', { fetch: unreachable })).status).toBe(400);
    expect((await send('', { fetch: unreachable })).status).toBe(400);
  });

  it('accepts the ceiling itself', async () => {
    const events = Array.from({ length: 50 }, (_, index) => event({ eventId: uuid(index + 1) }));
    const result = await send({ events });
    expect(result.status).toBe(202);
    expect(result.payload).toEqual({ accepted: 50 });
  });
});

describe('the same-origin rule', () => {
  it('refuses a request from another origin', async () => {
    const result = await handleTrack(request({ events: [event()] }, { origin: 'https://evil.test' }), {
      env: ENV,
      fetch: unreachable,
    });
    expect(result.status).toBe(403);
    expect(JSON.parse(await result.text())['code']).toBe('BAD_REQUEST');
  });

  it('refuses a request with no origin and no same-site marker', async () => {
    const bare = new Request(`${ORIGIN}/api/track`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: [event()] }),
    });
    expect((await handleTrack(bare, { env: ENV, fetch: unreachable })).status).toBe(403);
  });

  it('accepts a browser-set same-site marker in place of an origin', async () => {
    const marked = new Request(`${ORIGIN}/api/track`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ events: [event()] }),
    });
    const response = await handleTrack(marked, { env: ENV, fetch: api(202, { accepted: 1 }) });
    expect(response.status).toBe(202);
  });

  it('refuses before anything is forwarded or any cookie is issued', async () => {
    const seen: Seen[] = [];
    const response = await handleTrack(request({ events: [event()] }, { origin: 'https://evil.test' }), {
      env: ENV,
      fetch: api(202, { accepted: 1 }, seen),
    });
    expect(seen).toEqual([]);
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});

describe('an upstream that cannot take the batch', () => {
  /** Nothing a visitor can act on, and retrying a rate limit would make a flood worse. */
  it('reports nothing accepted for a 429, rather than the refusal', async () => {
    const result = await send({ events: [event()] }, { fetch: api(429, { status: 429, code: 'TOO_MANY_REQUESTS' }) });
    expect(result.status).toBe(202);
    expect(result.payload).toEqual({ accepted: 0 });
  });

  it('reports nothing accepted for a 503, a 500 and a 400', async () => {
    for (const status of [503, 500, 400]) {
      const result = await send({ events: [event()] }, { fetch: api(status, { status, code: 'BAD_REQUEST' }) });
      expect(result.status, String(status)).toBe(202);
      expect(result.payload, String(status)).toEqual({ accepted: 0 });
    }
  });

  it('reports nothing accepted when the API cannot be reached at all', async () => {
    const result = await send({ events: [event()] }, { fetch: unreachable });
    expect(result.status).toBe(202);
    expect(result.payload).toEqual({ accepted: 0 });
  });

  /** A drifted API cannot make this route answer something a page would misread. */
  it('reports nothing accepted when the answer does not match the contract', async () => {
    for (const payload of [{ accepted: 'one' }, { accepted: -1 }, { inserted: 1 }, 'ok', null]) {
      const result = await send({ events: [event()] }, { fetch: api(202, payload) });
      expect(result.status, JSON.stringify(payload)).toBe(202);
      expect(result.payload, JSON.stringify(payload)).toEqual({ accepted: 0 });
    }
  });

  /** The visit still gets its session, so the next batch is not orphaned by one bad response. */
  it('still issues the session cookie when the upstream failed', async () => {
    const result = await send({ events: [event()] }, { fetch: unreachable });
    expect(result.setCookie).not.toBeNull();
    expect(result.setCookie!.startsWith(`${ANALYTICS_SESSION_COOKIE_NAME}=`)).toBe(true);
  });

  it('never passes the API’s problem body to the page', async () => {
    const result = await send(
      { events: [event()] },
      { fetch: api(503, { status: 503, code: 'SERVICE_UNAVAILABLE', detail: 'The stream is down.' }) },
    );
    expect(Object.keys(result.payload)).toEqual(['accepted']);
    expect(JSON.stringify(result.payload)).not.toContain('stream');
  });
});
