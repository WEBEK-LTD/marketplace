import { handleSupportDecision } from '../../../../../admin/server/bff';

/**
 * `POST /admin/api/support/decision` (Phase 7-L).
 *
 * The agent outcome: `resolved` or `closed`, and nothing else is accepted here, upstream or in the database.
 * There is no reason field, because nothing stores one, and no reopen route anywhere.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleSupportDecision(request);
}
