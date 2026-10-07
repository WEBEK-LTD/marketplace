import { handleNavigationMenuCreate, handleNavigationMenuUpdate } from '../../../../../admin/server/bff';

/**
 * `POST /admin/api/navigation/menus` — create a menu.
 * `PATCH /admin/api/navigation/menus` — change one's key or labels.
 *
 * Both on the collection, with the menu's identifier in the body rather than the path, because the same-origin
 * check reads a submitted body and the browser forms that drive these submit one.
 *
 * **Neither handler forwards a visibility flag.** Showing a menu is `/admin/api/navigation/menus/state`, so editing one
 * can never put it in front of the public however the body is shaped.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleNavigationMenuCreate(request);
}

export async function PATCH(request: Request): Promise<Response> {
  return handleNavigationMenuUpdate(request);
}
