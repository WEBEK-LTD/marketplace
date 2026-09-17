import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildContentSecurityPolicy } from '@repo/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_DIR, nonceFromCsp, scriptTags, startBuiltApp, type RunningApp } from './support/next-server.js';

let app: RunningApp;
beforeAll(async () => {
  app = await startBuiltApp({ API_BASE_URL: 'http://api-canary.internal.invalid:8080' });
});
afterAll(async () => {
  await app.stop();
});

const get = (path: string, init: RequestInit = {}) => fetch(`${app.baseUrl}${path}`, { redirect: 'manual', ...init });

describe('admin security headers', () => {
  it('uses the admin header set (no-referrer, noindex) and no framework header', async () => {
    const res = await get('/');
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
    for (const path of ['/', '/', '/missing']) {
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
  it('renders the neutral admin home in English (no profiles yet)', async () => {
    const html = await (await get('/')).text();
    expect(html).toContain('<html lang="en" dir="ltr">');
    expect(html).toContain('>Admin</h1>');
    expect(html).toContain('<meta name="robots" content="noindex, nofollow"/>');
    expect(html).toContain(`© ${new Date().getFullYear()} Marketplace`);
  });

  it('has no /ar prefix and ignores Accept-Language', async () => {
    expect((await get('/ar')).status).toBe(404);
    const html = await (await get('/', { headers: { 'accept-language': 'ar' } })).text();
    expect(html).toContain('<html lang="en" dir="ltr">');
  });

  it('serves a server-rendered 404 for unknown paths', async () => {
    const res = await get('/missing/page');
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain('<html lang="en" dir="ltr">');
    expect(html).toContain('>Page not found</h1>');
  });
});

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
    for (const forbidden of ['API_BASE_URL', 'BffConfigError', 'checkSameOrigin', 'api-canary']) {
      expect(js).not.toContain(forbidden);
    }
  });

  it('pages reference scripts only from this origin', async () => {
    const html = await (await get('/')).text();
    for (const tag of scriptTags(html)) {
      const src = /src="([^"]+)"/.exec(tag)?.[1];
      if (src !== undefined) expect(src.startsWith('/_next/')).toBe(true);
    }
  });
});
