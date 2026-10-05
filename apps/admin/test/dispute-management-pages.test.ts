import type { ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import arMessages from '../messages/ar.json';
import enMessages from '../messages/en.json';
import { startBuiltApp, type RunningApp } from './support/next-server.js';
import { problem, startStubApi, type StubApi } from './support/stub-api.js';

/**
 * The dispute management screens, over real HTTP against the built app (Phase 7-R).
 *
 * Run against the built app rather than a unit harness for the reason 7-F's shell test is: what matters is what
 * actually reaches a browser, **including the streamed RSC payload**.
 *
 * The cases this file exists for:
 *
 *   * **a guest, a buyer, staff at `aal1`, a Moderator and a Support Agent receive none of this section** — no
 *     claim, no reason, no message — in the markup or in the flight data, and no read is performed. A Moderator
 *     is deliberately granted neither dispute key, so this is one of the two sections they cannot see at all;
 *   * **THE PHASE 8 BOUNDARY IS ON THE SCREEN.** The notice that a refund resolution records a decision and
 *     moves no money appears beside a recorded refund decision and in the standing note, in **both languages**;
 *   * **money renders from strings with full precision** — an amount larger than a double can hold exactly
 *     renders digit for digit, which is the assertion that fails if anybody puts a `Number()` in the path;
 *   * **nothing identifying a person renders** — no buyer, no seller, no opener, no resolver, no author;
 *   * **the controls are shipped only where they apply**: a read-only colleague gets neither and none of their
 *     words, and a party gets the message control but not the resolution control;
 *   * **the four unreachable states are not offered**, and the evidence panel does not exist;
 *   * both languages, the direction that goes with each, and every state.
 *
 * No browser, no Playwright, no live provider, no live storage, no deployment.
 */

const CANARY_CREDENTIAL = 'test-dispute-pages-canary-notreal0123456789';

const EN = enMessages;
const AR = arMessages;

const ACCESS = '__Host-mp_admin_access=canary-admin-access-token-not-a-real-token';
const REFRESH = '__Host-mp_admin_refresh=canary-admin-refresh-token-not-a-real-tok';
const SESSION = `${ACCESS}; ${REFRESH}`;

const STAFF = '11111111-1111-4111-8111-111111111111';
const DISPUTE = 'fe000000-0000-4000-8000-000000000001';

const READ = 'disputes.dispute.read';
const MANAGE = 'disputes.dispute.manage';

/** An administrator: both dispute keys, plus others this surface never consults. */
const ADMIN = [READ, MANAGE, 'users.profile.read'].sort();

/** A colleague who may read disputes and act on none — the read/manage separation, on a screen. */
const DISPUTE_READER = [READ].sort();

/** A moderator, who by the platform's own decision holds neither dispute key. */
const MODERATOR = [
  'moderation.report.read',
  'moderation.action.read',
  'reviews.review.read',
  'reviews.review.moderate',
  'users.profile.read',
  'sellers.profile.read',
].sort();

/** A support agent: likewise. */
const SUPPORT_AGENT = ['support.ticket.read', 'users.profile.read', 'security.recovery.review'].sort();

/**
 * Larger than `Number.MAX_SAFE_INTEGER`, and chosen so the rendered form is unmistakable.
 *
 * 9007199254740993 minor units renders as `90071992547409.93`. If any layer converts to a number, the digits
 * become ...992 and the rendered string changes.
 */
const BIG_AMOUNT = '9007199254740993';
const BIG_RENDERED = '90071992547409.93';

const DISPUTE_DETAILS = 'Canary account of what went wrong with this order';
const RESOLUTION_NOTE = 'Canary reason the decision went the way it did';
const MESSAGE_BODY = 'Canary message the buyer wrote on this dispute';
const INTERNAL_BODY = 'Canary staff-only note nobody outside the console may read';
const ORDER_NUMBER = 'MP-26-000123';
const SELLER_NAME = 'Canary Shop That Sells Canaries';
const SLUG = 'a-canary-shop';

/** Values that must never render, whatever the API sends. */
const BUYER_ACCOUNT = '44444444-4444-4444-8444-444444444444';
const SELLER_ACCOUNT = '55555555-5555-4555-8555-555555555555';
const RESOLVER_ACCOUNT = '99999999-9999-4999-8999-999999999999';
const ORDER_ID = '66666666-6666-4666-8666-666666666666';

const QUEUE_ROW = {
  id: DISPUTE,
  status: 'open',
  reasonCode: 'damaged',
  currencyCode: 'EGP',
  claimAmountMinor: BIG_AMOUNT,
  orderNumber: ORDER_NUMBER,
  orderStatus: 'disputed',
  orderType: 'product',
  sellerSlug: SLUG,
  sellerDisplayName: SELLER_NAME,
  isParty: false,
  resolvedByMe: false,
  resolution: null,
  messageCount: 2,
  hasDetails: true,
  dueAt: null,
  createdAt: '2026-05-01T09:00:00.000Z',
};

const DETAIL = {
  id: DISPUTE,
  status: 'open',
  reasonCode: 'damaged',
  details: DISPUTE_DETAILS,
  currencyCode: 'EGP',
  claimAmountMinor: BIG_AMOUNT,
  orderNumber: ORDER_NUMBER,
  orderStatus: 'disputed',
  orderType: 'product',
  orderGrandTotalMinor: BIG_AMOUNT,
  orderStatusBefore: 'delivered',
  orderPlacedAt: '2026-04-01T09:00:00.000Z',
  sellerSlug: SLUG,
  sellerDisplayName: SELLER_NAME,
  openedByRole: 'buyer',
  resolution: null,
  resolutionAmountMinor: null,
  resolutionNote: null,
  resolvedAt: null,
  resolvedByMe: false,
  isParty: false,
  canManage: true,
  dueAt: null,
  createdAt: '2026-05-01T09:00:00.000Z',
  updatedAt: '2026-05-01T09:00:00.000Z',
};

const MESSAGES = [
  {
    id: 'ff000000-0000-4000-8000-000000000001',
    authorRole: 'buyer',
    body: MESSAGE_BODY,
    isInternal: false,
    isOwnMessage: false,
    createdAt: '2026-05-01T09:05:00.000Z',
  },
  {
    id: 'ff000000-0000-4000-8000-000000000002',
    authorRole: 'staff',
    body: INTERNAL_BODY,
    isInternal: true,
    isOwnMessage: true,
    createdAt: '2026-05-01T09:10:00.000Z',
  },
];

type Who =
  | { kind: 'unauthenticated' }
  | { kind: 'buyer' }
  | { kind: 'staff-aal1' }
  | { kind: 'staff'; permissions: readonly string[]; locale?: 'en' | 'ar' };

type Data =
  | 'default'
  | 'empty'
  | 'paged'
  | 'notFound'
  | 'unavailable'
  | 'leaky'
  | 'party'
  | 'readOnly'
  | 'resolvedRefund'
  | 'resolvedNoAction';

interface Serve {
  readonly who: Who;
  readonly data?: Data;
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

function disputeFor(mode: Data): unknown {
  if (mode === 'party') return { dispute: { ...DETAIL, isParty: true } };
  if (mode === 'readOnly') return { dispute: { ...DETAIL, canManage: false } };
  if (mode === 'resolvedRefund') {
    return {
      dispute: {
        ...DETAIL,
        status: 'resolved',
        orderStatus: 'delivered',
        resolution: 'partial_refund',
        resolutionAmountMinor: BIG_AMOUNT,
        resolutionNote: RESOLUTION_NOTE,
        resolvedAt: '2026-05-02T09:00:00.000Z',
        resolvedByMe: true,
      },
    };
  }
  if (mode === 'resolvedNoAction') {
    return {
      dispute: {
        ...DETAIL,
        status: 'resolved',
        orderStatus: 'delivered',
        resolution: 'no_action',
        resolutionNote: RESOLUTION_NOTE,
        resolvedAt: '2026-05-02T09:00:00.000Z',
      },
    };
  }
  if (mode === 'leaky') {
    // An API that has drifted and sends every account. The contract is the wall.
    return {
      dispute: {
        ...DETAIL,
        buyerUserId: BUYER_ACCOUNT,
        sellerUserId: SELLER_ACCOUNT,
        resolvedBy: RESOLVER_ACCOUNT,
        orderId: ORDER_ID,
      },
    };
  }
  return { dispute: DETAIL };
}

function apiServes(serve: Serve): void {
  const data: Data = serve.data ?? 'default';
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
          roles: ['admin'],
          permissions: [...who.permissions],
        },
      });
    }

    const held = (key: string): boolean => who.kind === 'staff' && who.permissions.includes(key);

    // The API's own gating, modelled: every read answers 404 for a caller without the read key.
    if (path === '/v1/admin/disputes') {
      if (!held(READ)) return problem(response, 404, 'NOT_FOUND');
      if (data === 'unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      if (data === 'empty') return json(response, { items: [], nextCursor: null });
      if (data === 'party') {
        return json(response, { items: [{ ...QUEUE_ROW, isParty: true }], nextCursor: null });
      }
      if (data === 'resolvedRefund') {
        return json(response, {
          items: [
            {
              ...QUEUE_ROW,
              status: 'resolved',
              resolution: 'partial_refund',
              resolvedByMe: true,
            },
          ],
          nextCursor: null,
        });
      }
      return json(response, {
        items: [QUEUE_ROW],
        nextCursor: data === 'paged' ? 'ZHExfGNhbmFyeQ' : null,
      });
    }
    if (path === `/v1/admin/disputes/${DISPUTE}`) {
      if (!held(READ)) return problem(response, 404, 'NOT_FOUND');
      if (data === 'notFound') return problem(response, 404, 'NOT_FOUND');
      if (data === 'unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      return json(response, disputeFor(data));
    }
    if (path === `/v1/admin/disputes/${DISPUTE}/messages`) {
      if (!held(READ)) return problem(response, 404, 'NOT_FOUND');
      if (data === 'empty') return json(response, { items: [] });
      if (data === 'leaky') {
        return json(response, {
          items: [{ ...MESSAGES[0], authorUserId: BUYER_ACCOUNT }],
        });
      }
      return json(response, { items: MESSAGES });
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

const QUEUE_PAGE = '/disputes';
const DISPUTE_PAGE = `/disputes/${DISPUTE}`;
const ALL = [QUEUE_PAGE, DISPUTE_PAGE];

/** Everything a refused response must not contain, in markup or flight data. */
const SECRETS = [DISPUTE_DETAILS, MESSAGE_BODY, INTERNAL_BODY, ORDER_NUMBER, SELLER_NAME];

/** Values that must never render on any screen, however they arrive. */
const NEVER = [BUYER_ACCOUNT, SELLER_ACCOUNT, RESOLVER_ACCOUNT, ORDER_ID];

/* ------------------------------------------------------------------------------------------------ */

describe('who is refused', () => {
  it('a guest with no cookie receives none of either screen, and no read is performed', async () => {
    apiServes({ who: { kind: 'unauthenticated' } });
    for (const path of ALL) {
      const { status, html } = await get(path, '');
      expect(status, path).toBe(200);
      expect(html, path).toContain(EN.Console.signedOutTitle);
      for (const secret of SECRETS) expect(html, `${path} :: ${secret}`).not.toContain(secret);
    }
    expect(api.seen.filter((request) => request.url.includes('/disputes'))).toHaveLength(0);
  });

  it('a buyer and staff at aal1 receive none of either screen', async () => {
    for (const who of [{ kind: 'buyer' } as const, { kind: 'staff-aal1' } as const]) {
      apiServes({ who });
      for (const path of ALL) {
        const { html } = await get(path);
        for (const secret of SECRETS) expect(html, `${path} :: ${secret}`).not.toContain(secret);
      }
      expect(api.seen.filter((request) => request.url.includes('/disputes')), who.kind).toHaveLength(0);
    }
  });

  /**
   * A Moderator holds a great deal of this console and is deliberately granted neither dispute key. A
   * regression in that grant would open somebody's money dispute to the wrong role.
   */
  it('a moderator and a support agent are refused, and no read is performed', async () => {
    for (const permissions of [MODERATOR, SUPPORT_AGENT]) {
      apiServes({ who: { kind: 'staff', permissions } });
      for (const path of ALL) {
        const { html } = await get(path);
        expect(html, path).toContain(EN.Console.forbiddenTitle);
        expect(html, path).not.toContain(EN.Disputes.queueIntro);
        for (const secret of SECRETS) expect(html, `${path} :: ${secret}`).not.toContain(secret);
      }
      expect(api.seen.filter((request) => request.url.includes('/v1/admin/disputes'))).toHaveLength(0);
    }
  });

  it('never performs a read outside the gate, so a refusal costs nothing', async () => {
    apiServes({ who: { kind: 'staff', permissions: [] } });
    await get(QUEUE_PAGE);
    await get(DISPUTE_PAGE);
    expect(api.seen.filter((request) => request.url.includes('/v1/admin/disputes'))).toHaveLength(0);
  });
});

describe('THE PHASE 8 BOUNDARY IS ON THE SCREEN', () => {
  it('states it on the queue and on the detail', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    for (const path of ALL) {
      const { html } = await get(path);
      expect(html, path).toContain(EN.Disputes.boundaryNote);
    }
  });

  it('states it beside a recorded refund decision', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'resolvedRefund' });
    const { html } = await get(DISPUTE_PAGE);

    expect(html).toContain(EN.Disputes.refundDecidedNotMoved);
    expect(html).toContain(EN.Disputes.resolution.partial_refund);
  });

  it('does not state it beside a decision that never implied money', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'resolvedNoAction' });
    const { html } = await get(DISPUTE_PAGE);

    // The notice belongs where a refund was decided. Everywhere else it would be noise.
    expect(html).not.toContain(EN.Disputes.refundDecidedNotMoved);
    expect(html).toContain(EN.Disputes.resolution.no_action);
  });

  it('ships the notice with the resolution control, so it is read before a decision is made', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get(DISPUTE_PAGE);
    expect(html).toContain(EN.Disputes.noMoneyNotice);
  });

  it('renders nothing that suggests money moved', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'resolvedRefund' });
    const payload = (await get(DISPUTE_PAGE)).html.replaceAll('\\"', '"');

    for (const forbidden of ['refundId', 'paymentId', 'ledger', 'payout', 'withdrawal', 'settlement']) {
      expect(payload, forbidden).not.toContain(forbidden);
    }
  });
});

describe('money renders from strings with full precision', () => {
  it('renders an amount larger than a double can hold, digit for digit', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get(DISPUTE_PAGE);

    // `Number('9007199254740993')` is ...992. If any layer converts, this renders ...92 and fails.
    expect(html).toContain(BIG_RENDERED);
    expect(html).not.toContain('90071992547409.92');
    // And never without its currency.
    expect(html).toContain('EGP');
  });

  it('renders the decided amount the same way', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'resolvedRefund' });
    const { html } = await get(DISPUTE_PAGE);
    expect(html).toContain(EN.Disputes.decidedAmountLabel);
    expect(html).toContain(BIG_RENDERED);
  });

  it('renders the claim on the queue row too', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get(QUEUE_PAGE);
    expect(html).toContain(BIG_RENDERED);
  });
});

describe('nobody is named', () => {
  it('refuses a drifted body outright rather than rendering the part it recognises', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'leaky' });
    // The flight payload escapes its own quotes, so it is unescaped before anything is looked for in it.
    const payload = (await get(DISPUTE_PAGE)).html.replaceAll('\\"', '"');

    for (const value of NEVER) expect(payload, value).not.toContain(value);
    expect(payload).toContain(EN.Console.unavailableTitle);
  });

  it('names nobody on the page that does render', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const payload = (await get(DISPUTE_PAGE)).html.replaceAll('\\"', '"');

    for (const value of NEVER) expect(payload, value).not.toContain(value);
    for (const forbidden of ['buyerUserId', 'sellerUserId', 'resolvedBy', 'authorUserId', 'orderId']) {
      expect(payload, forbidden).not.toContain(`"${forbidden}":`);
    }
    // What is rendered instead: sides, roles, the storefront's handle and the order's reference.
    expect(payload).toContain(EN.Disputes.openedBy.buyer);
    expect(payload).toContain(SLUG);
    expect(payload).toContain(ORDER_NUMBER);
  });

  it('never ships a permission key to a browser', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const payload = (await get(DISPUTE_PAGE)).html.replaceAll('\\"', '"');
    for (const key of [READ, MANAGE]) expect(payload, key).not.toContain(key);
  });
});

describe('the controls are shipped only where they apply', () => {
  it('ships an administrator both controls', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get(DISPUTE_PAGE);

    expect(html).toContain(EN.Disputes.messageSubmit);
    expect(html).toContain(EN.Disputes.resolveSubmit);
    expect(html).toContain(EN.Disputes.internalLabel);
  });

  it('ships a read-only colleague neither control and none of their words', async () => {
    apiServes({ who: { kind: 'staff', permissions: DISPUTE_READER }, data: 'readOnly' });
    const { html } = await get(DISPUTE_PAGE);

    expect(html).toContain(DISPUTE_DETAILS);
    expect(html).toContain(EN.Disputes.readOnlyNote);
    for (const word of [
      EN.Disputes.messageHeading,
      EN.Disputes.messageSubmit,
      EN.Disputes.resolveHeading,
      EN.Disputes.resolveSubmit,
      EN.Disputes.internalLabel,
      EN.Disputes.noMoneyNotice,
      EN.Disputes.confirmRefund,
    ]) {
      expect(html, word).not.toContain(word);
    }
  });

  it('ships a party the message control but not the resolution control', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'party' });
    const { html } = await get(DISPUTE_PAGE);

    // 0027 refuses a resolver who is a party, and permits their ordinary message.
    expect(html).toContain(EN.Disputes.isPartyNote);
    expect(html).toContain(EN.Disputes.messageSubmit);
    for (const word of [EN.Disputes.resolveSubmit, EN.Disputes.confirmRefund, EN.Disputes.noMoneyNotice]) {
      expect(html, word).not.toContain(word);
    }
  });

  it('says so on the queue row as well, before a colleague opens it', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'party' });
    const { html } = await get(QUEUE_PAGE);
    expect(html).toContain(EN.Disputes.isPartyHint);
  });

  it('ships no control at all once a dispute is settled', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'resolvedNoAction' });
    const { html } = await get(DISPUTE_PAGE);

    expect(html).toContain(EN.Disputes.closedNote);
    for (const word of [EN.Disputes.messageSubmit, EN.Disputes.resolveSubmit]) {
      expect(html, word).not.toContain(word);
    }
  });

  it('offers all four resolutions', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get(DISPUTE_PAGE);
    for (const label of Object.values(EN.Disputes.resolution)) {
      expect(html, label).toContain(label);
    }
  });
});

describe('the thread carries the internal notes', () => {
  it('renders a staff-only note, marked', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get(DISPUTE_PAGE);

    expect(html).toContain(EN.Disputes.threadHeading);
    expect(html).toContain(MESSAGE_BODY);
    expect(html).toContain(INTERNAL_BODY);
    expect(html).toContain(EN.Disputes.internalBadge);
    expect(html).toContain(EN.Disputes.ownMessageHint);
  });

  it('refuses a drifted thread rather than rendering it', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'leaky' });
    const payload = (await get(DISPUTE_PAGE)).html.replaceAll('\\"', '"');
    expect(payload).not.toContain(BUYER_ACCOUNT);
    expect(payload).not.toContain(MESSAGE_BODY);
  });
});

describe('what is deferred is said, not left as a gap', () => {
  it('states that evidence, assignment and due dates are not available', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get(DISPUTE_PAGE);
    expect(html).toContain(EN.Disputes.deferredNote);
  });

  it('renders no evidence panel and no upload control', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const payload = (await get(DISPUTE_PAGE)).html.replaceAll('\\"', '"');

    // Structural markers, not the bare word: the page's own deferred note says "evidence" on purpose, and a
    // substring search for it would assert something other than the property under test.
    for (const marker of [
      'type="file"',
      '<input type="file"',
      'enctype="multipart/form-data"',
      'dispute-evidence/',
      '"objectPath"',
      '"evidenceCount"',
      '"signedUrl"',
      '/api/disputes/evidence',
    ]) {
      expect(payload, marker).not.toContain(marker);
    }
    // And the note that explains the absence is there, so it reads as deferred rather than broken.
    expect(payload).toContain(EN.Disputes.deferredNote);
  });

  it('serves nothing at a route that would attach evidence or assign a dispute', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    for (const path of [
      '/api/disputes/evidence',
      '/api/disputes/assign',
      '/api/disputes/due',
      '/api/disputes/refund',
      '/api/disputes/cancel',
    ]) {
      const response = await fetch(`${app.baseUrl}${path}`, {
        method: 'POST',
        headers: { origin: app.baseUrl, 'content-type': 'application/json', cookie: SESSION },
        body: JSON.stringify({ disputeId: DISPUTE }),
      });
      expect(response.status, path).toBe(404);
    }
  });
});

describe('every state is a state', () => {
  it('renders an empty queue as its own answer', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'empty' });
    const { html } = await get(QUEUE_PAGE);
    expect(html).toContain(EN.Disputes.queueEmptyTitle);
    expect(html).not.toContain(ORDER_NUMBER);
  });

  it('renders a dispute that is not this caller’s to see as the neutral answer', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'notFound' });
    const { html } = await get(DISPUTE_PAGE);
    expect(html).toContain(EN.Disputes.notFoundTitle);
    expect(html).not.toContain(DISPUTE_DETAILS);
  });

  it('renders an unreadable answer as an outage', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'unavailable' });
    for (const path of ALL) {
      const { html } = await get(path);
      expect(html, path).toContain(EN.Console.unavailableTitle);
    }
  });

  it('offers the next page only when there is one', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'paged' });
    const paged = await get(QUEUE_PAGE);
    expect(paged.html).toContain(EN.Disputes.nextPage);
    expect(paged.html).toContain('cursor=ZHExfGNhbmFyeQ');

    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    expect((await get(QUEUE_PAGE)).html).not.toContain(EN.Disputes.nextPage);
  });

  it('shows the order the dispute is about, and the status it will go back to', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get(DISPUTE_PAGE);
    expect(html).toContain(ORDER_NUMBER);
    expect(html).toContain(EN.Disputes.statusBeforeLabel);
    expect(html).toContain(EN.Disputes.orderTotalLabel);
  });
});

describe('both languages', () => {
  it('renders both screens in Arabic, right to left, with none of the English', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN, locale: 'ar' } });
    for (const [path, en, ar] of [
      [QUEUE_PAGE, EN.Disputes.queueIntro, AR.Disputes.queueIntro],
      [DISPUTE_PAGE, EN.Disputes.detailIntro, AR.Disputes.detailIntro],
    ] as const) {
      const { html } = await get(path);
      expect(html, path).toContain('dir="rtl"');
      expect(html, path).toContain('lang="ar"');
      expect(html, path).toContain(ar);
      expect(html, path).not.toContain(en);
    }
  });

  /** The boundary must be as clear in Arabic as in English: it is the sentence that prevents a real mistake. */
  it('states the Phase 8 boundary in Arabic too', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN, locale: 'ar' } });
    const { html } = await get(DISPUTE_PAGE);

    expect(html).toContain(AR.Disputes.boundaryNote);
    expect(html).toContain(AR.Disputes.noMoneyNotice);
    expect(html).not.toContain(EN.Disputes.noMoneyNotice);
  });

  it('states it beside a recorded refund decision in Arabic', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN, locale: 'ar' }, data: 'resolvedRefund' });
    const { html } = await get(DISPUTE_PAGE);
    expect(html).toContain(AR.Disputes.refundDecidedNotMoved);
  });

  it('renders both controls in Arabic', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN, locale: 'ar' } });
    const { html } = await get(DISPUTE_PAGE);
    expect(html).toContain(AR.Disputes.messageSubmit);
    expect(html).toContain(AR.Disputes.resolveSubmit);
    expect(html).toContain(AR.Disputes.internalLabel);
  });

  it('refuses in Arabic too, with none of the data', async () => {
    apiServes({ who: { kind: 'staff', permissions: [], locale: 'ar' } });
    for (const path of ALL) {
      const { html } = await get(path);
      expect(html, path).toContain('dir="rtl"');
      for (const secret of SECRETS) expect(html, `${path} :: ${secret}`).not.toContain(secret);
    }
  });
});
