import { handleSessionRefresh } from '../../../../server/bff';

/**
 * `POST /api/auth/refresh` — the browser's only way to lengthen its session.
 *
 * Three lines on purpose: the Origin check, the refresh cookie, the internal BFF credential and the
 * cookie rotation all live in the shared handler, which the tests drive directly.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleSessionRefresh(request);
}
