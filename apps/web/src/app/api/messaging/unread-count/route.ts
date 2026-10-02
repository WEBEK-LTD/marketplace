import { handleUnreadCount } from '../../../../server/bff';

/** `GET /api/messaging/unread-count` — the caller's total, read on its own so it can fail on its own. */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return handleUnreadCount(request);
}
