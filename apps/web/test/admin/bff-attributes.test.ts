import { describe, expect, it } from 'vitest';
import {
  handleAttributeCreate,
  handleAttributeOptionCreate,
  handleAttributeOptionState,
  handleAttributeOptionUpdate,
  handleAttributeState,
  handleAttributeUpdate,
  handleCategoryAttributeAttach,
  handleCategoryAttributeDetach,
  handleTagCreate,
  handleTagState,
  handleTagUpdate,
  readAttributeDetail,
  readAttributeVocabulary,
  readCategoryAttributes,
  readTags,
} from '../../src/admin/server/bff/attributes';

/**
 * The attribute and tag BFF, on the admin origin.
 *
 * What matters at this boundary:
 *
 *   * the caller's token comes from `__Host-mp_admin_access` and never from a body, and the browser's own
 *     `Cookie` header is never forwarded upstream;
 *   * **the body is rebuilt, never forwarded** — a `key` or `dataType` sent to the attribute edit never crosses,
 *     nor a `value` to an option edit, nor a `slug` to a tag rename, so none of those renames is expressible from
 *     a browser; an `isActive` sent to an edit never crosses either, so an edit cannot show a field by accident;
 *   * a thing is named by its id in the **route**, from a value checked for shape here;
 *   * responses are validated against the contract before a byte reaches a browser;
 *   * the three refusals a screen must act on are forwarded with the API's own problem body, and anything else
 *     becomes one 503;
 *   * every write is same-origin, and a cross-origin submission is refused before its body is read.
 *
 * Everything is stubbed at the `fetch` boundary: no API, no database, no network.
 */

const ENV = {
  API_BASE_URL: 'https://api.internal.test',
  INTERNAL_BFF_CREDENTIAL: 'test-attributes-canary-credential-abcdefghi',
} as const;

const SESSION_TOKEN = 'canary-admin-access-token-not-a-real-token';
const COOKIE = `__Host-mp_admin_access=${SESSION_TOKEN}; __Host-mp_admin_refresh=canary-refresh-not-real`;
const ORIGIN = 'https://admin.test';

const DEFINITION = 'dd000000-0000-4000-8000-0000000000d1';
const OPTION = 'ee000000-0000-4000-8000-0000000000e1';
const TAG = 'ff000000-0000-4000-8000-0000000000f1';
const CATEGORY = 'cc000000-0000-4000-8000-0000000000c1';

const DEFINITION_ROW = {
  definitionId: DEFINITION,
  key: 'width',
  dataType: 'number',
  unit: 'cm',
  nameEn: 'Width',
  nameAr: 'العرض',
  isFilterable: true,
  isActive: true,
  sortOrder: 1,
  optionCount: 0,
  categoryCount: 2,
  answerCount: 7,
  createdAt: '2026-04-01T09:00:00.000Z',
  updatedAt: '2026-05-02T09:00:00.000Z',
};

const TAG_ROW = {
  tagId: TAG,
  slug: 'handmade',
  nameEn: 'Handmade',
  nameAr: 'صناعة يدوية',
  isActive: true,
  usageCount: 4,
  createdAt: '2026-04-01T09:00:00.000Z',
  updatedAt: '2026-05-02T09:00:00.000Z',
};

const CATEGORY_ATTRIBUTE_ROW = {
  definitionId: DEFINITION,
  key: 'width',
  dataType: 'number',
  unit: 'cm',
  nameEn: 'Width',
  nameAr: 'العرض',
  isRequired: true,
  isFilterable: true,
  sortOrder: 1,
  isActive: true,
  optionCount: 0,
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

function writeRequest(path: string, method: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { origin: ORIGIN, 'content-type': 'application/json', cookie: COOKIE, ...headers },
    body: JSON.stringify(body),
  });
}

/* ------------------------------------------------------------------------------------------------ */
/* Reads                                                                                            */
/* ------------------------------------------------------------------------------------------------ */

describe('reading the vocabularies', () => {
  it('presents the session token upstream and never the browser cookie', async () => {
    const seen: { value?: Seen } = {};
    await readAttributeVocabulary({
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReturns(200, { attributes: [DEFINITION_ROW], canManage: true }, seen),
    });
    expect(seen.value?.url).toBe('https://api.internal.test/v1/admin/attributes');
    expect(seen.value?.method).toBe('GET');
    expect(seen.value?.sessionToken).toBe(SESSION_TOKEN);
    expect(seen.value?.cookie).toBeNull();
  });

  it('returns the vocabulary', async () => {
    const result = await readAttributeVocabulary({
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReturns(200, { attributes: [DEFINITION_ROW], canManage: true }),
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.data.attributes[0]?.key).toBe('width');
  });

  it('treats an empty vocabulary as a state rather than a failure', async () => {
    const result = await readAttributeVocabulary({
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReturns(200, { attributes: [], canManage: true }),
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.data.attributes).toEqual([]);
  });

  it('needs a session cookie before it calls anything', async () => {
    const seen: { value?: Seen } = {};
    const result = await readAttributeVocabulary({
      env: ENV,
      cookieHeader: null,
      fetch: apiReturns(200, { attributes: [], canManage: true }, seen),
    });
    expect(result.kind).toBe('unauthenticated');
    expect(seen.value).toBeUndefined();
  });

  it('reports a refusal as an absence, exactly as the API does', async () => {
    const result = await readAttributeVocabulary({
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReturns(404, { status: 404, code: 'NOT_FOUND' }),
    });
    expect(result.kind).toBe('notFound');
  });

  it('reports an outage as an outage', async () => {
    for (const fetcher of [apiReturns(503, { status: 503, code: 'SERVICE_UNAVAILABLE' }), apiUnreachable()]) {
      const result = await readAttributeVocabulary({ env: ENV, cookieHeader: COOKIE, fetch: fetcher });
      expect(result.kind).toBe('unavailable');
    }
  });

  it('refuses a body the contract does not recognise rather than forwarding it', async () => {
    const result = await readAttributeVocabulary({
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReturns(200, { attributes: [{ ...DEFINITION_ROW, dataType: 'colour' }], canManage: true }),
    });
    expect(result.kind).toBe('unavailable');
  });

  it('reads one attribute by the identifier in the route', async () => {
    const seen: { value?: Seen } = {};
    await readAttributeDetail(DEFINITION, {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReturns(200, { attribute: DEFINITION_ROW, options: [], canManage: true }, seen),
    });
    expect(seen.value?.url).toBe(`https://api.internal.test/v1/admin/attributes/${DEFINITION}`);
  });

  it('answers that a made-up address holds nothing, without calling the API', async () => {
    const seen: { value?: Seen } = {};
    for (const bad of ['not-a-uuid', '', undefined]) {
      const result = await readAttributeDetail(bad, {
        env: ENV,
        cookieHeader: COOKIE,
        fetch: apiReturns(200, {}, seen),
      });
      expect(result.kind, String(bad)).toBe('notFound');
    }
    expect(seen.value).toBeUndefined();
  });

  it('reads the tags from their own address', async () => {
    const seen: { value?: Seen } = {};
    const result = await readTags({
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReturns(200, { tags: [TAG_ROW], canManage: true }, seen),
    });
    expect(seen.value?.url).toBe('https://api.internal.test/v1/admin/tags');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.data.tags[0]?.slug).toBe('handmade');
  });

  it('reads what a category asks from the category’s own address', async () => {
    const seen: { value?: Seen } = {};
    const result = await readCategoryAttributes(CATEGORY, {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReturns(200, { attributes: [CATEGORY_ATTRIBUTE_ROW], canManage: false }, seen),
    });
    expect(seen.value?.url).toBe(`https://api.internal.test/v1/admin/categories/${CATEGORY}/attributes`);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.data.canManage).toBe(false);
      expect(result.data.attributes[0]?.isRequired).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* Writes                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

describe('defining an attribute', () => {
  it('rebuilds the body and answers with the new identifier', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleAttributeCreate(
      writeRequest('/api/attributes', 'POST', {
        key: 'depth',
        dataType: 'number',
        nameEn: 'Depth',
        nameAr: 'العمق',
        unit: 'cm',
        // Not part of the contract. It must not cross.
        isActive: true,
      }),
      { env: ENV, fetch: apiReturns(201, { definitionId: DEFINITION }, seen) },
    );
    // `isActive` is not in the schema, and the schema is strict, so the whole request is refused rather than
    // quietly stripped: a colleague who asked for something impossible is told, not half-obeyed.
    expect(response.status).toBe(400);
    expect(seen.value).toBeUndefined();

    const good = await handleAttributeCreate(
      writeRequest('/api/attributes', 'POST', {
        key: 'depth',
        dataType: 'number',
        nameEn: 'Depth',
        nameAr: 'العمق',
        unit: 'cm',
      }),
      { env: ENV, fetch: apiReturns(201, { definitionId: DEFINITION }, seen) },
    );
    expect(good.status).toBe(201);
    expect(await good.json()).toEqual({ definitionId: DEFINITION });
    expect(seen.value?.url).toBe('https://api.internal.test/v1/admin/attributes');
    expect(seen.value?.sessionToken).toBe(SESSION_TOKEN);
    expect(seen.value?.cookie).toBeNull();
  });

  it('refuses a unit on an attribute that is not a number, before anything crosses', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleAttributeCreate(
      writeRequest('/api/attributes', 'POST', {
        key: 'colour',
        dataType: 'text',
        nameEn: 'Colour',
        nameAr: 'اللون',
        unit: 'cm',
      }),
      { env: ENV, fetch: apiReturns(201, { definitionId: DEFINITION }, seen) },
    );
    expect(response.status).toBe(400);
    expect(seen.value).toBeUndefined();
  });

  it('refuses a cross-origin submission before reading its body', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleAttributeCreate(
      writeRequest(
        '/api/attributes',
        'POST',
        { key: 'depth', dataType: 'number', nameEn: 'Depth', nameAr: 'العمق' },
        { origin: 'https://evil.test' },
      ),
      { env: ENV, fetch: apiReturns(201, { definitionId: DEFINITION }, seen) },
    );
    expect(response.status).toBe(403);
    expect(seen.value).toBeUndefined();
  });

  it('needs a session cookie', async () => {
    const request = new Request(`${ORIGIN}/api/attributes`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'depth', dataType: 'number', nameEn: 'Depth', nameAr: 'العمق' }),
    });
    const response = await handleAttributeCreate(request, { env: ENV, fetch: apiUnreachable() });
    expect(response.status).toBe(401);
  });
});

describe('what cannot be renamed', () => {
  it('never lets a key or a data type cross on an edit', async () => {
    const seen: { value?: Seen } = {};
    for (const extra of [{ key: 'renamed' }, { dataType: 'text' }, { isActive: false }]) {
      const response = await handleAttributeUpdate(
        writeRequest('/api/attributes', 'PATCH', {
          definitionId: DEFINITION,
          nameEn: 'Width',
          nameAr: 'العرض',
          isFilterable: true,
          sortOrder: 1,
          ...extra,
        }),
        { env: ENV, fetch: apiReturns(200, { changed: true }, seen) },
      );
      expect(response.status, JSON.stringify(extra)).toBe(400);
      expect(seen.value, JSON.stringify(extra)).toBeUndefined();
    }
  });

  it('never lets an option value cross on an edit', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleAttributeOptionUpdate(
      writeRequest('/api/attributes/options', 'PATCH', {
        definitionId: DEFINITION,
        optionId: OPTION,
        labelEn: 'Oak',
        labelAr: 'بلوط',
        sortOrder: 1,
        value: 'renamed',
      }),
      { env: ENV, fetch: apiReturns(200, { changed: true }, seen) },
    );
    expect(response.status).toBe(400);
    expect(seen.value).toBeUndefined();
  });

  it('never lets a tag slug cross on a rename', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleTagUpdate(
      writeRequest('/api/tags', 'PATCH', {
        tagId: TAG,
        nameEn: 'Handmade',
        nameAr: 'يدوي',
        slug: 'renamed',
      }),
      { env: ENV, fetch: apiReturns(200, { changed: true }, seen) },
    );
    expect(response.status).toBe(400);
    expect(seen.value).toBeUndefined();
  });

  it('puts the identifier in the route and keeps it out of the body', async () => {
    const seen: { value?: Seen } = {};
    await handleAttributeUpdate(
      writeRequest('/api/attributes', 'PATCH', {
        definitionId: DEFINITION,
        nameEn: 'Width',
        nameAr: 'العرض',
        unit: 'mm',
        isFilterable: false,
        sortOrder: 9,
      }),
      { env: ENV, fetch: apiReturns(200, { changed: true }, seen) },
    );
    expect(seen.value?.url).toBe(`https://api.internal.test/v1/admin/attributes/${DEFINITION}`);
    expect(seen.value?.method).toBe('PATCH');
    expect(JSON.parse(seen.value?.body ?? '{}')).toEqual({
      nameEn: 'Width',
      nameAr: 'العرض',
      unit: 'mm',
      isFilterable: false,
      sortOrder: 9,
    });
  });

  it('refuses an identifier that cannot name anything, without calling the API', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleAttributeUpdate(
      writeRequest('/api/attributes', 'PATCH', {
        definitionId: 'not-a-uuid',
        nameEn: 'Width',
        nameAr: 'العرض',
        isFilterable: true,
        sortOrder: 1,
      }),
      { env: ENV, fetch: apiReturns(200, { changed: true }, seen) },
    );
    expect(response.status).toBe(400);
    expect(seen.value).toBeUndefined();
  });
});

describe('showing and hiding', () => {
  it('sends the state to the attribute’s own state route', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleAttributeState(
      writeRequest('/api/attributes/state', 'PUT', { definitionId: DEFINITION, isActive: false }),
      { env: ENV, fetch: apiReturns(200, { changed: true }, seen) },
    );
    expect(response.status).toBe(200);
    expect(seen.value?.url).toBe(`https://api.internal.test/v1/admin/attributes/${DEFINITION}/state`);
    expect(JSON.parse(seen.value?.body ?? '{}')).toEqual({ isActive: false });
  });

  it('sends an option’s state to the option’s own state route', async () => {
    const seen: { value?: Seen } = {};
    await handleAttributeOptionState(
      writeRequest('/api/attributes/options/state', 'PUT', {
        definitionId: DEFINITION,
        optionId: OPTION,
        isActive: false,
      }),
      { env: ENV, fetch: apiReturns(200, { changed: true }, seen) },
    );
    expect(seen.value?.url).toBe(
      `https://api.internal.test/v1/admin/attributes/${DEFINITION}/options/${OPTION}/state`,
    );
  });

  it('sends a tag’s state to the tag’s own state route', async () => {
    const seen: { value?: Seen } = {};
    await handleTagState(writeRequest('/api/tags/state', 'PUT', { tagId: TAG, isActive: false }), {
      env: ENV,
      fetch: apiReturns(200, { changed: true }, seen),
    });
    expect(seen.value?.url).toBe(`https://api.internal.test/v1/admin/tags/${TAG}/state`);
  });

  it('refuses a state that is not a boolean', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleTagState(
      writeRequest('/api/tags/state', 'PUT', { tagId: TAG, isActive: 'yes' }),
      { env: ENV, fetch: apiReturns(200, { changed: true }, seen) },
    );
    expect(response.status).toBe(400);
    expect(seen.value).toBeUndefined();
  });
});

describe('options and tags', () => {
  it('adds an option under its attribute', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleAttributeOptionCreate(
      writeRequest('/api/attributes/options', 'POST', {
        definitionId: DEFINITION,
        value: 'pine',
        labelEn: 'Pine',
        labelAr: 'صنوبر',
      }),
      { env: ENV, fetch: apiReturns(201, { optionId: OPTION }, seen) },
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ optionId: OPTION });
    expect(seen.value?.url).toBe(`https://api.internal.test/v1/admin/attributes/${DEFINITION}/options`);
    expect(JSON.parse(seen.value?.body ?? '{}')).toEqual({
      value: 'pine',
      labelEn: 'Pine',
      labelAr: 'صنوبر',
    });
  });

  it('creates a tag and answers with its identifier', async () => {
    const response = await handleTagCreate(
      writeRequest('/api/tags', 'POST', { slug: 'vintage', nameEn: 'Vintage', nameAr: 'عتيق' }),
      { env: ENV, fetch: apiReturns(201, { tagId: TAG }) },
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ tagId: TAG });
  });

  it('refuses a blank label', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleTagCreate(
      writeRequest('/api/tags', 'POST', { slug: 'vintage', nameEn: '   ', nameAr: 'عتيق' }),
      { env: ENV, fetch: apiReturns(201, { tagId: TAG }, seen) },
    );
    expect(response.status).toBe(400);
    expect(seen.value).toBeUndefined();
  });

  it('refuses a slug the column would refuse', async () => {
    const seen: { value?: Seen } = {};
    for (const slug of ['Vintage', 'with space', '-leading', 'a'.repeat(51)]) {
      const response = await handleTagCreate(
        writeRequest('/api/tags', 'POST', { slug, nameEn: 'Vintage', nameAr: 'عتيق' }),
        { env: ENV, fetch: apiReturns(201, { tagId: TAG }, seen) },
      );
      expect(response.status, slug).toBe(400);
    }
    expect(seen.value).toBeUndefined();
  });
});

describe('what a category asks', () => {
  it('attaches to the category’s own address, with the identifier in the route', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleCategoryAttributeAttach(
      writeRequest('/api/categories/attributes', 'PUT', {
        categoryId: CATEGORY,
        definitionId: DEFINITION,
        isRequired: true,
        sortOrder: 3,
      }),
      { env: ENV, fetch: apiReturns(200, { changed: true }, seen) },
    );
    expect(response.status).toBe(200);
    expect(seen.value?.url).toBe(`https://api.internal.test/v1/admin/categories/${CATEGORY}/attributes`);
    expect(JSON.parse(seen.value?.body ?? '{}')).toEqual({
      definitionId: DEFINITION,
      isRequired: true,
      sortOrder: 3,
    });
  });

  it('detaches with a POST here and a DELETE upstream, and deletes no answer', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleCategoryAttributeDetach(
      writeRequest('/api/categories/attributes/remove', 'POST', {
        categoryId: CATEGORY,
        definitionId: DEFINITION,
      }),
      { env: ENV, fetch: apiReturns(200, { changed: true }, seen) },
    );
    expect(response.status).toBe(200);
    expect(seen.value?.method).toBe('DELETE');
    expect(seen.value?.url).toBe(
      `https://api.internal.test/v1/admin/categories/${CATEGORY}/attributes/${DEFINITION}`,
    );
    expect(seen.value?.body).toBeNull();
  });

  it('forwards that nothing changed, rather than inventing a refusal', async () => {
    const response = await handleCategoryAttributeDetach(
      writeRequest('/api/categories/attributes/remove', 'POST', {
        categoryId: CATEGORY,
        definitionId: DEFINITION,
      }),
      { env: ENV, fetch: apiReturns(200, { changed: false }) },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ changed: false });
  });
});

describe('how refusals travel', () => {
  const REFUSALS = [
    { status: 409, code: 'ATTRIBUTE_KEY_TAKEN' },
    { status: 409, code: 'ATTRIBUTE_NOT_ANSWERABLE' },
    { status: 409, code: 'ATTRIBUTE_VALUE_NOT_ALLOWED' },
    { status: 404, code: 'NOT_FOUND' },
    { status: 401, code: 'AUTHENTICATION_REQUIRED' },
  ] as const;

  for (const refusal of REFUSALS) {
    it(`forwards ${refusal.code} with its own status`, async () => {
      const response = await handleAttributeCreate(
        writeRequest('/api/attributes', 'POST', {
          key: 'depth',
          dataType: 'number',
          nameEn: 'Depth',
          nameAr: 'العمق',
        }),
        { env: ENV, fetch: apiReturns(refusal.status, { status: refusal.status, code: refusal.code }) },
      );
      expect(response.status).toBe(refusal.status);
      expect(await response.json()).toMatchObject({ code: refusal.code });
    });
  }

  it('turns a status nobody expected into one 503', async () => {
    const response = await handleAttributeCreate(
      writeRequest('/api/attributes', 'POST', {
        key: 'depth',
        dataType: 'number',
        nameEn: 'Depth',
        nameAr: 'العمق',
      }),
      { env: ENV, fetch: apiReturns(418, { status: 418, code: 'TEAPOT' }) },
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('turns a success the contract does not recognise into one 503', async () => {
    const response = await handleAttributeCreate(
      writeRequest('/api/attributes', 'POST', {
        key: 'depth',
        dataType: 'number',
        nameEn: 'Depth',
        nameAr: 'العمق',
      }),
      { env: ENV, fetch: apiReturns(201, { definition: DEFINITION }) },
    );
    expect(response.status).toBe(503);
  });

  it('turns an unreachable API into one 503', async () => {
    const response = await handleTagState(
      writeRequest('/api/tags/state', 'PUT', { tagId: TAG, isActive: false }),
      { env: ENV, fetch: apiUnreachable() },
    );
    expect(response.status).toBe(503);
  });
});
