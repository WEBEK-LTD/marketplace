import type { ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import ar from '../messages/ar.json';
import en from '../messages/en.json';
import { startBuiltApp, type RunningApp } from './support/next-server.js';
import { problem, startStubApi, type StubApi } from './support/stub-api.js';

/**
 * `/dashboard/seller/{listings,services}/:slug`, over real HTTP against the built app (Phase 8-C).
 *
 * What this page owes, and what the assertions are about:
 *
 * **A field per kind of answer.** A number gets a number input with its unit, a yes-or-no a checkbox, one-from-a-
 * list a radio group with a "not given" choice, and several-from-a-list checkboxes. A text box for all of them
 * would accept answers the database then refuses, which is a worse way for a seller to find out.
 *
 * **Required is marked and never blocking.** The word is on the field, the page says in a sentence that leaving
 * one blank will not stop a submission, and there is no submission control on this page at all — the one the
 * seller already had is 6-F's, untouched.
 *
 * **Nothing private, ever.** No identifier of an attribute, an option, a definition or a listing, no token and no
 * API address, asserted against the whole document including the RSC payload, which is where a prop passed to a
 * client component actually travels.
 *
 * **A listing that is no longer a draft is read-only, and says so** rather than offering controls the database
 * would refuse.
 *
 * **A failure is not an empty form.** An unavailable API gets the error view, never "this asks for nothing".
 *
 * **Both locales**, with the Arabic copy and `rtl`.
 *
 * No browser, no Playwright, no live provider, no deployment.
 */

// Exactly 43 base64url characters, or the web app's env validation refuses it at startup.
const CANARY_CREDENTIAL = 'test-web-vocabulary-page-canary-not-real-xx';
const ACCESS = '__Host-mp_access=canary-access-token-value-not-a-real-token';
const REFRESH = '__Host-mp_refresh=canary-refresh-token-value-not-a-real-toke';
const SESSION = `${ACCESS}; ${REFRESH}`;
const USER_ID = '11111111-1111-4111-8111-111111111111';
const IDENTITY = { user: { id: USER_ID, displayName: 'Nadia' } };

/** Identifiers the API never sends on this surface. The stub sends them anyway, to prove they cannot pass. */
const PRIVATE_VALUES = {
  definitionId: '99999999-9999-4999-8999-999999999999',
  optionId: '88888888-8888-4888-8888-888888888888',
  listingId: '77777777-7777-4777-8777-777777777777',
} as const;

const ATTRIBUTES = [
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
    ...PRIVATE_VALUES,
  },
  {
    key: 'assembled',
    label: 'Assembled',
    dataType: 'boolean',
    unit: null,
    isRequired: false,
    sortOrder: 2,
    text: null,
    number: null,
    boolean: true,
    options: [],
    choices: [],
  },
  {
    key: 'material',
    label: 'Material',
    dataType: 'single_select',
    unit: null,
    isRequired: false,
    sortOrder: 3,
    text: null,
    number: null,
    boolean: null,
    options: ['oak'],
    choices: [
      { value: 'oak', label: 'Oak' },
      { value: 'pine', label: 'Pine' },
    ],
  },
  {
    key: 'features',
    label: 'Features',
    dataType: 'multi_select',
    unit: null,
    isRequired: false,
    sortOrder: 4,
    text: null,
    number: null,
    boolean: null,
    options: [],
    choices: [
      { value: 'folding', label: 'Folding' },
      { value: 'extendable', label: 'Extendable' },
    ],
  },
  {
    key: 'note',
    label: 'Note',
    dataType: 'text',
    unit: null,
    isRequired: false,
    sortOrder: 5,
    text: 'A short note',
    number: null,
    boolean: null,
    options: [],
    choices: [],
  },
];

const TAGS = [
  { slug: 'handmade', name: 'Handmade', isSelected: true },
  { slug: 'vintage', name: 'Vintage', isSelected: false },
];

type Mode =
  | { readonly kind: 'ok'; readonly isEditable?: boolean; readonly attributes?: unknown[]; readonly tags?: unknown[] }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'unavailable' };

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

function apiServes(mode: Mode = { kind: 'ok' }): void {
  api.reply((request, response) => {
    const path = request.url.split('?')[0] ?? '';
    if (path === '/v1/users/me') return json(response, IDENTITY);

    if (/^\/v1\/sellers\/me\/(listings|services)\/[^/]+\/attributes$/.test(path)) {
      if (mode.kind === 'not_found') return problem(response, 404, 'NOT_FOUND');
      if (mode.kind === 'unauthenticated') return problem(response, 401, 'AUTHENTICATION_REQUIRED');
      if (mode.kind === 'unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      return json(response, {
        attributes: mode.attributes ?? ATTRIBUTES,
        isEditable: mode.isEditable ?? true,
      });
    }

    if (/^\/v1\/sellers\/me\/(listings|services)\/[^/]+\/tags$/.test(path)) {
      if (mode.kind === 'not_found') return problem(response, 404, 'NOT_FOUND');
      if (mode.kind === 'unauthenticated') return problem(response, 401, 'AUTHENTICATION_REQUIRED');
      if (mode.kind === 'unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      return json(response, { tags: mode.tags ?? TAGS, isEditable: mode.isEditable ?? true });
    }

    return problem(response, 404, 'NOT_FOUND');
  });
}

beforeEach(() => {
  api.seen.length = 0;
  apiServes();
});

async function load(
  path: string,
  cookie: string | null = SESSION,
): Promise<{ status: number; location: string | null; html: string }> {
  const response = await fetch(`${app.baseUrl}${path}`, {
    redirect: 'manual',
    headers: cookie === null ? {} : { cookie },
  });
  return {
    status: response.status,
    location: response.headers.get('location'),
    html: await response.text(),
  };
}

/** The form controls the page rendered, by name. */
function controls(html: string): string[] {
  return (html.match(/<input\b[^>]*\sname="([A-Za-z0-9_-]+)"/g) ?? []).map(
    (tag) => /name="([A-Za-z0-9_-]+)"/.exec(tag)?.[1] ?? '',
  );
}

const LISTING_PATH = '/dashboard/seller/listings/a-chair';
const SERVICE_PATH = '/dashboard/seller/services/a-service';

describe('who may open it', () => {
  it('sends a visitor with no session to sign in', async () => {
    const { status, location, html } = await load(LISTING_PATH, null);
    expect(status === 307 || status === 302 || status === 200).toBe(true);
    if (status === 200) {
      for (const leak of ['Width', 'Handmade', 'Oak']) expect(html, leak).not.toContain(leak);
    } else {
      expect(location).toContain('/login');
    }
  });

  it('shows the questions to the listing’s own seller', async () => {
    const { status, html } = await load(LISTING_PATH);
    expect(status).toBe(200);
    expect(html).toContain(en.SellerVocabulary.attributesHeading);
    expect(html).toContain('Width');
    expect(html).toContain('Handmade');
  });

  it('answers that a slug belonging to nobody holds nothing', async () => {
    apiServes({ kind: 'not_found' });
    const { html } = await load(LISTING_PATH);
    expect(html).toContain(en.SellerVocabulary.errorNotFound);
    for (const leak of ['Width', 'Handmade']) expect(html, leak).not.toContain(leak);
  });

  it('shows the error view, never an empty form, when the service is down', async () => {
    apiServes({ kind: 'unavailable' });
    const { html } = await load(LISTING_PATH);
    expect(html).toContain(en.SellerVocabulary.errorUnavailable);
    expect(html).not.toContain(en.SellerVocabulary.noQuestions);
  });
});

describe('the fields', () => {
  it('renders one control per kind of answer', async () => {
    const { html } = await load(LISTING_PATH);
    const names = controls(html);
    expect(names).toContain('attribute-width');
    expect(names).toContain('attribute-assembled');
    expect(names).toContain('attribute-material');
    expect(names).toContain('attribute-features-folding');
    expect(names).toContain('attribute-note');
  });

  it('gives a number a number input with its unit beside it', async () => {
    const { html } = await load(LISTING_PATH);
    expect(html).toMatch(/name="attribute-width"[^>]*type="number"|type="number"[^>]*name="attribute-width"/);
    expect(html).toContain('cm');
  });

  it('gives a list a choice that means no answer, so one can be cleared', async () => {
    const { html } = await load(LISTING_PATH);
    expect(html).toContain(en.SellerVocabulary.noAnswer);
    expect(html).toContain('Oak');
    expect(html).toContain('Pine');
  });

  it('carries the answers the listing already holds', async () => {
    const { html } = await load(LISTING_PATH);
    expect(html).toContain('180');
    expect(html).toContain('A short note');
  });

  it('marks a required field and says it will not block a submission', async () => {
    const { html } = await load(LISTING_PATH);
    expect(html).toContain(en.SellerVocabulary.required);
    expect(html).toContain(en.SellerVocabulary.advisory);
  });

  it('offers no submission control at all, so submission is still 6-F’s', async () => {
    const { html } = await load(LISTING_PATH);
    for (const absent of [en.SellerListings.submit, en.SellerListings.archive]) {
      expect(html, absent).not.toContain(absent);
    }
  });

  it('says a category that asks nothing asks nothing', async () => {
    apiServes({ kind: 'ok', attributes: [] });
    const { html } = await load(LISTING_PATH);
    expect(html).toContain(en.SellerVocabulary.noQuestions);
  });

  it('says there are no tags when there are none', async () => {
    apiServes({ kind: 'ok', tags: [] });
    const { html } = await load(LISTING_PATH);
    expect(html).toContain(en.SellerVocabulary.noTags);
  });
});

describe('a listing that is no longer a draft', () => {
  it('reads the answers out and offers no control', async () => {
    apiServes({ kind: 'ok', isEditable: false });
    const { html } = await load(LISTING_PATH);
    expect(html).toContain(en.SellerVocabulary.notEditable);
    expect(html).toContain('180 cm');
    expect(html).toContain('Oak');
    expect(controls(html).filter((name) => name.startsWith('attribute-'))).toEqual([]);
    for (const absent of [en.SellerVocabulary.save, en.SellerVocabulary.saveTags]) {
      expect(html, absent).not.toContain(absent);
    }
  });
});

describe('the services surface', () => {
  it('serves the same form at the services address', async () => {
    const { status, html } = await load(SERVICE_PATH);
    expect(status).toBe(200);
    expect(html).toContain(en.SellerVocabulary.attributesHeading);
    expect(html).toContain('Width');
  });

  it('asks the API about services, not listings', async () => {
    await load(SERVICE_PATH);
    const asked = api.seen.map((seen) => seen.url);
    expect(asked.some((url) => url.startsWith('/v1/sellers/me/services/a-service/attributes'))).toBe(true);
    expect(asked.some((url) => url.includes('/v1/sellers/me/listings/'))).toBe(false);
  });

  it('posts back to the services address', async () => {
    const { html } = await load(SERVICE_PATH);
    expect(html).toContain('/api/sellers/me/services/a-service');
    expect(html).not.toContain('/api/sellers/me/listings/a-service');
  });
});

describe('what never reaches a browser', () => {
  it('carries no identifier of an attribute, an option or a listing', async () => {
    const { html } = await load(LISTING_PATH);
    for (const leak of Object.values(PRIVATE_VALUES)) {
      expect(html, leak).not.toContain(leak);
    }
  });

  it('carries no token, no credential and no API address', async () => {
    const { html } = await load(LISTING_PATH);
    for (const leak of [CANARY_CREDENTIAL, 'canary-access-token-value-not-a-real-token', api.baseUrl]) {
      expect(html, leak).not.toContain(leak);
    }
  });

  it('presents the session token upstream and never the browser’s cookie', async () => {
    await load(LISTING_PATH);
    const reads = api.seen.filter((seen) => seen.url.startsWith('/v1/sellers/me/'));
    expect(reads.length).toBeGreaterThan(0);
    for (const seen of reads) {
      expect(seen.credential).toBe(CANARY_CREDENTIAL);
      expect(seen.cookie ?? '').not.toContain('mp_access');
    }
  });
});

describe('both languages', () => {
  it('renders the Arabic page right to left with the Arabic copy', async () => {
    const { status, html } = await load(`/ar${LISTING_PATH}`);
    expect(status).toBe(200);
    expect(html).toContain('dir="rtl"');
    expect(html).toContain(ar.SellerVocabulary.attributesHeading);
    expect(html).toContain(ar.SellerVocabulary.advisory);
  });

  it('names no physical direction in a class', async () => {
    const { html } = await load(`/ar${LISTING_PATH}`);
    for (const physical of ['text-left', 'text-right', 'ml-', 'mr-', 'pl-', 'pr-']) {
      // The page's own markup; the framework's runtime scripts are not this page's to police.
      const body = html.split('<script')[0] ?? '';
      expect(body, physical).not.toContain(`class="${physical}`);
    }
  });

  it('asks the API in the locale it is rendering', async () => {
    await load(`/ar${LISTING_PATH}`);
    const asked = api.seen.map((seen) => seen.url);
    expect(asked.some((url) => url.includes('locale=ar'))).toBe(true);
  });
});
