import { describe, expect, it } from 'vitest';
import { buildContentSecurityPolicy, createNonce, staticSecurityHeaders } from '../src/index.js';

describe('CSP', () => {
  it('builds the approved policy around a nonce', () => {
    const nonce = createNonce();
    expect(buildContentSecurityPolicy(nonce)).toBe(
      [
        "default-src 'self'",
        `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
        `style-src 'self' 'nonce-${nonce}'`,
        "img-src 'self' blob: data:",
        "font-src 'self'",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        'upgrade-insecure-requests',
      ].join('; '),
    );
  });

  it('never allows unsafe-inline, unsafe-eval or wildcards', () => {
    const csp = buildContentSecurityPolicy(createNonce());
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
  });

  it('creates unpredictable 128-bit nonces', () => {
    const nonces = new Set(Array.from({ length: 1000 }, () => createNonce()));
    expect(nonces.size).toBe(1000);
    for (const nonce of nonces) expect(Buffer.from(nonce, 'base64')).toHaveLength(16);
  });

  it.each(["abc'; script-src *", '', 'short', 'x'.repeat(10) + ' '])('rejects an unsafe nonce %j', (nonce) => {
    expect(() => buildContentSecurityPolicy(nonce)).toThrow(TypeError);
  });
});

describe('static security headers', () => {
  const asMap = (app: 'web' | 'admin') => Object.fromEntries(staticSecurityHeaders(app).map((h) => [h.key, h.value]));

  it('match the approved values for the public web', () => {
    expect(asMap('web')).toEqual({
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'X-Robots-Tag': 'noindex',
    });
  });

  it('use no-referrer and noindex for the admin app', () => {
    expect(asMap('admin')['Referrer-Policy']).toBe('no-referrer');
    expect(asMap('admin')['X-Robots-Tag']).toBe('noindex');
  });
});
