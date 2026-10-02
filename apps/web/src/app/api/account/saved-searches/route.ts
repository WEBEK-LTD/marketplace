import { handleCreateSavedSearch } from '../../../../server/bff';

/**
 * `POST /api/account/saved-searches` — store a search (Phase 7-E).
 *
 * Storing one schedules nothing: there is no matching engine in this project, and `notify` is a stored
 * preference that no writer on this path acts on.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleCreateSavedSearch(request);
}
