import { handleNavigationItemsReorder } from '../../../../../server/bff';

/**
 * `POST /api/navigation/items/reorder` — set the order of one menu, whole.
 *
 * One request for the whole order rather than one per move, so a half-applied arrangement is not reachable.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleNavigationItemsReorder(request);
}
