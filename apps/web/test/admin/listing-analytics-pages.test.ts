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
 * The listing analytics screen, over real HTTP against the built app (0102).
 *
 * Run against the built app rather than a unit harness for the reason every console screen test is: what matters
 * is what actually reaches a browser, **including the streamed RSC payload**.
 *
 * The cases this file exists for:
 *
 *   * **a guest, a buyer, staff at `aal1`, a Moderator and a Support Agent receive none of this section** — no
 *     listing, no seller, no count — in the markup or in the flight data, and no read is performed.
 *     `analytics.listing.read` is held by Admin and Super Admin alone;
 *   * **nothing identifying ever renders** — no account, no session digest, no listing identifier as a field;
 *   * **there is no control anywhere on the page.** No re-run, no recompute, no backfill, no export — asserted
 *     by searching the payload for a form and a button, and by driving the routes such controls would post to;
 *   * **the two standing facts are on the page**: impressions and views are not counted, and nothing here is a
 *     rate;
 *   * **no verdict is rendered** — a count is a count, and no number is coloured or called good;
 *   * both languages, the direction that goes with each, and every state: a page, an empty page, an unusable
 *     cursor and an unreadable rollup.
 *
 * No browser, no Playwright, no live provider, no live storage, no deployment.
 */

/** 43 base64url characters, like every other canary in this repository. */
const CANARY_CREDENTIAL = 'test-listing-analytics-pages-canary-notreal';

const EN = enMessages;
const AR = arMessages;

const ACCESS = '__Host-mp_admin_access=canary-admin-access-token-not-a-real-token';
const REFRESH = '__Host-mp_admin_refresh=canary-admin-refresh-token-not-a-real-tok';
const SESSION = `${ACCESS}; ${REFRESH}`;

const STAFF = '11111111-1111-4111-8111-111111111111';
const ANALYTICS = 'analytics.listing.read';

/** An administrator: the key, plus others this surface never consults. */
const ADMIN = [ANALYTICS, 'users.profile.read', 'audit.read'].sort();

/** A moderator: everything a moderator holds, and not this. */
const MODERATOR = [
  'moderation.report.read',
  'moderation.action.read',
  'reviews.review.read',
  'users.profile.read',
  'sellers.profile.read',
].sort();

/** A support agent: likewise. */
const SUPPORT_AGENT = ['support.ticket.read', 'users.profile.read', 'security.recovery.review'].sort();

const LISTING_TITLE = 'Canary Listing Title For Analytics';
const SELLER_SLUG = 'canary-storefront';

/** Values that must never render, whatever the API sends. */
const CANARY_ACCOUNT = 'aaaaaaaa-9999-4999-8999-aaaaaaaaaaaa';
const CANARY_LISTING_ID = 'eeeeeeee-9999-4999-8999-eeeeeeeeeeee';
const CANARY_DIGEST = 'ab'.repeat(32);

const ROW = {
  day: '2026-10-03',
  listingSlug: 'canary-listing',
  listingTitle: LISTING_TITLE,
  listingStatus: 'active',
  sellerSlug: SELLER_SLUG,
  clicks: '914131',
  contacts: '914117',
  favorites: '0',
  shares: '0',
  computedAt: '2026-10-04T02:50:00.000Z',
};

type Who =
  | { kind: 'staff'; permissions: string[]; locale?: 'en' | 'ar' }
  | { kind: 'staff-aal1' }
  | { kind: 'buyer' }
  | { kind: 'unauthenticated' };

type Data = 'page' | 'empty' | 'paged' | 'invalidCursor' | 'unavailable' | 'leaky';

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

const serve: { who: Who; data: Data; reads: number } = { who: { kind: 'staff', permissions: ADMIN }, data: 'page', reads: 0 };

function apiServes(who: Who, data: Data = 'page'): void {
  serve.who = who;
  serve.data = data;
  serve.reads = 0;

  api.reply((request, response) => {
    const path = request.url.split('?')[0] ?? '';
    const current = serve.who;

    if (path === '/v1/admin/session') {
      if (current.kind === 'unauthenticated') return problem(response, 401, 'AUTHENTICATION_REQUIRED');
      const base = {
        id: STAFF,
        displayName: 'Nadia',
        localeCode: current.kind === 'staff' ? (current.locale ?? 'en') : 'en',
      };
      if (current.kind === 'buyer') {
        return json(response, {
          session: { ...base, isStaff: false, requiresStepUp: false, roles: [], permissions: [] },
        });
      }
      if (current.kind === 'staff-aal1') {
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
          permissions: [...current.permissions],
        },
      });
    }

    if (path === '/v1/admin/analytics/listings') {
      serve.reads += 1;
      // The API's own shape, modelled: a caller without the key gets an **empty page**, not a refusal. The
      // console must therefore never depend on a 403 or a 404 to keep this section shut — `RequireStaff` does.
      const held = current.kind === 'staff' && current.permissions.includes(ANALYTICS);
      if (!held) return json(response, { days: 30, items: [], nextCursor: null });

      if (serve.data === 'unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      if (serve.data === 'invalidCursor') {
        return problem(response, 400, 'LISTING_ANALYTICS_CURSOR_INVALID');
      }
      if (serve.data === 'empty') return json(response, { days: 30, items: [], nextCursor: null });
      if (serve.data === 'paged') {
        return json(response, { days: 30, items: [ROW], nextCursor: 'bGExfDIwMjYtMTAtMDN8eQ' });
      }
      if (serve.data === 'leaky') {
        return json(response, {
          days: 30,
          items: [
            {
              ...ROW,
              sellerUserId: CANARY_ACCOUNT,
              listingId: CANARY_LISTING_ID,
              sessionHash: CANARY_DIGEST,
              impressions: '9999',
            },
          ],
          nextCursor: null,
        });
      }
      return json(response, { days: 30, items: [ROW], nextCursor: null });
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

const PAGE = '/analytics/listings';

/**
 * Everything a refused response must not contain, in markup or flight data.
 *
 * The counts are deliberately six digits. They were `131` and `17`, and a two- or three-digit canary is not a
 * canary: every response carries a random base64 CSP nonce and a set of hashed asset names, so `17` appeared inside
 * a nonce (`al17QJkNDAReGG…`) and the assertion failed on a run where nothing had leaked. It is the same trap this
 * file already names for `ctr` a few tests below — three letters colliding with hashed asset names — and the fix is
 * the same one: make the needle long enough that a hit means what it says.
 */
const SECRETS = [LISTING_TITLE, SELLER_SLUG, '914131', '914117', EN.ListingAnalytics.clicksHeading];

/* ------------------------------------------------------------------------------------------------ */

describe('who sees this section', () => {
  it('shows an administrator the rollup', async () => {
    apiServes({ kind: 'staff', permissions: ADMIN });
    const page = await get(PAGE);
    expect(page.status).toBe(200);
    expect(page.html).toContain(EN.Sections.listingAnalytics.title);
    expect(page.html).toContain(LISTING_TITLE);
    expect(page.html).toContain('914131');
  });

  /**
   * The RSC lesson this repository has learned repeatedly: a gate that refuses must not render the subtree at
   * all, because a client component's props are serialized into the flight data whatever it returns.
   */
  it('shows a moderator, a support agent and aal1 staff nothing of it, and performs no read', async () => {
    for (const who of [
      { kind: 'staff', permissions: MODERATOR } as const,
      { kind: 'staff', permissions: SUPPORT_AGENT } as const,
      { kind: 'staff-aal1' } as const,
      { kind: 'buyer' } as const,
    ]) {
      apiServes(who);
      const page = await get(PAGE);
      for (const secret of SECRETS) {
        expect(page.html, `${JSON.stringify(who)} ${secret}`).not.toContain(secret);
      }
      // Nothing above the gate reads, so a refused caller costs no upstream call.
      expect(serve.reads, JSON.stringify(who)).toBe(0);
    }
  });

  it('sends a guest to sign in rather than rendering anything', async () => {
    apiServes({ kind: 'unauthenticated' });
    const page = await get(PAGE, '');
    for (const secret of SECRETS) expect(page.html, secret).not.toContain(secret);
    expect(serve.reads).toBe(0);
  });
});

describe('what the page says', () => {
  it('states that impressions and views are not counted, rather than leaving the gap unexplained', async () => {
    apiServes({ kind: 'staff', permissions: ADMIN });
    const page = await get(PAGE);
    expect(page.html).toContain(EN.ListingAnalytics.notCountedNote);
  });

  it('states that it is read-only', async () => {
    apiServes({ kind: 'staff', permissions: ADMIN });
    const page = await get(PAGE);
    expect(page.html).toContain(EN.ListingAnalytics.readOnlyNote);
  });

  it('shows the four counts and the window', async () => {
    apiServes({ kind: 'staff', permissions: ADMIN });
    const page = await get(PAGE);
    for (const label of [
      EN.ListingAnalytics.clicksHeading,
      EN.ListingAnalytics.contactsHeading,
      EN.ListingAnalytics.favoritesHeading,
      EN.ListingAnalytics.sharesHeading,
    ]) {
      expect(page.html, label).toContain(label);
    }
    // The window as the page actually words it. `'30'` alone would pass on a response that merely happened to have
    // those digits in a nonce or an asset hash, which is the collision this file's canaries were just corrected for.
    expect(page.html).toContain(EN.ListingAnalytics.windowValue.replace('{days}', '30'));
  });

  /** 914117/914131 is about 100%. Nothing on the page computes any rate at all. */
  it('renders no rate, ratio or verdict', async () => {
    apiServes({ kind: 'staff', permissions: ADMIN });
    const page = await get(PAGE);
    expect(page.html).not.toMatch(/\d+(\.\d+)?%/);
    // The note that says there is no click-through is the one permitted mention, and it is a denial — so it is
    // removed before the words are looked for, exactly as the seller catalogue's own test does.
    const withoutDenials = page.html
      .toLowerCase()
      .split(EN.ListingAnalytics.notCountedNote.toLowerCase())
      .join(' ');
    // `ctr` is deliberately not among these: three letters collide with hashed asset names and with ordinary
    // markup, so it would assert nothing. `click-through` is the concept, spelled out.
    for (const word of ['click-through', 'conversion rate', 'popular', 'trending']) {
      expect(withoutDenials, word).not.toContain(word);
    }
  });

  it('names a seller by their storefront slug and never by an account', async () => {
    apiServes({ kind: 'staff', permissions: ADMIN });
    const page = await get(PAGE);
    expect(page.html).toContain(SELLER_SLUG);
    expect(page.html).not.toContain(STAFF);
  });
});

describe('what never reaches a browser', () => {
  /** A drifted API is a clean failure, not a page carrying a field nobody approved. */
  it('renders nothing from a drifted row that carried an account, a digest or an impression', async () => {
    apiServes({ kind: 'staff', permissions: ADMIN }, 'leaky');
    const page = await get(PAGE);
    for (const canary of [CANARY_ACCOUNT, CANARY_LISTING_ID, CANARY_DIGEST, '9999']) {
      expect(page.html, canary).not.toContain(canary);
    }
    // The contract is strict, so the whole page falls back to its unavailable state rather than leaking.
    expect(page.html).toContain(EN.ListingAnalytics.unavailableTitle);
  });

  it('never carries a listing identifier as a field, even while paging', async () => {
    apiServes({ kind: 'staff', permissions: ADMIN }, 'paged');
    const page = await get(PAGE);
    expect(page.html).not.toContain('listingId');
    expect(page.html).toContain(EN.ListingAnalytics.nextPage);
  });
});

describe('there is no control on this page', () => {
  it('renders no form at all', async () => {
    apiServes({ kind: 'staff', permissions: ADMIN });
    const page = await get(PAGE);
    // The console shell has its own controls — the section menu and the language switch — so the assertion is
    // about this page's own subtree: no form element, which every write control on this console is built from.
    expect(page.html).not.toContain('<form');
    expect(page.html).not.toContain('method="post"');
    // The read-only note explains that a day is corrected by re-running the rollup elsewhere. That is a denial,
    // and it is removed before the verbs are looked for.
    const withoutDenials = page.html
      .toLowerCase()
      .split(EN.ListingAnalytics.readOnlyNote.toLowerCase())
      .join(' ');
    for (const word of ['recompute', 're-run', 'rerun', 'backfill', 'export', 'download']) {
      expect(withoutDenials, word).not.toContain(word);
    }
  });

  /** The routes such controls would post to do not exist, so a crafted request reaches nothing. */
  it('has no route to post a recompute, a backfill or an export to', async () => {
    for (const path of [
      '/api/analytics/listings',
      '/api/analytics/listings/recompute',
      '/api/analytics/rollup',
      '/api/analytics/listings/export',
    ]) {
      const response = await fetch(`${app.baseUrl}${CONSOLE}${path}`, {
        method: 'POST',
        headers: { cookie: SESSION, 'content-type': 'application/json', origin: app.baseUrl },
        body: '{}',
      });
      expect([404, 405], path).toContain(response.status);
    }
  });
});

describe('every state', () => {
  it('shows an honest empty state', async () => {
    apiServes({ kind: 'staff', permissions: ADMIN }, 'empty');
    const page = await get(PAGE);
    expect(page.html).toContain(EN.ListingAnalytics.emptyTitle);
    expect(page.html).not.toContain(LISTING_TITLE);
  });

  it('shows the cursor state for a position the API did not issue', async () => {
    apiServes({ kind: 'staff', permissions: ADMIN }, 'invalidCursor');
    const page = await get(`${PAGE}?cursor=bGExfG5vcGU`);
    expect(page.html).toContain(EN.ListingAnalytics.cursorTitle);
  });

  it('shows the unavailable state when the rollup cannot be read', async () => {
    apiServes({ kind: 'staff', permissions: ADMIN }, 'unavailable');
    const page = await get(PAGE);
    expect(page.html).toContain(EN.ListingAnalytics.unavailableTitle);
    expect(page.html).not.toContain(LISTING_TITLE);
  });

  it('offers a next page only when there is one', async () => {
    apiServes({ kind: 'staff', permissions: ADMIN }, 'page');
    expect((await get(PAGE)).html).not.toContain(EN.ListingAnalytics.nextPage);
    apiServes({ kind: 'staff', permissions: ADMIN }, 'paged');
    expect((await get(PAGE)).html).toContain(EN.ListingAnalytics.nextPage);
  });
});

describe('both languages', () => {
  it('renders the section in Arabic, right to left', async () => {
    apiServes({ kind: 'staff', permissions: ADMIN, locale: 'ar' });
    const page = await get(PAGE);
    expect(page.html).toContain('dir="rtl"');
    expect(page.html).toContain(AR.Sections.listingAnalytics.title);
    expect(page.html).toContain(AR.ListingAnalytics.notCountedNote);
  });

  it('carries every key this screen uses in both catalogues', () => {
    expect(Object.keys(EN.ListingAnalytics).sort()).toEqual(Object.keys(AR.ListingAnalytics).sort());
    expect(Object.keys(EN.Sections.listingAnalytics).sort()).toEqual(
      Object.keys(AR.Sections.listingAnalytics).sort(),
    );
  });

  it('names no action a colleague cannot take, in either catalogue', () => {
    for (const catalogue of [EN.ListingAnalytics, AR.ListingAnalytics]) {
      const prose = Object.values(catalogue).join(' ').toLowerCase();
      for (const verb of ['recompute', 'export', 'download', 'delete']) {
        expect(prose, verb).not.toContain(verb);
      }
    }
  });
});
