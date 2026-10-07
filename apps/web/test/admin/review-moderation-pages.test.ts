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
 * The review moderation screens, over real HTTP against the built app (Phase 7-P).
 *
 * Run against the built app rather than a unit harness for the reason 7-F's shell test is: what matters is
 * what actually reaches a browser, **including the streamed RSC payload**.
 *
 * The cases this file exists for:
 *
 *   * **a guest, a buyer, staff at `aal1` and a colleague without the key receive none of a review** — not
 *     its title, not its body, not the seller's reply — in the markup or in the flight data, and no read is
 *     performed;
 *   * **the three keys are not held together, and the screens show it.** A colleague holding
 *     `reviews.review.read` and not `moderation.action.read` is shipped **no history panel at all** — absent,
 *     not empty, because an empty heading would itself say something was withheld. One holding the read key
 *     and not `reviews.review.moderate` is shipped no control and none of the control's words;
 *   * **the control is never shipped to somebody the database would refuse it from.** A moderator who is the
 *     review's buyer or seller is shipped the explanation instead, and none of the control's words;
 *   * **nobody is named** — not the buyer who wrote the review, not the seller's account, not the colleague
 *     who ruled, not the order — whatever the API sends;
 *   * **the reply is read-only everywhere**: no screen offers to hide or remove one, and the page says so in
 *     words rather than leaving a colleague hunting for a control that was never built;
 *   * both languages, the direction that goes with each, and every state: empty, refused, unavailable.
 *
 * No browser, no Playwright, no live provider, no live storage, no deployment.
 */

const CANARY_CREDENTIAL = 'test-review-moderation-pages-canary-notreal';

const EN = enMessages;
const AR = arMessages;

const ACCESS = '__Host-mp_admin_access=canary-admin-access-token-not-a-real-token';
const REFRESH = '__Host-mp_admin_refresh=canary-admin-refresh-token-not-a-real-tok';
const SESSION = `${ACCESS}; ${REFRESH}`;

const STAFF = '11111111-1111-4111-8111-111111111111';
const REVIEW = 'a9000000-0000-4000-8000-000000000001';

const READ = 'reviews.review.read';
const MODERATE = 'reviews.review.moderate';
const ACTIONS = 'moderation.action.read';

/** A moderator, as 0033 grants it: all three, plus keys this surface never consults. */
const MODERATOR = [READ, MODERATE, ACTIONS, 'moderation.report.read'].sort();

/** A colleague who may read reviews and rule on nothing — the read/moderate separation, on a screen. */
const REVIEW_READER = [READ].sort();

/** A colleague holding both review keys and not 0027's, which is what makes the trail absent. */
const NO_TRAIL = [READ, MODERATE].sort();

/** A support agent: neither review key nor 0027's. */
const SUPPORT_AGENT = ['support.ticket.read', 'users.profile.read'].sort();

const REVIEW_TITLE = 'Canary review title about a late delivery';
const REVIEW_BODY = 'Canary body of the review that a buyer wrote about this order.';
const REPLY_BODY = 'Canary reply the seller wrote back to this review.';
const MODERATION_REASON = 'Canary reason a colleague hid this review';
const ACTION_REASON = 'Canary reason recorded in the moderation trail';
const SELLER_NAME = 'Canary Shop That Sells Canaries';
const SLUG = 'a-canary-shop';

/** Values that must never render, whatever the API sends. */
const BUYER_ACCOUNT = '44444444-4444-4444-8444-444444444444';
const SELLER_ACCOUNT = '55555555-5555-4555-8555-555555555555';
const COLLEAGUE = '99999999-9999-4999-8999-999999999999';
const ORDER = '66666666-6666-4666-8666-666666666666';
const BUYER_NAME = 'Canary Buyer Who Wrote This';

const QUEUE_ROW = {
  id: REVIEW,
  rating: 2,
  title: REVIEW_TITLE,
  status: 'published',
  hasBody: true,
  autoHiddenReason: null,
  isModerated: false,
  moderatedByMe: false,
  isParty: false,
  sellerSlug: SLUG,
  sellerDisplayName: SELLER_NAME,
  hasReply: true,
  replyStatus: 'published',
  createdAt: '2026-05-01T09:00:00.000Z',
};

const DETAIL = {
  id: REVIEW,
  rating: 2,
  title: REVIEW_TITLE,
  body: REVIEW_BODY,
  status: 'published',
  autoHiddenReason: null,
  moderationReason: null,
  moderatedAt: null,
  moderatedByMe: false,
  isParty: false,
  canModerate: true,
  publicationBlock: null,
  sellerSlug: SLUG,
  sellerDisplayName: SELLER_NAME,
  sellerStatus: 'active',
  replyBody: REPLY_BODY,
  replyStatus: 'published',
  replyModerationReason: null,
  replyCreatedAt: '2026-05-02T09:00:00.000Z',
  createdAt: '2026-05-01T09:00:00.000Z',
  updatedAt: '2026-05-01T09:00:00.000Z',
};

const ACTION_ROW = {
  id: 'b9000000-0000-4000-8000-000000000001',
  action: 'hide',
  reason: ACTION_REASON,
  notes: null,
  reportId: null,
  isOwnAction: false,
  createdAt: '2026-05-03T09:00:00.000Z',
};

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
  | 'moderated'
  | 'autoHidden'
  | 'blocked'
  | 'noReply'
  | 'ratingOnly';

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

function reviewFor(mode: Data): unknown {
  if (mode === 'party') return { review: { ...DETAIL, isParty: true } };
  if (mode === 'readOnly') return { review: { ...DETAIL, canModerate: false } };
  if (mode === 'moderated') {
    return {
      review: {
        ...DETAIL,
        status: 'hidden',
        moderationReason: MODERATION_REASON,
        moderatedAt: '2026-05-03T09:00:00.000Z',
        moderatedByMe: true,
      },
    };
  }
  if (mode === 'autoHidden') {
    return { review: { ...DETAIL, status: 'hidden', autoHiddenReason: 'order_refunded' } };
  }
  if (mode === 'blocked') return { review: { ...DETAIL, publicationBlock: 'payment_disputed' } };
  if (mode === 'noReply') {
    return {
      review: {
        ...DETAIL,
        replyBody: null,
        replyStatus: null,
        replyModerationReason: null,
        replyCreatedAt: null,
      },
    };
  }
  if (mode === 'ratingOnly') return { review: { ...DETAIL, title: null, body: null } };
  if (mode === 'leaky') {
    // An API that has drifted and sends the buyer, the seller's account, the colleague who ruled and the
    // order. The contract is the wall, and this is what proves it stands.
    return {
      review: {
        ...DETAIL,
        buyerUserId: BUYER_ACCOUNT,
        buyerDisplayName: BUYER_NAME,
        sellerUserId: SELLER_ACCOUNT,
        moderatedBy: COLLEAGUE,
        orderId: ORDER,
      },
    };
  }
  return { review: DETAIL };
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
          roles: ['moderator'],
          permissions: [...who.permissions],
        },
      });
    }

    const held = (key: string): boolean => who.kind === 'staff' && who.permissions.includes(key);

    // The API's own gating, modelled: each operation answers 404 for a caller without its key. That is what
    // makes "absent rather than empty" a property of the screen rather than of this stub.
    if (path === '/v1/admin/reviews') {
      if (!held(READ)) return problem(response, 404, 'NOT_FOUND');
      if (data === 'unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      if (data === 'empty') return json(response, { items: [], nextCursor: null });
      if (data === 'party') {
        return json(response, { items: [{ ...QUEUE_ROW, isParty: true }], nextCursor: null });
      }
      if (data === 'ratingOnly') {
        return json(response, {
          items: [{ ...QUEUE_ROW, title: null, hasBody: false, hasReply: false, replyStatus: null }],
          nextCursor: null,
        });
      }
      return json(response, {
        items: [QUEUE_ROW],
        nextCursor: data === 'paged' ? 'cnYxfGNhbmFyeQ' : null,
      });
    }
    if (path === `/v1/admin/reviews/${REVIEW}`) {
      if (!held(READ)) return problem(response, 404, 'NOT_FOUND');
      if (data === 'notFound') return problem(response, 404, 'NOT_FOUND');
      if (data === 'unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      return json(response, reviewFor(data));
    }
    if (path === `/v1/admin/reviews/${REVIEW}/actions`) {
      // 0027's own key, and neither review key. A colleague without it gets the API's neutral answer, and
      // the screen renders no heading at all.
      if (!held(ACTIONS)) return problem(response, 404, 'NOT_FOUND');
      if (data === 'empty') return json(response, { items: [] });
      if (data === 'leaky') {
        return json(response, {
          items: [{ ...ACTION_ROW, moderatorUserId: COLLEAGUE, moderatorDisplayName: 'A Colleague' }],
        });
      }
      return json(response, { items: [ACTION_ROW] });
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

const QUEUE_PAGE = '/reviews';
const REVIEW_PAGE = `/reviews/${REVIEW}`;
const ALL = [QUEUE_PAGE, REVIEW_PAGE];

/** Everything a refused response must not contain, in markup or flight data. */
const SECRETS = [REVIEW_TITLE, REVIEW_BODY, REPLY_BODY, ACTION_REASON, SELLER_NAME];

/** Values that must never render on any screen, however they arrive. */
const NEVER = [BUYER_ACCOUNT, SELLER_ACCOUNT, COLLEAGUE, ORDER, BUYER_NAME];

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
    expect(api.seen.filter((request) => request.url.includes('/reviews'))).toHaveLength(0);
  });

  it('a buyer and staff at aal1 receive none of either screen', async () => {
    for (const who of [{ kind: 'buyer' } as const, { kind: 'staff-aal1' } as const]) {
      apiServes({ who });
      for (const path of ALL) {
        const { html } = await get(path);
        for (const secret of SECRETS) expect(html, `${path} :: ${secret}`).not.toContain(secret);
        expect(html, path).not.toContain(EN.Reviews.decisionSubmit);
      }
      expect(api.seen.filter((request) => request.url.includes('/reviews')), who.kind).toHaveLength(0);
    }
  });

  it('a support agent holding neither review key is refused, and no read is performed', async () => {
    apiServes({ who: { kind: 'staff', permissions: SUPPORT_AGENT } });
    for (const path of ALL) {
      const { html } = await get(path);
      expect(html, path).toContain(EN.Console.forbiddenTitle);
      expect(html, path).not.toContain(EN.Reviews.queueIntro);
      for (const secret of SECRETS) expect(html, `${path} :: ${secret}`).not.toContain(secret);
    }
    expect(api.seen.filter((request) => request.url.includes('/reviews'))).toHaveLength(0);
  });

  it('never performs a read outside the gate, so a refusal costs nothing', async () => {
    apiServes({ who: { kind: 'staff', permissions: [] } });
    await get(QUEUE_PAGE);
    await get(REVIEW_PAGE);
    // The gate is a server component inside the page, so a refused subtree is never invoked at all.
    expect(api.seen.filter((request) => request.url.includes('/v1/admin/reviews'))).toHaveLength(0);
  });
});

describe('the keys are not held together, and the screens show it', () => {
  it('ships a moderator the review, the control and the trail', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR } });
    const { html } = await get(REVIEW_PAGE);

    expect(html).toContain(REVIEW_TITLE);
    expect(html).toContain(REVIEW_BODY);
    expect(html).toContain(EN.Reviews.decisionSubmit);
    expect(html).toContain(EN.Reviews.historyHeading);
    expect(html).toContain(ACTION_REASON);
  });

  it('ships a colleague without 0027’s key no history heading at all', async () => {
    apiServes({ who: { kind: 'staff', permissions: NO_TRAIL } });
    const { html } = await get(REVIEW_PAGE);

    expect(html).toContain(REVIEW_TITLE);
    expect(html).toContain(EN.Reviews.decisionSubmit);
    // Absent, not empty. An empty heading would say there was something behind it.
    expect(html).not.toContain(EN.Reviews.historyHeading);
    expect(html).not.toContain(ACTION_REASON);
  });

  it('ships a colleague without the moderate key no control and none of its words', async () => {
    apiServes({ who: { kind: 'staff', permissions: REVIEW_READER }, data: 'readOnly' });
    const { html } = await get(REVIEW_PAGE);

    expect(html).toContain(REVIEW_TITLE);
    expect(html).toContain(REVIEW_BODY);
    for (const word of [
      EN.Reviews.decisionHeading,
      EN.Reviews.decisionIntro,
      EN.Reviews.decisionSubmit,
      EN.Reviews.decisionStatusLabel,
      EN.Reviews.reasonLabel,
      EN.Reviews.confirmPublish,
      EN.Reviews.confirmHide,
      EN.Reviews.confirmRemove,
    ]) {
      expect(html, word).not.toContain(word);
    }
  });

  it('renders an empty trail as no trail at all', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR }, data: 'empty' });
    const { html } = await get(REVIEW_PAGE);
    expect(html).not.toContain(EN.Reviews.historyHeading);
  });
});

describe('the control is shipped only where the database would accept it', () => {
  it('ships a party to the review the explanation and none of the control', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR }, data: 'party' });
    const { html } = await get(REVIEW_PAGE);

    expect(html).toContain(EN.Reviews.isPartyNote);
    for (const word of [EN.Reviews.decisionSubmit, EN.Reviews.decisionStatusLabel, EN.Reviews.confirmHide]) {
      expect(html, word).not.toContain(word);
    }
  });

  it('says so on the queue row as well, before a colleague opens it', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR }, data: 'party' });
    const { html } = await get(QUEUE_PAGE);
    expect(html).toContain(EN.Reviews.isPartyHint);
  });

  it('offers all four statuses, because the writer imposes no transition matrix', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR } });
    const { html } = await get(REVIEW_PAGE);

    for (const label of Object.values(EN.Reviews.status)) {
      expect(html, label).toContain(label);
    }
    // Every decision carries a reason, so the field is on the screen from the start rather than appearing
    // for some statuses and not others.
    expect(html).toContain(EN.Reviews.reasonLabel);
    expect(html).toContain(EN.Reviews.reasonHint);
  });
});

describe('nobody is named', () => {
  it('refuses a drifted body outright rather than rendering the part it recognises', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR }, data: 'leaky' });
    // The flight payload escapes its own quotes, so it is unescaped before anything is looked for in it.
    const payload = (await get(REVIEW_PAGE)).html.replaceAll('\\"', '"');

    for (const value of NEVER) expect(payload, value).not.toContain(value);
    // The contract is `.strict()`, so an API that had drifted and sent the buyer's account does not get the
    // rest of its body rendered either: the whole read becomes one clean outage. That is a stronger property
    // than filtering the extra field out would be, because nothing has to remember to filter.
    expect(payload).toContain(EN.Console.unavailableTitle);
    expect(payload).not.toContain(REVIEW_BODY);
  });

  it('names nobody on the page that does render, and the storefront by its own handle', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR } });
    const payload = (await get(REVIEW_PAGE)).html.replaceAll('\\"', '"');

    for (const value of NEVER) expect(payload, value).not.toContain(value);
    // What is rendered instead: the slug the storefront's own public projection publishes.
    expect(payload).toContain(SLUG);
    expect(payload).toContain(SELLER_NAME);
    expect(payload).toContain(REVIEW_BODY);
  });

  it('refuses a drifted trail the same way, so no colleague is ever named', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR }, data: 'leaky' });
    const payload = (await get(REVIEW_PAGE)).html.replaceAll('\\"', '"');
    expect(payload).not.toContain(COLLEAGUE);
    expect(payload).not.toContain(ACTION_REASON);
  });

  it('renders the reader’s own relationship rather than anybody’s identity', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR }, data: 'moderated' });
    const { html } = await get(REVIEW_PAGE);

    expect(html).toContain(EN.Reviews.moderatedByMeHint);
    expect(html).toContain(MODERATION_REASON);
    expect(html).not.toContain(COLLEAGUE);
  });

  it('never ships a permission key to a browser', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR } });
    const payload = (await get(REVIEW_PAGE)).html.replaceAll('\\"', '"');

    // The capability crosses; the key never does. A screen holding the key could compose its own rule.
    for (const key of [READ, MODERATE, ACTIONS]) expect(payload, key).not.toContain(key);
  });
});

describe('the reply is read-only everywhere', () => {
  it('shows the reply and says its state cannot be changed here', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR } });
    const { html } = await get(REVIEW_PAGE);

    expect(html).toContain(EN.Reviews.replyHeading);
    expect(html).toContain(REPLY_BODY);
    expect(html).toContain(EN.Reviews.replyReadOnlyNote);
    expect(html).toContain(EN.Reviews.replyGapNote);
  });

  it('omits the reply section entirely when there is none', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR }, data: 'noReply' });
    const { html } = await get(REVIEW_PAGE);

    expect(html).not.toContain(EN.Reviews.replyHeading);
    expect(html).not.toContain(REPLY_BODY);
    // The gap is still stated, because it is a gap in the surface rather than in this one review.
    expect(html).toContain(EN.Reviews.replyGapNote);
  });

  it('serves nothing at a route that would moderate a reply', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR } });
    const response = await fetch(`${app.baseUrl}${CONSOLE}/api/reviews/reply/moderation`, {
      method: 'POST',
      headers: { origin: app.baseUrl, 'content-type': 'application/json', cookie: SESSION },
      body: JSON.stringify({ reviewId: REVIEW, status: 'hidden', reason: 'Because.' }),
    });
    expect(response.status).toBe(404);
  });
});

describe('every state is a state', () => {
  it('renders an empty queue as its own answer', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR }, data: 'empty' });
    const { html } = await get(QUEUE_PAGE);
    expect(html).toContain(EN.Reviews.queueEmptyTitle);
    expect(html).not.toContain(REVIEW_TITLE);
  });

  it('renders a review that is not this caller’s to see as the neutral answer', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR }, data: 'notFound' });
    const { html } = await get(REVIEW_PAGE);
    expect(html).toContain(EN.Reviews.notFoundTitle);
    expect(html).not.toContain(REVIEW_TITLE);
  });

  it('renders an unreadable answer as an outage', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR }, data: 'unavailable' });
    for (const path of ALL) {
      const { html } = await get(path);
      expect(html, path).toContain(EN.Console.unavailableTitle);
    }
  });

  it('offers the next page only when there is one', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR }, data: 'paged' });
    const paged = await get(QUEUE_PAGE);
    expect(paged.html).toContain(EN.Reviews.nextPage);
    expect(paged.html).toContain('cursor=cnYxfGNhbmFyeQ');

    apiServes({ who: { kind: 'staff', permissions: MODERATOR } });
    const last = await get(QUEUE_PAGE);
    expect(last.html).not.toContain(EN.Reviews.nextPage);
  });

  it('shows a review with a rating and nothing written', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR }, data: 'ratingOnly' });
    const detail = await get(REVIEW_PAGE);
    expect(detail.html).toContain(EN.Reviews.untitled);
    expect(detail.html).not.toContain(REVIEW_BODY);

    const queue = await get(QUEUE_PAGE);
    expect(queue.html).toContain(EN.Reviews.bodyAbsent);
    expect(queue.html).toContain(EN.Reviews.replyAbsent);
  });

  it('shows why automation hid a review', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR }, data: 'autoHidden' });
    const { html } = await get(REVIEW_PAGE);
    expect(html).toContain(EN.Reviews.autoHiddenLabel);
    expect(html).toContain(EN.Reviews.status.hidden);
  });

  it('shows what publishing a blocked review would override', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR }, data: 'blocked' });
    const { html } = await get(REVIEW_PAGE);
    expect(html).toContain(EN.Reviews.publicationBlock.payment_disputed);
  });
});

describe('both languages', () => {
  it('renders both screens in Arabic, right to left, with none of the English', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR, locale: 'ar' } });
    for (const [path, en, ar] of [
      [QUEUE_PAGE, EN.Reviews.queueIntro, AR.Reviews.queueIntro],
      [REVIEW_PAGE, EN.Reviews.detailIntro, AR.Reviews.detailIntro],
    ] as const) {
      const { html } = await get(path);
      expect(html, path).toContain('dir="rtl"');
      expect(html, path).toContain('lang="ar"');
      expect(html, path).toContain(ar);
      expect(html, path).not.toContain(en);
    }
  });

  it('renders the control in Arabic', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR, locale: 'ar' } });
    const { html } = await get(REVIEW_PAGE);
    expect(html).toContain(AR.Reviews.decisionSubmit);
    expect(html).toContain(AR.Reviews.reasonLabel);
    expect(html).toContain(AR.Reviews.status.hidden);
    expect(html).not.toContain(EN.Reviews.decisionSubmit);
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
