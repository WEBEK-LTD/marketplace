/**
 * Approved browser security policy for the Next.js apps (Phase 1 Step 5).
 * Turnstile and Realtime sources are added in their later phases.
 */
export type AppKind = 'web' | 'admin';

export interface HeaderEntry {
  readonly key: string;
  readonly value: string;
}

const NONCE_PATTERN = /^[A-Za-z0-9+/]{16,}={0,2}$/;

/** 128 random bits, base64-encoded, for one response. */
export function createNonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function buildContentSecurityPolicy(nonce: string): string {
  if (!NONCE_PATTERN.test(nonce)) {
    throw new TypeError('Invalid CSP nonce.');
  }
  return [
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
  ].join('; ');
}

/** Headers sent on every response (the CSP itself is set per request with its nonce). */
export function staticSecurityHeaders(app: AppKind): readonly HeaderEntry[] {
  return Object.freeze([
    { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: app === 'admin' ? 'no-referrer' : 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
    // Step 5: every page is noindex; the admin app stays noindex permanently.
    { key: 'X-Robots-Tag', value: 'noindex' },
  ]);
}
