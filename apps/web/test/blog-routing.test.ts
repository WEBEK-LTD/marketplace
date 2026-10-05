import type { ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startBuiltApp, type RunningApp } from './support/next-server.js';
import { startStubApi, type StubApi } from './support/stub-api.js';

/**
 * The public blog, over real HTTP against the built app (0092).
 *
 * The status line is what matters and it can only be decided in the middleware: Next.js 16 streams, so a redirect or a
 * 404 chosen inside a page arrives as a 200 with the right body. These run the built app under `next start` against a
 * stub API.
 *
 * What this suite exists to prove:
 *
 *   * **a retired post address is a real 301**, issued before the redirect map is consulted — which is LIVE PAGE WINS
 *     applied to the blog: a post's own slug history is a live surface, so the map must never get the chance to
 *     shadow it. Asserted on the stub API's record of what was asked, not only on the status line;
 *   * **every non-public state is one 404** — a draft, a schedule, an archive, a future publication and a slug that
 *     never existed are indistinguishable from the outside;
 *   * **a post's `<head>` comes from the post**: its own `metaTitle` and `metaDescription`, and `isIndexable` as the
 *     only thing that decides whether it may be indexed. **No metadata override is ever read for a post** (0092's
 *     decision B), asserted by what the app asked the API for;
 *   * **the index is canonical unfiltered and unpaged**, and a filtered or paged view is `noindex`;
 *   * **the blog may actually be indexed** (0097). 0092 wrote `isIndexable` through to the page and the response
 *     still carried a blanket `X-Robots-Tag: noindex`, which combines to the most restrictive of the two — so the
 *     column reached no crawler. Both halves are now asserted together for the index and for a post, in both states
 *     of the column, because a page is indexable only when neither the header nor the page forbids it;
 *   * **the blog has one sitemap kind and no taxonomy** (0097's decisions 2 and 6);
 *   * the fallback locale is reported on the content itself rather than claimed.
 *
 * No browser, no Playwright, no live provider, no deployment.
 */

/** Obviously fake, 43 base64url characters. */
const CANARY_CREDENTIAL = 'test-web-blog-routing-canary-notreal0123456';

const POST = {
  slug: 'a-lovely-post',
  isIndexable: true,
  isFeatured: true,
  categorySlug: 'news',
  categoryName: 'Marketplace news',
  resolvedLocale: 'en',
  title: 'A Lovely Post',
  excerpt: 'Worth reading.',
  body: 'The body of the post, at enough length to be real.',
  metaTitle: 'A Lovely Post | Meta',
  metaDescription: 'What the post is about.',
  coverObjectPath: null,
  tags: [{ slug: 'shipping', name: 'Shipping advice' }],
  publishedAt: '2026-05-01T09:00:00.000Z',
  updatedAt: '2026-05-02T09:00:00.000Z',
} as const;

const SUMMARY = {
  slug: 'a-lovely-post',
  isFeatured: true,
  categorySlug: 'news',
  categoryName: 'Marketplace news',
  resolvedLocale: 'en',
  title: 'A Lovely Post',
  excerpt: 'Worth reading.',
  coverObjectPath: null,
  publishedAt: '2026-05-01T09:00:00.000Z',
  updatedAt: '2026-05-02T09:00:00.000Z',
} as const;

const TAXONOMY = {
  categories: [{ slug: 'news', name: 'Marketplace news', postCount: 1 }],
  tags: [{ slug: 'shipping', name: 'Shipping advice', postCount: 1 }],
} as const;

type PostAnswer =
  | { kind: 'post'; post: Record<string, unknown> }
  | { kind: 'moved'; movedTo: string }
  | { kind: 'absent' }
  | { kind: 'unavailable' };

let api: StubApi;
let app: RunningApp;
let postAnswer: PostAnswer;
let indexEmpty: boolean;
/** What the redirect map answers, keyed by the path it was asked about. */
let mapAnswers: ReadonlyMap<string, { toPath: string; statusCode: number }>;

function json(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function notFound(response: ServerResponse): void {
  response.writeHead(404, { 'content-type': 'application/problem+json' });
  response.end(JSON.stringify({ status: 404, code: 'NOT_FOUND' }));
}

function unavailable(response: ServerResponse): void {
  response.writeHead(503, { 'content-type': 'application/problem+json' });
  response.end(JSON.stringify({ status: 503, code: 'SERVICE_UNAVAILABLE' }));
}

function serveApi(): void {
  api.reply((request, response) => {
    const [pathname, search] = request.url.split('?');
    const path = pathname ?? '';

    if (path === '/v1/seo/redirects/resolve') {
      const asked = new URLSearchParams(search ?? '').get('path') ?? '';
      const answer = mapAnswers.get(asked);
      return json(response, answer === undefined ? { outcome: 'none' } : { outcome: 'redirect', ...answer });
    }

    if (path === '/v1/blog') {
      return json(response, { items: indexEmpty ? [] : [SUMMARY], nextCursor: indexEmpty ? null : 'YmkxLXRlc3Q' });
    }
    if (path === '/v1/blog/taxonomy') return json(response, TAXONOMY);

    if (path.startsWith('/v1/blog/')) {
      if (postAnswer.kind === 'absent') return notFound(response);
      if (postAnswer.kind === 'unavailable') return unavailable(response);
      if (postAnswer.kind === 'moved') {
        return json(response, { outcome: 'moved', movedTo: postAnswer.movedTo });
      }
      return json(response, { outcome: 'post', post: postAnswer.post });
    }

    // Every other read — robots, the sitemaps, the catalogue — answers nothing, which is what makes the sitemap
    // assertions below meaningful: the blog is absent because no kind exists for it, not because a stub refused.
    return notFound(response);
  });
}

beforeAll(async () => {
  api = await startStubApi();
  serveApi();
  app = await startBuiltApp({ API_BASE_URL: api.baseUrl, INTERNAL_BFF_CREDENTIAL: CANARY_CREDENTIAL });
}, 180_000);

afterAll(async () => {
  await app?.stop();
  await api?.stop();
});

beforeEach(() => {
  api.seen.length = 0;
  postAnswer = { kind: 'post', post: { ...POST } };
  indexEmpty = false;
  mapAnswers = new Map();
  // Re-registered every test, because a test that replaces the handler must not leak into the next one.
  serveApi();
});

interface Hit {
  readonly status: number;
  readonly location: string | null;
  readonly html: string;
  readonly robotsHeader: string | null;
}

async function load(path: string): Promise<Hit> {
  const response = await fetch(`${app.baseUrl}${path}`, { redirect: 'manual' });
  return {
    status: response.status,
    location: response.headers.get('location'),
    html: await response.text(),
    robotsHeader: response.headers.get('x-robots-tag'),
  };
}

/** Whether the redirect map was consulted at all during the last request. */
function mapWasConsulted(): boolean {
  return api.seen.some((entry) => entry.url.startsWith('/v1/seo/redirects/resolve'));
}

/** What the app asked the API for, paths only. */
function asked(): readonly string[] {
  return api.seen.map((entry) => entry.url.split('?')[0] ?? '');
}

/** One `<meta name="…">` content value, or null. */
function meta(html: string, name: string): string | null {
  const match = new RegExp(`<meta name="${name}" content="([^"]*)"`).exec(html);
  return match?.[1] ?? null;
}

/** The `<link rel="canonical">` href, or null. */
function canonical(html: string): string | null {
  const match = /<link rel="canonical" href="([^"]*)"/.exec(html);
  return match?.[1] ?? null;
}

/* ------------------------------------------------------------------------------------------------ */
/* One post                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

describe('one post', () => {
  it('is served with its text, its category and its tags', async () => {
    const hit = await load('/blog/a-lovely-post');
    expect(hit.status).toBe(200);
    expect(hit.html).toContain('A Lovely Post');
    expect(hit.html).toContain('The body of the post');
    expect(hit.html).toContain('Marketplace news');
    expect(hit.html).toContain('Shipping advice');
  });

  it('takes its head from the post and never from a metadata override', async () => {
    const hit = await load('/blog/a-lovely-post');
    expect(hit.html).toContain('<title>A Lovely Post | Meta</title>');
    expect(meta(hit.html, 'description')).toBe('What the post is about.');
    expect(canonical(hit.html)).toBe('/blog/a-lovely-post');
    // 0092's decision B, asserted by what was asked: the override reader is never consulted for a post.
    expect(asked()).not.toContain('/v1/seo/metadata');
  });

  it('falls back to its own title when no meta title was written', async () => {
    postAnswer = { kind: 'post', post: { ...POST, metaTitle: null, metaDescription: null, excerpt: null } };
    const hit = await load('/blog/a-lovely-post');
    expect(hit.html).toContain('<title>A Lovely Post</title>');
    expect(meta(hit.html, 'description')).toBeNull();
  });

  it('honours the administrators indexability decision, and nothing else decides it', async () => {
    const indexable = await load('/blog/a-lovely-post');
    expect(meta(indexable.html, 'robots')).toBe('index, follow');

    postAnswer = { kind: 'post', post: { ...POST, isIndexable: false } };
    const hidden = await load('/blog/a-lovely-post');
    expect(meta(hidden.html, 'robots')).toBe('noindex, follow');
  });

  it('reports the language it actually served on the content itself', async () => {
    postAnswer = { kind: 'post', post: { ...POST, resolvedLocale: 'en', title: 'A Lovely Post' } };
    const arabic = await load('/ar/blog/a-lovely-post');
    expect(arabic.status).toBe(200);
    // Asked for in Arabic and written only in English: the article says `lang="en"` rather than claiming Arabic.
    expect(arabic.html).toContain('lang="en"');
    expect(arabic.html).toContain('dir="ltr"');
  });

  it('says so rather than claiming absence when the blog could not be read', async () => {
    postAnswer = { kind: 'unavailable' };
    const hit = await load('/blog/a-lovely-post');
    expect(hit.status).toBe(200);
    expect(hit.html).toContain('Blog unavailable');
    expect(meta(hit.html, 'robots')).toBe('noindex, nofollow');
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* A retired address, and LIVE PAGE WINS                                                             */
/* ------------------------------------------------------------------------------------------------ */

describe('a retired post address', () => {
  it('is a real 301 to the current address', async () => {
    postAnswer = { kind: 'moved', movedTo: 'a-lovely-post' };
    const hit = await load('/blog/an-older-address');
    expect(hit.status).toBe(301);
    expect(hit.location).toContain('/blog/a-lovely-post');
  });

  it('stays in the locale it arrived in', async () => {
    postAnswer = { kind: 'moved', movedTo: 'a-lovely-post' };
    const hit = await load('/ar/blog/an-older-address');
    expect(hit.status).toBe(301);
    // An Arabic reader following an old Arabic address is not moved to the English site.
    expect(hit.location).toContain('/ar/blog/a-lovely-post');
  });

  it('wins over the redirect map, which is never even consulted', async () => {
    postAnswer = { kind: 'moved', movedTo: 'a-lovely-post' };
    mapAnswers = new Map([['/blog/an-older-address', { toPath: '/blog', statusCode: 302 }]]);
    const hit = await load('/blog/an-older-address');
    // The post's own slug history is a live surface, so it answers first. The assertion that matters is not that
    // the map lost but that it was never asked.
    expect(hit.status).toBe(301);
    expect(hit.location).toContain('/blog/a-lovely-post');
    expect(mapWasConsulted()).toBe(false);
  });

  it('is served live rather than redirected when the post exists at that address', async () => {
    mapAnswers = new Map([['/blog/a-lovely-post', { toPath: '/blog', statusCode: 301 }]]);
    const hit = await load('/blog/a-lovely-post');
    expect(hit.status).toBe(200);
    expect(mapWasConsulted()).toBe(false);
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* Absence                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

describe('a post the public may not see', () => {
  it('is one 404 for every reason, with no detail about which', async () => {
    postAnswer = { kind: 'absent' };
    for (const path of ['/blog/a-draft', '/blog/scheduled-for-later', '/blog/never-existed']) {
      const hit = await load(path);
      expect(hit.status, path).toBe(404);
      expect(hit.robotsHeader, path).toBe('noindex');
      expect(hit.html, path).not.toContain('A Lovely Post');
    }
  });

  it('reaches the redirect map, because a 404 is exactly what the map is for', async () => {
    postAnswer = { kind: 'absent' };
    mapAnswers = new Map([['/blog/a-retired-campaign-post', { toPath: '/blog', statusCode: 301 }]]);
    const hit = await load('/blog/a-retired-campaign-post');
    expect(hit.status).toBe(301);
    expect(hit.location).toContain('/blog');
  });

  it('shows no post for an address that could not name one, and never asks the API about it', async () => {
    const hit = await load('/blog/Not%20A%20Slug');
    // No read at all: a string that fails the slug shape names no post, so the reader refuses it before the hop.
    expect(asked().filter((path) => path.startsWith('/v1/blog/'))).toEqual([]);
    expect(hit.html).not.toContain('A Lovely Post');
    expect(hit.html).not.toContain('The body of the post');
    // The status line is deliberately not asserted here. A malformed segment under a served dynamic prefix is
    // routed, and the not-found body then streams under a 200 — which is how every dynamic public surface on this
    // platform behaves, for the Next.js streaming reason the proxy's own comment gives. Making the blog alone
    // answer 404 would single it out, and changing the rest is a cross-surface concern of its own.
  });

  it('is a 404 for a second segment, which this increment did not build', async () => {
    const hit = await load('/blog/a-lovely-post/comments');
    expect(hit.status).toBe(404);
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* The index                                                                                         */
/* ------------------------------------------------------------------------------------------------ */

describe('the index', () => {
  it('lists the posts with their filters', async () => {
    const hit = await load('/blog');
    expect(hit.status).toBe(200);
    expect(hit.html).toContain('A Lovely Post');
    expect(hit.html).toContain('Marketplace news');
    expect(hit.html).toContain('Shipping advice');
  });

  it('is canonical at its unfiltered, unpaged address and indexable only there', async () => {
    const plain = await load('/blog');
    expect(canonical(plain.html)).toBe('/blog');
    expect(meta(plain.html, 'robots')).toBe('index, follow');

    for (const path of ['/blog?category=news', '/blog?tag=shipping', '/blog?cursor=YmkxLXRlc3Q']) {
      const narrowed = await load(path);
      expect(narrowed.status, path).toBe(200);
      // Every narrowed view is the same blog seen from a different angle, so only the plain address is indexed —
      // and each of them still points at it.
      expect(canonical(narrowed.html), path).toBe('/blog');
      expect(meta(narrowed.html, 'robots'), path).toBe('noindex, follow');
    }
  });

  it('offers a next page as a link, so a page of posts has its own address', async () => {
    const hit = await load('/blog');
    expect(hit.html).toContain('rel="next"');
    expect(hit.html).toContain('cursor=YmkxLXRlc3Q');
  });

  it('keeps a filter when paging, so the next page is the same filtered view', async () => {
    const hit = await load('/blog?category=news');
    expect(hit.html).toContain('category=news&amp;cursor=');
  });

  it('tells an empty blog from a filter that matched nothing', async () => {
    indexEmpty = true;
    const bare = await load('/blog');
    expect(bare.html).toContain('There are no posts yet.');

    const filtered = await load('/blog?category=news');
    expect(filtered.html).toContain('No posts match that filter yet.');
  });

  it('is served in Arabic under /ar/blog', async () => {
    const hit = await load('/ar/blog');
    expect(hit.status).toBe(200);
    expect(hit.html).toContain('المدونة');
    expect(canonical(hit.html)).toBe('/ar/blog');
  });

  it('never consults the redirect map, because it is a live address', async () => {
    mapAnswers = new Map([['/blog', { toPath: '/', statusCode: 301 }]]);
    const hit = await load('/blog');
    expect(hit.status).toBe(200);
    expect(mapWasConsulted()).toBe(false);
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* Owner decision A — the blog is in no sitemap                                                      */
/* ------------------------------------------------------------------------------------------------ */

describe('the blog may be indexed, which 0097 is what made true', () => {
  it('lets a published indexable post say index on the wire as well as in the page', async () => {
    // The defect this proves fixed. The post page has always carried `robots: { index: post.isIndexable }`, but the
    // response also carried a blanket `X-Robots-Tag: noindex`, and a header and a meta tag combine to the most
    // restrictive of the two — so the administrator's own decision reached no crawler. Both halves are asserted
    // here, because a page is indexable only when neither of them forbids it.
    for (const path of ['/blog/a-lovely-post', '/ar/blog/a-lovely-post']) {
      const hit = await load(path);
      expect(hit.status, path).toBe(200);
      expect(hit.robotsHeader, `${path} header`).toBeNull();
      expect(meta(hit.html, 'robots'), `${path} meta`).toBe('index, follow');
    }
  });

  it('honours a post the administrator marked not indexable, in the page and not by the header', async () => {
    // The other half of the same decision: the column now does something, and what it does is page-level. The
    // header must not be the thing that refuses, or every post would be refused again.
    postAnswer = { kind: 'post', post: { ...POST, isIndexable: false } };
    serveApi();
    const hit = await load('/blog/a-lovely-post');
    expect(hit.status).toBe(200);
    expect(hit.robotsHeader).toBeNull();
    expect(meta(hit.html, 'robots')).toBe('noindex, follow');
  });

  it('lets the blog index say index at its canonical address', async () => {
    for (const path of ['/blog', '/ar/blog']) {
      const hit = await load(path);
      expect(hit.status, path).toBe(200);
      expect(hit.robotsHeader, `${path} header`).toBeNull();
      expect(meta(hit.html, 'robots'), `${path} meta`).toBe('index, follow');
    }
  });

  it('keeps a filtered or paged index out of the index, exactly as it already declared', async () => {
    // Owner decision 1: preserve what the page already says. A cursor page and a filtered view are the same blog
    // from another angle, which is 8-D's rule for every filtered surface on this site.
    for (const path of ['/blog?category=news', '/blog?tag=shipping', '/blog?cursor=Y3Vyc29y', '/ar/blog?tag=shipping']) {
      const hit = await load(path);
      expect(hit.status, path).toBe(200);
      expect(hit.robotsHeader, `${path} header`).toBeNull();
      expect(meta(hit.html, 'robots'), `${path} meta`).toBe('noindex, follow');
    }
  });

  it('still refuses by header anything that only looks like a blog address', async () => {
    for (const path of ['/blogsomething', '/blog/a-lovely-post/edit', '/blog/category/news', '/blog/tag/news']) {
      const hit = await load(path);
      expect(hit.robotsHeader, path).toBe('noindex');
    }
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* Owner decisions 2 and 6 — one blog kind in the sitemap, and no taxonomy                            */
/* ------------------------------------------------------------------------------------------------ */

describe('the blog in the sitemap', () => {
  it('has no taxonomy sitemap, because a category and a tag are filters on the index', async () => {
    // Owner decision 6. These name no kind at all, so they are a 404 whatever the origin is.
    for (const path of ['/sitemaps/blog/1', '/sitemaps/posts/1', '/sitemaps/blog_category/1', '/sitemaps/blog_tag/1']) {
      const hit = await load(path);
      expect(hit.status, path).toBe(404);
    }
  });

  it('answers the blog child exactly as every other kind does with no origin configured', async () => {
    // `blog_post` now names a real kind. This app is booted without `PUBLIC_WEB_ORIGIN`, so every sitemap is a 404 —
    // and the point of asserting it beside `page` is that the blog is refused for the origin and not for its kind.
    expect((await load('/sitemaps/blog_post/1')).status).toBe(404);
    expect((await load('/sitemaps/page/1')).status).toBe(404);
    expect((await load('/sitemap.xml')).status).toBe(404);
  });
});
