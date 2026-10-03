import type { ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startBuiltApp, type RunningApp } from './support/next-server.js';
import { startStubApi, type StubApi } from './support/stub-api.js';

/**
 * The public help centre, on the wire against the built app (0095).
 *
 * The cases this file exists for:
 *
 *   * **owner decision 1**: a page's `page_key` is the topic, so `/faq` asks for `faq` and `/help` asks for
 *     `help` — and a page with no key asks for nothing at all;
 *   * **owner decision 2**: a topic with nothing published renders no section, no heading and no placeholder;
 *   * **owner decision 3**: an answer is rendered as paragraphs split on blank lines, and never as markup;
 *   * **owner decision 4**: no `FAQPage` JSON-LD, and no script of any kind, reaches the page;
 *   * **owner decision 7**: the page's own metadata, canonical and robots are exactly what they were before this
 *     increment — the questions change the body and nothing else;
 *   * **a failed read costs the section and never the page.**
 *
 * No browser, no Playwright, no live provider: the built app runs under `next start` against a stub API.
 */

/** Obviously fake, 43 base64url characters. */
const CANARY_CREDENTIAL = 'test-web-faqs-canary-notreal0123456789abcde';

const PAGE = {
  slug: 'faq',
  pageKey: 'faq',
  template: 'help',
  isIndexable: true,
  resolvedLocale: 'en',
  title: 'Questions and answers',
  excerpt: 'The things people ask most.',
  body: 'Everything below was written by our team.',
  metaTitle: null,
  metaDescription: null,
  coverObjectPath: null,
  publishedAt: '2026-05-01T09:00:00.000Z',
  updatedAt: '2026-05-02T09:00:00.000Z',
} as const;

const ENTRIES = [
  {
    faqId: '11111111-1111-4111-8111-111111111111',
    question: 'How do I buy?',
    answer: 'Open a listing and read it.\n\nThen press buy.',
  },
  {
    faqId: '22222222-2222-4222-8222-222222222222',
    question: 'Is it safe?',
    answer: 'We check every seller. Angle brackets like <b>these</b> are text.',
  },
] as const;

type Mode = 'published' | 'empty' | 'unavailable' | 'noKey' | 'arabic';

let api: StubApi;
let app: RunningApp;
let mode: Mode;

function json(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function notFound(response: ServerResponse): void {
  response.writeHead(404, { 'content-type': 'application/problem+json' });
  response.end(JSON.stringify({ status: 404, code: 'NOT_FOUND' }));
}

function serveApi(): void {
  api.reply((request, response) => {
    const [pathname, search] = request.url.split('?');
    const path = pathname ?? '';
    const params = new URLSearchParams(search ?? '');

    if (path === '/v1/cms/pages/faq' || path === '/v1/cms/pages/help') {
      const slug = path.endsWith('/help') ? 'help' : 'faq';
      return json(response, {
        outcome: 'page',
        page: {
          ...PAGE,
          slug,
          pageKey: mode === 'noKey' ? null : slug,
          resolvedLocale: params.get('locale') === 'ar' ? 'ar' : 'en',
        },
      });
    }

    if (path === '/v1/faqs') {
      if (mode === 'unavailable') {
        response.writeHead(503, { 'content-type': 'application/problem+json' });
        response.end(JSON.stringify({ status: 503, code: 'SERVICE_UNAVAILABLE' }));
        return;
      }
      const topic = params.get('topic') ?? '';
      if (mode === 'empty') return json(response, { topic, entries: [] });
      if (mode === 'arabic') {
        return json(response, {
          topic,
          entries: [{ ...ENTRIES[0], question: 'كيف أشتري؟', answer: 'افتح قائمة.\n\nثم اضغط شراء.' }],
        });
      }
      // The topic the page asked for is echoed, so a wrong topic would be visible.
      return json(response, { topic, entries: topic === 'faq' ? ENTRIES : [ENTRIES[0]] });
    }

    if (path === '/v1/seo/redirects/resolve') return json(response, { outcome: 'none' });
    if (path === '/v1/seo/metadata') return notFound(response);
    if (path === '/v1/navigation') return json(response, { menus: [] });

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
  mode = 'published';
  serveApi();
});

interface Hit {
  readonly status: number;
  readonly html: string;
  readonly robotsMeta: string | null;
}

async function load(path: string): Promise<Hit> {
  const response = await fetch(`${app.baseUrl}${path}`, { redirect: 'manual' });
  const html = await response.text();
  const meta = /<meta name="robots" content="([^"]*)"\/?>/.exec(html);
  return { status: response.status, html, robotsMeta: meta === null ? null : (meta[1] ?? null) };
}

/** Which topics were asked for while rendering. */
function topicsAsked(): readonly string[] {
  return api.seen
    .filter((entry) => entry.url.startsWith('/v1/faqs'))
    .map((entry) => new URLSearchParams(entry.url.split('?')[1] ?? '').get('topic') ?? '');
}

describe('a page that carries a key', () => {
  it('shows the published questions of the topic its key names', async () => {
    const hit = await load('/faq');
    expect(hit.status).toBe(200);
    // The page's own content is still there.
    expect(hit.html).toContain('Questions and answers');
    expect(hit.html).toContain('Everything below was written by our team.');
    // And the questions beneath it.
    expect(hit.html).toContain('How do I buy?');
    expect(hit.html).toContain('Is it safe?');
    expect(topicsAsked()).toEqual(['faq']);
  });

  it('asks for the help topic on /help, which is owner decision 1', async () => {
    const hit = await load('/help');
    expect(hit.status).toBe(200);
    expect(topicsAsked()).toEqual(['help']);
    expect(hit.html).toContain('How do I buy?');
    // The stub serves only one entry under `help`, so the second must not appear.
    expect(hit.html).not.toContain('Is it safe?');
  });

  it('renders an answer as paragraphs split on blank lines', async () => {
    const hit = await load('/faq');
    expect(hit.html).toContain('Open a listing and read it.');
    expect(hit.html).toContain('Then press buy.');
    // Two paragraphs, not one string with a visible newline.
    expect(hit.html).toMatch(/Open a listing and read it\.<\/p>/);
  });

  it('never interprets an answer as markup', async () => {
    // Owner decision 3: the angle brackets are the author's characters, so they are escaped rather than parsed.
    const hit = await load('/faq');
    expect(hit.html).toContain('&lt;b&gt;these&lt;/b&gt;');
    expect(hit.html).not.toContain('<b>these</b>');
  });

  it('shows the questions in Arabic on the Arabic address', async () => {
    mode = 'arabic';
    serveApi();
    const hit = await load('/ar/faq');
    expect(hit.html).toContain('كيف أشتري؟');
    expect(hit.html).toContain('ثم اضغط شراء.');
    const asked = api.seen.filter((entry) => entry.url.startsWith('/v1/faqs'));
    expect(asked[0]?.url).toContain('locale=ar');
  });

  it('emits no structured data and no script of its own', async () => {
    // Owner decision 4. Next.js adds its own scripts; what matters is that no JSON-LD document appears.
    const hit = await load('/faq');
    expect(hit.html).not.toContain('application/ld+json');
    expect(hit.html).not.toContain('FAQPage');
    expect(hit.html).not.toContain('acceptedAnswer');
  });
});

describe('owner decision 2 — nothing published, nothing rendered', () => {
  it('renders the page and no section at all', async () => {
    mode = 'empty';
    serveApi();
    const hit = await load('/faq');
    expect(hit.status).toBe(200);
    expect(hit.html).toContain('Questions and answers');
    // No heading, no placeholder, no empty state.
    expect(hit.html).not.toContain('Common questions');
    expect(hit.html).not.toContain('How do I buy?');
  });
});

describe('a page with no key', () => {
  it('asks for nothing and shows nothing', async () => {
    mode = 'noKey';
    serveApi();
    const hit = await load('/faq');
    expect(hit.status).toBe(200);
    expect(hit.html).toContain('Questions and answers');
    expect(hit.html).not.toContain('Common questions');
    // Not one read: a page with no key has no topic to ask about.
    expect(topicsAsked()).toEqual([]);
  });
});

describe('a failed read', () => {
  it('costs the section and never the page', async () => {
    mode = 'unavailable';
    serveApi();
    const hit = await load('/faq');
    expect(hit.status).toBe(200);
    expect(hit.html).toContain('Questions and answers');
    expect(hit.html).toContain('Everything below was written by our team.');
    expect(hit.html).not.toContain('Common questions');
  });
});

describe('owner decision 7 — the head is untouched', () => {
  it('keeps the pages own metadata, canonical and robots', async () => {
    const hit = await load('/faq');
    // The page's own title and excerpt, as before 0095.
    expect(hit.html).toContain('<title>Questions and answers</title>');
    expect(hit.html).toContain('The things people ask most.');
    expect(hit.html).toContain('<link rel="canonical" href="/faq"/>');
    expect(hit.robotsMeta).toBe('index, follow');
  });

  it('reads the pages own metadata override and the questions, and nothing else', async () => {
    await load('/faq');
    // A closed inventory on purpose: the page read, 0091's override, 0094's chrome and 0095's questions.
    expect([...new Set(api.seen.map((entry) => entry.url.split('?')[0]))].sort()).toEqual([
      '/v1/cms/pages/faq',
      '/v1/faqs',
      '/v1/navigation',
      '/v1/seo/metadata',
    ]);
  });

  it('asks for the questions once per page render', async () => {
    await load('/faq');
    expect(api.seen.filter((entry) => entry.url.startsWith('/v1/faqs'))).toHaveLength(1);
  });

  it('shows no questions on a static page that carries no key, in either language', async () => {
    mode = 'noKey';
    serveApi();
    for (const path of ['/faq', '/ar/faq', '/help']) {
      api.seen.length = 0;
      const hit = await load(path);
      expect(hit.status, path).toBe(200);
      expect(topicsAsked(), path).toEqual([]);
    }
  });
});
