import { handleNavigationItemCreate, handleNavigationItemUpdate } from '../../../../server/bff';

/**
 * `POST /api/navigation/items` — create one entry.
 * `PATCH /api/navigation/items` — change one's labels, target, parent, tab preference or position.
 *
 * **Neither handler forwards a visibility flag**, and neither moves an entry between menus.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleNavigationItemCreate(request);
}

export async function PATCH(request: Request): Promise<Response> {
  return handleNavigationItemUpdate(request);
}
