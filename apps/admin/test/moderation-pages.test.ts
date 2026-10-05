import type { ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import arMessages from '../messages/ar.json';
import enMessages from '../messages/en.json';
import { startBuiltApp, type RunningApp } from './support/next-server.js';
import { problem, startStubApi, type StubApi } from './support/stub-api.js';

/**
 * The moderation console's screens, over real HTTP against the built app (Phase 7-N).
 *
 * Run against the built app rather than a unit harness for the reason 7-F's shell test is: what matters is
 * what actually reaches a browser, **including the streamed RSC payload**.
 *
 * The cases this file exists for:
 *
 *   * **a guest, a buyer, staff at `aal1` and a colleague without the key receive none of a report or a
 *     listing** — no subject, no reporter's words, no decision note — in the markup or in the flight data,
 *     and no read is performed;
 *   * **the two trails need `moderation.action.read` and are absent, not empty, without it** — a colleague
 *     holding every other key sees no history heading at all, because an empty one would itself say there
 *     was something withheld;
 *   * **the action form needs `catalog.listing.moderate`**, which the database answers with `canModerate`,
 *     and a colleague without it is shipped none of its words;
 *   * **no account is ever named** — not a reporter, not a seller, not a colleague moderator, whatever the
 *     API sends;
 *   * **a report already decided offers no decision form**, and one the caller filed offers none either;
 *   * both languages, the direction that goes with each, and every state: empty, refused, unavailable.
 *
 * No browser, no Playwright, no live provider, no live storage, no deployment.
 */

const CANARY_CREDENTIAL = 'test-admin-moderation-pages-canary-notreal1';

const EN = enMessages;
const AR = arMessages;

const ACCESS = '__Host-mp_admin_access=canary-admin-access-token-not-a-real-token';
const REFRESH = '__Host-mp_admin_refresh=canary-admin-refresh-token-not-a-real-tok';
const SESSION = `${ACCESS}; ${REFRESH}`;

const STAFF = '11111111-1111-4111-8111-111111111111';
const REPORT = 'c0000000-0000-4000-8000-00000000000a';
const LISTING = '22220000-0000-4000-8000-000000000001';

const READ = 'moderation.report.read';
const MANAGE = 'moderation.report.manage';
const ACTIONS = 'moderation.action.read';
const CATALOG = 'catalog.listing.read';
const MODERATE = 'catalog.listing.moderate';

/** A moderator, as 0033 grants it. */
const MODERATOR = [
  READ,
  MANAGE,
  ACTIONS,
  CATALOG,
  MODERATE,
  'reviews.review.read',
  'reviews.review.moderate',
  'users.profile.read',
  'sellers.profile.read',
].sort();

/** A support agent: none of the five. */
const SUPPORT_AGENT = ['support.ticket.read', 'support.ticket.manage', 'users.profile.read'].sort();

const SUBJECT_LABEL = 'Canary listing about a payout';
const REPORTER_WORDS = 'Canary details of what is wrong with this listing.';
const DECISION_NOTE = 'Canary decision note recorded by a colleague';
const ACTION_REASON = 'Canary reason for the action taken';
const TRAIL_REASON = 'Canary reason the listing was suspended';
const LISTING_DESCRIPTION = 'Canary description of the listing under review.';

/** Values that must never render, whatever the API sends. */
const REPORTER_ACCOUNT = '99999999-9999-4999-8999-999999999999';
const SELLER_ACCOUNT = '88888888-8888-4888-8888-888888888888';

const REPORT_ROW = {
  id: REPORT,
  subjectType: 'listing',
  subjectLabel: SUBJECT_LABEL,
  reasonCode: 'counterfeit',
  status: 'open',
  priority: 'high',
  isOwnReport: false,
  actionCount: 0,
  createdAt: '2026-05-01T09:00:00.000Z',
};

const REPORT_DETAIL = {
  id: REPORT,
  subjectType: 'listing',
  subjectSlug: 'a-canary-listing',
  subjectLabel: SUBJECT_LABEL,
  subjectStatus: 'active',
  subjectIsResolvable: true,
  reasonCode: 'counterfeit',
  details: REPORTER_WORDS,
  status: 'open',
  priority: 'high',
  isOwnReport: false,
  resolution: null,
  resolutionNote: null,
  resolvedAt: null,
  resolvedByMe: false,
  duplicateOfReportId: null,
  createdAt: '2026-05-01T09:00:00.000Z',
  updatedAt: '2026-05-01T09:00:00.000Z',
};

const ACTION_ROW = {
  id: 'd0000000-0000-4000-8000-00000000000a',
  action: 'suspend',
  reason: ACTION_REASON,
  notes: null,
  reportId: REPORT,
  expiresAt: null,
  reversesActionId: null,
  isOwnAction: false,
  createdAt: '2026-05-02T09:00:00.000Z',
};

const LISTING_ROW = {
  id: LISTING,
  slug: 'a-canary-listing',
  title: SUBJECT_LABEL,
  status: 'pending_review',
  listingTypeCode: 'product',
  currencyCode: 'EGP',
  priceMinor: '150000',
  isOwnListing: false,
  reportCount: 2,
  createdAt: '2026-05-01T09:00:00.000Z',
};

const LISTING_DETAIL = {
  ...LISTING_ROW,
  description: LISTING_DESCRIPTION,
  contentLanguage: 'en',
  city: 'Cairo',
  sellerSlug: 'a-canary-shop',
  sellerDisplayName: 'Canary Shop',
  canModerate: true,
  openReportCount: 2,
  approvedAt: null,
  reportCount: undefined,
};

const TRAIL_ROW = {
  id: 'e0000000-0000-4000-8000-00000000000a',
  action: 'suspend',
  fromStatus: 'active',
  toStatus: 'suspended',
  reason: TRAIL_REASON,
  reportId: null,
  isOwnAction: false,
  createdAt: '2026-05-02T09:00:00.000Z',
};

type Who =
  | { kind: 'staff'; permissions: readonly string[]; locale?: 'en' | 'ar' }
  | { kind: 'staff-aal1' }
  | { kind: 'buyer' }
  | { kind: 'unauthenticated' };

interface Serve {
  readonly who: Who;
  readonly data?: 'ok' | 'empty' | 'notFound' | 'unavailable' | 'paged' | 'decided' | 'own' | 'unresolvable' | 'leaky' | 'cannotModerate';
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

function reportFor(mode: Serve['data']): unknown {
  if (mode === 'decided') {
    return {
      report: {
        ...REPORT_DETAIL,
        status: 'actioned',
        resolution: 'actioned',
        resolutionNote: DECISION_NOTE,
        resolvedAt: '2026-05-03T09:00:00.000Z',
        resolvedByMe: false,
      },
    };
  }
  if (mode === 'own') return { report: { ...REPORT_DETAIL, isOwnReport: true } };
  if (mode === 'unresolvable') {
    return {
      report: {
        ...REPORT_DETAIL,
        subjectType: 'message',
        subjectSlug: null,
        subjectLabel: null,
        subjectStatus: null,
        subjectIsResolvable: false,
      },
    };
  }
  if (mode === 'leaky') {
    // An API that has drifted and sends accounts. The contract is the wall: none of this may render.
    return { report: { ...REPORT_DETAIL, reporterUserId: REPORTER_ACCOUNT, resolvedBy: REPORTER_ACCOUNT } };
  }
  return { report: REPORT_DETAIL };
}

function listingFor(mode: Serve['data']): unknown {
  if (mode === 'cannotModerate') return { listing: { ...LISTING_DETAIL, canModerate: false } };
  if (mode === 'own') return { listing: { ...LISTING_DETAIL, isOwnListing: true } };
  if (mode === 'leaky') return { listing: { ...LISTING_DETAIL, sellerUserId: SELLER_ACCOUNT } };
  return { listing: LISTING_DETAIL };
}

function apiServes(serve: Serve): void {
  api.seen.length = 0;
  api.reply((request, response) => {
    const path = request.url.split('?')[0] ?? '';
    const who = serve.who;

    if (path === '/v1/admin/session') {
      if (who.kind === 'unauthenticated') return problem(response, 401, 'AUTHENTICATION_REQUIRED');
      const base = {
        id: STAFF,
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
          roles: ['moderator'],
          permissions: [...who.permissions],
        },
      });
    }

    const held = (key: string): boolean => who.kind === 'staff' && who.permissions.includes(key);

    // The API's own gating, modelled: each operation answers 404 for a caller without its key. That is what
    // makes "absent rather than empty" a property of the screen rather than of this stub.
    if (path === `/v1/admin/moderation/reports/${REPORT}/actions`) {
      if (!held(ACTIONS)) return problem(response, 404, 'NOT_FOUND');
      return json(response, { items: serve.data === 'empty' ? [] : [ACTION_ROW] });
    }
    if (path === `/v1/admin/moderation/listings/${LISTING}/history`) {
      if (!held(ACTIONS)) return problem(response, 404, 'NOT_FOUND');
      return json(response, { items: serve.data === 'empty' ? [] : [TRAIL_ROW] });
    }
    if (path === '/v1/admin/moderation/reports') {
      if (!held(READ)) return problem(response, 404, 'NOT_FOUND');
      if (serve.data === 'notFound') return problem(response, 404, 'NOT_FOUND');
      if (serve.data === 'unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      if (serve.data === 'empty') return json(response, { items: [], nextCursor: null });
      return json(response, {
        items: [REPORT_ROW],
        nextCursor: serve.data === 'paged' ? 'bXIxfGNhbmFyeQ' : null,
      });
    }
    if (path === `/v1/admin/moderation/reports/${REPORT}`) {
      if (!held(READ)) return problem(response, 404, 'NOT_FOUND');
      if (serve.data === 'notFound') return problem(response, 404, 'NOT_FOUND');
      if (serve.data === 'unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      return json(response, reportFor(serve.data));
    }
    if (path === '/v1/admin/moderation/listings') {
      if (!held(CATALOG)) return problem(response, 404, 'NOT_FOUND');
      if (serve.data === 'unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      if (serve.data === 'empty') return json(response, { items: [], nextCursor: null });
      return json(response, {
        items: [LISTING_ROW],
        nextCursor: serve.data === 'paged' ? 'bWwxfGNhbmFyeQ' : null,
      });
    }
    if (path === `/v1/admin/moderation/listings/${LISTING}`) {
      if (!held(CATALOG)) return problem(response, 404, 'NOT_FOUND');
      if (serve.data === 'notFound') return problem(response, 404, 'NOT_FOUND');
      if (serve.data === 'unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      return json(response, listingFor(serve.data));
    }

    return problem(response, 404, 'NOT_FOUND');
  });
}

async function get(path: string, cookie = SESSION): Promise<{ status: number; html: string }> {
  const response = await fetch(`${app.baseUrl}${path}`, {
    redirect: 'manual',
    headers: cookie === '' ? {} : { cookie },
  });
  return { status: response.status, html: await response.text() };
}

const REPORTS = '/moderation/reports';
const REPORT_PAGE = `/moderation/reports/${REPORT}`;
const LISTINGS = '/catalog';
const LISTING_PAGE = `/catalog/${LISTING}`;
const ALL = [REPORTS, REPORT_PAGE, LISTINGS, LISTING_PAGE];

/** Everything a refused response must not contain, in markup or flight data. */
const SECRETS = [SUBJECT_LABEL, REPORTER_WORDS, DECISION_NOTE, ACTION_REASON, TRAIL_REASON, LISTING_DESCRIPTION];

/* ------------------------------------------------------------------------------------------------ */

describe('who is refused', () => {
  it('a guest with no cookie receives none of any screen, and no read is performed', async () => {
    apiServes({ who: { kind: 'unauthenticated' } });
    for (const path of ALL) {
      const { status, html } = await get(path, '');
      expect(status, path).toBe(200);
      expect(html, path).toContain(EN.Console.signedOutTitle);
      for (const secret of SECRETS) expect(html, `${path} :: ${secret}`).not.toContain(secret);
    }
    expect(api.seen.filter((request) => request.url.includes('/moderation'))).toHaveLength(0);
  });

  it('a buyer and staff at aal1 receive none of any screen', async () => {
    for (const who of [{ kind: 'buyer' } as const, { kind: 'staff-aal1' } as const]) {
      apiServes({ who });
      for (const path of ALL) {
        const { html } = await get(path);
        for (const secret of SECRETS) expect(html, `${path} :: ${secret}`).not.toContain(secret);
      }
      expect(api.seen.filter((request) => request.url.includes('/v1/admin/moderation'))).toHaveLength(0);
    }
  });

  it('a support agent receives none of any screen, and no moderation read is performed', async () => {
    apiServes({ who: { kind: 'staff', permissions: SUPPORT_AGENT } });
    for (const path of ALL) {
      const { html } = await get(path);
      expect(html, path).toContain(EN.Console.forbiddenTitle);
      for (const secret of SECRETS) expect(html, `${path} :: ${secret}`).not.toContain(secret);
    }
    expect(api.seen.filter((request) => request.url.includes('/v1/admin/moderation'))).toHaveLength(0);
  });

  it('a report or listing that is not this caller’s to see reads as nothing at that address', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR }, data: 'notFound' });
    for (const path of [REPORT_PAGE, LISTING_PAGE]) {
      const { status, html } = await get(path);
      expect(status, path).toBe(200);
      expect(html, path).toContain(EN.Moderation.notFoundTitle);
      for (const secret of SECRETS) expect(html, `${path} :: ${secret}`).not.toContain(secret);
    }
  });

  it('a malformed identifier is an address with nothing at it', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR } });
    for (const path of ['/moderation/reports/not-a-uuid', '/catalog/not-a-uuid']) {
      const { status, html } = await get(path);
      expect(status, path).toBe(200);
      expect(html, path).toContain(EN.Moderation.notFoundTitle);
      expect(html, path).not.toContain(SUBJECT_LABEL);
    }
  });

  it('protects each screen by direct address, not through a link', async () => {
    // The gate is inside each page, so typing the address is as protected as following a link — and the
    // navigation is not what protects it.
    apiServes({ who: { kind: 'staff', permissions: SUPPORT_AGENT } });
    for (const path of ALL) {
      const { html } = await get(path);
      expect(html, path).toContain(EN.Console.forbiddenTitle);
      expect(html, path).not.toContain('aria-current="page"');
    }
  });
});

describe('what a moderator sees', () => {
  it('renders the report queue with the report’s own facts', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR } });
    const { status, html } = await get(REPORTS);

    expect(status).toBe(200);
    expect(html).toContain(SUBJECT_LABEL);
    expect(html).toContain(EN.Moderation.reason.counterfeit);
    expect(html).toContain(EN.Moderation.status.open);
    // Priority is shown as a fact. It is not an ordering, and no ranking is claimed anywhere.
    expect(html).toContain(EN.Moderation.priority.high);
  });

  it('renders one report with what the reporter wrote and the subject’s current status', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR } });
    const { html } = await get(REPORT_PAGE);

    expect(html).toContain(SUBJECT_LABEL);
    expect(html).toContain(REPORTER_WORDS);
    expect(html).toContain(EN.Moderation.subjectStatusLabel);
    expect(html).toContain(EN.Moderation.listingStatus.active);
    // And a way to reach the subject it is about.
    expect(html).toContain('/catalog/a-canary-listing');
  });

  it('offers the decision control with the four statuses the writer accepts, and no open', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR } });
    const { html } = await get(REPORT_PAGE);

    expect(html).toContain(EN.Moderation.decideHeading);
    for (const status of ['triaged', 'actioned', 'dismissed', 'duplicate'] as const) {
      expect(html, status).toContain(EN.Moderation.status[status]);
    }
    // `open` has no option: the existing writer refuses it, so the console cannot offer it.
    expect(html).not.toContain('value="open"');
    expect(html).not.toContain('value="reopened"');
  });

  it('offers no decision control on a report already decided, and says why', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR }, data: 'decided' });
    const { html } = await get(REPORT_PAGE);

    expect(html).toContain(EN.Moderation.alreadyDecidedHint);
    expect(html).toContain(DECISION_NOTE);
    expect(html).toContain(EN.Moderation.decidedByColleague);
    expect(html).not.toContain(EN.Moderation.decideHeading);
    expect(html).not.toContain(EN.Moderation.decideSubmit);
  });

  it('offers no decision control on the caller’s own report, and says why', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR }, data: 'own' });
    const { html } = await get(REPORT_PAGE);

    expect(html).toContain(EN.Moderation.ownReportHint);
    expect(html).not.toContain(EN.Moderation.decideHeading);
  });

  it('says so for a subject this repository has no staff view for', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR }, data: 'unresolvable' });
    const { html } = await get(REPORT_PAGE);

    expect(html).toContain(EN.Moderation.subjectUnavailable);
    expect(html).toContain(EN.Moderation.subjectType.message);
    // No subject link is composed for something that cannot be shown.
    expect(html).not.toContain('/catalog/a-canary-listing');
  });

  it('renders the listing queue and one listing', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR } });
    const queue = await get(LISTINGS);
    expect(queue.html).toContain(SUBJECT_LABEL);
    expect(queue.html).toContain(EN.Moderation.listingStatus.pending_review);
    expect(queue.html).toContain(EN.Moderation.openReportsLabel);

    const detail = await get(LISTING_PAGE);
    expect(detail.html).toContain(LISTING_DESCRIPTION);
    // The storefront's public name, never its account.
    expect(detail.html).toContain('Canary Shop');
  });

  it('offers the five actions the writer defines, and no sixth', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR } });
    const { html } = await get(LISTING_PAGE);

    expect(html).toContain(EN.Moderation.moderateHeading);
    for (const action of ['approve', 'reject', 'suspend', 'reinstate', 'request_changes'] as const) {
      expect(html, action).toContain(EN.Moderation.listingAction[action]);
    }
    for (const absent of ['value="remove"', 'value="hide"', 'value="delete"', 'value="escalate"']) {
      expect(html, absent).not.toContain(absent);
    }
  });

  it('offers no action control on the caller’s own listing', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR }, data: 'own' });
    const { html } = await get(LISTING_PAGE);
    expect(html).toContain(EN.Moderation.ownListingHint);
    expect(html).not.toContain(EN.Moderation.moderateHeading);
  });
});

describe('the two trails need their own key', () => {
  it('renders both for a colleague who holds it', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR } });
    expect((await get(REPORT_PAGE)).html).toContain(EN.Moderation.actionsHeading);
    expect((await get(REPORT_PAGE)).html).toContain(ACTION_REASON);

    const listing = await get(LISTING_PAGE);
    expect(listing.html).toContain(EN.Moderation.historyHeading);
    expect(listing.html).toContain(TRAIL_REASON);
  });

  it('renders neither heading for a colleague who holds everything else', async () => {
    // Absent, not empty: an empty "Moderation history" would itself say there was something withheld.
    const withoutActions = MODERATOR.filter((key) => key !== ACTIONS);
    apiServes({ who: { kind: 'staff', permissions: withoutActions } });

    const report = await get(REPORT_PAGE);
    expect(report.html, 'the report itself is still readable').toContain(REPORTER_WORDS);
    expect(report.html).not.toContain(EN.Moderation.actionsHeading);
    expect(report.html).not.toContain(ACTION_REASON);

    const listing = await get(LISTING_PAGE);
    expect(listing.html, 'the listing itself is still readable').toContain(LISTING_DESCRIPTION);
    expect(listing.html).not.toContain(EN.Moderation.historyHeading);
    expect(listing.html).not.toContain(TRAIL_REASON);
  });

  it('renders neither heading when there is nothing in them', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR }, data: 'empty' });
    const listing = await get(LISTING_PAGE);
    expect(listing.html).not.toContain(EN.Moderation.historyHeading);
  });
});

describe('the action control needs its own key', () => {
  it('is absent for a colleague the database says may not moderate', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR }, data: 'cannotModerate' });
    const { html } = await get(LISTING_PAGE);

    expect(html, 'the listing is still readable').toContain(LISTING_DESCRIPTION);
    expect(html).not.toContain(EN.Moderation.moderateHeading);
    expect(html).not.toContain(EN.Moderation.moderateSubmit);
    for (const action of ['approve', 'reject', 'suspend', 'reinstate'] as const) {
      expect(html, action).not.toContain(`value="${action}"`);
    }
  });
});

describe('what no screen ever contains', () => {
  it('never names an account, even from a drifted API', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR }, data: 'leaky' });
    for (const path of [REPORT_PAGE, LISTING_PAGE]) {
      const { html } = await get(path);
      expect(html, path).not.toContain(REPORTER_ACCOUNT);
      expect(html, path).not.toContain(SELLER_ACCOUNT);
      expect(html, path).not.toContain('reporterUserId');
      expect(html, path).not.toContain('sellerUserId');
      expect(html, path).not.toContain('resolvedBy"');
      expect(html, path).not.toContain('moderatorUserId');
    }
  });

  it('never renders a permission key, the API address or the credential', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR } });
    for (const path of ALL) {
      const { html } = await get(path);
      for (const key of [READ, MANAGE, ACTIONS, CATALOG, MODERATE]) {
        expect(html, `${path} :: ${key}`).not.toContain(key);
      }
      expect(html, path).not.toContain(api.baseUrl);
      expect(html, path).not.toContain(CANARY_CREDENTIAL);
      expect(html, path).not.toContain('canary-admin-access-token');
    }
  });

  it('sends no write of any kind while rendering any screen', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR } });
    for (const path of ALL) await get(path);
    expect(api.seen.length).toBeGreaterThan(0);
    for (const request of api.seen) {
      expect(request.method, request.url).toBe('GET');
      expect(request.body, request.url).toBe('');
    }
  });

  it('has no route that edits, reverses or assigns anything', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR } });
    for (const path of [
      '/api/moderation/reports/assignment',
      '/api/moderation/listings/reverse',
      '/api/moderation/reports/reopen',
    ]) {
      const response = await fetch(`${app.baseUrl}${path}`, {
        method: 'POST',
        headers: { cookie: SESSION, 'content-type': 'application/json', origin: app.baseUrl },
        body: JSON.stringify({ reportId: REPORT }),
      });
      expect(response.ok, path).toBe(false);
    }
  });
});

describe('the states each screen has', () => {
  it('says so when a queue is empty', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR }, data: 'empty' });
    expect((await get(REPORTS)).html).toContain(EN.Moderation.reportsEmptyTitle);
    expect((await get(LISTINGS)).html).toContain(EN.Moderation.listingsEmptyTitle);
  });

  it('offers the next page when there is one', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR }, data: 'paged' });
    const reports = await get(REPORTS);
    expect(reports.html).toContain(EN.Moderation.nextPage);
    expect(reports.html).toContain('cursor=bXIxfGNhbmFyeQ');

    const listings = await get(LISTINGS);
    expect(listings.html).toContain('cursor=bWwxfGNhbmFyeQ');
  });

  it('says so when a read could not be performed', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR }, data: 'unavailable' });
    for (const path of ALL) {
      const { html } = await get(path);
      expect(html, path).toContain(EN.Console.unavailableTitle);
      for (const secret of SECRETS) expect(html, `${path} :: ${secret}`).not.toContain(secret);
    }
  });

  it('sends the section’s old address to its new home', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR } });
    const response = await fetch(`${app.baseUrl}/moderation`, {
      redirect: 'manual',
      headers: { cookie: SESSION },
    });
    const html = await response.text();

    // Next streams, so a redirect from a page body arrives as a 200 carrying the redirect rather than as a
    // 307 status line. The destination is what matters and is what this asserts; and the page it leaves
    // carries none of a report, because it reads nothing.
    expect(html).toContain('/moderation/reports');
    for (const secret of SECRETS) expect(html, secret).not.toContain(secret);
    expect(api.seen.filter((request) => request.url.includes('/v1/admin/moderation'))).toHaveLength(0);
  });
});

describe('both languages', () => {
  it('renders the report screens in Arabic, mirrored', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR, locale: 'ar' } });
    const queue = await get(REPORTS);
    expect(queue.html).toContain('<html lang="ar" dir="rtl">');
    expect(queue.html).toContain(AR.Moderation.reportsIntro);
    expect(queue.html).toContain(AR.Moderation.reason.counterfeit);

    const detail = await get(REPORT_PAGE);
    expect(detail.html).toContain('<html lang="ar" dir="rtl">');
    expect(detail.html).toContain(AR.Moderation.decideHeading);
    expect(detail.html).toContain(REPORTER_WORDS);
  });

  it('renders the listing screens in Arabic, mirrored', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR, locale: 'ar' } });
    const queue = await get(LISTINGS);
    expect(queue.html).toContain('<html lang="ar" dir="rtl">');
    expect(queue.html).toContain(AR.Moderation.listingsIntro);

    const detail = await get(LISTING_PAGE);
    expect(detail.html).toContain(AR.Moderation.moderateHeading);
    expect(detail.html).toContain(AR.Moderation.listingAction.suspend);
  });

  it('keeps every moderation screen out of search engines', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR } });
    for (const path of ALL) {
      const { html } = await get(path);
      expect(html, path).toContain('name="robots"');
      expect(html, path).toContain('noindex');
    }
  });
});
