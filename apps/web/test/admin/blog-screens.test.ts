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
 * The blog screens, over real HTTP against the built app (0092).
 *
 * Run against the built app rather than a unit harness for the reason the shell test is: what matters is what actually
 * reaches a browser, **including the streamed RSC payload** — so a control merely hidden with CSS would fail these
 * assertions and a control never rendered passes them.
 *
 * The cases this file exists for:
 *
 *   * **a guest, a buyer, staff at `aal1`, a Moderator, a Support Agent and somebody who maintains only the CMS
 *     pages receive none of this section** — no post, no title, no address — and no read is performed. The last of
 *     those is the one that matters most: the blog and the static pages are separate keys, and this is where that is
 *     visible;
 *   * **the read/manage separation is on the screen.** A colleague holding `cms.blog.read` and not `cms.blog.manage`
 *     sees the posts and **not one control or any of their words**;
 *   * **a rename cannot publish.** The details panel and the publishing panel are separate forms, and the words of
 *     the second never appear inside the first;
 *   * **the screens say what they do not do** — no sitemap entry, no metadata override elsewhere, no comments and no
 *     byline picker — which are the things an operator could reasonably expect and would not get;
 *   * both languages and the direction that goes with each.
 *
 * No browser, no Playwright, no live provider, no deployment.
 */

const CANARY_CREDENTIAL = 'test-blog-screens-canary-notreal01234567890';

const EN = enMessages;
const AR = arMessages;

const ACCESS = '__Host-mp_admin_access=canary-admin-access-token-not-a-real-token';
const REFRESH = '__Host-mp_admin_refresh=canary-admin-refresh-token-not-a-real-tok';
const SESSION = `${ACCESS}; ${REFRESH}`;

const STAFF = '11111111-1111-4111-8111-111111111111';
const POST = 'fb000000-0000-4000-8000-0000000000b1';
const CATEGORY = 'fb000000-0000-4000-8000-0000000000c1';
const TAG = 'fb000000-0000-4000-8000-0000000000a1';

const READ = 'cms.blog.read';
const MANAGE = 'cms.blog.manage';

/** An administrator: both blog keys, plus others this surface never consults. */
const ADMIN = [READ, MANAGE, 'users.profile.read'].sort();

/** A colleague who may read the blog and change none — the read/manage separation, on a screen. */
const BLOG_READER = [READ].sort();

const MODERATOR = ['moderation.report.read', 'moderation.action.read', 'reviews.review.read'].sort();
const SUPPORT = ['support.ticket.read', 'support.ticket.manage', 'users.profile.read'].sort();

/** Somebody who maintains the static pages and not the blog: one module, two keys, two sections. */
const PAGES_ONLY = ['cms.page.read', 'cms.page.manage'].sort();

type Who =
  | { kind: 'staff'; permissions: string[]; locale?: 'en' | 'ar' }
  | { kind: 'staff-aal1' }
  | { kind: 'buyer' }
  | { kind: 'unauthenticated' };

type Data = 'default' | 'unwritten' | 'empty' | 'unavailable' | 'readerDetail' | 'withCover';

interface Serve {
  readonly who: Who;
  readonly data?: Data;
}

let api: StubApi;
let app: RunningApp;

const LIST_POST = {
  id: POST,
  slug: 'a-lovely-post',
  status: 'published',
  categoryId: CATEGORY,
  categorySlug: 'news',
  isIndexable: true,
  isFeatured: false,
  scheduledFor: null,
  publishedAt: '2026-05-01T09:00:00.000Z',
  archivedAt: null,
  updatedAt: '2026-05-02T09:00:00.000Z',
  translatedLocales: ['en'],
  tagCount: 1,
  title: 'A Lovely Post',
};

const TRANSLATION = {
  localeCode: 'en',
  title: 'A Lovely Post',
  excerpt: 'Worth reading.',
  body: 'The body of the post.',
  metaTitle: 'A Lovely Post | Meta',
  metaDescription: 'What the post is about.',
  updatedAt: '2026-05-02T09:00:00.000Z',
};

/** The detail contract is strict and declares neither `title` nor the list's two summary counts. */
function detailFor(data: Data, canManage: boolean): Record<string, unknown> {
  return {
    id: POST,
    slug: 'a-lovely-post',
    status: data === 'unwritten' ? 'draft' : 'published',
    categoryId: CATEGORY,
    categorySlug: 'news',
    isIndexable: true,
    isFeatured: false,
    // 0099: an attached cover is a stored path plus the alt text somebody wrote. Never a URL.
    ...(data === 'withCover'
      ? {
          coverMediaId: 'fb000000-0000-4000-8000-0000000000a1',
          coverObjectPath: 'cms-media/1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d.png',
          coverAltTextEn: 'A harbour at dawn',
          coverAltTextAr: 'ميناء عند الفجر',
        }
      : {
          coverMediaId: null,
          coverObjectPath: null,
          coverAltTextEn: null,
          coverAltTextAr: null,
        }),
    authorUserId: STAFF,
    scheduledFor: null,
    publishedAt: data === 'unwritten' ? null : '2026-05-01T09:00:00.000Z',
    archivedAt: null,
    createdAt: '2026-04-01T09:00:00.000Z',
    updatedAt: '2026-05-02T09:00:00.000Z',
    canManage,
    previousSlugs: ['an-older-address'],
    tagIds: [TAG],
    translations: data === 'unwritten' ? [] : [TRANSLATION],
  };
}

const TAXONOMY = {
  categories: [
    {
      id: CATEGORY,
      slug: 'news',
      nameEn: 'Marketplace news',
      nameAr: 'أخبار المنصة',
      descriptionEn: null,
      descriptionAr: null,
      sortOrder: 10,
      isActive: true,
      postCount: 2,
      updatedAt: '2026-05-02T09:00:00.000Z',
    },
  ],
  tags: [
    {
      id: TAG,
      slug: 'shipping',
      nameEn: 'Shipping advice',
      nameAr: null,
      isActive: true,
      postCount: 1,
      updatedAt: '2026-05-02T09:00:00.000Z',
    },
  ],
  canManage: true,
};

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

    if (path === '/v1/admin/blog/taxonomy') {
      if (!held(READ)) return problem(response, 404, 'NOT_FOUND');
      if (data === 'unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      // The capability comes from the key the caller actually holds, exactly as the API resolves it.
      return json(response, { ...TAXONOMY, canManage: data === 'readerDetail' ? false : held(MANAGE) });
    }

    if (path === '/v1/admin/blog') {
      if (!held(READ)) return problem(response, 404, 'NOT_FOUND');
      if (data === 'unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      if (data === 'empty') return json(response, { items: [], nextCursor: null });
      return json(response, { items: [LIST_POST], nextCursor: null });
    }

    if (path === `/v1/admin/blog/${POST}`) {
      if (!held(READ)) return problem(response, 404, 'NOT_FOUND');
      if (data === 'unavailable') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      return json(response, { post: detailFor(data, data === 'readerDetail' ? false : held(MANAGE)) });
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

beforeAll(async () => {
  api = await startStubApi();
  app = await startBuiltApp({
    API_BASE_URL: api.baseUrl,
    INTERNAL_BFF_CREDENTIAL: CANARY_CREDENTIAL,
  });
}, 180_000);

afterAll(async () => {
  await app?.stop();
  await api?.stop();
});

describe('who receives none of this section', () => {
  it('shows a guest, a buyer, staff at aal1, a moderator, a support agent and a pages-only maintainer nothing', async () => {
    for (const who of [
      { kind: 'unauthenticated' } as const,
      { kind: 'buyer' } as const,
      { kind: 'staff-aal1' } as const,
      { kind: 'staff', permissions: MODERATOR } as const,
      { kind: 'staff', permissions: SUPPORT } as const,
      // Maintaining the static pages and maintaining the blog are different jobs with different seeded keys, and
      // this is where that separation is visible.
      { kind: 'staff', permissions: PAGES_ONLY } as const,
    ]) {
      apiServes({ who });
      for (const path of ['/blog', `/blog/${POST}`]) {
        const { html } = await get(path);
        const label = `${who.kind}:${JSON.stringify('permissions' in who ? who.permissions : [])}:${path}`;
        expect(html, label).not.toContain('A Lovely Post');
        expect(html, label).not.toContain('a-lovely-post');
        expect(html, label).not.toContain('an-older-address');
        expect(html, label).not.toContain(EN.Blog.saveSubmit);
        expect(html, label).not.toContain(EN.Blog.statusSubmit);
      }
      expect(api.seen.filter((entry) => entry.url.startsWith('/v1/admin/blog')), who.kind).toEqual([]);
    }
  });
});

describe('the read and manage keys are separate on the screen', () => {
  it('gives a reader the posts and the detail, and not one control', async () => {
    apiServes({ who: { kind: 'staff', permissions: BLOG_READER }, data: 'readerDetail' });

    const list = await get('/blog');
    expect(list.status).toBe(200);
    expect(list.html).toContain('A Lovely Post');
    // Not one word of a control. The add panel asks the taxonomy for its capability and renders nothing without it.
    expect(list.html).not.toContain(EN.Blog.createSubmit);
    expect(list.html).not.toContain(EN.Blog.draftNotice);
    expect(list.html).not.toContain(EN.Blog.addCategoryHeading);

    const detail = await get(`/blog/${POST}`);
    expect(detail.status).toBe(200);
    expect(detail.html).toContain('a-lovely-post');
    expect(detail.html).toContain('an-older-address');
    expect(detail.html).toContain(EN.Blog.readOnlyTitle);
    expect(detail.html).not.toContain(EN.Blog.saveSubmit);
    expect(detail.html).not.toContain(EN.Blog.statusSubmit);
    expect(detail.html).not.toContain(EN.Blog.removeLocale);
    expect(detail.html).not.toContain(EN.Blog.tagsNotice);
  });

  it('gives a manager every control', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });

    const list = await get('/blog');
    expect(list.html).toContain(EN.Blog.createSubmit);
    expect(list.html).toContain(EN.Blog.addCategoryHeading);
    expect(list.html).toContain(EN.Blog.addTagHeading);

    const detail = await get(`/blog/${POST}`);
    expect(detail.html).toContain(EN.Blog.saveSubmit);
    expect(detail.html).toContain(EN.Blog.statusSubmit);
    expect(detail.html).toContain(EN.Blog.removeLocale);
    expect(detail.html).toContain(EN.Blog.tagsNotice);
    expect(detail.html).not.toContain(EN.Blog.readOnlyTitle);
  });
});

describe('a rename cannot publish', () => {
  it('keeps the lifecycle in its own form, with its own words', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get(`/blog/${POST}`);

    // Two separate panels with two separate headings, which is the shape that makes the separation real.
    expect(html).toContain(EN.Blog.editHeading);
    expect(html).toContain(EN.Blog.statusHeading);
    // And the details panel says plainly that it does not publish.
    expect(html).toContain(EN.Blog.editIntro);
  });

  it('refuses to offer publishing words to a post nobody has written, and says why', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'unwritten' });
    const { html } = await get(`/blog/${POST}`);
    expect(html).toContain(EN.Blog.unwrittenTitle);
    expect(html).toContain(EN.Blog.unwrittenBody);
  });
});

describe('what the section says it does not do', () => {
  it('states the absences an operator would otherwise discover', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const list = await get('/blog');

    // The sitemap, the metadata section, comments and the byline: four things somebody could reasonably expect.
    expect(list.html).toContain(EN.Blog.notHereTitle);
    expect(list.html).toContain(EN.Blog.notHereBody);
    // And the counts, which are of every post rather than the public ones.
    expect(list.html).toContain(EN.Blog.countsBody);

    const detail = await get(`/blog/${POST}`);
    // The cover is a storage path with no public address, said rather than implied.
    expect(detail.html).toContain(EN.Blog.coverBody);
    // Where a post's head comes from, said where somebody is editing it.
    expect(detail.html).toContain(EN.Blog.metaTitleHint);
    // The retired address still redirects, and no other post can take it.
    expect(detail.html).toContain(EN.Blog.previousSlugsBody);
  });

  it('offers no control this increment did not build', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const detail = await get(`/blog/${POST}`);

    // No byline picker: the field exists on the row and no form writes it.
    expect(detail.html).not.toContain('name="authorUserId"');
    expect(detail.html).not.toContain('id="blog-details-author"');
    // No sitemap toggle and no structured data, neither of which this increment has.
    expect(detail.html).not.toContain('name="sitemap"');
    expect(detail.html).not.toContain('name="structuredData"');
    // No canonical field: a post's head is its own meta fields, and the override section does not reach the blog.
    expect(detail.html).not.toContain('name="canonicalPath"');
  });
});

describe('the cover image on the screen (0099)', () => {
  it('offers the identifier field to a manager, which nothing did before', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get(`/blog/${POST}`);
    expect(html).toContain(EN.Blog.coverMediaIdLabel);
    expect(html).toContain(EN.Blog.coverMediaIdHint);
  });

  it('shows the stored path and both alt texts for an attached cover', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'withCover' });
    const { html } = await get(`/blog/${POST}`);
    expect(html).toContain('cms-media/1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d.png');
    expect(html).toContain('A harbour at dawn');
    expect(html).toContain(EN.Blog.fieldCoverAltEn);
    expect(html).toContain(EN.Blog.fieldCoverAltAr);
  });

  it('renders no image and no URL for it, because the bucket is private', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'withCover' });
    const { html } = await get(`/blog/${POST}`);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('token=');
    expect(html).not.toContain('/storage/v1/');
  });

  it('does not show the alt-text rows when nothing is attached', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get(`/blog/${POST}`);
    expect(html).not.toContain(EN.Blog.fieldCoverAltEn);
    expect(html).toContain(EN.Blog.noCover);
  });

  it('gives a reader no cover field at all', async () => {
    apiServes({ who: { kind: 'staff', permissions: BLOG_READER }, data: 'readerDetail' });
    const { html } = await get(`/blog/${POST}`);
    expect(html).not.toContain(EN.Blog.coverMediaIdLabel);
    expect(html).not.toContain(EN.Blog.coverMediaIdHint);
  });
});

describe('the list and its filters', () => {
  it('carries the state, the category and which languages exist', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get('/blog');
    expect(html).toContain('a-lovely-post');
    expect(html).toContain('news');
    expect(html).toContain(EN.Blog.columnLocales);
  });

  it('says a search is matched literally, because that is not the obvious assumption', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get('/blog');
    expect(html).toContain(EN.Blog.searchHint);
  });

  it('tells an empty section from a filter that matched nothing', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'empty' });
    const bare = await get('/blog');
    expect(bare.html).toContain(EN.Blog.emptyTitle);
    expect(bare.html).not.toContain(EN.Blog.noMatchesTitle);

    const filtered = await get('/blog?status=draft');
    expect(filtered.html).toContain(EN.Blog.noMatchesTitle);
    expect(filtered.html).not.toContain(EN.Blog.emptyTitle);
  });

  it('is an honest failure when the list could not be read, not an empty section', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN }, data: 'unavailable' });
    const { status, html } = await get('/blog');
    expect(status).toBe(200);
    expect(html).toContain(EN.Blog.unavailableTitle);
    expect(html).not.toContain(EN.Blog.emptyTitle);
  });
});

describe('both languages', () => {
  it('renders Arabic right to left with the Arabic words', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN, locale: 'ar' } });
    const { html } = await get('/blog');
    expect(html).toContain('dir="rtl"');
    expect(html).toContain(AR.Sections.blog.title);
    expect(html).toContain(AR.Blog.listHeading);
    expect(html).toContain(AR.Blog.notHereBody);
  });

  it('renders English left to right with the English words', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get('/blog');
    expect(html).toContain('dir="ltr"');
    expect(html).toContain(EN.Sections.blog.title);
    expect(html).toContain(EN.Blog.listHeading);
  });

  it('shows an Arabic category name where one was written and the English one where it was not', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN, locale: 'ar' } });
    const { html } = await get('/blog');
    // Both names come back on every row: the console edits both, so it shows both rather than choosing.
    expect(html).toContain('Marketplace news');
    expect(html).toContain('Shipping advice');
  });
});

describe('a post that is not there', () => {
  it('reads the same as one this caller may not see', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { status, html } = await get('/blog/fb000000-0000-4000-8000-00000000dead');
    expect(status).toBe(200);
    expect(html).toContain(EN.Blog.notFoundTitle);
    expect(html).toContain(EN.Blog.notFoundBody);
  });

  it('is the same message for an address that could not name a post', async () => {
    apiServes({ who: { kind: 'staff', permissions: ADMIN } });
    const { html } = await get('/blog/not-a-uuid');
    expect(html).toContain(EN.Blog.notFoundTitle);
    // Nothing was asked upstream: a string that cannot be an identifier names nothing.
    expect(api.seen.filter((entry) => entry.url.startsWith('/v1/admin/blog/not-a-uuid'))).toEqual([]);
  });
});
