import { buildContentSecurityPolicy, createNonce } from '@repo/config';
import createMiddleware from 'next-intl/middleware';
import type { NextRequest } from 'next/server';
import { routing } from './i18n/routing';

const handleLocale = createMiddleware(routing);

/**
 * Locale routing and a per-request CSP nonce only. Never authorization (v5.2).
 * Runs for every path except Next.js build assets, so every HTML response carries the CSP.
 * No route handlers exist yet (no public BFF handlers in Step 5), so every path goes through
 * locale routing and unknown paths get the localized, nonce-protected 404.
 */
export default function proxy(request: NextRequest) {
  const nonce = createNonce();
  const csp = buildContentSecurityPolicy(nonce);
  // Next.js reads the nonce from the request's CSP header while rendering.
  request.headers.set('x-nonce', nonce);
  request.headers.set('content-security-policy', csp);
  const response = handleLocale(request);
  response.headers.set('content-security-policy', csp);
  return response;
}

export const config = {
  matcher: ['/((?!_next/|_vercel/).*)'],
};
