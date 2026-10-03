import type { ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startBuiltApp, type RunningApp } from './support/next-server.js';
import { startStubApi, type StubApi } from './support/stub-api.js';

/**
 * The site's navigation, on the wire against the built app (0094).
 *
 * The cases this file exists for:
 *
 *   * **the composed menus reach the chrome of a public page**, in the operator's order and with the operator's own
 *     labels, in both languages;
 *   * **owner decision 2**: an account or authentication surface keeps the plain chrome, and the menus are not even
 *     read for one;
 *   * **owner decision 4**: an entry pointing at a published page this application serves no address for is absent,
 *     and the rest of the menu is unaffected;
 *   * **owner decision 5**: the header's second level is a native `<details>` disclosure and the footer groups its
 *     second level under the heading;
 *   * **owner decision 6**: `opensInNewTab` becomes `target="_blank" rel="noopener noreferrer"`;
 *   * **owner decision 7**: a site with no menus and a site whose menus could not be read both render the plain
 *     header and footer, and neither breaks the page;
 *   * **owner decision 8**: the locale switch is still there whatever anybody composed.
 *
 * No browser, no Playwright, no live provider: the built app runs under `next start` against a stub API.
 */

/** Obviously fake, 43 base64url characters. */
const CANARY_CREDENTIAL = 'test-web-navigation-canary-notreal01234567a';

const LINK = {
  itemId: '11111111-1111-4111-8111-111111111111',
  label: 'Browse listings',
  target: { kind: 'path', path: '/listings' },
  opensInNewTab: false,
} as const;

const HEADER_MENU = {
  menuKey: 'header',
  label: 'Header',
  items: [
    { ...LINK, children: [] },
    {
      itemId: '22222222-2222-4222-8222-222222222222',
      label: 'About',
      target: { kind: 'page', slug: 'about' },
      opensInNewTab: false,
      children: [
        {
          itemId: '33333333-3333-4333-8333-333333333333',
          label: 'Our terms',
          target: { kind: 'page', slug: 'terms' },
          opensInNewTab: false,
        },
      ],
    },
    {
      itemId: '44444444-4444-4444-8444-444444444444',
      label: 'A post',
      target: { kind: 'blog_post', slug: 'a-lovely-post' },
      opensInNewTab: true,
      children: [],
    },
  ],
};

const FOOTER_MENU = {
  menuKey: 'footer',
  label: 'Footer',
  items: [
    {
      itemId: '55555555-5555-4555-8555-555555555555',
      label: 'Company',
      target: { kind: 'path', path: '/about' },
      opensInNewTab: false,
      children: [
        {
          itemId: '66666666-6666-4666-8666-666666666666',
          label: 'Furniture',
          target: { kind: 'category', slug: 'furniture' },
          opensInNewTab: false,
        },
      ],
    },
  ],
};

/** A page that is published and sits outside the closed set of addresses this application serves. */
const UNSERVABLE_MENU = {
  menuKey: 'header',
  label: 'Header',
  items: [
    {
      itemId: '77777777-7777-4777-8777-777777777777',
      label: 'A made-up page',
      target: { kind: 'page', slug: 'nav-made-up-page' },
      opensInNewTab: false,
      children: [],
    },
    { ...LINK, children: [] },
  ],
};

type Mode = 'composed' | 'empty' | 'unavailable' | 'unservable' | 'headerOnly';

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

function menusFor(mode: Mode): readonly unknown[] {
  if (mode === 'empty') return [];
  if (mode === 'unservable') return [UNSERVABLE_MENU];
  if (mode === 'headerOnly') return [HEADER_MENU];
  return [HEADER_MENU, FOOTER_MENU];
}

function serveApi(): void {
  api.reply((request, response) => {
    const path = request.url.split('?')[0] ?? '';

    if (path === '/v1/navigation') {
      if (mode === 'unavailable') {
        response.writeHead(503, { 'content-type': 'application/problem+json' });
        response.end(JSON.stringify({ status: 503, code: 'SERVICE_UNAVAILABLE' }));
        return;
      }
      return json(response, { menus: menusFor(mode) });
    }

    if (path === '/v1/seo/redirects/resolve') return json(response, { outcome: 'none' });
    if (path === '/v1/homepage') return json(response, { sections: [] });
    if (path === '/v1/categories') return json(response, { categories: [] });

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
  mode = 'composed';
  serveApi();
});

async function load(path: string): Promise<{ status: number; html: string }> {
  const response = await fetch(`${app.baseUrl}${path}`, { redirect: 'manual' });
  return { status: response.status, html: await response.text() };
}

/** Whether the navigation was read at all while rendering that path. */
function readNavigation(): boolean {
  return api.seen.some((entry) => entry.url.startsWith('/v1/navigation'));
}

describe('a public page', () => {
  it('carries the composed header and footer', async () => {
    const hit = await load('/');
    expect(hit.status).toBe(200);
    expect(hit.html).toContain('Browse listings');
    expect(hit.html).toContain('href="/listings"');
    expect(hit.html).toContain('Company');
    // The menu's own label becomes the landmark's name, so a screen reader announces which navigation it is.
    expect(hit.html).toContain('aria-label="Header"');
    expect(hit.html).toContain('aria-label="Footer"');
  });

  it('reads the whole chrome in one request', async () => {
    await load('/listings');
    const asked = api.seen.filter((entry) => entry.url.startsWith('/v1/navigation'));
    expect(asked).toHaveLength(1);
    expect(asked[0]?.url).toContain('menus=header%2Cfooter%2Cmobile');
  });

  it('builds each address from this applications own route map', async () => {
    const hit = await load('/');
    expect(hit.html).toContain('href="/about"');
    expect(hit.html).toContain('href="/terms"');
    expect(hit.html).toContain('href="/blog/a-lovely-post"');
    expect(hit.html).toContain('href="/category/furniture"');
  });

  it('renders the headers second level as a native disclosure', async () => {
    // Owner decision 5: no JavaScript, keyboard-operable, and announced as a disclosure.
    const hit = await load('/');
    expect(hit.html).toContain('<details');
    expect(hit.html).toContain('<summary');
    expect(hit.html).toContain('Our terms');
  });

  it('honours opens in a new tab, with the rel that belongs with it', async () => {
    const hit = await load('/');
    expect(hit.html).toContain('rel="noopener noreferrer"');
    expect(hit.html).toContain('target="_blank"');
  });

  it('keeps the locale switch whatever was composed', async () => {
    // Owner decision 8: part of the application, not an entry an operator could delete.
    const composed = await load('/');
    expect(composed.html).toContain('hrefLang="ar"');

    mode = 'empty';
    serveApi();
    const plain = await load('/');
    expect(plain.html).toContain('hrefLang="ar"');
  });

  it('localizes a stored path for an Arabic visitor and leaves an Arabic one alone', async () => {
    const hit = await load('/ar');
    expect(hit.html).toContain('href="/ar/listings"');
    expect(hit.html).toContain('href="/ar/about"');
    expect(hit.html).toContain('href="/ar/blog/a-lovely-post"');
  });

  it('serves the same menus on every public surface', async () => {
    for (const path of ['/', '/listings', '/categories', '/blog', '/nope']) {
      mode = 'composed';
      serveApi();
      const hit = await load(path);
      expect(hit.html, path).toContain('Browse listings');
    }
  });
});

describe('owner decision 2 — public surfaces only', () => {
  it('leaves the account and authentication surfaces with the plain chrome', async () => {
    for (const path of [
      '/login',
      '/ar/login',
      '/register',
      '/register/verify',
      '/forgot-password',
      '/reset-password',
      '/dashboard',
      '/ar/dashboard',
    ]) {
      mode = 'composed';
      serveApi();
      api.seen.length = 0;
      const hit = await load(path);
      expect(hit.html, path).not.toContain('Browse listings');
      expect(hit.html, path).not.toContain('aria-label="Header"');
      // And the menus were not read at all: a surface that renders none should cost none.
      expect(readNavigation(), path).toBe(false);
    }
  });

  it('is not fooled by a path that only begins like one of them', async () => {
    const hit = await load('/loginsomething');
    expect(hit.html).toContain('Browse listings');
  });

  it('still renders the plain header and footer on an account surface', async () => {
    const hit = await load('/login');
    expect(hit.html).toContain('<header');
    expect(hit.html).toContain('<footer');
    expect(hit.html).toContain('hrefLang="ar"');
  });
});

describe('owner decision 4 — an address this application does not serve', () => {
  it('omits an entry pointing at a page outside the served set, and keeps the rest', async () => {
    mode = 'unservable';
    serveApi();
    const hit = await load('/');
    expect(hit.status).toBe(200);
    expect(hit.html).not.toContain('A made-up page');
    expect(hit.html).not.toContain('nav-made-up-page');
    expect(hit.html).toContain('Browse listings');
  });
});

describe('owner decision 7 — nothing here may break a page', () => {
  it('renders the plain chrome when nothing has been composed', async () => {
    mode = 'empty';
    serveApi();
    const hit = await load('/');
    expect(hit.status).toBe(200);
    expect(hit.html).toContain('<header');
    expect(hit.html).toContain('<footer');
    expect(hit.html).not.toContain('aria-label="Header"');
  });

  it('renders the plain chrome when the menus could not be read, and still serves the page', async () => {
    mode = 'unavailable';
    serveApi();
    const hit = await load('/listings');
    expect(hit.status).toBe(200);
    expect(hit.html).toContain('<header');
    expect(hit.html).toContain('<footer');
    expect(hit.html).not.toContain('aria-label="Header"');
  });

  it('renders a footer with no composed menu when only a header was composed', async () => {
    mode = 'headerOnly';
    serveApi();
    const hit = await load('/');
    expect(hit.html).toContain('aria-label="Header"');
    expect(hit.html).not.toContain('aria-label="Footer"');
  });

  it('falls back to the header menu for the mobile drawer when no mobile menu exists', async () => {
    // Two landmarks with the same name, one in the header and one in the drawer: the drawer shows the header's
    // entries rather than nothing, because a visitor on a narrow screen needs somewhere to go too.
    const hit = await load('/');
    expect(hit.html.match(/aria-label="Header"/g)?.length).toBe(2);
  });
});
