import { handleNavigationMenuState } from '../../../../../server/bff';

/**
 * `POST /api/navigation/menus/state` — show or hide one menu.
 *
 * Its own route, and the one that can take a whole menu off every public surface at once. A `POST` on this origin
 * and a `PUT` upstream: the same-origin check reads a submitted body, and the form that drives this submits one.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleNavigationMenuState(request);
}
