import type { ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import ar from '../messages/ar.json';
import en from '../messages/en.json';
import { startBuiltApp, type RunningApp } from './support/next-server.js';
import { problem, startStubApi, type StubApi } from './support/stub-api.js';

/**
 * `/dashboard/seller/services`, over real HTTP against the built app (Phase 6-G).
 *
 * What this page owes, and what the assertions are about:
 *
 * **Controls exist only where a mutation is permitted**, and a control that is not permitted is *absent*
 * rather than disabled — copy included, because a label shipped for an action the server will never allow is
 * an RSC-payload leak of exactly the kind 6-F caught.
 *
 * **The pricing block is conditional on the pricing model**, so the four fields that hang off it are not in
 * the document until a model is stated. Asserted against the rendered form.
 *
 * **Nothing private, ever.** No identifier — not the seller's, not the listing's, not the category's — no
 * token, no API address, no approval time, no view count, no moderation note and no rejection reason.
 *
 * **A failure is not an empty shop.** An unavailable API gets the error view, never "you have no services".
 *
 * **The amount is displayed through the money package** and the currency's own minor unit, so `9900` at two
 * decimal places reads as `99.00` and nothing is converted.
 *
 * **Both locales, and no physical direction anywhere.**
 *
 * The forms' *behaviour* is tested exactly, as pure functions, in `seller-service-forms.test.ts`.
 *
 * No browser, no Playwright, no live provider, no deployment.
 */

// Exactly 43 base64url characters, or the web app's env validation refuses it at startup.
const CANARY_CREDENTIAL = 'test-web-services-page-canary-not-real-xxxx';
const ACCESS = '__Host-mp_access=canary-access-token-value-not-a-real-token';
const REFRESH = '__Host-mp_refresh=canary-refresh-token-value-not-a-real-toke';
const SESSION = `${ACCESS}; ${REFRESH}`;
const USER_ID = '11111111-1111-4111-8111-111111111111';
const IDENTITY = { user: { id: USER_ID, displayName: 'Nadia' } };

const SELLER = {
  slug: 'svc-shop',
  displayName: 'Service Shop',
  status: 'active',
  verificationStatus: 'verified',
  city: 'Cairo',
  countryCode: 'EG',
};

const SERVICE = {
  slug: 'logo-design',
  title: 'Logo Design',
  description: 'I will design a logo for you.',
  categorySlug: 'design',
  status: 'draft',
  currencyCode: 'EGP',
  currencyMinorUnit: 2,
  priceMinor: '9900',
  isNegotiable: false,
  contentLanguage: 'en',
  countryCode: 'EG',
  governorate: null,
  city: 'Cairo',
  pricingModel: 'fixed',
  deliveryDays: 5,
  revisionsIncluded: 2,
  requiresBrief: true,
  scope: 'Two concepts.',
  mediaCount: 0,
  createdAt: '2026-05-01T10:00:00.000Z',
  updatedAt: '2026-05-02T10:00:00.000Z',
  submittedAt: null,
  archivedAt: null,
};

const at = (status: string, slug: string): Record<string, unknown> => ({ ...SERVICE, status, slug });

/** Values no service contract carries, offered by the stub API anyway. */
const PRIVATE_VALUES = {
  sellerUserId: USER_ID,
  listingId: '99999999-9999-4999-8999-999999999999',
  categoryId: '88888888-8888-4888-8888-888888888888',
  approvedAt: '2026-06-01T00:00:00.000Z',
  viewCount: 4242,
  rejectionReason: 'Prohibited service, internal moderation note',
} as const;

type Mode =
  | {
      readonly kind: 'ok';
      readonly seller?: Record<string, unknown>;
      readonly services?: unknown[];
      readonly nextCursor?: string | null;
    }
  | { readonly kind: 'not_a_seller' }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'services_unavailable' };

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
    if (path === '/v1/sellers/me') {
      if (mode.kind === 'not_a_seller') return problem(response, 404, 'NOT_FOUND');
      if (mode.kind === 'unauthenticated') return problem(response, 401, 'AUTHENTICATION_REQUIRED');
      return json(response, { seller: mode.kind === 'ok' ? (mode.seller ?? SELLER) : SELLER });
    }
    if (path === '/v1/sellers/me/services') {
      if (mode.kind === 'not_a_seller') return problem(response, 404, 'NOT_FOUND');
      if (mode.kind === 'unauthenticated') return problem(response, 401, 'AUTHENTICATION_REQUIRED');
      if (mode.kind === 'services_unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      return json(response, {
        services: mode.services ?? [SERVICE],
        nextCursor: mode.nextCursor ?? null,
      });
    }
    if (path === '/v1/categories') {
      return json(response, {
        categories: [
          {
            id: PRIVATE_VALUES.categoryId,
            slug: 'design',
            name: 'Design',
            children: [
              { id: '77777777-7777-4777-8777-777777777777', slug: 'logos', name: 'Logos', children: [] },
            ],
          },
        ],
      });
    }
    if (path === '/v1/listings') return json(response, { listings: [], nextCursor: null });
    if (path === '/v1/services') return json(response, { services: [], nextCursor: null });
    return problem(response, 404, 'NOT_FOUND');
  });
}

beforeEach(() => {
  api.seen.length = 0;
  apiServes();
});

interface Page {
  readonly status: number;
  readonly location: string | null;
  readonly robotsHeader: string | null;
  readonly html: string;
}

async function load(path: string, cookie: string | null = SESSION): Promise<Page> {
  const response = await fetch(`${app.baseUrl}${path}`, {
    redirect: 'manual',
    headers: cookie === null ? {} : { cookie },
  });
  return {
    status: response.status,
    location: response.headers.get('location'),
    robotsHeader: response.headers.get('x-robots-tag'),
    html: await response.text(),
  };
}

/** The form controls the page rendered, by name. */
function controls(html: string): string[] {
  return (html.match(/<(?:input|select|textarea)\b[^>]*\sname="([A-Za-z]+)"/g) ?? []).map(
    (tag) => /name="([A-Za-z]+)"/.exec(tag)?.[1] ?? '',
  );
}

describe('protection', () => {
  it('redirects a signed-out visitor into the existing login flow', async () => {
    const page = await load('/dashboard/seller/services', null);

    expect(page.status).toBe(307);
    expect(page.location).toContain('/login');
    expect(page.robotsHeader).toBe('noindex');
  });

  it('redirects to the Arabic sign-in under /ar', async () => {
    const page = await load('/ar/dashboard/seller/services', null);

    expect(page.status).toBe(307);
    expect(page.location).toContain('/ar/login');
  });

  it('gives a signed-out visitor no service at all, payload included', async () => {
    const page = await load('/dashboard/seller/services', null);

    for (const absent of ['Logo Design', 'logo-design', 'Create a service draft', 'name="slug"', 'design']) {
      expect(page.html, absent).not.toContain(absent);
    }
  });

  it('shows 5-A’s own signed-out view when the session gate itself is refused', async () => {
    api.reply((request, response) => {
      const path = request.url.split('?')[0] ?? '';
      if (path === '/v1/users/me') return problem(response, 401, 'AUTHENTICATION_REQUIRED');
      return json(response, { services: [SERVICE], nextCursor: null });
    });
    const page = await load('/dashboard/seller/services');

    expect(page.status).toBe(200);
    expect(page.html).toContain(en.Session.expiredTitle);
    expect(page.html).not.toContain('Create a service draft');
    expect(page.html).not.toContain('Logo Design');
  });

  it('shows the session-ended view when the session lapses between the gate and the read', async () => {
    apiServes({ kind: 'unauthenticated' });
    const page = await load('/dashboard/seller/services');

    expect(page.status).toBe(200);
    expect(page.html).toContain(en.Session.expiredBody);
    expect(page.html).not.toContain('Create a service draft');
  });

  it('is never indexable', async () => {
    const page = await load('/dashboard/seller/services');
    expect(page.html).toContain('noindex');
  });
});

describe('the services index', () => {
  it('shows a service’s own facts, named by slug and never by an identifier', async () => {
    const page = await load('/dashboard/seller/services');

    expect(page.status).toBe(200);
    expect(page.html).toContain('Logo Design');
    expect(page.html).toContain('logo-design');
    expect(page.html).toContain('design');
    expect(page.html).toContain('Draft');
  });

  it('formats the amount through the money package and the currency’s own minor unit', async () => {
    const page = await load('/dashboard/seller/services');
    // 9900 minor units at two decimal places. Never converted, never re-denominated.
    expect(page.html).toContain('EGP 99.00');
  });

  it('shows the detail fields a service has stated', async () => {
    const page = await load('/dashboard/seller/services');

    expect(page.html).toContain(en.SellerServices.pricingFixed);
    expect(page.html).toContain(en.SellerServices.deliveryDays);
    expect(page.html).toContain(en.SellerServices.revisions);
  });

  it('says a service has stated nothing about pricing rather than inventing a default', async () => {
    apiServes({
      kind: 'ok',
      services: [
        {
          ...SERVICE,
          pricingModel: null,
          deliveryDays: null,
          revisionsIncluded: null,
          requiresBrief: null,
          scope: null,
        },
      ],
    });
    const page = await load('/dashboard/seller/services');

    expect(page.html).toContain(en.SellerServices.noPricing);
    expect(page.html).toContain(en.SellerServices.noDelivery);
  });

  it('ships no edit-form copy for a service whose state offers no edit', async () => {
    // A sold service offers nothing, so its edit label group is withheld on the server. `save`, `saving` and
    // `saved` belong to that group alone — the create form has its own words — so their absence is the RSC
    // narrowing observed where it is actually observable.
    apiServes({ kind: 'ok', services: [at('sold', 'sold-service')] });
    const sold = await load('/dashboard/seller/services');

    for (const copy of [en.SellerServices.save, en.SellerServices.saving, en.SellerServices.saved]) {
      expect(sold.html, copy).not.toContain(copy);
    }

    // And a draft, which does offer an edit, ships them.
    apiServes();
    const draft = await load('/dashboard/seller/services');
    expect(draft.html).toContain(en.SellerServices.save);
  });

  it('says so plainly when there is nothing yet', async () => {
    apiServes({ kind: 'ok', services: [] });
    const page = await load('/dashboard/seller/services');

    expect(page.html).toContain(en.SellerServices.empty);
    expect(page.html).not.toContain('Logo Design');
  });

  it('reports a media count rather than any object path', async () => {
    apiServes({ kind: 'ok', services: [{ ...SERVICE, mediaCount: 3 }] });
    const page = await load('/dashboard/seller/services');

    expect(page.html).toContain(en.SellerServices.mediaCount);
    expect(page.html).not.toContain('objectPath');
    expect(page.html).not.toContain('seller-media/');
  });

  it('offers the next page as an ordinary link carrying the opaque cursor', async () => {
    apiServes({ kind: 'ok', nextCursor: 'b3BhcXVl' });
    const page = await load('/dashboard/seller/services');

    expect(page.html).toContain(en.SellerServices.nextPage);
    expect(page.html).toContain('cursor=b3BhcXVl');
  });

  it('sends a caller with no storefront to the seller landing page', async () => {
    apiServes({ kind: 'not_a_seller' });
    const page = await load('/dashboard/seller/services');

    expect(page.status).toBe(200);
    expect(page.html).toContain(en.SellerDashboard.notASeller);
    expect(page.html).not.toContain('Create a service draft');
    expect(controls(page.html)).toEqual([]);
  });

  it('shows the error view rather than an empty shop when the service cannot answer', async () => {
    apiServes({ kind: 'services_unavailable' });
    const page = await load('/dashboard/seller/services');

    expect(page.status).toBe(200);
    expect(page.html).toContain(en.SellerServices.errorUnavailable);
    expect(page.html).not.toContain(en.SellerServices.empty);
  });
});

describe('which actions each state offers', () => {
  it('offers a draft both editing and submission, and no archive', async () => {
    const page = await load('/dashboard/seller/services');

    expect(page.html).toContain(en.SellerServices.edit);
    expect(page.html).toContain(en.SellerServices.submit);
    expect(page.html).not.toContain(en.SellerServices.archive);
  });

  it.each([
    ['approved', 'approved-service'],
    ['active', 'active-service'],
  ])('offers a %s service archival only', async (status, slug) => {
    apiServes({ kind: 'ok', services: [at(status, slug)] });
    const page = await load('/dashboard/seller/services');

    expect(page.html).toContain(en.SellerServices.archive);
    expect(page.html).not.toContain(en.SellerServices.edit);
    expect(page.html).not.toContain(en.SellerServices.submit);
  });

  it('offers a submitted service nothing, and says why', async () => {
    apiServes({ kind: 'ok', services: [at('pending_review', 'submitted-service')] });
    const page = await load('/dashboard/seller/services');

    expect(page.html).toContain(en.SellerServices.awaitingReview);
    expect(page.html).not.toContain(en.SellerServices.edit);
    expect(page.html).not.toContain(en.SellerServices.submit);
    expect(page.html).not.toContain(en.SellerServices.archive);
  });

  it.each(['sold', 'expired', 'archived', 'rejected', 'suspended'])(
    'offers a %s service no action at all',
    async (status) => {
      apiServes({ kind: 'ok', services: [at(status, `${status}-service`)] });
      const page = await load('/dashboard/seller/services');

      for (const action of [
        en.SellerServices.edit,
        en.SellerServices.submit,
        en.SellerServices.archive,
      ]) {
        expect(page.html, action).not.toContain(action);
      }
    },
  );

  it('offers nothing anywhere on the page that deletes a service', async () => {
    apiServes({
      kind: 'ok',
      services: [SERVICE, at('active', 'active-service'), at('rejected', 'rejected-service')],
    });
    const page = await load('/dashboard/seller/services');
    const lower = page.html.toLowerCase();

    for (const word of ['delete', 'remove service', 'method="delete"']) {
      expect(lower, word).not.toContain(word);
    }
  });

  it('confirms before submitting and before archiving, naming what will happen', async () => {
    apiServes({ kind: 'ok', services: [SERVICE, at('active', 'active-service')] });
    const page = await load('/dashboard/seller/services');

    expect(page.html).toContain(en.SellerServices.submitConfirm);
    expect(page.html).toContain(en.SellerServices.archiveConfirm);
  });
});

describe('a storefront that may not mutate', () => {
  it.each(['suspended', 'closed'])('gives a %s storefront its services and no controls at all', async (status) => {
    apiServes({ kind: 'ok', seller: { ...SELLER, status } });
    const page = await load('/dashboard/seller/services');

    // Reading one's own rows is not a mutation, so the services are still there.
    expect(page.html).toContain('Logo Design');
    expect(page.html).toContain(en.SellerServices.notEditable);
    expect(page.html).not.toContain('Create a service draft');
    expect(page.html).not.toContain(en.SellerServices.edit);
    expect(page.html).not.toContain(en.SellerServices.submit);
    expect(page.html).not.toContain(en.SellerServices.archive);
    expect(controls(page.html)).toEqual([]);
  });

  it('never names the reason a storefront is suspended', async () => {
    apiServes({
      kind: 'ok',
      seller: { ...SELLER, status: 'suspended', suspensionReason: 'Repeated policy breaches, internal note' },
    });
    const page = await load('/dashboard/seller/services');

    expect(page.html).not.toContain('Repeated policy breaches');
    expect(page.html).not.toContain('internal note');
  });

  it('gives a pending storefront the full set, because pending may mutate', async () => {
    apiServes({ kind: 'ok', seller: { ...SELLER, status: 'pending', verificationStatus: 'unverified' } });
    const page = await load('/dashboard/seller/services');

    expect(page.html).toContain('Create a service draft');
    expect(page.html).toContain(en.SellerServices.edit);
  });
});

describe('the create form', () => {
  it('renders the fields a service draft needs, and no status, type or identifier among them', async () => {
    const page = await load('/dashboard/seller/services');
    const names = controls(page.html);

    for (const field of [
      'slug',
      'title',
      'description',
      'categorySlug',
      'contentLanguage',
      'currencyCode',
      'countryCode',
      'priceMinor',
      'isNegotiable',
      'governorate',
      'city',
      'pricingModel',
    ]) {
      expect(names, field).toContain(field);
    }
    for (const field of ['status', 'listingTypeCode', 'sellerUserId', 'userId', 'id', 'categoryId']) {
      expect(names, field).not.toContain(field);
    }
  });

  it('hides the four fields that hang off the pricing model until one is stated', async () => {
    const page = await load('/dashboard/seller/services');
    const names = controls(page.html);

    // The create form starts with no model stated, so none of the four is in the document — which is also
    // exactly what the database would refuse if they were sent. The model itself is there to be chosen.
    expect(names).toContain('pricingModel');
    for (const field of ['deliveryDays', 'revisionsIncluded', 'requiresBrief', 'scope']) {
      expect(names, field).not.toContain(field);
    }
    expect(page.html).toContain(en.SellerServices.pricingUnset);
  });

  it('offers no file input: 6-G is not a service-media subsystem', async () => {
    const page = await load('/dashboard/seller/services');
    expect(page.html).not.toContain('type="file"');
  });

  it('names categories by slug, and carries none of the tree’s identifiers', async () => {
    const page = await load('/dashboard/seller/services');

    expect(page.html).toContain('Design');
    expect(page.html).toContain('value="design"');
    expect(page.html).not.toContain(PRIVATE_VALUES.categoryId);
    expect(page.html).not.toContain('77777777-7777-4777-8777-777777777777');
  });

  it('says the service address is permanent, because it is', async () => {
    const page = await load('/dashboard/seller/services');
    expect(page.html).toContain(en.SellerServices.slugPermanent);
  });

  it('asks for a currency code rather than naming one when the seller has no services yet', async () => {
    apiServes({ kind: 'ok', services: [] });
    const page = await load('/dashboard/seller/services');

    expect(page.html).toContain(en.SellerServices.currencyHint);
    expect(controls(page.html)).toContain('currencyCode');
  });
});

describe('what never reaches the browser', () => {
  it('carries no identifier, timestamp or moderation detail the API offered', async () => {
    api.reply((request, response) => {
      const path = request.url.split('?')[0] ?? '';
      if (path === '/v1/users/me') return json(response, IDENTITY);
      if (path === '/v1/sellers/me') return json(response, { seller: { ...SELLER, ...PRIVATE_VALUES } });
      if (path === '/v1/sellers/me/services') {
        return json(response, { services: [{ ...SERVICE, ...PRIVATE_VALUES }], nextCursor: null });
      }
      if (path === '/v1/categories') return json(response, { categories: [] });
      return problem(response, 404, 'NOT_FOUND');
    });

    const page = await load('/dashboard/seller/services');

    for (const value of Object.values(PRIVATE_VALUES)) {
      expect(page.html, String(value)).not.toContain(String(value));
    }
  });

  it('carries no session token, no internal credential and no API address', async () => {
    const page = await load('/dashboard/seller/services');

    expect(page.html).not.toContain('canary-access-token');
    expect(page.html).not.toContain('canary-refresh-token');
    expect(page.html).not.toContain(CANARY_CREDENTIAL);
    expect(page.html).not.toContain(api.baseUrl);
    expect(page.html).not.toContain(USER_ID);
  });

  it('exposes no internal route: the browser only ever sees this origin’s own paths', async () => {
    const page = await load('/dashboard/seller/services');
    expect(page.html).not.toContain('/v1/sellers/me/services');
  });
});

describe('both locales', () => {
  it('renders the Arabic page in Arabic, right to left', async () => {
    const page = await load('/ar/dashboard/seller/services');

    expect(page.status).toBe(200);
    expect(page.html).toContain('dir="rtl"');
    expect(page.html).toContain(ar.SellerServices.title);
    expect(page.html).toContain(ar.SellerServices.create);
    expect(page.html).not.toContain(en.SellerServices.create);
  });

  it('carries the same keys in both message files, so neither page can fall back silently', () => {
    expect(Object.keys(ar.SellerServices).sort()).toEqual(Object.keys(en.SellerServices).sort());
    for (const [key, value] of Object.entries(ar.SellerServices)) {
      expect(typeof value, key).toBe('string');
      expect(String(value).trim(), key).not.toBe('');
    }
  });

  it('adds no marketing claim to either', () => {
    const copy = `${Object.values(en.SellerServices).join(' ')} ${Object.values(ar.SellerServices).join(' ')}`;
    for (const claim of ['free', 'best', 'fastest', 'guarantee', 'no fees', 'مجاناً', 'الأفضل']) {
      expect(copy.toLowerCase(), claim).not.toContain(claim.toLowerCase());
    }
  });

  it('links the services from the seller navigation in both locales', async () => {
    const english = await load('/dashboard/seller/listings');
    expect(english.html).toContain('/dashboard/seller/services');

    const arabic = await load('/ar/dashboard/seller/services');
    expect(arabic.html).toContain('/ar/dashboard/seller/services');
  });
});

describe('direction is logical, not physical', () => {
  it('uses no left/right utility in any of the service components', async () => {
    const { readFileSync } = await import('node:fs');
    const sources = [
      'src/components/seller-service-create-form.tsx',
      'src/components/seller-service-row.tsx',
      'src/app/[locale]/dashboard/seller/services/page.tsx',
    ]
      .map((path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'))
      .join('\n');

    expect(sources).not.toMatch(/\b(ml|mr|pl|pr)-\d|\btext-(left|right)\b|\b(left|right)-\d/);
  });
});
