import { buildContentSecurityPolicy, createNonce } from '@repo/config';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Per-request CSP nonce only (admin has no locale routing). Never authorization (v5.2).
 */
export default function proxy(request: NextRequest) {
  const nonce = createNonce();
  const csp = buildContentSecurityPolicy(nonce);
  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('content-security-policy', csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('content-security-policy', csp);
  return response;
}

export const config = {
  matcher: ['/((?!_next/|_vercel/).*)'],
};
