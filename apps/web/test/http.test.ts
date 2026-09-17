import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildContentSecurityPolicy } from '@repo/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_DIR, nonceFromCsp, scriptTags, startBuiltApp, type RunningApp } from './support/next-server.js';

const CANARY_API_URL = 'http://api-canary.internal.invalid:8080';
let app: RunningApp;
beforeAll(async () => {
  app = await startBuiltApp({ API_BASE_URL: CANARY_API_URL });
});
afterAll(async () => {
  await app.stop();
});

const get = (path: string, init: RequestInit = {}) => fetch(`${app.baseUrl}${path}`, { redirect: 'manual', ...init });

describe('security headers', () => {
  it('sends the approved static headers and no framework header', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('permissions-policy')).toBe('camera=(), microphone=(), geolocation=()');
    expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(res.headers.get('x-powered-by')).toBeNull();
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('sends the approved CSP with a per-request nonce', async () => {
    const res = await get('/');
    const csp = res.headers.get('content-security-policy');
    expect(csp).toBe(buildContentSecurityPolicy(nonceFromCsp(csp)));
  });

  it('uses a different nonce on every request and applies it to every script', async () => {
    const nonces = new Set<string>();
    for (const path of ['/', '/', '/ar', '/nope']) {
      const res = await get(path);
      const nonce = nonceFromCsp(res.headers.get('content-security-policy'));
      nonces.add(nonce);
      const html = await res.text();
      const scripts = scriptTags(html);
      expect(scripts.length).toBeGreaterThan(0);
      for (const tag of scripts) expect(tag).toContain(`nonce="${nonce}"`);
    }
    expect(nonces.size).toBe(4);
  });

  it('applies the static headers to build assets too', async () => {
    const html = await (await get('/')).text();
    const asset = /\/_next\/static\/[^"]+\.css/.exec(html)?.[0];
    expect(asset).toBeDefined();
    const res = await get(asset ?? '');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
  });
});

describe('locale routing', () => {
  it('serves English at the root, left-to-right', async () => {
    const html = await (await get('/')).text();
    expect(html).toContain('<html lang="en" dir="ltr">');
    expect(html).toContain('>Marketplace</h1>');
    expect(html).toMatch(/<a href="\/ar" hrefLang="ar" lang="ar" aria-label="Switch to Arabic"[^>]*>العربية<\/a>/);
    expect(html).toContain(`© ${new Date().getFullYear()} Marketplace`);
    expect(html).toContain('href="#content"');
  });

  it('serves Arabic under /ar, right-to-left', async () => {
    const html = await (await get('/ar')).text();
    expect(html).toContain('<html lang="ar" dir="rtl">');
    expect(html).toContain('>السوق</h1>');
    expect(html).toMatch(/<a href="\/" hrefLang="en" lang="en"[^>]*>English<\/a>/);
  });

  it('redirects /en to the unprefixed root', async () => {
    const res = await get('/en');
    expect([307, 308]).toContain(res.status);
    expect(res.headers.get('location')).toBe('/');
  });

  it('never redirects on Accept-Language and never sets a locale cookie', async () => {
    const res = await get('/', { headers: { 'accept-language': 'ar' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<html lang="en" dir="ltr">');
    for (const path of ['/', '/ar', '/en', '/nope']) {
      expect((await get(path)).headers.get('set-cookie')).toBeNull();
    }
  });
});

describe('not-found pages', () => {
  it.each([
    ['/nope', 'en', 'ltr', 'Page not found'],
    ['/ar/nope', 'ar', 'rtl', 'الصفحة غير موجودة'],
    ['/ar/a/b/c', 'ar', 'rtl', 'الصفحة غير موجودة'],
    ['/fr/page', 'en', 'ltr', 'Page not found'],
    ['/api/anything', 'en', 'ltr', 'Page not found'],
    ['/file.txt', 'en', 'ltr', 'Page not found'],
  ])('%s is a server-rendered 404 in %s', async (path, lang, dir, title) => {
    const res = await get(path);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-security-policy')).toContain("'nonce-");
    const html = await res.text();
    expect(html).toContain(`<html lang="${lang}" dir="${dir}">`);
    expect(html).toContain(`>${title}</h1>`);
  });
});

describe('noindex', () => {
  it.each(['/', '/ar', '/nope'])('%s is not indexable', async (path) => {
    const res = await get(path);
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    expect(await res.text()).toContain('<meta name="robots" content="noindex, nofollow"/>');
  });
});

describe('client bundles', () => {
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? files(full) : [full];
    });
  }
  const staticFiles = files(join(APP_DIR, '.next/static'));

  it('contain no server-only BFF code or configuration', () => {
    const js = staticFiles.filter((file) => file.endsWith('.js')).map((file) => readFileSync(file, 'utf8')).join('\n');
    expect(js.length).toBeGreaterThan(0);
    for (const forbidden of ['API_BASE_URL', 'BffConfigError', 'checkSameOrigin', 'api-canary', 'readApiBaseUrl']) {
      expect(js).not.toContain(forbidden);
    }
  });

  it('never exposes the runtime API URL in pages', async () => {
    for (const path of ['/', '/ar', '/nope']) {
      expect(await (await get(path)).text()).not.toContain('api-canary');
    }
  });

  it('ship CSS built only from the design tokens', () => {
    const css = staticFiles.filter((file) => file.endsWith('.css')).map((file) => readFileSync(file, 'utf8')).join('\n');
    expect(css).toContain('--token-color-brand-primary');
    expect(css).toContain('--token-color-brand-secondary');
    expect(css).not.toMatch(/--color-(red|blue|purple|indigo|violet|pink|green)-\d/);
    expect(css.toLowerCase()).not.toContain('gradient');
  });
});
