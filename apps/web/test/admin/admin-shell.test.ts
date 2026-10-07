import type { ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import arMessages from '../../messages/admin/ar.json';
import enMessages from '../../messages/admin/en.json';
import { CONSOLE_SECTIONS } from '../../src/admin/server/console-sections';
import { startBuiltApp, type RunningApp } from '../support/next-server.js';
import { problem, startStubApi, type StubApi } from '../support/stub-api.js';

/**
 * Where the console is mounted (0108). Every address in this file is console-relative, exactly as it was while the
 * console was an application of its own; this is the one place that turns it into the address the server answers.
 */
const CONSOLE = '/admin';

/**
 * The admin application shell, over real HTTP against the built app (Phase 7-F).
 *
 * Run against the built app rather than a unit harness because what matters is what actually reaches a
 * browser, **including the streamed RSC payload** — the whole reason the gate is a component inside
 * each page rather than a layout. The assertions fall into five groups:
 *
 *   * **who is refused** — a guest, a buyer, a seller, staff at aal1, and staff at aal2 holding the
 *     wrong permission — and that all of them receive the same neutral answer except the one case that
 *     is theirs to act on;
 *   * **who is admitted, and to exactly what** — a support agent reaches support and not moderation, a
 *     moderator the reverse, and each of them by direct address as well as through a link;
 *   * **what is absent** — no section a person may not open appears anywhere in the response, markup
 *     and flight data alike; no permission set is accepted from a browser; no token or credential is
 *     ever in a page;
 *   * **the shell itself** — header, account area, language switch, responsive navigation, active
 *     state, loading, error and empty states;
 *   * **both languages, and the direction that goes with each.**
 *
 * No browser, no Playwright, no live provider, no deployment.
 */

// Exactly 43 base64url characters: the admin app's env validation refuses any other length at startup.
const CANARY_CREDENTIAL = 'test-admin-shell-canary-credential-notrea12';

const EN = enMessages;
const AR = arMessages;

const ACCESS = '__Host-mp_admin_access=canary-admin-access-token-not-a-real-token';
const REFRESH = '__Host-mp_admin_refresh=canary-admin-refresh-token-not-a-real-tok';
const SESSION = `${ACCESS}; ${REFRESH}`;

const STAFF_ID = '11111111-1111-4111-8111-111111111111';

const SUPPORT_PERMISSIONS = [
  'orders.order.read',
  'security.recovery.review',
  'support.ticket.manage',
  'support.ticket.read',
  'users.profile.read',
];

const MODERATOR_PERMISSIONS = [
  'catalog.listing.moderate',
  'catalog.listing.read',
  'moderation.action.read',
  'moderation.report.manage',
  'moderation.report.read',
  'reviews.review.moderate',
  'reviews.review.read',
  'sellers.profile.read',
  'users.profile.read',
];

const ADMIN_PERMISSIONS = [
  ...new Set([
    ...SUPPORT_PERMISSIONS,
    ...MODERATOR_PERMISSIONS,
    'audit.read',
    'disputes.dispute.read',
    'platform.job.read',
    'users.role.manage',
    // 7-G: the seed gives this to admin and super_admin only, which is why it is absent from both sets
    // above. A moderator holds `sellers.profile.read` and not this one, so the two seller sections are
    // a real test of permission-driven navigation rather than a duplicate of each other.
    'sellers.verification.review',
    // 7-J: likewise admin and super_admin only, and likewise held by neither narrow console role — so the
    // Admin Only service request section is another real test of the same mechanism.
    'service_requests.request.read',
    // The static pages section: admin and super_admin only in the seed, and held by neither narrow console
    // role, so it is a further real test of the same mechanism. `cms.page.manage` is deliberately absent —
    // it gates the authoring controls inside the section, not the section itself.
    'cms.page.read',
    // The category tree: admin and super_admin only in the seed, and held by neither narrow console role, so it
    // is another real test of the same mechanism. `catalog.category.manage` is deliberately absent — it gates the
    // controls inside the section, not the section itself, which `catalog.category.read` does.
    'catalog.category.read',
    // 8-C's two vocabularies, and the one place a section is gated on a manage key: neither
    // `catalog.attribute.read` nor `catalog.tag.read` exists in the seed, and neither was invented, so each
    // section is gated on the key its own table's RLS policy names. Both are admin and super_admin only.
    'catalog.attribute.manage',
    'catalog.tag.manage',
    // 8-E's redirect map: admin and super_admin only in the seed, and held by neither narrow console role, so it is
    // another real test of the same mechanism. `seo.redirect.manage` is deliberately absent — it gates the controls
    // inside the section, not the section itself, which `seo.redirect.read` does.
    'seo.redirect.read',
    // 8-F's metadata overrides: the same mechanism once more, and a second key in the same module, so the two SEO
    // sections are a real test of permission-driven navigation rather than one entry twice.
    'seo.metadata.read',
    'cms.blog.read',
    'cms.homepage.read',
    // 0094's navigation menus: admin and super_admin only in the seed, and held by neither narrow console role, so
    // it is another real test of the same mechanism. `cms.navigation.manage` is deliberately absent — it gates the
    // controls inside the section, not the section itself, which `cms.navigation.read` does.
    'cms.navigation.read',
    // 0095's help centre: admin and super_admin only in the seed, and held by neither narrow console role, so it is
    // another real test of the same mechanism. `cms.faq.manage` is deliberately absent — it gates the controls
    // inside the section, not the section itself, which `cms.faq.read` does.
    'cms.faq.read',
    // 0096's site-wide SEO defaults, and the third place a section is gated on a **manage** key: `seo.settings.read`
    // does not exist in the seed and was not invented, so the section is gated on the key its own table's RLS policy
    // names. Admin and super_admin only, and held by neither narrow console role.
    'seo.settings.manage',
    // 0098's media library, and the fourth place a section is gated on a **manage** key: `cms.media.read` does not
    // exist in the seed and was not invented, so the section is gated on the key its own table's RLS policy names.
    // Admin and super_admin only, and held by neither narrow console role.
    'cms.media.manage',
    // 0102's listing analytics, and the first section in the `analytics` module. Seeded since 0033 and consumed by
    // nothing until that increment; admin and super_admin only, and held by neither narrow console role, so it is
    // another real test of permission-driven navigation.
    'analytics.listing.read',
  ]),
].sort();

type Who =
  | { kind: 'staff'; roles: string[]; permissions: string[]; locale?: 'en' | 'ar'; name?: string | null }
  | { kind: 'staff-aal1' }
  | { kind: 'buyer' }
  | { kind: 'seller' }
  | { kind: 'unauthenticated' }
  | { kind: 'unavailable' };

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

function apiServes(who: Who): void {
  api.seen.length = 0;
  api.reply((request, response) => {
    const [path] = request.url.split('?');

    if (path !== '/v1/admin/session') return problem(response, 404, 'NOT_FOUND');
    if (who.kind === 'unauthenticated') return problem(response, 401, 'AUTHENTICATION_REQUIRED');
    if (who.kind === 'unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');

    const base = { id: STAFF_ID, displayName: 'Nadia', localeCode: 'en' };
    if (who.kind === 'buyer' || who.kind === 'seller') {
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
        id: STAFF_ID,
        displayName: who.name === undefined ? 'Nadia' : who.name,
        localeCode: who.locale ?? 'en',
        isStaff: true,
        requiresStepUp: false,
        roles: who.roles,
        permissions: who.permissions,
      },
    });
  });
}

const staff = (roles: string[], permissions: string[], extra: Partial<{ locale: 'en' | 'ar'; name: string | null }> = {}): Who => ({
  kind: 'staff',
  roles,
  permissions,
  ...extra,
});

async function get(path: string, cookie = SESSION): Promise<{ status: number; html: string }> {
  const response = await fetch(`${app.baseUrl}${CONSOLE}${path}`, {
    redirect: 'manual',
    headers: cookie === '' ? {} : { cookie },
  });
  return { status: response.status, html: await response.text() };
}

// Console-relative, as every address in this file is: '' is the console's own root, which the `get` helper turns
// into `/admin` — not `/admin/`, which Next.js answers with a 308 to the former.
const PROTECTED = ['', ...CONSOLE_SECTIONS.map((section) => section.href)];

/**
 * The rendered `<main>`, with the per-request CSP nonce removed.
 *
 * Two refusals that are the same refusal still differ in their script tags, because the nonce is fresh
 * on every request. Comparing what a person actually reads is the assertion that was meant.
 */
function refusalOf(html: string): string {
  const main = /<main[^>]*>([\s\S]*?)<\/main>/.exec(html);
  return (main?.[1] ?? html).replace(/nonce="[^"]*"/g, 'nonce=""');
}

/* ------------------------------------------------------------------------------------------------ */

describe('who is refused', () => {
  it('a guest, with no cookie at all, receives the signed-out state and no console', async () => {
    apiServes({ kind: 'unauthenticated' });
    for (const path of PROTECTED) {
      const { status, html } = await get(path, '');
      expect(status, path).toBe(200);
      expect(html, path).toContain(EN.Console.signedOutTitle);
      expect(html, path).toContain('/login');
      expect(html, path).not.toContain(EN.Console.sectionsLabel);
      expect(html, path).not.toContain(EN.Console.comingSoonTitle);
    }
  });

  it('never even asks the API when there is no session cookie', async () => {
    apiServes({ kind: 'unauthenticated' });
    await get('/moderation/reports', '');
    expect(api.seen).toEqual([]);
  });

  it('a signed-in buyer receives the neutral refusal everywhere', async () => {
    apiServes({ kind: 'buyer' });
    for (const path of PROTECTED) {
      const { status, html } = await get(path);
      expect(status, path).toBe(200);
      expect(html, path).toContain(EN.Console.forbiddenTitle);
      expect(html, path).toContain(EN.Console.forbiddenBody);
      expect(html, path).not.toContain(EN.Console.sectionsLabel);
    }
  });

  it('a signed-in seller receives exactly the same refusal as a buyer', async () => {
    // Compared on the rendered body rather than the whole document: the CSP nonce is per request, so
    // two identical pages differ in their script tags and in nothing else.
    apiServes({ kind: 'seller' });
    const seller = await get('/support');
    apiServes({ kind: 'buyer' });
    const buyer = await get('/support');

    expect(refusalOf(seller.html)).toBe(refusalOf(buyer.html));
    expect(refusalOf(seller.html)).toContain(EN.Console.forbiddenBody);
  });

  it('staff at aal1 are refused every protected surface, and told to step up', async () => {
    apiServes({ kind: 'staff-aal1' });
    for (const path of PROTECTED) {
      const { status, html } = await get(path);
      expect(status, path).toBe(200);
      expect(html, path).toContain(EN.Console.stepUpTitle);
      expect(html, path).toContain('/security/totp');
      // Nothing of the console itself: not the navigation, not a section, not its body.
      expect(html, path).not.toContain(EN.Console.sectionsLabel);
      expect(html, path).not.toContain(EN.Sections.moderation.title);
      expect(html, path).not.toContain(EN.Console.comingSoonTitle);
    }
  });

  it('staff at aal2 without the permission are refused that section, neutrally', async () => {
    apiServes(staff(['support_agent'], SUPPORT_PERMISSIONS));
    const { status, html } = await get('/moderation/reports');

    expect(status).toBe(200);
    expect(html).toContain(EN.Console.forbiddenTitle);
    // The refusal names no permission, no role and no section.
    expect(html).not.toContain('moderation.report.read');
    expect(html).not.toContain(EN.Sections.moderation.description);
    expect(html).not.toContain(EN.Console.comingSoonTitle);
  });

  it('gives the same refusal to a buyer and to staff who lack one permission', async () => {
    apiServes(staff(['support_agent'], SUPPORT_PERMISSIONS));
    const wrongSection = await get('/moderation/reports');
    apiServes({ kind: 'buyer' });
    const notStaff = await get('/moderation/reports');

    // Indistinguishable: a moderator's section says nothing different to somebody who is not staff.
    expect(refusalOf(wrongSection.html)).toBe(refusalOf(notStaff.html));
  });

  it('refuses the console home to staff who hold no console permission at all', async () => {
    apiServes(staff([], []));
    const { html } = await get('');
    expect(html).toContain(EN.Console.forbiddenTitle);
    expect(html).not.toContain(EN.Console.sectionsLabel);
  });
});

describe('who is admitted, and to what', () => {
  it('lets a support agent into support', async () => {
    apiServes(staff(['support_agent'], SUPPORT_PERMISSIONS));
    const { status, html } = await get('/support');

    expect(status).toBe(200);
    expect(html).toContain(EN.Sections.support.title);
    expect(html).toContain(EN.Sections.support.description);
    // 7-L replaced this section's empty state with the agent console, so the placeholder is gone and the
    // two lists are what an admitted colleague sees. The stub here serves only the session endpoint, so the
    // lists themselves render their own refusal — the section being reachable is what this test is about.
    expect(html).toContain(EN.SupportConsole.queueHeading);
    expect(html).toContain(EN.SupportConsole.assignedHeading);
    expect(html).not.toContain(EN.Console.comingSoonTitle);
  });

  it('lets a moderator into moderation and not into support', async () => {
    apiServes(staff(['moderator'], MODERATOR_PERMISSIONS));
    const moderation = await get('/moderation/reports');
    // 7-N gave this section its own screen, so the page renders the section's title and the queue's own
    // introduction rather than the placeholder's description. Admission is what this asserts either way.
    expect(moderation.html).toContain(EN.Sections.moderation.title);
    expect(moderation.html).toContain(EN.Moderation.reportsIntro);

    const support = await get('/support');
    expect(support.html).toContain(EN.Console.forbiddenTitle);
    expect(support.html).not.toContain(EN.Sections.support.description);
  });

  /**
   * What proves admission to one section.
   *
   * A section still carrying 7-F's placeholder is admitted when its description renders. A section a later
   * increment has replaced with a real screen renders that screen's own introduction instead, so the marker
   * moves with it — and the assertion stays about admission rather than about which increment last touched
   * the page. 7-O replaced four: sellers, users, account recovery and audit. 7-P replaced reviews, and 7-Q
   * replaced platform jobs, and 7-R replaced disputes — the last of 7-F's placeholders. Sections added since,
   * the blog among them, were never placeholders and bring their own introduction with them.
   */
  function admissionMarker(id: string): string {
    if (id === 'sellers') return EN.AdminOps.sellersIntro;
    if (id === 'users') return EN.AdminOps.usersIntro;
    if (id === 'recovery') return EN.AdminOps.recoveryIntro;
    if (id === 'audit') return EN.AdminOps.auditIntro;
    if (id === 'moderation') return EN.Moderation.reportsIntro;
    if (id === 'reviews') return EN.Reviews.queueIntro;
    if (id === 'platform') return EN.Platform.pageIntro;
    if (id === 'disputes') return EN.Disputes.queueIntro;
    // 0092's blog arrived as a real screen rather than as a placeholder, so its own introduction is the marker.
    if (id === 'blog') return EN.Blog.pageIntro;
    if (id === 'homepage') return EN.Homepage.pageIntro;
    return EN.Sections[id as 'support'].description;
  }

  it('protects each section by direct address, not only through a link', async () => {
    apiServes(staff(['support_agent'], SUPPORT_PERMISSIONS));
    const allowed = new Set(
      CONSOLE_SECTIONS.filter((section) => SUPPORT_PERMISSIONS.includes(section.permission)).map((s) => s.href),
    );
    for (const section of CONSOLE_SECTIONS) {
      const { html } = await get(section.href);
      const marker = admissionMarker(section.id);
      if (allowed.has(section.href)) {
        expect(html, section.href).toContain(marker);
      } else {
        expect(html, section.href).toContain(EN.Console.forbiddenTitle);
        // Neither the placeholder's words nor the real screen's: a refused section renders no part of
        // itself, which is the whole point of putting the gate inside the page.
        expect(html, section.href).not.toContain(marker);
        expect(html, section.href).not.toContain(EN.Sections[section.id as 'support'].description);
      }
    }
  });

  it('lets an administrator into every section the console has', async () => {
    apiServes(staff(['admin'], ADMIN_PERMISSIONS));
    for (const section of CONSOLE_SECTIONS) {
      const { status, html } = await get(section.href);
      expect(status, section.href).toBe(200);
      expect(html, section.href).toContain(EN.Sections[section.id as 'support'].title);
    }
  });
});

describe('the navigation reveals nothing unauthorized', () => {
  it('shows a support agent their sections and nobody else’s', async () => {
    apiServes(staff(['support_agent'], SUPPORT_PERMISSIONS));
    const { html } = await get('');

    for (const section of CONSOLE_SECTIONS) {
      const permitted = SUPPORT_PERMISSIONS.includes(section.permission);
      const title = EN.Sections[section.id as 'support'].title;
      if (permitted) expect(html, section.id).toContain(`href="/admin${section.href}"`);
      else {
        expect(html, section.id).not.toContain(`href="/admin${section.href}"`);
        expect(html, section.id).not.toContain(title);
      }
    }
  });

  it('shows a moderator theirs, and the two sets genuinely differ', async () => {
    apiServes(staff(['moderator'], MODERATOR_PERMISSIONS));
    const { html } = await get('');

    expect(html).toContain('href="/admin/moderation/reports"');
    expect(html).toContain('href="/admin/reviews"');
    expect(html).not.toContain('href="/admin/support"');
    expect(html).not.toContain('href="/admin/audit"');
    expect(html).not.toContain(EN.Sections.support.title);
  });

  it('does not ship a section a person may not open, flight data included', async () => {
    apiServes(staff(['support_agent'], SUPPORT_PERMISSIONS));
    const { html } = await get('/support');
    // The unauthorized sections are not hidden in this response; they were never sent.
    for (const forbidden of ['audit.read', 'platform.job.read', 'disputes.dispute.read', 'moderation.report.read']) {
      expect(html, forbidden).not.toContain(forbidden);
    }
    expect(html).not.toContain(EN.Sections.audit.title);
    expect(html).not.toContain(EN.Sections.platform.title);
  });

  it('marks the section being read as the current page, and not by weight alone', async () => {
    apiServes(staff(['moderator'], MODERATOR_PERMISSIONS));
    const { html } = await get('/moderation/reports');
    expect(html).toContain('aria-current="page"');
  });
});

describe('permission state cannot come from the browser', () => {
  it('ignores a cookie that claims permissions', async () => {
    apiServes({ kind: 'buyer' });
    const { html } = await get(
      '/audit',
      `${SESSION}; permissions=audit.read; isStaff=true; aal=aal2; role=super_admin`,
    );
    expect(html).toContain(EN.Console.forbiddenTitle);
    expect(html).not.toContain(EN.Sections.audit.description);
  });

  it('ignores a query string that claims them', async () => {
    apiServes({ kind: 'buyer' });
    const { html } = await get('/audit?permissions=audit.read&isStaff=true&aal=aal2');
    expect(html).toContain(EN.Console.forbiddenTitle);
  });

  it('ignores headers that claim them', async () => {
    apiServes({ kind: 'buyer' });
    const response = await fetch(`${app.baseUrl}${CONSOLE}/audit`, {
      redirect: 'manual',
      headers: {
        cookie: SESSION,
        'x-permissions': 'audit.read',
        'x-aal': 'aal2',
        'x-staff': 'true',
        'x-role': 'super_admin',
      },
    });
    expect(await response.text()).toContain(EN.Console.forbiddenTitle);
  });

  it('sends the API nothing but the caller’s own token and the internal credential', async () => {
    apiServes(staff(['admin'], ADMIN_PERMISSIONS));
    await get('/audit');

    expect(api.seen.length).toBeGreaterThan(0);
    for (const request of api.seen) {
      // 7-O gave this section a real screen, so the page now resolves the session *and* reads the audit
      // trail. What this asserts is unchanged and is the point of the test: whatever it calls, it is a
      // read on the admin surface carrying nothing but the caller's own token and the internal credential.
      expect(request.url.startsWith('/v1/admin/')).toBe(true);
      expect(request.method).toBe('GET');
      expect(request.body).toBe('');
      // The browser's own cookie header never travels onward; the internal credential does.
      expect(request.cookie).toBeNull();
      expect(request.credential).toBe(CANARY_CREDENTIAL);
    }
  });
});

describe('the shell itself', () => {
  it('renders the header, the account area and the language switch', async () => {
    apiServes(staff(['admin'], ADMIN_PERMISSIONS, { name: 'Nadia' }));
    const { html } = await get('');

    expect(html).toContain('Marketplace');
    expect(html).toContain('Nadia');
    expect(html).toContain(EN.Sections.role.admin);
    expect(html).toContain('العربية');
  });

  it('names an account with no display name without inventing one', async () => {
    apiServes(staff(['admin'], ADMIN_PERMISSIONS, { name: null }));
    const { html } = await get('');
    expect(html).toContain(EN.Console.accountUnnamed);
  });

  it('renders a navigation that works on a small screen and on a large one', async () => {
    apiServes(staff(['admin'], ADMIN_PERMISSIONS));
    const { html } = await get('');

    // One list, a real button that announces its state, and a breakpoint rather than a second copy.
    expect(html).toContain('aria-controls="admin-sections"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('id="admin-sections"');
    expect(html).toContain('md:flex');
    expect(html.match(/id="admin-sections"/g) ?? []).toHaveLength(1);
  });

  it('renders the console home as sections and not as a dashboard', async () => {
    apiServes(staff(['admin'], ADMIN_PERMISSIONS));
    const { html } = await get('');

    expect(html).toContain(EN.Console.title);
    expect(html).toContain(EN.Console.intro);
    // No numbers nobody has a source for.
    for (const word of ['total', 'revenue', 'today', 'last 7 days', 'pending count', 'kpi']) {
      expect(html.toLowerCase(), word).not.toContain(word);
    }
  });

  it('says so plainly when access could not be checked, rather than showing an empty console', async () => {
    apiServes({ kind: 'unavailable' });
    const { status, html } = await get('');

    expect(status).toBe(200);
    expect(html).toContain(EN.Console.unavailableTitle);
    expect(html).toContain(EN.Console.unavailableBody);
    // Not a refusal, and not an offer to sign in that would be a lie.
    expect(html).not.toContain(EN.Console.forbiddenTitle);
    expect(html).not.toContain(EN.Console.signIn);
  });

  it('keeps every console surface out of a search index', async () => {
    apiServes(staff(['admin'], ADMIN_PERMISSIONS));
    for (const path of PROTECTED) {
      const { html } = await get(path);
      expect(html, path).toContain('<meta name="robots" content="noindex, nofollow"/>');
    }
  });
});

describe('what never reaches a browser', () => {
  it('sends no credential, no token and no internal address', async () => {
    apiServes(staff(['admin'], ADMIN_PERMISSIONS));
    for (const path of PROTECTED) {
      const { html } = await get(path);
      expect(html, path).not.toContain(CANARY_CREDENTIAL);
      expect(html, path).not.toContain('canary-admin-access-token');
      expect(html, path).not.toContain('canary-admin-refresh-token');
      expect(html, path).not.toContain(api.baseUrl);
      expect(html, path).not.toContain('/v1/admin/session');
    }
  });

  it('never promotes anybody: the console sends no write of any kind while rendering', async () => {
    apiServes(staff(['support_agent'], SUPPORT_PERMISSIONS));
    for (const path of PROTECTED) await get(path);

    expect(api.seen.length).toBeGreaterThan(0);
    for (const request of api.seen) {
      expect(request.method).toBe('GET');
      expect(request.body).toBe('');
      // 7-L's console reads its own two lists while rendering, so the session endpoint is no longer the only
      // address; what this test is about is that **every** request a rendering console makes is a read.
      expect(request.url.startsWith('/v1/admin/'), request.url).toBe(true);
      expect(request.url).not.toContain('/claim');
      expect(request.url).not.toContain('/release');
      expect(request.url).not.toContain('/decision');
      expect(request.url).not.toContain('/notes?');
    }
  });
});

describe('both languages', () => {
  it('renders the console in Arabic, mirrored, when the profile says so', async () => {
    apiServes(staff(['admin'], ADMIN_PERMISSIONS, { locale: 'ar' }));
    const { status, html } = await get('');

    expect(status).toBe(200);
    expect(html).toContain('<html lang="ar" dir="rtl">');
    expect(html).toContain(AR.Console.title);
    expect(html).toContain(AR.Sections.moderation.title);
  });

  it('renders each section in Arabic too', async () => {
    apiServes(staff(['admin'], ADMIN_PERMISSIONS, { locale: 'ar' }));
    for (const section of CONSOLE_SECTIONS) {
      const { html } = await get(section.href);
      expect(html, section.href).toContain('dir="rtl"');
      expect(html, section.href).toContain(AR.Sections[section.id as 'support'].title);
    }
  });

  it('refuses in Arabic as well, without naming anything', async () => {
    apiServes(staff(['support_agent'], SUPPORT_PERMISSIONS, { locale: 'ar' }));
    const { html } = await get('/moderation/reports');
    expect(html).toContain('dir="rtl"');
    expect(html).toContain(AR.Console.forbiddenTitle);
    expect(html).not.toContain(AR.Sections.moderation.description);
    expect(html).not.toContain(AR.Moderation.reportsIntro);
  });

  it('falls back to English for a visitor with no session', async () => {
    apiServes({ kind: 'unauthenticated' });
    const { html } = await get('', '');
    expect(html).toContain('<html lang="en" dir="ltr">');
  });

  it('falls back to English when the language could not be read', async () => {
    apiServes({ kind: 'unavailable' });
    const { html } = await get('');
    expect(html).toContain('<html lang="en" dir="ltr">');
    expect(html).toContain(EN.Console.unavailableTitle);
  });
});
