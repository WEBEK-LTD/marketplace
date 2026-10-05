import { describe, expect, it } from 'vitest';
import { readRedirect } from '../src/server/bff/seo-redirects';

/**
 * The public half of the redirect map, at the BFF boundary.
 *
 * What matters here:
 *
 *   * **no session, and no cookie** — the map is the same for everybody, so nothing about the caller is read or
 *     forwarded;
 *   * **an answer the table could not have stored is not acted on.** A destination that would leave the site, or a
 *     status code outside the four, becomes no redirect: the safe reading of a value that should not exist is to
 *     leave the visitor with the 404 they were already getting;
 *   * **a failure never becomes a redirect.** An outage, a malformed body and a refusal all answer `none`, because
 *     a redirect we cannot confirm is not a redirect;
 *   * **a path that could not be a row is answered without a hop**, so a probing request costs nothing.
 *
 * Everything is stubbed at the `fetch` boundary: no API, no database, no network.
 */

const ENV = {
  API_BASE_URL: 'https://api.internal.test',
  INTERNAL_BFF_CREDENTIAL: 'test-web-redirect-canary-not-real-abcdefghi',
} as const;

interface Seen {
  url: string;
  method: string;
  cookie: string | null;
  credential: string | null;
}

function apiReturns(status: number, body: unknown, seen: { value?: Seen } = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const sent = new Headers(init?.headers);
    seen.value = {
      url: String(input),
      method: init?.method ?? 'GET',
      cookie: sent.get('cookie'),
      credential: sent.get('x-internal-credential'),
    };
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': status < 400 ? 'application/json' : 'application/problem+json' },
    });
  }) as unknown as typeof fetch;
}

function apiUnreachable(): typeof fetch {
  return (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
}

const REDIRECT = { outcome: 'redirect', toPath: '/new-offer', statusCode: 301 };

describe('readRedirect', () => {
  it('asks about the path exactly as it arrived, with the credential and no cookie', async () => {
    const seen: { value?: Seen } = {};
    const result = await readRedirect('/old-offer', { env: ENV, fetch: apiReturns(200, REDIRECT, seen) });
    expect(result).toEqual({ kind: 'redirect', toPath: '/new-offer', statusCode: 301 });
    expect(seen.value?.url).toBe(
      `https://api.internal.test/v1/seo/redirects/resolve?path=${encodeURIComponent('/old-offer')}`,
    );
    expect(seen.value?.method).toBe('GET');
    expect(seen.value?.cookie).toBeNull();
    expect(seen.value?.credential).toBe(ENV.INTERNAL_BFF_CREDENTIAL);
  });

  it('keeps the locale prefix, because the map is keyed on the address as written', async () => {
    const seen: { value?: Seen } = {};
    await readRedirect('/ar/old-offer', { env: ENV, fetch: apiReturns(200, { outcome: 'none' }, seen) });
    expect(seen.value?.url).toContain(encodeURIComponent('/ar/old-offer'));
  });

  it('is none when the map names no redirect', async () => {
    const result = await readRedirect('/nothing', { env: ENV, fetch: apiReturns(200, { outcome: 'none' }) });
    expect(result).toEqual({ kind: 'none' });
  });

  it('is none for a path that could not be a row, without an upstream hop', async () => {
    const seen: { value?: Seen } = {};
    for (const path of ['old-offer', 'https://evil.test/x', '//evil.test', '', '/with spaces', `/${'a'.repeat(3000)}`]) {
      const result = await readRedirect(path, { env: ENV, fetch: apiReturns(200, REDIRECT, seen) });
      expect(result, path).toEqual({ kind: 'none' });
    }
    expect(seen.value).toBeUndefined();
  });

  it('never acts on a destination the table could not have stored', async () => {
    for (const toPath of ['https://evil.test/', '//evil.test', 'relative-but-not-a-path', '']) {
      const result = await readRedirect('/old-offer', {
        env: ENV,
        fetch: apiReturns(200, { outcome: 'redirect', toPath, statusCode: 301 }),
      });
      expect(result, toPath).toEqual({ kind: 'none' });
    }
  });

  it('never acts on a status code outside the four the table allows', async () => {
    for (const statusCode of [200, 303, 307.5, 404, 0]) {
      const result = await readRedirect('/old-offer', {
        env: ENV,
        fetch: apiReturns(200, { outcome: 'redirect', toPath: '/new-offer', statusCode }),
      });
      expect(result, String(statusCode)).toEqual({ kind: 'none' });
    }
  });

  it('accepts each of the four, because each is one an operator may store', async () => {
    for (const statusCode of [301, 302, 307, 308]) {
      const result = await readRedirect('/old-offer', {
        env: ENV,
        fetch: apiReturns(200, { outcome: 'redirect', toPath: '/new-offer', statusCode }),
      });
      expect(result, String(statusCode)).toEqual({ kind: 'redirect', toPath: '/new-offer', statusCode });
    }
  });

  it('never sends a visitor to the address they just asked for', async () => {
    const result = await readRedirect('/same', {
      env: ENV,
      fetch: apiReturns(200, { outcome: 'redirect', toPath: '/same', statusCode: 301 }),
    });
    expect(result).toEqual({ kind: 'none' });
  });

  it('turns every failure into none rather than into a redirect', async () => {
    for (const fetcher of [
      apiUnreachable(),
      apiReturns(503, { status: 503, code: 'SERVICE_UNAVAILABLE' }),
      apiReturns(400, { status: 400, code: 'VALIDATION_FAILED' }),
      apiReturns(403, { status: 403, code: 'BAD_REQUEST' }),
      apiReturns(200, 'not json at all'),
      apiReturns(200, { outcome: 'maybe' }),
      apiReturns(200, { outcome: 'redirect' }),
      apiReturns(200, {}),
    ]) {
      const result = await readRedirect('/old-offer', { env: ENV, fetch: fetcher });
      expect(result).toEqual({ kind: 'none' });
    }
  });

  it('ignores a field the contract does not name rather than carrying it', async () => {
    const result = await readRedirect('/old-offer', {
      env: ENV,
      fetch: apiReturns(200, { ...REDIRECT, priority: 10, note: 'internal' }),
    });
    // The resolution schema is strict, so an extra field is a refusal rather than something quietly dropped.
    expect(result).toEqual({ kind: 'none' });
  });
});
