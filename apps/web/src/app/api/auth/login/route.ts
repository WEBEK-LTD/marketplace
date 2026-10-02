import { handleLogin } from '../../../../server/bff';

/**
 * `POST /api/auth/login` — the only login endpoint the browser may call.
 *
 * The route itself is deliberately three lines. Everything that matters — the Origin/CSRF check, the
 * internal BFF credential, the call to `POST /v1/auth/login`, the `__Host-` cookies of C-8 and the
 * RFC 9457 problem details of C-2 — lives in `handleLogin`, which is shared with the tests. A route
 * that re-implemented any of it would be a second place for the contract to drift.
 *
 * `runtime = 'nodejs'` because the handler is server-only code that reads server configuration, and
 * `dynamic = 'force-dynamic'` because a login must never be served from a cache.
 *
 * There is no `GET`: an unsupported method gets Next.js's own 405, which discloses nothing.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleLogin(request);
}
