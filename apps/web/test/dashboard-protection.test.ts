import type { ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startBuiltApp, type RunningApp } from './support/next-server.js';
import { problem, startStubApi, type StubApi } from './support/stub-api.js';

/**
 * Authenticated-route protection, over real HTTP against the built app (Phase 5-A).
 *
 * Protection is two layers and both are exercised here, because either alone is a hole.
 *
 * The **middleware** turns away a visitor with no session cookie at all, and it must do so with a real
 * redirect status. That is why this runs against the built app rather than a unit harness: Next.js 16
 * commits the status line as soon as a page starts awaiting, so a redirect chosen anywhere later would
 * arrive as a 200 — the soft-redirect this project has already been bitten by twice.
 *
 * The **layout** is what actually decides. A forged cookie gets past the middleware by construction —
 * the middleware reads presence, not validity — and must still see no dashboard content, because the
 * layout asks the API who the caller is and renders a signed-out view when the answer is nobody.
 *
 * The last block is the regression that matters most: none of this may disturb the public catalogue,
 * which has no session and must behave exactly as it did before.
 *
 * No browser, no Playwright, no live provider, no deployment.
 */

const CANARY_CREDENTIAL = 'test-web-session-canary-credential-not-real';
const ACCESS = '__Host-mp_access=canary-access-token-value-not-a-real-token';
const REFRESH = '__Host-mp_refresh=canary-refresh-token-value-not-a-real-toke';
const IDENTITY = { user: { id: '11111111-1111-4111-8111-111111111111', displayName: 'Nadia' } };

let api: StubApi;
let app: RunningApp;

beforeAll(async () => {
  api = await startStubApi();
  app = await startBuiltApp({ API_BASE_URL: api.baseUrl, INTERNAL_BFF_CREDENTIAL: CANARY_CREDENTIAL });
}, 120_000);

afterAll(async () => {
  await app.stop();
  await api.stop();
});

function json(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

/** The API as it behaves for a signed-in caller; the catalogue routes answer too, for the regression. */
function apiServes(identity: 'ok' | 'unauthenticated' | 'unavailable'): void {
  api.reply((request, response) => {
    const [path] = request.url.split('?');
    if (path === '/v1/users/me') {
      if (identity === 'unauthenticated') return problem(response, 401, 'AUTHENTICATION_REQUIRED');
      if (identity === 'unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      return json(response, IDENTITY);
    }
    if (path === '/v1/listings') return json(response, { listings: [], nextCursor: null });
    if (path === '/v1/services') return json(response, { services: [], nextCursor: null });
    if (path === '/v1/categories') return json(response, { categories: [] });
    if (path === '/v1/search') return json(response, { results: [], nextCursor: null });
    return problem(response, 404, 'NOT_FOUND');
  });
}

beforeEach(() => {
  api.seen.length = 0;
  apiServes('ok');
});

interface Page {
  readonly status: number;
  readonly location: string | null;
  readonly robotsHeader: string | null;
  readonly html: string;
}

async function load(path: string, cookie?: string): Promise<Page> {
  const response = await fetch(`${app.baseUrl}${path}`, {
    redirect: 'manual',
    headers: cookie === undefined ? {} : { cookie },
  });
  const html = await response.text();
  return {
    status: response.status,
    location: response.headers.get('location'),
    robotsHeader: response.headers.get('x-robots-tag'),
    html,
  };
}

describe('a visitor with no session', () => {
  it('is redirected away from a dashboard page with a real redirect status', async () => {
    const page = await load('/dashboard/security');
    expect(page.status).toBe(307);
    expect(page.location).toContain('/login');
  });

  it('is redirected to the Arabic sign-in page from an Arabic dashboard path', async () => {
    const page = await load('/ar/dashboard/security');
    expect(page.status).toBe(307);
    expect(page.location).toContain('/ar/login');
  });

  it('never reaches the page, so the API is never asked who they are', async () => {
    await load('/dashboard/security');
    expect(api.seen.filter((request) => request.url.startsWith('/v1/users/me'))).toHaveLength(0);
  });

  it('gets no dashboard content in the redirect body', async () => {
    const page = await load('/dashboard/security');
    expect(page.html).not.toContain('Phone number');
  });

  it('and the redirect is not indexable', async () => {
    const page = await load('/dashboard/security');
    expect(page.robotsHeader).toBe('noindex');
  });
});

describe('a visitor whose cookie the API does not accept', () => {
  beforeEach(() => {
    apiServes('unauthenticated');
  });

  it('gets past the middleware — which reads presence, not validity — and no further', async () => {
    const page = await load('/dashboard/security', `${ACCESS}; ${REFRESH}`);
    expect(page.status).toBe(200);
    expect(page.html).toContain('You are signed out');
  });

  it('sees no dashboard content at all', async () => {
    const page = await load('/dashboard/security', `${ACCESS}; ${REFRESH}`);
    expect(page.html).not.toContain('Phone number');
    expect(page.html).not.toContain('New phone number');
  });

  it('does not receive the protected subtree in the streamed payload either', async () => {
    // The assertion above reads the whole response, RSC flight data included, which is the point: an
    // earlier version of this gate lived in the layout, hid the page from the document, and still
    // streamed the entire settings tree into the payload. Naming the client component keeps that
    // specific regression legible.
    const page = await load('/dashboard/security', `${ACCESS}; ${REFRESH}`);
    expect(page.html).not.toContain('PhoneChangeForm');
    expect(page.html).not.toContain('/api/auth/contact/phone/start');
  });

  it('is offered the way back in', async () => {
    const page = await load('/dashboard/security', `${ACCESS}; ${REFRESH}`);
    expect(page.html).toContain('Sign in');
    expect(page.html).toContain('/login');
  });

  it('is told the same thing in Arabic under /ar', async () => {
    const page = await load('/ar/dashboard/security', `${ACCESS}; ${REFRESH}`);
    expect(page.status).toBe(200);
    expect(page.html).toContain('تم تسجيل خروجك');
    expect(page.html).not.toContain('Phone number');
  });

  it('is never told why, and never sees a token', async () => {
    const page = await load('/dashboard/security', `${ACCESS}; ${REFRESH}`);
    expect(page.html).not.toContain('canary-access-token');
    expect(page.html).not.toContain('canary-refresh-token');
    expect(page.html).not.toContain(CANARY_CREDENTIAL);
  });
});

describe('a visitor with a refresh cookie only', () => {
  it('is not redirected: the access cookie expires long before the session does', async () => {
    apiServes('unauthenticated');
    const page = await load('/dashboard/security', REFRESH);
    expect(page.status).toBe(200);
    expect(page.html).toContain('You are signed out');
  });
});

describe('a signed-in visitor', () => {
  it('sees the dashboard page', async () => {
    const page = await load('/dashboard/security', `${ACCESS}; ${REFRESH}`);
    expect(page.status).toBe(200);
    expect(page.html).toContain('Phone number');
    expect(page.html).not.toContain('You are signed out');
  });

  it('is identified by their own token, presented with the internal credential', async () => {
    await load('/dashboard/security', `${ACCESS}; ${REFRESH}`);
    const asked = api.seen.filter((request) => request.url.startsWith('/v1/users/me'));
    expect(asked).toHaveLength(1);
    expect(asked[0]?.credential).toBe(CANARY_CREDENTIAL);
    // The browser's cookie header is read here and never forwarded onward.
    expect(asked[0]?.cookie).toBeNull();
  });

  it('is still not indexable', async () => {
    const page = await load('/dashboard/security', `${ACCESS}; ${REFRESH}`);
    expect(page.robotsHeader).toBe('noindex');
  });
});

describe('when the API cannot answer', () => {
  beforeEach(() => {
    apiServes('unavailable');
  });

  it('the page says so rather than claiming the visitor is signed out', async () => {
    const page = await load('/dashboard/security', `${ACCESS}; ${REFRESH}`);
    expect(page.status).toBe(200);
    expect(page.html).toContain('temporarily unavailable');
    expect(page.html).not.toContain('You are signed out');
  });

  it('and still renders no dashboard content', async () => {
    const page = await load('/dashboard/security', `${ACCESS}; ${REFRESH}`);
    expect(page.html).not.toContain('Phone number');
  });
});

describe('the session BFF routes are reachable through the middleware', () => {
  it('refresh is not rewritten into a locale path', async () => {
    const response = await fetch(`${app.baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { origin: app.baseUrl },
      redirect: 'manual',
    });
    // 401 rather than 404: the route ran and found no refresh cookie.
    expect(response.status).toBe(401);
  });

  it('logout is not rewritten either, and is idempotent with no session', async () => {
    const response = await fetch(`${app.baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { origin: app.baseUrl },
      redirect: 'manual',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('logout clears both session cookies', async () => {
    const response = await fetch(`${app.baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { origin: app.baseUrl, cookie: `${ACCESS}; ${REFRESH}` },
      redirect: 'manual',
    });
    const cookies = response.headers.getSetCookie();
    expect(cookies.some((value) => value.startsWith('__Host-mp_access=') && value.includes('Max-Age=0'))).toBe(true);
    expect(cookies.some((value) => value.startsWith('__Host-mp_refresh=') && value.includes('Max-Age=0'))).toBe(true);
  });
});

describe('the public catalogue is untouched', () => {
  it('still answers 200 without any session', async () => {
    for (const path of ['/listings', '/services', '/categories', '/marketplace', '/search?q=chair']) {
      const page = await load(path);
      expect(page.status, path).toBe(200);
    }
  });

  it('still answers 200 under /ar without any session', async () => {
    for (const path of ['/ar/listings', '/ar/services', '/ar/marketplace']) {
      const page = await load(path);
      expect(page.status, path).toBe(200);
    }
  });

  it('keeps its robots policy: the catalogue is exempt, the dashboard is not', async () => {
    expect((await load('/listings')).robotsHeader).toBeNull();
    expect((await load('/marketplace')).robotsHeader).toBeNull();
    expect((await load('/search?q=chair')).robotsHeader).toBe('noindex');
    expect((await load('/dashboard/security')).robotsHeader).toBe('noindex');
  });

  it('is never redirected to a sign-in page', async () => {
    for (const path of ['/listings', '/marketplace', '/categories']) {
      const page = await load(path);
      expect(page.location, path).toBeNull();
    }
  });
});
