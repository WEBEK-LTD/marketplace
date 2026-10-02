import { readdirSync, statSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import { cmsPageSlugs } from '@repo/config';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startBuiltApp, type RunningApp } from './support/next-server.js';
import { startStubApi, type StubApi } from './support/stub-api.js';

/**
 * The public CMS static pages, over real HTTP against the built app.
 *
 * What is worth proving here is the part that cannot be proved in isolation: **the status line**. Next.js 16
 * commits it as soon as a page starts awaiting, so a `404` or a `301` decided inside a page arrives as a `200`
 * with the right body. These addresses are therefore resolved in the middleware, exactly as the catalogue
 * surfaces are, and only a test over real HTTP can tell a real 404 from a soft one.
 *
 * The rest of what is proved:
 *
 *   * every address the specification fixes is routed, and the route tree and the shared list say the same
 *     thing — a page that exists in one and not the other is a 404 nobody meant;
 *   * an unknown address is still the localized 404 this app has always served, which is why there is no
 *     catch-all route;
 *   * indexability is the administrator's decision and reaches the response, both as metadata and as the
 *     absence of a blanket header that would override it;
 *   * a renamed page's old address is a real 301, in the locale it was asked in;
 *   * a failed read says so instead of claiming the terms of service do not exist.
 *
 * No browser, no Playwright, no live provider, no deployment.
 */

const CANARY_CREDENTIAL = 'test-web-static-canary-credential-not-realx';

const PAGE = {
  slug: 'terms',
  pageKey: 'terms',
  template: 'legal',
  isIndexable: true,
  resolvedLocale: 'en',
  title: 'Terms of Service',
  excerpt: 'The short version.',
  body: 'First paragraph.\n\nSecond paragraph.',
  metaTitle: 'Terms — Marketplace',
  metaDescription: 'The terms you agree to.',
  coverObjectPath: null,
  publishedAt: '2026-05-01T09:00:00.000Z',
  updatedAt: '2026-05-02T09:00:00.000Z',
} as const;

const ARABIC = {
  ...PAGE,
  resolvedLocale: 'ar',
  title: 'شروط الخدمة',
  excerpt: null,
  body: 'النص العربي.',
  metaTitle: null,
  metaDescription: null,
} as const;

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

function problem(response: ServerResponse, status: number, code: string): void {
  response.writeHead(status, { 'content-type': 'application/problem+json' });
  response.end(JSON.stringify({ status, code }));
}

/** What `GET /v1/cms/pages/<slug>` answers for this test. */
type Answer =
  | { readonly kind: 'page'; readonly page: Record<string, unknown> }
  | { readonly kind: 'moved'; readonly movedTo: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'fails' };

function apiAnswers(answer: Answer, arabic: Record<string, unknown> = ARABIC): void {
  api.reply((request, response) => {
    const [path, query = ''] = request.url.split('?');
    if (path?.startsWith('/v1/cms/pages/') === true) {
      if (answer.kind === 'fails') return problem(response, 503, 'SERVICE_UNAVAILABLE');
      if (answer.kind === 'absent') return problem(response, 404, 'NOT_FOUND');
      if (answer.kind === 'moved') return json(response, { outcome: 'moved', movedTo: answer.movedTo });
      // The locale the page comes back in follows what was asked for, which is what the API itself does.
      const wanted = new URLSearchParams(query).get('locale');
      return json(response, { outcome: 'page', page: wanted === 'ar' ? arabic : answer.page });
    }
    return problem(response, 404, 'NOT_FOUND');
  });
}

beforeEach(() => {
  api.seen.length = 0;
  apiAnswers({ kind: 'page', page: PAGE });
});

interface Page {
  readonly status: number;
  readonly location: string | null;
  readonly robotsHeader: string | null;
  readonly robotsMeta: string | null;
  readonly title: string | null;
  readonly canonical: string | null;
  readonly alternates: readonly string[];
  readonly html: string;
}

async function load(path: string): Promise<Page> {
  const response = await fetch(`${app.baseUrl}${path}`, { redirect: 'manual' });
  const html = await response.text();
  const pick = (re: RegExp): string | null => re.exec(html)?.[1] ?? null;
  return {
    status: response.status,
    location: response.headers.get('location'),
    robotsHeader: response.headers.get('x-robots-tag'),
    robotsMeta: pick(/<meta name="robots" content="([^"]*)"\/?>/),
    title: pick(/<title>([^<]*)<\/title>/),
    canonical: pick(/<link rel="canonical" href="([^"]*)"\/?>/),
    alternates: [...html.matchAll(/<link rel="alternate" hrefLang="([^"]*)" href="([^"]*)"\/?>/g)].map(
      (m) => `${m[1]}=${m[2]}`,
    ),
    html,
  };
}

describe('the route tree', () => {
  it('serves every address on the shared list and no others', () => {
    const dir = join(import.meta.dirname, '..', 'src', 'app', '[locale]');
    const routed = new Set(
      readdirSync(dir).filter((name) => {
        if (!statSync(join(dir, name)).isDirectory()) return false;
        try {
          return statSync(join(dir, name, 'page.tsx')).isFile();
        } catch {
          return false;
        }
      }),
    );
    // Every CMS address has a route file of its own. This is the half that a rename of the list would break.
    for (const slug of cmsPageSlugs) expect(routed.has(slug), slug).toBe(true);
    // And `become-a-seller` is a page of its own, which the CMS must never claim.
    expect(routed.has('become-a-seller')).toBe(true);
    expect([...cmsPageSlugs]).not.toContain('become-a-seller');
  });

  it('answers on all of them, in both locales, rather than only the one this file exercises', async () => {
    for (const slug of cmsPageSlugs) {
      const english = await load(`/${slug}`);
      expect(english.status, slug).toBe(200);
      const arabic = await load(`/ar/${slug}`);
      expect(arabic.status, `ar/${slug}`).toBe(200);
    }
  });
});

describe('a published page', () => {
  it('renders its title, excerpt and body in English', async () => {
    const page = await load('/terms');
    expect(page.status).toBe(200);
    expect(page.html).toContain('>Terms of Service</h1>');
    expect(page.html).toContain('The short version.');
    expect(page.html).toContain('First paragraph.');
    expect(page.html).toContain('Second paragraph.');
  });

  it('renders in Arabic, right to left, under the Arabic address', async () => {
    const page = await load('/ar/terms');
    expect(page.status).toBe(200);
    expect(page.html).toContain('شروط الخدمة');
    expect(page.html).toContain('dir="rtl"');
    expect(page.html).toContain('<html lang="ar" dir="rtl">');
  });

  it('asks the API for the locale it was asked in, credentialled, and reads twice and no more', async () => {
    await load('/ar/terms');
    const reads = api.seen.filter((entry) => entry.url.startsWith('/v1/cms/pages/terms'));
    // Two reads, stated rather than glossed: the middleware reads to choose the status line, and the page
    // reads to render. Nothing can carry a response body from the middleware into a render, so the second
    // read is the price of a real status line — the same price every catalogue detail page already pays. The
    // page's own read is cached per request, so `generateMetadata` and the component share one; a third read
    // here would mean that cache had been broken. The not-found path pays only once, which is asserted below.
    expect(reads).toHaveLength(2);
    for (const read of reads) {
      expect(read.url).toBe('/v1/cms/pages/terms?locale=ar');
      expect(read.method).toBe('GET');
      expect(read.credential).toBe(CANARY_CREDENTIAL);
    }
  });

  it('takes its head from the administrator, with a self-referencing canonical and both languages', async () => {
    const page = await load('/terms');
    expect(page.title).toBe('Terms — Marketplace');
    expect(page.html).toContain('The terms you agree to.');
    expect(page.canonical).toBe('/terms');
    expect(page.alternates).toEqual(['en=/terms', 'ar=/ar/terms']);
  });

  it('falls back to the page title and excerpt when the administrator wrote no meta fields', async () => {
    const page = await load('/ar/terms');
    expect(page.title).toBe('شروط الخدمة');
  });

  it('is indexable only because the administrator said so, and the header does not override it', async () => {
    const page = await load('/terms');
    // The decisive assertion: a blanket `noindex` header is the most restrictive directive on a response and
    // would silently overrule the metadata. On these addresses it is withheld.
    expect(page.robotsHeader).toBeNull();
    expect(page.robotsMeta).toBe('index, follow');
  });

  it('is not indexable when the administrator said it is not', async () => {
    apiAnswers({ kind: 'page', page: { ...PAGE, isIndexable: false } });
    const page = await load('/terms');
    expect(page.status).toBe(200);
    expect(page.robotsMeta).toBe('noindex, nofollow');
  });

  it('shows nothing a visitor has no use for', async () => {
    const page = await load('/terms');
    // The page key, the template and the timestamps build nothing a reader sees.
    expect(page.html).not.toContain('2026-05-01');
    expect(page.html).not.toContain('>legal<');
  });

  it('escapes authored text rather than rendering it as markup', async () => {
    apiAnswers({
      kind: 'page',
      page: { ...PAGE, body: '<script>alert(1)</script>', title: '<b>Terms</b>' },
    });
    const page = await load('/terms');
    expect(page.status).toBe(200);
    expect(page.html).not.toContain('<script>alert(1)</script>');
    expect(page.html).not.toContain('<b>Terms</b>');
    expect(page.html).toContain('&lt;script&gt;');
  });
});

describe('a renamed page', () => {
  it('answers its old address with a real 301 to the new one', async () => {
    apiAnswers({ kind: 'moved', movedTo: 'terms-of-service' });
    const page = await load('/terms');
    // A real status line, not a 200 carrying the renamed content at the old address.
    expect(page.status).toBe(301);
    expect(page.location).toBe('/terms-of-service');
  });

  it('keeps the reader in the locale they were reading', async () => {
    apiAnswers({ kind: 'moved', movedTo: 'terms-of-service' });
    const page = await load('/ar/terms');
    expect(page.status).toBe(301);
    expect(page.location).toBe('/ar/terms-of-service');
  });

  it('refuses to redirect to an address that is not slug-shaped', async () => {
    // The redirect target comes from the API rather than from the shared list, so it is validated against the
    // shared slug contract before anything is built from it. A drifted or hostile value is a failed read, not
    // a `Location` header — which is what keeps this from being a redirect somebody else can aim.
    for (const movedTo of ['a b', '../dashboard', 'https://evil.example', '/terms', 'Terms']) {
      apiAnswers({ kind: 'moved', movedTo });
      const page = await load('/terms');
      expect(page.status, movedTo).toBe(200);
      expect(page.location, movedTo).toBeNull();
      expect(page.html, movedTo).toContain('Page unavailable');
    }
  });
});

describe('a page nobody may see', () => {
  // A draft, a scheduled page, an archived one, one whose moment has not arrived, one nobody has written in
  // any locale, and an address nobody has authored are all the same answer. The API decides which; this is
  // about what the visitor gets.
  it('is a real, server-rendered 404 in English', async () => {
    apiAnswers({ kind: 'absent' });
    const page = await load('/terms');
    expect(page.status).toBe(404);
    expect(page.html).toContain('<html lang="en" dir="ltr">');
    expect(page.html).toContain('Page not found');
    expect(page.robotsHeader).toBe('noindex');
  });

  it('is a real, server-rendered 404 in Arabic', async () => {
    apiAnswers({ kind: 'absent' });
    const page = await load('/ar/terms');
    expect(page.status).toBe(404);
    expect(page.html).toContain('<html lang="ar" dir="rtl">');
    expect(page.html).toContain('الصفحة غير موجودة');
  });

  it('costs one read, not two', async () => {
    apiAnswers({ kind: 'absent' });
    await load('/terms');
    expect(api.seen.filter((entry) => entry.url.startsWith('/v1/cms/pages/terms'))).toHaveLength(1);
  });
});

describe('a page that could not be read', () => {
  it('says so under a 200, because the address itself is real', async () => {
    apiAnswers({ kind: 'fails' });
    const page = await load('/terms');
    // Not a 404: these addresses are fixed by the specification, so a failed read is a failure and not an
    // absence. Claiming the terms of service do not exist would be the worse answer.
    expect(page.status).toBe(200);
    expect(page.html).toContain('Page unavailable');
    expect(page.robotsMeta).toBe('noindex, nofollow');
  });

  it('never shows the visitor anything about why', async () => {
    apiAnswers({ kind: 'fails' });
    const page = await load('/terms');
    expect(page.html).not.toContain('SERVICE_UNAVAILABLE');
    expect(page.html).not.toContain('503');
  });
});

describe('an address that is not a static page', () => {
  it('keeps the localized 404 that every unknown address gets', async () => {
    for (const path of ['/nope', '/terms-and-conditions', '/terms/old', '/file.txt']) {
      const page = await load(path);
      expect(page.status, path).toBe(404);
      expect(page.html, path).toContain('Page not found');
    }
  });

  it('leaves the addresses the specification reserves for unbuilt surfaces unrouted', async () => {
    for (const path of ['/featured', '/new', '/popular', '/deals', '/blog']) {
      const page = await load(path);
      expect(page.status, path).toBe(404);
      expect(page.robotsHeader, path).toBe('noindex');
    }
  });

  it('never reads the CMS for one', async () => {
    await load('/nope');
    await load('/featured');
    expect(api.seen.filter((entry) => entry.url.startsWith('/v1/cms/pages'))).toHaveLength(0);
  });

  it('leaves the built page at its own address alone', async () => {
    const page = await load('/become-a-seller');
    expect(page.status).toBe(200);
    // Its own content, not a CMS page's.
    expect(page.html).not.toContain('Terms of Service');
    expect(api.seen.filter((entry) => entry.url.startsWith('/v1/cms/pages'))).toHaveLength(0);
  });
});
