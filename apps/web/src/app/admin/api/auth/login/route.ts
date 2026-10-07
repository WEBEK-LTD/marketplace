import { handleLogin } from '../../../../../admin/server/bff';

/**
 * `POST /admin/api/auth/login` on the **admin origin** — a separate application, a separate origin and a
 * separate session. It is deliberately the twin of the web route rather than a shared module: the two
 * apps may not import each other, and the cookie names they issue (`__Host-mp_admin_*` here) are what
 * keeps the two sessions from ever standing in for one another.
 *
 * The admin app has no locale routing, so its proxy passes this path through untouched; all the
 * behaviour lives in the admin app's own `handleLogin`.
 *
 * There is no `GET`: an unsupported method gets Next.js's own 405, which discloses nothing.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleLogin(request);
}
