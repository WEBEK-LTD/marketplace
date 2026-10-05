import { handleArchiveNotifications } from '../../../../server/bff';

/** `POST /api/notifications/archive` — archive named notifications. The rules live in the handler. */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleArchiveNotifications(request);
}
