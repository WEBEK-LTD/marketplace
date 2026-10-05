import { handleMarkNotificationsRead } from '../../../../server/bff';

/**
 * `POST /api/notifications/read` — the browser's only entry to marking notifications read.
 *
 * Three lines on purpose: the Origin check, the session cookie, the internal BFF credential, the body
 * rebuild and the problem-details pass-through all live in the shared handler, which the tests drive
 * directly.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleMarkNotificationsRead(request);
}
