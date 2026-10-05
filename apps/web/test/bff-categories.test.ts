import { INTERNAL_CREDENTIAL_HEADER } from '../src/server/bff/internal-credential';
import { describe, expect, it } from 'vitest';
import { handleCategories, readCategories } from '../src/server/bff/categories';

/**
 * The BFF half of the public category tree (Phase 4-A).
 *
 * What matters here is that the browser's request never leaves this origin as anything but one
 * credentialled internal call, and that whatever comes back is checked against the shared contract
 * before a page is allowed to render it. A malformed upstream body has to become a clean 503, not a
 * half-drawn tree.
 */

const ENV = {
  API_BASE_URL: 'https://api.test',
  PUBLIC_WEB_ORIGIN: 'https://web.test',
  INTERNAL_BFF_CREDENTIAL: 'test-current-credential-value-not-a-real-se',
} as const;

const TREE = {
  categories: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      slug: 'electronics',
      name: 'Electronics',
      children: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          slug: 'phones',
          name: 'Phones',
          children: [],
        },
      ],
    },
  ],
};

interface Seen {
  url: string;
  credential: string | null;
  method: string;
}

function apiReturns(status: number, body: unknown, seen: { value?: Seen } = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.value = {
      url: String(input),
      credential: headers.get(INTERNAL_CREDENTIAL_HEADER),
      method: init?.method ?? 'GET',
    };
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': status === 200 ? 'application/json' : 'application/problem+json' },
    });
  }) as unknown as typeof fetch;
}

function request(query = ''): Request {
  return new Request(`https://web.test/api/categories${query}`, { method: 'GET' });
}

describe('reading the category tree', () => {
  it('makes exactly one credentialled GET to the API', async () => {
    const seen: { value?: Seen } = {};
    await readCategories('en', { env: ENV, fetch: apiReturns(200, TREE, seen) });
    expect(seen.value?.method).toBe('GET');
    expect(seen.value?.url).toBe('https://api.test/v1/categories?locale=en');
    expect(seen.value?.credential).toBe(ENV.INTERNAL_BFF_CREDENTIAL);
  });

  it('forwards a locale we serve and normalises anything else to the default', async () => {
    for (const [given, expected] of [
      ['ar', 'ar'],
      ['AR', 'ar'],
      ['de', 'en'],
      [undefined, 'en'],
    ] as const) {
      const seen: { value?: Seen } = {};
      await readCategories(given, { env: ENV, fetch: apiReturns(200, TREE, seen) });
      expect(seen.value?.url).toBe(`https://api.test/v1/categories?locale=${expected}`);
    }
  });

  it('returns the validated tree', async () => {
    const data = await readCategories('en', { env: ENV, fetch: apiReturns(200, TREE) });
    expect(data).toEqual(TREE);
  });

  it('returns null when the API refuses, is unreachable, or answers nonsense', async () => {
    const unreachable = (async () => {
      throw new Error('connection refused');
    }) as unknown as typeof fetch;

    expect(await readCategories('en', { env: ENV, fetch: apiReturns(503, { status: 503 }) })).toBeNull();
    expect(await readCategories('en', { env: ENV, fetch: unreachable })).toBeNull();
    expect(await readCategories('en', { env: ENV, fetch: apiReturns(200, 'not json') })).toBeNull();
    expect(await readCategories('en', { env: ENV, fetch: apiReturns(200, { categories: 'no' }) })).toBeNull();
  });

  it('refuses a node carrying a field the contract does not define', async () => {
    const extra = {
      categories: [
        { id: TREE.categories[0]!.id, slug: 'x', name: 'X', children: [], isActive: true },
      ],
    };
    expect(await readCategories('en', { env: ENV, fetch: apiReturns(200, extra) })).toBeNull();
  });
});

describe('GET /api/categories', () => {
  it('answers 200 with the tree and nothing else', async () => {
    const response = await handleCategories(request(), { env: ENV, fetch: apiReturns(200, TREE) });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(JSON.parse(await response.text())).toEqual(TREE);
  });

  it('passes the browser’s locale through', async () => {
    const seen: { value?: Seen } = {};
    await handleCategories(request('?locale=ar'), { env: ENV, fetch: apiReturns(200, TREE, seen) });
    expect(seen.value?.url).toBe('https://api.test/v1/categories?locale=ar');
  });

  it('answers 503 as problem details when the tree cannot be read', async () => {
    const response = await handleCategories(request(), { env: ENV, fetch: apiReturns(503, { status: 503 }) });
    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    expect(JSON.parse(await response.text())).toMatchObject({ status: 503, code: 'SERVICE_UNAVAILABLE' });
  });

  it('never sets a cookie and never returns the internal credential', async () => {
    const response = await handleCategories(request(), { env: ENV, fetch: apiReturns(200, TREE) });
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await response.text()).not.toContain(ENV.INTERNAL_BFF_CREDENTIAL);
  });

  it('answers an empty catalogue as an empty list, not an error', async () => {
    const response = await handleCategories(request(), {
      env: ENV,
      fetch: apiReturns(200, { categories: [] }),
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(await response.text())).toEqual({ categories: [] });
  });
});
