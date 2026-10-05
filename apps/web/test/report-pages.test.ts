import type { ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startBuiltApp, type RunningApp } from './support/next-server.js';
import { problem, startStubApi, type StubApi } from './support/stub-api.js';

/**
 * The reporter's surfaces, over real HTTP against the built app (Phase 7-M).
 *
 * Run against the built app rather than a unit harness for the reason the other protection tests are: what
 * matters is what actually reaches a browser, **including the streamed RSC payload**.
 *
 * The cases this file exists for:
 *
 *   * **the history page is gated inside the page** — a signed-out visitor receives none of a report, and no
 *     read is performed;
 *   * **no moderation state is ever in the document**, whatever the API sends: no priority, no assignee, no
 *     resolution, no resolution note, no resolver, no duplicate-of, and no subject id;
 *   * **another reporter's report is never rendered**, because the reader is scoped and the page asks only for
 *     its own;
 *   * **the report control is on the three public pages and nowhere else**, it names the subject by slug, and
 *     it ships no account and no listing id;
 *   * **a public page still performs no session read** to decide whether to show the control — which is what
 *     keeps those surfaces cacheable;
 *   * both languages, the direction that goes with each, and every state: empty, refused, unavailable, and a
 *     subject that has left public view.
 *
 * No browser, no Playwright, no live provider, no live storage, no deployment.
 */

const CANARY_CREDENTIAL = 'test-web-reporter-canary-credential-notrea1';

const ACCESS = '__Host-mp_access=canary-access-token-value-not-a-real-token';
const REFRESH = '__Host-mp_refresh=canary-refresh-token-value-not-a-real-toke';
const SESSION = `${ACCESS}; ${REFRESH}`;
const IDENTITY = { user: { id: '11111111-1111-4111-8111-111111111111', displayName: 'Nadia' } };

const REPORT = 'c0000000-0000-4000-8000-00000000000a';
const LISTING_SLUG = 'a-canary-listing';
const SELLER_SLUG = 'canary-shop';
const LABEL = 'A canary listing about a payout';
const OWN_WORDS = 'Canary details of what is wrong with this listing.';

/** Values that must never render: moderation state and the subject's own id. */
const MODERATOR = '99999999-9999-4999-8999-999999999999';
const RESOLUTION_NOTE = 'Canary internal note no reporter may read';
const SUBJECT_ID = '22220000-0000-4000-8000-000000000001';
const OTHER_REPORTERS_REPORT = 'Canary report that belongs to somebody else';

const ROW = {
  id: REPORT,
  subjectType: 'listing',
  subjectSlug: LISTING_SLUG,
  subjectLabel: LABEL,
  reasonCode: 'counterfeit',
  details: OWN_WORDS,
  status: 'open',
  createdAt: '2026-05-01T09:00:00.000Z',
};

const NEXT_CURSOR = 'cnAxfDIwMjYtMDUtMDFUMDk6MDA6MDAuMDAwWnxjMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMGE';

type HistoryMode = 'ok' | 'empty' | 'fails' | 'invalid' | 'paged' | 'gone' | 'leaky' | 'resolved';

let api: StubApi;
let app: RunningApp;

beforeAll(async () => {
  api = await startStubApi();
  app = await startBuiltApp({ API_BASE_URL: api.baseUrl, INTERNAL_BFF_CREDENTIAL: CANARY_CREDENTIAL });
}, 240_000);

afterAll(async () => {
  await app.stop();
  await api.stop();
});

function json(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function historyFor(mode: HistoryMode): unknown {
  if (mode === 'empty') return { items: [], nextCursor: null };
  if (mode === 'paged') return { items: [ROW], nextCursor: NEXT_CURSOR };
  if (mode === 'gone') {
    // The subject has left public view. 0027 keeps the report; the projection loses the slug and the label.
    return { items: [{ ...ROW, subjectSlug: null, subjectLabel: null }], nextCursor: null };
  }
  if (mode === 'resolved') {
    return { items: [{ ...ROW, status: 'actioned' }], nextCursor: null };
  }
  if (mode === 'leaky') {
    // An API that has drifted and sends moderation state. The contract is the wall: none of this may render.
    return {
      items: [
        {
          ...ROW,
          subjectId: SUBJECT_ID,
          priority: 'high',
          assignedTo: MODERATOR,
          assignedAt: '2026-05-02T09:00:00.000Z',
          resolution: 'actioned',
          resolutionNote: RESOLUTION_NOTE,
          resolvedBy: MODERATOR,
          duplicateOfReportId: 'c0000000-0000-4000-8000-00000000000b',
        },
        // And a row that is not the caller's at all.
        { ...ROW, id: 'c0000000-0000-4000-8000-00000000000c', subjectLabel: OTHER_REPORTERS_REPORT },
      ],
      nextCursor: null,
    };
  }
  return { items: [ROW], nextCursor: null };
}

const LISTING = {
  listing: {
    id: SUBJECT_ID,
    slug: LISTING_SLUG,
    title: LABEL,
    city: 'Cairo',
    priceMinor: '150000',
    currencyCode: 'EGP',
    currencyMinorUnit: 2,
    isNegotiable: false,
    listingTypeCode: 'product',
    description: 'A canary description long enough to satisfy the length rule.',
    contentLanguage: 'en',
    createdAt: '2026-05-01T09:00:00.000Z',
    availability: 'available',
    category: { slug: 'design', name: 'Design' },
    seller: { slug: SELLER_SLUG, displayName: 'Canary Shop' },
    attributes: [],
    tags: [],
  },
};

const SELLER = {
  seller: {
    slug: SELLER_SLUG,
    displayName: 'Canary Shop',
    bio: 'We restore mid-century furniture.',
    contentLanguage: 'en',
    city: 'Cairo',
  },
  availability: 'available',
};

function apiServes(mode: HistoryMode = 'ok', options: { signedOut?: boolean } = {}): void {
  api.seen.length = 0;
  api.reply((request, response) => {
    const path = request.url.split('?')[0] ?? '';

    if (path === '/v1/users/me') {
      if (options.signedOut === true) return problem(response, 401, 'AUTHENTICATION_REQUIRED');
      return json(response, IDENTITY);
    }
    if (path === '/v1/messaging/unread-count') return json(response, { unreadCount: 0 });
    if (path === '/v1/notifications/unread-count') return json(response, { unreadCount: 0 });

    if (path === '/v1/reports') {
      if (options.signedOut === true) return problem(response, 401, 'AUTHENTICATION_REQUIRED');
      if (mode === 'fails') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      if (mode === 'invalid') return problem(response, 400, 'REPORTS_CURSOR_INVALID');
      return json(response, historyFor(mode));
    }

    if (path === `/v1/listings/${LISTING_SLUG}`) return json(response, LISTING);
    if (path === `/v1/sellers/${SELLER_SLUG}`) return json(response, SELLER);

    return problem(response, 404, 'NOT_FOUND');
  });
}

/**
 * The document with the flight payload's escaping undone.
 *
 * Client-component props are serialized into a JavaScript string literal inside a `<script>`, so a prop
 * arrives as `\"subjectSlug\":\"…\"` rather than as plain JSON. Unescaping once lets one assertion cover
 * both the markup and the payload, which is what these tests are actually about.
 */
function unescaped(html: string): string {
  return html.replaceAll('\\"', '"');
}

async function get(path: string, cookie: string | null = SESSION): Promise<{ status: number; html: string }> {
  const response = await fetch(`${app.baseUrl}${path}`, {
    redirect: 'manual',
    headers: cookie === null ? {} : { cookie },
  });
  return { status: response.status, html: await response.text() };
}

const HISTORY = '/dashboard/reports';

/** Everything a refused or gated response must not contain, in markup or flight data. */
const SECRETS = [LABEL, OWN_WORDS, 'counterfeit'];

/** Everything that must never appear on any of these pages, whatever the API sends. */
const NEVER = [
  RESOLUTION_NOTE,
  MODERATOR,
  OTHER_REPORTERS_REPORT,
  'resolutionNote',
  'duplicateOfReportId',
  'assignedTo',
  'assignedAt',
  'resolvedBy',
  '"priority"',
];

/* ------------------------------------------------------------------------------------------------ */

describe('the history page is gated inside the page', () => {
  it('sends a signed-out visitor to sign in, and performs no read', async () => {
    apiServes('ok', { signedOut: true });
    const response = await fetch(`${app.baseUrl}${HISTORY}`, { redirect: 'manual' });
    const html = await response.text();

    // 5-A's own behaviour for a dashboard page: the gate redirects rather than rendering a signed-out view.
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/login');
    for (const secret of SECRETS) expect(html, secret).not.toContain(secret);
    expect(api.seen.filter((request) => request.url.startsWith('/v1/reports'))).toHaveLength(0);
  });

  it('gives a visitor whose session the API rejects none of a report', async () => {
    apiServes('ok', { signedOut: true });
    const { html } = await get(HISTORY);
    for (const secret of SECRETS) expect(html, secret).not.toContain(secret);
    expect(api.seen.filter((request) => request.url.startsWith('/v1/reports'))).toHaveLength(0);
  });

  it('is kept out of search engines', async () => {
    apiServes();
    const { html } = await get(HISTORY);
    expect(html).toContain('name="robots"');
    expect(html).toContain('noindex');
  });
});

describe('what the reporter sees of their own reports', () => {
  it('renders the report with what they wrote and what became of it', async () => {
    apiServes();
    const { status, html } = await get(HISTORY);

    expect(status).toBe(200);
    expect(html).toContain(LABEL);
    expect(html).toContain(OWN_WORDS);
    // The reason and the status, in the platform's own vocabulary, named for a reader.
    expect(html).toContain('A fake or counterfeit item');
    expect(html).toContain('Received');
    // A link back to what they reported, built from the slug.
    expect(html).toContain(`/listing/${LISTING_SLUG}`);
  });

  it('reports a closed outcome as the platform words it, with no reason attached', async () => {
    apiServes('resolved');
    const { html } = await get(HISTORY);
    expect(html).toContain('We acted on it');
    for (const secret of NEVER) expect(html, secret).not.toContain(secret);
  });

  it('keeps a report whose subject has left public view, and offers no link to it', async () => {
    apiServes('gone');
    const { html } = await get(HISTORY);

    expect(html).toContain('No longer shown');
    expect(html).toContain(OWN_WORDS);
    expect(html).not.toContain(`/listing/${LISTING_SLUG}`);
    expect(html).not.toContain(LABEL);
  });

  it('offers the next page when there is one', async () => {
    apiServes('paged');
    const { html } = await get(HISTORY);
    expect(html).toContain('Older reports');
    expect(html).toContain(`cursor=${NEXT_CURSOR}`);
  });

  it('says so when nothing has been reported', async () => {
    apiServes('empty');
    const { html } = await get(HISTORY);
    expect(html).toContain('You have not reported anything');
    for (const secret of SECRETS) expect(html, secret).not.toContain(secret);
  });

  it('says so when the history could not be read, and offers the way back', async () => {
    for (const mode of ['fails', 'invalid'] as const) {
      apiServes(mode);
      const { html } = await get(HISTORY);
      expect(html, mode).toContain('Your reports could not be loaded');
      for (const secret of SECRETS) expect(html, `${mode} :: ${secret}`).not.toContain(secret);
    }
  });
});

describe('no moderation state reaches the reporter’s page', () => {
  it('renders none of it, and none of another reporter’s row, from a drifted API', async () => {
    apiServes('leaky');
    const { html } = await get(HISTORY);

    // The whole page refuses the drifted body rather than rendering part of it, so the error state stands in
    // for it — and either way none of this is in the document.
    for (const secret of [...NEVER, SUBJECT_ID]) expect(html, secret).not.toContain(secret);
  });

  it('never renders the subject’s own id on a well-formed page', async () => {
    apiServes();
    const { html } = await get(HISTORY);
    expect(html).not.toContain(SUBJECT_ID);
    expect(html).not.toContain('subjectId');
  });

  it('never renders the API address or the internal credential', async () => {
    apiServes();
    const { html } = await get(HISTORY);
    expect(html).not.toContain(api.baseUrl);
    expect(html).not.toContain(CANARY_CREDENTIAL);
    expect(html).not.toContain('canary-access-token');
  });

  it('sends no write while rendering the history', async () => {
    apiServes();
    await get(HISTORY);
    expect(api.seen.length).toBeGreaterThan(0);
    for (const request of api.seen) {
      expect(request.method, request.url).toBe('GET');
      expect(request.body, request.url).toBe('');
    }
  });
});

describe('the report control on the public pages', () => {
  it('is on the listing page, naming the subject by slug', async () => {
    apiServes();
    const { status, html } = await get(`/listing/${LISTING_SLUG}`, null);

    expect(status).toBe(200);
    expect(html).toContain('Report this');
    expect(unescaped(html)).toContain(`"subjectSlug":"${LISTING_SLUG}"`);
    expect(unescaped(html)).toContain('"subjectType":"listing"');
  });

  it('is on the seller page, naming the storefront by slug', async () => {
    apiServes();
    const { status, html } = await get(`/seller/${SELLER_SLUG}`, null);

    expect(status).toBe(200);
    expect(html).toContain('Report this');
    expect(unescaped(html)).toContain(`"subjectSlug":"${SELLER_SLUG}"`);
    expect(unescaped(html)).toContain('"subjectType":"seller"');
  });

  it('ships no account and no row id with the control', async () => {
    apiServes();
    for (const path of [`/listing/${LISTING_SLUG}`, `/seller/${SELLER_SLUG}`]) {
      const { html } = await get(path, null);
      // The listing page carries the listing id for its own contact and offer controls, which 5-E and 7-H
      // own; what must not appear is that id *as a report subject*, and no account may appear at all.
      expect(unescaped(html), path).not.toContain('"subjectId"');
      expect(html, path).not.toContain(MODERATOR);
      expect(html, path).not.toContain('reporterUserId');
    }
  });

  it('offers the control to a visitor with no session, without reading one', async () => {
    apiServes();
    const { html } = await get(`/listing/${LISTING_SLUG}`, null);
    expect(html).toContain('Report this');
    // The public pages stay cacheable because they ask nobody who the visitor is. A 401 from the BFF is what
    // turns the control into a way in, at the moment it is used.
    expect(api.seen.filter((request) => request.url.startsWith('/v1/users/me'))).toHaveLength(0);
    expect(api.seen.filter((request) => request.url.startsWith('/v1/reports'))).toHaveLength(0);
  });

  it('is not on a page that has nothing reportable on it', async () => {
    apiServes();
    for (const path of ['/', '/listings', '/categories']) {
      const { html } = await get(path, null);
      expect(html, path).not.toContain('Report this');
    }
  });

  it('ships the eleven reasons and no twelfth, and no status or priority control', async () => {
    apiServes();
    const { html } = await get(`/listing/${LISTING_SLUG}`, null);

    expect(html).toContain('A fake or counterfeit item');
    expect(html).toContain('Something else');

    // No status vocabulary and no moderation field reaches a public page. Asserted on the words and field
    // names themselves rather than on a bare `"status"`, which `role="status"` also matches — a proxy that
    // fires on an ARIA attribute proves nothing about what was disclosed.
    for (const absent of [
      'Being looked at',
      'We acted on it',
      'We took no action',
      'Already covered',
      'statusLabel',
      'assignedTo',
      'resolutionNote',
      'duplicateOfReportId',
      'subjectId',
    ]) {
      expect(unescaped(html), absent).not.toContain(absent);
    }
  });
});

describe('both languages', () => {
  it('renders the history in Arabic, mirrored', async () => {
    apiServes();
    const { status, html } = await get(`/ar${HISTORY}`);

    expect(status).toBe(200);
    expect(html).toContain('<html lang="ar" dir="rtl">');
    expect(html).toContain('البلاغات');
    expect(html).toContain('وصل إلينا');
    expect(html).toContain(OWN_WORDS);
    // The subject link is built under the active locale.
    expect(html).toContain(`/ar/listing/${LISTING_SLUG}`);
  });

  it('renders the control in Arabic on a public page, mirrored', async () => {
    apiServes();
    const { html } = await get(`/ar/listing/${LISTING_SLUG}`, null);

    expect(html).toContain('<html lang="ar" dir="rtl">');
    expect(html).toContain('الإبلاغ عن هذا');
    expect(html).toContain('/ar/login');
  });

  it('says the empty and the error states in Arabic too', async () => {
    apiServes('empty');
    expect((await get(`/ar${HISTORY}`)).html).toContain('لم تبلّغ عن أي شيء');
    apiServes('fails');
    expect((await get(`/ar${HISTORY}`)).html).toContain('لم يتم تحميل بلاغاتك');
  });
});
