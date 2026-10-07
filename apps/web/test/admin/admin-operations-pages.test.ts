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
 * The seller, user, recovery and audit screens, over real HTTP against the built app (Phase 7-O).
 *
 * Run against the built app rather than a unit harness for the reason 7-F's shell test is: what matters is
 * what actually reaches a browser, **including the streamed RSC payload**.
 *
 * The cases this file exists for:
 *
 *   * **a guest, a buyer, staff at `aal1` and a colleague without the key receive none of a storefront, an
 *     account, a recovery request or an audit row** — in the markup or in the flight data — and no read is
 *     performed;
 *   * **the six keys are not held together, and the screens show it.** A support agent reads accounts and
 *     is shipped no roles panel and no security panel at all — absent, not empty, because an empty heading
 *     would itself say something was withheld. A moderator reads storefronts and accounts and no roles, no
 *     security record, no recovery and no audit;
 *   * **exactly one recovery control is ever shipped, and only to a colleague the database would accept
 *     it from.** The account holder and the reviewer are shipped the explanation instead, and none of the
 *     control's words;
 *   * **no personal detail and no value ever renders** — no legal name, no phone number, no contact digest,
 *     no object path, no old or new value of an audited row — whatever the API sends;
 *   * **neither capability gap has a control anywhere**: no screen offers to grant a role or to change a
 *     storefront's status, and both say so in words rather than leaving a colleague hunting;
 *   * both languages, the direction that goes with each, and every state: empty, refused, unavailable.
 *
 * No browser, no Playwright, no live provider, no live storage, no deployment.
 */

const CANARY_CREDENTIAL = 'test-admin-operations-pages-canary-notreal1';

const EN = enMessages;
const AR = arMessages;

const ACCESS = '__Host-mp_admin_access=canary-admin-access-token-not-a-real-token';
const REFRESH = '__Host-mp_admin_refresh=canary-admin-refresh-token-not-a-real-tok';
const SESSION = `${ACCESS}; ${REFRESH}`;

const STAFF = '11111111-1111-4111-8111-111111111111';
const TARGET = '22222222-2222-4222-8222-222222222222';
const REQUEST = 'a8000000-0000-4000-8000-000000000001';
const SLUG = 'a-canary-shop';

const SELLERS = 'sellers.profile.read';
const USERS = 'users.profile.read';
const ROLES = 'users.role.read';
const SECURITY = 'users.security.read';
const RECOVERY = 'security.recovery.review';
const AUDIT = 'audit.read';

/** An administrator, as 0033 grants it for these six. */
const SELLERS_MANAGE = 'sellers.profile.manage';
const ADMIN = [SELLERS, USERS, ROLES, SECURITY, RECOVERY, AUDIT, SELLERS_MANAGE].sort();

/** An administrator who can read storefronts and not move one — the read/manage separation, on a screen. */
const SELLER_READER = [SELLERS, USERS].sort();

/** A moderator: storefronts and accounts, and none of the other four. */
const MODERATOR = [SELLERS, USERS, 'moderation.report.read'].sort();

/** A support agent: accounts and recovery, and none of the other four. */
const SUPPORT_AGENT = [USERS, RECOVERY, 'support.ticket.read'].sort();
/**
 * 0100. A colleague who may read accounts and roles *and* change them. Kept separate from `ADMIN` on purpose:
 * every assertion written before this increment describes a colleague without the manage key, and those
 * colleagues must keep seeing exactly what they saw — the roles panel read-only, with its note.
 */
const ROLE_MANAGE = 'users.role.manage';
const ROLE_MANAGER = [USERS, ROLES, ROLE_MANAGE].sort();

/** The one key that still unlocks nothing here, because role assignment has no writer. */
const NEITHER_KEY = ['users.role.manage'].sort();

const SELLER_NAME = 'Canary Shop That Sells Canaries';
const SELLER_BIO = 'Canary description of what this storefront sells.';
const SUSPENSION_REASON = 'Canary reason this storefront was suspended';
const USER_NAME = 'Canary Person With An Account';
const REVIEW_NOTE = 'Canary note about the identity review';
const REJECTION_REASON = 'Canary reason this recovery was rejected';
const EVIDENCE_FILE = 'canary-national-id.jpg';

/** Values that must never render, whatever the API sends. */
const LEGAL_NAME = 'Canary Shop Legal Entity LLC';
const CONTACT_EMAIL = 'canary-owner@test.invalid';
const CONTACT_PHONE = '+201000000777';
const OBJECT_PATH = 'recovery-evidence/a8/canary-national-id.jpg';
const OLD_VALUE = 'canary-old-column-value';
const NEW_VALUE = 'canary-new-column-value';
const COLLEAGUE = '99999999-9999-4999-8999-999999999999';

const SELLER_ROW = {
  slug: SLUG,
  displayName: SELLER_NAME,
  status: 'active',
  verificationStatus: 'verified',
  countryCode: 'EG',
  city: 'Cairo',
  listingCount: 3,
  openReportCount: 1,
  createdAt: '2026-05-01T09:00:00.000Z',
};

const SELLER_DETAIL = {
  ...SELLER_ROW,
  bio: SELLER_BIO,
  contentLanguage: 'en',
  suspendedAt: null,
  suspensionReason: null,
  closedAt: null,
  verifiedAt: '2026-04-01T09:00:00.000Z',
  governorate: 'Cairo',
  liveListingCount: 2,
  isOwnStorefront: false,
  canManage: true,
};

const USER_ROW = {
  id: TARGET,
  displayName: USER_NAME,
  status: 'active',
  localeCode: 'en',
  hasVerifiedEmail: true,
  hasVerifiedPhone: false,
  isStaff: false,
  isSeller: true,
  isSelf: false,
  createdAt: '2026-05-01T09:00:00.000Z',
};

const USER_DETAIL = {
  ...USER_ROW,
  timezone: 'Africa/Cairo',
  sellerSlug: SLUG,
  lastSeenAt: '2026-05-02T09:00:00.000Z',
};

const ROLE_ROW = {
  roleKey: 'moderator',
  nameEn: 'Moderator',
  nameAr: 'مشرف',
  requiresMfa: true,
  isAdminConsole: true,
  grantedAt: '2026-04-01T09:00:00.000Z',
  expiresAt: null,
  revokedAt: null,
  isEffective: true,
  permissionCount: 7,
};

const CATALOGUE_ROW = {
  roleKey: 'moderator',
  nameEn: 'Moderator',
  nameAr: 'مشرف',
  requiresMfa: true,
  isAdminConsole: true,
  isAssignable: true,
  permissionCount: 7,
  holderCount: 2,
};

const EVENT_ROW = {
  id: '42',
  eventType: 'auth.login_failed',
  details: { attempt: 1 },
  occurredAt: '2026-05-03T09:00:00.000Z',
};

const QUEUE_ROW = {
  id: REQUEST,
  status: 'submitted',
  claimedContactChannel: 'email',
  newContactChannel: null,
  matchedAnAccount: true,
  isOwnRequest: false,
  isTheReviewer: false,
  hasBeenReviewed: false,
  contactVerified: false,
  evidenceCount: 2,
  expiresAt: '2026-06-01T09:00:00.000Z',
  createdAt: '2026-05-01T09:00:00.000Z',
};

const REQUEST_DETAIL = {
  id: REQUEST,
  status: 'submitted',
  claimedContactChannel: 'email',
  newContactChannel: null,
  matchedAnAccount: true,
  isOwnRequest: false,
  isTheReviewer: false,
  reviewedByMe: false,
  reviewNote: null,
  reviewedAt: null,
  approvedAt: null,
  rejectionReason: null,
  contactVerifiedAt: null,
  sessionsRevokedAt: null,
  mfaResetAt: null,
  holdUntil: null,
  completedAt: null,
  closedAt: null,
  expiresAt: '2026-06-01T09:00:00.000Z',
  createdAt: '2026-05-01T09:00:00.000Z',
};

const EVIDENCE_ROW = {
  id: 'e8000000-0000-4000-8000-000000000001',
  evidenceType: 'national_id',
  originalFilename: EVIDENCE_FILE,
  contentType: 'image/jpeg',
  byteSize: 120000,
  uploadedAt: '2026-05-01T09:05:00.000Z',
};

const AUDIT_ROW = {
  id: '7',
  occurredAt: '2026-05-04T09:00:00.000Z',
  actorType: 'user',
  isOwnAction: false,
  action: 'update',
  tableSchema: 'public',
  tableName: 'listings',
  recordId: '88880000-0000-4000-8000-000000000001',
  changedColumns: ['status', 'price_minor'],
  requestId: 'req-one',
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
  | 'own'
  | 'reviewer'
  | 'underReview'
  | 'awaitingContact'
  | 'readyToComplete'
  | 'completed'
  | 'rejected'
  | 'suspended'
  | 'suspendedVerified'
  | 'suspendedUnverified'
  | 'pendingSeller'
  | 'closedSeller';

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

function sellerFor(mode: Data): unknown {
  if (mode === 'suspendedVerified') {
    return {
      seller: {
        ...SELLER_DETAIL,
        status: 'suspended',
        verificationStatus: 'verified',
        suspendedAt: '2026-05-02T09:00:00.000Z',
        suspensionReason: SUSPENSION_REASON,
      },
    };
  }
  if (mode === 'suspendedUnverified') {
    return {
      seller: {
        ...SELLER_DETAIL,
        status: 'suspended',
        verificationStatus: 'rejected',
        suspendedAt: '2026-05-02T09:00:00.000Z',
        suspensionReason: SUSPENSION_REASON,
      },
    };
  }
  if (mode === 'pendingSeller') {
    return { seller: { ...SELLER_DETAIL, status: 'pending', verificationStatus: 'unverified', verifiedAt: null } };
  }
  if (mode === 'closedSeller') {
    return {
      seller: {
        ...SELLER_DETAIL,
        status: 'closed',
        closedAt: '2026-05-02T09:00:00.000Z',
      },
    };
  }
  if (mode === 'suspended') {
    return {
      seller: {
        ...SELLER_DETAIL,
        status: 'suspended',
        suspendedAt: '2026-05-02T09:00:00.000Z',
        suspensionReason: SUSPENSION_REASON,
      },
    };
  }
  if (mode === 'own') return { seller: { ...SELLER_DETAIL, isOwnStorefront: true } };
  if (mode === 'leaky') {
    // An API that has drifted and sends the owner's account and contact details. The contract is the wall.
    return {
      seller: {
        ...SELLER_DETAIL,
        userId: COLLEAGUE,
        legalName: LEGAL_NAME,
        contactEmail: CONTACT_EMAIL,
        contactPhoneE164: CONTACT_PHONE,
      },
    };
  }
  return { seller: SELLER_DETAIL };
}

function requestFor(mode: Data): unknown {
  if (mode === 'own') return { request: { ...REQUEST_DETAIL, isOwnRequest: true } };
  if (mode === 'reviewer') {
    return {
      request: {
        ...REQUEST_DETAIL,
        status: 'under_review',
        isTheReviewer: true,
        reviewedByMe: true,
        reviewedAt: '2026-05-02T09:00:00.000Z',
        reviewNote: REVIEW_NOTE,
      },
    };
  }
  if (mode === 'underReview') {
    return {
      request: {
        ...REQUEST_DETAIL,
        status: 'under_review',
        reviewedAt: '2026-05-02T09:00:00.000Z',
        reviewNote: REVIEW_NOTE,
      },
    };
  }
  if (mode === 'awaitingContact') {
    return {
      request: {
        ...REQUEST_DETAIL,
        status: 'contact_verification',
        reviewedAt: '2026-05-02T09:00:00.000Z',
        approvedAt: '2026-05-03T09:00:00.000Z',
        newContactChannel: 'email',
      },
    };
  }
  if (mode === 'readyToComplete') {
    return {
      request: {
        ...REQUEST_DETAIL,
        status: 'contact_verification',
        reviewedAt: '2026-05-02T09:00:00.000Z',
        approvedAt: '2026-05-03T09:00:00.000Z',
        newContactChannel: 'email',
        contactVerifiedAt: '2026-05-04T09:00:00.000Z',
      },
    };
  }
  if (mode === 'completed') {
    return {
      request: {
        ...REQUEST_DETAIL,
        status: 'completed',
        reviewedAt: '2026-05-02T09:00:00.000Z',
        approvedAt: '2026-05-03T09:00:00.000Z',
        contactVerifiedAt: '2026-05-04T09:00:00.000Z',
        sessionsRevokedAt: '2026-05-05T09:00:00.000Z',
        mfaResetAt: '2026-05-05T09:00:00.000Z',
        holdUntil: '2026-05-08T09:00:00.000Z',
        completedAt: '2026-05-05T09:00:00.000Z',
      },
    };
  }
  if (mode === 'rejected') {
    return {
      request: {
        ...REQUEST_DETAIL,
        status: 'rejected',
        reviewedAt: '2026-05-02T09:00:00.000Z',
        rejectionReason: REJECTION_REASON,
        closedAt: '2026-05-03T09:00:00.000Z',
      },
    };
  }
  if (mode === 'leaky') {
    return {
      request: { ...REQUEST_DETAIL, userId: COLLEAGUE, reviewerUserId: COLLEAGUE },
    };
  }
  return { request: REQUEST_DETAIL };
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

    // The API's own gating, modelled: each operation answers 404 for a caller without its key. That is what
    // makes "absent rather than empty" a property of the screen rather than of this stub.
    if (path === '/v1/admin/sellers') {
      if (!held(SELLERS)) return problem(response, 404, 'NOT_FOUND');
      if (data === 'unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      if (data === 'empty') return json(response, { items: [], nextCursor: null });
      return json(response, {
        items: [SELLER_ROW],
        nextCursor: data === 'paged' ? 'c3AxfGNhbmFyeQ' : null,
      });
    }
    if (path === `/v1/admin/sellers/${SLUG}`) {
      if (!held(SELLERS)) return problem(response, 404, 'NOT_FOUND');
      if (data === 'notFound') return problem(response, 404, 'NOT_FOUND');
      if (data === 'unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      // The API's own behaviour, modelled: `canManage` is the manage key on this same session, which is what
      // makes "no control for a read-only colleague" a property of the screen rather than of this stub.
      const body = sellerFor(data) as { seller: Record<string, unknown> };
      return json(response, { seller: { ...body.seller, canManage: held(SELLERS_MANAGE) } });
    }
    if (path === `/v1/admin/sellers/${SLUG}/status`) {
      if (!held(SELLERS_MANAGE)) return problem(response, 404, 'NOT_FOUND');
      return json(response, { outcome: 'updated', status: 'suspended' });
    }
    if (path === '/v1/admin/users') {
      if (!held(USERS)) return problem(response, 404, 'NOT_FOUND');
      if (data === 'unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      if (data === 'empty') return json(response, { items: [], nextCursor: null });
      return json(response, {
        items: [USER_ROW],
        nextCursor: data === 'paged' ? 'YXUxfGNhbmFyeQ' : null,
      });
    }
    if (path === `/v1/admin/users/${TARGET}`) {
      if (!held(USERS)) return problem(response, 404, 'NOT_FOUND');
      if (data === 'notFound') return problem(response, 404, 'NOT_FOUND');
      if (data === 'leaky') {
        return json(response, {
          user: { ...USER_DETAIL, fullName: LEGAL_NAME, phoneE164: CONTACT_PHONE, email: CONTACT_EMAIL },
        });
      }
      return json(response, { user: USER_DETAIL });
    }
    if (path === `/v1/admin/users/${TARGET}/roles`) {
      if (!held(ROLES)) return problem(response, 404, 'NOT_FOUND');
      return json(response, { items: data === 'empty' ? [] : [ROLE_ROW] });
    }
    if (path === `/v1/admin/users/${TARGET}/security-events`) {
      if (!held(SECURITY)) return problem(response, 404, 'NOT_FOUND');
      return json(response, { items: data === 'empty' ? [] : [EVENT_ROW] });
    }
    if (path === '/v1/admin/roles') {
      if (!held(ROLES)) return problem(response, 404, 'NOT_FOUND');
      return json(response, { items: data === 'empty' ? [] : [CATALOGUE_ROW] });
    }
    // 0100. Behind the manage key, and the set is the database's: this stub answers as the API does, with a
    // 404 for a caller who does not hold it, so the console renders no controls at all for them.
    if (path === '/v1/admin/roles/grantable') {
      if (!held(ROLE_MANAGE)) return problem(response, 404, 'NOT_FOUND');
      return json(response, {
        items:
          data === 'empty'
            ? []
            : [
                {
                  roleKey: 'moderator',
                  nameEn: 'Moderator',
                  nameAr: 'مشرف',
                  requiresMfa: true,
                  isAdminConsole: true,
                },
              ],
      });
    }
    if (path === '/v1/admin/recovery/requests') {
      if (!held(RECOVERY)) return problem(response, 404, 'NOT_FOUND');
      if (data === 'unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      if (data === 'empty') return json(response, { items: [], nextCursor: null });
      return json(response, {
        items: [data === 'own' ? { ...QUEUE_ROW, isOwnRequest: true } : QUEUE_ROW],
        nextCursor: data === 'paged' ? 'cnExfGNhbmFyeQ' : null,
      });
    }
    if (path === `/v1/admin/recovery/requests/${REQUEST}`) {
      if (!held(RECOVERY)) return problem(response, 404, 'NOT_FOUND');
      if (data === 'notFound') return problem(response, 404, 'NOT_FOUND');
      if (data === 'unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      return json(response, requestFor(data));
    }
    if (path === `/v1/admin/recovery/requests/${REQUEST}/evidence`) {
      if (!held(RECOVERY)) return problem(response, 404, 'NOT_FOUND');
      if (data === 'leaky') {
        return json(response, { items: [{ ...EVIDENCE_ROW, objectPath: OBJECT_PATH }] });
      }
      return json(response, { items: data === 'empty' ? [] : [EVIDENCE_ROW] });
    }
    if (path === '/v1/admin/audit') {
      if (!held(AUDIT)) return problem(response, 404, 'NOT_FOUND');
      if (data === 'unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      if (data === 'empty') return json(response, { items: [], nextCursor: null });
      if (data === 'leaky') {
        return json(response, {
          items: [{ ...AUDIT_ROW, oldValues: { c: OLD_VALUE }, newValues: { c: NEW_VALUE }, actorId: COLLEAGUE }],
          nextCursor: null,
        });
      }
      return json(response, {
        items: [AUDIT_ROW],
        nextCursor: data === 'paged' ? 'YWQxfGNhbmFyeQ' : null,
      });
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

const SELLERS_PAGE = '/sellers';
const SELLER_PAGE = `/sellers/storefront/${SLUG}`;
const USERS_PAGE = '/users';
const USER_PAGE = `/users/${TARGET}`;
const RECOVERY_PAGE = '/security/recovery';
const REQUEST_PAGE = `/security/recovery/${REQUEST}`;
const AUDIT_PAGE = '/audit';
const ALL = [SELLERS_PAGE, SELLER_PAGE, USERS_PAGE, USER_PAGE, RECOVERY_PAGE, REQUEST_PAGE, AUDIT_PAGE];

/** Everything a refused response must not contain, in markup or flight data. */
const SECRETS = [SELLER_NAME, SELLER_BIO, USER_NAME, REVIEW_NOTE, EVIDENCE_FILE, 'req-one'];

/** Values that must never render on any screen, however they arrive. */
const NEVER = [LEGAL_NAME, CONTACT_EMAIL, CONTACT_PHONE, OBJECT_PATH, OLD_VALUE, NEW_VALUE, COLLEAGUE];

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
    expect(
      api.seen.filter(
        (request) =>
          request.url.includes('/sellers') ||
          request.url.includes('/users') ||
          request.url.includes('/recovery') ||
          request.url.includes('/audit'),
      ),
    ).toHaveLength(0);
  });

  it('a buyer and staff at aal1 receive none of any screen', async () => {
    for (const who of [{ kind: 'buyer' } as const, { kind: 'staff-aal1' } as const]) {
      apiServes({ who });
      for (const path of ALL) {
        const { html } = await get(path);
        for (const secret of SECRETS) expect(html, `${path} :: ${secret}`).not.toContain(secret);
      }
      // 0068 hands an aal1 caller an empty effective set, so no gate passes and no read is made.
      expect(
        api.seen.filter(
          (request) =>
            request.url.startsWith('/v1/admin/sellers') ||
            request.url.startsWith('/v1/admin/users') ||
            request.url.startsWith('/v1/admin/recovery') ||
            request.url.startsWith('/v1/admin/audit'),
        ),
      ).toHaveLength(0);
    }
  });

  it('a colleague holding only the two management keys receives none of any screen', async () => {
    // Every screen is opened by a *read* key. Since 0100 `users.role.manage` has writers behind it, and it
    // still opens no screen on its own: a colleague holding only management keys reaches none of this.
    apiServes({ who: { kind: 'staff', permissions: NEITHER_KEY } });
    for (const path of ALL) {
      const { html } = await get(path);
      expect(html, path).toContain(EN.Console.forbiddenTitle);
      for (const secret of SECRETS) expect(html, `${path} :: ${secret}`).not.toContain(secret);
    }
  });

  it('protects every screen by direct address, not only through a link', async () => {
    apiServes({ who: { kind: 'staff', permissions: [] } });
    for (const path of ALL) {
      const { status, html } = await get(path);
      expect(status, path).toBe(200);
      expect(html, path).toContain(EN.Console.forbiddenTitle);
    }
  });
});

describe('the role writers on the screen (0100)', () => {
  it('ships no role controls at all to a colleague who may only read roles', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get(USER_PAGE);
    // They still see the panel and the note that says they cannot change anything.
    expect(html).toContain(EN.AdminOps.rolesHeading);
    expect(html).toContain(EN.AdminOps.rolesReadOnlyNote);
    // And not one word of the controls ships, which matters because a client component's whole props object
    // is serialised into the payload whether or not it renders.
    for (const absent of [
      EN.AdminOps.roleWriteHeading,
      EN.AdminOps.roleGrantSubmit,
      EN.AdminOps.roleRevokeSubmit,
      EN.AdminOps.roleSessionNote,
      EN.AdminOps.roleReasonLabel,
      EN.AdminOps.roleAboveCeiling,
      EN.AdminOps.roleIsSelf,
    ]) {
      expect(html, absent).not.toContain(absent);
    }
  });

  it('ships the controls to a colleague holding the manage key, and drops the read-only note', async () => {
    apiServes({ who: { kind: 'staff', permissions: ROLE_MANAGER } });
    const { html } = await get(USER_PAGE);
    expect(html).toContain(EN.AdminOps.roleWriteHeading);
    expect(html).toContain(EN.AdminOps.roleGrantSubmit);
    expect(html).toContain(EN.AdminOps.roleReasonLabel);
    expect(html).not.toContain(EN.AdminOps.rolesReadOnlyNote);
  });

  it('says in words that withdrawing a role does not sign anybody out (owner decision 6)', async () => {
    apiServes({ who: { kind: 'staff', permissions: ROLE_MANAGER } });
    const { html } = await get(USER_PAGE);
    expect(html).toContain(EN.AdminOps.roleSessionNote);
  });

  it('offers only the roles the server said may be granted, never a catalogue', async () => {
    apiServes({ who: { kind: 'staff', permissions: ROLE_MANAGER } });
    const { html } = await get(USER_PAGE);
    // The one role the grantable endpoint returned.
    expect(html).toContain('value="moderator"');
    // And nothing the catalogue happens to contain. `super_admin` is never grantable, and `guest` is not
    // assignable, so neither can appear as an option however the catalogue is served.
    expect(html).not.toContain('value="super_admin"');
    expect(html).not.toContain('value="guest"');
    expect(html).not.toContain('value="admin"');
  });

  it('offers no grant control when the caller’s own ceiling admits nothing', async () => {
    apiServes({ who: { kind: 'staff', permissions: ROLE_MANAGER }, data: 'empty' });
    const { html } = await get(USER_PAGE);
    // The panel is still there — they hold the key — and there is nothing to select or submit.
    expect(html).toContain(EN.AdminOps.roleWriteHeading);
    expect(html).not.toContain(EN.AdminOps.roleGrantSubmit);
  });

  it('offers a withdrawal only for a live grant inside the caller’s own ceiling', async () => {
    apiServes({ who: { kind: 'staff', permissions: ROLE_MANAGER } });
    const { html } = await get(USER_PAGE);
    // The fixture account holds `moderator` effectively, and `moderator` is in the grantable set, so the
    // intersection is non-empty and the control appears.
    expect(html).toContain(EN.AdminOps.roleHeldHeading);
    expect(html).toContain(EN.AdminOps.roleRevokeSubmit);
  });

  it('is in Arabic for an Arabic console', async () => {
    apiServes({ who: { kind: 'staff', permissions: ROLE_MANAGER, locale: 'ar' } });
    const { html } = await get(USER_PAGE);
    expect(html).toContain(AR.AdminOps.roleWriteHeading);
    expect(html).toContain(AR.AdminOps.roleSessionNote);
  });
});

describe('the six keys are not held together', () => {
  it('lets a moderator read storefronts and accounts and nothing else', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR } });

    const sellers = await get(SELLERS_PAGE);
    expect(sellers.html).toContain(SELLER_NAME);
    const users = await get(USERS_PAGE);
    expect(users.html).toContain(USER_NAME);

    for (const path of [RECOVERY_PAGE, REQUEST_PAGE, AUDIT_PAGE]) {
      const { html } = await get(path);
      expect(html, path).toContain(EN.Console.forbiddenTitle);
    }
  });

  it('lets a support agent read accounts and recovery and no storefront and no audit', async () => {
    apiServes({ who: { kind: 'staff', permissions: SUPPORT_AGENT } });

    expect((await get(USERS_PAGE)).html).toContain(USER_NAME);
    expect((await get(RECOVERY_PAGE)).html).toContain(EN.AdminOps.openRequest);

    for (const path of [SELLERS_PAGE, SELLER_PAGE, AUDIT_PAGE]) {
      const { html } = await get(path);
      expect(html, path).toContain(EN.Console.forbiddenTitle);
      expect(html, path).not.toContain(SELLER_NAME);
    }
  });

  /**
   * The property this increment exists to get right: reading an account is not reading its roles, and
   * neither is reading its security record. Both panels are **absent**, because an empty heading would
   * itself say there was something withheld.
   */
  it('ships an account’s roles panel only to a colleague holding the role key', async () => {
    apiServes({ who: { kind: 'staff', permissions: SUPPORT_AGENT } });
    const without = await get(USER_PAGE);
    expect(without.html).toContain(USER_NAME);
    expect(without.html).not.toContain(EN.AdminOps.rolesHeading);
    expect(without.html).not.toContain(EN.AdminOps.rolesReadOnlyNote);
    expect(without.html).not.toContain('Moderator');

    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const with_ = await get(USER_PAGE);
    expect(with_.html).toContain(EN.AdminOps.rolesHeading);
    expect(with_.html).toContain('Moderator');
  });

  it('ships an account’s security panel only to a colleague holding the security key', async () => {
    apiServes({ who: { kind: 'staff', permissions: SUPPORT_AGENT } });
    const without = await get(USER_PAGE);
    expect(without.html).not.toContain(EN.AdminOps.securityHeading);
    expect(without.html).not.toContain('auth.login_failed');

    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const with_ = await get(USER_PAGE);
    expect(with_.html).toContain(EN.AdminOps.securityHeading);
    expect(with_.html).toContain('auth.login_failed');
  });

  it('ships the role catalogue only to a colleague holding the role key', async () => {
    apiServes({ who: { kind: 'staff', permissions: SUPPORT_AGENT } });
    expect((await get(USERS_PAGE)).html).not.toContain(EN.AdminOps.catalogueHeading);

    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    expect((await get(USERS_PAGE)).html).toContain(EN.AdminOps.catalogueHeading);
  });
});

describe('what never renders', () => {
  /**
   * The strict contract refuses the whole body rather than trimming it, so a drifted API produces an
   * outage instead of a page missing a field. That is the stronger behaviour: a screen that quietly
   * dropped the extra fields would keep working while the API leaked them to anything else reading it.
   */
  it('refuses a storefront a drifted API sent personal details with, rather than trimming it', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'leaky' });
    const { html } = await get(SELLER_PAGE);
    expect(html).toContain(EN.Console.unavailableTitle);
    for (const secret of [LEGAL_NAME, CONTACT_EMAIL, CONTACT_PHONE, COLLEAGUE, SELLER_NAME]) {
      expect(html, secret).not.toContain(secret);
    }
  });

  it('renders no legal name, phone or email a drifted API sends with an account', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'leaky' });
    const { html } = await get(USER_PAGE);
    for (const secret of [LEGAL_NAME, CONTACT_PHONE, CONTACT_EMAIL]) {
      expect(html, secret).not.toContain(secret);
    }
  });

  it('renders no object path a drifted API sends with recovery evidence', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'leaky' });
    const { html } = await get(REQUEST_PAGE);
    expect(html).not.toContain(OBJECT_PATH);
    expect(html).not.toContain('recovery-evidence/');
  });

  it('refuses an audit page a drifted API sent values with, rather than trimming it', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'leaky' });
    const { html } = await get(AUDIT_PAGE);
    expect(html).toContain(EN.Console.unavailableTitle);
    for (const secret of [OLD_VALUE, NEW_VALUE, COLLEAGUE]) {
      expect(html, secret).not.toContain(secret);
    }
  });

  it('renders the names of the columns that changed, and has no place for their values', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get(AUDIT_PAGE);
    expect(html).toContain('price_minor');
    expect(html).toContain(EN.AdminOps.changedColumnsLabel);
    expect(html).not.toContain('oldValues');
    expect(html).not.toContain('newValues');
  });

  it('renders no colleague behind a recovery request', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'leaky' });
    const { html } = await get(REQUEST_PAGE);
    expect(html).not.toContain(COLLEAGUE);
  });
});

describe('the recovery workflow’s controls', () => {
  it('offers the review control on a submitted request, and only that one', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get(REQUEST_PAGE);
    expect(html).toContain(EN.AdminOps.reviewHeading);
    expect(html).toContain(EN.AdminOps.reviewSubmit);
    expect(html).not.toContain(EN.AdminOps.decisionSubmit);
    expect(html).not.toContain(EN.AdminOps.completionSubmit);
  });

  it('offers the decision control once somebody else has reviewed it', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'underReview' });
    const { html } = await get(REQUEST_PAGE);
    expect(html).toContain(EN.AdminOps.decisionHeading);
    expect(html).toContain(EN.AdminOps.approve);
    expect(html).toContain(EN.AdminOps.reject);
    expect(html).not.toContain(EN.AdminOps.reviewSubmit);
    expect(html).not.toContain(EN.AdminOps.completionSubmit);
  });

  /** The two-person rule, said before the database refuses it. */
  it('offers the reviewer no decision control, and explains why', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'reviewer' });
    const { html } = await get(REQUEST_PAGE);
    expect(html).toContain(EN.AdminOps.isReviewerHint);
    expect(html).not.toContain(EN.AdminOps.decisionSubmit);
    expect(html).not.toContain(EN.AdminOps.approve);
    // Not even the words for the refusal that control would have shipped.
    expect(html).not.toContain(EN.AdminOps.needsAnother);
  });

  it('offers the account holder no control at all, and explains why', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'own' });
    const { html } = await get(REQUEST_PAGE);
    expect(html).toContain(EN.AdminOps.ownRequestHint);
    for (const label of [
      EN.AdminOps.reviewSubmit,
      EN.AdminOps.decisionSubmit,
      EN.AdminOps.completionSubmit,
    ]) {
      expect(html, label).not.toContain(label);
    }
  });

  it('offers no completion until the new contact has been confirmed, and says whose step that is', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'awaitingContact' });
    const { html } = await get(REQUEST_PAGE);
    expect(html).toContain(EN.AdminOps.awaitingContactHint);
    expect(html).not.toContain(EN.AdminOps.completionSubmit);
  });

  it('offers the completion control once the contact has been confirmed', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'readyToComplete' });
    const { html } = await get(REQUEST_PAGE);
    expect(html).toContain(EN.AdminOps.completionHeading);
    expect(html).toContain(EN.AdminOps.mfaWasResetLabel);
    expect(html).not.toContain(EN.AdminOps.reviewSubmit);
    expect(html).not.toContain(EN.AdminOps.decisionSubmit);
  });

  it('offers nothing on a request already finished, and shows what finishing it did', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'completed' });
    const { html } = await get(REQUEST_PAGE);
    expect(html).toContain(EN.AdminOps.noStepHint);
    expect(html).toContain(EN.AdminOps.holdUntilLabel);
    expect(html).toContain(EN.AdminOps.sessionsRevokedLabel);
    for (const label of [
      EN.AdminOps.reviewSubmit,
      EN.AdminOps.decisionSubmit,
      EN.AdminOps.completionSubmit,
    ]) {
      expect(html, label).not.toContain(label);
    }
  });

  it('offers nothing on a rejected request, and shows the reason', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'rejected' });
    const { html } = await get(REQUEST_PAGE);
    expect(html).toContain(REJECTION_REASON);
    expect(html).toContain(EN.AdminOps.noStepHint);
    expect(html).not.toContain(EN.AdminOps.decisionSubmit);
  });

  it('ships no recovery control at all on the queue', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get(RECOVERY_PAGE);
    for (const label of [
      EN.AdminOps.reviewSubmit,
      EN.AdminOps.decisionSubmit,
      EN.AdminOps.completionSubmit,
    ]) {
      expect(html, label).not.toContain(label);
    }
  });

  it('flags the reader’s own request in the queue before they open it', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'own' });
    const { html } = await get(RECOVERY_PAGE);
    expect(html).toContain(EN.AdminOps.ownRequestHint);
  });
});

describe('role assignment has no control anywhere', () => {
  it('offers none, and says why', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get(USER_PAGE);
    expect(html).toContain(EN.AdminOps.rolesReadOnlyNote);
    // No form, no button, no field that could carry a role key.
    expect(html).not.toContain('name="roleKey"');
    expect(html).not.toContain('/api/roles');
    expect(html).not.toContain('/api/users');
  });

  it('renders the account, list and audit screens without a single form', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    for (const path of [SELLERS_PAGE, USERS_PAGE, USER_PAGE, AUDIT_PAGE]) {
      const { html } = await get(path);
      expect(html, path).not.toContain('<form');
    }
  });
});

describe('the seller status control', () => {
  /**
   * The control offers only what the storefront can legally reach, and a status it cannot reach is **absent
   * rather than disabled** — so its label never enters the payload.
   */
  it('offers suspend and close on an active storefront, and not the two reinstatements', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get(SELLER_PAGE);
    expect(html).toContain(EN.AdminOps.statusHeading);
    expect(html).toContain('value="suspended"');
    expect(html).toContain('value="closed"');
    expect(html).not.toContain('value="active"');
    expect(html).not.toContain('value="pending"');
  });

  it('offers suspend and close on a pending storefront, and never active', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'pendingSeller' });
    const { html } = await get(SELLER_PAGE);
    expect(html).toContain('value="suspended"');
    expect(html).toContain('value="closed"');
    // Activation is the verification approval's, not this screen's.
    expect(html).not.toContain('value="active"');
  });

  it('offers active on a suspended storefront that is verified, and not pending', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'suspendedVerified' });
    const { html } = await get(SELLER_PAGE);
    expect(html).toContain('value="active"');
    expect(html).toContain('value="closed"');
    expect(html).not.toContain('value="pending"');
  });

  it('offers pending on a suspended storefront that is not verified, and not active', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'suspendedUnverified' });
    const { html } = await get(SELLER_PAGE);
    expect(html).toContain('value="pending"');
    expect(html).toContain('value="closed"');
    expect(html).not.toContain('value="active"');
  });

  it('offers nothing at all on a closed storefront, and says it is final', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'closedSeller' });
    const { html } = await get(SELLER_PAGE);
    expect(html).toContain(EN.AdminOps.sellerTerminalNote);
    expect(html).not.toContain(EN.AdminOps.statusHeading);
    expect(html).not.toContain('<form');
    // Not even the confirmation words for a move that cannot be made.
    expect(html).not.toContain(EN.AdminOps.confirmReinstate);
  });

  /** The read/manage separation, on a screen: a colleague who can read a storefront cannot move one. */
  it('is not shipped to a colleague holding only the seller read key', async () => {
    apiServes({ who: { kind: 'staff', permissions: SELLER_READER } });
    const { html } = await get(SELLER_PAGE);
    expect(html).toContain(SELLER_NAME);
    expect(html).not.toContain(EN.AdminOps.statusHeading);
    expect(html).not.toContain('<form');
  });

  it('is not shipped to a moderator or a support agent', async () => {
    for (const permissions of [MODERATOR, SUPPORT_AGENT]) {
      apiServes({ who: { kind: 'staff', permissions } });
      const { html } = await get(SELLER_PAGE);
      expect(html).not.toContain(EN.AdminOps.statusHeading);
      expect(html).not.toContain('/api/sellers/status');
    }
  });

  it('is withheld by the capability on the row, not by a guess on the page', async () => {
    apiServes({ who: { kind: 'staff', permissions: SELLER_READER } });
    const withheld = (await get(SELLER_PAGE)).html;
    expect(withheld).toContain(SELLER_NAME);
    // Not the control, not its confirmations, not the terminal note — none of the words for a capability
    // this colleague does not have.
    for (const label of [
      EN.AdminOps.statusHeading,
      EN.AdminOps.statusSubmit,
      EN.AdminOps.confirmSuspend,
      EN.AdminOps.confirmClose,
      EN.AdminOps.confirmReinstate,
      EN.AdminOps.sellerTerminalNote,
    ]) {
      expect(withheld, label).not.toContain(label);
    }
  });

  it('says verification is decided elsewhere', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    expect((await get(SELLER_PAGE)).html).toContain(EN.AdminOps.sellerVerificationNote);
  });

  it('carries no timestamp or verification field in its payload', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const payload = (await get(SELLER_PAGE)).html.replaceAll('\\"', '"');
    for (const forbidden of ['suspendedAt"', 'closedAt"', 'verificationStatus"', 'verifiedAt"']) {
      expect(payload, forbidden).not.toContain(`"${forbidden}`);
    }
  });

  it('renders in Arabic', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN, locale: 'ar' } });
    const { html } = await get(SELLER_PAGE);
    expect(html).toContain('dir="rtl"');
    expect(html).toContain(AR.AdminOps.statusHeading);
    expect(html).toContain(AR.AdminOps.statusSubmit);
    expect(html).not.toContain(EN.AdminOps.statusHeading);
  });
});

describe('every state is a state', () => {
  it('renders an empty list rather than nothing, on each of the four', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'empty' });
    expect((await get(SELLERS_PAGE)).html).toContain(EN.AdminOps.sellersEmptyTitle);
    expect((await get(USERS_PAGE)).html).toContain(EN.AdminOps.usersEmptyTitle);
    expect((await get(RECOVERY_PAGE)).html).toContain(EN.AdminOps.recoveryEmptyTitle);
    expect((await get(AUDIT_PAGE)).html).toContain(EN.AdminOps.auditEmptyTitle);
  });

  it('renders an outage rather than a half page', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'unavailable' });
    for (const path of [SELLERS_PAGE, SELLER_PAGE, USERS_PAGE, RECOVERY_PAGE, REQUEST_PAGE, AUDIT_PAGE]) {
      const { html } = await get(path);
      expect(html, path).toContain(EN.Console.unavailableTitle);
      for (const secret of SECRETS) expect(html, `${path} :: ${secret}`).not.toContain(secret);
    }
  });

  it('renders a not-found for an address that names nothing', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'notFound' });
    for (const path of [SELLER_PAGE, USER_PAGE, REQUEST_PAGE]) {
      const { html } = await get(path);
      expect(html, path).toContain(EN.AdminOps.notFoundTitle);
    }
  });

  it('renders a not-found for a malformed address without calling the API', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    for (const path of [
      '/sellers/storefront/Not_A_Slug',
      '/users/not-a-uuid',
      '/security/recovery/not-a-uuid',
    ]) {
      const { html } = await get(path);
      expect(html, path).toContain(EN.AdminOps.notFoundTitle);
    }
  });

  it('offers a next page exactly when the API says there is one', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'paged' });
    for (const path of [SELLERS_PAGE, USERS_PAGE, RECOVERY_PAGE, AUDIT_PAGE]) {
      expect((await get(path)).html, path).toContain(EN.AdminOps.nextPage);
    }

    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    for (const path of [SELLERS_PAGE, USERS_PAGE, RECOVERY_PAGE, AUDIT_PAGE]) {
      expect((await get(path)).html, path).not.toContain(EN.AdminOps.nextPage);
    }
  });

  it('shows a suspension with its reason', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'suspended' });
    const { html } = await get(SELLER_PAGE);
    expect(html).toContain(SUSPENSION_REASON);
    expect(html).toContain(EN.AdminOps.sellerStatus.suspended);
  });
});

describe('both languages', () => {
  it('renders every screen in Arabic, right to left, with none of the English', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN, locale: 'ar' } });
    for (const [path, en, ar] of [
      [SELLERS_PAGE, EN.AdminOps.sellersIntro, AR.AdminOps.sellersIntro],
      [USERS_PAGE, EN.AdminOps.usersIntro, AR.AdminOps.usersIntro],
      [RECOVERY_PAGE, EN.AdminOps.recoveryIntro, AR.AdminOps.recoveryIntro],
      [AUDIT_PAGE, EN.AdminOps.auditIntro, AR.AdminOps.auditIntro],
    ] as const) {
      const { html } = await get(path);
      expect(html, path).toContain('dir="rtl"');
      expect(html, path).toContain('lang="ar"');
      expect(html, path).toContain(ar);
      expect(html, path).not.toContain(en);
    }
  });

  it('renders the recovery controls in Arabic', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN, locale: 'ar' }, data: 'underReview' });
    const { html } = await get(REQUEST_PAGE);
    expect(html).toContain(AR.AdminOps.decisionSubmit);
    expect(html).toContain(AR.AdminOps.approve);
    expect(html).not.toContain(EN.AdminOps.decisionSubmit);
  });

  it('refuses in Arabic too, with none of the data', async () => {
    apiServes({ who: { kind: 'staff', permissions: [], locale: 'ar' } });
    for (const path of ALL) {
      const { html } = await get(path);
      expect(html, path).toContain('dir="rtl"');
      expect(html, path).toContain(AR.Console.forbiddenTitle);
      for (const secret of SECRETS) expect(html, `${path} :: ${secret}`).not.toContain(secret);
    }
  });

  it('renders each screen left to right in English', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN, locale: 'en' } });
    for (const path of ALL) {
      const { html } = await get(path);
      expect(html, path).toContain('dir="ltr"');
      expect(html, path).toContain('lang="en"');
    }
  });
});

describe('what the payload carries', () => {
  it('carries the storefront’s facts and never the owner’s', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get(SELLER_PAGE);
    // The flight payload escapes its own quotes, so it is unescaped before anything is looked for in it.
    const payload = html.replaceAll('\\"', '"');
    expect(payload).toContain(SELLER_NAME);
    for (const secret of NEVER) expect(payload, secret).not.toContain(secret);
  });

  it('carries no control’s words when no control is on the screen', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'completed' });
    const payload = (await get(REQUEST_PAGE)).html.replaceAll('\\"', '"');
    for (const label of [
      EN.AdminOps.reviewConfirm,
      EN.AdminOps.decisionConfirm,
      EN.AdminOps.completionConfirm,
      EN.AdminOps.needsAnother,
    ]) {
      expect(payload, label).not.toContain(label);
    }
  });

  it('carries only the step’s own words when one control is on the screen', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'readyToComplete' });
    const payload = (await get(REQUEST_PAGE)).html.replaceAll('\\"', '"');
    expect(payload).toContain(EN.AdminOps.completionConfirm);
    // The other two steps' confirmations, and the two-person refusal, are not this step's to carry.
    expect(payload).not.toContain(EN.AdminOps.reviewConfirm);
    expect(payload).not.toContain(EN.AdminOps.decisionConfirm);
    expect(payload).not.toContain(EN.AdminOps.needsAnother);
  });

  it('never carries the internal credential or the session token', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    for (const path of ALL) {
      const { html } = await get(path);
      expect(html, path).not.toContain(CANARY_CREDENTIAL);
      expect(html, path).not.toContain('canary-admin-access-token-not-a-real-token');
    }
  });
});

describe('the reads happen inside the gate', () => {
  it('performs no read for a refused colleague, on any screen', async () => {
    apiServes({ who: { kind: 'staff', permissions: [] } });
    for (const path of ALL) await get(path);
    const reads = api.seen.filter((request) => !request.url.startsWith('/v1/admin/session'));
    expect(reads.map((request) => request.url)).toEqual([]);
  });

  it('performs exactly the reads the screen needs, and no write', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    await get(USER_PAGE);
    const reads = api.seen.filter((request) => !request.url.startsWith('/v1/admin/session'));
    // Four reads since 0100: the account, its roles, its security timeline, and the grantable set — which is
    // asked for unconditionally, because the API answers it with a 404 for a caller without the manage key and
    // a branch here could drift from that.
    expect(reads.map((request) => request.url.split('?')[0]).sort()).toEqual([
      '/v1/admin/roles/grantable',
      `/v1/admin/users/${TARGET}`,
      `/v1/admin/users/${TARGET}/roles`,
      `/v1/admin/users/${TARGET}/security-events`,
    ]);
    // Still not one write: opening an account changes nothing, role writers or no role writers.
    expect(reads.every((request) => request.method === 'GET')).toBe(true);
  });

  it('reads nothing but the trail on the audit screen, and never writes to it', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    await get(AUDIT_PAGE);
    const reads = api.seen.filter((request) => !request.url.startsWith('/v1/admin/session'));
    expect(reads.every((request) => request.method === 'GET')).toBe(true);
    expect(reads.map((request) => request.url.split('?')[0])).toEqual(['/v1/admin/audit']);
  });
});
