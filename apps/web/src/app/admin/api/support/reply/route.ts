import { handleSupportReply } from '../../../../../admin/server/bff';

/**
 * `POST /admin/api/support/reply` (Phase 7-L).
 *
 * One message to the requester, rebuilt field by field by the shared handler. No author and no role crosses:
 * the database works the role out from the ticket.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleSupportReply(request);
}
