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
 * The CMS media library screen, over real HTTP against the built app (0098).
 *
 * Run against the built app rather than a unit harness for the reason the shell test is: what matters is what actually
 * reaches a browser, **including the streamed RSC payload** — so a control merely hidden with CSS would fail these
 * assertions and a control never rendered passes them.
 *
 * The cases this file exists for:
 *
 *   * **a guest, a buyer, staff at `aal1`, a Moderator and a colleague holding every other `cms` key receive none of
 *     this section** — and no read is performed. An invented `cms.media.read` is in that last set on purpose: it does
 *     not exist in the seed and must not be a way in;
 *   * **no image reaches the page until an operator asks.** The bucket is private and a preview is a short-lived
 *     signed URL, so the rendered HTML must contain no `<img src>` pointing at storage and no signed URL at all;
 *   * **owner decision 4 is explained**, because an operator uploading a cover would otherwise expect it to appear on
 *     the public site and wait for something that is not going to happen;
 *   * **owner decisions 2 and 6 are explained** — what may be uploaded, and that SVG is refused and why;
 *   * **the delete is not offered until the references have been shown** (owner decision 5): the rendered page carries
 *     no delete control, because the usage list is fetched by a button;
 *   * **no promotion, placement, ranking, financial or public-URL control appears anywhere**;
 *   * both languages and the direction that goes with each.
 *
 * No browser, no Playwright, no live provider, no deployment.
 */

/** Obviously fake, 43 base64url characters. */
const CANARY_CREDENTIAL = 'test-cms-media-screens-canary-notreal012345';

const EN = enMessages;
const AR = arMessages;

const ACCESS = '__Host-mp_admin_access=canary-admin-access-token-not-a-real-token';
const REFRESH = '__Host-mp_admin_refresh=canary-admin-refresh-token-not-a-real-tok';
const SESSION = `${ACCESS}; ${REFRESH}`;

const STAFF = '11111111-1111-4111-8111-111111111111';
const MEDIA = 'cf000000-0000-4000-8000-0000000000a1';
const OBJECT_PATH = 'cms-media/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png';

const MANAGE = 'cms.media.manage';

/** An administrator: the one key this surface has, plus others it never consults. */
const ADMIN = [MANAGE, 'users.profile.read'].sort();

/**
 * A colleague holding every other `cms` key — and an invented `cms.media.read`.
 *
 * The invented key is the point: it does not exist in the seed, nothing was built to accept it, and this section must
 * stay shut to somebody who has it.
 */
const CMS_WITHOUT_MEDIA = [
  'cms.media.read',
  'cms.page.read',
  'cms.page.manage',
  'cms.blog.read',
  'cms.blog.manage',
  'cms.homepage.read',
  'cms.navigation.read',
  'cms.faq.read',
  'cms.banner.read',
  'cms.banner.manage',
].sort();

const MODERATOR = ['moderation.report.read', 'moderation.action.read', 'reviews.review.read'].sort();

type Who =
  | { kind: 'staff'; permissions: string[]; locale?: 'en' | 'ar' }
  | { kind: 'staff-aal1' }
  | { kind: 'buyer' }
  | { kind: 'unauthenticated' };

type Data = 'default' | 'unused' | 'empty' | 'paged' | 'unavailable' | 'usage' | 'usageEmpty' | 'usageFails';

interface Serve {
  readonly who: Who;
  readonly data?: Data;
}

let api: StubApi;
let app: RunningApp;

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: MEDIA,
    objectPath: OBJECT_PATH,
    contentType: 'image/png',
    width: 800,
    height: 600,
    byteSize: 4096,
    altTextEn: 'A photo of a chair',
    altTextAr: null,
    usageCount: 2,
    createdAt: '2026-05-02T09:00:00.000Z',
    updatedAt: '2026-05-02T09:00:00.000Z',
    ...overrides,
  };
}

function json(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
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

    if (path === '/v1/admin/cms/media') {
      // The API's own shape: one key, so no key means the neutral absence.
      if (!held(MANAGE)) return problem(response, 404, 'NOT_FOUND');
      if (data === 'unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      if (data === 'empty') return json(response, { items: [], nextCursor: null, canManage: true });
      if (data === 'unused') {
        return json(response, { items: [entry({ usageCount: 0 })], nextCursor: null, canManage: true });
      }
      if (data === 'paged') {
        return json(response, { items: [entry()], nextCursor: 'Y20xfG5leHQ', canManage: true });
      }
      return json(response, { items: [entry()], nextCursor: null, canManage: true });
    }

    if (path === `/v1/admin/cms/media/${MEDIA}/usage`) {
      if (!held(MANAGE)) return problem(response, 404, 'NOT_FOUND');
      if (data === 'usageFails') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      if (data === 'usageEmpty') return json(response, { id: MEDIA, references: [] });
      return json(response, {
        id: MEDIA,
        references: [
          {
            entityType: 'page',
            entityId: 'cf100000-0000-4000-8000-000000000001',
            label: 'about',
            column: 'cover_media_id',
          },
          { entityType: 'seo_settings', entityId: null, label: 'en', column: 'default_share_media_id' },
        ],
      });
    }

    return problem(response, 404, 'NOT_FOUND');
  });
}

async function get(path: string, cookie: string | null = SESSION): Promise<{ status: number; html: string }> {
  const response = await fetch(`${app.baseUrl}${CONSOLE}${path}`, {
    headers: cookie === null ? {} : { cookie },
    redirect: 'manual',
  });
  return { status: response.status, html: await response.text() };
}

/** Which upstream addresses were asked for while rendering. */
function asked(): readonly string[] {
  return api.seen.map((entry_) => entry_.url.split('?')[0] ?? '');
}

beforeAll(async () => {
  api = await startStubApi();
  app = await startBuiltApp({ API_BASE_URL: api.baseUrl, INTERNAL_BFF_CREDENTIAL: CANARY_CREDENTIAL });
}, 120_000);

afterAll(async () => {
  await app.stop();
  await api.stop();
});

/* ------------------------------------------------------------------------------------------------ */

describe('who may open the section at all', () => {
  it('refuses a guest, a buyer and staff at aal1, each neutrally', async () => {
    for (const who of [
      { kind: 'unauthenticated' } as const,
      { kind: 'buyer' } as const,
      { kind: 'staff-aal1' } as const,
    ]) {
      apiServes({ who });
      const { html } = await get('/cms/media', who.kind === 'unauthenticated' ? null : SESSION);
      expect(html, who.kind).not.toContain(EN.CmsMedia.uploadHeading);
      expect(asked(), who.kind).not.toContain('/v1/admin/cms/media');
    }
  });

  it('refuses a Moderator, and performs no read', async () => {
    apiServes({ who: { kind: 'staff', permissions: MODERATOR } });
    const { html } = await get('/cms/media');
    expect(html).not.toContain(EN.CmsMedia.uploadHeading);
    expect(asked()).not.toContain('/v1/admin/cms/media');
  });

  it('refuses somebody holding every other cms key, including an invented cms.media.read', async () => {
    // The second section in this console gated on a manage key. An invented read key is not a way in.
    apiServes({ who: { kind: 'staff', permissions: CMS_WITHOUT_MEDIA } });
    const { html } = await get('/cms/media');
    expect(html).not.toContain(EN.CmsMedia.uploadHeading);
    expect(html).not.toContain(EN.CmsMedia.listHeading);
    expect(asked()).not.toContain('/v1/admin/cms/media');
  });

  it('shows the section to somebody holding the manage key', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { status, html } = await get('/cms/media');
    expect(status).toBe(200);
    expect(html).toContain(EN.Sections.cmsMedia.title);
    expect(html).toContain(EN.CmsMedia.uploadHeading);
    expect(asked()).toContain('/v1/admin/cms/media');
  });

  it('is reachable from the navigation for that colleague and absent for the other', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const withKey = await get('');
    expect(withKey.html).toContain(EN.Sections.cmsMedia.title);
    expect(withKey.html).toContain('/cms/media');

    apiServes({ who: { kind: 'staff', permissions: CMS_WITHOUT_MEDIA } });
    const withoutKey = await get('');
    expect(withoutKey.html).not.toContain(EN.Sections.cmsMedia.title);
    expect(withoutKey.html).not.toContain('/cms/media');
  });
});

/* ------------------------------------------------------------------------------------------------ */

describe('no image reaches the page until an operator asks', () => {
  it('renders no img element and no storage URL', async () => {
    // The bucket is private and a preview is a short-lived credential. A page that previewed every row would put live
    // credentials into HTML nobody has looked at yet, and make a provider call per row.
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get('/cms/media');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('https://storage');
    expect(html).not.toContain('/storage/v1/');
    expect(html).not.toContain('X-Amz-');
    expect(html).not.toContain('token=');
  });

  it('shows what the entry is instead, including its path and its usage', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get('/cms/media');
    expect(html).toContain(OBJECT_PATH);
    expect(html).toContain('image/png');
    expect(html).toContain('800');
    expect(html).toContain('600');
    expect(html).toContain('A photo of a chair');
  });

  it('offers the preview and the usage check as controls rather than as content', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get('/cms/media');
    expect(html).toContain(EN.CmsMedia.preview);
    expect(html).toContain(EN.CmsMedia.checkUsage);
  });

  it('says an unused entry is used nowhere', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'unused' });
    const { html } = await get('/cms/media');
    expect(html).toContain(EN.CmsMedia.usedNowhere);
  });
});

/* ------------------------------------------------------------------------------------------------ */

describe('what the screen says out loud', () => {
  it('says that nothing public shows these images yet', async () => {
    // Owner decision 4. Nothing else in this product would ever tell an operator this.
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get('/cms/media');
    expect(html).toContain(EN.CmsMedia.notUsedYetTitle);
  });

  it('says what may be uploaded, and that SVG is not accepted', async () => {
    // Owner decisions 2 and 6, explained rather than discovered through a refusal.
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get('/cms/media');
    expect(html).toContain(EN.CmsMedia.rulesTitle);
    expect(html).toContain('SVG');
    expect(html).toContain('10 MB');
  });

  it('offers only the four accepted types to the file picker', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get('/cms/media');
    expect(html).toContain('image/jpeg');
    expect(html).toContain('image/avif');
    expect(html).not.toContain('image/svg+xml');
  });

  it('offers no delete control, and no word about deleting, until the references are asked for', async () => {
    // Owner decision 5, as a property of the response. Asserted against the whole body including the streamed RSC
    // payload, so a label merely shipped to the browser for a control that is not rendered would fail here.
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get('/cms/media');
    expect(html).not.toContain(EN.CmsMedia.remove);
    expect(html).not.toContain(EN.CmsMedia.removeConfirm);
    expect(html).not.toContain(EN.CmsMedia.usageHeading);
    // What it offers instead is a link that asks the server for them.
    expect(html).toContain(EN.CmsMedia.checkUsage);
    expect(html).toContain(`/cms/media?usage=${MEDIA}`);
  });

  it('renders the references and the delete control in the same server response', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'usage' });
    const { html } = await get(`/cms/media?usage=${MEDIA}`);
    expect(html).toContain(EN.CmsMedia.usageHeading);
    // The references themselves, including the locale-keyed row that has no identifier.
    expect(html).toContain('about');
    expect(html).toContain('cover_media_id');
    expect(html).toContain('default_share_media_id');
    // And only now the delete.
    expect(html).toContain(EN.CmsMedia.remove);
  });

  it('offers no delete when the references could not be read', async () => {
    // If the list of what deleting would blank cannot be shown, deleting is not offered at all.
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'usageFails' });
    const { html } = await get(`/cms/media?usage=${MEDIA}`);
    expect(html).toContain(EN.CmsMedia.usageFailed);
    expect(html).not.toContain(EN.CmsMedia.remove);
    expect(html).not.toContain(EN.CmsMedia.removeConfirm);
  });

  it('says so plainly when nothing points at the entry', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'usageEmpty' });
    const { html } = await get(`/cms/media?usage=${MEDIA}`);
    expect(html).toContain(EN.CmsMedia.usageNone);
    expect(html).toContain(EN.CmsMedia.remove);
  });

  it('says the library is empty when it is', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'empty' });
    const { html } = await get('/cms/media');
    expect(html).toContain(EN.CmsMedia.emptyTitle);
  });

  it('offers an older-uploads link only when there is another page', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    expect((await get('/cms/media')).html).not.toContain(EN.CmsMedia.nextPage);

    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'paged' });
    const paged = await get('/cms/media');
    expect(paged.html).toContain(EN.CmsMedia.nextPage);
    expect(paged.html).toContain('cursor=Y20xfG5leHQ');
  });
});

/* ------------------------------------------------------------------------------------------------ */

describe('what this screen must not contain', () => {
  it('has no promotion, placement, ranking or financial control', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get('/cms/media');
    for (const name of [
      'name="promotion"',
      'name="placement"',
      'name="ranking"',
      'name="priceMinor"',
      'name="commission"',
      'name="settlement"',
      'name="payout"',
    ]) {
      expect(html, name).not.toContain(name);
    }
  });

  it('has no path field, so nothing a person types becomes part of a path', async () => {
    // Owner decision 3.
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get('/cms/media');
    for (const name of ['name="objectPath"', 'name="bucket"', 'name="bucketId"', 'name="uploadUrl"']) {
      expect(html, name).not.toContain(name);
    }
  });

  it('has no banner control, because 0098 builds no banner', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get('/cms/media');
    expect(html).not.toContain('name="bannerKey"');
    expect(html).not.toContain('/cms/banners');
  });
});

/* ------------------------------------------------------------------------------------------------ */

describe('failures and both languages', () => {
  it('says the library could not be loaded when the read fails', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'unavailable' });
    const { status, html } = await get('/cms/media');
    expect(status).toBe(200);
    expect(html).toContain(EN.CmsMedia.unavailableTitle);
    // The upload panel is still there: a failed read of the list does not stop somebody adding an image.
    expect(html).toContain(EN.CmsMedia.uploadHeading);
  });

  it('renders in Arabic, right to left', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN, locale: 'ar' } });
    const { status, html } = await get('/cms/media');
    expect(status).toBe(200);
    expect(html).toContain('dir="rtl"');
    expect(html).toContain(AR.Sections.cmsMedia.title);
    expect(html).toContain(AR.CmsMedia.uploadHeading);
    expect(html).toContain(AR.CmsMedia.notUsedYetTitle);
  });

  it('renders in English, left to right', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get('/cms/media');
    expect(html).toContain('dir="ltr"');
    expect(html).toContain(EN.CmsMedia.uploadHeading);
  });
});
