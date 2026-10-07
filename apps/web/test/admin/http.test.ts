import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildContentSecurityPolicy } from '@repo/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_DIR, nonceFromCsp, scriptTags, startBuiltApp, type RunningApp } from '../support/next-server.js';


/** Obviously fake, 43 base64url characters. Distinct from the public suite's so a bundle hit names its source. */
const CANARY_CREDENTIAL = 'test-admin-bundle-canary-credential-not-rea';

/**
 * Where the console is mounted (0108).
 *
 * A literal, not an import. The whole point of these assertions is to observe the built deployment from outside, and
 * a test that asked the application where its console was would pass even if the answer had changed.
 */
const ADMIN = '/admin';
let app: RunningApp;
beforeAll(async () => {
  app = await startBuiltApp({ API_BASE_URL: 'http://api-canary.internal.invalid:8080', INTERNAL_BFF_CREDENTIAL: CANARY_CREDENTIAL });
});
afterAll(async () => {
  await app.stop();
});

const get = (path: string, init: RequestInit = {}) => fetch(`${app.baseUrl}${path}`, { redirect: 'manual', ...init });

describe('admin security headers', () => {
  it('uses the admin header set (no-referrer, noindex) and no framework header', async () => {
    const res = await get(ADMIN);
    expect(res.status).toBe(200);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    expect(res.headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('permissions-policy')).toBe('camera=(), microphone=(), geolocation=()');
    expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(res.headers.get('x-powered-by')).toBeNull();
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('sends the approved nonce CSP, unique per request, on every script', async () => {
    const nonces = new Set<string>();
    for (const path of [ADMIN, ADMIN, `${ADMIN}/missing`]) {
      const res = await get(path);
      const csp = res.headers.get('content-security-policy');
      const nonce = nonceFromCsp(csp);
      expect(csp).toBe(buildContentSecurityPolicy(nonce));
      nonces.add(nonce);
      const scripts = scriptTags(await res.text());
      expect(scripts.length).toBeGreaterThan(0);
      for (const tag of scripts) expect(tag).toContain(`nonce="${nonce}"`);
    }
    expect(nonces.size).toBe(3);
  });
});

describe('admin pages', () => {
  it('renders the console home in English, signed out (Phase 7-F)', async () => {
    // 7-F made the home a gated console. A visitor with no staff session gets the signed-out state,
    // in English, in the same document frame — and none of the console itself.
    const html = await (await get(ADMIN)).text();
    expect(html).toContain('<html lang="en" dir="ltr">');
    expect(html).toContain('>You are signed out</h1>');
    expect(html).toContain('<meta name="robots" content="noindex, nofollow"/>');
    expect(html).toContain(`© ${new Date().getFullYear()} Marketplace`);
    expect(html).not.toContain('Console sections');
  });

  it('has no /ar prefix and ignores Accept-Language', async () => {
    // The console's language comes from the reader's profile, never from the URL or a header. `/admin/ar` is
    // therefore not an Arabic console — it is an address the console does not serve.
    expect((await get(`${ADMIN}/ar`)).status).toBe(404);
    // And the locale prefix does not reach it from the other side either: `/ar/admin` is not the console.
    expect((await get(`/ar${ADMIN}`)).status).toBe(404);
    const html = await (await get(ADMIN, { headers: { 'accept-language': 'ar' } })).text();
    expect(html).toContain('<html lang="en" dir="ltr">');
  });

  it('serves a server-rendered 404 for unknown paths', async () => {
    const res = await get(`${ADMIN}/missing/page`);
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain('<html lang="en" dir="ltr">');
    expect(html).toContain('>Page not found</h1>');
  });

  /**
   * The console shares an origin with the marketplace and nothing else (0108).
   *
   * Asserted against the built server rather than against the source, because this is the property the merge could
   * plausibly have broken and the only evidence that settles it is what each address actually serves.
   */
  it('shares the origin with the marketplace without sharing a document', async () => {
    const consoleHtml = await (await get(ADMIN)).text();
    const marketplaceHtml = await (await get('/')).text();

    // The marketplace renders its own home and its composed chrome; the console renders neither.
    expect(marketplaceHtml).not.toContain('>You are signed out</h1>');
    expect(consoleHtml).not.toContain('Marketplace</h1>');

    // The two sign-in pages are different pages at different addresses on one host.
    const staff = await get(`${ADMIN}/login`);
    const buyer = await get('/login');
    expect(staff.status).toBe(200);
    expect(buyer.status).toBe(200);
    expect(staff.headers.get('referrer-policy')).toBe('no-referrer');
    expect(buyer.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    // Exactly one value of the differing header, never two: `headers.get` joins repeats with a comma.
    expect(staff.headers.get('referrer-policy')).not.toContain(',');
    expect(buyer.headers.get('referrer-policy')).not.toContain(',');
  });

  /** The crawl documents belong to the origin, which is the marketplace's. The console publishes none. */
  it('publishes no crawl documents of its own', async () => {
    for (const path of ['/robots.txt', '/sitemap.xml']) {
      expect((await get(`${ADMIN}${path}`)).status, path).toBe(404);
    }
  });

  /**
   * A request header is not a fact about the request.
   *
   * The root layout and the next-intl request config both choose a surface from `x-mp-surface`, which the proxy sets
   * after deleting any inbound copy. Without that deletion a client could ask a public path for the console's
   * document shell. It would carry no console data and grant nothing — authorization is server-side in the API and
   * never derived from this header — but the shell is not a client's to choose.
   */
  it('ignores a forged surface header, in both directions', async () => {
    const forgedAdmin = await (await get('/', { headers: { 'x-mp-surface': 'admin' } })).text();
    expect(forgedAdmin).not.toContain('>You are signed out</h1>');

    const forgedPublic = await (await get(ADMIN, { headers: { 'x-mp-surface': 'public' } })).text();
    expect(forgedPublic).toContain('>You are signed out</h1>');
  });
});

/**
 * One build directory serves both surfaces since 0108, so this scan covers the console's chunks and the
 * marketplace's alike — and so does the public suite's equivalent. That is a tightening rather than a duplication:
 * neither surface's client bundles can now be produced without being scanned by both suites, each with its own
 * canary credential, so a hit names which server leaked it.
 */
describe('admin client bundles', () => {
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? files(full) : [full];
    });
  }

  it('contain no server-only BFF code or configuration, and no third-party script origins', () => {
    const js = files(join(APP_DIR, '.next/static'))
      .filter((file) => file.endsWith('.js'))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    for (const forbidden of ['API_BASE_URL', 'BffConfigError', 'checkSameOrigin', 'api-canary', 'INTERNAL_BFF_CREDENTIAL', 'x-internal-credential', 'createInternalCredentialFetch', CANARY_CREDENTIAL]) {
      expect(js).not.toContain(forbidden);
    }
  });

  it('pages reference scripts only from this origin', async () => {
    const html = await (await get(ADMIN)).text();
    for (const tag of scriptTags(html)) {
      const src = /src="([^"]+)"/.exec(tag)?.[1];
      if (src !== undefined) expect(src.startsWith('/_next/')).toBe(true);
    }
  });
});
