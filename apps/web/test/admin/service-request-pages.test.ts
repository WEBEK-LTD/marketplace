import type { ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import arMessages from '../../messages/admin/ar.json';
import enMessages from '../../messages/admin/en.json';
import { startBuiltApp, type RunningApp } from '../support/next-server.js';
import { problem, startStubApi, type StubApi } from '../support/stub-api.js';

/**
 * Where the console is mounted (0108). Every address in this file is console-relative, exactly as it was while the
 * console was an application of its own; this is the one place that turns it into the address the server answers.
 */
const CONSOLE = '/admin';

/**
 * The Admin Only service request screens, over real HTTP against the built app — Option 2 (Phase 7-J).
 *
 * Run against the built app rather than a unit harness for the reason 7-F's shell test is: what matters is what
 * actually reaches a browser, **including the streamed RSC payload**.
 *
 * The case this file exists for is the **field-level** one. Three people can reach three different amounts of
 * the same request, and the difference has to be in the document rather than in what a stylesheet hides:
 *
 *   * a colleague without `service_requests.request.read` receives none of it;
 *   * a colleague with that key and not `service_requests.payment_info.read` receives the brief and **no trace
 *     whatsoever of the payment fields** — not the values, not the labels, not the heading, because an empty
 *     "Payment information" box would itself disclose that there is something being withheld;
 *   * a colleague with both receives the two sentences the buyer wrote.
 *
 * Also asserted: no quote, checkout, order or payment control on any of these screens; the one approved closure
 * and nothing else; both languages and the direction that goes with each; and every state — empty, error,
 * not-found, purged and closed.
 *
 * No browser, no Playwright, no live provider, no deployment.
 */

const CANARY_CREDENTIAL = 'test-admin-sr-canary-credential-notreal1234';

const EN = enMessages;
const AR = arMessages;

const ACCESS = '__Host-mp_admin_access=canary-admin-access-token-not-a-real-token';
const REFRESH = '__Host-mp_admin_refresh=canary-admin-refresh-token-not-a-real-tok';
const SESSION = `${ACCESS}; ${REFRESH}`;

const STAFF_ID = '11111111-1111-4111-8111-111111111111';
const REQUEST = 'd5000000-0000-4000-8000-000000000001';

const READ = 'service_requests.request.read';
const MANAGE = 'service_requests.request.manage';
const PAYMENT_INFO = 'service_requests.payment_info.read';

const TITLE = 'Canary Admin Only brief';
const BRIEF = 'A canary brief body, comfortably past ten characters.';
const BUYER_NAME = 'Canary Admin-Only Buyer';
const PAYMENT_METHOD = 'Canary bank transfer at month end';
const PAYMENT_NOTE = 'Canary note about invoicing the company address';

/** A moderator: none of the three keys. */
const MODERATOR_PERMISSIONS = [
  'catalog.listing.read',
  'moderation.report.read',
  'reviews.review.read',
  'sellers.profile.read',
  'users.profile.read',
];

/** Reads the request, and not the payment fields. */
const READ_ONLY_PERMISSIONS = [...MODERATOR_PERMISSIONS, READ].sort();
/** Reads both, and may close. */
const FULL_PERMISSIONS = [...MODERATOR_PERMISSIONS, READ, MANAGE, PAYMENT_INFO].sort();

const QUEUE_ITEM = {
  id: REQUEST,
  status: 'open',
  title: TITLE,
  budgetMinor: '400000',
  currencyCode: 'EGP',
  currencyMinorUnit: 2,
  neededBy: '2026-06-01',
  buyerName: BUYER_NAME,
  hasPaymentNotes: true,
  closedAt: null,
  createdAt: '2026-05-01T09:00:00.000Z',
  updatedAt: '2026-05-01T09:00:00.000Z',
};

const DETAIL = { ...QUEUE_ITEM, brief: BRIEF };

type Who =
  | { kind: 'staff'; permissions: string[]; locale?: 'en' | 'ar' }
  | { kind: 'staff-aal1' }
  | { kind: 'buyer' }
  | { kind: 'unauthenticated' };

interface Serve {
  readonly who: Who;
  /** What the request operations answer. `ok` serves the canary data. */
  readonly data?: 'ok' | 'notFound' | 'unavailable' | 'empty' | 'paged' | 'closed';
  /** What the payment operation answers. Defaults to following the caller's permissions. */
  readonly payment?: 'ok' | 'notFound' | 'unavailable' | 'purged';
}

let api: StubApi;
let app: RunningApp;

beforeAll(async () => {
  api = await startStubApi();
  app = await startBuiltApp({ API_BASE_URL: api.baseUrl, INTERNAL_BFF_CREDENTIAL: CANARY_CREDENTIAL });
}, 180_000);

afterAll(async () => {
  await app.stop();
  await api.stop();
});

function json(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function apiServes(serve: Serve): void {
  api.seen.length = 0;
  api.reply((request, response) => {
    const [path] = request.url.split('?');
    const who = serve.who;

    if (path === '/v1/admin/session') {
      if (who.kind === 'unauthenticated') return problem(response, 401, 'AUTHENTICATION_REQUIRED');
      const base = {
        id: STAFF_ID,
        displayName: 'Nadia',
        localeCode: who.kind === 'staff' ? (who.locale ?? 'en') : 'en',
      };
      if (who.kind === 'buyer') {
        return json(response, {
          session: { ...base, isStaff: false, requiresStepUp: false, roles: [], permissions: [] },
        });
      }
      if (who.kind === 'staff-aal1') {
        return json(response, {
          session: { ...base, isStaff: true, requiresStepUp: true, roles: [], permissions: [] },
        });
      }
      return json(response, {
        session: {
          ...base,
          isStaff: true,
          requiresStepUp: false,
          roles: ['admin'],
          permissions: who.permissions,
        },
      });
    }

    // The payment operation, which the real API refuses without its own key. Modelled the same way here.
    if (path === `/v1/admin/service-requests/${REQUEST}/payment-information`) {
      const held = who.kind === 'staff' && who.permissions.includes(PAYMENT_INFO);
      const mode = serve.payment ?? (held ? 'ok' : 'notFound');
      if (mode === 'notFound') return problem(response, 404, 'NOT_FOUND');
      if (mode === 'unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      if (mode === 'purged') {
        return json(response, {
          paymentInformation: { preferredPaymentMethod: null, paymentNotes: null },
        });
      }
      return json(response, {
        paymentInformation: { preferredPaymentMethod: PAYMENT_METHOD, paymentNotes: PAYMENT_NOTE },
      });
    }

    if (path?.startsWith('/v1/admin/service-requests')) {
      if (serve.data === 'notFound') return problem(response, 404, 'NOT_FOUND');
      if (serve.data === 'unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      if (path === '/v1/admin/service-requests') {
        if (serve.data === 'empty') return json(response, { items: [], nextCursor: null });
        if (serve.data === 'paged') {
          return json(response, { items: [QUEUE_ITEM], nextCursor: 'YXExfGNhbmFyeQ' });
        }
        return json(response, { items: [QUEUE_ITEM], nextCursor: null });
      }
      if (serve.data === 'closed') {
        return json(response, {
          request: { ...DETAIL, status: 'declined', closedAt: '2026-05-03T09:00:00.000Z' },
        });
      }
      return json(response, { request: DETAIL });
    }

    return problem(response, 404, 'NOT_FOUND');
  });
}

async function get(path: string, cookie = SESSION): Promise<{ status: number; html: string }> {
  const response = await fetch(`${app.baseUrl}${CONSOLE}${path}`, {
    redirect: 'manual',
    headers: cookie === '' ? {} : { cookie },
  });
  return { status: response.status, html: await response.text() };
}

const QUEUE_PATH = '/service-requests';
const DETAIL_PATH = `/service-requests/${REQUEST}`;

/** Everything a refused response must not contain, in markup or in flight data. */
const SECRETS = [TITLE, BRIEF, BUYER_NAME, PAYMENT_METHOD, PAYMENT_NOTE];

/* ------------------------------------------------------------------------------------------------ */

describe('who may reach the surface at all', () => {
  it.each([
    ['a visitor with no session', { kind: 'unauthenticated' } as Who, ''],
    ['a buyer', { kind: 'buyer' } as Who, SESSION],
    ['staff who have not reached aal2', { kind: 'staff-aal1' } as Who, SESSION],
    [
      'a moderator at aal2 without the request permission',
      { kind: 'staff', permissions: MODERATOR_PERMISSIONS } as Who,
      SESSION,
    ],
  ])('refuses %s, on the queue and on a request addressed directly', async (_name, who, cookie) => {
    apiServes({ who });

    for (const path of [QUEUE_PATH, DETAIL_PATH]) {
      const { status, html } = await get(path, cookie);
      expect(status, path).toBe(200);
      for (const secret of SECRETS) {
        expect(html, `${path} ${secret}`).not.toContain(secret);
      }
      expect(html, path).not.toContain(EN.ServiceRequests.declineAction);
      expect(html, path).not.toContain(EN.ServiceRequests.paymentHeading);
    }
  });

  it('asks the API about no request on behalf of a refused caller', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR_PERMISSIONS } });
    await get(QUEUE_PATH);
    await get(DETAIL_PATH);
    for (const entry of api.seen) {
      expect(entry.url).not.toContain('/v1/admin/service-requests');
    }
  });

  it('leaks no token, credential or internal address to an authorized caller either', async () => {
    apiServes({ who: { kind: 'staff', permissions: FULL_PERMISSIONS } });
    for (const path of [QUEUE_PATH, DETAIL_PATH]) {
      const { html } = await get(path);
      expect(html, path).not.toContain('canary-admin-access-token');
      expect(html, path).not.toContain(CANARY_CREDENTIAL);
      expect(html, path).not.toContain('/v1/admin/service-requests');
      expect(html, path).not.toContain(api.baseUrl);
    }
  });

  it('names no permission key anywhere in the markup', async () => {
    apiServes({ who: { kind: 'staff', permissions: FULL_PERMISSIONS } });
    for (const path of [QUEUE_PATH, DETAIL_PATH]) {
      const { html } = await get(path);
      for (const key of [READ, MANAGE, PAYMENT_INFO]) {
        expect(html, `${path} ${key}`).not.toContain(key);
      }
    }
  });
});

describe('field-level separation, end to end', () => {
  it('gives a colleague with the request permission the brief and no trace of the payment fields', async () => {
    apiServes({ who: { kind: 'staff', permissions: READ_ONLY_PERMISSIONS } });
    const { html } = await get(DETAIL_PATH);

    // They can read the request.
    expect(html).toContain(TITLE);
    expect(html).toContain(BRIEF);
    expect(html).toContain(BUYER_NAME);

    // And not one trace of the other thing: not the values, not the labels, not the heading.
    expect(html).not.toContain(PAYMENT_METHOD);
    expect(html).not.toContain(PAYMENT_NOTE);
    expect(html).not.toContain(EN.ServiceRequests.paymentHeading);
    expect(html).not.toContain(EN.ServiceRequests.paymentMethod);
    expect(html).not.toContain(EN.ServiceRequests.paymentDescriptiveOnly);
    expect(html).not.toContain('preferredPaymentMethod');
    expect(html).not.toContain('paymentNotes');
  });

  it('gives a colleague with both permissions the two sentences the buyer wrote', async () => {
    apiServes({ who: { kind: 'staff', permissions: FULL_PERMISSIONS } });
    const { html } = await get(DETAIL_PATH);
    expect(html).toContain(EN.ServiceRequests.paymentHeading);
    expect(html).toContain(PAYMENT_METHOD);
    expect(html).toContain(PAYMENT_NOTE);
    expect(html).toContain(EN.ServiceRequests.paymentDescriptiveOnly);
  });

  it('asks for the payment fields only on behalf of somebody who may read them', async () => {
    apiServes({ who: { kind: 'staff', permissions: READ_ONLY_PERMISSIONS } });
    await get(DETAIL_PATH);
    // The read is attempted — the API is the authority, not this console — and its refusal is what removes
    // the section. What must never happen is the value arriving and being hidden.
    const { html } = await get(DETAIL_PATH);
    expect(html).not.toContain(PAYMENT_METHOD);
  });

  it('never carries a payment value on the queue, whatever the caller holds', async () => {
    apiServes({ who: { kind: 'staff', permissions: FULL_PERMISSIONS } });
    const { html } = await get(QUEUE_PATH);
    expect(html).not.toContain(PAYMENT_METHOD);
    expect(html).not.toContain(PAYMENT_NOTE);
    // It says only whether there is a note.
    expect(html).toContain(EN.ServiceRequests.paymentNotesPresent);
  });

  it('says so when the fields have been purged, and leaves the request intact', async () => {
    apiServes({ who: { kind: 'staff', permissions: FULL_PERMISSIONS }, payment: 'purged' });
    const { html } = await get(DETAIL_PATH);
    expect(html).toContain(EN.ServiceRequests.paymentPurged);
    expect(html).toContain(TITLE);
    expect(html).toContain(BRIEF);
    expect(html).not.toContain(PAYMENT_METHOD);
  });

  it('distinguishes "could not read" from "not yours to read"', async () => {
    apiServes({ who: { kind: 'staff', permissions: FULL_PERMISSIONS }, payment: 'unavailable' });
    const outage = await get(DETAIL_PATH);
    expect(outage.html).toContain(EN.ServiceRequests.paymentHeading);
    expect(outage.html).toContain(EN.ServiceRequests.paymentUnavailable);

    apiServes({ who: { kind: 'staff', permissions: FULL_PERMISSIONS }, payment: 'notFound' });
    const refused = await get(DETAIL_PATH);
    expect(refused.html).not.toContain(EN.ServiceRequests.paymentHeading);
  });
});

describe('the one approved action, and nothing else', () => {
  it('offers the closure on an open request', async () => {
    apiServes({ who: { kind: 'staff', permissions: FULL_PERMISSIONS } });
    const { html } = await get(DETAIL_PATH);
    expect(html).toContain(EN.ServiceRequests.declineAction);
  });

  it('offers it on no closed request', async () => {
    apiServes({ who: { kind: 'staff', permissions: FULL_PERMISSIONS }, data: 'closed' });
    const { html } = await get(DETAIL_PATH);
    expect(html).not.toContain(EN.ServiceRequests.declineAction);
    expect(html).toContain(EN.ServiceRequests.status.declined);
  });

  it('offers no quote, checkout, order or payment control anywhere', async () => {
    apiServes({ who: { kind: 'staff', permissions: FULL_PERMISSIONS } });
    for (const path of [QUEUE_PATH, DETAIL_PATH]) {
      const { html } = await get(path);
      for (const word of [
        'Send a quote',
        'Accept quote',
        'Add to cart',
        'Checkout',
        'Pay now',
        'Place order',
        'Refund',
        'Payout',
        'Assign',
        'Route to',
      ]) {
        expect(html, `${path} ${word}`).not.toContain(word);
      }
      expect(html, path).not.toContain('/api/checkout');
      expect(html, path).not.toContain('/api/orders');
    }
  });

  it('says plainly that no seller is involved and nothing is attached', async () => {
    apiServes({ who: { kind: 'staff', permissions: FULL_PERMISSIONS } });
    const { html } = await get(DETAIL_PATH);
    expect(html).toContain(EN.ServiceRequests.noSellerNote);
  });

  it('posts the closure to this origin’s own route', async () => {
    apiServes({ who: { kind: 'staff', permissions: FULL_PERMISSIONS } });
    const { html } = await get(DETAIL_PATH);
    expect(html).not.toContain('api.internal');
    expect(html).not.toContain('/v1/admin');
  });
});

describe('every state renders, in both languages', () => {
  it('renders the empty queue', async () => {
    apiServes({ who: { kind: 'staff', permissions: FULL_PERMISSIONS }, data: 'empty' });
    const { html } = await get(QUEUE_PATH);
    expect(html).toContain(EN.ServiceRequests.emptyTitle);
  });

  it('renders the outage state, and still has a title', async () => {
    apiServes({ who: { kind: 'staff', permissions: FULL_PERMISSIONS }, data: 'unavailable' });
    for (const path of [QUEUE_PATH, DETAIL_PATH]) {
      const { html } = await get(path);
      expect(html, path).toContain(EN.Sections.serviceRequests.title);
      expect(html, path).toContain(EN.Console.unavailableTitle);
    }
  });

  it('renders the not-found state for a request that is not there or not ours', async () => {
    apiServes({ who: { kind: 'staff', permissions: FULL_PERMISSIONS }, data: 'notFound' });
    const { html } = await get(DETAIL_PATH);
    expect(html).toContain(EN.ServiceRequests.notFoundTitle);
    expect(html).not.toContain(BRIEF);
  });

  it('renders the not-found state for an address that is not an identifier, without asking', async () => {
    apiServes({ who: { kind: 'staff', permissions: FULL_PERMISSIONS } });
    const { html } = await get('/service-requests/not-a-uuid');
    expect(html).toContain(EN.ServiceRequests.notFoundTitle);
    for (const entry of api.seen) {
      expect(entry.url).not.toContain('not-a-uuid');
    }
  });

  it('offers an older page only when there is one', async () => {
    apiServes({ who: { kind: 'staff', permissions: FULL_PERMISSIONS }, data: 'paged' });
    expect((await get(QUEUE_PATH)).html).toContain('cursor=YXExfGNhbmFyeQ');
    apiServes({ who: { kind: 'staff', permissions: FULL_PERMISSIONS } });
    expect((await get(QUEUE_PATH)).html).not.toContain('cursor=');
  });

  it('serves Arabic right-to-left, with no /ar prefix, on both screens', async () => {
    apiServes({ who: { kind: 'staff', permissions: FULL_PERMISSIONS, locale: 'ar' } });
    for (const path of [QUEUE_PATH, DETAIL_PATH]) {
      const { status, html } = await get(path);
      expect(status, path).toBe(200);
      expect(html, path).toContain('lang="ar"');
      expect(html, path).toContain('dir="rtl"');
      expect(html, path).toContain(AR.Sections.serviceRequests.title);
    }
  });

  it('serves English left-to-right', async () => {
    apiServes({ who: { kind: 'staff', permissions: FULL_PERMISSIONS } });
    const { html } = await get(QUEUE_PATH);
    expect(html).toContain('lang="en"');
    expect(html).toContain('dir="ltr"');
  });

  it('keeps both screens out of any search index', async () => {
    apiServes({ who: { kind: 'staff', permissions: FULL_PERMISSIONS } });
    for (const path of [QUEUE_PATH, DETAIL_PATH]) {
      const { html } = await get(path);
      expect(html, path).toContain('noindex');
    }
  });

  it('links the section from the console navigation for somebody who holds the key', async () => {
    apiServes({ who: { kind: 'staff', permissions: FULL_PERMISSIONS } });
    const { html } = await get(QUEUE_PATH);
    expect(html).toContain('/service-requests');
  });

  it('shows no such link to a moderator', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR_PERMISSIONS } });
    const { html } = await get('');
    expect(html).not.toContain('href="/admin/service-requests"');
  });
});
