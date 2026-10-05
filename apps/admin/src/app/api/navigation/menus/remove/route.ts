import { handleNavigationMenuRemove } from '../../../../../server/bff';

/**
 * `POST /api/navigation/menus/remove` — remove one menu, and its entries with it.
 *
 * A `POST` on this origin and a `DELETE` upstream, for the reason every other remove route gives: the same-origin
 * check reads a submitted body and a browser form submits one.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleNavigationMenuRemove(request);
}
