import { describe, expect, it } from 'vitest';
import { readListingAnalytics } from '../../src/admin/server/bff/listing-analytics';

/**
 * The listing analytics BFF, on the admin origin (0102).
 *
 * What matters at this boundary:
 *
 *   * the caller's token comes from `__Host-mp_admin_access` and never from anywhere else, and the browser's own
 *     `Cookie` header is never forwarded upstream;
 *   * **there is no write path in the module at all** — no handler taking a `Request`, no origin check, no POST
 *     — which is asserted on the module's own export list, because that is the shape a missing writer takes at
 *     this layer;
 *   * responses are validated against the contract before a byte reaches a browser, so a drifted API that sent
 *     an account identifier or a session digest would produce a clean failure rather than a leak;
 *   * a window, a page size and a cursor are checked against their own shapes and dropped rather than forwarded
 *     when they could not match;
 *   * every upstream status becomes the one state a screen renders — and an **empty page is a success**, because
 *     that is what a caller without the key receives.
 *
 * Everything is stubbed at the `fetch` boundary: no API, no database, no network.
 */

const ENV = {
  API_BASE_URL: 'https://api.internal.test',
  INTERNAL_BFF_CREDENTIAL: 'test-listing-analytics-canary-credential-xy',
} as const;

const SESSION_TOKEN = 'canary-admin-access-token-not-a-real-token';
const COOKIE = `__Host-mp_admin_access=${SESSION_TOKEN}; __Host-mp_admin_refresh=canary-refresh-not-real`;

const ROW = {
  day: '2026-10-03',
  listingSlug: 'a-chair',
  listingTitle: 'A chair',
  listingStatus: 'active',
  sellerSlug: 'good-shop',
  clicks: '4294967296',
  contacts: '3',
  favorites: '0',
  shares: '0',
  computedAt: '2026-10-04T02:50:00.000Z',
};

const BODY = { days: 30, items: [ROW], nextCursor: null };

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

const OPTIONS = { env: ENV, cookieHeader: COOKIE } as const;

/* ------------------------------------------------------------------------------------------------ */

describe('the hop upstream', () => {
  it('reads the one operation, with the session and the internal credential', async () => {
    const seen: Seen[] = [];
    const result = await readListingAnalytics({}, { ...OPTIONS, fetch: api(200, BODY, seen) });

    expect(result).toEqual({ kind: 'ok', data: BODY });
    expect(seen[0]?.url).toBe('https://api.internal.test/v1/admin/analytics/listings');
    expect(seen[0]?.method).toBe('GET');
    expect(seen[0]?.headers.get('x-session-token')).toBe(SESSION_TOKEN);
    expect(seen[0]?.headers.get('x-internal-credential')).toBe(ENV.INTERNAL_BFF_CREDENTIAL);
  });

  it('never forwards the browser’s cookie', async () => {
    const seen: Seen[] = [];
    await readListingAnalytics({}, { ...OPTIONS, fetch: api(200, BODY, seen) });
    expect(seen[0]?.headers.get('cookie')).toBeNull();
    expect(seen[0]?.body).toBe('');
  });

  /** Nothing about the caller is built here: the API resolves the account and the database the permission. */
  it('sends no account, role, permission or assurance level', async () => {
    const seen: Seen[] = [];
    await readListingAnalytics({}, { ...OPTIONS, fetch: api(200, BODY, seen) });
    const sent = `${seen[0]?.url} ${[...(seen[0]?.headers.keys() ?? [])].join(' ')}`;
    for (const forbidden of ['userId', 'role', 'permission', 'aal', 'analytics.listing.read']) {
      expect(sent, forbidden).not.toContain(forbidden);
    }
  });

  it('is unauthenticated without the admin session cookie', async () => {
    const seen: Seen[] = [];
    const result = await readListingAnalytics({}, { env: ENV, cookieHeader: null, fetch: api(200, BODY, seen) });
    expect(result).toEqual({ kind: 'unauthenticated' });
    // Refused before the hop, so a signed-out request costs no upstream call.
    expect(seen).toEqual([]);
  });

  it('is unauthenticated when only the buyer origin’s cookie is present', async () => {
    const result = await readListingAnalytics(
      {},
      { env: ENV, cookieHeader: `__Host-mp_access=${SESSION_TOKEN}`, fetch: api(200, BODY) },
    );
    expect(result).toEqual({ kind: 'unauthenticated' });
  });
});

describe('the query it builds', () => {
  it('forwards a window and a page size it recognises', async () => {
    const seen: Seen[] = [];
    await readListingAnalytics({ days: '7', limit: '50' }, { ...OPTIONS, fetch: api(200, BODY, seen) });
    expect(seen[0]?.url).toContain('days=7');
    expect(seen[0]?.url).toContain('limit=50');
  });

  /** A mistyped bookmark shows the default window rather than an error page. */
  it('drops a window or page size it could not be', async () => {
    for (const input of [
      { days: 'soon' },
      { days: '-1' },
      { days: '1000000' },
      { limit: 'lots' },
      { limit: '10000' },
    ]) {
      const seen: Seen[] = [];
      await readListingAnalytics(input, { ...OPTIONS, fetch: api(200, BODY, seen) });
      expect(seen[0]?.url, JSON.stringify(input)).toBe('https://api.internal.test/v1/admin/analytics/listings');
    }
  });

  it('passes a cursor along as opaque text', async () => {
    const seen: Seen[] = [];
    await readListingAnalytics({ cursor: 'bGExfDIwMjYtMTAtMDN8eA' }, { ...OPTIONS, fetch: api(200, BODY, seen) });
    expect(seen[0]?.url).toContain('cursor=bGExfDIwMjYtMTAtMDN8eA');
  });

  it('drops a cursor that is not base64url, rather than forwarding it', async () => {
    for (const cursor of ['a b', '../etc', "' or 1=1--", 'x'.repeat(513), '']) {
      const seen: Seen[] = [];
      await readListingAnalytics({ cursor }, { ...OPTIONS, fetch: api(200, BODY, seen) });
      expect(seen[0]?.url, JSON.stringify(cursor)).not.toContain('cursor=');
    }
  });

  it('never sends anything it was not given', async () => {
    const seen: Seen[] = [];
    await readListingAnalytics({}, { ...OPTIONS, fetch: api(200, BODY, seen) });
    expect(seen[0]?.url).not.toContain('?');
  });
});

describe('every upstream answer becomes one state', () => {
  it('reports an empty page as success, because that is what a refusal looks like', async () => {
    const result = await readListingAnalytics(
      {},
      { ...OPTIONS, fetch: api(200, { days: 30, items: [], nextCursor: null }) },
    );
    expect(result).toEqual({ kind: 'ok', data: { days: 30, items: [], nextCursor: null } });
  });

  it('reports an ended session', async () => {
    const result = await readListingAnalytics({}, { ...OPTIONS, fetch: api(401, { code: 'X', status: 401 }) });
    expect(result).toEqual({ kind: 'unauthenticated' });
  });

  it('reports an unusable cursor separately, so the console can clear it', async () => {
    const result = await readListingAnalytics(
      {},
      { ...OPTIONS, fetch: api(400, { code: 'LISTING_ANALYTICS_CURSOR_INVALID', status: 400 }) },
    );
    expect(result).toEqual({ kind: 'invalid' });
  });

  it('reports anything else as unavailable', async () => {
    for (const status of [403, 404, 409, 500, 503]) {
      const result = await readListingAnalytics({}, { ...OPTIONS, fetch: api(status, { status }) });
      expect(result, String(status)).toEqual({ kind: 'unavailable' });
    }
  });

  it('reports an unreachable API as unavailable', async () => {
    expect(await readListingAnalytics({}, { ...OPTIONS, fetch: unreachable })).toEqual({
      kind: 'unavailable',
    });
  });

  it('reports a body that is not JSON as unavailable', async () => {
    const broken = (async () =>
      new Response('not json', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    expect(await readListingAnalytics({}, { ...OPTIONS, fetch: broken })).toEqual({ kind: 'unavailable' });
  });
});

describe('what cannot reach a browser', () => {
  /** A drifted API is a clean failure here, not a half-rendered page carrying a field nobody approved. */
  it('refuses a row carrying an account identifier or a session digest', async () => {
    for (const extra of [
      { sellerUserId: '11111111-1111-4111-8111-111111111111' },
      { userId: '11111111-1111-4111-8111-111111111111' },
      { listingId: '11111111-1111-4111-8111-111111111111' },
      { sessionHash: 'ab'.repeat(32) },
      { referrerHost: 'example.test' },
    ]) {
      const result = await readListingAnalytics(
        {},
        { ...OPTIONS, fetch: api(200, { days: 30, items: [{ ...ROW, ...extra }], nextCursor: null }) },
      );
      expect(result.kind, JSON.stringify(extra)).toBe('unavailable');
    }
  });

  it('refuses a row carrying an impression, a view or a rate', async () => {
    for (const extra of [{ impressions: '1' }, { views: '1' }, { ctr: '0.1' }]) {
      const result = await readListingAnalytics(
        {},
        { ...OPTIONS, fetch: api(200, { days: 30, items: [{ ...ROW, ...extra }], nextCursor: null }) },
      );
      expect(result.kind, JSON.stringify(extra)).toBe('unavailable');
    }
  });

  it('refuses a count that is not a count', async () => {
    for (const clicks of [12, '-1', '1.5', null]) {
      const result = await readListingAnalytics(
        {},
        { ...OPTIONS, fetch: api(200, { days: 30, items: [{ ...ROW, clicks }], nextCursor: null }) },
      );
      expect(result.kind, JSON.stringify(clicks)).toBe('unavailable');
    }
  });

  it('accepts a row whose owner has no storefront', async () => {
    const result = await readListingAnalytics(
      {},
      { ...OPTIONS, fetch: api(200, { days: 30, items: [{ ...ROW, sellerSlug: null }], nextCursor: null }) },
    );
    expect(result.kind).toBe('ok');
  });
});

describe('the module exports no write path', () => {
  it('exports exactly one reader, and nothing that mutates', async () => {
    const surface = (await import('../../src/admin/server/bff/listing-analytics')) as Record<string, unknown>;
    const exported = Object.keys(surface).sort();
    expect(exported).toEqual(['readListingAnalytics']);
    for (const name of exported) {
      expect(name).not.toMatch(/handle|create|update|delete|recompute|rerun|backfill|export/i);
    }
  });

  /** The shape a missing writer takes at this layer, asserted on the file rather than inferred. */
  it('has no request handler, no origin check and no POST anywhere in it', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const source = readFileSync(
      join(import.meta.dirname, '..', '..', 'src', 'admin', 'server', 'bff', 'listing-analytics.ts'),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toContain("method: 'POST'");
    expect(code).not.toContain('checkSameOrigin');
    expect(code).not.toContain('acceptWrite');
    expect(code).not.toContain('callWrite');
    expect(code).not.toMatch(/request: Request/);
  });
});
