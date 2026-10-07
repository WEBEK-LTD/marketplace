import { handleSupportClaim } from '../../../../../admin/server/bff';

/**
 * `POST /admin/api/support/claim` (Phase 7-L).
 *
 * Takes one ticket from the queue for the colleague whose session this is. The body carries an identifier and
 * nothing else: the API assigns the caller's own account, so there is no field here that could name anybody.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleSupportClaim(request);
}
