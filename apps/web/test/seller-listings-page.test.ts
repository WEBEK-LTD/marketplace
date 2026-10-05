import type { ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import ar from '../messages/ar.json';
import en from '../messages/en.json';
import { startBuiltApp, type RunningApp } from './support/next-server.js';
import { problem, startStubApi, type StubApi } from './support/stub-api.js';

/**
 * `/dashboard/seller/listings`, over real HTTP against the built app (Phase 6-F).
 *
 * What this page owes, and what the assertions are about:
 *
 * **Controls exist only where a mutation is permitted.** A suspended or closed storefront sees its listings
 * and no create form and no row controls at all — so no mutation request can be made rather than being made
 * and refused. Within a storefront that may mutate, each row offers exactly what its own status allows, and
 * a control that is not permitted is *absent* rather than disabled: a disabled button is still in the DOM to
 * re-enable, and a hidden one still posts.
 *
 * **Nothing private, ever.** No identifier of any kind — not the seller's, not the listing's, not the
 * category's — no token, no API address, no approval time, no view count, no moderation note and no
 * rejection reason, asserted against the whole document including the RSC payload, which is where a prop
 * passed to a client component actually travels.
 *
 * **A failure is not an empty shop.** An unavailable API gets the error view, never "you have no listings".
 *
 * **Both locales, and no physical direction anywhere.** The Arabic page carries the Arabic copy, the
 * document direction is `rtl`, and the components use logical properties rather than `left`/`right`.
 *
 * The forms' *behaviour* — which fields are sent, what a blank box means, that nothing is optimistic — is
 * tested exactly, as pure functions, in `seller-listing-forms.test.ts`. Testing it here would need a browser.
 *
 * No browser, no Playwright, no live provider, no deployment.
 */

// Exactly 43 base64url characters, or the web app's env validation refuses it at startup.
const CANARY_CREDENTIAL = 'test-web-listings-page-canary-not-real-xxxx';
const ACCESS = '__Host-mp_access=canary-access-token-value-not-a-real-token';
const REFRESH = '__Host-mp_refresh=canary-refresh-token-value-not-a-real-toke';
const SESSION = `${ACCESS}; ${REFRESH}`;
const USER_ID = '11111111-1111-4111-8111-111111111111';
const IDENTITY = { user: { id: USER_ID, displayName: 'Nadia' } };

const SELLER = {
  slug: 'good-shop',
  displayName: 'Good Shop',
  status: 'active',
  verificationStatus: 'verified',
  city: 'Cairo',
  countryCode: 'EG',
};

const LISTING = {
  slug: 'a-chair',
  title: 'A Chair',
  description: 'A very fine chair indeed.',
  listingTypeCode: 'product',
  categorySlug: 'widgets',
  status: 'draft',
  currencyCode: 'EGP',
  priceMinor: 9900,
  isNegotiable: false,
  contentLanguage: 'en',
  countryCode: 'EG',
  governorate: null,
  city: 'Cairo',
  mediaCount: 0,
  createdAt: '2026-05-01T10:00:00.000Z',
  updatedAt: '2026-05-02T10:00:00.000Z',
  submittedAt: null,
  archivedAt: null,
};

const at = (status: string, slug: string): Record<string, unknown> => ({ ...LISTING, status, slug });

/** Values no listing contract carries, offered by the stub API anyway. */
const PRIVATE_VALUES = {
  sellerUserId: USER_ID,
  listingId: '99999999-9999-4999-8999-999999999999',
  categoryId: '88888888-8888-4888-8888-888888888888',
  approvedAt: '2026-06-01T00:00:00.000Z',
  viewCount: 4242,
  rejectionReason: 'Prohibited item, internal moderation note',
} as const;

type Mode =
  | { readonly kind: 'ok'; readonly seller?: Record<string, unknown>; readonly listings?: unknown[]; readonly nextCursor?: string | null }
  | { readonly kind: 'not_a_seller' }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'listings_unavailable' };

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
    if (path === '/v1/sellers/me/listings') {
      if (mode.kind === 'not_a_seller') return problem(response, 404, 'NOT_FOUND');
      if (mode.kind === 'unauthenticated') return problem(response, 401, 'AUTHENTICATION_REQUIRED');
      if (mode.kind === 'listings_unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      return json(response, {
        listings: mode.listings ?? [LISTING],
        nextCursor: mode.nextCursor ?? null,
      });
    }
    if (path === '/v1/categories') {
      return json(response, {
        categories: [
          {
            id: PRIVATE_VALUES.categoryId,
            slug: 'widgets',
            name: 'Widgets',
            children: [
              { id: '77777777-7777-4777-8777-777777777777', slug: 'chairs', name: 'Chairs', children: [] },
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
    const page = await load('/dashboard/seller/listings', null);

    expect(page.status).toBe(307);
    expect(page.location).toContain('/login');
    expect(page.robotsHeader).toBe('noindex');
  });

  it('redirects to the Arabic sign-in under /ar', async () => {
    const page = await load('/ar/dashboard/seller/listings', null);

    expect(page.status).toBe(307);
    expect(page.location).toContain('/ar/login');
  });

  it('gives a signed-out visitor no listing at all, payload included', async () => {
    const page = await load('/dashboard/seller/listings', null);

    for (const absent of ['A Chair', 'a-chair', 'Create a listing draft', 'name="slug"', 'widgets']) {
      expect(page.html, absent).not.toContain(absent);
    }
  });

  it('shows 5-A’s own signed-out view when the session gate itself is refused', async () => {
    api.reply((request, response) => {
      const path = request.url.split('?')[0] ?? '';
      if (path === '/v1/users/me') return problem(response, 401, 'AUTHENTICATION_REQUIRED');
      return json(response, { listings: [LISTING], nextCursor: null });
    });
    const page = await load('/dashboard/seller/listings');

    expect(page.status).toBe(200);
    expect(page.html).toContain(en.Session.expiredTitle);
    // Nothing of the page behind the gate, payload included.
    expect(page.html).not.toContain('Create a listing draft');
    expect(page.html).not.toContain('A Chair');
  });

  it('shows the session-ended view when the session lapses between the gate and the read', async () => {
    apiServes({ kind: 'unauthenticated' });
    const page = await load('/dashboard/seller/listings');

    expect(page.status).toBe(200);
    expect(page.html).toContain(en.Session.expiredBody);
    expect(page.html).not.toContain('Create a listing draft');
    expect(page.html).not.toContain('A Chair');
  });

  it('is never indexable', async () => {
    const page = await load('/dashboard/seller/listings');
    expect(page.html).toContain('noindex');
  });
});

describe('the listings index', () => {
  it('shows a listing’s own facts, named by slug and never by an identifier', async () => {
    const page = await load('/dashboard/seller/listings');

    expect(page.status).toBe(200);
    expect(page.html).toContain('A Chair');
    expect(page.html).toContain('a-chair');
    expect(page.html).toContain('widgets');
    expect(page.html).toContain('Draft');
  });

  it('says so plainly when there is nothing yet, rather than showing an empty table', async () => {
    apiServes({ kind: 'ok', listings: [] });
    const page = await load('/dashboard/seller/listings');

    expect(page.html).toContain(en.SellerListings.empty);
    expect(page.html).not.toContain('A Chair');
  });

  it('reports a media count rather than any object path', async () => {
    apiServes({ kind: 'ok', listings: [{ ...LISTING, mediaCount: 3 }] });
    const page = await load('/dashboard/seller/listings');

    expect(page.html).toContain('Images');
    expect(page.html).not.toContain('objectPath');
    expect(page.html).not.toContain('seller-media/');
  });

  it('offers the next page as an ordinary link carrying the opaque cursor', async () => {
    apiServes({ kind: 'ok', nextCursor: 'b3BhcXVl' });
    const page = await load('/dashboard/seller/listings');

    expect(page.html).toContain(en.SellerListings.nextPage);
    expect(page.html).toContain('cursor=b3BhcXVl');
  });

  it('shows no next-page link on the last page', async () => {
    const page = await load('/dashboard/seller/listings');
    expect(page.html).not.toContain(en.SellerListings.nextPage);
  });

  it('sends a caller with no storefront to the seller landing page, not to a second form', async () => {
    apiServes({ kind: 'not_a_seller' });
    const page = await load('/dashboard/seller/listings');

    expect(page.status).toBe(200);
    expect(page.html).toContain(en.SellerDashboard.notASeller);
    expect(page.html).not.toContain('Create a listing draft');
    expect(controls(page.html)).toEqual([]);
  });

  it('shows the error view rather than an empty shop when the service cannot answer', async () => {
    apiServes({ kind: 'listings_unavailable' });
    const page = await load('/dashboard/seller/listings');

    expect(page.status).toBe(200);
    expect(page.html).toContain(en.SellerListings.errorUnavailable);
    // The one thing a failing read must never be mistaken for.
    expect(page.html).not.toContain(en.SellerListings.empty);
  });
});

describe('which actions each state offers', () => {
  it('offers a draft both editing and submission, and no archive', async () => {
    const page = await load('/dashboard/seller/listings');

    expect(page.html).toContain(en.SellerListings.edit);
    expect(page.html).toContain(en.SellerListings.submit);
    expect(page.html).not.toContain(en.SellerListings.archive);
  });

  it.each([
    ['approved', 'approved-listing'],
    ['active', 'active-listing'],
  ])('offers a %s listing archival only', async (status, slug) => {
    apiServes({ kind: 'ok', listings: [at(status, slug)] });
    const page = await load('/dashboard/seller/listings');

    expect(page.html).toContain(en.SellerListings.archive);
    expect(page.html).not.toContain(en.SellerListings.edit);
    expect(page.html).not.toContain(en.SellerListings.submit);
  });

  it('offers a submitted listing nothing, and says why', async () => {
    apiServes({ kind: 'ok', listings: [at('pending_review', 'submitted-listing')] });
    const page = await load('/dashboard/seller/listings');

    expect(page.html).toContain(en.SellerListings.awaitingReview);
    expect(page.html).not.toContain(en.SellerListings.edit);
    expect(page.html).not.toContain(en.SellerListings.submit);
    expect(page.html).not.toContain(en.SellerListings.archive);
  });

  it.each(['sold', 'expired', 'archived', 'rejected', 'suspended'])(
    'offers a %s listing no action at all',
    async (status) => {
      apiServes({ kind: 'ok', listings: [at(status, `${status}-listing`)] });
      const page = await load('/dashboard/seller/listings');

      for (const action of [
        en.SellerListings.edit,
        en.SellerListings.submit,
        en.SellerListings.archive,
      ]) {
        expect(page.html, action).not.toContain(action);
      }
    },
  );

  it('offers nothing anywhere on the page that deletes a listing', async () => {
    apiServes({
      kind: 'ok',
      listings: [LISTING, at('active', 'active-listing'), at('rejected', 'rejected-listing')],
    });
    const page = await load('/dashboard/seller/listings');
    const lower = page.html.toLowerCase();

    for (const word of ['delete', 'remove listing', 'method="delete"']) {
      expect(lower, word).not.toContain(word);
    }
  });

  it('confirms before submitting and before archiving, naming what will happen', async () => {
    apiServes({ kind: 'ok', listings: [LISTING, at('active', 'active-listing')] });
    const page = await load('/dashboard/seller/listings');

    expect(page.html).toContain(en.SellerListings.submitConfirm);
    expect(page.html).toContain(en.SellerListings.archiveConfirm);
  });
});

describe('a storefront that may not mutate', () => {
  it.each(['suspended', 'closed'])('gives a %s storefront its listings and no controls at all', async (status) => {
    apiServes({ kind: 'ok', seller: { ...SELLER, status } });
    const page = await load('/dashboard/seller/listings');

    // Reading one's own rows is not a mutation, so the listings are still there.
    expect(page.html).toContain('A Chair');
    expect(page.html).toContain(en.SellerListings.notEditable);
    // And not one control that could ask for a mutation.
    expect(page.html).not.toContain('Create a listing draft');
    expect(page.html).not.toContain(en.SellerListings.edit);
    expect(page.html).not.toContain(en.SellerListings.submit);
    expect(page.html).not.toContain(en.SellerListings.archive);
    expect(controls(page.html)).toEqual([]);
  });

  it('never names the reason a storefront is suspended', async () => {
    apiServes({
      kind: 'ok',
      seller: { ...SELLER, status: 'suspended', suspensionReason: 'Repeated policy breaches, internal note' },
    });
    const page = await load('/dashboard/seller/listings');

    expect(page.html).not.toContain('Repeated policy breaches');
    expect(page.html).not.toContain('internal note');
  });

  it('gives a pending storefront the full set, because pending may mutate', async () => {
    apiServes({ kind: 'ok', seller: { ...SELLER, status: 'pending', verificationStatus: 'unverified' } });
    const page = await load('/dashboard/seller/listings');

    expect(page.html).toContain('Create a listing draft');
    expect(page.html).toContain(en.SellerListings.edit);
  });
});

describe('the create form', () => {
  it('renders the fields a draft needs, and no status, seller or identifier among them', async () => {
    const page = await load('/dashboard/seller/listings');
    const names = controls(page.html);

    for (const field of [
      'slug',
      'title',
      'description',
      'listingTypeCode',
      'categorySlug',
      'contentLanguage',
      'currencyCode',
      'countryCode',
      'priceMinor',
      'isNegotiable',
      'governorate',
      'city',
    ]) {
      expect(names, field).toContain(field);
    }
    for (const field of ['status', 'sellerUserId', 'userId', 'id', 'categoryId', 'approvedAt', 'mediaCount']) {
      expect(names, field).not.toContain(field);
    }
  });

  it('offers no file input: 6-F is not listing media', async () => {
    const page = await load('/dashboard/seller/listings');
    expect(page.html).not.toContain('type="file"');
  });

  it('names categories by slug, and carries none of the tree’s identifiers', async () => {
    const page = await load('/dashboard/seller/listings');

    expect(page.html).toContain('Widgets');
    expect(page.html).toContain('value="widgets"');
    // The public tree carries a uuid per node; the projection drops it before it can reach the payload.
    expect(page.html).not.toContain(PRIVATE_VALUES.categoryId);
    expect(page.html).not.toContain('77777777-7777-4777-8777-777777777777');
  });

  it('says the listing address is permanent, because it is', async () => {
    const page = await load('/dashboard/seller/listings');
    expect(page.html).toContain(en.SellerListings.slugPermanent);
  });

  it('asks for a currency code rather than naming one when the seller has no listings yet', async () => {
    apiServes({ kind: 'ok', listings: [] });
    const page = await load('/dashboard/seller/listings');

    expect(page.html).toContain(en.SellerListings.currencyHint);
    expect(controls(page.html)).toContain('currencyCode');
  });
});

describe('what never reaches the browser', () => {
  it('carries no identifier, timestamp or moderation detail the API offered', async () => {
    apiServes({ kind: 'ok', listings: [LISTING] });
    // The stub sends every private value it can alongside a perfectly good listing.
    api.reply((request, response) => {
      const path = request.url.split('?')[0] ?? '';
      if (path === '/v1/users/me') return json(response, IDENTITY);
      if (path === '/v1/sellers/me') return json(response, { seller: { ...SELLER, ...PRIVATE_VALUES } });
      if (path === '/v1/sellers/me/listings') {
        return json(response, { listings: [{ ...LISTING, ...PRIVATE_VALUES }], nextCursor: null });
      }
      if (path === '/v1/categories') return json(response, { categories: [] });
      return problem(response, 404, 'NOT_FOUND');
    });

    const page = await load('/dashboard/seller/listings');

    // The strict contract refuses the drifted listing outright, so the page shows the error view rather
    // than a listing with extra fields — and none of the offered values is anywhere in the document.
    for (const value of Object.values(PRIVATE_VALUES)) {
      expect(page.html, String(value)).not.toContain(String(value));
    }
  });

  it('carries no session token, no internal credential and no API address', async () => {
    const page = await load('/dashboard/seller/listings');

    expect(page.html).not.toContain('canary-access-token');
    expect(page.html).not.toContain('canary-refresh-token');
    expect(page.html).not.toContain(CANARY_CREDENTIAL);
    expect(page.html).not.toContain(api.baseUrl);
    expect(page.html).not.toContain(USER_ID);
  });

  it('exposes no internal route: the browser only ever sees this origin’s own paths', async () => {
    const page = await load('/dashboard/seller/listings');
    expect(page.html).not.toContain('/v1/sellers/me/listings');
  });
});

describe('both locales', () => {
  it('renders the Arabic page in Arabic, right to left', async () => {
    const page = await load('/ar/dashboard/seller/listings');

    expect(page.status).toBe(200);
    expect(page.html).toContain('dir="rtl"');
    expect(page.html).toContain(ar.SellerListings.title);
    expect(page.html).toContain(ar.SellerListings.create);
    expect(page.html).not.toContain(en.SellerListings.create);
  });

  it('carries the same keys in both message files, so neither page can fall back silently', () => {
    expect(Object.keys(ar.SellerListings).sort()).toEqual(Object.keys(en.SellerListings).sort());
    for (const [key, value] of Object.entries(ar.SellerListings)) {
      expect(typeof value, key).toBe('string');
      expect(String(value).trim(), key).not.toBe('');
    }
  });

  it('adds no marketing claim to either', () => {
    const copy = `${Object.values(en.SellerListings).join(' ')} ${Object.values(ar.SellerListings).join(' ')}`;
    for (const claim of ['free', 'best', 'fastest', 'guarantee', 'no fees', 'مجاناً', 'الأفضل']) {
      expect(copy.toLowerCase(), claim).not.toContain(claim.toLowerCase());
    }
  });

  it('links the listings from the seller navigation in both locales', async () => {
    const english = await load('/dashboard/seller/profile');
    expect(english.html).toContain('/dashboard/seller/listings');

    const arabic = await load('/ar/dashboard/seller/listings');
    expect(arabic.html).toContain('/ar/dashboard/seller/listings');
  });
});

describe('direction is logical, not physical', () => {
  it('uses no left/right utility in any of the listing components', async () => {
    const { readFileSync } = await import('node:fs');
    const sources = [
      'src/components/seller-listing-create-form.tsx',
      'src/components/seller-listing-row.tsx',
      'src/app/[locale]/dashboard/seller/listings/page.tsx',
    ]
      .map((path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'))
      .join('\n');

    // Margins, padding, alignment and offsets that would not mirror under RTL.
    expect(sources).not.toMatch(/\b(ml|mr|pl|pr)-\d|\btext-(left|right)\b|\b(left|right)-\d/);
  });
});
