import { describe, expect, it } from 'vitest';
import {
  handleHomepageSectionCreate,
  handleHomepageSectionRemove,
  handleHomepageSectionState,
  handleHomepageSectionUpdate,
  handleHomepageSectionsReorder,
  readHomepageSection,
  readHomepageSections,
} from '../src/server/bff/homepage';

/**
 * The homepage BFF, on the admin origin (0093).
 *
 * What matters at this boundary:
 *
 *   * the caller's token comes from `__Host-mp_admin_access` and never from a body, and the browser's own `Cookie`
 *     header is never forwarded upstream;
 *   * **a configuration is validated against its section type here as well as upstream**, because a document that
 *     does not match its type is the one mistake an editor can make that would otherwise reach the public as a
 *     silently missing section;
 *   * **no visibility flag is ever forwarded by the editing handler**, so changing a section's text cannot show it;
 *   * **nothing can carry a promotion, a placement or a ranking**, which is owner decision A at the boundary;
 *   * responses are validated before a byte reaches a browser;
 *   * every write is same-origin, and a cross-origin submission is refused before its body is read.
 *
 * Everything is stubbed at the `fetch` boundary: no API, no database, no network.
 */

const ENV = {
  API_BASE_URL: 'https://api.internal.test',
  INTERNAL_BFF_CREDENTIAL: 'test-homepage-canary-not-realabcdefghijklmn',
} as const;

const SESSION_TOKEN = 'canary-admin-access-token-not-a-real-token';
const COOKIE = `__Host-mp_admin_access=${SESSION_TOKEN}; __Host-mp_admin_refresh=canary-refresh-not-real`;
const ORIGIN = 'https://admin.test';

const SECTION = 'fc000000-0000-4000-8000-0000000000e1';
const LISTING = '22222222-2222-4222-8222-222222222222';

const SUMMARY = {
  id: SECTION,
  sectionKey: 'home_picks',
  sectionType: 'featured_listings',
  titleEn: 'Our picks',
  titleAr: null,
  sortOrder: 20,
  isActive: true,
  isServed: true,
  isConfigured: true,
  updatedAt: '2026-05-02T09:00:00.000Z',
};

const DETAIL = {
  id: SECTION,
  sectionKey: 'home_picks',
  sectionType: 'featured_listings',
  titleEn: 'Our picks',
  titleAr: null,
  subtitleEn: null,
  subtitleAr: null,
  config: { ids: [LISTING] },
  sortOrder: 20,
  isActive: true,
  isServed: true,
  isConfigured: true,
  createdAt: '2026-04-01T09:00:00.000Z',
  updatedAt: '2026-05-02T09:00:00.000Z',
  canManage: true,
  chosenCount: 4,
  renderableCount: 2,
};

interface Seen {
  url: string;
  method: string;
  cookie: string | null;
  sessionToken: string | null;
  body: string | null;
}

function apiReturns(status: number, body: unknown, seen: { value?: Seen } = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const sent = new Headers(init?.headers);
    seen.value = {
      url: String(input),
      method: init?.method ?? 'GET',
      cookie: sent.get('cookie'),
      sessionToken: sent.get('x-session-token') ?? sent.get('X-Session-Token'),
      body: typeof init?.body === 'string' ? init.body : null,
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

function writeRequest(
  path: string,
  method: string,
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { origin: ORIGIN, 'content-type': 'application/json', cookie: COOKIE, ...headers },
    body: JSON.stringify(body),
  });
}

/* ------------------------------------------------------------------------------------------------ */
/* Reads                                                                                             */
/* ------------------------------------------------------------------------------------------------ */

describe('readHomepageSections', () => {
  it('presents the session token upstream and never the browser cookie', async () => {
    const seen: { value?: Seen } = {};
    await readHomepageSections({
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReturns(200, { sections: [SUMMARY], canManage: true }, seen),
    });
    expect(seen.value?.sessionToken).toBe(SESSION_TOKEN);
    expect(seen.value?.cookie).toBeNull();
    expect(seen.value?.url).toContain('/v1/admin/homepage/sections');
  });

  it('is unauthenticated with no session cookie, without calling upstream', async () => {
    const seen: { value?: Seen } = {};
    const result = await readHomepageSections({
      env: ENV,
      cookieHeader: null,
      fetch: apiReturns(200, {}, seen),
    });
    expect(result.kind).toBe('unauthenticated');
    expect(seen.value).toBeUndefined();
  });

  it('carries the capability flag and the two warning flags', async () => {
    const result = await readHomepageSections({
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReturns(200, {
        sections: [{ ...SUMMARY, isServed: false, isConfigured: false }],
        canManage: false,
      }),
    });
    expect(result.kind === 'ok' && result.data.canManage).toBe(false);
    expect(result.kind === 'ok' && result.data.sections[0]?.isServed).toBe(false);
    expect(result.kind === 'ok' && result.data.sections[0]?.isConfigured).toBe(false);
  });

  it('turns each upstream status into its own answer', async () => {
    for (const [status, kind] of [
      [401, 'unauthenticated'],
      [404, 'notFound'],
      [400, 'invalid'],
      [403, 'unavailable'],
      [503, 'unavailable'],
    ] as const) {
      const result = await readHomepageSections({
        env: ENV,
        cookieHeader: COOKIE,
        fetch: apiReturns(status, { status, code: 'X' }),
      });
      expect(result.kind, String(status)).toBe(kind);
    }
  });

  it('is unavailable when the API cannot be reached, and when its body drifted', async () => {
    expect((await readHomepageSections({ env: ENV, cookieHeader: COOKIE, fetch: apiUnreachable() })).kind).toBe(
      'unavailable',
    );
    const drifted = await readHomepageSections({
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReturns(200, { sections: [{ ...SUMMARY, extra: 1 }], canManage: true }),
    });
    expect(drifted.kind).toBe('unavailable');
  });
});

describe('readHomepageSection', () => {
  it('unwraps the section and keeps both counts', async () => {
    const result = await readHomepageSection(SECTION, {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReturns(200, { section: DETAIL }),
    });
    expect(result.kind).toBe('ok');
    expect(result.kind === 'ok' && result.data.chosenCount).toBe(4);
    expect(result.kind === 'ok' && result.data.renderableCount).toBe(2);
  });

  it('is notFound for an identifier that could not be one, without calling upstream', async () => {
    const seen: { value?: Seen } = {};
    const result = await readHomepageSection('not-a-uuid', {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReturns(200, { section: DETAIL }, seen),
    });
    expect(result.kind).toBe('notFound');
    expect(seen.value).toBeUndefined();
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* Writes                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

describe('handleHomepageSectionCreate', () => {
  it('forwards only the contracts own fields', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleHomepageSectionCreate(
      writeRequest('/api/homepage/sections', 'POST', {
        sectionKey: 'home_latest',
        sectionType: 'latest_listings',
        config: { count: 6 },
        isActive: true,
        createdBy: 'somebody',
      }),
      { env: ENV, fetch: apiReturns(201, { id: SECTION }, seen) },
    );
    expect(response.status).toBe(201);
    const sent = JSON.parse(seen.value?.body ?? '{}') as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(['config', 'sectionKey', 'sectionType']);
  });

  it('refuses a configuration that does not match its type, before the hop', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleHomepageSectionCreate(
      writeRequest('/api/homepage/sections', 'POST', {
        sectionKey: 'home_picks',
        sectionType: 'featured_listings',
        config: { count: 6 },
      }),
      { env: ENV, fetch: apiReturns(201, { id: SECTION }, seen) },
    );
    expect(response.status).toBe(400);
    expect(seen.value).toBeUndefined();
  });

  it('refuses a configuration carrying a promotion, a placement or a ranking', async () => {
    for (const config of [
      { ids: [LISTING], promotionId: SECTION },
      { ids: [LISTING], placement: 'homepage' },
      { ids: [LISTING], promoted: true },
      { count: 4, ranking: 'promoted_first' },
    ]) {
      const response = await handleHomepageSectionCreate(
        writeRequest('/api/homepage/sections', 'POST', {
          sectionKey: 'home_picks',
          sectionType: 'featured_listings',
          config,
        }),
        { env: ENV, fetch: apiReturns(201, { id: SECTION }) },
      );
      expect(response.status, JSON.stringify(config)).toBe(400);
    }
  });

  it('cannot create a banner_strip', async () => {
    const response = await handleHomepageSectionCreate(
      writeRequest('/api/homepage/sections', 'POST', {
        sectionKey: 'home_strip',
        sectionType: 'banner_strip',
        config: {},
      }),
      { env: ENV, fetch: apiReturns(201, { id: SECTION }) },
    );
    expect(response.status).toBe(400);
  });

  it('refuses a cross-origin submission before reading its body', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleHomepageSectionCreate(
      writeRequest(
        '/api/homepage/sections',
        'POST',
        { sectionKey: 'home_latest', sectionType: 'latest_listings', config: { count: 4 } },
        { origin: 'https://evil.test' },
      ),
      { env: ENV, fetch: apiReturns(201, { id: SECTION }, seen) },
    );
    expect(response.status).toBe(403);
    expect(seen.value).toBeUndefined();
  });

  it('is a 401 with no session cookie', async () => {
    const response = await handleHomepageSectionCreate(
      new Request(`${ORIGIN}/api/homepage/sections`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ sectionKey: 'home_latest', sectionType: 'latest_listings', config: { count: 4 } }),
      }),
      { env: ENV, fetch: apiReturns(201, { id: SECTION }) },
    );
    expect(response.status).toBe(401);
  });
});

describe('handleHomepageSectionUpdate', () => {
  it('never forwards a visibility flag, so editing cannot show a section', async () => {
    const seen: { value?: Seen } = {};
    await handleHomepageSectionUpdate(
      writeRequest('/api/homepage/sections', 'PATCH', {
        sectionId: SECTION,
        titleEn: 'Renamed',
        isActive: true,
      }),
      { env: ENV, fetch: apiReturns(200, { ok: true }, seen) },
    );
    const sent = JSON.parse(seen.value?.body ?? '{}') as Record<string, unknown>;
    expect('isActive' in sent).toBe(false);
    expect(seen.value?.url).toContain(`/v1/admin/homepage/sections/${SECTION}`);
    expect(seen.value?.url).not.toContain('/state');
  });

  it('keeps an absent field absent and an explicit null null', async () => {
    const seen: { value?: Seen } = {};
    await handleHomepageSectionUpdate(
      writeRequest('/api/homepage/sections', 'PATCH', { sectionId: SECTION, titleEn: 'Renamed' }),
      { env: ENV, fetch: apiReturns(200, { ok: true }, seen) },
    );
    expect(JSON.parse(seen.value?.body ?? '{}')).toEqual({ titleEn: 'Renamed' });

    await handleHomepageSectionUpdate(
      writeRequest('/api/homepage/sections', 'PATCH', { sectionId: SECTION, titleAr: null }),
      { env: ENV, fetch: apiReturns(200, { ok: true }, seen) },
    );
    expect(JSON.parse(seen.value?.body ?? '{}')).toEqual({ titleAr: null });
  });

  it('refuses a configuration sent without the type to check it against', async () => {
    const response = await handleHomepageSectionUpdate(
      writeRequest('/api/homepage/sections', 'PATCH', { sectionId: SECTION, config: { ids: [LISTING] } }),
      { env: ENV, fetch: apiReturns(200, { ok: true }) },
    );
    expect(response.status).toBe(400);
  });

  it('refuses a mismatched configuration even with its type', async () => {
    const response = await handleHomepageSectionUpdate(
      writeRequest('/api/homepage/sections', 'PATCH', {
        sectionId: SECTION,
        sectionType: 'featured_listings',
        config: { count: 4 },
      }),
      { env: ENV, fetch: apiReturns(200, { ok: true }) },
    );
    expect(response.status).toBe(400);
  });

  it('is a 400 for a missing or malformed section identifier, and for an empty update', async () => {
    for (const body of [
      { titleEn: 'Renamed' },
      { sectionId: 'not-a-uuid', titleEn: 'Renamed' },
      { sectionId: SECTION },
    ]) {
      const response = await handleHomepageSectionUpdate(
        writeRequest('/api/homepage/sections', 'PATCH', body),
        { env: ENV, fetch: apiReturns(200, { ok: true }) },
      );
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe('handleHomepageSectionState', () => {
  it('calls the one upstream route that can show a section', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleHomepageSectionState(
      writeRequest('/api/homepage/sections/state', 'POST', { sectionId: SECTION, isActive: true }),
      { env: ENV, fetch: apiReturns(200, { ok: true }, seen) },
    );
    expect(response.status).toBe(200);
    expect(seen.value?.method).toBe('PUT');
    expect(seen.value?.url).toContain(`/v1/admin/homepage/sections/${SECTION}/state`);
    expect(JSON.parse(seen.value?.body ?? '{}')).toEqual({ isActive: true });
  });

  it('drops a field that belongs to the editing request rather than forwarding it', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleHomepageSectionState(
      writeRequest('/api/homepage/sections/state', 'POST', { sectionId: SECTION, isActive: true, sortOrder: 0 }),
      { env: ENV, fetch: apiReturns(200, { ok: true }, seen) },
    );
    // The body is rebuilt from the contract's own field rather than forwarded, which every handler on this origin
    // does: a stray `sortOrder` has nowhere to go, so it cannot reorder the homepage from the visibility route.
    expect(response.status).toBe(200);
    expect(JSON.parse(seen.value?.body ?? '{}')).toEqual({ isActive: true });
  });

  it('refuses a body with no flag at all', async () => {
    const response = await handleHomepageSectionState(
      writeRequest('/api/homepage/sections/state', 'POST', { sectionId: SECTION }),
      { env: ENV, fetch: apiReturns(200, { ok: true }) },
    );
    expect(response.status).toBe(400);
  });

  it('forwards the refusals a screen must act on, with the APIs own body', async () => {
    for (const [status, code] of [
      [409, 'HOMEPAGE_SECTION_KEY_TAKEN'],
      [409, 'HOMEPAGE_SECTION_NOT_ALLOWED'],
      [404, 'NOT_FOUND'],
    ] as const) {
      const response = await handleHomepageSectionState(
        writeRequest('/api/homepage/sections/state', 'POST', { sectionId: SECTION, isActive: true }),
        { env: ENV, fetch: apiReturns(status, { status, code, detail: 'Upstream said so.' }) },
      );
      expect(response.status, code).toBe(status);
      expect(((await response.json()) as { code: string }).code, code).toBe(code);
    }
  });

  it('collapses a status nobody expected into one outage', async () => {
    const response = await handleHomepageSectionState(
      writeRequest('/api/homepage/sections/state', 'POST', { sectionId: SECTION, isActive: true }),
      { env: ENV, fetch: apiReturns(418, { status: 418, code: 'TEAPOT' }) },
    );
    expect(response.status).toBe(503);
  });
});

describe('handleHomepageSectionsReorder', () => {
  it('sends the whole order and calls the reorder route', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleHomepageSectionsReorder(
      writeRequest('/api/homepage/sections/reorder', 'POST', { sectionIds: [SECTION, LISTING] }),
      { env: ENV, fetch: apiReturns(200, { ok: true }, seen) },
    );
    expect(response.status).toBe(200);
    expect(seen.value?.method).toBe('PUT');
    expect(seen.value?.url).toContain('/v1/admin/homepage/sections/reorder');
    expect(JSON.parse(seen.value?.body ?? '{}')).toEqual({ sectionIds: [SECTION, LISTING] });
  });

  it('refuses an id that could not be one', async () => {
    const response = await handleHomepageSectionsReorder(
      writeRequest('/api/homepage/sections/reorder', 'POST', { sectionIds: ['not-a-uuid'] }),
      { env: ENV, fetch: apiReturns(200, { ok: true }) },
    );
    expect(response.status).toBe(400);
  });
});

describe('handleHomepageSectionRemove', () => {
  it('removes with a POST here and a DELETE upstream', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleHomepageSectionRemove(
      writeRequest('/api/homepage/sections/remove', 'POST', { sectionId: SECTION }),
      { env: ENV, fetch: apiReturns(200, { ok: true }, seen) },
    );
    expect(response.status).toBe(200);
    expect(seen.value?.method).toBe('DELETE');
    expect(seen.value?.body).toBeNull();
  });

  it('is a 400 for an identifier that could not be one', async () => {
    const response = await handleHomepageSectionRemove(
      writeRequest('/api/homepage/sections/remove', 'POST', { sectionId: 'not-a-uuid' }),
      { env: ENV, fetch: apiReturns(200, { ok: true }) },
    );
    expect(response.status).toBe(400);
  });
});
