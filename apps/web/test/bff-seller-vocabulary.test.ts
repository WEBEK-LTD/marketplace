import { describe, expect, it } from 'vitest';
import {
  handleSellerVocabularyAttributesSave,
  handleSellerVocabularyTagsSave,
  readSellerListingVocabulary,
} from '../src/server/bff/seller-vocabulary';

/**
 * The seller vocabulary BFF, on the web origin (Phase 8-C).
 *
 * What matters at this boundary:
 *
 *   * the Origin check runs **before** the session cookie is read;
 *   * the token travels in the session-token header and the browser's `Cookie` header never does;
 *   * **what is forwarded is the validated value, never the text a browser sent** — an answer whose shape does
 *     not match its own kind, a second answer for the same attribute, a tag chosen twice and a field the
 *     contract does not name all stop here;
 *   * the surface is the caller's parameter, not the request's, so a product cannot be answered through the
 *     services path;
 *   * one exact success status, and the refusal a screen must act on travels with the API's own code;
 *   * a malformed slug costs no upstream hop.
 *
 * Everything is stubbed at the `fetch` boundary: no API, no database, no network.
 */

const ENV = {
  API_BASE_URL: 'https://api.internal.test',
  INTERNAL_BFF_CREDENTIAL: 'test-web-vocabulary-canary-not-real-abcdefg',
} as const;

const ACCESS_TOKEN = 'canary-access-token-value-not-a-real-token';
const COOKIE = `__Host-mp_access=${ACCESS_TOKEN}; __Host-mp_refresh=canary-refresh-not-real`;
const ORIGIN = 'https://web.test';

const ATTRIBUTES = {
  attributes: [
    {
      key: 'width',
      label: 'Width',
      dataType: 'number',
      unit: 'cm',
      isRequired: true,
      sortOrder: 1,
      text: null,
      number: 180,
      boolean: null,
      options: [],
      choices: [],
    },
  ],
  isEditable: true,
};

const TAGS = {
  tags: [{ slug: 'handmade', name: 'Handmade', isSelected: true }],
  isEditable: true,
};

interface Seen {
  url: string;
  method: string;
  cookie: string | null;
  sessionToken: string | null;
  body: string | null;
}

/** A stub that answers both reads, and records every call. */
function apiReads(
  attributes: { status: number; body: unknown },
  tags: { status: number; body: unknown },
  seen: Seen[] = [],
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const sent = new Headers(init?.headers);
    seen.push({
      url,
      method: init?.method ?? 'GET',
      cookie: sent.get('cookie'),
      sessionToken: sent.get('x-session-token'),
      body: typeof init?.body === 'string' ? init.body : null,
    });
    const chosen = url.includes('/tags') ? tags : attributes;
    return new Response(JSON.stringify(chosen.body), {
      status: chosen.status,
      headers: {
        'content-type': chosen.status < 400 ? 'application/json' : 'application/problem+json',
      },
    });
  }) as unknown as typeof fetch;
}

function apiReturns(status: number, body: unknown, seen: { value?: Seen } = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const sent = new Headers(init?.headers);
    seen.value = {
      url: String(input),
      method: init?.method ?? 'GET',
      cookie: sent.get('cookie'),
      sessionToken: sent.get('x-session-token'),
      body: typeof init?.body === 'string' ? init.body : null,
    };
    return new Response(JSON.stringify(body), {
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

function writeRequest(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json', cookie: COOKIE, ...headers },
    body: JSON.stringify(body),
  });
}

const OK = { status: 200, body: ATTRIBUTES };
const OK_TAGS = { status: 200, body: TAGS };

describe('reading one listing’s vocabulary', () => {
  it('asks both questions of the surface it was given, in the locale it was given', async () => {
    const seen: Seen[] = [];
    await readSellerListingVocabulary('listings', 'a-chair', 'ar', {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReads(OK, OK_TAGS, seen),
    });
    expect(seen.map((call) => call.url).sort()).toEqual([
      'https://api.internal.test/v1/sellers/me/listings/a-chair/attributes?locale=ar',
      'https://api.internal.test/v1/sellers/me/listings/a-chair/tags?locale=ar',
    ]);
    for (const call of seen) {
      expect(call.sessionToken).toBe(ACCESS_TOKEN);
      expect(call.cookie).toBeNull();
    }
  });

  it('asks about services when the services surface is named, and never about listings', async () => {
    const seen: Seen[] = [];
    await readSellerListingVocabulary('services', 'a-service', 'en', {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReads(OK, OK_TAGS, seen),
    });
    for (const call of seen) {
      expect(call.url).toContain('/v1/sellers/me/services/');
      expect(call.url).not.toContain('/v1/sellers/me/listings/');
    }
  });

  it('returns the questions, the tags and whether they may be changed', async () => {
    const result = await readSellerListingVocabulary('listings', 'a-chair', 'en', {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReads(OK, OK_TAGS),
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.attributes[0]?.key).toBe('width');
      expect(result.tags[0]?.slug).toBe('handmade');
      expect(result.isEditable).toBe(true);
    }
  });

  it('takes the stricter answer if the two halves ever disagreed about editability', async () => {
    const result = await readSellerListingVocabulary('listings', 'a-chair', 'en', {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReads(OK, { status: 200, body: { ...TAGS, isEditable: false } }),
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.isEditable).toBe(false);
  });

  it('needs a session cookie before it calls anything', async () => {
    const seen: Seen[] = [];
    const result = await readSellerListingVocabulary('listings', 'a-chair', 'en', {
      env: ENV,
      cookieHeader: null,
      fetch: apiReads(OK, OK_TAGS, seen),
    });
    expect(result.kind).toBe('unauthenticated');
    expect(seen).toEqual([]);
  });

  it('refuses a malformed slug without an upstream hop', async () => {
    const seen: Seen[] = [];
    for (const slug of ['Not A Slug', 'a/../b', '']) {
      const result = await readSellerListingVocabulary('listings', slug, 'en', {
        env: ENV,
        cookieHeader: COOKIE,
        fetch: apiReads(OK, OK_TAGS, seen),
      });
      expect(result.kind, slug).toBe('not_found');
    }
    expect(seen).toEqual([]);
  });

  it('reports an absence as an absence and an outage as an outage', async () => {
    const cases = [
      { status: 404, kind: 'not_found' },
      { status: 401, kind: 'unauthenticated' },
      { status: 503, kind: 'unavailable' },
      { status: 500, kind: 'unavailable' },
    ] as const;
    for (const scenario of cases) {
      const result = await readSellerListingVocabulary('listings', 'a-chair', 'en', {
        env: ENV,
        cookieHeader: COOKIE,
        fetch: apiReads({ status: scenario.status, body: { code: 'X' } }, OK_TAGS),
      });
      expect(result.kind, String(scenario.status)).toBe(scenario.kind);
    }
  });

  it('is an outage when either half fails, never half a form', async () => {
    const result = await readSellerListingVocabulary('listings', 'a-chair', 'en', {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReads(OK, { status: 503, body: { code: 'SERVICE_UNAVAILABLE' } }),
    });
    expect(result.kind).toBe('unavailable');
  });

  it('is an outage when a body the contract does not recognise comes back', async () => {
    const result = await readSellerListingVocabulary('listings', 'a-chair', 'en', {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiReads({ status: 200, body: { attributes: [{ key: 'width' }], isEditable: true } }, OK_TAGS),
    });
    expect(result.kind).toBe('unavailable');
  });

  it('is an outage when the API cannot be reached', async () => {
    const result = await readSellerListingVocabulary('listings', 'a-chair', 'en', {
      env: ENV,
      cookieHeader: COOKIE,
      fetch: apiUnreachable(),
    });
    expect(result.kind).toBe('unavailable');
  });
});

describe('saving answers', () => {
  it('forwards the validated answers to the surface it was given', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleSellerVocabularyAttributesSave(
      writeRequest('/api/sellers/me/listings/a-chair/attributes', {
        answers: [
          { kind: 'number', key: 'width', number: 180 },
          { kind: 'single_select', key: 'material', options: ['oak'] },
        ],
      }),
      'listings',
      'a-chair',
      { env: ENV, fetch: apiReturns(200, { slug: 'a-chair', saved: true }, seen) },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ slug: 'a-chair', saved: true });
    expect(seen.value?.url).toBe('https://api.internal.test/v1/sellers/me/listings/a-chair/attributes');
    expect(seen.value?.method).toBe('POST');
    expect(seen.value?.sessionToken).toBe(ACCESS_TOKEN);
    expect(seen.value?.cookie).toBeNull();
    expect(JSON.parse(seen.value?.body ?? '{}')).toEqual({
      answers: [
        { kind: 'number', key: 'width', number: 180 },
        { kind: 'single_select', key: 'material', options: ['oak'] },
      ],
    });
  });

  it('accepts an empty set, which is how a seller clears every answer', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleSellerVocabularyAttributesSave(
      writeRequest('/api/sellers/me/listings/a-chair/attributes', { answers: [] }),
      'listings',
      'a-chair',
      { env: ENV, fetch: apiReturns(200, { slug: 'a-chair', saved: true }, seen) },
    );
    expect(response.status).toBe(200);
    expect(JSON.parse(seen.value?.body ?? '{}')).toEqual({ answers: [] });
  });

  it('never forwards an answer whose shape does not match its own kind', async () => {
    const seen: { value?: Seen } = {};
    for (const answer of [
      { kind: 'number', key: 'width', text: '180' },
      { kind: 'text', key: 'note', number: 1 },
      { kind: 'boolean', key: 'assembled', boolean: 'yes' },
      { kind: 'single_select', key: 'material', options: ['oak', 'pine'] },
      { kind: 'multi_select', key: 'features', options: [] },
      { kind: 'colour', key: 'colour', text: 'red' },
      { key: 'width', number: 180 },
    ]) {
      const response = await handleSellerVocabularyAttributesSave(
        writeRequest('/api/sellers/me/listings/a-chair/attributes', { answers: [answer] }),
        'listings',
        'a-chair',
        { env: ENV, fetch: apiReturns(200, { slug: 'a-chair', saved: true }, seen) },
      );
      expect(response.status, JSON.stringify(answer)).toBe(400);
    }
    expect(seen.value).toBeUndefined();
  });

  it('never forwards the same attribute answered twice', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleSellerVocabularyAttributesSave(
      writeRequest('/api/sellers/me/listings/a-chair/attributes', {
        answers: [
          { kind: 'number', key: 'width', number: 180 },
          { kind: 'number', key: 'width', number: 200 },
        ],
      }),
      'listings',
      'a-chair',
      { env: ENV, fetch: apiReturns(200, { slug: 'a-chair', saved: true }, seen) },
    );
    expect(response.status).toBe(400);
    expect(seen.value).toBeUndefined();
  });

  it('never forwards a field the contract does not name', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleSellerVocabularyAttributesSave(
      writeRequest('/api/sellers/me/listings/a-chair/attributes', {
        answers: [{ kind: 'number', key: 'width', number: 180 }],
        sellerUserId: '11111111-1111-4111-8111-111111111111',
      }),
      'listings',
      'a-chair',
      { env: ENV, fetch: apiReturns(200, { slug: 'a-chair', saved: true }, seen) },
    );
    expect(response.status).toBe(400);
    expect(seen.value).toBeUndefined();
  });

  it('refuses a cross-origin submission before reading its body', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleSellerVocabularyAttributesSave(
      writeRequest(
        '/api/sellers/me/listings/a-chair/attributes',
        { answers: [] },
        { origin: 'https://evil.test' },
      ),
      'listings',
      'a-chair',
      { env: ENV, fetch: apiReturns(200, { slug: 'a-chair', saved: true }, seen) },
    );
    expect(response.status).toBe(403);
    expect(seen.value).toBeUndefined();
  });

  it('needs a session cookie', async () => {
    const request = new Request(`${ORIGIN}/api/sellers/me/listings/a-chair/attributes`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ answers: [] }),
    });
    const response = await handleSellerVocabularyAttributesSave(request, 'listings', 'a-chair', {
      env: ENV,
      fetch: apiUnreachable(),
    });
    expect(response.status).toBe(401);
  });

  it('refuses a malformed slug without an upstream hop', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleSellerVocabularyAttributesSave(
      writeRequest('/api/sellers/me/listings/bad/attributes', { answers: [] }),
      'listings',
      'Not A Slug',
      { env: ENV, fetch: apiReturns(200, { slug: 'x', saved: true }, seen) },
    );
    expect(response.status).toBe(404);
    expect(seen.value).toBeUndefined();
  });

  it('forwards a refused answer with the API’s own code, so a screen can say which rule turned', async () => {
    const response = await handleSellerVocabularyAttributesSave(
      writeRequest('/api/sellers/me/listings/a-chair/attributes', { answers: [] }),
      'listings',
      'a-chair',
      {
        env: ENV,
        fetch: apiReturns(409, { status: 409, code: 'LISTING_ATTRIBUTE_ANSWER_NOT_ALLOWED' }),
      },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'LISTING_ATTRIBUTE_ANSWER_NOT_ALLOWED' });
  });

  it('forwards that a listing is no longer a draft with its own code', async () => {
    const response = await handleSellerVocabularyAttributesSave(
      writeRequest('/api/sellers/me/listings/a-chair/attributes', { answers: [] }),
      'listings',
      'a-chair',
      { env: ENV, fetch: apiReturns(409, { status: 409, code: 'SELLER_LISTING_NOT_EDITABLE' }) },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'SELLER_LISTING_NOT_EDITABLE' });
  });

  it('turns a status nobody expected, and an unreachable API, into one 503', async () => {
    for (const fetcher of [apiReturns(418, { code: 'TEAPOT' }), apiUnreachable()]) {
      const response = await handleSellerVocabularyAttributesSave(
        writeRequest('/api/sellers/me/listings/a-chair/attributes', { answers: [] }),
        'listings',
        'a-chair',
        { env: ENV, fetch: fetcher },
      );
      expect(response.status).toBe(503);
    }
  });

  it('turns a success the contract does not recognise into one 503', async () => {
    const response = await handleSellerVocabularyAttributesSave(
      writeRequest('/api/sellers/me/listings/a-chair/attributes', { answers: [] }),
      'listings',
      'a-chair',
      { env: ENV, fetch: apiReturns(200, { slug: 'a-chair' }) },
    );
    expect(response.status).toBe(503);
  });
});

describe('saving tags', () => {
  it('forwards the validated selection', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleSellerVocabularyTagsSave(
      writeRequest('/api/sellers/me/services/a-service/tags', { tags: ['handmade', 'vintage'] }),
      'services',
      'a-service',
      { env: ENV, fetch: apiReturns(200, { slug: 'a-service', saved: true }, seen) },
    );
    expect(response.status).toBe(200);
    expect(seen.value?.url).toBe('https://api.internal.test/v1/sellers/me/services/a-service/tags');
    expect(JSON.parse(seen.value?.body ?? '{}')).toEqual({ tags: ['handmade', 'vintage'] });
  });

  it('accepts an empty array, which removes every tag', async () => {
    const seen: { value?: Seen } = {};
    const response = await handleSellerVocabularyTagsSave(
      writeRequest('/api/sellers/me/listings/a-chair/tags', { tags: [] }),
      'listings',
      'a-chair',
      { env: ENV, fetch: apiReturns(200, { slug: 'a-chair', saved: true }, seen) },
    );
    expect(response.status).toBe(200);
    expect(JSON.parse(seen.value?.body ?? '{}')).toEqual({ tags: [] });
  });

  it('never forwards a duplicate, a badly shaped slug or anything but an array', async () => {
    const seen: { value?: Seen } = {};
    for (const body of [
      { tags: ['handmade', 'handmade'] },
      { tags: ['Handmade'] },
      { tags: 'handmade' },
      { tags: [{ slug: 'handmade' }] },
      {},
    ]) {
      const response = await handleSellerVocabularyTagsSave(
        writeRequest('/api/sellers/me/listings/a-chair/tags', body),
        'listings',
        'a-chair',
        { env: ENV, fetch: apiReturns(200, { slug: 'a-chair', saved: true }, seen) },
      );
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(seen.value).toBeUndefined();
  });
});
